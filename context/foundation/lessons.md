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
