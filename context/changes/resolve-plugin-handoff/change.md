---
change_id: resolve-plugin-handoff
title: Resolve plugin handoff
status: implementing
created: 2026-06-22
updated: 2026-06-26
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

- 2026-06-26: Internal research complete → `research.md`. Key finding: F-02's "6-command" bridge contract is **stale** — the live `invoke()` surface is **20 commands + 3 Tauri plugin/API families**. The scope-defining decision is whether the WhisperX sidecar (transcription) ports into the Electron panel at all.
- 2026-06-26: Plan complete → `plan.md` + `plan-brief.md` (status `planned`). Decisions: Mode B ships fully (full WhisperX port, phased last); macOS-only; signing as final phase; 6 phases (Bridge+D → C → B → A → Packaging); Mode D via `ImportTimelineFromFile`; Mode C via SRT-import; Mode A render-to-file + FFmpeg fallback; `/resolve-plugin` dir importing shared `src/`; single platform-adapter + capability check; Electron `app.getPath`/`safeStorage` fresh namespace; boot API probe → S-08 fallback; regression + manual checklist per phase.
- 2026-06-26: Plan review (`/10x-plan-review`) → verdict **REVISE**. Triaged 6 findings, all fixed in `plan.md`: **F1** (CRITICAL) Mode D pinned to **FCPXML** (0-based, carries fps+markers); **EDL excluded** — `edl.js:15` bakes the `3600*fps` offset the plan itself flags as an import-breaker. **F2** `state.fps` now seeded from the live Resolve timeline on panel open (Phase 1) + new check 1.10 — removes Mode D's dependency on the Phase-4 `probe_video_metadata` port. **F3** converted 43 phase-body Success-Criteria checkboxes → plain bullets (state lives only in `## Progress`, per 10x-implement). **F4** Mode D per-reel FCPXML generation (single-reel `reelsData` slice → one temp file each) made explicit. **F5** Mode A drops the blind FFmpeg-source fallback → manual file import + Polish notice (source ≠ timeline mix on edited timelines); `plan-brief.md` synced. **F6** Phase 4 Progress heading aligned with body. Progress mechanical contract re-verified (6/6 phases, criteria↔rows aligned, 0 stray checkboxes).
