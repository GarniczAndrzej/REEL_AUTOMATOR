use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

static WHISPER_CALL: AtomicU64 = AtomicU64::new(0);

// Tracks the in-flight engine child so `cancel_transcription` can kill it, plus
// a flag the run loop checks to report a cancelled (not failed) state.
static TRANSCRIBE_CHILD: Mutex<Option<CommandChild>> = Mutex::new(None);
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

/// Translate an engine exit code into a distinct Polish error message.
fn engine_error_message(code: Option<i32>, stderr: &str) -> String {
    match code {
        Some(10) => "Model transkrypcji nie został znaleziony lub nie został jeszcze pobrany. Pobierz model w menedżerze modeli.".to_string(),
        Some(11) => "Nie udało się zdekodować audio. Sprawdź plik źródłowy.".to_string(),
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
) -> Result<serde_json::Value, String> {
    // Engine model: a managed model_id resolves to its downloaded local dir
    // (whisper-models/<id>/) that the engine loads offline via --model; a raw
    // model_path is a dev fallback passed through verbatim. Guard against a
    // not-yet-downloaded managed model with a distinct Polish message.
    ensure_engine_free()?;
    let model = match model_id.filter(|s| !s.is_empty()) {
        Some(id) => {
            let dir = crate::models::model_dir(&app, &id)?;
            if !crate::models::is_downloaded(&dir) {
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
    let diarize = diarize.unwrap_or(false);
    let hf_token = hf_token.unwrap_or_default();
    if diarize && hf_token.trim().is_empty() {
        return Err("Diaryzacja jest włączona, ale brak tokenu Hugging Face. Wprowadź token lub wyłącz diaryzację.".into());
    }

    TRANSCRIBE_CANCELLED.store(false, Ordering::SeqCst);

    // ── Cache lookup (model/settings-aware + legacy fallback) ───────────
    // The entry is keyed by the video AND the full run signature, so re-running
    // the same clip with a different model/language/settings does a fresh
    // transcription instead of returning the previous run's result.
    let run_sig = serde_json::json!({
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
    })
    .to_string();

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
    // Alignment model ships beside the sidecar (not baked in) — tell the engine
    // where to find it.
    if let Some(dir) = crate::engine::align_model_dir(&app) {
        args.push("--align-model-dir".into());
        args.push(dir);
    }

    let sidecar = app
        .shell()
        .sidecar(crate::engine::ENGINE_SIDECAR)
        .map_err(|e| {
            let _ = std::fs::remove_file(&wav_path);
            format!("Silnik WhisperX niedostępny: {e}. Zbuduj go: sidecar/build.sh")
        })?
        .args(args);
    // Transcription model is local and the align model is bundled, so force HF
    // offline (skips slow network etag checks) — except when diarizing, where
    // pyannote may still need to be fetched from HuggingFace.
    let sidecar = if diarize {
        // pyannote may still need HuggingFace; pass the token via env (not argv).
        sidecar.env("HF_TOKEN", hf_token.clone())
    } else {
        crate::engine::with_hf_offline(sidecar)
    };

    let (mut rx, child) = sidecar.spawn().map_err(|e| {
        let _ = std::fs::remove_file(&wav_path);
        format!("Nie udało się uruchomić silnika WhisperX: {e}")
    })?;
    *TRANSCRIBE_CHILD.lock().unwrap() = Some(child);

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut stderr_line = String::new();
    let mut exit_code: Option<i32> = None;

    // Poll with a short timeout so a cancel mid-run breaks out promptly. The
    // engine is a PyInstaller onefile: SIGKILL of the bootloader orphans its
    // worker child, which keeps the stdout/stderr pipe open — a plain
    // `rx.recv().await` would then block until the orphan finishes the whole
    // (multi-minute) run, leaving the UI stuck on "Anulowano" and unable to
    // start again. Re-checking the cancel flag every 250 ms fixes that.
    loop {
        if TRANSCRIBE_CANCELLED.load(Ordering::SeqCst) {
            break;
        }
        let ev =
            match tokio::time::timeout(std::time::Duration::from_millis(250), rx.recv()).await {
                Ok(Some(ev)) => ev,
                Ok(None) => break,  // stream closed normally
                Err(_) => continue, // timeout — re-check the cancel flag
            };
        match ev {
            CommandEvent::Stdout(b) => stdout_buf.push_str(&String::from_utf8_lossy(&b)),
            CommandEvent::Stderr(b) => {
                let chunk = String::from_utf8_lossy(&b);
                stderr_buf.push_str(&chunk);
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
            CommandEvent::Terminated(p) => {
                exit_code = p.code;
                break;
            }
            _ => {}
        }
    }

    *TRANSCRIBE_CHILD.lock().unwrap() = None;
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
    if let Some(dir) = crate::engine::align_model_dir(&app) {
        align_args.push("--align-model-dir".into());
        align_args.push(dir);
    }

    // Align-only uses just the bundled wav2vec2 model — always force HF offline.
    // Clean up the temp WAV + transcript on the early sidecar/spawn error paths
    // too (the post-loop cleanup at the bottom only runs once the engine starts).
    let cleanup_temps = || {
        let _ = std::fs::remove_file(&wav_path);
        let _ = std::fs::remove_file(&transcript_path);
    };

    let sidecar = crate::engine::with_hf_offline(
        app.shell()
            .sidecar(crate::engine::ENGINE_SIDECAR)
            .map_err(|e| {
                cleanup_temps();
                format!("Silnik WhisperX niedostępny: {e}. Zbuduj go: sidecar/build.sh")
            })?
            .args(align_args),
    );

    let (mut rx, child) = sidecar.spawn().map_err(|e| {
        cleanup_temps();
        format!("Nie udało się uruchomić silnika WhisperX: {e}")
    })?;
    *TRANSCRIBE_CHILD.lock().unwrap() = Some(child);

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut stderr_line = String::new();
    let mut exit_code: Option<i32> = None;

    // Poll with a short timeout so a cancel mid-run breaks out promptly. The
    // engine is a PyInstaller onefile: SIGKILL of the bootloader orphans its
    // worker child, which keeps the stdout/stderr pipe open — a plain
    // `rx.recv().await` would then block until the orphan finishes the whole
    // (multi-minute) run, leaving the UI stuck on "Anulowano" and unable to
    // start again. Re-checking the cancel flag every 250 ms fixes that.
    loop {
        if TRANSCRIBE_CANCELLED.load(Ordering::SeqCst) {
            break;
        }
        let ev =
            match tokio::time::timeout(std::time::Duration::from_millis(250), rx.recv()).await {
                Ok(Some(ev)) => ev,
                Ok(None) => break,  // stream closed normally
                Err(_) => continue, // timeout — re-check the cancel flag
            };
        match ev {
            CommandEvent::Stdout(b) => stdout_buf.push_str(&String::from_utf8_lossy(&b)),
            CommandEvent::Stderr(b) => {
                let chunk = String::from_utf8_lossy(&b);
                stderr_buf.push_str(&chunk);
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
            CommandEvent::Terminated(p) => {
                exit_code = p.code;
                break;
            }
            _ => {}
        }
    }

    *TRANSCRIBE_CHILD.lock().unwrap() = None;
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

/// Kill the in-flight engine child (if any) and mark the run cancelled so the
/// driver returns the cancelled-state message rather than a failure.
#[tauri::command]
pub async fn cancel_transcription() -> Result<(), String> {
    TRANSCRIBE_CANCELLED.store(true, Ordering::SeqCst);
    let child = TRANSCRIBE_CHILD.lock().unwrap().take();
    if let Some(c) = child {
        // On Unix the engine is a PyInstaller onefile: a hard SIGKILL of the
        // bootloader can't be forwarded to its worker child, orphaning it (it
        // keeps running the transcription and holding the stdout pipe). Send
        // SIGTERM first — the bootloader's handler forwards it so the worker
        // shuts down cleanly — then hard-kill the bootloader as a fallback.
        #[cfg(unix)]
        {
            let pid = c.pid() as i32;
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let _ = c.kill();
        }
        #[cfg(not(unix))]
        {
            let _ = c.kill();
        }
    }
    Ok(())
}
