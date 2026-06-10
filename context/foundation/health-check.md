---
project: reel-automator
checked_at: 2026-06-10T14:07:43Z
health_status: needs-attention
context_type: brownfield
language_family: multi
stack_assessment_available: true
checks_run:
  - lockfile
  - dependency_audit
  - outdated_deps
  - test_runner
  - ci_cd
  - configuration
audit_findings:
  critical: 0
  high: 0
  moderate: 0
  low: 0
test_runner_detected: true
ci_provider: null
recommended_fixes: 5
---

## Dependency Health

### Lockfile

```
Status: present — package-lock.json (frontend) + src-tauri/Cargo.lock (backend)
Package manager: npm (frontend) + cargo (backend)
```

Both halves of the dual-language project are pinned. Builds are reproducible on both sides.

### Security Audit

```
Tool: npm audit --json  +  cargo audit (src-tauri/Cargo.lock)
Summary: 0 CRITICAL, 0 HIGH, 0 MODERATE, 0 LOW (true vulnerabilities)
Direct vs transitive: npm — 0 across 79 deps; cargo — advisory-only warnings, all transitive
```

**npm:** clean — 0 vulnerabilities across 79 dependencies (5 prod, 75 dev, 63 optional).

**cargo:** no vulnerabilities, but ~17 `unmaintained` advisories (RUSTSEC-2024-0411…0418 and siblings) for the **gtk-rs GTK3 bindings** (`atk`, `gdk`, `gdkx11`, `gtk`, `gdk-pixbuf`, `javascriptcore-rs`, `webkit2gtk`, …). These are **Linux-only transitive dependencies** pulled in by Tauri's `wry`/`webkit2gtk` stack. This app is **macOS-only** (Linux support is an explicit PRD non-goal), so these crates are never compiled into the shipped binary. **Advisory noise, not a real exposure** — no action required, but worth a one-line note in the project so a future agent doesn't chase them.

### Outdated Dependencies

```
Packages with major version gaps: 1
```

- **vite**: 6.4.2 → 8.0.16 (2 major versions behind). **Do not blindly bump** — Tauri 2 templates pin Vite 6, and the `target`/`envPrefix` config in `vite.config.js` is tuned for the Tauri 2 toolchain. A jump to Vite 8 should be deliberate and tested against `npm run tauri dev`, not a routine update.
- Minor (non-blocking): `@tauri-apps/cli` 2.11.0 → 2.11.2, `vite` patch 6.4.2 → 6.4.3.

## Test Suite

```
Test runner: custom Node script (test/regression.js)
Tests found: 134 assertions across 7 test groups
Test execution: passing (134 passed, 0 failed)
```

```
Configuration: test/regression.js (run via `node --experimental-vm-modules test/regression.js`)
Framework: none — hand-rolled assertion script (no Vitest/Jest)
```

The suite is bespoke but **healthy and well-aimed**: it byte-compares EDL/XML/Lua exporter output against legacy reference, verifies `parseSRT` and `mergeAdjacentClips`, and exercises the `framesToTC` frame-math invariants (NDF + drop-frame, the CMX-3600 1-hour offset, negative-frame clamping). These are **exactly the PRD guardrails** that must not regress during the render-path removal (FR-038) and the schema change (FR-011/FR-012). The agent has a real, working safety net for the riskiest planned work — its only weakness is that it's a custom format an agent must imitate rather than a conventional runner (already flagged in the stack assessment).

## CI/CD

```
Provider: not detected
Configuration: not found
```

```
| Stage      | Status | Notes              |
|------------|--------|--------------------|
| Lint       | ✗      | not configured     |
| Test       | ✗      | runs locally only  |
| Build      | ✗      | not configured     |
| Type check | ✗      | not configured     |
| Security   | ✗      | not configured     |
```

ℹ No CI/CD configuration detected. You'll set this up in the infrastructure and deployment lesson — [Sprint Zero z Agentem: infrastruktura, walking skeleton i pierwszy deploy (M1L5)](https://platforma.przeprogramowani.pl/external/10xdevs-3/m1-l5). For now, the working local regression suite is what matters for agent collaboration.

## Configuration

### High severity

- **Not a git repository** — `git rev-parse` confirms there is no `.git` here. This is the single biggest agent-readiness gap: with no version control, the agent has no safe rollback when the planned **render-path removal (FR-038)** — a large multi-file deletion — goes wrong. Fix: `git init && git add -A && git commit -m "baseline before render-path removal"`.
- **`.gitignore`** — absent at root and in `src-tauri/`, while `node_modules/`, `dist/`, and `src-tauri/target/` are present on disk. Without it the first commit would swallow build artifacts. Fix: add a `.gitignore` ignoring `node_modules/`, `dist/`, `src-tauri/target/`, `.DS_Store` **before** the first `git add`.

### Medium severity

- **No formatter / linter** — no `.prettierrc`, `biome.json`, `.eslintrc`, or `eslint.config.*`. The untyped vanilla-JS frontend has nothing enforcing a consistent style, so agent-generated code will drift in formatting. Fix: `npm i -D prettier` + a minimal `.prettierrc`, or `npx @biomejs/biome init` for combined format+lint.
- **No `tsconfig.json`** — expected, since the frontend is plain JS. Not a gap to "fix" by adding TypeScript now, but it is the root of the type-safety finding in the stack assessment; the JSDoc-annotation compensation rule there is the lightweight path.

### Low severity

- **`.editorconfig`** — absent. Minor cross-editor consistency; quick to add but low impact for a single-developer project.
- **`.env.example`** — not applicable. API keys live in `localStorage` / (post-FR-035) the OS keychain, not in env files, so no env template is expected.

## Stack Assessment Cross-Reference

```
Stack assessment: context/foundation/stack-assessment.md
Agent readiness (from stack-assess): ready-with-compensation
```

| Quality Gate Gap          | Health-Check Finding                                                              | Status      |
|---------------------------|-----------------------------------------------------------------------------------|-------------|
| typed: fail (JS frontend) | No `tsconfig.json`, no formatter/linter, no type-check in CI                       | Reinforced  |
| convention_based: partial | `CLAUDE.md` present with strong conventions + invariants                           | Mitigated   |
| test runner: fail (gates) | Bespoke runner, but it **executes and passes 134/134**, covering the guardrails    | Mitigated   |
| no CI                     | Confirmed — no pipeline enforces the above gates                                   | Reinforced  |

The stack assessment's headline risk — untyped frontend at the layer the PRD changes most — is **reinforced**: nothing (no types, no linter, no CI) mechanically guards it. The recommended compensation lives in instruction-file rules; those CLAUDE.md additions from the stack assessment are **not yet applied** and are worth adding before the schema change lands. Conversely, the "bespoke test runner" gate concern is **mitigated in practice**: the suite works and covers precisely the invariants at risk.

## Recommended Fixes

### Fix before agent work (Category A)

### 1. Initialize version control

**Impact**: No git = no rollback. The agent is about to perform a large deletion (render-path removal, FR-038) plus a cross-cutting schema change; without a commit baseline, a bad agent edit is unrecoverable.
**Severity**: high
**Effort**: quick (< 5 min)
**Fix**:

```bash
# create .gitignore FIRST (see fix #2), then:
git init
git add -A
git commit -m "baseline: working app before render-path removal"
```

### 2. Add a .gitignore

**Impact**: `node_modules/`, `dist/`, and `src-tauri/target/` are on disk; a first commit without `.gitignore` bloats the repo with build artifacts the agent shouldn't touch.
**Severity**: high
**Effort**: quick (< 5 min)
**Fix**: create `.gitignore` with:

```
node_modules/
dist/
src-tauri/target/
.DS_Store
*.reelproj
```

### 3. Add a formatter (and optionally a linter)

**Impact**: the untyped JS frontend has no style enforcement; agent output will be formatted inconsistently across edits, making diffs noisy and review harder.
**Severity**: medium
**Effort**: quick (< 5 min)
**Fix**:

```bash
npx @biomejs/biome init      # format + lint in one tool, or:
npm i -D prettier && printf '{\n  "singleQuote": true\n}\n' > .prettierrc
```

### 4. Apply the stack-assessment compensation rules to CLAUDE.md

**Impact**: the untyped-frontend risk is only mitigated by documented conventions. The schema change (FR-011/FR-012) touches every LLM-JSON consumer; the "validate before use / update every consumer" rule from the stack assessment should be in place before that work starts.
**Severity**: medium
**Effort**: moderate (15–30 min)
**Fix**: paste the three instruction-file blocks from `context/foundation/stack-assessment.md` → "Recommended Instruction File Additions" into `CLAUDE.md` (type discipline, frontend state conventions, tests).

### 5. Record the cargo "unmaintained" advisories as known/accepted

**Impact**: a future agent running `cargo audit` will see ~17 RUSTSEC warnings and may waste effort "fixing" Linux GTK crates that never ship in this macOS-only app.
**Severity**: low
**Effort**: quick (< 5 min)
**Fix**: add a note to `CLAUDE.md` ("cargo audit reports unmaintained gtk-rs/GTK3 advisories — these are Linux-only transitive Tauri deps; macOS-only app, safe to ignore"), or add an `[advisories] ignore = [...]` block to `src-tauri/.cargo/audit.toml`.

### Addressed in upcoming lessons (Category B)

### No CI/CD pipeline

**Lesson**: [Sprint Zero z Agentem: infrastruktura, walking skeleton i pierwszy deploy (M1L5)](https://platforma.przeprogramowani.pl/external/10xdevs-3/m1-l5)
**What you'll do there**: stand up a pipeline that runs the regression suite (and ideally `cargo check` + a formatter check) on every change, mechanically enforcing the gates that are currently local-only.

### No AGENTS.md (agent instruction file)

**Lesson**: [Agent Onboarding: Agents.md, AI Rules i feedback loops (M1L4)](https://platforma.przeprogramowani.pl/external/10xdevs-3/m1-l4)
**What you'll do there**: build the agent instruction file with the right content. `CLAUDE.md` already exists and is strong; onboarding covers how to extend/structure it deliberately rather than stubbing one now.

## Summary

```
Health status: needs-attention
```

The dependency picture is clean (zero real vulnerabilities, both lockfiles present) and the bespoke regression suite **passes 134/134 covering exactly the frame-math and exporter invariants the upcoming work must protect** — a genuine safety net. The reason this is `needs-attention` rather than `healthy` is operational, not dependency-related: **the project is not under version control**, so the large render-path deletion ahead has no rollback, and there's no formatter or type enforcement guarding the untyped frontend the PRD changes most. None of these are hard to fix.

Next step: knock out the five Category A fixes — git init + `.gitignore` first (5 minutes, biggest payoff), then a formatter and the CLAUDE.md compensation rules — then proceed to agent onboarding.
