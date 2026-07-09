// Thin-installer dependency resolver (Phase 1).
//
// Loads the declarative heavy-dependency spec (remote `deps.json` → embedded
// fallback), detects the host's hardware variant (GPU/CPU, fail-safe to CPU),
// computes the dependency set the host actually needs, and reports each one's
// on-disk status — ALL spawn-free (S-18): it stats files and reads small JSON,
// never launches the multi-GB engine. The download/staging side lands in Phase 2;
// the spawn-path rework in Phase 3.
//
// Source-of-truth boundary (F4): this module covers ONLY the heavy hardware-
// variant deps — `engine`, `ffmpeg`, `align-models`. Transcription MODELS stay in
// `models.rs` + `src/transcription/model-registry.js`. See `src/deps/deps-spec.js`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

/// Tauri bundle identifier (mirrors `tauri.conf.json → identifier`). Used to
/// resolve the per-machine config dir WITHOUT an `AppHandle`, so `detect_variant`
/// can stay argless yet still honor the UI override file — guaranteeing the
/// spawn-side (`engine::engine_sidecar`) and the download-side (`deps_status`)
/// never disagree because both route through the same argless resolver.
pub const APP_IDENTIFIER: &str = "com.reelautomator.app";

/// Placeholder release-host URL for the remote spec. PHASE 0 (stubbed): this host
/// does not exist yet, so `load_deps_spec` always falls back to the embedded copy.
/// Point this at the real versioned `deps.json` once the release host is stood up.
const REMOTE_SPEC_URL: &str = "https://RELEASE_HOST/reel-automator/deps/deps.json";

/// The embedded spec — the offline/host-down fallback AND the checksum trust
/// anchor (ships inside the code-signed installer). `include_str!` is relative to
/// this file: `src-tauri/src/deps.rs` → repo `src/deps/deps-spec.json`.
const EMBEDDED_SPEC: &str = include_str!("../../src/deps/deps-spec.json");

// ── Spec types ───────────────────────────────────────────────────────

/// One file of a multi-file dependency (mirrors the model-registry
/// `{name,sizeBytes,sha256}` shape). `sha256` is lowercase hex.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepFile {
    pub name: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: u64,
}

/// A single heavy dependency entry. See `src/deps/deps-spec.js` for the documented
/// schema. Unknown JSON fields (e.g. the `_note` annotations in the stub) are
/// ignored by serde.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub id: String,
    /// `engine` | `ffmpeg` | `align-models`.
    pub kind: String,
    /// `windows` | `macos`.
    pub platform: String,
    /// `x86_64` | `aarch64`.
    pub arch: String,
    /// `gpu` | `cpu` | `any`.
    pub variant_predicate: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub files: Option<Vec<DepFile>>,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub sha256: Option<String>,
    pub version: String,
    #[serde(default)]
    pub sentinel: String,
    /// `engine-bin` | `ffmpeg-bin` | `align-models`.
    pub stage_to: String,
}

/// The top-level spec document.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepsSpec {
    pub spec_version: u32,
    pub dependencies: Vec<Dependency>,
}

/// Parse the embedded spec. Fails loudly if the bundled JSON is malformed (a build
/// mistake, not a runtime condition) — covered by a unit test.
pub fn embedded_spec() -> Result<DepsSpec, String> {
    serde_json::from_str(EMBEDDED_SPEC)
        .map_err(|e| format!("Wbudowana specyfikacja zależności jest niepoprawna: {e}"))
}

/// Merge a remote spec over the embedded one under the trust-anchor rule:
///   - the embedded copy is authoritative for INTEGRITY: for any `id` present in
///     the embedded spec, its `sha256`/`version`/`files` (and other fields) WIN;
///     the remote spec may only re-point that id's `url`,
///   - a remote-only `id` is a genuinely new dependency, trusted-on-first-use
///     (its hash comes from the host) and appended as-is.
/// This closes the hole where a compromised host serves a malicious binary with a
/// self-consistent malicious hash: a *known* id can never have its hash swapped.
pub fn merge_specs(embedded: &DepsSpec, remote: &DepsSpec) -> DepsSpec {
    let mut deps: Vec<Dependency> = Vec::new();
    for e in &embedded.dependencies {
        let mut merged = e.clone();
        // Allow the remote to re-point ONLY the URL of a known id.
        if let Some(r) = remote.dependencies.iter().find(|r| r.id == e.id) {
            if let Some(url) = &r.url {
                merged.url = Some(url.clone());
            }
        }
        deps.push(merged);
    }
    // Append remote-only ids (new deps) verbatim — trusted-on-first-use.
    for r in &remote.dependencies {
        if !embedded.dependencies.iter().any(|e| e.id == r.id) {
            deps.push(r.clone());
        }
    }
    DepsSpec {
        spec_version: remote.spec_version.max(embedded.spec_version),
        dependencies: deps,
    }
}

/// Resolve the active spec: fetch the remote `deps.json`, merge it over the
/// embedded copy under the trust-anchor rule, and fall back to the embedded copy
/// on ANY network/parse error so first run resolves even offline. Short timeout so
/// launch never stalls on the host.
pub async fn resolve_spec() -> DepsSpec {
    let embedded = match embedded_spec() {
        Ok(s) => s,
        // A malformed embedded spec is a build error; there is nothing to fall back
        // to, so surface an empty spec rather than panicking on the launch path.
        Err(_) => {
            return DepsSpec {
                spec_version: 0,
                dependencies: Vec::new(),
            }
        }
    };
    let fetched = async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .ok()?;
        let text = client
            .get(REMOTE_SPEC_URL)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .text()
            .await
            .ok()?;
        serde_json::from_str::<DepsSpec>(&text).ok()
    }
    .await;
    match fetched {
        Some(remote) => merge_specs(&embedded, &remote),
        None => embedded,
    }
}

/// Command wrapper around `resolve_spec`.
#[tauri::command]
pub async fn load_deps_spec() -> Result<DepsSpec, String> {
    Ok(resolve_spec().await)
}

// ── Hardware detection ───────────────────────────────────────────────

/// Host target triple, matching `sidecar/build.sh`'s naming (lifted from
/// `engine.rs` so the spawn-side and download-side agree on one definition).
pub fn host_triple() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        ""
    }
}

/// `(platform, arch)` for the host, matching the spec's `platform`/`arch` values.
pub fn host_platform_arch() -> (&'static str, &'static str) {
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "unknown"
    };
    (platform, arch)
}

/// True if a usable NVIDIA GPU + driver is present (cheap, ~instant): `nvidia-smi`
/// runs and lists ≥1 GPU. Shells out only to the always-installed driver tool — it
/// does NOT spawn the multi-GB engine. Any error/absence ⇒ false. Memoized: host
/// hardware does not change within a run, so the probe runs at most once.
pub fn nvidia_gpu_present() -> bool {
    static PRESENT: OnceLock<bool> = OnceLock::new();
    *PRESENT.get_or_init(|| {
        std::process::Command::new("nvidia-smi")
            .arg("-L")
            .output()
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false)
    })
}

/// Per-machine settings path (`deps-settings.json`) resolved WITHOUT an
/// `AppHandle` so argless resolvers can read it. Mirrors Tauri's
/// `app_config_dir()` layout: `<config>/<identifier>/deps-settings.json`. Phase 2
/// (`set_deps_root`) and Phase 4 (variant override) write to this SAME path via
/// this helper, so reads and writes never diverge.
pub fn deps_settings_path() -> Option<PathBuf> {
    let base: PathBuf = if cfg!(target_os = "windows") {
        PathBuf::from(std::env::var("APPDATA").ok()?)
    } else if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var("HOME").ok()?)
            .join("Library")
            .join("Application Support")
    } else {
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .ok()
            .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config"))
    };
    Some(base.join(APP_IDENTIFIER).join("deps-settings.json"))
}

/// Read a string field from `deps-settings.json`. Tolerant of a missing/corrupt
/// file (returns `None`).
fn read_settings_field(field: &str) -> Option<String> {
    let path = deps_settings_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get(field)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// Resolve the persisted UI variant override (`gpu`|`cpu`) if present. Written by
/// Phase 4; absent in Phase 1 (tolerated).
fn variant_override() -> Option<String> {
    read_settings_field("variantOverride")
}

/// Pure variant precedence, factored out for unit testing without touching the
/// environment or the filesystem: env override → UI override → NVIDIA present ⇒
/// gpu → cpu. `gpu_present` is injected so the test doesn't shell out.
fn resolve_variant(env_override: Option<&str>, ui_override: Option<&str>, gpu_present: bool) -> &'static str {
    match env_override {
        Some("gpu") => "gpu",
        Some("cpu") => "cpu",
        _ => match ui_override {
            Some("gpu") => "gpu",
            Some("cpu") => "cpu",
            _ if gpu_present => "gpu",
            _ => "cpu",
        },
    }
}

/// Resolve the host's engine variant, fail-safe to CPU. Precedence:
///   1. `REEL_ENGINE_VARIANT=gpu|cpu` env override (power-user/debug),
///   2. persisted UI override (`deps-settings.json → variantOverride`, Phase 4),
///   3. `nvidia-smi` finds a GPU ⇒ gpu,
///   4. else cpu.
/// Spawn-free apart from the memoized `nvidia-smi -L` probe. NOT memoized itself,
/// so a mid-session UI-override change is reflected on the next `deps_status`.
pub fn detect_variant() -> &'static str {
    let env = std::env::var("REEL_ENGINE_VARIANT").ok();
    let ui = variant_override();
    resolve_variant(env.as_deref(), ui.as_deref(), nvidia_gpu_present())
}

// ── Staging paths + required-set/status ──────────────────────────────

/// Read the persisted deps-root override (`deps-settings.json → depsRoot`).
/// Written by Phase 2's `set_deps_root`; absent ⇒ default.
fn deps_root_override() -> Option<String> {
    read_settings_field("depsRoot")
}

/// Staging root for downloaded heavy deps: the persisted override if set, else the
/// writable `app_data_dir()/deps`. Phase 2 adds the `get/set_deps_root` +
/// writability/space commands on top of this reader.
pub fn deps_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = deps_root_override() {
        let t = root.trim();
        if !t.is_empty() {
            return Ok(PathBuf::from(t));
        }
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("deps"))
}

/// Map a `stageTo` slot to a concrete path under `root`, preserving the
/// `align_models/`-beside-the-engine contract. For single-file kinds the returned
/// path IS the staged file; for `align-models` it is the staged directory. Both
/// the downloader (write, Phase 2) and the spawn resolver (read, Phase 3) agree on
/// this mapping.
pub fn staged_path(root: &Path, slot: &str, variant: &str, triple: &str) -> PathBuf {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    match slot {
        "engine-bin" => {
            let base = if variant == "gpu" {
                "whisperx-engine-gpu"
            } else {
                "whisperx-engine"
            };
            root.join("engine")
                .join(variant)
                .join(format!("{base}-{triple}{ext}"))
        }
        "ffmpeg-bin" => root.join("ffmpeg").join(format!("ffmpeg-{triple}{ext}")),
        "align-models" => root.join("engine").join(variant).join("align_models"),
        // Unknown slot: keep it under the root by name rather than panicking.
        other => root.join(other),
    }
}

/// Is a dependency present at its staged location? For single-file kinds the
/// staged path itself must be a file; for `align-models` the `sentinel` file (or,
/// when the sentinel is empty, the staged dir) must exist. Pure filesystem read.
fn dep_present(staged: &Path, kind: &str, sentinel: &str) -> bool {
    match kind {
        "align-models" => {
            if sentinel.trim().is_empty() {
                staged.is_dir()
            } else {
                staged.join(sentinel).is_file()
            }
        }
        _ => staged.is_file(),
    }
}

/// Does this dependency apply to the given host + variant? (`any` matches either
/// variant.)
fn dep_required(dep: &Dependency, platform: &str, arch: &str, variant: &str) -> bool {
    dep.platform == platform
        && dep.arch == arch
        && (dep.variant_predicate == "any" || dep.variant_predicate == variant)
}

/// The subset of the spec the host actually needs. (Consumed by the Phase 2
/// downloader + Phase 4 UI; currently exercised by the unit tests.)
#[allow(dead_code)]
pub fn required_deps<'a>(
    spec: &'a DepsSpec,
    platform: &str,
    arch: &str,
    variant: &str,
) -> Vec<&'a Dependency> {
    spec.dependencies
        .iter()
        .filter(|d| dep_required(d, platform, arch, variant))
        .collect()
}

/// Read the per-machine installed manifest (`deps_root/deps-installed.json`,
/// `{ <id>: { version, sha256 } }`) into an `id → version` map. Written by Phase 2
/// on a successful stage; a missing/corrupt manifest reads as empty (⇒ any present
/// artifact is treated as version-unknown). Never re-hashes the staged artifact —
/// the recorded `version` is the cheap staleness gate.
fn installed_versions(root: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let text = match std::fs::read_to_string(root.join("deps-installed.json")) {
        Ok(t) => t,
        Err(_) => return map,
    };
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(obj) = v.as_object() {
            for (id, entry) in obj {
                if let Some(ver) = entry.get("version").and_then(|x| x.as_str()) {
                    map.insert(id.clone(), ver.to_string());
                }
            }
        }
    }
    map
}

/// Per-dependency status reported to the first-run UI + the transcription gate.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepStatus {
    pub id: String,
    pub kind: String,
    pub required: bool,
    pub present: bool,
    pub stale: bool,
    pub size_bytes: u64,
    pub staged_path: Option<String>,
}

/// Report each dependency's on-disk status for the host — spawn-free (S-18):
/// `present` stats the staged sentinel, `stale` compares the recorded installed
/// `version` against the spec `version` via a cheap manifest read (never re-hashes
/// the multi-GB artifact). Unit-tested via the pure helpers above.
#[tauri::command]
pub async fn deps_status(app: AppHandle) -> Result<Vec<DepStatus>, String> {
    let spec = resolve_spec().await;
    let (platform, arch) = host_platform_arch();
    let variant = detect_variant();
    let triple = host_triple();
    let root = deps_root(&app)?;
    let installed = installed_versions(&root);

    let mut out = Vec::new();
    for dep in &spec.dependencies {
        let required = dep_required(dep, platform, arch, variant);
        let staged = staged_path(&root, &dep.stage_to, variant, triple);
        let present = dep_present(&staged, &dep.kind, &dep.sentinel);
        // stale = present on disk but the recorded installed version doesn't match
        // the (embedded-authoritative) spec version — including "no record".
        let stale = present && installed.get(&dep.id).map(|v| v != &dep.version).unwrap_or(true);
        out.push(DepStatus {
            id: dep.id.clone(),
            kind: dep.kind.clone(),
            required,
            present,
            stale,
            size_bytes: dep.size_bytes,
            staged_path: if present {
                Some(staged.to_string_lossy().into_owned())
            } else {
                None
            },
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dep(id: &str, kind: &str, platform: &str, arch: &str, variant: &str, stage_to: &str) -> Dependency {
        Dependency {
            id: id.into(),
            kind: kind.into(),
            platform: platform.into(),
            arch: arch.into(),
            variant_predicate: variant.into(),
            url: Some("https://example/x".into()),
            repo: None,
            files: None,
            size_bytes: 100,
            sha256: Some("abc".into()),
            version: "1.0.0".into(),
            sentinel: "x.exe".into(),
            stage_to: stage_to.into(),
        }
    }

    fn sample_spec() -> DepsSpec {
        DepsSpec {
            spec_version: 1,
            dependencies: vec![
                dep("engine-gpu", "engine", "windows", "x86_64", "gpu", "engine-bin"),
                dep("engine-cpu", "engine", "windows", "x86_64", "cpu", "engine-bin"),
                dep("ffmpeg", "ffmpeg", "windows", "x86_64", "any", "ffmpeg-bin"),
                dep("align", "align-models", "windows", "x86_64", "any", "align-models"),
                dep("mac-engine", "engine", "macos", "aarch64", "cpu", "engine-bin"),
            ],
        }
    }

    #[test]
    fn gpu_host_requires_gpu_engine_not_cpu() {
        let spec = sample_spec();
        let ids: Vec<&str> = required_deps(&spec, "windows", "x86_64", "gpu")
            .iter()
            .map(|d| d.id.as_str())
            .collect();
        assert!(ids.contains(&"engine-gpu"), "gpu host needs gpu engine");
        assert!(!ids.contains(&"engine-cpu"), "gpu host must NOT need cpu engine");
        assert!(ids.contains(&"ffmpeg"), "'any' deps always required");
        assert!(ids.contains(&"align"), "'any' align always required");
        assert!(!ids.contains(&"mac-engine"), "macOS entry excluded on windows host");
    }

    #[test]
    fn cpu_host_requires_cpu_engine_not_gpu() {
        let spec = sample_spec();
        let ids: Vec<&str> = required_deps(&spec, "windows", "x86_64", "cpu")
            .iter()
            .map(|d| d.id.as_str())
            .collect();
        assert!(ids.contains(&"engine-cpu"));
        assert!(!ids.contains(&"engine-gpu"));
        assert!(ids.contains(&"ffmpeg"));
    }

    #[test]
    fn host_arch_mismatch_excludes_dep() {
        let spec = sample_spec();
        // aarch64 windows host: no entry matches (all are x86_64 windows).
        let req = required_deps(&spec, "windows", "aarch64", "gpu");
        assert!(req.is_empty(), "no windows/aarch64 entries in the sample");
    }

    #[test]
    fn variant_precedence_env_wins() {
        // env override beats everything, even a present GPU.
        assert_eq!(resolve_variant(Some("cpu"), Some("gpu"), true), "cpu");
        assert_eq!(resolve_variant(Some("gpu"), None, false), "gpu");
    }

    #[test]
    fn variant_precedence_ui_over_hardware() {
        // no env; UI override beats hardware detection.
        assert_eq!(resolve_variant(None, Some("cpu"), true), "cpu");
        assert_eq!(resolve_variant(None, Some("gpu"), false), "gpu");
    }

    #[test]
    fn variant_fail_safe_to_cpu() {
        // no override, no GPU ⇒ cpu; GPU present ⇒ gpu.
        assert_eq!(resolve_variant(None, None, false), "cpu");
        assert_eq!(resolve_variant(None, None, true), "gpu");
        // a bogus override value is ignored ⇒ falls through to hardware.
        assert_eq!(resolve_variant(Some("garbage"), None, false), "cpu");
    }

    #[test]
    fn staged_paths_match_contract() {
        let root = Path::new("/deps");
        let triple = "x86_64-pc-windows-msvc";
        let gpu = staged_path(root, "engine-bin", "gpu", triple);
        assert!(gpu.ends_with(format!("engine/gpu/whisperx-engine-gpu-{triple}.exe")) || gpu.to_string_lossy().contains("whisperx-engine-gpu"));
        let cpu = staged_path(root, "engine-bin", "cpu", triple);
        assert!(cpu.to_string_lossy().contains("whisperx-engine-"));
        assert!(!cpu.to_string_lossy().contains("engine-gpu"));
        let ff = staged_path(root, "ffmpeg-bin", "cpu", triple);
        assert!(ff.to_string_lossy().contains("ffmpeg-"));
        let al = staged_path(root, "align-models", "cpu", triple);
        assert!(al.ends_with("align_models"));
    }

    #[test]
    fn merge_keeps_embedded_hash_repoints_url() {
        let mut embedded = sample_spec();
        embedded.dependencies[0].sha256 = Some("EMBEDDED_HASH".into());
        embedded.dependencies[0].url = Some("https://old/e.exe".into());

        let mut remote = sample_spec();
        remote.dependencies[0].sha256 = Some("MALICIOUS_HASH".into());
        remote.dependencies[0].url = Some("https://new/e.exe".into());
        // add a remote-only new dep
        remote.dependencies.push(dep("new-dep", "ffmpeg", "windows", "x86_64", "any", "ffmpeg-bin"));

        let merged = merge_specs(&embedded, &remote);
        let e0 = merged.dependencies.iter().find(|d| d.id == "engine-gpu").unwrap();
        assert_eq!(e0.sha256.as_deref(), Some("EMBEDDED_HASH"), "embedded hash must win");
        assert_eq!(e0.url.as_deref(), Some("https://new/e.exe"), "remote may re-point url");
        assert!(merged.dependencies.iter().any(|d| d.id == "new-dep"), "remote-only dep appended");
    }

    #[test]
    fn embedded_spec_deserializes() {
        let spec = embedded_spec().expect("bundled deps-spec.json must parse");
        assert!(spec.spec_version >= 1);
        assert!(
            spec.dependencies.iter().any(|d| d.kind == "engine"),
            "spec should list at least one engine dependency"
        );
    }

    #[test]
    fn present_check_single_file_vs_dir() {
        let tmp = std::env::temp_dir().join(format!("reel_deps_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // single-file kind: absent then present
        let exe = tmp.join("whisperx-engine.exe");
        assert!(!dep_present(&exe, "engine", "whisperx-engine.exe"));
        std::fs::write(&exe, b"x").unwrap();
        assert!(dep_present(&exe, "engine", "whisperx-engine.exe"));

        // align-models with empty sentinel: dir presence
        let align = tmp.join("align_models");
        assert!(!dep_present(&align, "align-models", ""));
        std::fs::create_dir_all(&align).unwrap();
        assert!(dep_present(&align, "align-models", ""));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
