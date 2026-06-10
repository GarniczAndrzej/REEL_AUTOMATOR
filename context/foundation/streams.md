---
project: Reels Automator
version: 1
status: draft
created: 2026-06-10
updated: 2026-06-10
source: context/foundation/roadmap.md (v1)
purpose: worktree parallelization plan — which slices can be built simultaneously in separate git worktrees
---

# Streams: parallel worktree plan

> Companion to `roadmap.md`. The roadmap orders slices by **dependency**.
> This file orders them by **file-disjointness** — what can actually be built
> side-by-side in separate worktrees without colliding on merge.
>
> **Two slices are worktree-safe together only when both are true:**
> 1. Neither is a prerequisite of the other (dependency-safe — from the roadmap).
> 2. They do not edit the same files (footprint-safe — from this doc).
>
> The roadmap's "Streams" table satisfies (1). It does **not** satisfy (2):
> five slices (S-01, S-02, S-03, S-04, S-14) all rewrite the same 1408-line
> `src/ui/step2-analyze.js`. Dependency-parallel ≠ worktree-parallel.

## Repo state (2026-06-10)

- Git repo present, single branch `master` @ `dc538d1`, no worktrees yet.
- Baseline commit `0a728e2` = working app *before* render-path removal.
- Only automated guard is `node --experimental-vm-modules test/regression.js`
  (parser + EDL/XML/Lua exporters). Every wave below ends by running it.

## File footprint per slice

Primary = the slice owns/creates these. **Shared hot file** = edited by 2+ slices;
these are the merge-conflict surfaces.

| Slice | Primary files (owned) | Shared hot files it touches |
| ----- | --------------------- | --------------------------- |
| **F-01** remove-render | `src/render/*` (delete), `src-tauri/src/rendering.rs` + `face_detect.rs` (delete), `tauri.conf.json` | `src-tauri/src/lib.rs`, `src/ui/step3-export.js`, `src/main.js`, `src/state.js`, `test/regression.js` |
| **F-02** resolve-spike | *(no code — writes a decision doc)* | — |
| **S-01** scored-selection-edl | `src/ai/prompt.js`, `src/ai/providers.js`, `src/ai/models.js`, `src/exporters/edl.js` | `src/ui/step2-analyze.js`, `src/state.js`, `test/regression.js` |
| **S-02** reel-list-ui | `src/styles.css` (list) | `src/ui/step2-analyze.js` |
| **S-03** prompt-presets | `src/ai/presets.js` (new), preset file IO in `src-tauri` | `src/ai/prompt.js`, `src/ui/step2-analyze.js`, `src/state.js` |
| **S-04** segment-tuning | `src/parser/segments.js`, `src/render/fillers.js`† | `src/ui/step2-analyze.js`, `src/state.js`, `test/regression.js` |
| **S-05** whisperx | `src-tauri/src/whisper.rs`, `src/ui/step1-import.js`, segmentation module | `src-tauri/src/lib.rs`, `tauri.conf.json`, `src/state.js` |
| **S-06** word-trim | word-timestamp consumer, snap heuristic | `src/ui/step2-analyze.js`, `src/state.js` |
| **S-07** auto-mode | staged-progress orchestrator | `src/main.js`, `src/ui/step1-import.js`, `src/ui/step2-analyze.js`, `src/ui/step3-export.js` |
| **S-08** export-set | `src/exporters/xml.js`, `src/exporters/lua.js`, `src/exporters/fcpxml.js` (new) | `src/ui/step3-export.js`, `test/regression.js` |
| **S-09** resolve-plugin | plugin runtime / panel host | `src/ui/step3-export.js` (fallback wiring) |
| **S-10** i18n | `src/i18n/*` (new keys) | **every `src/ui/*` file + `src/main.js`** |
| **S-11** keychain | `src-tauri` keychain module, `src/ai/openrouter-picker.js` | `src/ai/providers.js`, `src/main.js`, `src/ui/step1-import.js`, `src/ui/step2-analyze.js`, `src-tauri/src/lib.rs` |
| **S-12** error-states | — | `src/ui/step1-import.js`, `src/ui/step2-analyze.js`, `src/ui/step3-export.js` |
| **S-13** keyboard | keymap module | `src/main.js`, `src/ui/step2-analyze.js` |
| **S-14** quality-flags | dangling-ref post-pass module | `src/ai/prompt.js`, `src/ui/step2-analyze.js` |
| **S-15** preview | preview/playback module | `src/ui/step2-analyze.js` |

† `src/render/fillers.js` is selection-side logic (Polish filler sets), not render
logic. **F-01 must keep it** (relocate to `src/parser/fillers.js` or `src/selection/`)
because S-04 depends on it. Flag this explicitly in the F-01 plan.

## Hot-file contention map

The files that decide what can run in parallel:

| Hot file | Slices that edit it | Consequence |
| -------- | ------------------- | ----------- |
| `src/ui/step2-analyze.js` (1408 LoC) | S-01, S-02, S-03, S-04, S-06, S-07, S-11, S-12, S-13, S-14, S-15 | **The bottleneck.** Almost everything frontend funnels here. Must be split (see Prep R1) or these slices serialize. |
| `src/state.js` (68 LoC) | F-01, S-01, S-03, S-04, S-05, S-06 | Low-severity: edits are *additive* typedefs/fields in different regions. Land S-01 first, rebase the rest. |
| `src/ai/prompt.js` (85 LoC) | S-01, S-03, S-14 | S-01 sets the schema; S-03 un-hardcodes it; S-14 adds rules. Serialize: S-01 → S-03 → S-14. |
| `src-tauri/src/lib.rs` | F-01, S-05, S-11 | Command registration list. F-01 removes 4; S-05/S-11 add. F-01 lands first → others rebase cleanly. |
| `test/regression.js` | F-01, S-01, S-04, S-08 | Append-only test cases; conflicts are trivial textual appends. |
| `src/ui/step3-export.js` (1229 LoC) | F-01, S-07, S-08, S-09, S-12 | F-01 strips the render tab first; S-08 then owns it. |
| `src/main.js` | F-01, S-07, S-11, S-13 | Step routing + key reads. |
| key-read sites (`edl_apikey`) | S-11 vs S-01/S-02 | 4 files read it today; see Prep R2. |

## Prep refactors that unlock parallelism

Do these **inside the slice that lands first**, not as standalone changes — they
convert the two worst contention surfaces into owned files.

- **R1 — split `step2-analyze.js`** (do it as the opening move of S-01).
  Carve the 1408-line file into: `step2-reel-list.js` (→ S-02), `step2-prompt-panel.js`
  (→ S-03), `step2-segment-ops.js` (→ S-04), leaving `step2-analyze.js` as the thin
  orchestrator. After this, S-02/S-03/S-04/S-14/S-15 each own a different file and
  become true worktree partners instead of serial.
- **R2 — `getApiKey()/setApiKey()` abstraction** (do it as the opening move of S-11,
  *before* S-01 if possible). Replace the 4 direct `localStorage.edl_apikey_*` reads
  with one helper. Then S-11 swaps the helper's backing store (keychain) without
  touching providers/step1/step2, and stops conflicting with S-01.

## Parallel waves

Each wave = a set of worktrees safe to run concurrently. Merge a wave, run the
regression suite, then open the next. "⇒ merge order" resolves the additive
shared-file edits (state.js, prompt.js, lib.rs).

### Wave 0 — foundations (2 worktrees)
| Worktree | Slice | Why safe in parallel |
| --- | --- | --- |
| `wt-remove-render` | **F-01** | Solo builder of the render surface. |
| `wt-resolve-spike` | **F-02** | Research only — writes a doc, zero code overlap. |

F-01 is the **only** thing touching `src/render/*`, `rendering.rs`, `face_detect.rs`,
the render tab, and the `lib.rs` handler list. Nothing else may run while it does —
it would collide on lib.rs, step3, state.js, main.js. Land F-01 → regression green → Wave 1.
*(S-11's R2 helper can also be slipped in here, since it's prerequisite-free and only
helps later waves.)*

### Wave 1 — the two engines + hardening (3 worktrees)
After F-01 merges.
| Worktree | Slice | Footprint | Overlap watch |
| --- | --- | --- | --- |
| `wt-selection` | **S-01** (incl. R1 split) | `src/ai/*`, `edl.js`, splits `step2-*` | `state.js`, `regression.js` |
| `wt-whisperx` | **S-05** | `whisper.rs`, `step1-import.js`, `lib.rs`, `tauri.conf` | `state.js` |
| `wt-keychain` | **S-11** (incl. R2) | keychain module, `openrouter-picker.js` | `lib.rs`, key-read sites |

S-01 = frontend AI + exporter; S-05 = Rust backend + step1; S-11 = credentials.
Mostly disjoint. Only shared files are **additive**: `state.js` (S-01/S-05/S-11),
`lib.rs` (S-05/S-11). **⇒ merge order: S-01 → S-05 → S-11**, rebasing each on the
prior. Doing R1 inside S-01 and R2 inside S-11 is what makes Wave 2 wide.

### Wave 2 — selection surfaces + exports (up to 5 worktrees, *requires R1*)
After S-01 merges. Without R1 these serialize on `step2-analyze.js`; with R1 each owns a file.
| Worktree | Slice | Owned file (post-R1) |
| --- | --- | --- |
| `wt-reel-list` | **S-02** | `step2-reel-list.js` |
| `wt-prompt-presets` | **S-03** | `step2-prompt-panel.js` + `prompt.js`¹ |
| `wt-segment-ops` | **S-04** | `step2-segment-ops.js` + `segments.js` |
| `wt-export-set` | **S-08** | `exporters/*` + `step3-export.js` (fully disjoint from step2 — safest partner) |
| `wt-quality-flags` | **S-14** | post-pass module + `prompt.js`¹ |

¹ S-03 and S-14 both touch `prompt.js`. **⇒ merge order within wave: S-03 → S-14**
(or run S-14 in Wave 3). S-08 touches neither step2 nor prompt.js — it is the
cleanest parallel slice in the whole project and can start the moment S-01 lands.

### Wave 3 — transcription-dependent + auto + states (after S-04 & S-05)
| Worktree | Slice | Prereqs met by | Overlap watch |
| --- | --- | --- | --- |
| `wt-word-trim` | **S-06** | S-04 + S-05 | `step2-segment-ops.js` |
| `wt-auto-mode` | **S-07** | S-01 + S-05 | `main.js`, all steps — keep thin (orchestration only) |
| `wt-error-states` | **S-12** | S-01 + S-05 | all steps — thin consolidation pass |
| `wt-preview` | **S-15** | S-04 | own preview module |

S-07 and S-12 both span all three step files; if both run, **⇒ merge S-12 → S-07**
(error states first, then auto-mode wires through them). S-06 and S-15 own modules → free.

### Wave 4 — cross-cutting + blocked (mostly serial)
| Worktree | Slice | Note |
| --- | --- | --- |
| `wt-keyboard` | **S-13** | needs S-02 + S-04; `main.js` + step2 keymap |
| `wt-resolve-plugin` | **S-09** | **blocked** until F-02 returns "viable"; else parks to S-08 fallback |
| `wt-i18n` | **S-10** | **run alone.** Touches every UI file — string extraction must be the *last* UI-wide pass so strings are extracted once. Do not worktree-parallel S-10 with anything that edits `src/ui/*`. |

## Worktree commands

```bash
# from the main checkout (master). One worktree + branch per slice:
git worktree add ../reel-wt-selection    -b stream/scored-selection-edl
git worktree add ../reel-wt-whisperx     -b stream/builtin-whisperx-transcription
git worktree add ../reel-wt-keychain     -b stream/keychain-credentials

# each worktree is a full independent checkout — run dev/tests inside it:
cd ../reel-wt-selection && npm run tauri dev
node --experimental-vm-modules test/regression.js   # before AND after each slice

# integrate a finished stream:
cd <main checkout>
git merge --no-ff stream/scored-selection-edl
node --experimental-vm-modules test/regression.js   # gate before opening next wave

# clean up:
git worktree remove ../reel-wt-selection
```

Branch naming mirrors the roadmap **Change ID** (`stream/<change-id>`) so a worktree
maps 1:1 to a `/10x-plan <change-id>` unit.

## Rules of thumb

1. **One slice = one worktree = one branch = one Change ID.** Don't bundle.
2. **Run regression before and after** every slice (the only fence; F-01 and S-08
   are the high-risk deletions/format changes the PRD calls out).
3. **Additive shared files** (`state.js`, `lib.rs`, `regression.js`) → resolve by
   merge order, not by avoidance; conflicts are trivial.
4. **Structural shared files** (`step2-analyze.js`, `prompt.js`) → the slice that
   lands first does the split/abstraction (R1/R2) so later slices own files.
5. **S-10 (i18n) and F-01 (render removal) are never co-parallel with UI work** —
   they touch everything; give each its own quiet window.
```
