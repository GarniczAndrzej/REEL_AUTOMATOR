use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

static FACE_CALL: AtomicU64 = AtomicU64::new(0);

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct FaceKeyframe {
    pub t: f64,
    pub x: f64,
}

#[tauri::command]
pub async fn detect_face_keyframes(
    app: AppHandle,
    source_path: String,
) -> Result<Vec<FaceKeyframe>, String> {
    let cache_key = build_cache_key(&app, &source_path);

    if let Some((ref dir, ref hash)) = cache_key {
        let cached = dir.join(format!("{}.json", hash));
        if cached.exists() {
            if let Ok(text) = std::fs::read_to_string(&cached) {
                if let Ok(kfs) = serde_json::from_str::<Vec<FaceKeyframe>>(&text) {
                    return Ok(kfs);
                }
            }
        }
    }

    let keyframes = extract_and_analyze(&app, &source_path).await?;

    if let Some((ref dir, ref hash)) = cache_key {
        if let Ok(json) = serde_json::to_string(&keyframes) {
            let _ = std::fs::write(dir.join(format!("{}.json", hash)), json);
        }
    }

    Ok(keyframes)
}

fn build_cache_key(app: &AppHandle, path: &str) -> Option<(std::path::PathBuf, String)> {
    let dir = app.path().app_cache_dir().ok()?.join("face-cache");
    std::fs::create_dir_all(&dir).ok()?;
    let hash = compute_hash(path)?;
    Some((dir, hash))
}

fn compute_hash(path: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    let meta = std::fs::metadata(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(meta.len().to_le_bytes());
    // Include mtime to distinguish files with identical size and first MB
    let mtime = meta.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    hasher.update(mtime.to_le_bytes());
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 1024 * 1024];
    let n = f.read(&mut buf).ok()?;
    hasher.update(&buf[..n]);
    Some(format!("{:x}", hasher.finalize()))
}

async fn extract_and_analyze(app: &AppHandle, source: &str) -> Result<Vec<FaceKeyframe>, String> {
    const W: usize = 320;
    const H: usize = 180;
    const FRAME_BYTES: usize = W * H;

    // Write rawvideo to a temp file to avoid line-buffering corruption of 0x0A bytes
    let raw_path = std::env::temp_dir()
        .join(format!("reel_face_{}_{}.raw", std::process::id(), FACE_CALL.fetch_add(1, Ordering::Relaxed)));
    let raw_path_str = raw_path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args([
            "-y",
            "-i",
            source,
            "-vf",
            &format!("fps=2,scale={}:{}", W, H),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            &raw_path_str,
        ]);

    let (mut rx, _child) = sidecar.spawn().map_err(|e| e.to_string())?;
    // Drain events until termination
    while let Some(ev) = rx.recv().await {
        if matches!(ev, CommandEvent::Terminated(_)) { break; }
    }

    let raw_bytes = std::fs::read(&raw_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&raw_path);

    let mut offset = 0usize;
    let mut frame_idx: usize = 0;
    let mut raw: Vec<(f64, f64)> = Vec::new();

    while offset + FRAME_BYTES <= raw_bytes.len() {
        let frac = find_face_frac(&raw_bytes[offset..offset + FRAME_BYTES], W, H);
        raw.push((frame_idx as f64 / 2.0, frac));
        frame_idx += 1;
        offset += FRAME_BYTES;
    }

    Ok(smooth_keyframes(raw))
}

fn find_face_frac(frame: &[u8], w: usize, h: usize) -> f64 {
    let mut col_e = vec![0f64; w];
    for y in 0..h {
        let row = &frame[y * w..(y + 1) * w];
        for x in 1..(w - 1) {
            col_e[x] += (row[x + 1] as f64 - row[x - 1] as f64).abs();
        }
    }

    // Sliding window width = crop window at this scale (h * 9/16)
    let win = (h * 9 / 16).max(1).min(w);
    let half = win / 2;

    let mut window_sum: f64 = col_e[..win].iter().sum();
    let mut best = window_sum;
    let mut best_center = half;

    for x in 1..=(w.saturating_sub(win)) {
        window_sum += col_e[x + win - 1];
        window_sum -= col_e[x - 1];
        if window_sum > best {
            best = window_sum;
            best_center = x + half;
        }
    }

    (best_center as f64) / (w as f64)
}

fn smooth_keyframes(raw: Vec<(f64, f64)>) -> Vec<FaceKeyframe> {
    if raw.is_empty() {
        return Vec::new();
    }
    const ALPHA: f64 = 0.15;
    let mut ema = raw[0].1;
    let mut last_x = -1.0f64;
    let mut result: Vec<FaceKeyframe> = Vec::new();

    for (t, x) in raw {
        ema = ALPHA * x + (1.0 - ALPHA) * ema;
        if result.is_empty() || (ema - last_x).abs() >= 0.02 {
            result.push(FaceKeyframe { t, x: ema });
            last_x = ema;
        }
    }

    result
}
