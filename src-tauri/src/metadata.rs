// Video-metadata probe (S-16). Reuses the bundled FFmpeg sidecar to detect a
// source clip's fps + resolution so the import flow can auto-populate project
// settings (#4/#5) instead of leaving every project on the hard-coded
// 1920x1080 default the XML exporter depends on. Tolerant by design: any field
// it can't parse comes back as `null` and the frontend keeps its editable
// default — a probe never blocks an import.

use crate::ffmpeg::run_ffmpeg_output;
use tauri::AppHandle;

#[derive(serde::Serialize)]
pub struct VideoMeta {
    pub fps: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[tauri::command]
pub async fn probe_video_metadata(app: AppHandle, path: String) -> Result<VideoMeta, String> {
    // `ffmpeg -i <file>` with no output exits non-zero but prints the stream
    // banner (resolution, fps) to stderr — exactly what we parse. We ignore the
    // exit code and read the captured buffer.
    let (buf, _ok) = run_ffmpeg_output(&app, &["-hide_banner", "-i", &path]).await?;
    Ok(parse_meta(&buf))
}

fn parse_meta(stderr: &str) -> VideoMeta {
    let video_line = stderr.lines().find(|l| l.contains("Video:"));
    let (mut width, mut height, mut fps) = (None, None, None);
    if let Some(line) = video_line {
        (width, height) = parse_resolution(line);
        fps = parse_fps(line);
    }
    VideoMeta { fps, width, height }
}

// Find the first `<digits>x<digits>` token (e.g. "1920x1080"), tolerating a
// trailing SAR/DAR suffix on the same comma-separated field.
fn parse_resolution(line: &str) -> (Option<u32>, Option<u32>) {
    for raw in line.split([',', ' ']) {
        let tok = raw.trim();
        if let Some((w, h)) = tok.split_once('x') {
            if let (Ok(wn), Ok(hn)) = (w.parse::<u32>(), h.parse::<u32>()) {
                if wn >= 16 && hn >= 16 {
                    return (Some(wn), Some(hn));
                }
            }
        }
    }
    (None, None)
}

// Pull the number immediately preceding the `fps` token (e.g. "25 fps",
// "23.98 fps"). Prefer `fps` over `tbr` since `tbr` can be doubled.
fn parse_fps(line: &str) -> Option<f64> {
    let tokens: Vec<&str> = line.split([',', ' ']).map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
    let pos = tokens.iter().position(|&t| t == "fps")?;
    if pos == 0 {
        return None;
    }
    tokens[pos - 1].parse::<f64>().ok()
}
