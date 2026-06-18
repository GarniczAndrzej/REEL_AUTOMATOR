# Segment Tuning — Fix Drag-Reorder — Plan Brief

> Full plan: `context/changes/segment-tuning-ops/plan.md`

## What & Why

In the S-04 clip-tuning slice, drag-to-reorder is the only broken operation (delete and merge work). The clip-reorder code is correct — Tauri's webview is intercepting the HTML5 drag events before they reach the DOM, so the handlers never fire. We disable that interception so the existing code works.

## Starting Point

The reel editor renders `draggable="true"` clip rows with HTML5 `dragstart`/`dragover`/`drop` handlers (`step2-segment-ops.js:136–210`). The window config (`tauri.conf.json:20–26`) has no `dragDropEnabled` flag, so it defaults to `true` — and Tauri then swallows HTML5 drag events. Delete/merge use `click` and keyboard reorder uses keydown, which is why only drag is dead.

## Desired End State

Dragging a clip by its ⠿ grip reorders within a reel and moves clips across reels, exports reflect the new order, and the step-1 file-drop import still works.

## Key Decisions Made

| Decision                       | Choice                          | Why (1 sentence)                                                                 | Source |
| ------------------------------ | ------------------------------- | -------------------------------------------------------------------------------- | ------ |
| Fix strategy                   | Flip `dragDropEnabled: false`   | One-line, doc-recommended; reuses the already-correct drag code untouched.        | Plan   |
| File-drop import handling      | Verify existing HTML5 drop      | The dropzone is already HTML5; flipping the flag should enable it, not break it.  | Plan   |
| Verification                   | Manual drag-reorder test        | The drag path can only be proven in the real Tauri webview.                       | Plan   |

## Scope

**In scope:** Add `"dragDropEnabled": false` to the window config; verify clip drag-reorder and step-1 file-drop import in `tauri dev`.

**Out of scope:** Touching `moveClip`/delete/merge/keyboard logic; a Pointer-Events rewrite; migrating file import to Tauri's native `onDragDropEvent`; FR-023 fillers (dropped in S-17).

## Architecture / Approach

Single config flag. Tauri's `dragDropEnabled` defaults to `true`, which makes the native webview capture drag-drop and block HTML5 DnD on the frontend. Setting it `false` hands HTML5 drag-and-drop back to the frontend for both clip reorder (the bug) and the step-1 file-drop import (already HTML5, no native listener to lose).

## Phases at a Glance

| Phase                                   | What it delivers                              | Key risk                                              |
| --------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| 1. Enable HTML5 DnD in the webview      | `dragDropEnabled: false` + verification       | File-drop import regressing — covered by manual check |

**Prerequisites:** A Tauri dev build that runs (`npm run tauri dev`); sidecars restored per repo setup.
**Estimated effort:** ~1 short session (one config line + manual verification).

## Open Risks & Assumptions

- Assumes the step-1 HTML5 file-drop import keeps working with native interception off (expected; verified manually in Phase 1).
- Assumes WKWebView delivers HTML5 drag events once `dragDropEnabled` is false (Tauri docs state this is the supported path).

## Success Criteria (Summary)

- Clip drag-reorder works within and across reels, and exports reflect the new order.
- Step-1 file-drop import still works.
- `cargo check` and the regression suite stay green.
