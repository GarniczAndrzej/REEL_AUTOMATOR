# S-08 Timeline Export Set — Plan Brief

> Full plan: `context/changes/timeline-export-set/plan.md`
> Research: `context/changes/timeline-export-set/research.md`

## What & Why

Bring the timeline-export set to parity on hook/body/punchline markers and add a net-new FCPXML exporter (PRD FR-027/028/029, roadmap S-08). Today only EDL emits markers; the XML and Lua exporters already receive `reel.markers` but ignore it, and Final Cut Pro X (`.fcpxml`) isn't supported at all. Editors should be able to export to Premiere (xmeml), Final Cut (FCPXML), and DaVinci Resolve (Lua) and see their AI-detected markers in every NLE.

## Starting Point

Four-format export popover (EDL/XML/Lua + transcript extras). EDL is the reference marker implementation (`* LOC:` locators gated on `reel.markers`, record-frame math via `recordFrameById`). XML/Lua are pure `(opts)→string` functions that already get `reel.markers` for free but emit nothing. Regression suite is at 206 passed / 0 failed; Test 13 is the EDL-marker reference case.

## Desired End State

XML emits sequence-level `<marker>` (Green/Blue/Red), Lua emits `timeline:AddMarker(...)`, and a new `generateFCPXML` produces a valid FCPXML 1.9 document with clip-local `<marker value>` markers — all gated on `reel.markers` so marker-free output stays byte-identical to today. A fourth "FCPXML" row appears in the export popover. The regression fence gains one marker case per format.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| FCPXML vs reuse xmeml | Separate pure exporter | Different DTD, rational-time model, EMPTY `<marker>` grammar | Research |
| FCPXML version floor | 1.9 (FCP 10.4.9+) | Widest safe floor; no newer features needed | Research |
| xmeml marker placement | Sequence-level `<marker>` | Cleanest parallel to EDL record-frame locators; survives in timeline view | Plan |
| Lua marker colors | Green / Blue / Red | Valid Resolve palette names mirroring EDL; zero remap across formats | Plan |
| Marker label source | One shared canonical constant | Single source of truth for HOOK/BODY/PUNCHLINE across 4 formats; colors stay format-local | Plan |
| Marker note text | Label only, no text note | Matches EDL behavior; smaller diff; avoids per-format truncation decisions | Plan |
| Scope/phasing | All four, phased in one change | Completes S-08 parity; phases isolate cheap markers from net-new format | Plan |

## Scope

**In scope:** XML markers, Lua markers, shared label constant, net-new FCPXML exporter + UI/state wiring, regression cases per format.

**Out of scope:** S-09 plugin; marker text notes; emitting scores/reason; changing EDL; FCPXML inter-reel gaps; FCPXML 1.10+ features; new test framework.

## Architecture / Approach

Exporters stay pure `(opts)→string`; all `state` access remains in the `gen*()` wrappers in `export-popover.js`. Phase 1 adds a shared `markers.js` label constant and emits markers into the two existing exporters (per-format record-frame math, no shared frame helper — each cursor scheme differs). Phase 2 adds `fcpxml.js` (rational time, shared `<asset>`, one project/sequence per reel, clip-local source-frame markers) plus additive UI: `FORMATS.fcpxml`, `state.fcpxmlContent`, a new HTML row, and a `videoPath` guard like Lua. Phase 3 extends `test/regression.js`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Shared labels + XML/Lua markers | Markers in `.xml` and `.lua`, gated | Per-format record-frame math misplacing markers; perturbing Test 4/5 baselines |
| 2. FCPXML exporter + wiring | New `.fcpxml` format end-to-end | Rational-time correctness; absolute `file://` path requirement |
| 3. Regression cases | One marker case per format | Marker-free byte-identical guards must hold |

**Prerequisites:** None — additive to existing exporters; research already mapped the full FCPXML grammar.
**Estimated effort:** ~2–3 sessions across 3 phases.

## Open Risks & Assumptions

- xmeml `<marker>` import reliability varies across Premiere/Resolve (the xmeml structure is flagged fragile) — manual import test is the gate.
- FCPXML rational-time must keep integer numerators; a stray decimal divide misplaces clips. Regression range-asserts guard it.
- FCPXML requires `state.videoPath` (absolute `file://`); without it the format is unavailable (toast), same as Lua.

## Success Criteria (Summary)

- A marked reel exported to `.xml` / `.lua` / `.fcpxml` shows three correctly-placed HOOK/BODY/PUNCHLINE markers in its target NLE.
- Marker-free exports are byte-identical (XML) / functionally identical (Lua) to pre-change output.
- `node --experimental-vm-modules test/regression.js` passes with the new per-format marker cases.
