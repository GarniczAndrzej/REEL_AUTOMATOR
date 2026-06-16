// WhisperX engine sidecar plumbing.
//
// Resolves and drives the bundled `whisperx-engine` sidecar (registered in
// tauri.conf.json → bundle.externalBin) the same way ffmpeg.rs drives FFmpeg.
// Phase 1 only needs the readiness self-check; transcription wiring lands in
// Phase 2.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{Command, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Base name of the sidecar; Tauri resolves the arch-suffixed file per platform.
pub const ENGINE_SIDECAR: &str = "whisperx-engine";

/// Bound for the cheap `--capability` probe. It does a device detect + dir check
/// (no model load, no align), so even cold — torch import + onefile extraction —
/// it should land well inside this; the bound only guards a wedged sidecar.
const CAPABILITY_TIMEOUT: Duration = Duration::from_secs(60);

/// Bound for the heavy `--selftest` probe (manual re-verify). It loads the align
/// model and runs a real `align()` (tens of seconds warm), so it gets a generous
/// budget — enough for a legitimate slow run, but still finite so the unbounded
/// 15-min hang the user observed can never recur.
const SELFTEST_TIMEOUT: Duration = Duration::from_secs(300);

/// Apply `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` to an engine command so
/// huggingface_hub/transformers skip per-launch network etag checks and use only
/// the locally-present model files. Without this the bundled wav2vec2 align model
/// still triggers blocking HEAD requests to huggingface.co on every spawn — ~50s
/// of pure network wait on the cold `--selftest` that gates the readiness badge.
///
/// Safe for the self-test, align-only, and *non-diarize* transcription paths —
/// all use bundled/local models. Do NOT apply when diarization is requested:
/// pyannote may still need to be fetched from HuggingFace.
pub fn with_hf_offline(cmd: Command) -> Command {
    cmd.env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
}

/// Resolve the external wav2vec2 alignment-model directory that ships *beside*
/// the sidecar (Tauri `bundle.resources` → `align_models/`). The model is no
/// longer baked into the frozen binary: a multi-GB onefile Mach-O fails to load
/// on macOS, so it lives outside the executable and the path is passed to the
/// engine via `--align-model-dir`.
///
/// Resolution order:
///   1. bundled resource dir (production app bundle), then
///   2. the repo `src-tauri/binaries/align_models` (covers `tauri dev`, where
///      `build.sh` stages the model next to the sidecar binary).
/// Returns `None` when neither exists (engine then falls back to next-to-exe).
pub fn align_model_dir(app: &AppHandle) -> Option<String> {
    if let Ok(p) = app.path().resolve("align_models", BaseDirectory::Resource) {
        if p.is_dir() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("align_models");
    if dev.is_dir() {
        return Some(dev.to_string_lossy().into_owned());
    }
    None
}

/// Readiness report returned by the engine `--selftest` / `--capability` probe.
/// `Deserialize` is derived so cached verdicts (see `engine-readiness` cache)
/// can be read back from disk.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct EngineStatus {
    pub ok: bool,
    pub version: String,
    pub gpu: bool,
    pub device: String,
    pub alignment_model_ready: bool,
}

/// Run the sidecar with the given args, collecting (stdout, stderr, exit_code),
/// bounded by `timeout`. `exit_code` is `None` when the process was killed
/// without an exit status.
///
/// On timeout the child is killed **explicitly** — `CommandChild` is not
/// documented to terminate the OS process on drop (mirroring `std::process::
/// Child`), so relying on drop would leave an orphaned sidecar running, i.e. the
/// same hang detached and invisible. An elapsed bound returns `Err` so callers
/// surface the amber "nie można sprawdzić" state instead of hanging.
pub async fn run_engine(
    app: &AppHandle,
    args: &[&str],
    timeout: Duration,
) -> Result<(String, String, Option<i32>), String> {
    let arg_vec: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    // Both callers (self-test, capability) use only the bundled align model (or
    // no model at all) — force HF offline so they don't stall on network checks.
    let sidecar = with_hf_offline(
        app.shell()
            .sidecar(ENGINE_SIDECAR)
            .map_err(|e| format!("Silnik WhisperX niedostępny: {e}"))?
            .args(arg_vec),
    );
    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Nie udało się uruchomić silnika WhisperX: {e}"))?;
    let mut out = String::new();
    let mut err = String::new();
    let mut code: Option<i32> = None;

    let recv_loop = async {
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
    };

    match tokio::time::timeout(timeout, recv_loop).await {
        Ok(()) => Ok((out, err, code)),
        Err(_) => {
            // Elapsed — kill the child explicitly (not via drop) and report.
            let _ = child.kill();
            Err("Sprawdzanie silnika przekroczyło limit czasu".to_string())
        }
    }
}

/// Parse the engine's readiness JSON (shared by `--selftest` and `--capability`).
fn parse_engine_status(out: &str) -> Result<EngineStatus, String> {
    let v: serde_json::Value = serde_json::from_str(out.trim())
        .map_err(|e| format!("Niepoprawna odpowiedź silnika: {e}"))?;
    Ok(EngineStatus {
        ok: v["ok"].as_bool().unwrap_or(false),
        version: v["version"].as_str().unwrap_or("").to_string(),
        gpu: v["gpu"].as_bool().unwrap_or(false),
        device: v["device"].as_str().unwrap_or("").to_string(),
        alignment_model_ready: v["alignment_model_ready"].as_bool().unwrap_or(false),
    })
}

// ── engine-readiness verdict cache ───────────────────────────────────
//
// Content-addressed disk cache mirroring the project.rs / waveform.rs recipe
// (no TTL, validate-on-read, best-effort). The key folds in the app package
// version (bumps when a new bundled sidecar ships) plus the align-model dir's
// size+mtime (a swapped model invalidates stale verdicts). The key must be
// pre-spawn computable so a hit can genuinely skip the spawn — the engine-
// reported `version` is carried inside the stored verdict for on-read sanity
// only, never used as the lookup key.

/// Compute the pre-spawn cache key. SHA-256 of `app version` + align-model dir
/// metadata; falls back to a stable sentinel when the dir is absent.
fn readiness_cache_key(app: &AppHandle) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(app.package_info().version.to_string().as_bytes());
    h.update(b"\x00");
    match align_model_dir(app).and_then(|d| std::fs::metadata(&d).ok()) {
        Some(meta) => {
            h.update(meta.len().to_le_bytes());
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            h.update(mtime.to_le_bytes());
        }
        None => h.update(b"no-align-dir"),
    }
    format!("{:x}", h.finalize())
}

/// Read a cached verdict for `key`. Returns `None` on any error (treated as a
/// miss — never fatal).
fn read_readiness_cache(app: &AppHandle, key: &str) -> Option<EngineStatus> {
    let dir = app.path().app_cache_dir().ok()?.join("engine-readiness");
    let text = std::fs::read_to_string(dir.join(format!("{key}.json"))).ok()?;
    serde_json::from_str(&text).ok()
}

/// Persist `status` under `key`. Best-effort: any error is silently ignored.
fn write_readiness_cache(app: &AppHandle, key: &str, status: &EngineStatus) {
    if let Ok(base) = app.path().app_cache_dir() {
        let dir = base.join("engine-readiness");
        if std::fs::create_dir_all(&dir).is_ok() {
            if let Ok(json) = serde_json::to_string(status) {
                let _ = std::fs::write(dir.join(format!("{key}.json")), json);
            }
        }
    }
}

/// Spawn the sidecar's `--selftest` probe and parse its readiness JSON. This is
/// the heavy, authoritative path (loads the align model, runs a real align) used
/// by the manual "pełna weryfikacja" action; it also refreshes the readiness
/// cache so subsequent launches reflect the heavyweight result. Does not require
/// a downloaded transcription model.
#[tauri::command]
pub async fn whisperx_engine_check(app: AppHandle) -> Result<EngineStatus, String> {
    let mut args: Vec<String> = vec!["--selftest".into()];
    if let Some(dir) = align_model_dir(&app) {
        args.push("--align-model-dir".into());
        args.push(dir);
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (out, err, code) = run_engine(&app, &arg_refs, SELFTEST_TIMEOUT).await?;
    if code != Some(0) {
        return Err(format!(
            "Silnik WhisperX zakończył self-test z błędem (kod {:?}): {}",
            code,
            err.trim()
        ));
    }
    let status = parse_engine_status(&out)?;
    write_readiness_cache(&app, &readiness_cache_key(&app), &status);
    Ok(status)
}

/// The badge's entry point: return a cached verdict instantly on a hit, else run
/// the cheap `--capability` probe (device detect + dir check, no model load, no
/// align, no HF network), bounded by a timeout, and cache the result. Cache is
/// best-effort — any error falls through to a live probe.
#[tauri::command]
pub async fn whisperx_engine_capability(app: AppHandle) -> Result<EngineStatus, String> {
    let key = readiness_cache_key(&app);
    if let Some(cached) = read_readiness_cache(&app, &key) {
        return Ok(cached);
    }
    let mut args: Vec<String> = vec!["--capability".into()];
    if let Some(dir) = align_model_dir(&app) {
        args.push("--align-model-dir".into());
        args.push(dir);
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (out, err, code) = run_engine(&app, &arg_refs, CAPABILITY_TIMEOUT).await?;
    if code != Some(0) {
        return Err(format!(
            "Sprawdzanie silnika WhisperX nie powiodło się (kod {:?}): {}",
            code,
            err.trim()
        ));
    }
    let status = parse_engine_status(&out)?;
    write_readiness_cache(&app, &key, &status);
    Ok(status)
}
