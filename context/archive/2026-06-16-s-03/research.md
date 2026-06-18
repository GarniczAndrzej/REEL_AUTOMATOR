---
date: 2026-06-16T23:40:59+0200
researcher: GarniczAndrzej
git_commit: 029929faf672abefb7ac01617f46a46d94167afb
branch: master
repository: REEL_AUTOMATOR
topic: "Editable system prompt + reusable prompt presets (FR-015 / FR-016)"
tags: [research, codebase, prompt, presets, schema, persistence, ui]
status: complete
last_updated: 2026-06-16
last_updated_by: GarniczAndrzej
---

# Research: Editable system prompt + reusable prompt presets (FR-015 / FR-016)

**Date**: 2026-06-16T23:40:59+0200
**Researcher**: GarniczAndrzej
**Git Commit**: 029929faf672abefb7ac01617f46a46d94167afb
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

Ground a plan for S-03 (roadmap `prompt-presets`): make the system prompt editable
(FR-015 — "the system prompt is not hardcoded; editor supplies a user prompt too") and
add reusable prompt presets (FR-016 — list + editor; save-as / duplicate / delete / edit;
import/export as `.json` via native path picker; built-in starter presets ship; user
presets persist). Focus areas (all selected, comprehensive depth): **persistence
mechanism**, **schema-coupling safety**, **import/export + path-picker**, **built-in
starters + UI patterns**.

## Summary

Today there is exactly **one** editable prompt — `state.userPrompt`, a Polish default
block (`src/state.js:49-56`) bound to a single `<textarea id="userPrompt">`
(`src/index.html:317-321`) wired in `src/ui/step2-analyze.js:17-22`. The "system prompt"
that FR-015 wants editable is currently the **hardcoded** `FORMAT_SPEC` constant
(`src/ai/prompt.js:10-35`) — the response-format JSON example + scoring rules — appended
after the user prompt by `buildPrompt()` (`src/ai/prompt.js:94-102`). The feature has
**never been attempted**: no `promptPresets` state, no system-prompt editor, no preset
storage exists in live code or history (the only "presets" ever in the repo were
*render* presets, deleted in F-01/S-17 — do not resurrect).

The one sharp edge the roadmap flags (`roadmap.md:173`) is real but **structurally
contained**: `buildPrompt` already isolates the user-editable text (the `userPrompt` slot)
from the schema-bearing `FORMAT_SPEC` + segments block. As long as `FORMAT_SPEC` and the
`DOSTĘPNE SEGMENTY` block keep being injected (the existing `buildStaticBlock` split),
`validateReels` cannot be broken by whatever the user types — because the validator
hard-requires only `reel_name` + `clip_ids`, and only `markers` among the scored fields
ever reaches an exporter.

There are three established persistence tiers (localStorage / `.reelproj` / Tauri
backend dirs) and clean UI precedents for every piece of the preset manager. The **one
genuine gap**: there is no frontend-callable "read an arbitrary text file" command — the
native `open()` dialog returns only a path, and only `load_project` reads a file. So
preset **export** reuses `saveTextToPath` as-is, but preset **import** from a chosen
`.json` needs a new Rust read command (or a `load_project` analog).

## Detailed Findings

### A. The prompt pipeline & the FR-015 split point

- `buildPrompt(userPrompt, sentences, sources, primaryFilename)` (`src/ai/prompt.js:94-102`)
  returns `` `${userPrompt}\n${buildStaticBlock(...)}` ``. Assembled order:
  1. **`userPrompt`** — editable today
  2. `multiSourceNote` — dynamic, **dead** (all callers pass `sources = null`; multi-source
     repeater removed in S-16)
  3. `DOSTĘPNE SEGMENTY` + segments JSON — machine-generated from `sentences`
     (`buildSegmentsSection`, `src/ai/prompt.js:39-70`)
  4. **`FORMAT_SPEC`** (`src/ai/prompt.js:10-35`) — hardcoded; **this is what FR-015 exposes**
- `FORMAT_SPEC` has two parts: the JSON shape example (`:10-28`, `OCZEKIWANY FORMAT
  ODPOWIEDZI`) and the scoring prose (`:30-35`, `ZASADY OCENY`).
- `state.userPrompt` default is an **inline literal** at `src/state.js:49` — no shared
  constant. FR-016 will likely want this hoisted into a presets module so the default
  becomes "preset #1" instead of a magic literal.
- The four `buildPrompt` callers: `src/ui/step2-prompt-panel.js:70` (live analysis +
  cache key), `:196` (download `.txt`), `:212` (copy `.md`), and
  `src/ui/export-popover.js:231` (copy-prompt). Textarea write-back is the sole
  `state.userPrompt =` at `src/ui/step2-analyze.js:20` (+ `emit()`).

### B. Schema-coupling safety (the "sharp edge")

The validator is **lenient by design** (`src/ai/validate.js`, header `:1-3`):

- **Hard-required (throws):** top level non-empty array (`:20-25`); `reel_name` non-empty
  string (`:34`); `clip_ids` non-empty array of integers (`:43`) that exist in `sentences`
  (`:48`, `knownIds.has(id)`).
- **Validated only-if-present (optional):** `virality_score` number 0–100 (`:56-63`);
  `scores.{hook,flow,value,trend}` numbers, type-checked only (no range) (`:64-80`, `AXES`
  `:5`); `reason` string (`:81-83`); `markers.{hook,body,punchline}` integers that must be
  **members of this reel's `clip_ids`** (`:84-105`, membership `:99`).

Downstream consumers (what actually breaks if the shape drifts):

- **`clip_ids`** — load-bearing everywhere: all 3 exporters (`edl.js:30`, `xml.js:40`,
  `lua.js:58/97/106`), `selection/timeline.js:33`, reel-list + segment-ops UI,
  `parser/segments.js:7`.
- **`reel_name`** — export labels: `edl.js:35`, `xml.js:45`, `lua.js:110`,
  `step2-reel-list.js:115`.
- **`markers`** — the **only** scored field an exporter reads: `edl.js:59-69` (`* LOC`
  GREEN/YELLOW/RED cues), guarded by `if (reel.markers)` (`:61`); **no** xml/lua consumer.
- **`virality_score`, `scores.*`** — cosmetic, UI badges only (`step2-reel-list.js:62-66`).
- **`reason`** — **zero consumers** anywhere (pure passthrough).

→ **Schema-critical (must stay locked / always-injected):** the `FORMAT_SPEC` JSON example
+ the `DOSTĘPNE SEGMENTY` block (supplies the valid `clip_ids` universe) + the
`markers ∈ clip_ids` rule. **Safe to expose for free editing:** the persona/intent prose
(today's `userPrompt`) and the `ZASADY OCENY` scoring guidance (validator enforces no
per-axis ranges; `reason` is unused).

The CLAUDE.md "update EVERY consumer" rule resolves concretely to: `src/ai/prompt.js`,
`src/ai/validate.js`, `src/state.js:30-37` (`@typedef Reel`), the 3 exporters,
`step2-reel-list.js`, `step2-segment-ops.js`, `export-popover.js`, `selection/timeline.js`,
`parser/segments.js`, `project-io.js`, and a `test/regression.js` case.

### C. Persistence & import/export precedents

Three tiers, each with a reusable pattern:

1. **localStorage (app-level / per-machine).** Keys: `edl_app_settings` (settings bag —
   `src/settings.js:9/22/39`, the canonical `loadSettings()`/`saveSettings(partial)`
   merge-and-write helper), `edl_apikey_<provider>` (`src/ai/api-key.js`), `edl_whisper_advanced`
   (`transcribe.js:358/375/386`), `edl_or_model` + `edl_or_models_cache`
   (`openrouter-picker.js:24/29/56/136`), `edl_recent_projects` (`project-io.js:180/183`).
   `state` itself is **not** persisted.
2. **`.reelproj` (per-project).** `src/ui/import/project-io.js` save (`:66-96`, `version: 5`
   at `:75`, writes `userPrompt` at `:85`) / tolerant load (`applyProjectData` `:98-175`:
   reset-to-default then conditional assign; legacy keys ignored). Rust side
   `src-tauri/src/project.rs:5-15` (`save_project`/`load_project` over a frontend path).
   `userPrompt` already round-trips here.
3. **Tauri backend dirs.** `app_cache_dir` → `llm-cache`/`waveform-cache`/`whisper-cache`/
   `engine-readiness`; `app_data_dir` → `whisper-models` (`models.rs:39`, the one durable
   non-cache store). **No `app_config_dir` is used anywhere** — would be a net-new convention.

File I/O building blocks:

- **Export (write to chosen path):** `saveTextToPath({defaultName, content, filters})`
  (`src/util/save-file.js:15-33`) → Rust `save_text_file` (`project.rs:20`). Used by
  export-popover, segments `.md`, `PROMPT_DLA_AI.txt` (`step2-prompt-panel.js:202`), etc.
- **Open (returns path string only):** `open(...)` at `project-io.js:29`,
  `settings-modal.js:130`, `transcribe.js:576`. **None read file contents in JS.**
- **Native confirm:** `ask(...)` (`@tauri-apps/plugin-dialog`) at `transcribe.js:254-263`
  (delete-model) — the destructive-confirm precedent for preset delete.
- **No `@tauri-apps/plugin-fs` usage anywhere** — all file I/O goes through Rust commands.

→ **Gap:** preset **import** needs a new frontend-callable "read text from chosen path"
Rust command (mirror `save_text_file` in reverse), or a generic `load_text_file`.

### D. Built-in starters + UI pattern precedents

- **Host:** `src/ui/settings-modal.js` (`:82-104`) — the modal lifecycle (open/close,
  `fillSettingsForm` load-on-open, per-input save-through + `emit()`). Natural home for a
  "Presety promptu" section; persist via the `src/settings.js` `loadSettings`/`saveSettings`
  pattern.
- **Pick-one list:** `src/ai/openrouter-picker.js` — load list → cache to localStorage →
  render → filter → select-and-`emit()` → badge (`:81-147`). Maps ~1:1 to a preset picker.
- **List-with-per-item-actions:** `renderModelManager` (`transcribe.js:193-246`) — `<select>`
  + conditional per-item buttons via `data-*` attributes + handlers attached post-render +
  re-render-after-mutation. The template for preset rows (edit/duplicate/delete).
  `deleteModel` (`:248-277`) is the native-`ask` destructive-confirm precedent.
- **Alternative surface:** `src/ui/export-popover.js` (`:65-76`, `FORMATS` config map) — a
  table-driven popover if presets are config-shaped.
- **Feedback:** `src/ui/toast.js` — `toast(msg, 'success'|'error'|'info')`, transient, Polish.
  Toasts inform only; never gate a decision.
- **Defaults+overrides modeling:** no "shipped seed list + user additions" precedent exists;
  closest is `defaultWhisperAdvanced()` (a hardcoded defaults factory, `transcribe.js:~360`)
  and the `saveSettings(partial)` merge. Built-in starter presets would be a new
  hardcoded-array-in-code seed.

## Code References

- `src/ai/prompt.js:10-35` — `FORMAT_SPEC` (the hardcoded "system prompt" FR-015 targets)
- `src/ai/prompt.js:94-102` — `buildPrompt`, the user/static split point
- `src/state.js:49-56` — `state.userPrompt` inline default (Polish)
- `src/ui/step2-analyze.js:17-22` — textarea ↔ state wiring
- `src/index.html:317-321` — `<textarea id="userPrompt">`
- `src/ai/validate.js:19-105` — `validateReels` gate (hard vs optional fields)
- `src/exporters/edl.js:59-69` — the only exporter reading `markers`
- `src/ui/import/project-io.js:66-96,98-175` — `.reelproj` save/tolerant-load (v5)
- `src-tauri/src/project.rs:5-20` — `save_project`/`load_project`/`save_text_file`
- `src/util/save-file.js:15-33` — `saveTextToPath` (export precedent)
- `src/settings.js:9-42` — `loadSettings`/`saveSettings` localStorage bag pattern
- `src/ui/settings-modal.js:82-124` — modal host lifecycle
- `src/ai/openrouter-picker.js:81-147` — searchable list → select → persist precedent
- `src/ui/import/transcribe.js:193-277` — list-with-actions + native-`ask` delete precedent

## Architecture Insights

- **The split already exists.** `buildPrompt`'s `userPrompt` slot is structurally isolated
  from the schema half. FR-015 is largely *formalizing and expanding* an existing surface
  (split `FORMAT_SPEC` into an editable "system prompt" string + keep the JSON example +
  segments always-injected), not inventing a pipeline. The safest design keeps the
  schema-critical block machine-owned and re-validates hard regardless of prompt text —
  `validateReels` already guarantees export safety.
- **A preset is just text.** Post-S-17 there is no provider axis; a preset is prompt
  text (system + user), optionally a model id. No provider/model constants to thread.
- **Persistence is a real decision, not a default.** App-global preset persistence has no
  single obvious home: localStorage is the only existing *app-level* store (`.reelproj` is
  per-project; no `app_config_dir` convention exists). The three candidates and the
  precedent each reuses:

  | Target | Reuses | Survives | Portable | Import `.json` |
  |---|---|---|---|---|
  | localStorage bag (`edl_prompt_presets`) | `src/settings.js`, `edl_or_models_cache` | sessions, per-machine | only via export | needs new read cmd |
  | Tauri JSON in `app_data_dir` (new Rust cmd) | `models.rs` durable-store pattern | sessions, per-machine | only via export | needs new read cmd |
  | `.reelproj` | existing project save/load | per-project only | with the project | reuses `load_project` |

  (Facts only — the plan picks the winner. localStorage mirrors the app's status-quo
  app-level store; `.reelproj` is per-project so it does **not** satisfy "presets persist
  globally" alone.)
- **Cache-busting is expected.** The full prompt string is the LLM disk-cache key
  (`step2-prompt-panel.js:86-90`); editing the system prompt or switching presets busts the
  cache by design. Worth a user-facing note, not a blocker.

## Historical Context (from prior changes)

- **S-01** (`context/archive/2026-06-12-scored-selection-edl/plan.md:222-233,309-331`) —
  established the fixed scored JSON schema + the `validateReels` "validate-before-use" gate;
  explicitly deferred S-03 (`plan.md:81`).
- **S-16** (`context/archive/2026-06-15-s-16/`) — removed the A/B compare modal + AI-cache
  control; demoted the paste-JSON path; introduced the **settings-modal / export-popover /
  toast** patterns (the UI precedents above); split `step2-analyze` into per-surface modules.
- **S-17** (`context/archive/2026-06-15-s-17/plan.md:31,110-122`) — OpenRouter-only;
  deleted `src/ai/models.js` + provider/model constants; **kept S-03 at full scope** in the
  plan (overriding its own research note that floated simplifying FR-016). Also pruned the
  unrelated *render* preset commands (`save/load/list/delete_render_preset`) — gone, do not
  resurrect.
- **No prior prompt-preset work** — every "preset" hit in history is either a forward
  reference to S-03 or the deleted render presets.
- **lessons.md** (`context/foundation/lessons.md`) — two entries (plan-brief in Polish;
  never bake multi-GB assets into the onefile); **neither constrains S-03**. Note the
  standing app-wide rule: all user-facing strings are Polish.

## Related Research

- `context/archive/2026-06-12-scored-selection-edl/research.md` — schema + validation origin
- `context/archive/2026-06-15-s-17/research.md` — provider pruning; S-03 scope note
- `context/archive/2026-06-15-s-16/research.md` — settings-modal / popover / toast patterns

## Open Questions

1. **Persistence target** — localStorage bag vs new Tauri `app_data_dir` JSON vs `.reelproj`.
   Roadmap says "user presets persist" (implies app-global → not `.reelproj` alone). For the
   plan / a scoping decision.
2. **System-prompt editability granularity** — expose the whole `FORMAT_SPEC` as free text
   (max flexibility, max foot-gun) vs expose only `ZASADY OCENY` scoring guidance and keep
   the JSON-shape example + segments machine-owned (safer). Research says the latter cannot
   break export; the former can desync the badges but still passes `validateReels` as long
   as the static block is always appended.
3. **Preset shape** — does a preset bundle {systemPrompt, userPrompt} together, or are system
   and user prompts presetted independently? FR-015 names both; FR-016 says "prompt presets".
4. **Import command** — new generic `load_text_file` Rust command vs a preset-specific reader.
5. **Built-in starters** — how many ship, and is today's `state.js:49` default promoted to
   "preset #1"? (Recommended by the pipeline agent to kill the magic literal.)
