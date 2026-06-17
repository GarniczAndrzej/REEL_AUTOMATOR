# Editable system prompt + reusable prompt presets (S-03) Implementation Plan

## Overview

Deliver FR-015 + FR-016: make the LLM scoring guidance **editable as a global system
prompt**, and add a **reusable library of `userPrompt` presets** (pick / save-as /
duplicate / rename / delete + `.json` import/export). The response-format JSON example and
the `DOSTĘPNE SEGMENTY` block stay machine-owned and always-injected, so no prompt edit can
break the export pipeline — `validateReels` remains the export-safety guarantee.

## Current State Analysis

- The prompt is assembled by `buildPrompt(userPrompt, sentences, sources, primaryFilename)`
  (`src/ai/prompt.js:94-102`), which concatenates the editable `userPrompt` with a static
  block (`buildStaticBlock`, `prompt.js:73-84`): `DOSTĘPNE SEGMENTY` + `FORMAT_SPEC`.
- `FORMAT_SPEC` (`prompt.js:10-35`) is **one hardcoded constant** with two parts: the JSON
  shape example (`:10-28`) and the `ZASADY OCENY` scoring prose (`:30-35`). FR-015 targets
  the latter.
- `state.userPrompt` is an inline Polish literal (`src/state.js:49-56`); the only writer is
  the textarea binding at `src/ui/step2-analyze.js:17-22`. There is **no** `systemPrompt`,
  no `promptPresets`, no preset storage anywhere.
- `buildPrompt` has **four callers**: `step2-prompt-panel.js:70` (analysis + cache key),
  `:196` (download `.txt`), `:212` (copy `.md`), and `export-popover.js:231` (copy-prompt).
- Persistence precedents: the localStorage settings bag (`src/settings.js`
  `loadSettings`/`saveSettings`), the `.reelproj` save/tolerant-load (`project-io.js`,
  currently `version: 5`; `userPrompt` already round-trips at `:85`/`:124`), and the
  `saveTextToPath` export helper (`src/util/save-file.js`) → Rust `save_text_file`
  (`project.rs:20`).
- **Gap:** no frontend-callable "read an arbitrary text file" command exists — `open()`
  returns a path only; only `load_project` reads a file. Preset import needs a new reader.
- The regression suite (`test/regression.js`) covers parser + exporters but **has zero
  prompt-building coverage** today.

## Desired End State

- A **settings-modal field** holds the editable scoring guidance (`state.systemPrompt`),
  defaulting to today's `ZASADY OCENY` text, persisted to localStorage and round-tripped in
  `.reelproj` (schema v6). The JSON example + segments stay machine-injected.
- A **preset bar** in the Analiza AI section lets the user pick a preset (fills the
  `userPrompt` textarea), save the current prompt as a new named preset, duplicate, rename,
  delete (native confirm), and import/export presets as `.json`.
- 3–4 Polish **built-in starter presets** ship and are seeded into the localStorage library
  on first run; today's `state.js` default becomes preset #1.
- `buildPrompt` always appends the machine-owned response-format + segments regardless of
  prompt text, so export stays safe. Verifiable: `node --experimental-vm-modules
  test/regression.js` passes including a new prompt-assembly case; `cargo check` passes with
  the new `load_text_file` command registered.

### Key Discoveries:

- The user/static split already exists — `buildPrompt`'s `userPrompt` slot is isolated from
  the schema half (`prompt.js:73-102`). FR-015 formalizes it; it does not invent a pipeline.
- Export safety is owned by `validateReels`, not the prompt (`src/ai/validate.js:19-105`):
  hard-requires only `reel_name` + `clip_ids`; only `markers` reaches an exporter
  (`edl.js:59-69`). So exposing the scoring prose **cannot** break export.
- `saveTextToPath` already satisfies preset **export** as-is; only **import** needs new Rust.
- `.reelproj` `applyProjectData` resets per-project content but intentionally does NOT reset
  app-level config (`project-io.js:98-130`) — `systemPrompt` should follow the `userPrompt`
  precedent (assign-if-present, with a localStorage-backed global default).

## What We're NOT Doing

- **No per-preset model id** — a preset is `userPrompt` text only; the OpenRouter model
  stays the global picker.
- **No independent system-prompt presets** — the system prompt is a single global setting,
  not a preset list.
- **No editing of the JSON-shape example or `DOSTĘPNE SEGMENTY`** — both stay machine-owned
  and always-injected.
- **No preset sharing / cloud sync** — portability is local `.json` export/import only.
- **No new `app_config_dir`/Tauri durable store** — presets live in localStorage; the active
  prompts round-trip in `.reelproj`.

## Implementation Approach

Split `FORMAT_SPEC` into a machine-owned `RESPONSE_FORMAT` (JSON example) and an exported
`DEFAULT_SCORING_GUIDANCE` (the `ZASADY OCENY` text, the default for `state.systemPrompt`).
Thread `systemPrompt` through `buildStaticBlock`/`buildPrompt` and all four callers, with the
response-format + segments always injected after the user/system text. Persist `systemPrompt`
to the localStorage settings bag and round-trip it in a v6 `.reelproj`. Presets are a separate
localStorage library (`edl_prompt_presets`) managed by a new `src/ai/prompt-presets.js`
module, seeded with built-ins on first run, surfaced by a preset bar in step 2 and
import/exported via `saveTextToPath` + a new generic `load_text_file` Rust command.

## Critical Implementation Details

- **Always-inject ordering is the safety invariant.** `buildStaticBlock` must append
  `RESPONSE_FORMAT` + the segments block *unconditionally*, independent of `systemPrompt`
  text. The system prompt slot carries only the scoring prose; if a user empties it, export
  still works because the JSON example + segments + `validateReels` are untouched.
- **`systemPrompt` has global-default + project-override semantics**, mirroring how
  `userPrompt` loads from `.reelproj` (`project-io.js:124`). On boot, seed `state.systemPrompt`
  from `loadSettings().systemPrompt ?? DEFAULT_SCORING_GUIDANCE`; on project load, assign only
  if present; the settings-modal edit writes through to both `state` and `saveSettings`.

## Phase 1: Prompt pipeline split + global system prompt

### Overview

Split the hardcoded `FORMAT_SPEC` so the scoring guidance becomes an editable global
`state.systemPrompt`, thread it through the prompt builder and all callers, persist it
(localStorage + `.reelproj` v6), and add a settings-modal editor. Lock in export safety with
the first regression test for prompt assembly.

### Changes Required:

#### 1. Prompt builder split

**File**: `src/ai/prompt.js`

**Intent**: Separate the machine-owned response format from the user-editable scoring
guidance, and let the builder accept a system prompt while always injecting the format +
segments.

**Contract**: Replace `FORMAT_SPEC` with two pieces: `RESPONSE_FORMAT` (the JSON example,
`:10-28`, kept module-private) and an exported `DEFAULT_SCORING_GUIDANCE` (the `ZASADY OCENY`
text, `:30-35`). `buildStaticBlock(sentences, sources, primaryFilename)` stays machine-owned
(segments + `RESPONSE_FORMAT`). `buildPrompt` gains a `systemPrompt` parameter and returns
`userPrompt` + segments + `RESPONSE_FORMAT` + `systemPrompt` (scoring guidance last). New
signature: `buildPrompt(userPrompt, systemPrompt, sentences, sources = null, primaryFilename = '')`.

#### 2. `buildPrompt` callers

**File**: `src/ui/step2-prompt-panel.js` (lines 70, 196, 212), `src/ui/export-popover.js` (line 231)

**Intent**: Pass `state.systemPrompt` into every `buildPrompt` call so analysis, downloads,
copy-prompt, and the cache key all reflect the editable system prompt.

**Contract**: Update all four call sites to the new signature. The analysis `cacheKey`
(`step2-prompt-panel.js:86-90`) already hashes the full prompt string, so editing the system
prompt busts the LLM cache automatically — no separate cache-key change needed.

#### 3. State field

**File**: `src/state.js`

**Intent**: Add the global editable system prompt to state with the scoring-guidance default.

**Contract**: Add `systemPrompt` to the `state` object, initialized to `DEFAULT_SCORING_GUIDANCE`
imported from `src/ai/prompt.js`. (Boot override from `loadSettings()` is wired in change #5.)

#### 4. Settings-modal editor

**File**: `src/ui/settings-modal.js`, `src/index.html`

**Intent**: Give the user a place to view/edit the global system prompt, persisted across
sessions.

**Contract**: Add a `<textarea id="systemPrompt">` (Polish label, e.g. "Prompt systemowy
(zasady oceny)") to the settings modal markup in `index.html`. In `settings-modal.js`:
`fillSettingsForm` sets its value from `state.systemPrompt`; an `input` handler writes through
to `state.systemPrompt`, calls `saveSettings({ systemPrompt })`, and `emit()`s — mirroring the
existing `mergeThreshold` binding (`:31-39`).

#### 5. Boot seeding from settings

**File**: `src/ui/settings-modal.js` (init) or `src/main.js`

**Intent**: Restore a previously saved global system prompt on launch, falling back to the
default.

**Contract**: On init, set `state.systemPrompt = loadSettings().systemPrompt ?? DEFAULT_SCORING_GUIDANCE`.
Place alongside the existing settings-bag reads.

#### 6. `.reelproj` round-trip (schema v6)

**File**: `src/ui/import/project-io.js`

**Intent**: Make projects reproducible — a project analyzed with custom scoring guidance
reloads with it.

**Contract**: Bump `version: 5` → `6` (`:75`); add `systemPrompt: state.systemPrompt` to the
write payload (`:85` area). In `applyProjectData`, add `if (data.systemPrompt) state.systemPrompt = data.systemPrompt;`
(assign-if-present, like `userPrompt` at `:124`) and sync the settings-modal textarea value.
Older v5/v4 files load unchanged (no `systemPrompt` key → keeps the global default).

#### 7. Regression coverage

**File**: `test/regression.js`

**Intent**: Lock the safety invariant — response format + segments are always injected
regardless of system/user prompt text.

**Contract**: Add a case importing `buildPrompt` + `DEFAULT_SCORING_GUIDANCE`: assert the
output contains the segments header, the JSON-shape markers (e.g. `clip_ids`), and the passed
`systemPrompt`, and that an empty `systemPrompt` still yields the format + segments. Follow the
existing test structure; do not add a framework.

### Success Criteria:

#### Automated Verification:

- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- New prompt-assembly case asserts format + segments always present
- Rust type-check passes (unchanged backend): `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- Editing the system prompt in settings then running analysis produces sensible results
- The edited system prompt survives an app restart (localStorage)
- Saving + reloading a `.reelproj` restores the project's system prompt
- Loading an old (v5) project keeps the current global system prompt (no crash)

**Implementation Note**: After completing this phase and all automated verification passes,
pause for manual confirmation before proceeding.

---

## Phase 2: Preset data model + persistence + seeding

### Overview

Introduce the `userPrompt` preset library: a `state.promptPresets` list backed by a
localStorage store, with 3–4 Polish built-in starters seeded on first run (today's default =
preset #1) and helper functions for CRUD.

### Changes Required:

#### 1. Preset module

**File**: `src/ai/prompt-presets.js` (new)

**Intent**: Own the preset library — load/save to localStorage, seed built-ins on first run,
and expose CRUD helpers used by the UI and import/export.

**Contract**: Export `loadPresets()` / `savePresets(list)` over localStorage key
`edl_prompt_presets` (tolerant read like `loadSettings`); a `BUILTIN_PRESETS` array of 3–4
`{ id, name, userPrompt }` (preset #1 = the current `state.userPrompt` default, plus e.g.
edukacyjny, storytelling, sprzedażowy — all Polish); `seedPresetsIfEmpty()` that writes
`BUILTIN_PRESETS` when the store is absent; and helpers `addPreset`, `updatePreset`,
`removePreset(id)`, `getPreset(id)`. Presets are fully editable/deletable (no immutable flag).
IDs are generated (e.g. `crypto.randomUUID()` or timestamp).

#### 2. State field + typedef

**File**: `src/state.js`

**Intent**: Hold the in-memory preset list and document its shape.

**Contract**: Add `promptPresets: []` to `state`; add a `@typedef PromptPreset` with
`{ id: string, name: string, userPrompt: string }`. Keep the existing `userPrompt` literal as
the active prompt (it also seeds built-in #1).

#### 3. Boot seeding

**File**: `src/main.js` (or the settings init path)

**Intent**: Ensure the library is populated on first run and loaded into state every launch.

**Contract**: Call `seedPresetsIfEmpty()` then `state.promptPresets = loadPresets()` during
boot, before the step-2 UI renders.

### Success Criteria:

#### Automated Verification:

- Regression suite still passes: `node --experimental-vm-modules test/regression.js`
- `src/ai/prompt-presets.js` exists and exports the documented helpers

#### Manual Verification:

- First launch shows the 3–4 built-in presets in the picker (Phase 3 surfaces them)
- Built-ins persist across restart; the store is not re-seeded over user edits

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Preset manager UI (CRUD)

### Overview

Surface the preset library in the Analiza AI section: a picker that applies a preset to the
`userPrompt` textarea, plus save-as / duplicate / rename / delete, with toast feedback and a
native confirm on delete.

### Changes Required:

#### 1. Preset bar markup

**File**: `src/index.html`

**Intent**: Add the preset controls above the existing `#userPrompt` textarea (`:317-321`).

**Contract**: A row containing a `<select id="presetPicker">` and buttons (Polish):
"Zapisz jako", "Duplikuj", "Zmień nazwę", "Usuń", "Importuj", "Eksportuj" (import/export wired
in Phase 4). Place inside the existing "Prompt dla AI" card.

#### 2. Preset bar controller

**File**: `src/ui/step2-preset-bar.js` (new), wired from `src/ui/step2-analyze.js`

**Intent**: Render the picker from `state.promptPresets`, apply a chosen preset to the prompt,
and handle save-as/duplicate/rename/delete against the Phase 2 helpers.

**Contract**: `renderPresetBar()` populates the `<select>` from `state.promptPresets` and
re-renders after any mutation (the `renderModelManager` re-render-after-mutation pattern,
`transcribe.js:193-246`). Selecting a preset sets `state.userPrompt`, updates the
`#userPrompt` textarea value, and `emit()`s. "Zapisz jako" prompts for a name and calls
`addPreset({ name, userPrompt: state.userPrompt })`; "Duplikuj" clones the selected preset;
"Zmień nazwę" renames via `updatePreset`; "Usuń" confirms via `ask()` (the
`transcribe.js:248-277` delete precedent) then `removePreset`. Every mutation persists via
`savePresets` and shows a `toast(...)`. Keep the existing textarea↔state binding in
`step2-analyze.js:17-22` intact (manual edits still update `state.userPrompt`).

### Success Criteria:

#### Automated Verification:

- Regression suite still passes: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Picking a preset fills the prompt textarea and analysis uses it
- Save-as / duplicate / rename / delete work and persist across restart
- Delete asks for native confirmation; cancelling leaves the preset intact
- Toasts appear for each action; all strings are Polish

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Preset import/export

### Overview

Add a generic `load_text_file` Rust command and wire preset import (chosen `.json` →
validate → merge into the library) and export (selected preset(s) → `.json` via the existing
`saveTextToPath`).

### Changes Required:

#### 1. Rust text-file reader

**File**: `src-tauri/src/project.rs`, `src-tauri/src/lib.rs`

**Intent**: Provide the missing "read an arbitrary text file at a chosen path" command,
symmetric with `save_text_file`.

**Contract**: Add `load_text_file(path: String) -> Result<String, String>` to `project.rs`
(mirror `save_text_file`, `:19-22`, using `fs::read_to_string`); register
`project::load_text_file` in the `generate_handler!` list in `lib.rs`.

#### 2. Export presets

**File**: `src/ui/step2-preset-bar.js`

**Intent**: Write preset(s) to a user-chosen `.json` file.

**Contract**: Serialize the selected preset (or the whole library — pick one; default to the
selected preset) with `JSON.stringify`, then `saveTextToPath({ defaultName: '<name>.json',
content, filters: [{ name: 'JSON', extensions: ['json'] }] })`. Toast on success/cancel.

#### 3. Import presets

**File**: `src/ui/step2-preset-bar.js`

**Intent**: Read a chosen `.json`, validate it, and merge presets into the library.

**Contract**: `open({ filters: [{ name: 'JSON', extensions: ['json'] }] })` →
`invoke('load_text_file', { path })` → `JSON.parse` → validate each entry has a string `name`
and string `userPrompt` (assign fresh IDs to avoid collisions) → append via `addPreset` /
`savePresets` → `renderPresetBar()` + `emit()` + toast. On parse/shape failure, `toast(...,
'error')` with a Polish message; never feed unvalidated data into state.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- `load_text_file` is registered in `lib.rs` (`generate_handler!`)
- Regression suite still passes: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Exporting a preset writes a `.json` to the chosen location (native dialog, not ~/Downloads)
- Importing that `.json` re-adds the preset(s) and they appear in the picker
- Importing a malformed/`.json` non-preset file shows a Polish error toast, no crash
- Imported presets persist across restart

**Implementation Note**: Pause for manual confirmation; this is the final phase.

---

## Testing Strategy

### Unit Tests (regression runner):

- `buildPrompt` always injects the response-format JSON example + `DOSTĘPNE SEGMENTY`,
  regardless of `userPrompt` / `systemPrompt` content (including empty `systemPrompt`).
- The passed `systemPrompt` appears in the assembled prompt.

### Integration / Manual:

- Settings-modal system-prompt edit → persists (localStorage) and round-trips (`.reelproj` v6).
- Preset CRUD lifecycle (create/apply/duplicate/rename/delete) persists across restart.
- Import/export round-trip; malformed-import rejection.
- Old-project (v5) load keeps the global system prompt and does not error.

### Manual Testing Steps:

1. Edit the system prompt in settings; run analysis; confirm it influences results.
2. Save a `.reelproj`, restart, reload it; confirm system prompt + active user prompt restored.
3. Create a preset, restart, confirm it persists; apply it; analyze.
4. Export the preset to `.json`; delete it; import the `.json`; confirm it returns.
5. Import a junk file; confirm a Polish error toast and no crash.

## Performance Considerations

Editing the system prompt or switching presets changes the full prompt string, which is the
LLM disk-cache key (`step2-prompt-panel.js:86-90`) — so it busts the cache by design. This is
expected behavior, not a regression; worth a brief user-facing note if the UI has room.

## Migration Notes

`.reelproj` bumps to **v6** (adds `systemPrompt`). v5/v4/older files load tolerantly — a
missing `systemPrompt` falls back to the global default; no migration step required. The
preset library is net-new localStorage (`edl_prompt_presets`), seeded on first run.

## References

- Internal research: `context/changes/s-03/research.md`
- Prompt split point: `src/ai/prompt.js:73-102`
- Validator (export-safety gate): `src/ai/validate.js:19-105`
- `.reelproj` save/tolerant-load (v5): `src/ui/import/project-io.js:66-175`
- Settings bag + modal: `src/settings.js`, `src/ui/settings-modal.js:31-39,95-124`
- Export helper / Rust file I/O: `src/util/save-file.js`, `src-tauri/src/project.rs:19-22`
- List-with-actions + native-confirm precedent: `src/ui/import/transcribe.js:193-277`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Prompt pipeline split + global system prompt

#### Automated

- [x] 1.1 Regression suite passes — 86c7fb7
- [x] 1.2 New prompt-assembly case asserts format + segments always present — 86c7fb7
- [x] 1.3 Rust type-check passes — 86c7fb7

#### Manual

- [ ] 1.4 Editing the system prompt then analyzing produces sensible results
- [ ] 1.5 Edited system prompt survives an app restart
- [ ] 1.6 Saving + reloading a `.reelproj` restores the project's system prompt
- [ ] 1.7 Loading an old (v5) project keeps the global system prompt (no crash)

### Phase 2: Preset data model + persistence + seeding

#### Automated

- [x] 2.1 Regression suite still passes — f46efa7
- [x] 2.2 `src/ai/prompt-presets.js` exists and exports the documented helpers — f46efa7

#### Manual

- [ ] 2.3 First launch shows the built-in presets in the picker
- [ ] 2.4 Built-ins persist across restart; store not re-seeded over user edits

### Phase 3: Preset manager UI (CRUD)

#### Automated

- [x] 3.1 Regression suite still passes

#### Manual

- [ ] 3.2 Picking a preset fills the textarea and analysis uses it
- [ ] 3.3 Save-as / duplicate / rename / delete work and persist across restart
- [ ] 3.4 Delete asks for native confirmation; cancel leaves preset intact
- [ ] 3.5 Toasts appear for each action; all strings Polish

### Phase 4: Preset import/export

#### Automated

- [ ] 4.1 Rust type-check passes
- [ ] 4.2 `load_text_file` registered in `lib.rs`
- [ ] 4.3 Regression suite still passes

#### Manual

- [ ] 4.4 Exporting a preset writes `.json` to chosen location (native dialog)
- [ ] 4.5 Importing that `.json` re-adds the preset(s)
- [ ] 4.6 Importing a malformed file shows a Polish error toast, no crash
- [ ] 4.7 Imported presets persist across restart
