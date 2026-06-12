// Transcription model manager: download-on-demand into the app data dir with
// live progress + SHA-256 verification, and per-model status reporting.
//
// The curated registry (id, label, size, url, sha256) lives in the frontend
// (src/transcription/model-registry.js); these commands take the url/sha256 for
// the requested model so the Rust layer stays registry-agnostic.

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

/// Root dir for downloaded transcription models.
fn models_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("whisper-models");
    Ok(dir)
}

/// Final on-disk path for a model id.
fn model_path(app: &AppHandle, model_id: &str) -> Result<PathBuf, String> {
    Ok(models_root(app)?.join(format!("{}.bin", sanitize(model_id))))
}

fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

#[derive(Serialize)]
pub struct ModelStatus {
    pub id: String,
    pub downloaded: bool,
    pub path: Option<String>,
    pub size_bytes: u64,
}

/// Report downloaded/missing status (and on-disk size) for each requested id.
#[tauri::command]
pub async fn list_models(app: AppHandle, model_ids: Vec<String>) -> Result<Vec<ModelStatus>, String> {
    let mut out = Vec::new();
    for id in model_ids {
        let p = model_path(&app, &id)?;
        let (downloaded, size) = match std::fs::metadata(&p) {
            Ok(m) if m.is_file() => (true, m.len()),
            _ => (false, 0),
        };
        out.push(ModelStatus {
            id,
            downloaded,
            path: if downloaded { Some(p.to_string_lossy().to_string()) } else { None },
            size_bytes: size,
        });
    }
    Ok(out)
}

/// Verify a file's SHA-256; on mismatch delete it and return a Polish error.
/// `expected` is hex (lowercase); empty/None-like skips verification.
fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    if expected.trim().is_empty() {
        return Ok(());
    }
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| e.to_string())?;
    let got = format!("{:x}", hasher.finalize());
    if got.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        let _ = std::fs::remove_file(path);
        Err(format!(
            "Suma kontrolna pobranego modelu nie zgadza się (oczekiwano {}, otrzymano {}). Pobieranie odrzucone.",
            &expected[..expected.len().min(12)],
            &got[..got.len().min(12)]
        ))
    }
}

/// Stream a model file into the app data dir with progress, then verify SHA-256.
/// Returns the final local path. On any failure the partial file is removed.
#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    model_id: String,
    url: String,
    sha256: String,
    size_bytes: Option<u64>,
) -> Result<String, String> {
    let root = models_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let final_path = model_path(&app, &model_id)?;
    let tmp_path = root.join(format!("{}.part", sanitize(&model_id)));

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Pobieranie modelu nie powiodło się: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Serwer zwrócił błąd {} przy pobieraniu modelu.", resp.status()));
    }
    let total = resp.content_length().or(size_bytes).unwrap_or(0);

    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let start = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("Przerwane pobieranie modelu: {e}")
        })?;
        file.write_all(&chunk).await.map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            e.to_string()
        })?;
        downloaded += chunk.len() as u64;

        // Throttle progress events to ~5/s.
        if last_emit.elapsed().as_millis() >= 200 {
            last_emit = std::time::Instant::now();
            let secs = start.elapsed().as_secs_f64().max(0.001);
            let rate = downloaded as f64 / secs;
            let percent = if total > 0 { (downloaded as f64 / total as f64) * 100.0 } else { 0.0 };
            let eta = if rate > 0.0 && total > downloaded {
                (total - downloaded) as f64 / rate
            } else {
                0.0
            };
            let _ = app.emit(
                "model-download-progress",
                serde_json::json!({
                    "modelId": model_id,
                    "percent": percent,
                    "bytesPerSec": rate,
                    "etaSec": eta,
                    "downloaded": downloaded,
                    "total": total,
                }),
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    // Verify before marking ready.
    verify_sha256(&tmp_path, &sha256)?;

    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        e.to_string()
    })?;

    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({ "modelId": model_id, "percent": 100.0, "bytesPerSec": 0.0, "etaSec": 0.0, "done": true }),
    );

    Ok(final_path.to_string_lossy().to_string())
}

/// Delete a downloaded model.
#[tauri::command]
pub async fn delete_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let p = model_path(&app, &model_id)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_mismatch_deletes_partial_and_errors() {
        let dir = std::env::temp_dir().join(format!("reel_model_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("m.part");
        std::fs::write(&f, b"hello world").unwrap();

        // Wrong expected digest → must error and remove the file.
        let res = verify_sha256(&f, "0000000000000000000000000000000000000000000000000000000000000000");
        assert!(res.is_err(), "mismatched checksum should error");
        assert!(!f.exists(), "partial file should be deleted on mismatch");

        // Correct digest → ok, file kept.
        std::fs::write(&f, b"hello world").unwrap();
        // sha256("hello world")
        let good = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert!(verify_sha256(&f, good).is_ok(), "correct checksum should pass");
        assert!(f.exists(), "file kept on match");

        // Empty expected → verification skipped.
        assert!(verify_sha256(&f, "").is_ok(), "empty expected skips verification");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
