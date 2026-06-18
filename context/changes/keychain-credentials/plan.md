# Keychain Credentials (S-11) Implementation Plan

## Overview

Migrate the app's two live API keys — OpenRouter (`openrouter`) and the HuggingFace diarization token (`huggingface`) — out of plaintext `localStorage` and into the **macOS Keychain** (the OS secure credential store) via the Rust `keyring` crate, satisfying **FR-035** ("API keys are stored in the OS secure credential store, never plaintext").

The migration happens entirely behind the existing single chokepoint `src/ai/api-key.js` (`getApiKey()` / `setApiKey()`), so the five call sites that read/write keys do not change. `getApiKey()` stays **synchronous** by reading an in-memory cache that is hydrated from the keychain once at app startup; `setApiKey()` becomes an async write-through to the keychain.

## Current State Analysis

- **R2 accessor refactor is already complete in code** (roadmap marks it "proposed", but reality is done). Every key read/write routes through `src/ai/api-key.js`:
  - `getApiKey(provider)` → `localStorage.getItem('edl_apikey_' + provider)`
  - `setApiKey(provider, key)` → `localStorage.setItem('edl_apikey_' + provider, key)`
- **Five call sites**, two providers in use:
  - `src/ui/settings-modal.js:172,178,181` — `saveApiKey()` / `loadApiKey()` for `openrouter` (**synchronous** functions called when the settings modal opens).
  - `src/ai/openrouter-picker.js:43` — inside `async loadOrModels()`.
  - `src/ui/step2-prompt-panel.js:42` — inside `async runAIAnalysis()`.
  - `src/ui/import/transcribe.js:53` (setup, **sync**), `:65` (input handler, sync), `:630` (inside async run) — for `huggingface`.
- `getApiKey()` is consumed from both **synchronous** (`settings-modal` load/save, `transcribe.js` setup) and **async** contexts. This is why the in-memory-cache + sync-getter shape was chosen over a fully-async accessor.
- **Backend**: Tauri 2; custom commands are registered in `src-tauri/src/lib.rs` via `invoke_handler!`. Custom `#[tauri::command]`s are callable from the frontend **without** a capability/permission entry — `src-tauri/capabilities/default.json` only lists plugin permissions. So a custom command module needs **no** capability change.
- **Non-Tauri fallback pattern** already exists: `src/ai/cache.js` does `try { ({invoke} = await import('@tauri-apps/api/core')); } catch { /* fall through */ }`. The accessor will mirror this.
- `keyring` crate dependency is **not** present in `src-tauri/Cargo.toml` today.
- Orphaned `edl_apikey_gemini` / `edl_apikey_claude` localStorage entries exist but are never read (S-17) — left untouched (out of scope per user decision).

## Desired End State

- Entering an OpenRouter key in Settings (or the HF token in the diarization row) writes the key to the macOS Keychain and **not** to `localStorage`.
- On the next app launch, the key is read back from the Keychain and the app behaves identically to today (AI analysis, model loading, diarization all see the key).
- Any pre-existing plaintext key in `localStorage` is moved to the Keychain on first launch and the plaintext entry is **deleted**.
- Verifiable: after setting a key and relaunching, `Keychain Access.app` shows an entry under the app's service for `openrouter`; `localStorage` no longer contains `edl_apikey_openrouter`; AI analysis still works.

### Key Discoveries:

- Single chokepoint already in place: `src/ai/api-key.js:14,24`.
- Sync callers that block a fully-async accessor: `settings-modal.js:166-188`, `transcribe.js:53`.
- Custom commands need no capability entry (`capabilities/default.json` only has plugin perms).
- Established Tauri-or-fallback import pattern: `src/ai/cache.js:17-23`.
- App startup entry point and where to call hydration: `src/main.js` (boot sequence) — hydration must complete (or be awaited) before the settings modal first reads a key.

## What We're NOT Doing

- **Not** implementing the PIN / password app-lock (explicitly DEFERRED in PRD §Access Control).
- **Not** purging the dead `edl_apikey_gemini` / `edl_apikey_claude` localStorage entries (out of scope; harmless, nothing reads them).
- **Not** changing the five call sites' logic or the function signatures of `getApiKey()`/`setApiKey()` (getter stays sync; setter gains async write-through but callers that ignore the returned promise keep working).
- **Not** adding Windows-specific handling/testing now (the `keyring` crate covers Windows transparently when that platform is added; this slice ships macOS-only behavior).
- **Not** wiring a new Tauri capability/permission (custom commands don't need one).

## Implementation Approach

Three phases, bottom-up:

1. A tiny Rust command module wraps the `keyring` crate with get/set/delete-credential commands.
2. `api-key.js` becomes a hydrated in-memory cache: read-through-cache on the frontend, write-through to the keychain. A one-time localStorage→keychain migration runs inside hydration. `main.js` awaits hydration at boot.
3. Docs + roadmap status + verification.

## Critical Implementation Details

- **Hydration must run before the first synchronous `getApiKey()`**: the settings modal's `loadApiKey()` and `transcribe.js` setup read synchronously from the cache. `hydrateKeys()` must be `await`ed during app boot (`main.js`) before those surfaces can be opened, otherwise the first open shows an empty field until refresh. If boot can't cleanly await before those surfaces render, the modal-open/setup path must call `emit()` (or re-read) after hydration resolves so the field repopulates.
- **Migration idempotency**: on hydrate, for each provider, if the keychain has no entry but `localStorage` does, write localStorage→keychain, then `localStorage.removeItem(...)`. After the first successful run there is nothing left in localStorage, so subsequent launches are no-ops. The migration must tolerate a keychain write failure (keep the plaintext, surface the toast, retry next launch) — never delete plaintext before a confirmed successful keychain write.
- **`keyring` "no entry" is not an error**: the crate returns a distinct `Error::NoEntry` for a missing key — map it to `Ok(None)` / empty string, not a thrown command error, so a first-run empty keychain doesn't spam failure toasts.

## Phase 1: Backend keychain command module

### Overview

Add the `keyring` crate and a small Rust module exposing three Tauri commands that the frontend can `invoke`. No capability changes.

### Changes Required:

#### 1. Add the `keyring` dependency

**File**: `src-tauri/Cargo.toml`

**Intent**: Pull in the cross-platform OS-keychain crate so the backend can read/write the macOS Keychain (and Windows Credential Manager later).

**Contract**: Add `keyring = "<latest 3.x>"` (resolve the actual latest stable at implement time via `cargo add keyring`) to `[dependencies]`. Use the crate's default platform features (macOS Security framework on darwin). No change to `[profile.*]`.

#### 2. New keychain command module

**File**: `src-tauri/src/keychain.rs` (new)

**Intent**: Wrap `keyring::Entry` with three commands — read, write, delete — keyed by `(service, account)` where service is a fixed app id and account is the provider id. Map "no entry" to an empty/`None` result rather than an error.

**Contract**: Three `#[tauri::command]` functions:
- `get_credential(provider: String) -> Result<Option<String>, String>` — returns `Ok(None)` on `keyring::Error::NoEntry`, `Ok(Some(secret))` on hit, `Err(msg)` on real failure.
- `set_credential(provider: String, secret: String) -> Result<(), String>`
- `delete_credential(provider: String) -> Result<(), String>` — `NoEntry` is treated as success (idempotent delete).

The service string is a single module constant (e.g. `const SERVICE: &str = "reel-automator";`); account = `provider`. `Entry::new(SERVICE, &provider)` then `get_password()` / `set_password()` / `delete_credential()`. Errors are stringified for the frontend.

#### 3. Register the module + commands

**File**: `src-tauri/src/lib.rs`

**Intent**: Declare the module and add the three commands to the existing `invoke_handler!` list.

**Contract**: Add `mod keychain;` alongside the other `mod` declarations, and append `keychain::get_credential, keychain::set_credential, keychain::delete_credential,` to `tauri::generate_handler![...]`. No plugin/capability change.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rust build passes: `~/.cargo/bin/cargo build --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- N/A this phase (no UI yet); covered end-to-end in Phase 2.

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Frontend accessor + startup hydration + migration

### Overview

Rework `src/ai/api-key.js` from a thin localStorage wrapper into a hydrated in-memory cache that talks to the keychain commands, runs the one-time plaintext migration, and degrades gracefully outside Tauri / on keychain failure. Wire `hydrateKeys()` into app boot.

### Changes Required:

#### 1. Rewrite the accessor

**File**: `src/ai/api-key.js`

**Intent**: Keep `getApiKey(provider)` synchronous by serving from a module-level in-memory cache; make `setApiKey(provider, key)` an async write-through that updates the cache immediately (so sync reads see it at once) and persists to the keychain in the background. Add `hydrateKeys()` to populate the cache from the keychain at boot and run migration. Mirror `cache.js`'s Tauri-or-fallback import: outside Tauri, the cache is the only store (session-only, no plaintext written).

**Contract**:
- Module state: `const cache = new Map()` (provider → key string) plus a lazy `invoke` accessor (`async function tauriInvoke()` returning the imported `invoke` or `null` when not in Tauri).
- `getApiKey(provider): string` — returns `cache.get(provider) ?? ''`. Stays synchronous; **no signature change**.
- `setApiKey(provider, key): Promise<void>` — sets `cache.set(provider, key)` synchronously, then `await invoke('set_credential', { provider, secret: key })`; on failure show a Polish error `toast()` and keep the cache value (the chosen "toast + keep in memory" behavior). When not in Tauri, just update the cache.
- `hydrateKeys(): Promise<void>` — for each known provider (`'openrouter'`, `'huggingface'`): read `invoke('get_credential', { provider })`; if present, `cache.set`; if absent **and** `localStorage` has `edl_apikey_<provider>`, run migration (see below) and cache the migrated value. Outside Tauri, fall back to reading `localStorage` into the cache (dev convenience) without deleting it.
- Migration (inside `hydrateKeys`, per provider): read plaintext from `localStorage`; `await invoke('set_credential', ...)`; **only on success** `localStorage.removeItem('edl_apikey_<provider>')` and `cache.set`. On keychain failure, leave plaintext in place, `cache.set` from plaintext so the session works, and surface a toast.
- Known-providers list is a small module constant so adding a provider later is one line.

#### 2. Hydrate at app boot

**File**: `src/main.js`

**Intent**: Call `hydrateKeys()` during startup so the in-memory cache is populated (and migration has run) before any surface reads a key synchronously.

**Contract**: Import `hydrateKeys` from `../ai/api-key.js` and `await` it early in the boot sequence (before the settings modal / step-1 transcribe setup can be reached). If the boot sequence is not already async at that point, after hydration resolves call `emit()` so any already-rendered key fields repopulate from the now-filled cache.

#### 3. Settings modal / transcribe setup repopulation (only if needed)

**File**: `src/ui/settings-modal.js`, `src/ui/import/transcribe.js`

**Intent**: Guarantee the API-key / HF-token input fields reflect the hydrated cache. If Phase 2.2's `await` + `emit()` already covers this, no change is needed here.

**Contract**: No logic change to `saveApiKey`/`loadApiKey` or transcribe setup beyond ensuring they run (or re-run) after hydration. `setApiKey` calls become "fire-and-forget" awaited promises — these functions may stay non-`async` since the cache is updated synchronously and the UI status (`'Zapisano ✓'`) reflects the in-memory write. (Verify the input value is correct on first modal open during manual testing.)

### Success Criteria:

#### Automated Verification:

- Regression suite passes (no parser/exporter impact expected): `node --experimental-vm-modules test/regression.js`
- App boots in dev without console errors: `npm run tauri dev` (smoke).

#### Manual Verification:

- Enter an OpenRouter key in Settings → relaunch app → key is still present and AI analysis works.
- `Keychain Access.app` shows an entry for service `reel-automator`, account `openrouter`.
- A key pre-seeded into `localStorage` (`edl_apikey_openrouter`) is moved to the keychain on first launch and **removed** from `localStorage` (verify in devtools Application tab).
- HF diarization token round-trips the same way (`huggingface`).
- Running the plain Vite browser (`npm run dev`, no Tauri) does not throw; key entry works for the session.
- Simulated keychain failure surfaces a Polish toast and the app remains usable for the session.

**Implementation Note**: After automated verification passes, pause for manual confirmation (the Keychain round-trip + migration checks above are the core of this slice) before Phase 3.

---

## Phase 3: Cleanup, docs & verification

### Overview

Update the credential documentation, flip roadmap statuses, and confirm the regression fence is green.

### Changes Required:

#### 1. Update the credential note in agent docs

**File**: `CLAUDE.md`, `AGENTS.md`

**Intent**: Replace the "API key is stored in `localStorage` as `edl_apikey_openrouter`" line with the new reality: keys live in the macOS Keychain (service `reel-automator`, account = provider) behind `src/ai/api-key.js`; the in-memory cache is hydrated at boot; OpenRouter model list cache (`edl_or_models_cache`) and other non-secret settings stay in `localStorage`.

**Contract**: Edit the relevant bullet (CLAUDE.md:98 / AGENTS.md:98) in both files. Keep the note about orphaned gemini/claude entries (now also no longer migrated). Mention the `keyring`-crate `keychain.rs` module in the backend command table.

#### 2. Update roadmap statuses

**File**: `context/foundation/roadmap.md`, `context/foundation/roadmap.pl.md`

**Intent**: Reflect that R2 (accessor) is done and S-11 is delivered. Update the Baseline "Credentials" line.

**Contract**: Flip R2 `api-key-accessor` status proposed→done (note: shipped behind `src/ai/api-key.js`); flip S-11 `keychain-credentials` ready→done; update the Baseline "Credentials" bullet to "keychain (macOS), migrated from localStorage". Mirror in `roadmap.pl.md`. (Archiving itself is handled later by `/10x-archive`, not this plan.)

### Success Criteria:

#### Automated Verification:

- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- Rust check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- Docs read correctly and match the shipped behavior.
- Full end-to-end smoke: fresh launch → set key → analyze → export still works.

**Implementation Note**: After automated verification passes, pause for final manual confirmation.

---

## Testing Strategy

### Unit Tests:

- No new automated unit tests — the existing bespoke regression runner (`test/regression.js`) covers only parser/exporter correctness, which this change does not touch. The accessor swap is verified manually (keychain round-trip + migration).

### Integration Tests:

- Manual end-to-end: set key → relaunch → key persists from Keychain → AI analysis runs.

### Manual Testing Steps:

1. Pre-seed `localStorage.edl_apikey_openrouter` with a dummy value, launch, confirm it migrates to Keychain and the plaintext entry is deleted.
2. Set a fresh OpenRouter key via Settings, relaunch, confirm it loads from Keychain and AI analysis works.
3. Enable diarization, enter an HF token, relaunch, confirm round-trip.
4. Run `npm run dev` (no Tauri) and confirm no crash + session-only key entry works.
5. (Optional) Deny the macOS Keychain access prompt and confirm a Polish error toast appears and the app stays usable.

## Performance Considerations

- One extra async keychain read per provider at boot (2 reads). Negligible; runs once, off the render-critical path. The sync `getApiKey()` stays O(1) cache lookup.

## Migration Notes

- One-time, idempotent localStorage→keychain migration runs inside `hydrateKeys()` for `openrouter` and `huggingface`. Plaintext is deleted only after a confirmed keychain write. Orphaned `gemini`/`claude` entries are intentionally left.

## References

- Change identity: `context/changes/keychain-credentials/change.md`
- Roadmap slice: `context/foundation/roadmap.md` (S-11, R2)
- PRD: `context/foundation/prd.md` (FR-035, §Access Control Changes)
- Accessor chokepoint: `src/ai/api-key.js`
- Tauri-or-fallback pattern: `src/ai/cache.js:17-23`
- Command registration: `src-tauri/src/lib.rs:15-34`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Backend keychain command module

#### Automated

- [x] 1.1 Rust type-check passes (`cargo check`) — 9853f18
- [x] 1.2 Rust build passes (`cargo build`) — 9853f18

### Phase 2: Frontend accessor + startup hydration + migration

#### Automated

- [x] 2.1 Regression suite passes (`node --experimental-vm-modules test/regression.js`) — b263b44
- [x] 2.2 App boots in dev without console errors (`npm run tauri dev` smoke) — b263b44

#### Manual

- [x] 2.3 OpenRouter key persists across relaunch from Keychain; AI analysis works
- [x] 2.4 Keychain Access shows entry (service `reel-automator`, account `openrouter`)
- [x] 2.5 Pre-seeded localStorage key migrates to keychain and is removed from localStorage
- [x] 2.6 HF diarization token round-trips (`huggingface`)
- [x] 2.7 Plain Vite browser (no Tauri) does not throw; session key entry works
- [x] 2.8 Simulated keychain failure surfaces Polish toast; app remains usable

### Phase 3: Cleanup, docs & verification

#### Automated

- [x] 3.1 Regression suite passes — 7020c04
- [x] 3.2 Rust check passes — 7020c04

#### Manual

- [x] 3.3 Docs match shipped behavior
- [x] 3.4 Full end-to-end smoke (set key → analyze → export) works
