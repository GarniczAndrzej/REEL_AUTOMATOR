// WhisperX engine sidecar plumbing.
//
// Resolves and drives the bundled `whisperx-engine` sidecar (registered in
// tauri.conf.json → bundle.externalBin) the same way ffmpeg.rs drives FFmpeg.
// Phase 1 only needs the readiness self-check; transcription wiring lands in
// Phase 2.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Base name of the sidecar; Tauri resolves the arch-suffixed file per platform.
pub const ENGINE_SIDECAR: &str = "whisperx-engine";

/// Readiness report returned by the engine `--selftest` probe.
#[derive(Debug, Serialize, Default)]
pub struct EngineStatus {
    pub ok: bool,
    pub version: String,
    pub gpu: bool,
    pub device: String,
    pub alignment_model_ready: bool,
}

/// Run the sidecar with the given args, collecting (stdout, stderr, exit_code).
/// `exit_code` is `None` when the process was killed without an exit status.
pub async fn run_engine(
    app: &AppHandle,
    args: &[&str],
) -> Result<(String, String, Option<i32>), String> {
    let arg_vec: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let sidecar = app
        .shell()
        .sidecar(ENGINE_SIDECAR)
        .map_err(|e| format!("Silnik WhisperX niedostępny: {e}"))?
        .args(arg_vec);
    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("Nie udało się uruchomić silnika WhisperX: {e}"))?;
    let mut out = String::new();
    let mut err = String::new();
    let mut code: Option<i32> = None;
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(b) => out.push_str(&String::from_utf8_lossy(&b)),
            CommandEvent::Stderr(b) => err.push_str(&String::from_utf8_lossy(&b)),
            CommandEvent::Terminated(p) => {
                code = p.code;
                break;
            }
            _ => {}
        }
    }
    Ok((out, err, code))
}

/// Spawn the sidecar's `--selftest` probe and parse its readiness JSON.
/// Does not require a downloaded transcription model.
#[tauri::command]
pub async fn whisperx_engine_check(app: AppHandle) -> Result<EngineStatus, String> {
    let (out, err, code) = run_engine(&app, &["--selftest"]).await?;
    if code != Some(0) {
        return Err(format!(
            "Silnik WhisperX zakończył self-test z błędem (kod {:?}): {}",
            code,
            err.trim()
        ));
    }
    let v: serde_json::Value = serde_json::from_str(out.trim())
        .map_err(|e| format!("Niepoprawna odpowiedź self-testu silnika: {e}"))?;
    Ok(EngineStatus {
        ok: v["ok"].as_bool().unwrap_or(false),
        version: v["version"].as_str().unwrap_or("").to_string(),
        gpu: v["gpu"].as_bool().unwrap_or(false),
        device: v["device"].as_str().unwrap_or("").to_string(),
        alignment_model_ready: v["alignment_model_ready"].as_bool().unwrap_or(false),
    })
}
