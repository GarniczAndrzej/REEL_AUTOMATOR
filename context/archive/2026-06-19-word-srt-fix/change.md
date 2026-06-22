---
change_id: word-srt-fix
title: Fix word-by-word SRT export — diagnose and repair broken implementation
status: archived
created: 2026-06-19
updated: 2026-06-22
archived_at: 2026-06-22T08:32:09Z
---

## Notes

Poprzednie wdrożenie (word-level-srt-export, zarchiwizowane 2026-06-18) zostało oznaczone jako ukończone bez przejścia przez manualne stepy weryfikacji. Funkcja transkrypcji słowo-po-słowie nie działa.

**Sprostowanie (research 2026-06-22):** wcześniejsza notatka o „niezatwierdzonych poprawkach bugów” jest nieaktualna. Obie poprawki (end-clamp w `transcript.js`, zaostrzenie `hasFrameWords` w `export-popover.js`) zostały **zacommitowane** w `2801144` (2026-06-19) i są w HEAD. Bieżące zmiany w working-tree (`src/ai/api-key.js`, `src/ui/step2-preset-bar.js`) to **niepowiązany** reformat Prettiera — poza zakresem tej zmiany. Sam eksporter `generateWordSRT` jest poprawny i zablokowany testem regresyjnym 15; usterka leży w „glue” GUI (persystencja checkboxa, ciche ścieżki abortu eksportu, niezabezpieczony inline auto-align).
