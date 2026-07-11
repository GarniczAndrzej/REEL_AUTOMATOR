use crate::proc::ProcError;
use std::ffi::OsString;
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

/// The bare name a `PATH` lookup finds: `ffmpeg.exe` on Windows (`CreateProcess`
/// appends only `.exe`, never a target triple), `ffmpeg` elsewhere.
fn bare_ffmpeg_name() -> String {
    format!("ffmpeg{}", if cfg!(windows) { ".exe" } else { "" })
}

/// Is the resolved binary ALREADY bare-named, i.e. findable by a child's bare
/// `ffmpeg` lookup without any shim? True only for the macOS/production bundle
/// case, where Tauri's `externalBin` bundler strips the triple. Both other
/// branches of `ffmpeg_bin_path` (staged deps root, repo `binaries/`) are
/// triple-suffixed and need a shim.
fn is_bare_ffmpeg(bin: &Path) -> bool {
    bin.file_name().and_then(|n| n.to_str()) == Some(bare_ffmpeg_name().as_str())
}

/// Does `shim` still resolve to the same file as `target`?
///
/// Identity, not existence — and this distinction is the whole point. FFmpeg is a
/// versioned dep: `deps::download_dependency` re-stages it through `atomic_swap`
/// (`rename(final → .bak); rename(part → final)`), which installs a **new inode**,
/// and a dev checkout re-running `sidecar/fetch-ffmpeg.sh` does the same. A hardlink
/// made before that rename still points at the old inode. An existence-only check
/// would never refresh it, so the engine child would decode with the *old* FFmpeg
/// forever while every Rust-side call used the new one — silently — and the orphaned
/// inode (our link being its last reference) would leak ~143 MB.
///
/// Compared by `(len, modified)`: for a hardlink both paths are the same inode, so
/// the pair is identical by construction; after a re-stage it is not. (The precise
/// Windows `(volume_serial_number, file_index)` pair is still unstable — it sits
/// behind the `windows_by_handle` feature — and this portable compare is also the
/// only option on the copy fallback path.)
fn shim_matches(target: &Path, shim: &Path) -> bool {
    let (t, s) = match (std::fs::metadata(target), std::fs::metadata(shim)) {
        (Ok(t), Ok(s)) => (t, s),
        _ => return false,
    };
    t.len() == s.len() && t.modified().ok() == s.modified().ok()
}

/// Materialize a bare-named `shim` pointing at `target`, refreshing a stale one.
/// Hardlink first — the shim sits next to its target by construction, so the link
/// is always same-volume and always free; a copy is the fallback for a filesystem
/// that refuses links.
fn materialize_shim(target: &Path, shim: &Path) -> Result<(), String> {
    if shim_matches(target, shim) {
        return Ok(());
    }
    let _ = std::fs::remove_file(shim);
    if std::fs::hard_link(target, shim).is_ok() {
        return Ok(());
    }
    std::fs::copy(target, shim)
        .map(|_| ())
        .map_err(|e| format!("Nie udało się przygotować FFmpeg dla silnika: {e}"))
}

/// The pure half of `ffmpeg_shim_dir`, split out so it is testable without an
/// `AppHandle` (mirroring how `engine::pick_variant` injects its `present` closure).
fn shim_dir_for(bin: &Path) -> Result<PathBuf, String> {
    let parent = bin
        .parent()
        .ok_or_else(|| "Nie udało się ustalić katalogu FFmpeg.".to_string())?;
    // Already bare-named (macOS/production bundle): hand back its own directory and
    // write NOTHING — the `.app` is code-signed and must not be mutated.
    if is_bare_ffmpeg(bin) {
        return Ok(parent.to_path_buf());
    }
    let dir = parent.join("bin");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Nie udało się utworzyć katalogu FFmpeg dla silnika: {e}"))?;
    materialize_shim(bin, &dir.join(bare_ffmpeg_name()))?;
    Ok(dir)
}

/// A directory holding a **bare-named** `ffmpeg[.exe]`, suitable for prepending to
/// an engine child's `PATH`. whisperx's `load_audio` shells out to a bare
/// `subprocess.run(["ffmpeg", …])` with no injection point, and neither the staged
/// nor the dev FFmpeg is bare-named — so without this the child's lookup finds
/// nothing and the decode dies with exit 11.
pub fn ffmpeg_shim_dir(app: &AppHandle) -> Result<PathBuf, String> {
    shim_dir_for(&ffmpeg_bin_path(app)?)
}

/// `dir` prepended to `current` as a `PATH` value — prepended, not appended, so our
/// FFmpeg wins over any stray system one. `None` when the join fails (a path holding
/// the platform separator).
pub fn prepend_to_path(dir: &Path, current: Option<OsString>) -> Option<OsString> {
    let mut parts: Vec<PathBuf> = vec![dir.to_path_buf()];
    if let Some(cur) = current.as_ref() {
        parts.extend(std::env::split_paths(cur));
    }
    std::env::join_paths(parts).ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch dir of our own, mirroring `deps.rs`'s `atomic_swap` test (no
    /// `tempfile` dev-dependency in this crate).
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("reel_shim_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bare_named_ffmpeg_needs_no_shim() {
        // The macOS/production-bundle case: Tauri's externalBin strips the triple, so
        // a child's bare lookup already finds it — and the signed .app must not be
        // written to.
        let bare = Path::new("/opt/app.app/Contents/MacOS").join(bare_ffmpeg_name());
        assert!(is_bare_ffmpeg(&bare));
        // Both other precedence branches are triple-suffixed and DO need one.
        assert!(!is_bare_ffmpeg(Path::new(
            "C:/repo/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe"
        )));
        assert!(!is_bare_ffmpeg(Path::new(
            "/deps/ffmpeg/ffmpeg-aarch64-apple-darwin"
        )));
    }

    #[test]
    fn shim_dir_for_a_bare_binary_is_its_parent_and_writes_nothing() {
        let dir = scratch("bare");
        let bin = dir.join(bare_ffmpeg_name());
        std::fs::write(&bin, b"ffmpeg").unwrap();

        assert_eq!(shim_dir_for(&bin).unwrap(), dir);
        assert!(!dir.join("bin").exists(), "no shim dir may be created");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shim_dir_materializes_a_bare_name_beside_a_triple_suffixed_binary() {
        let dir = scratch("triple");
        let bin = dir.join("ffmpeg-x86_64-pc-windows-msvc.exe");
        std::fs::write(&bin, b"v1").unwrap();

        let shim_dir = shim_dir_for(&bin).unwrap();
        assert_eq!(shim_dir, dir.join("bin"));
        let shim = shim_dir.join(bare_ffmpeg_name());
        assert_eq!(std::fs::read(&shim).unwrap(), b"v1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_shim_is_relinked_after_the_target_is_re_staged() {
        // The regression guard for the whole class: `deps::atomic_swap` re-stages
        // FFmpeg by rename, which installs a NEW inode. An existence-only idempotency
        // check would pin the shim to the OLD binary forever — the engine child would
        // decode with it while every Rust-side call used the new one.
        let dir = scratch("stale");
        let bin = dir.join("ffmpeg-x86_64-pc-windows-msvc.exe");
        std::fs::write(&bin, b"v1").unwrap();
        let shim = shim_dir_for(&bin).unwrap().join(bare_ffmpeg_name());
        assert_eq!(std::fs::read(&shim).unwrap(), b"v1");

        // Re-stage exactly as `atomic_swap` does: write a `.part`, then rename over.
        let part = dir.join("ffmpeg.part");
        std::fs::write(&part, b"v2-longer").unwrap();
        std::fs::remove_file(&bin).unwrap();
        std::fs::rename(&part, &bin).unwrap();

        shim_dir_for(&bin).unwrap();
        assert_eq!(
            std::fs::read(&shim).unwrap(),
            b"v2-longer",
            "shim must resolve to the re-staged binary, not the old inode"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_shim_dir_is_prepended_to_path_never_appended() {
        // Prepend, so our FFmpeg wins over any stray system one.
        let shim = Path::new("/deps/ffmpeg/bin");
        let existing = std::env::join_paths([Path::new("/usr/bin"), Path::new("/bin")]).unwrap();
        let joined = prepend_to_path(shim, Some(existing)).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&joined).collect();
        assert_eq!(parts.first().unwrap(), shim);
        assert_eq!(parts.len(), 3);

        // No inherited PATH at all ⇒ just the shim dir.
        let only = prepend_to_path(shim, None).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&only).collect();
        assert_eq!(parts, vec![shim.to_path_buf()]);
    }
}
