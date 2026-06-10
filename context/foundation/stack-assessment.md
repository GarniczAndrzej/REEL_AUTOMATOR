---
project: reel-automator
assessed_at: 2026-06-10T14:07:43Z
agent_readiness: ready-with-compensation
context_type: brownfield
stack_components:
  language: JavaScript (frontend) + Rust 2021 (backend)
  framework: Tauri 2
  build_tool: Vite 6 (frontend) + Cargo (backend)
  test_runner: custom Node script (test/regression.js)
  package_manager: npm
  ci_provider: null
  deployment_target: Tauri desktop bundle (externalBin FFmpeg sidecar)
gates_passed: 6
gates_failed: 3
---

## Stack Components

This is a **dual-language desktop app**, so the stack splits cleanly into two halves with very different agent-readiness profiles.

- **Frontend language — JavaScript (vanilla ES modules).** `package.json` declares `"type": "module"` with no `tsconfig.json` anywhere in the tree and no `@types/*` or TypeScript dev dependency. The UI is hand-rolled vanilla JS (no React/Vue/Svelte) over a single mutable `state` object with a minimal `emit()`/`subscribe()` pub-sub (per `CLAUDE.md`). No `.eslintrc`, `.prettierrc`, or `.editorconfig` present.
- **Backend language — Rust (edition 2021, `rust-version = 1.77.2`).** `src-tauri/Cargo.toml` pins `tauri 2`, `serde`/`serde_json`, `sha2`, `tokio`. Typed by the language; serde gives schema'd (de)serialization for the `.reelproj` contract.
- **Framework — Tauri 2.** Desktop shell bridging the JS frontend and Rust commands (`run_render`, `transcribe_video`, `save_project`, …) registered in `lib.rs`. Frontend itself has **no application framework** — routing/state/components are bespoke.
- **Build tool — Vite 6** (`vite.config.js`, `root: 'src'`, output to `../dist`) for the frontend; **Cargo** for the Rust backend.
- **Test runner — none formal.** A single bespoke script `test/regression.js` run via `node --experimental-vm-modules`, covering parser + exporter correctness. No Vitest/Jest, no `cargo test` suites detected.
- **Package manager — npm** (`package-lock.json`).
- **CI/CD — none.** No `.github/workflows/`, GitLab, CircleCI, or Jenkins config.
- **Deployment — Tauri bundle.** Native desktop binary with an architecture-suffixed FFmpeg sidecar via `bundle.externalBin`. No Docker/cloud target (by design — this is a local-first desktop tool per the PRD).
- **Instruction files — `CLAUDE.md` only** (exceptionally detailed: architecture map, command table, render-pipeline spec, and a "Key invariants" section). No `AGENTS.md`, no `.cursor/rules`.

## Quality Gate Assessment

| Component            | Typed | Convention | Training Data | Documented | Verdict           |
|----------------------|-------|------------|---------------|------------|-------------------|
| Language — JS (FE)   | ✗     | —          | —             | —          | fail              |
| Language — Rust (BE) | ✓     | —          | —             | —          | pass              |
| Framework — Tauri 2  | —     | ✓          | ✓             | ✓          | pass              |
| Frontend (vanilla JS)| —     | ~          | ✓             | ✓          | pass-with-note    |
| Build — Vite / Cargo | —     | ✓          | ✓             | ✓          | pass              |
| Test runner (custom) | —     | ✗          | ✗             | ✗          | fail              |

Legend: ✓ = pass, ✗ = fail, ~ = partial, — = not applicable

**Tally:** 6 gate-passes, 3 gate-failures. All three failures sit on the **frontend / tooling** half; the Rust + Tauri + build-tool half passes cleanly.

### Gate Details

**Type safety**
- *Rust backend — pass.* Typed by the language; `serde` derive on the `.reelproj` schema (v2) means the agent reads input/output shapes from the source.
- *JS frontend — fail.* No `tsconfig.json`, no TypeScript dependency, no JSDoc `@typedef` discipline. The agent cannot reason about the shapes of `state`, `sentences[]`, `reelsData`, or the LLM JSON contract from the source alone — it has to infer them from usage. This matters acutely for the PRD's planned schema change (FR-011/FR-012 add `virality_score` + `hook/body/punchline` markers), which `CLAUDE.md` notes "requires updating every consumer."

**Convention-based**
- *Tauri / Vite / Cargo — pass.* Tauri ships strong conventions (commands registered in `lib.rs`, `tauri.conf.json`, `src-tauri/` layout); Vite and Cargo are convention-driven.
- *Vanilla-JS frontend — partial.* The framework itself imposes no layout, but the project documents its own conventions thoroughly in `CLAUDE.md` (the `src/ui/stepN-*.js` pipeline, pure exporters in `src/exporters/`, the `state` + `emit()` rule, the integer-frame invariant). This is exactly the compensation path: the convention lives in the instruction file rather than the framework. Scored pass-with-note because the documentation is real and current — but it is one file's discipline away from drift.

**Popular in training data** (assessed per language family)
- *Rust desktop — pass.* Tauri is the mainstream Rust desktop framework. (Note: Tauri **2** is recent — APIs in training data may lag the v2 plugin model.)
- *JS — pass.* Vanilla JS + Vite are maximally represented in training data.

**Well-documented**
- *Tauri 2, Vite 6 — pass.* Both have current, versioned official docs.
- *Rust crates — pass.* `serde`, `tokio` have canonical docs.

**Test runner — fail (all three applicable gates).** `test/regression.js` is a bespoke script: it follows no test-runner convention (no `describe`/`it`, no standard reporter), it is not a pattern present in training data (the agent can't pattern-match a known runner's idioms), and it is not externally documented. An agent asked to add coverage has nothing to imitate and may invent a divergent structure each time.

## Gaps & Compensation

### 1. Untyped JS frontend (type-safety gate)

**Why it matters for agents:** the riskiest edits in the PRD scope touch the LLM JSON contract (`src/ai/prompt.js`, `src/ai/providers.js`) and the timeline/segment data passed between parser, exporters, and the Rust `Span` struct. Without types, an agent changing the schema (adding `virality_score`/markers per FR-011/FR-012, or word-level boundary fields for FR-021) can silently break a consumer the source doesn't advertise.

**Compensation:** declare a type-annotation + boundary-validation convention in the instruction file, and validate the LLM response shape before use (already a PRD requirement — FR-018). See ready-to-paste rules below.

### 2. No frontend framework / convention lives only in CLAUDE.md (convention gate)

**Why it matters for agents:** vanilla JS means there is no framework to fall back on for "where does this go." The single `state` + `emit()` model is easy to violate (a mutation without `emit()`, a component reaching into another's DOM). The convention is real but undocumented-in-code.

**Compensation:** keep the existing `CLAUDE.md` conventions, and make the two most violable rules explicit and enforceable (the `emit()`-after-mutation rule; the pure-exporter rule). See below.

### 3. Bespoke test runner, no CI (test gate)

**Why it matters for agents:** the PRD's guardrails ("existing exporters still import cleanly," "integer-frame math holds," "`.reelproj` still loads") are exactly what regression tests should protect during the render-path removal (FR-038) — a large deletion. An agent needs to know the suite exists, how to run it, and that it must be extended when exporters/parser change.

**Compensation:** document the test command and a "extend regression when you touch parser/exporters" rule in the instruction file. See below.

### Recommended Instruction File Additions

Paste these into `CLAUDE.md` (or a new `AGENTS.md`):

```markdown
## Type discipline (frontend is untyped JS — compensate explicitly)

- All new frontend functions must carry JSDoc type annotations at their boundaries,
  e.g. `/** @param {Sentence[]} sentences @returns {string} */`. Define shared shapes
  (`Sentence`, `Reel`, `RenderConfig`) once as `@typedef` blocks in `src/state.js` and
  reference them by name.
- Validate every LLM response against the expected schema BEFORE use. Parse the JSON,
  then check required fields (`clip_ids`, `reel_name`, `virality_score`, `hook/body/punchline`)
  and types; on mismatch, surface the retry / manual-paste-and-fix path (FR-018) — never
  feed an unvalidated object into the export pipeline.
- When you change the LLM schema in `src/ai/prompt.js`, update EVERY consumer in the same
  change: `src/ai/providers.js`, the step-2 reel editor, and every exporter that reads the
  new field. Grep for the field name before considering the change complete.
```

```markdown
## Frontend state & module conventions (no framework — these ARE the rules)

- State is the single mutable object in `src/state.js`. After ANY mutation, call `emit()` —
  components are not reactive and will not see the change otherwise.
- Components read `state` directly; they must NOT mutate another component's DOM. UI lives
  under `src/ui/stepN-*.js`, one file per pipeline step.
- Exporters in `src/exporters/` are PURE functions of (`sentences`, `reelsData`) → string.
  No DOM access, no `state` import, no I/O. Keep them pure so regression tests stay simple.
- Timeline math is integer-frame only: seconds → `Math.round(s * fps)` → frames. Never round
  to seconds mid-pipeline. EDL record TC keeps the CMX-3600 1-hour offset (`3600 * fps`).
```

```markdown
## Tests (bespoke runner — no CI gate exists)

- Run the regression suite with: `node --experimental-vm-modules test/regression.js`.
  It covers SRT parsing + exporter (EDL / XML / Lua) correctness.
- This suite is the only automated guard. Run it before considering any change to
  `src/parser/`, `src/exporters/`, or the frame-math invariants complete.
- When you change parser or exporter behavior, ADD a regression case in the same change —
  follow the existing structure in `test/regression.js`; do not invent a new test framework.
- High-risk now: the render-path removal (FR-038) is a large deletion. Run the suite before
  and after to prove the selection → segment → export pipeline still works (PRD guardrail).
```

## Summary

**Overall readiness: ready-with-compensation.**

The stack is a tale of two halves. The **Rust + Tauri + Vite/Cargo backend and tooling pass all four agent-friendly criteria cleanly** — typed by the language, convention-driven, mainstream within their ecosystems, and well-documented. The **vanilla-JS frontend carries all three gaps**: it is untyped, framework-less (convention lives only in `CLAUDE.md`), and guarded by a single bespoke test script with no CI.

Crucially, none of these gaps call for replacing anything — and `CLAUDE.md` is already an unusually strong compensation document (architecture map, command table, and a "Key invariants" section most projects lack). The three instruction-file blocks above harden the two rules most likely to be violated during the planned work: the **schema change** (FR-011/FR-012 adding `virality_score` + markers, which touches every consumer) and the **render-path removal** (FR-038, a large deletion the regression suite must fence). Add those, and the agent has legible rules where the framework gives it none.

**Key strengths:** typed, convention-rich, well-documented Rust backend; exceptional existing `CLAUDE.md`; pure exporters that are easy to test.
**Key gaps:** untyped frontend at exactly the layer the PRD changes most; one bespoke test script and no CI to fence high-risk deletions.

**Recommended next step:** `/10x-health-check` — to audit dependencies, confirm the regression suite actually covers the guardrail invariants, and surface the missing-CI risk before the render-path removal lands.
