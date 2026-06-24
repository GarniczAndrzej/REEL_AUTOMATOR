# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## plan-brief.md zawsze po polsku

- **Context**: Każde generowanie/aktualizacja pliku plan-brief.md (np. w ramach /10x-plan i pokrewnych).
- **Problem**: plan-brief.md bywa generowany po angielsku, niespójnie z polskojęzycznym projektem i resztą dokumentów.
- **Rule**: plan-brief.md zawsze generuj po polsku; identyfikatory techniczne (FR/US/Change ID, nazwy plików) zostaw w oryginale.
- **Applies to**: plan, plan-review

## Never bake multi-GB assets into a PyInstaller onefile binary

- **Context**: Packaging a bundled CLI sidecar/externalBin (PyInstaller onefile, Tauri `externalBin`) that needs large data assets — ML model weights, datasets — especially on macOS.
- **Problem**: Baking a multi-GB asset into a PyInstaller onefile produces a multi-GB Mach-O that macOS 26 dyld refuses to load (`dyld: syscall to map cache into shared region failed`, aborts before `main`). The WhisperX sidecar's baked 2.4 GB `pl` alignment model made a 2.6 GB binary that wouldn't start; a 283 MB model-free build ran fine (fixed in commit a31fdbf).
- **Rule**: Never bake multi-GB data into a PyInstaller onefile executable. Ship large assets BESIDE the binary (e.g. Tauri `bundle.resources`) and pass their path in at runtime (e.g. `--align-model-dir`). Keep the executable small and loadable.
- **Applies to**: plan, plan-review, implement, impl-review

## Synchronous JS dialogs crash Tauri's macOS WKWebView

- **Context**: Any frontend save-as / rename / delete / confirm flow in the Tauri app that reaches for native browser dialogs (`window.prompt`, `window.confirm`, `window.alert`).
- **Problem**: Synchronous JS dialogs hard-crash Tauri's macOS WKWebView. S-03 planned native `window.prompt`/`window.confirm` for preset save-as/rename/delete; they crashed the window, forcing an in-app overlay modal (`promptNative`/`openModal`) + the async Tauri `ask()` plugin for delete, and `alert()`→`toast()` swaps in step2-prompt-panel.js / save-file.js.
- **Rule**: Never use synchronous `window.prompt/confirm/alert` in the Tauri webview. Use an in-app overlay modal for text input/confirmation, the async `@tauri-apps/plugin-dialog` `ask()`/`message()` for native prompts, and `toast()` for notifications. Keep all user-facing strings Polish.
- **Applies to**: plan, plan-review, implement, impl-review

## Incidental Prettier churn must not ride into a feature commit

- **Context**: Committing a phase of an in-scope change when unrelated files (e.g. `src/ai/api-key.js`, `src/ui/step2-preset-bar.js`) carry pre-existing Prettier reformatting in the working tree.
- **Problem**: Phase 1 commit `ee34f17` swept in two Prettier-only files that the plan's "What We're NOT Doing" explicitly told to leave untouched. The diffs were harmless, but the commit then contradicted its own plan's scope guardrail.
- **Rule**: Commit only files in the change's scope. If incidental formatting/churn is in the working tree, either stage it in a separate prep commit BEFORE the feature work, or leave it unstaged — never fold it into a feature/phase commit. If the user explicitly asks to include it, say so in the commit body AND update the plan's "NOT doing" list so the record stays consistent.
- **Applies to**: implement, impl-review

## Changing DEFAULT_*_GUIDANCE text breaks regression marker assertions

- **Context**: Editing the per-phase guidance constants in `src/ai/prompt.js` (`DEFAULT_SCORING_GUIDANCE`, `DEFAULT_CLUSTER_GUIDANCE`, `DEFAULT_CURATE_GUIDANCE`) — wording, language flip, or restructuring.
- **Problem**: The regression suite is widely assumed to be prompt-agnostic (it "only covers parser/exporter"), but `test/regression.js` hard-codes string markers from the guidance defaults (e.g. it asserted on the Polish `'ZASADY OCENY'`). S-26's EN-flip of `DEFAULT_SCORING_GUIDANCE` silently staled those assertions; the suite would fail until the marker was updated to a phrase unique to the new block (`'find every Reel worth cutting'`).
- **Rule**: When you change any `DEFAULT_*_GUIDANCE` text, grep `test/regression.js` for the old marker string and update both the "omits guidance" negative assertion and the "exported default" positive assertion to a phrase unique to the new text. Run `node --experimental-vm-modules test/regression.js` to confirm green.
- **Applies to**: implement, impl-review
