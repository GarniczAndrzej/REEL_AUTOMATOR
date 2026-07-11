use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;

static WHISPER_CALL: AtomicU64 = AtomicU64::new(0);

// Tracks the in-flight engine child so `cancel_transcription` can kill it, plus
// a flag the run loop checks to report a cancelled (not failed) state. Since the
// spawn-path rework (Phase 3) this is a raw `tokio::process::Child`, not the
// shell plugin's `CommandChild`.
static TRANSCRIBE_CHILD: Mutex<Option<tokio::process::Child>> = Mutex::new(None);
static TRANSCRIBE_CANCELLED: AtomicBool = AtomicBool::new(false);

// A single global child handle can only track/cancel one process, so a second
// concurrent run would orphan the first (cancel could no longer reach it).
// Reject a new run while one is in flight — the app drives one run at a time.
fn ensure_engine_free() -> Result<(), String> {
    if TRANSCRIBE_CHILD.lock().unwrap().is_some() {
        return Err("Transkrypcja już trwa. Poczekaj na jej zakończenie lub anuluj ją.".into());
    }
    Ok(())
}

// Engine/format cache version. WhisperX entries live under `whisper-cache/v2/`
// so they never collide with legacy whisper.cpp `whisper-cache/<hash>.{srt,json}`
// entries, which stay readable for already-processed media.
const CACHE_VERSION: &str = "v2";

// Sentinel prefix the frontend can match to distinguish a user cancel from a
// real failure (kept Polish-readable too).
const CANCELLED_MSG: &str = "ANULOWANO: Transkrypcja przerwana przez użytkownika.";

fn compute_video_hash(path: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    let meta = std::fs::metadata(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(meta.len().to_le_bytes());
    // Include mtime to detect in-place file replacement with identical size
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    hasher.update(mtime.to_le_bytes());
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 1024 * 1024];
    let n = f.read(&mut buf).ok()?;
    hasher.update(&buf[..n]);
    Some(format!("{:x}", hasher.finalize()))
}

/// Map an engine stderr `PROGRESS phase=… percent=…` reading onto the overall
/// progress bar + a Polish label. Phases occupy contiguous bands so the bar
/// only ever moves forward across transcribe → align → diarize.
fn map_progress(phase: &str, pct: f64) -> (String, f64) {
    let p = pct.clamp(0.0, 100.0);
    match phase {
        "transcribe" => (
            format!("Transkrypcja (WhisperX)… {}%", p as u32),
            5.0 + p * 0.65, // 5..70
        ),
        "align" => (
            format!("Dopasowanie słów… {}%", p as u32),
            70.0 + p * 0.25, // 70..95
        ),
        "diarize" => (
            format!("Rozpoznawanie mówców… {}%", p as u32),
            95.0 + p * 0.05, // 95..100
        ),
        _ => ("Przetwarzanie…".to_string(), 5.0),
    }
}

/// Build a plain SRT body from normalized engine segments (seconds → SRT TC).
/// The SRT is derived output, not the source of truth.
fn build_srt_from_segments(segments: &[serde_json::Value]) -> String {
    fn tc(sec: f64) -> String {
        let total_ms = (sec.max(0.0) * 1000.0).round() as u64;
        let ms = total_ms % 1000;
        let s = (total_ms / 1000) % 60;
        let m = (total_ms / 60_000) % 60;
        let h = total_ms / 3_600_000;
        format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
    }
    let mut out = String::new();
    for (i, seg) in segments.iter().enumerate() {
        let start = seg["start"].as_f64().unwrap_or(0.0);
        let end = seg["end"].as_f64().unwrap_or(start);
        let text = seg["text"].as_str().unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        out.push_str(&format!("{}\n", i + 1));
        out.push_str(&format!("{} --> {}\n", tc(start), tc(end)));
        out.push_str(text);
        out.push_str("\n\n");
    }
    out
}

/// Flatten engine segment words into the legacy `[{text,start,end}]` shape (in
/// seconds) so the existing `mergeWordsIntoSentences` path keeps working.
fn flatten_words(segments: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut words = Vec::new();
    for seg in segments {
        if let Some(ws) = seg["words"].as_array() {
            for w in ws {
                let text = w["text"].as_str().unwrap_or("").trim().to_string();
                let start = w["start"].as_f64();
                let end = w["end"].as_f64();
                if let (Some(s), Some(e)) = (start, end) {
                    if !text.is_empty() && e >= s {
                        let mut obj = serde_json::json!({ "text": text, "start": s, "end": e });
                        if let Some(spk) = w["speaker"].as_str() {
                            obj["speaker"] = serde_json::Value::String(spk.to_string());
                        }
                        words.push(obj);
                    }
                }
            }
        }
    }
    words
}

/// Fold the persisted "GPU unusable on this machine" verdict into the engine argv:
/// when it is set and the caller passed no explicit `--device`, force the engine's
/// CT2 device to CPU.
///
/// Flipping `detect_variant()` to `cpu` is NOT enough to demote a machine. A GPU box
/// only ever downloaded the GPU engine (`required_deps` for variant `gpu` excludes
/// the CPU entry), so once `gpuUnusable` is written `engine_bin_path` still
/// resolves — and spawns — the GPU exe, which re-detects CUDA through
/// `get_cuda_device_count()` and fails exactly as before. This flag is what actually
/// demotes it, whichever exe resolved. `--device` targets the CT2 device only, so
/// torch (VAD / alignment / diarization) is unaffected.
///
/// An explicit GPU override (`deps::gpu_forced`) beats the verdict, exactly as it
/// does in `resolve_variant`. Without that term the verdict would be unclearable:
/// there is no writer that resets it, and no UI control emits a CUDA device, so a
/// user who fixed their driver would resolve the GPU exe and still be pinned to the
/// CPU device forever.
fn push_gpu_demotion(args: &mut Vec<String>, device: &Option<String>) {
    let explicit = device.as_ref().is_some_and(|d| !d.trim().is_empty());
    if !explicit && !crate::deps::gpu_forced() && crate::deps::gpu_unusable() {
        args.push("--device".into());
        args.push("cpu".into());
    }
}

/// Append the Phase-7 advanced-settings flags to the engine argv. Only flags the
/// user actually set are pushed; everything else is omitted so the engine keeps
/// its own defaults (untouched modal = no behavior change). `min/max_speakers`
/// only matter when diarizing but are harmless to pass otherwise (the engine
/// reads them solely on the diarize path).
#[allow(clippy::too_many_arguments)]
fn push_advanced_args(
    args: &mut Vec<String>,
    device: &Option<String>,
    compute_type: &Option<String>,
    beam_size: &Option<i64>,
    initial_prompt: &Option<String>,
    vad_onset: &Option<f64>,
    vad_offset: &Option<f64>,
    min_speakers: &Option<i64>,
    max_speakers: &Option<i64>,
) {
    if let Some(d) = device.as_ref().filter(|s| !s.trim().is_empty()) {
        args.push("--device".into());
        args.push(d.clone());
    }
    if let Some(c) = compute_type.as_ref().filter(|s| !s.trim().is_empty()) {
        args.push("--compute-type".into());
        args.push(c.clone());
    }
    if let Some(b) = beam_size {
        args.push("--beam-size".into());
        args.push(b.to_string());
    }
    if let Some(p) = initial_prompt.as_ref().filter(|s| !s.trim().is_empty()) {
        args.push("--initial-prompt".into());
        args.push(p.clone());
    }
    if let Some(v) = vad_onset {
        args.push("--vad-onset".into());
        args.push(v.to_string());
    }
    if let Some(v) = vad_offset {
        args.push("--vad-offset".into());
        args.push(v.to_string());
    }
    if let Some(n) = min_speakers {
        args.push("--min-speakers".into());
        args.push(n.to_string());
    }
    if let Some(n) = max_speakers {
        args.push("--max-speakers".into());
        args.push(n.to_string());
    }
}

/// The engine's transcription-stage failure code (`EXIT_TRANSCRIBE_FAIL`,
/// `whisperx_engine.py:62`) — the only stage that runs on CTranslate2, i.e. the
/// only one a `--device cpu` retry can rescue.
const EXIT_TRANSCRIBE_FAIL: i32 = 14;

/// Does this engine stderr tail name a CUDA/cuBLAS failure of ANY kind?
///
/// This is the RETRY gate, deliberately broad: whatever went wrong on the GPU, the
/// user still wants their transcription, and CPU is the one device we know works.
/// Retrying is cheap to be wrong about — it costs one slower run. It is NOT the
/// demotion gate; see `is_permanent_cuda_failure`, which is deliberately narrow
/// because being wrong there is permanent.
fn is_cuda_failure(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("cublas") || s.contains("no kernel image") || s.contains("cuda")
}

/// Does this stderr tail name a CUDA failure that is STRUCTURAL — i.e. one that
/// will fail identically on every future run, so the machine should durably stop
/// choosing GPU (`deps::set_gpu_unusable`)?
///
/// Exactly two messages qualify, and they are the two this net was built for:
///   - `Library cublas64_12.dll is not found or cannot be loaded` — the DLLs did
///     not load, and nothing about a later run changes that.
///   - `no kernel image is available for execution on the device` — the driver has
///     no compiled kernels for this card's architecture. No cheap probe can predict
///     it, which is why the net exists at all.
///
/// Everything else that merely NAMES cuda is excluded, because the verdict is
/// one-way and a wrong demotion is unrecoverable without an explicit override:
///   - capacity, not capability: `CUDA out of memory`, and cuBLAS's own allocation
///     failures (`CUBLAS_STATUS_ALLOC_FAILED`, `CUBLAS_STATUS_NOT_INITIALIZED`),
///     which carry no "out of memory" text but mean exactly that. These are a batch
///     size / model size problem on a perfectly working GPU.
///   - transient driver states: `unknown error` (999, the classic post-sleep/resume
///     hiccup) and `driver version is insufficient` (an update pending a reboot).
///     Both are fixed by a reboot; demoting for them would outlive the cause.
///
/// Such a run still retries on CPU (`is_cuda_failure`) — it just does not brand the
/// machine.
fn is_permanent_cuda_failure(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    let transient = s.contains("out of memory")
        || s.contains("cublas_status_alloc_failed")
        || s.contains("cublas_status_not_initialized")
        || s.contains("unknown error")
        || s.contains("driver version is insufficient");
    if transient {
        return false;
    }
    s.contains("cannot be loaded") || s.contains("no kernel image")
}

/// Did this argv already pin the CT2 device? True when the caller set `--device`
/// explicitly (the "Wymuś CPU" checkbox / advanced settings) or when
/// `push_gpu_demotion` already appended it from a persisted verdict. Either way
/// the CT2 device is not ours to retry.
fn argv_pins_device(args: &[String]) -> bool {
    args.iter().any(|a| a == "--device")
}

/// Should this failed run be retried once on the CPU?
///
/// Every term is load-bearing:
///   - `cancelled` first: a cancelled run exits non-zero with whatever the reaper
///     left on stderr, and must NEVER be retried or demote the machine.
///   - `spawned_variant` is the tag of the exe that actually ran
///     (`engine::engine_bin_resolved`), never `deps::detect_variant()`'s label.
///     The label lies in both directions: a `REEL_ENGINE_VARIANT=cpu` box holding
///     only the GPU engine runs CUDA under a `cpu` label, and gating on the label
///     would leave exactly that user with a CUDA crash and no retry.
///   - `device_pinned`: nothing to fall back to — CT2 is already where the caller
///     put it.
///   - the exit code is the transcription stage specifically: align and diarize
///     run on torch, whose device `--device` does not touch, so a retry could not
///     rescue them.
fn should_retry_on_cpu(
    exit_code: Option<i32>,
    stderr: &str,
    spawned_variant: &str,
    device_pinned: bool,
    cancelled: bool,
) -> bool {
    if cancelled || device_pinned {
        return false;
    }
    if exit_code != Some(EXIT_TRANSCRIBE_FAIL) {
        return false;
    }
    crate::engine::is_gpu_variant(spawned_variant) && is_cuda_failure(stderr)
}

/// Translate an engine exit code into a distinct Polish error message.
fn engine_error_message(code: Option<i32>, stderr: &str) -> String {
    match code {
        Some(10) => "Model transkrypcji nie został znaleziony lub nie został jeszcze pobrany. Pobierz model w menedżerze modeli.".to_string(),
        Some(11) => "Nie udało się zdekodować audio. Najczęstsza przyczyna to niedostępny FFmpeg — sprawdź panel ZALEŻNOŚCI i pobierz brakujące składniki. Jeśli FFmpeg jest gotowy, sprawdź plik źródłowy.".to_string(),
        Some(12) => "Dopasowanie słów (alignment) nie powiodło się. Spróbuj ponownie lub zmień język.".to_string(),
        Some(13) => "Rozpoznawanie mówców (diaryzacja) nie powiodło się. Sprawdź token Hugging Face i dostęp do modelu pyannote.".to_string(),
        Some(14) => "Transkrypcja nie powiodła się. Sprawdź model i plik audio.".to_string(),
        Some(2) => "Nieprawidłowe wywołanie silnika WhisperX (błąd argumentów).".to_string(),
        _ => {
            let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
            format!("Silnik WhisperX zakończył się błędem. Szczegóły: {}", tail)
        }
    }
}

/// Cache variant key: folds the full run signature (model, language,
/// diarization, advanced tuning knobs) into the video hash. Re-transcribing the
/// SAME video with a DIFFERENT model/settings therefore yields a DISTINCT cache
/// entry (a fresh transcription) instead of silently returning the previous
/// run's result. The plain video hash is kept separately for the legacy lookup.
fn variant_key(video_hash: &str, run_sig: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(video_hash.as_bytes());
    h.update(b"\x00");
    h.update(run_sig.as_bytes());
    format!("{:x}", h.finalize())
}

/// Read a cached result. Prefers the versioned WhisperX entry (keyed by the
/// model/settings-aware `v2_hash`), then falls back to a legacy whisper.cpp
/// entry (keyed by the plain video `legacy_hash`, kept readable). Returns the
/// normalized `{srt_content, words, segments}` payload.
fn read_cache(
    dir: &std::path::Path,
    v2_hash: &str,
    legacy_hash: &str,
) -> Option<serde_json::Value> {
    // New engine: whisper-cache/v2/<v2_hash>.json holds the whole payload.
    let v2 = dir.join(CACHE_VERSION).join(format!("{}.json", v2_hash));
    if let Ok(text) = std::fs::read_to_string(&v2) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
            return Some(val);
        }
    }
    // Legacy whisper.cpp: <legacy_hash>.srt (+ optional <legacy_hash>.json).
    let legacy_srt = dir.join(format!("{}.srt", legacy_hash));
    if let Ok(srt_content) = std::fs::read_to_string(&legacy_srt) {
        let words: Vec<serde_json::Value> =
            std::fs::read_to_string(dir.join(format!("{}.json", legacy_hash)))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default();
        return Some(serde_json::json!({
            "srt_content": srt_content,
            "words": words,
            "segments": [],
        }));
    }
    None
}

fn write_cache(dir: &std::path::Path, v2_hash: &str, payload: &serde_json::Value) {
    let vdir = dir.join(CACHE_VERSION);
    if std::fs::create_dir_all(&vdir).is_ok() {
        if let Ok(json) = serde_json::to_string(payload) {
            let _ = std::fs::write(vdir.join(format!("{}.json", v2_hash)), json);
        }
    }
}

/// Byte ceiling for the retained stderr tail in `drive_engine`. A chatty engine
/// run (torch/ctranslate2/tqdm spew) could otherwise grow `stderr_buf` without
/// bound — the top in-app OOM amplifier (S-21). 64 KB keeps ample diagnostic
/// context for a non-zero-exit error message while capping total memory.
const STDERR_TAIL_MAX_BYTES: usize = 64 * 1024;

/// Append `chunk` to `buf`, then drop bytes from the front so `buf` never
/// exceeds `max_bytes`, retaining the most-recent (tail) content. The cut lands
/// on a UTF-8 char boundary (`buf` is only ever fed `String::from_utf8_lossy`
/// output, i.e. valid UTF-8), so the retained tail is always valid UTF-8 and the
/// drain never panics. Pure + unit-tested (S-21); used for stderr only — the
/// stdout JSON payload must stay uncapped.
fn append_bounded_tail(buf: &mut String, chunk: &str, max_bytes: usize) {
    buf.push_str(chunk);
    if buf.len() <= max_bytes {
        return;
    }
    // Keep at most `max_bytes` from the end; advance to the next char boundary
    // so we never split a multibyte sequence.
    let mut cut = buf.len() - max_bytes;
    while cut < buf.len() && !buf.is_char_boundary(cut) {
        cut += 1;
    }
    buf.drain(..cut);
}

/// Register the spawned engine child, pump its stdout/stderr until it terminates
/// or the run is cancelled, emitting a `transcribe-progress` event for every
/// `PROGRESS` stderr line, then deregister the child. Shared by `transcribe_video`
/// and `align_transcript` so the cancel-token check and the single global child
/// handle live in exactly one place. Returns the accumulated stdout, stderr, and
/// the process exit code (`None` when cancelled or the stream closed without a
/// `Terminated` event).
///
/// Poll with a short timeout so a cancel mid-run breaks out promptly. The engine
/// is a PyInstaller onefile: SIGKILL of the bootloader orphans its worker child,
/// which keeps the stdout/stderr pipe open — a plain `rx.recv().await` would then
/// block until the orphan finishes the whole (multi-minute) run, leaving the UI
/// stuck on "Anulowano" and unable to start again. Re-checking the cancel flag
/// every 250 ms fixes that.
async fn drive_engine(
    app: &AppHandle,
    mut child: tokio::process::Child,
) -> (String, String, Option<i32>) {
    // Take the pipe readers out of the child so we can pump them while the child
    // itself is parked in the global handle for `cancel_transcription` to kill.
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    *TRANSCRIBE_CHILD.lock().unwrap() = Some(child);

    // Accumulate stdout as raw bytes and lossy-decode once at the end so a
    // multibyte UTF-8 sequence split across two `read()` chunks is never mangled
    // (the JSON payload must stay byte-faithful). stderr is decoded per chunk for
    // PROGRESS line parsing (those lines are ASCII).
    let mut stdout_raw: Vec<u8> = Vec::new();
    let mut stderr_buf = String::new();
    let mut stderr_line = String::new();
    let mut cancelled = false;

    let mut obuf = [0u8; 8192];
    let mut ebuf = [0u8; 8192];
    let mut out_open = stdout.is_some();
    let mut err_open = stderr.is_some();
    // Re-check the cancel flag every 250 ms. The engine is a PyInstaller onefile:
    // a SIGKILL of the bootloader orphans its worker child, which keeps the pipes
    // open — a plain read-to-EOF would then block until the orphan finishes the
    // whole (multi-minute) run. Polling the flag lets a cancel break out promptly.
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
    tick.tick().await; // consume the immediate first tick

    while out_open || err_open {
        tokio::select! {
            biased;
            _ = tick.tick() => {
                if TRANSCRIBE_CANCELLED.load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
            }
            k = read_some(&mut stdout, &mut obuf), if out_open => {
                if k == 0 {
                    out_open = false;
                } else {
                    stdout_raw.extend_from_slice(&obuf[..k]);
                }
            }
            k = read_some(&mut stderr, &mut ebuf), if err_open => {
                if k == 0 {
                    err_open = false;
                } else {
                    let chunk = String::from_utf8_lossy(&ebuf[..k]);
                    // Bound the retained stderr to a tail so a chatty run can't
                    // grow this buffer without limit (S-21 OOM amplifier).
                    append_bounded_tail(&mut stderr_buf, &chunk, STDERR_TAIL_MAX_BYTES);
                    // Line-buffer stderr to parse PROGRESS lines reliably.
                    stderr_line.push_str(&chunk);
                    while let Some(nl) = stderr_line.find('\n') {
                        let line: String = stderr_line.drain(..=nl).collect();
                        let line = line.trim_end();
                        if let Some(rest) = line.strip_prefix("PROGRESS ") {
                            let mut phase = "";
                            let mut percent = 0.0_f64;
                            for tok in rest.split_whitespace() {
                                if let Some(v) = tok.strip_prefix("phase=") {
                                    phase = v;
                                } else if let Some(v) = tok.strip_prefix("percent=") {
                                    percent = v.parse().unwrap_or(0.0);
                                }
                            }
                            let (label, overall) = map_progress(phase, percent);
                            let _ = app.emit(
                                "transcribe-progress",
                                serde_json::json!({ "phase": phase, "label": label, "percent": overall }),
                            );
                        }
                    }
                }
            }
        }
    }

    // The driver is the single owner of the child. On cancel it reaps the child
    // itself; on normal completion (pipes hit EOF ⇒ process exited) it reaps via
    // `wait()` to collect the exit code. `take()` is atomic under the lock, so
    // whoever wins (driver here, or cancel_transcription's fallback) is the sole
    // reaper — no double-kill.
    let held = TRANSCRIBE_CHILD.lock().unwrap().take();
    let exit_code = if cancelled {
        if let Some(c) = held {
            reap_engine_child(c).await;
        }
        None
    } else {
        match held {
            Some(mut c) => c.wait().await.ok().and_then(|s| s.code()),
            None => None, // cancel_transcription took and reaped it
        }
    };
    (
        String::from_utf8_lossy(&stdout_raw).into_owned(),
        stderr_buf,
        exit_code,
    )
}

/// Read from an optional child pipe into `buf`, returning the byte count (0 on
/// EOF or error ⇒ the caller closes that stream). Parks forever when the pipe is
/// `None`; the `select!` branch is gated by `out_open`/`err_open` so that arm is
/// never actually polled once closed.
async fn read_some<R: tokio::io::AsyncRead + Unpin>(r: &mut Option<R>, buf: &mut [u8]) -> usize {
    match r.as_mut() {
        Some(rr) => rr.read(buf).await.unwrap_or(0),
        None => std::future::pending().await,
    }
}

#[tauri::command]
pub async fn transcribe_video(
    app: AppHandle,
    video_path: String,
    model_path: Option<String>,
    model_id: Option<String>,
    language: String,
    diarize: Option<bool>,
    hf_token: Option<String>,
    // Phase 7 — advanced settings (flat, to match the frontend's spread invoke).
    // Each is optional; an omitted/None value means the engine keeps its own
    // default (no behavior change when the modal is untouched). Turned into
    // engine CLI flags by `push_advanced_args`.
    device: Option<String>,
    compute_type: Option<String>,
    beam_size: Option<i64>,
    initial_prompt: Option<String>,
    vad_onset: Option<f64>,
    vad_offset: Option<f64>,
    min_speakers: Option<i64>,
    max_speakers: Option<i64>,
    // Phase 3 — Cohere routing. The frontend passes the selected model's engine
    // `kind` and readiness `sentinel` (both from the registry) plus the
    // Cohere-only `punctuation` toggle. All optional: a WhisperX/CT2 selection
    // omits them, so the sentinel gate falls back to `model.bin` and the engine
    // runs its default path — behaviorally unchanged from before.
    kind: Option<String>,
    sentinel: Option<String>,
    punctuation: Option<bool>,
) -> Result<serde_json::Value, String> {
    // Engine model: a managed model_id resolves to its downloaded local dir
    // (whisper-models/<id>/) that the engine loads offline via --model; a raw
    // model_path is a dev fallback passed through verbatim. Guard against a
    // not-yet-downloaded managed model with a distinct Polish message.
    ensure_engine_free()?;
    // The Cohere model loads via native transformers and is gated by its own
    // readiness sentinel (`model.safetensors`), not the CT2 `model.bin`.
    let is_cohere = kind.as_deref() == Some("cohere-transformers");
    let model = match model_id.filter(|s| !s.is_empty()) {
        Some(id) => {
            let dir = crate::models::model_dir(&app, &id)?;
            // Gate on the selected model's registry sentinel (CT2 → `model.bin`;
            // Cohere → `model.safetensors`). An absent sentinel defaults to the
            // CT2 file inside `is_downloaded`, so existing models gate as before.
            let sentinel = sentinel.as_deref().unwrap_or(crate::models::MODEL_SENTINEL);
            if !crate::models::is_downloaded(&dir, sentinel) {
                return Err("Wybrany model nie został pobrany. Pobierz go w menedżerze modeli.".to_string());
            }
            dir.to_string_lossy().to_string()
        }
        None => model_path
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Nie wybrano modelu transkrypcji.".to_string())?,
    };

    // Opt-in diarization needs an HF token; fail early with a distinct message
    // so the core (toggle-off) path is never blocked by diarization setup.
    // Cohere does not diarize in this change (WhisperX stays the only diarize
    // path), so force it off — the Cohere branch never requires an HF token.
    let diarize = diarize.unwrap_or(false) && !is_cohere;
    let hf_token = hf_token.unwrap_or_default();
    if diarize && hf_token.trim().is_empty() {
        return Err("Diaryzacja jest włączona, ale brak tokenu Hugging Face. Wprowadź token lub wyłącz diaryzację.".into());
    }

    TRANSCRIBE_CANCELLED.store(false, Ordering::SeqCst);

    // ── Cache lookup (model/settings-aware + legacy fallback) ───────────
    // The entry is keyed by the video AND the full run signature, so re-running
    // the same clip with a different model/language/settings does a fresh
    // transcription instead of returning the previous run's result.
    let mut run_sig_obj = serde_json::json!({
        "model": model.as_str(),
        "language": language.as_str(),
        "diarize": diarize,
        "beam_size": beam_size,
        "initial_prompt": initial_prompt.as_deref(),
        "vad_onset": vad_onset,
        "vad_offset": vad_offset,
        "compute_type": compute_type.as_deref(),
        "device": device.as_deref(),
        "min_speakers": min_speakers,
        "max_speakers": max_speakers,
    });
    // Cohere changes the transcript source AND honors a punctuation toggle, both
    // of which alter the output — fold them into the key so a Cohere run (and a
    // punctuation flip) maps to a distinct cache entry. CT2 runs add nothing
    // here, so their existing cache keys stay byte-for-byte the same.
    if is_cohere {
        run_sig_obj["engine"] = serde_json::json!("cohere");
        run_sig_obj["punctuation"] = serde_json::json!(punctuation.unwrap_or(true));
    }
    let run_sig = run_sig_obj.to_string();

    // (dir, v2_hash = model/settings-aware, legacy_hash = plain video hash)
    let cache_key: Option<(std::path::PathBuf, String, String)> = (|| {
        let dir = app.path().app_cache_dir().ok()?.join("whisper-cache");
        std::fs::create_dir_all(&dir).ok()?;
        let video_hash = compute_video_hash(&video_path)?;
        let v2 = variant_key(&video_hash, &run_sig);
        Some((dir, v2, video_hash))
    })();

    if let Some((ref dir, ref v2_hash, ref legacy_hash)) = cache_key {
        if let Some(cached) = read_cache(dir, v2_hash, legacy_hash) {
            let _ = app.emit(
                "transcribe-progress",
                serde_json::json!({ "phase": "done", "label": "Z cache! ⚡", "percent": 100 }),
            );
            return Ok(cached);
        }
    }

    // ── Audio extraction (FFmpeg sidecar, unchanged) ────────────────────
    let _ = app.emit(
        "transcribe-progress",
        serde_json::json!({ "phase": "audio_extract", "label": "Ekstrakcja audio…", "percent": 0 }),
    );

    let pid = std::process::id();
    let seq = WHISPER_CALL.fetch_add(1, Ordering::Relaxed);
    let wav_path = std::env::temp_dir().join(format!("reel_audio_{}_{}.wav", pid, seq));
    let wav_str = wav_path.to_string_lossy().to_string();

    let (_, ok) = crate::ffmpeg::run_ffmpeg_output(
        &app,
        &[
            "-y", "-i", &video_path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", &wav_str,
        ],
    )
    .await?;

    if !ok {
        return Err("Nie udało się wyekstrahować audio z wideo. Sprawdź plik źródłowy.".into());
    }

    if TRANSCRIBE_CANCELLED.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&wav_path);
        return Err(CANCELLED_MSG.into());
    }

    // ── Drive the WhisperX engine sidecar ───────────────────────────────
    let _ = app.emit(
        "transcribe-progress",
        serde_json::json!({ "phase": "transcribe", "label": "Transkrypcja (WhisperX)…", "percent": 5 }),
    );

    let lang_arg = if language == "auto" { "auto".to_string() } else { language.clone() };

    let mut args: Vec<String> = vec![
        "--audio".into(), wav_str.clone(),
        "--model".into(), model.clone(),
        "--language".into(), lang_arg,
    ];
    if is_cohere {
        // Native transformers Cohere producer; WhisperX still owns alignment.
        args.push("--engine".into());
        args.push("cohere".into());
        // BooleanOptionalAction in the engine: pass the explicit on/off form so
        // the panel toggle (Phase 4) round-trips. Default-on when unset.
        args.push(if punctuation.unwrap_or(true) {
            "--punctuation".into()
        } else {
            "--no-punctuation".into()
        });
    }
    if diarize {
        args.push("--diarize".into());
        // Token is passed via the HF_TOKEN env var (below), not argv, so it is
        // not visible in `ps` for the run's lifetime.
    }
    // Phase 7 — advanced tuning flags (only those the user set).
    push_advanced_args(
        &mut args,
        &device,
        &compute_type,
        &beam_size,
        &initial_prompt,
        &vad_onset,
        &vad_offset,
        &min_speakers,
        &max_speakers,
    );
    // A machine demoted by Phase 4's probe / runtime net keeps spawning its GPU exe
    // (it never downloaded a CPU one) — this is what forces that exe onto the CPU.
    push_gpu_demotion(&mut args, &device);
    // Alignment model: a local copy (bundled on macOS, or staged from a prior
    // run) is passed via --align-model-dir and used offline. On a thin Windows
    // install there is none — we omit the flag AND leave HF reachable (below) so
    // whisperx pulls the official wav2vec2 align model into the default HF cache
    // at runtime.
    let local_align = crate::engine::align_model_dir(&app);
    if let Some(dir) = &local_align {
        args.push("--align-model-dir".into());
        args.push(dir.clone());
    }

    // `engine_bin_resolved`, not `engine_bin_path`: the retry gate below must know
    // whether a CUDA-capable exe is on the other end, and the variant LABEL cannot
    // answer that (the resolver cross-falls-back in both directions).
    let (bin, spawned_variant) = crate::engine::engine_bin_resolved(&app).map_err(|e| {
        let _ = std::fs::remove_file(&wav_path);
        e
    })?;
    // One spawn recipe, used twice (the original run and the CPU retry) so the two
    // can never drift in their env.
    let spawn_engine = |argv: &Vec<String>| -> Result<tokio::process::Child, String> {
        let mut cmd = crate::proc::build_command(&bin, argv);
        // Force HF offline (skips slow network etag checks) only when the align
        // model can be served locally. Two cases keep HF reachable: diarizing
        // (pyannote may be fetched from HuggingFace — token via env, not argv, so
        // it isn't visible in `ps`), and a thin install with no local align model
        // (whisperx then pulls the official wav2vec2 align model at runtime into
        // the default HF cache).
        if diarize {
            cmd.env("HF_TOKEN", hf_token.clone());
        } else if local_align.is_some() {
            crate::engine::with_hf_offline(&mut cmd);
        }
        // UTF-8 stdio so Polish diacritics in the JSON result survive Windows'
        // cp1250 pipe default (see engine::with_utf8_io).
        crate::engine::with_utf8_io(&mut cmd);
        // The engine decodes the WAV itself, through an ffmpeg IT resolves — hand it
        // ours (absolute + a PATH shim) instead of letting it guess (see
        // engine::with_ffmpeg). Inside the shared closure, so the original run and the
        // CPU retry can never drift.
        crate::engine::with_ffmpeg(&app, &mut cmd);
        cmd.spawn()
            .map_err(|e| format!("Nie udało się uruchomić silnika WhisperX: {e}"))
    };

    let child = spawn_engine(&args).map_err(|e| {
        let _ = std::fs::remove_file(&wav_path);
        e
    })?;

    let (mut stdout_buf, mut stderr_buf, mut exit_code) = drive_engine(&app, child).await;

    // ── Runtime CUDA fallback net ───────────────────────────────────────
    // The post-stage probe proves a driver and a cuBLAS load; neither proves the
    // driver holds a kernel image for THIS card's architecture. That only ever
    // surfaces here, at the first real matmul. Retry once on the CPU — capped by
    // construction, since the retry pins `--device`, which `argv_pins_device`
    // then reads as "not ours to retry".
    if should_retry_on_cpu(
        exit_code,
        &stderr_buf,
        spawned_variant,
        argv_pins_device(&args),
        TRANSCRIBE_CANCELLED.load(Ordering::SeqCst),
    ) {
        // Brand the machine ONLY for a structural failure — one that will recur
        // identically forever. A capacity failure (too large a batch/model) or a
        // transient driver state must not earn a permanent verdict: it would outlive
        // its cause, and nothing clears it without an explicit override. Best-effort:
        // a failed write only costs the machine another retry next time.
        let permanent = is_permanent_cuda_failure(&stderr_buf);
        if permanent {
            let _ = crate::deps::set_gpu_unusable();
        }
        let label = if permanent {
            "GPU okazał się nieużywalny — ponawiam na CPU…"
        } else {
            "Transkrypcja na GPU nie powiodła się — ponawiam na CPU…"
        };
        let _ = app.emit(
            "transcribe-progress",
            serde_json::json!({
                "phase": "transcribe",
                "label": label,
                "percent": 5,
            }),
        );
        args.push("--device".into());
        args.push("cpu".into());
        match spawn_engine(&args) {
            Ok(child) => {
                let (o, e, c) = drive_engine(&app, child).await;
                stdout_buf = o;
                stderr_buf = e;
                exit_code = c;
            }
            // The retry could not even start: fall through and surface the
            // ORIGINAL CUDA failure, which is the more useful error.
            Err(_) => {}
        }
    }

    let _ = tokio::fs::remove_file(&wav_path).await;

    if TRANSCRIBE_CANCELLED.load(Ordering::SeqCst) {
        return Err(CANCELLED_MSG.into());
    }

    if exit_code != Some(0) {
        return Err(engine_error_message(exit_code, &stderr_buf));
    }

    // ── Parse the normalized engine JSON ────────────────────────────────
    let parsed: serde_json::Value = serde_json::from_str(stdout_buf.trim())
        .map_err(|e| format!("Niepoprawna odpowiedź silnika WhisperX: {e}"))?;
    let segments: Vec<serde_json::Value> = parsed["segments"].as_array().cloned().unwrap_or_default();

    let srt_content = build_srt_from_segments(&segments);
    let words = flatten_words(&segments);

    let payload = serde_json::json!({
        "srt_content": srt_content,
        "words": words,
        "segments": segments,
        "language": parsed["language"].as_str().unwrap_or(&language),
    });

    let _ = app.emit(
        "transcribe-progress",
        serde_json::json!({ "phase": "done", "label": "Gotowe!", "percent": 100 }),
    );

    if let Some((ref dir, ref v2_hash, _)) = cache_key {
        write_cache(dir, v2_hash, &payload);
    }

    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "reel_whisper_test_{}_{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn bounded_tail_stays_capped_and_keeps_latest() {
        let max = 1024;
        let mut buf = String::new();
        // Feed far more than the ceiling in many chunks.
        for i in 0..10_000 {
            append_bounded_tail(&mut buf, &format!("line {i}\n"), max);
            assert!(
                buf.len() <= max,
                "buf exceeded ceiling: {} > {}",
                buf.len(),
                max
            );
        }
        // The retained tail must be the most-recent content.
        assert!(buf.contains("line 9999"));
        assert!(!buf.contains("line 0\n"));
    }

    #[test]
    fn bounded_tail_is_multibyte_safe() {
        let max = 64;
        let mut buf = String::new();
        // Multibyte input (Polish + emoji) fed past the ceiling must never panic
        // on a char boundary and must stay valid UTF-8 under the cap.
        for _ in 0..1000 {
            append_bounded_tail(&mut buf, "zażółć gęślą jaźń 🎬\n", max);
        }
        assert!(buf.len() <= max);
        // Not splitting a multibyte sequence: the retained tail must be a literal
        // suffix of the repeated unit (reaching here without a panic already
        // proves char-boundary safety).
        let unit = "zażółć gęślą jaźń 🎬\n";
        let full = unit.repeat(2);
        assert!(full.ends_with(&buf), "tail not a clean suffix: {buf:?}");
    }

    #[test]
    fn legacy_cache_entry_still_loads() {
        // A pre-existing whisper.cpp entry (<hash>.srt + <hash>.json) must
        // resolve via read_cache without touching the engine.
        let dir = tmp_dir("legacy");
        let hash = "deadbeef";
        let srt = "1\n00:00:00,000 --> 00:00:01,000\nCześć\n\n";
        std::fs::write(dir.join(format!("{}.srt", hash)), srt).unwrap();
        std::fs::write(
            dir.join(format!("{}.json", hash)),
            r#"[{"text":"Cześć","start":0.0,"end":1.0}]"#,
        )
        .unwrap();

        // v2 miss (no versioned entry under this hash) → legacy fallback hit.
        let got = read_cache(&dir, hash, hash).expect("legacy entry should load");
        assert_eq!(got["srt_content"].as_str().unwrap(), srt);
        assert_eq!(got["words"].as_array().unwrap().len(), 1);
        assert!(got["segments"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn versioned_entry_preferred_over_legacy() {
        let dir = tmp_dir("v2pref");
        let hash = "cafef00d";
        std::fs::write(dir.join(format!("{}.srt", hash)), "legacy").unwrap();
        let vdir = dir.join(CACHE_VERSION);
        std::fs::create_dir_all(&vdir).unwrap();
        std::fs::write(
            vdir.join(format!("{}.json", hash)),
            r#"{"srt_content":"new","words":[],"segments":[{"start":0,"end":1,"text":"x","words":[]}]}"#,
        )
        .unwrap();

        let got = read_cache(&dir, hash, hash).expect("v2 entry should load");
        assert_eq!(got["srt_content"].as_str().unwrap(), "new");
        assert_eq!(got["segments"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Phase 4: the runtime CUDA fallback net ──────────────────────────

    const CUBLAS_ERR: &str =
        "RuntimeError: Library cublas64_12.dll is not found or cannot be loaded";
    const NO_KERNEL_ERR: &str = "no kernel image is available for execution on the device";

    // cuBLAS's own allocation failures carry NO "out of memory" text, but mean
    // exactly that: too large a batch/model on a perfectly healthy GPU.
    const CUBLAS_OOM_ERR: &str = "RuntimeError: cuBLAS failed with status CUBLAS_STATUS_ALLOC_FAILED";
    const OOM_ERR: &str = "torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB";
    const TRANSIENT_ERR: &str = "RuntimeError: CUDA error: unknown error (999)";
    const STALE_DRIVER_ERR: &str = "CUDA driver version is insufficient for CUDA runtime version";

    #[test]
    fn cuda_marker_fires_on_the_two_real_failures() {
        assert!(is_cuda_failure(CUBLAS_ERR));
        assert!(is_cuda_failure(NO_KERNEL_ERR));
        // Case-insensitive: the engine spells it CUDA, torch spells it cuda.
        assert!(is_cuda_failure("CUDA error: device-side assert triggered"));
    }

    #[test]
    fn cuda_marker_ignores_unrelated_failures() {
        assert!(!is_cuda_failure(
            "ValueError: model not found at C:\\models\\large-v3"
        ));
        assert!(!is_cuda_failure("Nie udało się zdekodować audio"));
    }

    #[test]
    fn a_capacity_or_transient_failure_retries_but_never_brands_the_machine() {
        // The RETRY gate is broad on purpose: whatever died on the GPU, the user
        // still wants their transcription, and one slower CPU run is a cheap way to
        // be wrong.
        assert!(is_cuda_failure(CUBLAS_OOM_ERR));
        assert!(is_cuda_failure(OOM_ERR));
        assert!(is_cuda_failure(TRANSIENT_ERR));
        assert!(is_cuda_failure(STALE_DRIVER_ERR));

        // The DEMOTION gate is narrow on purpose: `gpuUnusable` is one-way, so a
        // wrong verdict outlives its cause. None of these are the GPU's fault.
        //   - CUBLAS_STATUS_ALLOC_FAILED is the one that hid here: it names cuBLAS
        //     but carries no "out of memory" text, so a bare-substring guard would
        //     permanently demote a healthy card over an oversized batch_size.
        assert!(!is_permanent_cuda_failure(CUBLAS_OOM_ERR));
        assert!(!is_permanent_cuda_failure(OOM_ERR));
        //   - unknown error (999) is the classic post-sleep hiccup; a stale driver is
        //     fixed by an update. Both survive a reboot; a demotion would not.
        assert!(!is_permanent_cuda_failure(TRANSIENT_ERR));
        assert!(!is_permanent_cuda_failure(STALE_DRIVER_ERR));
    }

    #[test]
    fn only_a_structural_cuda_failure_brands_the_machine() {
        // These two recur identically on every future run — the machine really has
        // no usable CUDA for us, which is the whole point of the verdict.
        assert!(is_permanent_cuda_failure(CUBLAS_ERR));
        assert!(is_permanent_cuda_failure(NO_KERNEL_ERR));
        // A non-CUDA failure never brands anything.
        assert!(!is_permanent_cuda_failure("Nie udało się zdekodować audio"));
    }

    #[test]
    fn retry_fires_on_a_cuda_failure_from_a_gpu_exe() {
        assert!(should_retry_on_cpu(
            Some(EXIT_TRANSCRIBE_FAIL),
            CUBLAS_ERR,
            "gpu",
            false,
            false
        ));
        assert!(should_retry_on_cpu(
            Some(EXIT_TRANSCRIBE_FAIL),
            NO_KERNEL_ERR,
            "gpu-full",
            false,
            false
        ));
    }

    #[test]
    fn retry_never_fires_when_cancelled() {
        // 4.3 — a cancelled run exits non-zero with arbitrary stderr. It must never
        // be retried and never demote the machine, whatever the code or the text.
        assert!(!should_retry_on_cpu(
            Some(EXIT_TRANSCRIBE_FAIL),
            CUBLAS_ERR,
            "gpu",
            false,
            true
        ));
        assert!(!should_retry_on_cpu(None, NO_KERNEL_ERR, "gpu", false, true));
    }

    #[test]
    fn retry_keys_on_the_spawned_exe_not_the_variant_label() {
        // 4.4 — `detect_variant()` said `cpu` (REEL_ENGINE_VARIANT=cpu), but only
        // the GPU engine is staged, so the resolver spawned the GPU exe and it ran
        // CUDA. The label would hide that; the spawned-exe tag does not.
        assert!(should_retry_on_cpu(
            Some(EXIT_TRANSCRIBE_FAIL),
            CUBLAS_ERR,
            "gpu",
            false,
            false
        ));
        // A CPU exe cannot fail on CUDA — nothing to fall back to.
        assert!(!should_retry_on_cpu(
            Some(EXIT_TRANSCRIBE_FAIL),
            CUBLAS_ERR,
            "cpu",
            false,
            false
        ));
    }

    #[test]
    fn retry_respects_a_pinned_device_and_the_failing_stage() {
        // Already pinned — by the user's "Wymuś CPU", or by a prior demotion.
        assert!(!should_retry_on_cpu(
            Some(EXIT_TRANSCRIBE_FAIL),
            CUBLAS_ERR,
            "gpu",
            true,
            false
        ));
        // Align/diarize run on torch, whose device `--device` does not touch — a
        // CPU retry could not rescue them.
        assert!(!should_retry_on_cpu(Some(12), CUBLAS_ERR, "gpu", false, false));
        assert!(!should_retry_on_cpu(Some(13), CUBLAS_ERR, "gpu", false, false));
        // A missing model is not a CUDA problem.
        assert!(!should_retry_on_cpu(
            Some(10),
            "model not found",
            "gpu",
            false,
            false
        ));
    }

    #[test]
    fn argv_pins_device_sees_both_writers() {
        let explicit: Vec<String> = vec!["--audio".into(), "a.wav".into(), "--device".into(), "cpu".into()];
        assert!(argv_pins_device(&explicit));
        let plain: Vec<String> = vec!["--audio".into(), "a.wav".into(), "--language".into(), "pl".into()];
        assert!(!argv_pins_device(&plain));
    }

    #[test]
    fn srt_and_words_derive_from_segments() {
        let segments = vec![serde_json::json!({
            "start": 0.0, "end": 1.5, "text": "Cześć świat",
            "words": [
                {"text":"Cześć","start":0.0,"end":0.6,"score":0.9},
                {"text":"świat","start":0.7,"end":1.5,"score":0.8}
            ]
        })];
        let srt = build_srt_from_segments(&segments);
        assert!(srt.contains("00:00:00,000 --> 00:00:01,500"));
        assert!(srt.contains("Cześć świat"));
        let words = flatten_words(&segments);
        assert_eq!(words.len(), 2);
        assert_eq!(words[1]["text"].as_str().unwrap(), "świat");
    }
}

/// Force-align an imported transcript to the audio (no transcription). Extracts
/// audio via FFmpeg, then drives the engine's `--align-only` mode. Returns the
/// same normalized `{srt_content, words, segments}` shape as `transcribe_video`.
#[tauri::command]
pub async fn align_transcript(
    app: AppHandle,
    video_path: String,
    transcript: String,
    language: String,
    is_vtt: Option<bool>,
    // Phase 7 — only the device override is relevant to align-only (it drives
    // the torch wav2vec2 align stage); compute_type/beam/VAD are transcription
    // knobs and have no effect here.
    device: Option<String>,
) -> Result<serde_json::Value, String> {
    ensure_engine_free()?;
    TRANSCRIBE_CANCELLED.store(false, Ordering::SeqCst);

    let pid = std::process::id();
    let seq = WHISPER_CALL.fetch_add(1, Ordering::Relaxed);
    let wav_path = std::env::temp_dir().join(format!("reel_align_{}_{}.wav", pid, seq));
    let wav_str = wav_path.to_string_lossy().to_string();
    let ext = if is_vtt.unwrap_or(false) { "vtt" } else { "srt" };
    let transcript_path =
        std::env::temp_dir().join(format!("reel_align_{}_{}.{}", pid, seq, ext));
    std::fs::write(&transcript_path, &transcript).map_err(|e| e.to_string())?;
    let transcript_str = transcript_path.to_string_lossy().to_string();

    let _ = app.emit(
        "transcribe-progress",
        serde_json::json!({ "phase": "audio_extract", "label": "Ekstrakcja audio…", "percent": 0 }),
    );

    let (_, ok) = crate::ffmpeg::run_ffmpeg_output(
        &app,
        &[
            "-y", "-i", &video_path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", &wav_str,
        ],
    )
    .await?;
    if !ok {
        let _ = std::fs::remove_file(&transcript_path);
        return Err("Nie udało się wyekstrahować audio z wideo. Sprawdź plik źródłowy.".into());
    }

    // Forced alignment needs an explicit language (the wav2vec2 model is
    // per-language). When the caller leaves it on "auto" we fall back to Polish —
    // this is a Polish-first app and the bundled align model is `pl`.
    let lang_arg = if language == "auto" { "pl".to_string() } else { language.clone() };

    let mut align_args: Vec<String> = vec![
        "--align-only".into(),
        "--audio".into(), wav_str.clone(),
        "--transcript".into(), transcript_str.clone(),
        "--language".into(), lang_arg.clone(),
    ];
    if let Some(d) = device.as_ref().filter(|s| !s.trim().is_empty()) {
        align_args.push("--device".into());
        align_args.push(d.clone());
    }
    push_gpu_demotion(&mut align_args, &device);
    let local_align = crate::engine::align_model_dir(&app);
    if let Some(dir) = &local_align {
        align_args.push("--align-model-dir".into());
        align_args.push(dir.clone());
    }

    // Align-only uses the wav2vec2 model: a local copy runs offline; on a thin
    // install (no local model) HF stays reachable so whisperx pulls the official
    // one at runtime (see the offline gate at the spawn below).
    // Clean up the temp WAV + transcript on the early sidecar/spawn error paths
    // too (the post-loop cleanup at the bottom only runs once the engine starts).
    let cleanup_temps = || {
        let _ = std::fs::remove_file(&wav_path);
        let _ = std::fs::remove_file(&transcript_path);
    };

    let bin = crate::engine::engine_bin_path(&app).map_err(|e| {
        cleanup_temps();
        e
    })?;
    let mut cmd = crate::proc::build_command(&bin, &align_args);
    // Offline only when a local align model is present; otherwise leave HF
    // reachable so whisperx pulls the official wav2vec2 model at runtime.
    if local_align.is_some() {
        crate::engine::with_hf_offline(&mut cmd);
    }
    crate::engine::with_utf8_io(&mut cmd);
    // Align-only decodes the WAV too — the second decode entry point (see
    // engine::with_ffmpeg).
    crate::engine::with_ffmpeg(&app, &mut cmd);

    let child = cmd.spawn().map_err(|e| {
        cleanup_temps();
        format!("Nie udało się uruchomić silnika WhisperX: {e}")
    })?;

    let (stdout_buf, stderr_buf, exit_code) = drive_engine(&app, child).await;

    let _ = tokio::fs::remove_file(&wav_path).await;
    let _ = std::fs::remove_file(&transcript_path);

    if TRANSCRIBE_CANCELLED.load(Ordering::SeqCst) {
        return Err(CANCELLED_MSG.into());
    }
    if exit_code != Some(0) {
        return Err(engine_error_message(exit_code, &stderr_buf));
    }

    let parsed: serde_json::Value = serde_json::from_str(stdout_buf.trim())
        .map_err(|e| format!("Niepoprawna odpowiedź silnika WhisperX: {e}"))?;
    let segments: Vec<serde_json::Value> =
        parsed["segments"].as_array().cloned().unwrap_or_default();

    let _ = app.emit(
        "transcribe-progress",
        serde_json::json!({ "phase": "done", "label": "Gotowe!", "percent": 100 }),
    );

    Ok(serde_json::json!({
        "srt_content": build_srt_from_segments(&segments),
        "words": flatten_words(&segments),
        "segments": segments,
        "language": parsed["language"].as_str().unwrap_or(&language),
    }))
}

/// SIGTERM → 300 ms → SIGKILL escalation for the PyInstaller engine child.
///
/// On Unix the engine is a PyInstaller onefile: a hard SIGKILL of the bootloader
/// can't be forwarded to its worker child, orphaning it (it keeps running the
/// transcription and holding the stdout pipe). Send SIGTERM first — the
/// bootloader's handler forwards it so the worker shuts down cleanly — then
/// hard-kill the bootloader as a fallback. The single reaper used by both the
/// `drive_engine` cancel-break path and the `cancel_transcription` fallback, so
/// the escalation lives in exactly one place (S-21).
async fn reap_engine_child(mut c: tokio::process::Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = c.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        let _ = c.kill().await;
        let _ = c.wait().await;
    }
    #[cfg(not(unix))]
    {
        let _ = c.kill().await;
        let _ = c.wait().await;
    }
}

/// Mark the run cancelled so the driver returns the cancelled-state message, then
/// kill the engine child only if we still hold its handle — the fallback for the
/// window before `drive_engine` has taken ownership (or the no-driver case). Once
/// the driver owns the child it is the reaper; `take()` here returns `None` and we
/// return cleanly, so the driver and this command never both kill (S-21).
#[tauri::command]
pub async fn cancel_transcription() -> Result<(), String> {
    TRANSCRIBE_CANCELLED.store(true, Ordering::SeqCst);
    let child = TRANSCRIBE_CHILD.lock().unwrap().take();
    if let Some(c) = child {
        reap_engine_child(c).await;
    }
    Ok(())
}
