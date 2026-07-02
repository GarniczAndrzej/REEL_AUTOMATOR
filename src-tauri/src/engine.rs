// WhisperX engine sidecar plumbing.
//
// Resolves and drives the bundled `whisperx-engine` sidecar (registered in
// tauri.conf.json → bundle.externalBin) the same way ffmpeg.rs drives FFmpeg.
// Phase 1 only needs the readiness self-check; transcription wiring lands in
// Phase 2.

use serde::{Deserialize, Serialize};
use std::time::Duration;
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
/// the locally-present model files. Without this a present-but-uncached-elsewhere
/// wav2vec2 align model would still trigger blocking HEAD requests to
/// huggingface.co on every spawn — ~50s of pure network wait on the cold
/// `--selftest` that gates the readiness badge.
///
/// Used ONLY by the report-only `run_engine` paths (self-test, capability) — both
/// must never trigger the S-29 first-run align-model download. The transcribe
/// (non-diarize) and align-only paths (`whisper.rs`) deliberately do NOT wrap
/// their spawn with this: the engine now gates offline-vs-download itself per
/// language via `model_cache_only` (Phase 1), and a first-run download needs
/// network, so forcing this env there would block it before it could start. Do
/// NOT apply when diarizing either: pyannote may still need to be fetched from
/// HuggingFace.
pub fn with_hf_offline(cmd: Command) -> Command {
    cmd.env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
}

/// Resolve the **writable** per-user directory where the wav2vec2 alignment model
/// is cached, and ensure it exists. The model is no longer bundled with the app:
/// the 2.4 GB HF cache (further doubled to ~4.7 GB by Tauri dereferencing the HF
/// symlinks) pushed the DMG far past GitHub's 2 GB release-asset limit. Instead it
/// is downloaded on first transcription into this app-cache dir and reused offline
/// afterwards. The path is handed to the engine via `--align-model-dir`; the
/// engine downloads into it (standard `models--org--repo/snapshots/…` HF layout)
/// when it is empty.
///
/// Returns `None` only if the app cache dir cannot be resolved (engine then falls
/// back to its own next-to-exe / default-HF-cache resolution).
pub fn align_model_dir(app: &AppHandle) -> Option<String> {
    let dir = app.path().app_cache_dir().ok()?.join("align_models");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.to_string_lossy().into_owned())
}

/// Whether the alignment model has already been downloaded into the cache dir.
/// Drives the `HF_HUB_OFFLINE` decision: when present, a run may go fully offline
/// (no per-spawn network etag checks — ~50 s saved cold); when absent, the run
/// MUST be allowed network so the first-run download can proceed.
///
/// Detection is a shallow recursive glob for a non-trivial `*.safetensors` OR
/// `*.bin` weight file under the cache (the engine writes the standard HF
/// snapshot layout, where the weight is a symlink into `blobs/` — `metadata`
/// follows it to the real size). Both extensions are checked because
/// `_ensure_align_model` downloads whichever single format a language's repo
/// actually ships on `main` — the Polish repo, for one, has no `.safetensors`
/// at all, only `pytorch_model.bin` (see change.md's Phase 1 deviation note).
pub fn align_model_present(app: &AppHandle) -> bool {
    fn has_weight(p: &std::path::Path, depth: usize) -> bool {
        if depth > 6 {
            return false;
        }
        let Ok(rd) = std::fs::read_dir(p) else {
            return false;
        };
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                if has_weight(&path, depth + 1) {
                    return true;
                }
            } else if path
                .extension()
                .map(|x| x == "safetensors" || x == "bin")
                .unwrap_or(false)
                && std::fs::metadata(&path).map(|m| m.len() > 1024).unwrap_or(false)
            {
                return true;
            }
        }
        false
    }
    match align_model_dir(app) {
        Some(dir) => has_weight(std::path::Path::new(&dir), 0),
        None => false,
    }
}

/// Recursive total size of real (non-symlink) files under `dir`. The HF cache
/// layout the align-model download writes nests `blobs/` (real files) inside
/// `models--org--repo/snapshots/<sha>/…` (symlinks into `blobs/`) several levels
/// deep — unlike the flat CT2 model dirs in `models.rs`, so this walks
/// recursively. Symlinks are skipped (not dereferenced), so each blob is
/// counted exactly once via its real file in `blobs/`, never doubled via the
/// snapshot symlink that points to it.
fn dir_size_recursive(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let path = e.path();
            if let Ok(meta) = std::fs::symlink_metadata(&path) {
                if meta.is_dir() {
                    total += dir_size_recursive(&path);
                } else if meta.is_file() {
                    total += meta.len();
                }
            }
        }
    }
    total
}

/// Cheap status read for the model-manager's align-model card: whether the
/// per-language model is present, and its on-disk footprint. Never spawns the
/// sidecar (mirrors `align_model_present`'s glob-only presence check).
#[tauri::command]
pub async fn align_model_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let downloaded = align_model_present(&app);
    let size_bytes = align_model_dir(&app)
        .map(|d| dir_size_recursive(std::path::Path::new(&d)))
        .unwrap_or(0);
    Ok(serde_json::json!({ "downloaded": downloaded, "size_bytes": size_bytes }))
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
    /// Whether this verdict was earned by the heavy `--selftest` (which actually
    /// imports whisperx + runs a real align) versus the cheap `--capability`
    /// probe. Only an authoritative verdict may paint the green "gotowy" badge.
    /// Not part of the sidecar JSON — set by the Rust command before caching, so
    /// `#[serde(default)]` keeps pre-existing cache files (which lack it) readable.
    #[serde(default)]
    pub authoritative: bool,
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
    // Both callers (self-test, capability) are report-only and must never trigger
    // the S-29 first-run align-model download — force HF offline so they read
    // whatever is (or isn't) already cached instead of stalling on network checks.
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
        // Not in the sidecar JSON — the calling command stamps this before caching.
        authoritative: false,
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
    let mut status = parse_engine_status(&out)?;
    // The self-test actually imported whisperx + ran a real align — this verdict
    // is authoritative and is the only path allowed to earn the green badge.
    status.authoritative = true;
    write_readiness_cache(&app, &readiness_cache_key(&app), &status);
    Ok(status)
}

/// Launch-time badge read: return the cached verdict if present, else `None`.
/// **Never spawns the sidecar.** A cold probe (290 MB onefile extraction + torch
/// import) measured 37–67 s on the dev machine — too slow and too variable for
/// the launch path, so the badge paints only from a prior verification's cached
/// result. A miss surfaces the "kliknij, aby zweryfikować" prompt; the heavy
/// verify (`whisperx_engine_check`) runs only on explicit user action.
#[tauri::command]
pub async fn whisperx_engine_cached(app: AppHandle) -> Result<Option<EngineStatus>, String> {
    Ok(read_readiness_cache(&app, &readiness_cache_key(&app)))
}

/// On-demand cheap probe: return a cached verdict instantly on a hit, else run
/// the cheap `--capability` probe (device detect + dir check, no model load, no
/// align, no HF network), bounded by a timeout, and cache the result. Cache is
/// best-effort — any error falls through to a live probe. NOTE: the launch badge
/// no longer calls this (it uses `whisperx_engine_cached`, which never spawns) —
/// kept as the cheap on-demand primitive; the spawn here is still too slow/
/// variable (37–67 s cold) to sit on the launch path.
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
    let mut status = parse_engine_status(&out)?;
    // Capability is a device-detect + dir-check; it cannot verify the frozen
    // import chain, so its verdict is non-authoritative (amber "wykryty" tier).
    status.authoritative = false;
    write_readiness_cache(&app, &key, &status);
    Ok(status)
}
