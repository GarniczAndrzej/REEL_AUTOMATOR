# Segment Tuning — Fix Drag-Reorder Implementation Plan

## Overview

In the `segment-tuning-ops` slice (S-04: reorder / merge / delete clips), only **drag-to-reorder** is broken. Delete and merge work. The clip-reorder code is correct; the problem is that Tauri's webview intercepts HTML5 drag-and-drop events before they reach the DOM, so the existing `dragstart`/`dragover`/`drop` handlers never fire. The fix is to disable that native interception via the window's `dragDropEnabled` flag.

## Current State Analysis

The three clip operations split by event mechanism:

- **Delete** — delegated `click` on `.clip-del-btn` (`src/ui/step2-segment-ops.js:123–127`). Works.
- **Merge** — delegated `click` on `.clip-merge-btn` (`src/ui/step2-segment-ops.js:130–134`). Works.
- **Reorder** — two paths, both routing through the (correct) `moveClip()` mutation:
  - Primary: **HTML5 drag-and-drop** on `draggable="true"` clip rows (`src/ui/step2-segment-ops.js:136–210`; rows rendered at `src/ui/step2-reel-list.js:143–151`). **Broken.**
  - Fallback: Arrow ↑/↓ keyboard shortcuts on a focused clip (`src/ui/step2-segment-ops.js:225–263`). Logic-correct, but not the affordance users reach for (the ⠿ grip).

Root cause (confirmed against current Tauri 2 docs): the window config at `src-tauri/tauri.conf.json:20–26` declares **no `dragDropEnabled` flag**, so it defaults to `true`. Per Tauri 2: *"The `dragDropEnabled` option controls whether drag and drop functionality is enabled on the webview, and it is enabled by default. Disabling this option is necessary… to utilize HTML5 drag and drop features on the frontend."* With it enabled, the native webview swallows the HTML5 drag events the clip-reorder code depends on.

There are **zero** `onDragDropEvent` (Tauri-native) listeners anywhere in `src/`. The step-1 file-drop import (`src/ui/import/segments.js:40–55`) is itself pure HTML5 (`drop` + `e.dataTransfer.files`), so it is governed by the same flag rather than by Tauri's native overlay.

### Key Discoveries:

- `moveClip()` (`src/ui/step2-segment-ops.js:72–88`) is correct for both same-reel and cross-reel moves — no logic change needed.
- The broken layer is purely the **event delivery**, gated by one config flag.
- Flipping the flag to `false` hands HTML5 drag-and-drop to the frontend for *both* clip reorder and the step-1 file-drop import — neither path has a Tauri-native listener to lose.

## Desired End State

Dragging a clip row by its ⠿ grip reorders clips within a reel and moves clips across reels, the change is reflected in `state.reelsData[*].clip_ids` and downstream exports, and the step-1 file-drop import (drag an `.srt`/`.vtt`/video onto the dropzone) still works. Verified by manual drag testing in `npm run tauri dev`.

## What We're NOT Doing

- Not touching `moveClip()`, `removeClip()`, `mergeWithNext()`, or the keyboard reorder logic — they are correct.
- Not rewriting reorder onto Pointer Events (the config flip makes the existing HTML5 code work).
- Not migrating the step-1 file-drop import onto Tauri's native `onDragDropEvent` — the existing HTML5 dropzone is expected to keep working with the flag off; we only verify it.
- Not revisiting FR-023 filler removal (dropped in S-17 per roadmap).

## Implementation Approach

Single, minimal change: add `"dragDropEnabled": false` to the window object in `src-tauri/tauri.conf.json`, then verify in `tauri dev` that (a) clip drag-reorder works within and across reels and (b) the step-1 file-drop import still works. The frontend drag code is already in place and correct; this change only unblocks event delivery to it.

## Phase 1: Enable HTML5 drag-and-drop in the webview

### Overview

Disable Tauri's native drag-drop interception so the existing clip-reorder HTML5 handlers receive `dragstart`/`dragover`/`drop`, then confirm no regression to file-drop import.

### Changes Required:

#### 1. Tauri window config

**File**: `src-tauri/tauri.conf.json`

**Intent**: Stop the native webview from swallowing HTML5 drag-and-drop events so the frontend clip-reorder handlers fire. This is the doc-recommended way to use HTML5 DnD in a Tauri frontend.

**Contract**: Add `"dragDropEnabled": false` to the single window object in `app.windows[0]` (currently holding `title` / `width` / `height` at lines 20–26). No other config keys change.

### Success Criteria:

#### Automated Verification:

- Config parses / Rust side compiles: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite stays green (export pipeline `moveClip` feeds is untouched): `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- In `npm run tauri dev`: drag a clip by its ⠿ grip to a new position **within** a reel — order updates and persists.
- Drag a clip **across** reels — it moves to the target reel at the drop position.
- A quick-export (EDL) reflects the new clip order.
- Step-1 file-drop import still works: drag an `.srt`/`.vtt` (and a video) onto the dropzone and confirm it loads.
- Keyboard reorder (Arrow ↑/↓ on a focused clip) still works as the fallback.

**Implementation Note**: After the config change and automated checks pass, pause for manual confirmation that drag-reorder and file-drop import both work in `tauri dev` before considering the slice done. The drag and file-drop paths can only be proven in the real Tauri webview, not the regression runner.

---

## Testing Strategy

### Automated:

- `cargo check` confirms the config is valid and the app still builds.
- `node --experimental-vm-modules test/regression.js` confirms the parser/exporter pipeline (the consumer of `clip_ids`) is unaffected.

### Manual Testing Steps:

1. `npm run tauri dev`.
2. Import an SRT/video and run analysis so reels with multiple clips exist.
3. Drag a clip within a reel by the ⠿ grip; confirm reorder.
4. Drag a clip onto another reel's clip list; confirm cross-reel move.
5. Export EDL; confirm clip order matches the UI.
6. Drag an `.srt`/`.vtt` file onto the step-1 dropzone; confirm import still works.
7. Focus a clip and press Arrow ↑/↓; confirm keyboard reorder still works.

## Migration Notes

None — single config flag, no data or schema change. Reversible by removing the flag (reverts to `true` default).

## References

- Root-cause config: `src-tauri/tauri.conf.json:20–26`
- Reorder handlers: `src/ui/step2-segment-ops.js:136–210` (drag), `:225–263` (keyboard)
- Clip row rendering (`draggable="true"`): `src/ui/step2-reel-list.js:143–151`
- File-drop import (HTML5, same flag): `src/ui/import/segments.js:40–55`
- Tauri 2 `dragDropEnabled` docs: https://v2.tauri.app/reference/config

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Enable HTML5 drag-and-drop in the webview

#### Automated

- [x] 1.1 `cargo check` passes with the new config — bf1e935
- [x] 1.2 Regression suite green (`node --experimental-vm-modules test/regression.js`) — bf1e935

#### Manual

- [x] 1.3 Drag-reorder within a reel works in `tauri dev`
- [x] 1.4 Drag clip across reels works
- [x] 1.5 Exported EDL reflects new clip order
- [x] 1.6 Step-1 file-drop import still works
- [x] 1.7 Keyboard Arrow ↑/↓ reorder still works
