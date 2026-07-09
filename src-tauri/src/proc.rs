// Raw-`Command` process primitives (Phase 3: spawn-path rework).
//
// The heavy sidecars (WhisperX engine, FFmpeg) used to be launched through
// `tauri-plugin-shell`'s `app.shell().sidecar(name)`, which resolves a binary
// *beside the main executable* (the read-only install dir on Windows). The thin
// installer stages those binaries into a writable deps root and spawns them by
// **absolute path**, which the shell plugin's fixed-scope sidecar API cannot do
// without a broad dynamic scope glob. This module centralizes the raw
// `tokio::process::Command` spawn + stdout/stderr pump + per-call-site timeout
// (with explicit kill, no orphan) that replaces the plugin's `CommandEvent`
// stream — shared by `engine::run_engine`, `ffmpeg::run_ffmpeg_output`, and
// `waveform`. The transcription/align driver (`whisper::drive_engine`) needs a
// progress + cancel loop, so it builds on `build_command` directly rather than
// `spawn_and_collect`.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Failure modes of a raw spawn, so call sites can map each to their own Polish
/// message (a wedged probe → "przekroczył limit czasu"; a missing binary →
/// "niedostępny"). Keeping timeout distinct lets `run_engine` reproduce its
/// exact amber-state message.
pub enum ProcError {
    /// The process could not be spawned at all (binary missing, not executable…).
    Spawn(std::io::Error),
    /// The bounded run elapsed and the child was killed explicitly.
    TimedOut,
    /// An I/O error while waiting/reading (already a String message).
    Io(String),
}

/// Build a `tokio::process::Command` for an absolute program path with piped
/// stdio. On Windows, `CREATE_NO_WINDOW` suppresses the console window the shell
/// plugin used to hide for us (a frozen-Python sidecar would otherwise flash a
/// console on every spawn). `kill_on_drop` is a safety net so a dropped future
/// (panic/cancel) never leaves an orphan — the explicit kills below are the
/// primary mechanism.
pub fn build_command(program: &Path, args: &[String]) -> Command {
    let mut std_cmd = std::process::Command::new(program);
    std_cmd.args(args);
    std_cmd.stdin(Stdio::null());
    std_cmd.stdout(Stdio::piped());
    std_cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut cmd = Command::from(std_cmd);
    cmd.kill_on_drop(true);
    cmd
}

/// Spawn `cmd`, drain stdout + stderr fully, and wait for exit — bounded by
/// `timeout` (`None` = unbounded, cancel-only). Readers run as concurrent tasks
/// so a chatty child can never deadlock on a full pipe while we wait. On timeout
/// the child is killed **explicitly** (then reaped) and `TimedOut` is returned so
/// callers surface a bounded-error state instead of hanging.
///
/// Returns `(stdout, stderr, exit_code)` as lossy-UTF8 strings. `exit_code` is
/// `None` when the process was killed without an exit status.
pub async fn spawn_and_collect(
    mut cmd: Command,
    timeout: Option<Duration>,
) -> Result<(String, String, Option<i32>), ProcError> {
    let mut child = cmd.spawn().map_err(ProcError::Spawn)?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| ProcError::Io("brak strumienia stdout procesu".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| ProcError::Io("brak strumienia stderr procesu".into()))?;

    // Drain both pipes concurrently with the wait below (owned readers → 'static).
    let out_task = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = stdout.read_to_end(&mut b).await;
        b
    });
    let err_task = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = stderr.read_to_end(&mut b).await;
        b
    });

    let (code, timed_out) = match timeout {
        Some(t) => match tokio::time::timeout(t, child.wait()).await {
            Ok(st) => (st.map_err(|e| ProcError::Io(e.to_string()))?.code(), false),
            Err(_) => {
                // Elapsed — kill explicitly (not via drop) and reap, so no orphan.
                let _ = child.kill().await;
                let _ = child.wait().await;
                (None, true)
            }
        },
        None => (
            child
                .wait()
                .await
                .map_err(|e| ProcError::Io(e.to_string()))?
                .code(),
            false,
        ),
    };

    let out = out_task.await.unwrap_or_default();
    let err = err_task.await.unwrap_or_default();
    if timed_out {
        return Err(ProcError::TimedOut);
    }
    Ok((
        String::from_utf8_lossy(&out).into_owned(),
        String::from_utf8_lossy(&err).into_owned(),
        code,
    ))
}
