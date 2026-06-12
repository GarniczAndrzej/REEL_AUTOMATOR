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

/// Read a cached result for this hash. Prefers the versioned WhisperX entry,
/// then falls back to a legacy whisper.cpp entry (kept readable). Returns the
/// normalized `{srt_content, words, segments}` payload.
fn read_cache(dir: &std::path::Path, hash: &str) -> Option<serde_json::Value> {
    // New engine: whisper-cache/v2/<hash>.json holds the whole payload.
    let v2 = dir.join(CACHE_VERSION).join(format!("{}.json", hash));
    if let Ok(text) = std::fs::read_to_string(&v2) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
            return Some(val);
        }
    }
    // Legacy whisper.cpp: <hash>.srt (+ optional <hash>.json flat words).
    let legacy_srt = dir.join(format!("{}.srt", hash));
    if let Ok(srt_content) = std::fs::read_to_string(&legacy_srt) {
        let words: Vec<serde_json::Value> =
            std::fs::read_to_string(dir.join(format!("{}.json", hash)))
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

fn write_cache(dir: &std::path::Path, hash: &str, payload: &serde_json::Value) {
    let vdir = dir.join(CACHE_VERSION);
    if std::fs::create_dir_all(&vdir).is_ok() {
        if let Ok(json) = serde_json::to_string(payload) {
            let _ = std::fs::write(vdir.join(format!("{}.json", hash)), json);
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
) -> Result<serde_json::Value, String> {
    // Engine model: prefer model_id (managed), fall back to a raw path during
    // the frontend transition (Phase 4 retires the raw path).
    let model = model_id
        .filter(|s| !s.is_empty())
        .or(model_path.filter(|s| !s.is_empty()))
        .ok_or_else(|| "Nie wybrano modelu transkrypcji.".to_string())?;

    TRANSCRIBE_CANCELLED.store(false, Ordering::SeqCst);

    // ── Cache lookup (versioned + legacy fallback) ──────────────────────
    let cache_key: Option<(std::path::PathBuf, String)> = (|| {
        let dir = app.path().app_cache_dir().ok()?.join("whisper-cache");
        std::fs::create_dir_all(&dir).ok()?;
        let hash = compute_video_hash(&video_path)?;
        Some((dir, hash))
    })();

    if let Some((ref dir, ref hash)) = cache_key {
        if let Some(cached) = read_cache(dir, hash) {
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

    let sidecar = app
        .shell()
        .sidecar(crate::engine::ENGINE_SIDECAR)
        .map_err(|e| format!("Silnik WhisperX niedostępny: {e}. Zbuduj go: sidecar/build.sh"))?
        .args([
            "--audio", &wav_str,
            "--model", &model,
            "--language", &lang_arg,
        ]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Nie udało się uruchomić silnika WhisperX: {e}"))?;
    *TRANSCRIBE_CHILD.lock().unwrap() = Some(child);

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut stderr_line = String::new();
    let mut exit_code: Option<i32> = None;

    while let Some(ev) = rx.recv().await {
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

    if let Some((ref dir, ref hash)) = cache_key {
        write_cache(dir, hash, &payload);
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

        let got = read_cache(&dir, hash).expect("legacy entry should load");
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

        let got = read_cache(&dir, hash).expect("v2 entry should load");
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
) -> Result<serde_json::Value, String> {
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

    let lang_arg = if language == "auto" { "pl".to_string() } else { language.clone() };

    let sidecar = app
        .shell()
        .sidecar(crate::engine::ENGINE_SIDECAR)
        .map_err(|e| format!("Silnik WhisperX niedostępny: {e}. Zbuduj go: sidecar/build.sh"))?
        .args([
            "--align-only",
            "--audio", &wav_str,
            "--transcript", &transcript_str,
            "--language", &lang_arg,
        ]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Nie udało się uruchomić silnika WhisperX: {e}"))?;
    *TRANSCRIBE_CHILD.lock().unwrap() = Some(child);

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut stderr_line = String::new();
    let mut exit_code: Option<i32> = None;

    while let Some(ev) = rx.recv().await {
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
        let _ = c.kill();
    }
    Ok(())
}
