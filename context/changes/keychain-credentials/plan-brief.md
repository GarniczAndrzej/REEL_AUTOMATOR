# Keychain Credentials (S-11) — Plan Brief

> Full plan: `context/changes/keychain-credentials/plan.md`

## What & Why

Move the app's two live API keys — OpenRouter and the HuggingFace diarization token — out of plaintext `localStorage` and into the **macOS Keychain**, satisfying **FR-035** ("API keys are stored in the OS secure credential store, never plaintext"). This is a standalone security-hardening slice with no feature prerequisites.

## Starting Point

Both keys are stored in `localStorage` (`edl_apikey_openrouter`, `edl_apikey_huggingface`) behind a single chokepoint, `src/ai/api-key.js` (`getApiKey()`/`setApiKey()`). The R2 accessor refactor that created this chokepoint is **already done in code** (all 5 call sites route through it), even though the roadmap still marks R2 "proposed". `getApiKey()` is currently synchronous and is read from both sync and async call sites.

## Desired End State

Keys are written to and read from the macOS Keychain. On first launch any existing plaintext key is moved to the Keychain and the plaintext entry deleted. The app behaves identically to today — AI analysis, model loading, and diarization all still see the key — verifiable via `Keychain Access.app` and an empty `localStorage` key slot.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Keychain backend | `keyring` Rust crate + small custom command module | Native OS keychain, no capability changes, matches existing custom-command pattern | Plan |
| Accessor API shape | Sync `getApiKey()` over a startup-hydrated in-memory cache; async write-through `setApiKey()` | Near-zero call-site churn; keeps the sync settings/transcribe readers working | Plan |
| Plaintext migration | Migrate on first launch, then delete the plaintext entry | Satisfies FR-035 "never plaintext" — no lingering secret on disk | Plan |
| Non-Tauri fallback | In-memory, session-only store | App still works in browser dev without writing plaintext | Plan |
| Keychain failure UX | Polish error toast + keep key in memory for the session | Graceful, non-blocking, matches the app's toast convention | Plan |
| Keychain identity | service = `reel-automator`, account = provider id | Clean per-provider entries; future-proof for more providers | Plan |
| Scope | Only the 2 live keys; dead gemini/claude entries left untouched | Tight hardening slice; dead keys are harmless and unread | Plan |

## Scope

**In scope:** `keyring`-crate backend command module; rewrite `api-key.js` to a hydrated in-memory cache + async write-through; one-time localStorage→keychain migration; non-Tauri + failure fallbacks; docs/roadmap updates.

**Out of scope:** PIN/app-lock (PRD-deferred); purging orphaned gemini/claude localStorage keys; Windows-specific testing; changing the 5 call sites' logic.

## Architecture / Approach

Bottom-up: (1) a ~30-line Rust module (`keychain.rs`) wraps `keyring::Entry` with `get/set/delete_credential` commands registered in `lib.rs` — no Tauri capability change needed. (2) `api-key.js` becomes a module-level `Map` cache: `getApiKey()` reads it synchronously; `setApiKey()` updates the cache then writes through to the keychain; `hydrateKeys()` (awaited at boot in `main.js`) fills the cache from the keychain and runs migration. (3) Docs + roadmap status.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Backend keychain module | `keyring` dep + `keychain.rs` get/set/delete commands | Mapping `NoEntry` to a non-error result |
| 2. Frontend accessor + hydration + migration | Hydrated sync cache, async write-through, migration, fallbacks | Hydration must finish before first sync `getApiKey()`; never delete plaintext before a confirmed keychain write |
| 3. Cleanup, docs & verification | Updated CLAUDE.md/AGENTS.md + roadmap status; green fences | Docs drifting from shipped behavior |

**Prerequisites:** none (standalone hardening; R2 chokepoint already in place).
**Estimated effort:** ~1 focused session across 3 phases.

## Open Risks & Assumptions

- Boot sequence can `await hydrateKeys()` before the settings modal / transcribe setup read a key synchronously (else repopulate via `emit()` after hydration).
- `keyring` 3.x default macOS feature links cleanly into the existing Tauri build (no extra system deps).
- Regression suite is parser/exporter-only, so this change is verified primarily by manual Keychain round-trip + migration checks.

## Success Criteria (Summary)

- A key set in the app survives relaunch by loading from the macOS Keychain; no plaintext key remains in `localStorage`.
- A pre-existing plaintext key auto-migrates to the Keychain and is deleted on first launch.
- AI analysis, model loading, and diarization continue to work unchanged; browser-dev and keychain-failure paths degrade gracefully.
