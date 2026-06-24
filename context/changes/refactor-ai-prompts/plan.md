# Refactor AI Prompts (S-26) Implementation Plan

## Overview

Wire the already-authored engineered prompt text from
`context/foundation/prompt-design.md` into the app. Three things change:

1. The three per-phase guidance defaults in `src/ai/prompt.js`
   (`DEFAULT_CLUSTER_GUIDANCE`, `DEFAULT_CURATE_GUIDANCE`,
   `DEFAULT_SCORING_GUIDANCE`) are replaced with the structured
   `ROLE → TASK → RUBRIC → CONSTRAINTS → OUTPUT` rewrites (score bands, named
   hook archetypes, identity-aligned `trend`, anti-padding). The single-shot
   `DEFAULT_SCORING_GUIDANCE` is **flipped from Polish to
   English-instructions/Polish-output** to match cluster + curate.
2. The four generic `BUILTIN_PRESETS` in `src/ai/prompt-presets.js` are replaced
   by **11 presets**: the 9 BRAVE cohort presets (verbatim from the design doc)
   plus **The5** and **Copilot underuser** presets drafted here from the research
   persona cards.
3. A **one-time, flag-guarded boot migration** removes the 4 old generic
   starters *only when pristine* and merges the new builtins into existing users'
   libraries, preserving every user-created or edited preset.

The machine-owned JSON response format (`RESPONSE_FORMAT`,
`CLUSTER_RESPONSE_FORMAT`) and the validators (`validateReels`,
`validateThemes`) are **byte-identical** before and after — the schema does not
change, so no exporter or `.reelproj` consumer is touched.

## Current State Analysis

- **Guidance constants** live in `src/ai/prompt.js`: `DEFAULT_SCORING_GUIDANCE`
  (line 43, **Polish**), `DEFAULT_CLUSTER_GUIDANCE` (line 68, English),
  `DEFAULT_CURATE_GUIDANCE` (line 81, English). They seed `state.systemPrompt` /
  `state.clusterPrompt` / `state.curatePrompt` at `src/state.js:111,115,116`,
  with boot overrides from `loadSettings()`. The builders
  `buildPrompt` / `buildClusterPrompt` / `buildCuratePrompt` compose
  `userPrompt → machine static block → guidance`, so guidance text can never
  break export.
- **`BUILTIN_PRESETS`** (`src/ai/prompt-presets.js:14`) holds 4 generic Polish
  starters with stable ids `builtin-sprzedazowy`, `builtin-edukacyjny`,
  `builtin-storytelling`, `builtin-highlights`.
- **Seeding** is first-run-only: `seedPresetsIfEmpty()`
  (`src/ai/prompt-presets.js:98`) writes `BUILTIN_PRESETS` to
  `localStorage.edl_prompt_presets` **only when the key is absent**. Boot wiring
  is `src/main.js:36-37` (`seedPresetsIfEmpty(); state.promptPresets = loadPresets();`).
  Existing users therefore never see new builtins without a migration.
- **Preset picker** (`src/ui/step2-preset-bar.js`) renders `state.promptPresets`,
  matches the active preset by exact `userPrompt` text equality
  (`renderPresetBar`, line 39), and applies a preset by copying its `userPrompt`
  into `state.userPrompt` + the textarea.
- **Temperature** is a single global `0.1` in `callOpenRouter`
  (`src/ai/providers.js:42`), applied to all phases — already inside the
  research's 0–0.2 target. No per-phase override exists.
- **`state.userPrompt` default** (`src/state.js:101`) is hardcoded to the old
  `builtin-sprzedazowy` text.

### Key Discoveries:

- The machine-owned static block + editable guidance split means this change
  carries **zero export risk** — `validateReels`/`validateThemes` stay the gate
  (`context/changes/refactor-ai-prompts/research.md:177`).
- The regression suite (`test/regression.js`) does **not** exercise prompts, so
  it can only prove "nothing else regressed," not prompt quality. Real
  verification is a **manual A/B analysis run** on a real BRAVE recording
  (roadmap S-26 Risk note, `context/foundation/roadmap.md:480`).
- Synchronous JS dialogs crash the Tauri WKWebView
  ([[lessons.md]] rule) — not triggered by this change (no new dialogs), but
  keep it in mind if any preset CRUD is touched.
- Incidental Prettier churn must not ride into a feature commit
  ([[lessons.md]] rule) — `src/ui/step2-preset-bar.js` has carried pre-existing
  reformatting before; only stage files this change actually edits.

## Desired End State

- All three AI-analysis phases ship the re-engineered rubric guidance; the
  settings modal shows the new defaults. The single-shot guidance reads as an
  English rubric with a Polish-output directive, consistent with cluster/curate.
- A first-run user gets **11 cohort presets** in the picker (9 BRAVE + The5 +
  Copilot). An existing user gets the same 11 new builtins merged in, their old
  pristine generic starters removed, and every preset they created or edited
  left untouched.
- `node --experimental-vm-modules test/regression.js` is green before and after
  (unaffected — parser/exporter only).
- A manual A/B run (old vs new prompts) on a real BRAVE recording shows
  equal-or-better reel selection.

## What We're NOT Doing

- **No schema change.** `RESPONSE_FORMAT`, `CLUSTER_RESPONSE_FORMAT`,
  `validateReels`, `validateThemes` stay byte-identical. No new field → no
  exporter / `.reelproj` consumer changes.
- **No temperature change.** It is already `0.1` (verified). No per-phase temp
  override is added (Stage-1-higher-temp is logged future, not S-26).
- **No `state.userPrompt` default change** (user decision: leave the old
  `sprzedazowy` text as the first-run textarea default, even though that preset
  is removed from the picker — accepted mild inconsistency).
- **No parser / segment / frame-math touch.**
- **No reason-before-score, pause-cue clustering, rubric calibration, or
  CTA-A/B work** — all logged as future in `prompt-design.md` (they touch the
  frozen schema or the Stage-1 projection).
- **No preset-bar UI changes** — the existing picker renders the new list with
  no code change.

## Implementation Approach

Three independently verifiable phases, smallest-blast-radius first:
guidance text (Phase 1) is pure constant replacement; the preset library
(Phase 2) is a data swap plus two drafted presets; the migration (Phase 3) is
the only real logic and is isolated behind a version flag so it is idempotent
and cannot fight the user. Run the regression suite after each phase to prove no
collateral breakage, and finish with a manual A/B analysis run for the real
quality signal.

## Critical Implementation Details

- **Migration must be idempotent and never re-add deleted presets.** Gate it
  with a version flag in `localStorage` (e.g. `edl_presets_builtin_migration`).
  A naive "merge any missing `builtin-*` id every boot" would resurrect a cohort
  preset the user intentionally deleted — the flag prevents that by running the
  merge exactly once.
- **"Pristine" detection compares id + name + userPrompt against a frozen
  snapshot of the 4 old starters.** An old starter the user renamed (name
  differs) or edited (text differs) is NOT pristine and must be preserved. Only
  an untouched original is removed.
- **Boot ordering** in `src/main.js`: `seedPresetsIfEmpty()` (fresh users) →
  `migrateBuiltinPresets()` (existing users, flag-guarded) → `loadPresets()`.
  Fresh-seed must also set the migration flag so the migration is a no-op for
  brand-new installs.

## Phase 1: Per-phase guidance rewrites

### Overview

Replace the three `DEFAULT_*_GUIDANCE` constants in `src/ai/prompt.js` with the
engineered text from `prompt-design.md`, flipping the single-shot guidance to
English-instructions/Polish-output.

### Changes Required:

#### 1. Stage-1 clustering guidance

**File**: `src/ai/prompt.js` (`DEFAULT_CLUSTER_GUIDANCE`, line 68)

**Intent**: Replace the terse clustering rules with the structured
`ROLE → TASK → WHAT MAKES A GOOD THEME → RULES → OUTPUT` block from
`prompt-design.md` Phase 1, so Stage-1 sorts segments into stronger themed
buckets and keeps titles Polish.

**Contract**: Export name and type unchanged (`export const
DEFAULT_CLUSTER_GUIDANCE = \`...\``). Content is the verbatim text from
`context/foundation/prompt-design.md:75-98`. Still English instructions with an
explicit "write every title in Polish" directive. No change to
`buildClusterPrompt` or `CLUSTER_RESPONSE_FORMAT`.

#### 2. Stage-2 curation guidance

**File**: `src/ai/prompt.js` (`DEFAULT_CURATE_GUIDANCE`, line 81)

**Intent**: Replace with the design doc Phase 2 block — named hook archetypes
(Hot Take / Investigator / Proof Drop / Contrarian), 0–100 score bands per axis,
`trend` redefined as identity-aligned shareability, "start at the peak hook
moment," and the anti-padding line.

**Contract**: `export const DEFAULT_CURATE_GUIDANCE` unchanged in name/type;
content verbatim from `context/foundation/prompt-design.md:106-146`. English
instructions; "write reel_name and reason in Polish" directive retained. The
constraint "selection MUST include the punchline segment" and the
`markers.{hook,body,punchline}` clip_id rule are preserved (they back
`validateReels`). No schema field names change.

#### 3. Single-shot scoring guidance (EN flip)

**File**: `src/ai/prompt.js` (`DEFAULT_SCORING_GUIDANCE`, line 43)

**Intent**: Replace the current **Polish** rubric with the design doc Phase 3
block, flipping it to **English instructions + Polish-output directive** to
match cluster/curate and the [[llm-prompt-instructions-english]] lesson.

**Contract**: `export const DEFAULT_SCORING_GUIDANCE` unchanged in name/type;
content verbatim from `context/foundation/prompt-design.md:154-183`. This is the
one user-visible default-language change (settings modal "scoring guidance"
field now shows English rubric text; model output stays Polish). It still seeds
`state.systemPrompt` (`src/state.js:111`) — no wiring change.

### Success Criteria:

#### Automated Verification:

- Regression suite green: `node --experimental-vm-modules test/regression.js`
- Module imports without syntax error (constants are valid template literals)
- Prettier clean on the edited file: `npx prettier --check "src/ai/prompt.js"`

#### Manual Verification:

- Settings modal shows the three new guidance defaults (cluster/curate English,
  single-shot now English with Polish-output directive)
- A trial analysis run produces valid JSON that passes `validateReels` /
  `validateThemes` (no parse/validation regression)
- Reel `reason` / `reel_name` / theme `title` outputs are still Polish

**Implementation Note**: After Phase 1 automated verification passes, pause for
the human to confirm a trial analysis run still validates and outputs Polish
before proceeding.

---

## Phase 2: Cohort preset library

### Overview

Replace the 4 generic starters in `BUILTIN_PRESETS` with 11 presets: the 9 BRAVE
cohort presets verbatim from the design doc, plus drafted The5 and Copilot
presets.

### Changes Required:

#### 1. Replace BUILTIN_PRESETS with the 9 BRAVE cohort presets

**File**: `src/ai/prompt-presets.js` (`BUILTIN_PRESETS`, line 14)

**Intent**: Swap the 4 generic starters for the 9 BRAVE cohort presets, each
`{ id, name, userPrompt }` with the Polish `userPrompt` framing carried by the
per-cohort spine (audytorium → czego szukać → hook → długość → CTA).

**Contract**: Stable ids and names verbatim from
`context/foundation/prompt-design.md:207-295`:
`builtin-brave-ai-devs`, `builtin-brave-10xdevs`, `builtin-brave-ai-managers`,
`builtin-brave-product-heroes`, `builtin-brave-ai-marketers`,
`builtin-brave-ai-sales`, `builtin-brave-ai-hr`, `builtin-brave-ai-enterprise`,
`builtin-brave-ai-360`. `userPrompt` text verbatim Polish from the design doc.
Shape unchanged (`PromptPreset[]`).

#### 2. Add The5 preset (drafted)

**File**: `src/ai/prompt-presets.js` (`BUILTIN_PRESETS`)

**Intent**: Add a 10th preset for **The5** (Tomasz Karwatka, in collaboration
with BRAVE) with its own founder/systems spine — distinct from the AI-skills
cohorts. The reel sells *building a scalable company with systems*; the CTA
points at the book / The5 System / the movement, **not** at learning an AI tool
(per research persona card, `research.md:128-137`).

**Contract**: `{ id: 'builtin-the5', name: 'The5 (founderzy / systemy)',
userPrompt: <Polish> }`. Drafted Polish text (final wording in implementation;
this is the approved content contract):

```text
Wytnij reelsy promujące The5 — system budowania skalowalnej firmy (Tomasz Karwatka, we współpracy z BRAVE).
Audytorium: founderzy i przedsiębiorcy budujący skalowalne firmy (usługowe lub tech), 1–4 lata na rynku, przytłoczeni chaosem, którzy chcą systemów, nie motywacji.
Czego szukać: ostre prawdy o chaosie founderskim, konkretne frameworki i systemy skalowania, momenty „przestań być wąskim gardłem własnej firmy", budowanie firmy działającej bez właściciela.
Hook: mocna teza lub bolesna prawda o prowadzeniu firmy w pierwszych 3 sekundach (Hot Take / Contrarian pasują do głosu Karwatki).
Długość: 30–90 s.
CTA: zachętę do sięgnięcia po książkę „The 5." / System The5 / dołączenia do ruchu ustaw jako puentę — NIE do nauki narzędzia AI.
```

#### 3. Add Copilot underuser preset (drafted)

**File**: `src/ai/prompt-presets.js` (`BUILTIN_PRESETS`)

**Intent**: Add an 11th preset for the **Microsoft Copilot underuser** persona —
the anxious majority who already have M365 Copilot but use it shallowly. Reel
selection favors relatable underuse pain + one concrete safe win, lighter on
"become elite" (per research persona card, `research.md:151-159`).

**Contract**: `{ id: 'builtin-copilot', name: 'Copilot (niedoużywany)',
userPrompt: <Polish> }`. Drafted Polish text (content contract):

```text
Wytnij reelsy dla pracowników, którzy MAJĄ Microsoft 365 Copilot, ale używają go płytko (tylko notatki ze spotkań) i nie wiedzą, co dalej.
Audytorium: pracownicy biurowi w europejskich firmach, którym firma kupiła Copilota; sprawni w Office, ale nie entuzjaści AI; boją się zostać w tyle.
Czego szukać: momenty „używasz 5% Copilota", konkretne i bezpieczne wygrane na realnych zadaniach (Excel, PowerPoint, Outlook), proste przepisy „dla mojej roli zrób to", odpowiedzi na obawy o bezpieczeństwo danych.
Hook: kontrariańskie lub Proof-Drop otwarcie nazywające niedoużycie („Płacisz za Copilota i używasz 5%") w pierwszych 3 sekundach.
Długość: 25–70 s.
CTA: zachętę „naucz się dobrze używać Copilota" lub jeden konkretny prompt oszczędzający godzinę ustaw jako puentę. Emocja: ulga i brak zostawania w tyle, nie ambicja techniczna.
```

### Success Criteria:

#### Automated Verification:

- Regression suite green: `node --experimental-vm-modules test/regression.js`
- `BUILTIN_PRESETS` has 11 entries, all ids unique and `builtin-` prefixed
- Prettier clean: `npx prettier --check "src/ai/prompt-presets.js"`

#### Manual Verification:

- On a fresh profile (cleared `localStorage`), the picker lists all 11 presets
  with correct Polish names
- Selecting The5 and Copilot fills the textarea with the drafted Polish text
- A BRAVE-cohort preset (e.g. 10xDevs) + the new curate guidance produces a
  cohort-framed reel selection

**Implementation Note**: After Phase 2 automated verification, pause for the
human to confirm the 11 presets render and apply correctly on a fresh profile.

---

## Phase 3: One-time preset migration

### Overview

Add a flag-guarded boot migration so existing users (who hold the 4 old starters
in `localStorage`) receive the new builtins while keeping every preset they
created or edited; pristine old starters are removed.

### Changes Required:

#### 1. Retired-builtins snapshot + migration function

**File**: `src/ai/prompt-presets.js`

**Intent**: Add a frozen snapshot of the 4 retired generic starters (their
original `id` + `name` + `userPrompt`) for pristine-detection, and a
`migrateBuiltinPresets()` that runs once: remove pristine retired starters, merge
in any missing new `builtin-*` ids, preserve everything else, persist, and set a
version flag.

**Contract**: New module-level constants `RETIRED_BUILTINS` (array of the 4 old
`{id, name, userPrompt}` originals, copied from the current file before edit) and
`MIGRATION_FLAG = 'edl_presets_builtin_migration'` with a version value (e.g.
`'s26-v1'`). New exported `migrateBuiltinPresets()`:
- Early-return if `localStorage.getItem(MIGRATION_FLAG)` equals the current
  version (idempotent).
- Load current library; drop any preset whose `id` is in the retired set **and**
  whose `name` + `userPrompt` exactly equal the retired original (pristine).
  Keep all others (user-created, or edited/renamed old starters).
- Append any `BUILTIN_PRESETS` entry whose `id` is not already present.
- `savePresets(merged)`; on success set the flag to the current version.
- Wrap in try/catch (never throw on boot), mirroring `seedPresetsIfEmpty`.

#### 2. Set the flag on fresh-seed

**File**: `src/ai/prompt-presets.js` (`seedPresetsIfEmpty`, line 98)

**Intent**: When a fresh install seeds `BUILTIN_PRESETS`, also stamp the
migration flag so `migrateBuiltinPresets()` is a no-op for new users.

**Contract**: After the `savePresets(BUILTIN_PRESETS)` call inside the
first-run branch, set `localStorage.setItem(MIGRATION_FLAG, <version>)`. No
signature change.

#### 3. Wire migration into boot

**File**: `src/main.js` (lines 36-37)

**Intent**: Call the migration between seeding and loading so existing users are
upgraded before `state.promptPresets` is populated.

**Contract**: Sequence becomes `seedPresetsIfEmpty(); migrateBuiltinPresets();
state.promptPresets = loadPresets();`. Import `migrateBuiltinPresets` alongside
the existing `seedPresetsIfEmpty` / `loadPresets` imports.

### Success Criteria:

#### Automated Verification:

- Regression suite green: `node --experimental-vm-modules test/regression.js`
- Prettier clean: `npx prettier --check "src/ai/prompt-presets.js" "src/main.js"`

#### Manual Verification:

- **Existing-user upgrade**: seed `localStorage.edl_prompt_presets` with the 4
  old starters (no flag), reload → 4 pristine starters gone, 11 new builtins
  present, flag set.
- **Edited-starter preservation**: edit one old starter's text (or rename it),
  reload → that edited/renamed preset is kept, the other 3 pristine ones removed,
  11 new builtins added.
- **User-created preservation**: add a custom preset, reload → custom preset
  survives unchanged.
- **Idempotency / no-resurrect**: after migration, delete one cohort preset,
  reload → it stays deleted (flag prevents re-add).
- **Fresh install**: clear `localStorage`, reload → 11 builtins seeded, flag set,
  migration is a no-op.

**Implementation Note**: After Phase 3 automated verification, pause for the
human to walk the five migration scenarios above before closing the change.

---

## Testing Strategy

### Unit Tests:

- No new unit tests — `test/regression.js` covers parser/exporter only and is
  unaffected. Run it as a regression fence (must stay green) after every phase.

### Integration Tests:

- Manual A/B analysis run (the real quality signal): run the AI analysis on one
  real BRAVE recording with the **old** prompts (git stash / prior commit) and
  the **new** prompts, judged side-by-side on reel quality. This is the S-26
  acceptance test the automated suite cannot provide.

### Manual Testing Steps:

1. Fresh profile → confirm 11 presets seed and apply.
2. Existing-user profile (4 old starters) → confirm migration removes pristine
   starters, keeps edited/user presets, adds 11 builtins, sets flag.
3. Delete a cohort preset → reload → confirm it is not resurrected.
4. Run an analysis with a cohort preset → confirm valid JSON, Polish output,
   cohort-framed selection.
5. A/B old-vs-new prompts on a real recording → confirm equal-or-better reels.

## Performance Considerations

- The verbose curate rubric sits **after** the cacheable transcript prefix, so it
  is billed per Stage-2 bucket. The design text is intentionally tight; do not
  pad it during implementation (S-25 cost lever, roadmap S-26 Risk note).
- Migration runs once on boot, touches only `localStorage` — negligible.

## Migration Notes

- Existing users are upgraded by `migrateBuiltinPresets()` on first boot after
  the update; pristine old starters are removed, new builtins merged, user work
  preserved, guarded by `edl_presets_builtin_migration`.
- `state.userPrompt` first-run default is intentionally **not** changed (user
  decision); the default textarea text no longer matches a picker entry — known,
  accepted.

## References

- Design artifact: `context/foundation/prompt-design.md` (all guidance + 9
  cohort presets + rationale)
- Research: `context/changes/refactor-ai-prompts/research.md` (persona cards for
  The5 + Copilot, scoring/hook-archetype evidence)
- Roadmap slice: `context/foundation/roadmap.md:466-481` (S-26, the three
  Unknowns)
- Guidance constants: `src/ai/prompt.js:43,68,81`
- Preset library + seeding: `src/ai/prompt-presets.js:14,98`
- Boot wiring: `src/main.js:36-37`
- Picker render/apply: `src/ui/step2-preset-bar.js:23,57`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Per-phase guidance rewrites

#### Automated

- [x] 1.1 Regression suite green: `node --experimental-vm-modules test/regression.js` — a022cd9
- [x] 1.2 Module imports without syntax error (constants are valid template literals) — a022cd9
- [x] 1.3 Prettier clean on `src/ai/prompt.js` — a022cd9

#### Manual

- [x] 1.4 Settings modal shows the three new guidance defaults (single-shot now English/Polish-output) — a022cd9
- [x] 1.5 Trial analysis run produces valid JSON passing `validateReels` / `validateThemes` — a022cd9
- [x] 1.6 `reason` / `reel_name` / theme `title` outputs are still Polish — a022cd9

### Phase 2: Cohort preset library

#### Automated

- [x] 2.1 Regression suite green — 79c22da
- [x] 2.2 `BUILTIN_PRESETS` has 11 entries, ids unique and `builtin-` prefixed — 79c22da
- [x] 2.3 Prettier clean on `src/ai/prompt-presets.js` — 79c22da

> Deviation (user-directed): preset `userPrompt` bodies ship in **English**
> (labeled AUDIENCE → LOOK FOR → HOOK → LENGTH → CTA + a Polish-output anchor),
> not the verbatim Polish the Phase 2 block / `prompt-design.md` specified.
> Aligns with [[llm-prompt-instructions-english]]; output stays Polish; picker
> names stay Polish. See change.md Notes.

#### Manual

- [x] 2.4 Fresh profile picker lists all 11 presets with correct Polish names — 79c22da
- [x] 2.5 Selecting The5 and Copilot fills the textarea with drafted text (now English bodies) — 79c22da
- [x] 2.6 A cohort preset + new curate guidance produces a cohort-framed selection — 79c22da

### Phase 3: One-time preset migration

#### Automated

- [x] 3.1 Regression suite green — 6f83a46
- [x] 3.2 Prettier clean on `src/ai/prompt-presets.js` and `src/main.js` — 6f83a46

#### Manual

- [x] 3.3 Existing-user upgrade: pristine starters removed, 11 builtins added, flag set — 6f83a46
- [x] 3.4 Edited/renamed old starter preserved; other pristine ones removed — 6f83a46
- [x] 3.5 User-created preset survives migration unchanged — 6f83a46
- [x] 3.6 Idempotency: deleted cohort preset is not resurrected on reload — 6f83a46
- [x] 3.7 Fresh install seeds 11 builtins, sets flag, migration is a no-op — 6f83a46
