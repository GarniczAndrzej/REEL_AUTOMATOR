use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};

static WHISPER_CALL: AtomicU64 = AtomicU64::new(0);
use tokio::io::AsyncBufReadExt;

fn compute_video_hash(path: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    let meta = std::fs::metadata(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(meta.len().to_le_bytes());
    // Include mtime to detect in-place file replacement with identical size
    let mtime = meta.modified().ok()
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

#[tauri::command]
pub async fn transcribe_video(
    app: AppHandle,
    video_path: String,
    model_path: String,
    language: String,
) -> Result<serde_json::Value, String> {
    // Check cache
    let cache_key: Option<(std::path::PathBuf, String)> = (|| {
        let dir = app.path().app_cache_dir().ok()?.join("whisper-cache");
        std::fs::create_dir_all(&dir).ok()?;
        let hash = compute_video_hash(&video_path)?;
        Some((dir, hash))
    })();

    if let Some((ref dir, ref hash)) = cache_key {
        let srt_cache = dir.join(format!("{}.srt", hash));
        if srt_cache.exists() {
            if let Ok(srt_content) = std::fs::read_to_string(&srt_cache) {
                let words: Vec<serde_json::Value> = std::fs::read_to_string(
                    dir.join(format!("{}.json", hash))
                )
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default();
                let _ = app.emit("transcribe-progress", serde_json::json!({
                    "phase": "done", "label": "Z cache! ⚡", "percent": 100
                }));
                return Ok(serde_json::json!({ "srt_content": srt_content, "words": words }));
            }
        }
    }

    let _ = app.emit("transcribe-progress", serde_json::json!({
        "phase": "audio_extract", "label": "Ekstrakcja audio…", "percent": 0
    }));

    let pid = std::process::id();
    let seq = WHISPER_CALL.fetch_add(1, Ordering::Relaxed);
    let wav_path = std::env::temp_dir().join(format!("reel_audio_{}_{}.wav", pid, seq));
    let wav_str = wav_path.to_string_lossy().to_string();

    let (_, ok) = crate::ffmpeg::run_ffmpeg_output(&app, &[
        "-y", "-i", &video_path,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        &wav_str,
    ]).await?;

    if !ok {
        return Err("Nie udało się wyekstrahować audio z wideo. Sprawdź plik źródłowy.".into());
    }

    let _ = app.emit("transcribe-progress", serde_json::json!({
        "phase": "transcribe", "label": "Transkrypcja (Whisper)…", "percent": 5
    }));

    let srt_base = std::env::temp_dir().join(format!("reel_whisper_{}_{}", pid, seq));
    let srt_base_str = srt_base.to_string_lossy().to_string();

    let lang_arg = if language == "auto" { "auto".to_string() } else { language.clone() };

    let install_hint = if cfg!(target_os = "macos") {
        "brew install whisper-cpp"
    } else if cfg!(target_os = "windows") {
        "pobierz whisper-cli z https://github.com/ggerganov/whisper.cpp/releases"
    } else {
        "skompiluj whisper-cli z https://github.com/ggerganov/whisper.cpp"
    };

    let mut child = tokio::process::Command::new("whisper-cli")
        .args([
            "-m", &model_path,
            "-f", &wav_str,
            "-l", &lang_arg,
            "-osrt",
            "-oj",          // word-level JSON for F4
            "-of", &srt_base_str,
            "--print-progress",
        ])
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!(
            "whisper-cli niedostępny: {}. Zainstaluj: {}",
            e, install_hint
        ))?;

    let stderr = child.stderr.take().expect("stderr piped");
    let mut lines = tokio::io::BufReader::new(stderr).lines();
    let app2 = app.clone();
    let progress_task = tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(rest) = line.strip_prefix("whisper_print_progress_callback: progress = ") {
                if let Ok(pct) = rest.trim_end_matches('%').parse::<f64>() {
                    let _ = app2.emit("transcribe-progress", serde_json::json!({
                        "phase": "transcribe",
                        "label": format!("Transkrypcja (Whisper)… {}%", pct as u32),
                        "percent": 5.0 + pct * 0.9
                    }));
                }
            }
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    progress_task.abort();

    let _ = tokio::fs::remove_file(&wav_path).await;

    if !status.success() {
        let _ = std::fs::remove_file(srt_base.with_extension("srt"));
        let _ = std::fs::remove_file(srt_base.with_extension("json"));
        return Err("Whisper zakończył się błędem. Sprawdź plik modelu i spróbuj ponownie.".into());
    }

    let srt_path = srt_base.with_extension("srt");
    if !srt_path.exists() {
        return Err("Whisper nie wygenerował pliku SRT — nieoczekiwany błąd.".into());
    }

    let srt_content = std::fs::read_to_string(&srt_path)
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&srt_path);

    // Parse word timestamps from the JSON output (-oj generates <base>.json)
    let json_path = srt_base.with_extension("json");
    let words = if json_path.exists() {
        match parse_whisper_words(&json_path) {
            Ok(w) => { let _ = std::fs::remove_file(&json_path); w }
            Err(_) => { let _ = std::fs::remove_file(&json_path); vec![] }
        }
    } else {
        vec![]
    };

    let _ = app.emit("transcribe-progress", serde_json::json!({
        "phase": "done", "label": "Gotowe!", "percent": 100
    }));

    // Save to cache
    if let Some((ref dir, ref hash)) = cache_key {
        let _ = std::fs::write(dir.join(format!("{}.srt", hash)), &srt_content);
        if let Ok(json) = serde_json::to_string(&words) {
            let _ = std::fs::write(dir.join(format!("{}.json", hash)), json);
        }
    }

    Ok(serde_json::json!({ "srt_content": srt_content, "words": words }))
}

fn parse_whisper_words(json_path: &std::path::Path) -> Result<Vec<serde_json::Value>, String> {
    let text = std::fs::read_to_string(json_path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut words = Vec::new();

    if let Some(transcription) = v["transcription"].as_array() {
        for segment in transcription {
            if let Some(tokens) = segment["tokens"].as_array() {
                for token in tokens {
                    let text = token["text"].as_str().unwrap_or("").trim().to_string();
                    if text.is_empty() { continue; }
                    // offsets are in milliseconds
                    let start = token["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0;
                    let end   = token["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0;
                    if end > start {
                        words.push(serde_json::json!({ "text": text, "start": start, "end": end }));
                    }
                }
            }
        }
    }
    Ok(words)
}
