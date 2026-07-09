use crate::proc::ProcError;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Resolve the absolute FFmpeg exe to spawn, three-way precedence:
///   1. staged deps root (thin-installer download, triple-suffixed),
///   2. beside the main exe (production bundle — Tauri `externalBin` strips the
///      triple),
///   3. repo `src-tauri/binaries/ffmpeg-<triple>` (dev / `tauri dev`).
/// FFmpeg is variant-agnostic, so the `staged_path` variant arg is a placeholder.
pub fn ffmpeg_bin_path(app: &AppHandle) -> Result<PathBuf, String> {
    let triple = crate::deps::host_triple();
    let ext = if cfg!(windows) { ".exe" } else { "" };
    if let Ok(root) = crate::deps::deps_root(app) {
        let staged = crate::deps::staged_path(&root, "ffmpeg-bin", "cpu", triple);
        if staged.is_file() {
            return Ok(staged);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(format!("ffmpeg{ext}"));
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("ffmpeg-{triple}{ext}"));
    if dev.is_file() {
        return Ok(dev);
    }
    Err(format!(
        "FFmpeg niedostępny dla {triple}. Pobierz zależności lub uruchom: sidecar/fetch-ffmpeg.sh"
    ))
}

/// Run FFmpeg with `args`, returning `(combined_output, ok)` where
/// `combined_output` is stdout followed by stderr (FFmpeg prints its stream
/// banner — which `metadata::probe_video_metadata` parses — to stderr) and `ok`
/// is `exit_code == 0`. Unbounded: audio extraction on a long source can run for
/// minutes, so no timeout is imposed here (the transcription path is cancel-only).
pub async fn run_ffmpeg_output(app: &AppHandle, args: &[&str]) -> Result<(String, bool), String> {
    let arg_vec: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let bin = ffmpeg_bin_path(app)?;
    let cmd = crate::proc::build_command(&bin, &arg_vec);
    match crate::proc::spawn_and_collect(cmd, None).await {
        Ok((out, err, code)) => {
            let mut buf = out;
            if !buf.is_empty() && !buf.ends_with('\n') {
                buf.push('\n');
            }
            buf.push_str(&err);
            Ok((buf, code == Some(0)))
        }
        Err(ProcError::Spawn(e)) => Err(format!("Nie udało się uruchomić FFmpeg: {e}")),
        Err(ProcError::TimedOut) => Err("FFmpeg przekroczył limit czasu.".to_string()),
        Err(ProcError::Io(e)) => Err(e),
    }
}
