// Transcription model manager: download-on-demand into the app data dir with
// live progress + SHA-256 verification, and per-model status reporting.
//
// faster-whisper CT2 models are multi-file *directories* (model.bin + config +
// tokenizer + vocabulary[.txt|.json] + maybe preprocessor_config), so a model is
// downloaded into `whisper-models/<id>/` and the engine is pointed at that local
// path via `--model` (offline after download). The curated registry (id, label,
// repo, per-file name/size/sha256) lives in the frontend
// (src/transcription/model-registry.js); these commands take the HF repo + file
// manifest for the requested model so the Rust layer stays registry-agnostic.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

/// `model.bin` is the CT2 weights file; its presence marks a model as ready.
const MODEL_SENTINEL: &str = "model.bin";

/// One file of a model's directory, as curated in the frontend registry.
/// `sha256` is hex (lowercase); empty skips verification (only the big LFS
/// `model.bin` carries a digest — the small JSON files are git blobs, not LFS).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSpec {
    pub name: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: u64,
}

/// Root dir for downloaded transcription models.
fn models_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("whisper-models");
    Ok(dir)
}

/// Final on-disk directory for a model id (holds model.bin + config/tokenizer/…).
/// Public so `whisper.rs` can resolve the local `--model` path for transcription.
pub fn model_dir(app: &AppHandle, model_id: &str) -> Result<PathBuf, String> {
    Ok(models_root(app)?.join(sanitize(model_id)))
}

/// True when a model dir exists and holds the CT2 weights (`model.bin`).
pub fn is_downloaded(dir: &Path) -> bool {
    dir.join(MODEL_SENTINEL).is_file()
}

fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

/// A per-file model name must be a single, normal path segment — no separators,
/// no `..`, no absolute/root parts — so it can never escape the `.part` dir when
/// joined nor smuggle path traversal into the HuggingFace URL. `download_model`
/// is an invokable command boundary, so the (otherwise trusted) registry names
/// are validated here rather than assumed safe.
fn is_safe_filename(name: &str) -> bool {
    let mut comps = Path::new(name).components();
    matches!(
        (comps.next(), comps.next()),
        (Some(std::path::Component::Normal(_)), None)
    )
}

#[derive(Serialize)]
pub struct ModelStatus {
    pub id: String,
    pub downloaded: bool,
    pub path: Option<String>,
    pub size_bytes: u64,
}

/// Total bytes of all files directly inside `dir` (non-recursive — CT2 dirs are flat).
fn dir_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

/// Report downloaded/missing status (and on-disk size) for each requested id.
#[tauri::command]
pub async fn list_models(app: AppHandle, model_ids: Vec<String>) -> Result<Vec<ModelStatus>, String> {
    let mut out = Vec::new();
    for id in model_ids {
        let dir = model_dir(&app, &id)?;
        let downloaded = is_downloaded(&dir);
        out.push(ModelStatus {
            id,
            downloaded,
            path: if downloaded { Some(dir.to_string_lossy().to_string()) } else { None },
            size_bytes: if downloaded { dir_size(&dir) } else { 0 },
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

/// Stream every file of a faster-whisper CT2 model from its HuggingFace `repo`
/// into `whisper-models/<id>/`, emitting aggregate %/speed/ETA progress, then
/// verify `model.bin`'s SHA-256. Downloads into a sibling `<id>.part/` dir and
/// atomically renames on success; any failure removes the partial dir so a
/// half-download never looks ready. Returns the final local model-dir path.
#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    model_id: String,
    repo: String,
    files: Vec<FileSpec>,
    total_bytes: Option<u64>,
) -> Result<String, String> {
    if files.is_empty() {
        return Err("Brak listy plików modelu w rejestrze (uzupełnij repo/files).".into());
    }
    let root = models_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let final_dir = model_dir(&app, &model_id)?;
    let part_dir = root.join(format!("{}.part", sanitize(&model_id)));
    let _ = std::fs::remove_dir_all(&part_dir); // clear any prior aborted attempt
    std::fs::create_dir_all(&part_dir).map_err(|e| e.to_string())?;

    // Overall size for %/ETA: prefer the curated total, else sum the manifest.
    let total = total_bytes
        .filter(|n| *n > 0)
        .unwrap_or_else(|| files.iter().map(|f| f.size_bytes).sum());

    let client = reqwest::Client::new();
    let start = std::time::Instant::now();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    // Run the whole multi-file download in one fallible block so we can clean up
    // the .part dir on any error path with a single handler.
    let result: Result<(), String> = async {
        for spec in &files {
            if !is_safe_filename(&spec.name) {
                return Err(format!(
                    "Nieprawidłowa nazwa pliku modelu: {}. Pobieranie odrzucone.",
                    spec.name
                ));
            }
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                repo, spec.name
            );
            let resp = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("Pobieranie modelu nie powiodło się: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!(
                    "Serwer zwrócił błąd {} przy pobieraniu pliku {}.",
                    resp.status(),
                    spec.name
                ));
            }

            let dest = part_dir.join(&spec.name);
            let mut file = tokio::fs::File::create(&dest)
                .await
                .map_err(|e| e.to_string())?;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk =
                    chunk.map_err(|e| format!("Przerwane pobieranie modelu: {e}"))?;
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                downloaded += chunk.len() as u64;

                // Throttle aggregate progress events to ~5/s.
                if last_emit.elapsed().as_millis() >= 200 {
                    last_emit = std::time::Instant::now();
                    let secs = start.elapsed().as_secs_f64().max(0.001);
                    let rate = downloaded as f64 / secs;
                    let percent = if total > 0 {
                        (downloaded as f64 / total as f64) * 100.0
                    } else {
                        0.0
                    };
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

            // Verify the big LFS weights before trusting the download.
            verify_sha256(&dest, &spec.sha256)?;
        }
        Ok(())
    }
    .await;

    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&part_dir);
        return Err(e);
    }

    // Swap the verified .part dir into place without ever leaving the user with
    // no model: back up any existing dir first, move .part in, then drop the
    // backup — restoring it if the final rename fails (permissions, etc.).
    let bak_dir = root.join(format!("{}.bak", sanitize(&model_id)));
    let _ = std::fs::remove_dir_all(&bak_dir);
    let had_existing = final_dir.exists();
    if had_existing {
        std::fs::rename(&final_dir, &bak_dir).map_err(|e| {
            let _ = std::fs::remove_dir_all(&part_dir);
            format!("Nie udało się podmienić modelu: {e}")
        })?;
    }
    if let Err(e) = std::fs::rename(&part_dir, &final_dir) {
        if had_existing {
            let _ = std::fs::rename(&bak_dir, &final_dir); // restore previous model
        }
        let _ = std::fs::remove_dir_all(&part_dir);
        return Err(format!("Nie udało się podmienić modelu: {e}"));
    }
    let _ = std::fs::remove_dir_all(&bak_dir);

    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({ "modelId": model_id, "percent": 100.0, "bytesPerSec": 0.0, "etaSec": 0.0, "done": true }),
    );

    Ok(final_dir.to_string_lossy().to_string())
}

/// Delete a downloaded model directory.
#[tauri::command]
pub async fn delete_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let dir = model_dir(&app, &model_id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
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
