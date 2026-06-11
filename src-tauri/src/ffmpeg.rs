use tauri::AppHandle;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

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
