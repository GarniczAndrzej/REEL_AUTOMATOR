# Editable system prompt + reusable prompt presets (S-03) — Plan Brief

> Full plan: `context/changes/s-03/plan.md`
> Research: `context/changes/s-03/research.md`

## What & Why

Make the LLM scoring guidance editable as a **global system prompt** (FR-015) and add a
**reusable library of `userPrompt` presets** (FR-016): pick / save-as / duplicate / rename /
delete, plus `.json` import/export. Today the scoring rules are hardcoded and there's exactly
one editable prompt — this unlocks per-workflow prompting without touching code.

## Starting Point

`buildPrompt` (`src/ai/prompt.js:94-102`) already concatenates the editable `userPrompt` with
a machine-owned static block (`DOSTĘPNE SEGMENTY` + the hardcoded `FORMAT_SPEC`). The scoring
prose FR-015 wants editable is the `ZASADY OCENY` half of `FORMAT_SPEC`. There is no
`systemPrompt`, no preset state, and no frontend-callable "read a text file" command yet.

## Desired End State

A settings-modal field edits the global system prompt (persisted in localStorage, round-tripped
in a v6 `.reelproj`). A preset bar in the Analiza AI section picks/saves/manages `userPrompt`
presets backed by a localStorage library seeded with 3–4 Polish built-ins. The response-format
JSON example + segments stay machine-injected, so `validateReels` keeps export safe no matter
what the user types.

## Key Decisions Made

| Decision                       | Choice                                              | Why (1 sentence)                                                        | Source   |
| ------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| Persistence                    | Hybrid: localStorage library + `.reelproj` prompts  | App-global reuse via localStorage; active prompts travel with projects. | Plan     |
| System-prompt editability      | Scoring guidance (`ZASADY OCENY`) only              | Research confirms this cannot break export or desync badges.            | Research/Plan |
| Preset shape                   | `userPrompt`-only presets; system prompt is global  | Simplest model that meets FR-016; system prompt is set-and-forget.      | Plan     |
| Import command                 | Generic `load_text_file` Rust command               | Symmetric with `save_text_file`, reusable, keeps "presets are text".    | Plan     |
| Built-in starters              | 3–4 Polish; current default = preset #1             | Kills the magic literal, gives first-run value.                         | Plan     |
| Built-in CRUD                  | Fully editable/deletable (no immutable flag)        | Simplest model; no reset/flag machinery.                               | Plan     |

## Scope

**In scope:** editable global system prompt (settings modal + persistence + v6 round-trip);
`userPrompt` preset library with CRUD; built-in starters; `.json` import/export; new
`load_text_file` Rust command; first prompt-assembly regression test.

**Out of scope:** per-preset model id; independent system-prompt presets; editing the
JSON-shape/segments; cloud sync/sharing; any new Tauri durable store.

## Architecture / Approach

Split `FORMAT_SPEC` → machine-owned `RESPONSE_FORMAT` (JSON example) + exported
`DEFAULT_SCORING_GUIDANCE` (default for `state.systemPrompt`). Thread `systemPrompt` through
`buildPrompt` + its 4 callers, always appending format + segments. Persist via the settings
bag + `.reelproj` v6. Presets live in a new `src/ai/prompt-presets.js` (localStorage
`edl_prompt_presets`), surfaced by a `step2-preset-bar.js` controller and import/exported via
`saveTextToPath` + the new `load_text_file` command.

## Phases at a Glance

| Phase                                     | What it delivers                                          | Key risk                                              |
| ----------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| 1. Pipeline split + global system prompt  | Editable system prompt, persisted + v6 round-trip + test | Breaking the always-inject invariant / caller misses |
| 2. Preset data model + persistence        | `promptPresets` store + built-in seeding                  | First-run seeding clobbering user edits              |
| 3. Preset manager UI (CRUD)               | Picker + save-as/duplicate/rename/delete in step 2        | DOM/state desync with the existing textarea binding  |
| 4. Preset import/export                   | `load_text_file` + `.json` import/export                  | Unvalidated import data reaching state               |

**Prerequisites:** none beyond a working dev environment (sidecars not required for this slice).
**Estimated effort:** ~2–3 sessions across 4 phases.

## Open Risks & Assumptions

- Editing the system prompt or switching presets busts the LLM disk cache (it's the cache key)
  — expected, not a regression.
- Assumes `.reelproj` v6 tolerant-load keeps older files working (consistent with v5 behavior).

## Success Criteria (Summary)

- The user can edit a global system prompt that persists across sessions and travels with a project.
- The user can build, apply, and import/export a library of named prompt presets.
- Export never breaks regardless of prompt text — the regression suite proves format + segments
  are always injected.
