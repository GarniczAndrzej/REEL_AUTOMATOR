use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Notify;

pub async fn run_ffmpeg_output(
    app: &AppHandle,
    args: &[&str],
) -> Result<(String, bool), String> {
    let arg_vec: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let sidecar = app.shell().sidecar("ffmpeg").map_err(|e| e.to_string())?.args(arg_vec);
    let (mut rx, _child) = sidecar.spawn().map_err(|e| e.to_string())?;
    let mut buf = String::new();
    let mut ok = false;
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                buf.push_str(&String::from_utf8_lossy(&b));
                buf.push('\n');
            }
            CommandEvent::Terminated(p) => { ok = p.code == Some(0); break; }
            _ => {}
        }
    }
    Ok((buf, ok))
}

#[allow(dead_code)]
pub async fn run_ffmpeg(
    app: &AppHandle,
    args: Vec<String>,
    reel_id: String,
    total_frames: u64,
) -> Result<(), String> {
    let cancel = Arc::new(Notify::new());
    run_ffmpeg_cancellable(app, args, &reel_id, total_frames, cancel).await
}

pub async fn run_ffmpeg_cancellable(
    app: &AppHandle,
    args: Vec<String>,
    reel_id: &str,
    total_frames: u64,
    cancel: Arc<Notify>,
) -> Result<(), String> {
    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(args);
    let (mut rx, child) = sidecar.spawn().map_err(|e| e.to_string())?;

    let mut stderr_tail: Vec<String> = Vec::new();

    loop {
        tokio::select! {
            _ = cancel.notified() => {
                let _ = child.kill();
                return Err("cancelled".into());
            }
            event = rx.recv() => {
                match event {
                    Some(CommandEvent::Stderr(line)) | Some(CommandEvent::Stdout(line)) => {
                        let s = String::from_utf8_lossy(&line);
                        let mut emitted = false;
                        for l in s.lines() {
                            if let Some(rest) = l.strip_prefix("frame=") {
                                if let Ok(n) = rest.split_ascii_whitespace().next().unwrap_or("").parse::<u64>() {
                                    let pct = if total_frames > 0 {
                                        (n as f64 / total_frames as f64 * 100.0).min(100.0)
                                    } else {
                                        0.0
                                    };
                                    let _ = app.emit(
                                        "render-progress",
                                        serde_json::json!({ "reel_id": reel_id, "percent": pct }),
                                    );
                                    emitted = true;
                                }
                            }
                        }
                        if !emitted {
                            // Buffer up to 10 non-progress lines for error reporting
                            let trimmed = s.trim().to_string();
                            if !trimmed.is_empty() {
                                if stderr_tail.len() >= 10 { stderr_tail.remove(0); }
                                stderr_tail.push(trimmed);
                            }
                        }
                    }
                    Some(CommandEvent::Terminated(payload)) => {
                        if payload.code != Some(0) {
                            let detail = stderr_tail.join("\n");
                            return Err(format!("ffmpeg exit code {:?}\n{}", payload.code, detail));
                        }
                        return Ok(());
                    }
                    None => return Err("ffmpeg process ended unexpectedly".into()),
                    _ => {}
                }
            }
        }
    }
}
