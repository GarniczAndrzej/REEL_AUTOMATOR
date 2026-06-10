use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

static WAVEFORM_CALL: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn extract_waveform(
    app: AppHandle,
    video_path: String,
    start_s: f64,
    end_s: f64,
    num_samples: u32,
) -> Result<Vec<f32>, String> {
    if end_s <= start_s || num_samples == 0 {
        return Ok(vec![0.0; num_samples as usize]);
    }

    if let Some((dir, key)) = cache_key(&app, &video_path, start_s, end_s, num_samples) {
        let cached = dir.join(format!("{}.bin", key));
        if cached.exists() {
            if let Ok(bytes) = std::fs::read(&cached) {
                let peaks = bytes_to_f32(&bytes);
                if peaks.len() == num_samples as usize {
                    return Ok(peaks);
                }
            }
        }
    }

    let peaks = extract(&app, &video_path, start_s, end_s, num_samples).await?;

    if let Some((dir, key)) = cache_key(&app, &video_path, start_s, end_s, num_samples) {
        let _ = std::fs::write(dir.join(format!("{}.bin", key)), f32_to_bytes(&peaks));
    }

    Ok(peaks)
}

// ── Cache helpers ────────────────────────────────────────────────────

fn cache_key(
    app: &AppHandle,
    path: &str,
    start_s: f64,
    end_s: f64,
    num_samples: u32,
) -> Option<(std::path::PathBuf, String)> {
    let dir = app.path().app_cache_dir().ok()?.join("waveform-cache");
    std::fs::create_dir_all(&dir).ok()?;
    let src_hash = source_hash(path)?;
    let start_ms = (start_s * 1000.0).round() as i64;
    let end_ms = (end_s * 1000.0).round() as i64;
    let key = format!("{}_{}_{}_{}",  src_hash, start_ms, end_ms, num_samples);
    Some((dir, key))
}

fn source_hash(path: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    let meta = std::fs::metadata(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(meta.len().to_le_bytes());
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    hasher.update(mtime.to_le_bytes());
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 1024 * 1024];
    let n = f.read(&mut buf).ok()?;
    hasher.update(&buf[..n]);
    Some(format!("{:x}", hasher.finalize())[..16].to_string())
}

fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn f32_to_bytes(peaks: &[f32]) -> Vec<u8> {
    peaks.iter().flat_map(|v| v.to_le_bytes()).collect()
}

// ── Extraction ───────────────────────────────────────────────────────

async fn extract(
    app: &AppHandle,
    video_path: &str,
    start_s: f64,
    end_s: f64,
    num_samples: u32,
) -> Result<Vec<f32>, String> {
    let duration = end_s - start_s;
    let sr = ((num_samples as f64) / duration).ceil() as u32;
    let sr = sr.max(100);

    let raw_path = std::env::temp_dir()
        .join(format!("reel_waveform_{}_{}.raw", std::process::id(), WAVEFORM_CALL.fetch_add(1, Ordering::Relaxed)));
    let raw_path_str = raw_path.to_string_lossy().to_string();

    let start_str = format!("{:.6}", start_s);
    let end_str = format!("{:.6}", end_s);
    let sr_str = sr.to_string();

    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args([
            "-y",
            "-ss", &start_str,
            "-to", &end_str,
            "-i", video_path,
            "-ac", "1",
            "-ar", &sr_str,
            "-f", "f32le",
            "-vn",
            &raw_path_str,
        ]);

    let (mut rx, _child) = sidecar.spawn().map_err(|e| e.to_string())?;
    while let Some(ev) = rx.recv().await {
        if matches!(ev, CommandEvent::Terminated(_)) {
            break;
        }
    }

    let raw_bytes = std::fs::read(&raw_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&raw_path);

    let samples: Vec<f32> = raw_bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();

    if samples.is_empty() {
        return Ok(vec![0.0; num_samples as usize]);
    }

    let n = num_samples as usize;
    let total = samples.len();
    let peaks: Vec<f32> = (0..n)
        .map(|i| {
            let lo = i * total / n;
            let hi = (((i + 1) * total / n)).max(lo + 1).min(total);
            let slice = &samples[lo..hi];
            let rms = (slice.iter().map(|x| x * x).sum::<f32>() / slice.len() as f32).sqrt();
            rms.min(1.0)
        })
        .collect();

    Ok(peaks)
}
