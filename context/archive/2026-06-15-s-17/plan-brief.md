# S-17 Feature Pruning & Cleanup Pass — Brief planu

> Pełny plan: `context/changes/s-17/plan.md`
> Research: `context/changes/s-17/research.md`

## Co i dlaczego

Cykliczny przebieg odchudzający kod produkcyjny oraz zaplanowany backlog. Usuwa martwy ogon po usunięciu ścieżki renderu z F-01, de-duplikuje pętlę silnika whisper, **wycofuje dostawców AI Gemini i Claude na rzecz wyłącznie OpenRouter** (decyzja właściciela), kasuje funkcję filler-words (zgodnie z re-scope S-04), poprawia merytorycznie błędne fragmenty CLAUDE.md oraz parkuje/re-scope'uje slice'y backlogu — utrzymując kod aplikacji jednego właściciela szczupłym, a dokumenty agent-spec zgodne z rzeczywistością.

## Punkt wyjścia

F-01 usunęło ścieżkę renderu, ale zostawiło sześć osieroconych komend Tauri; pętla silnika w `whisper.rs` jest zduplikowana między `transcribe_video` a `align_transcript`; warstwa AI ma trzech dostawców (Gemini/Claude/OpenRouter) z dwoma niejednolitymi, zduplikowanymi blokami dispatchu; funkcja filler-words to tylko podgląd przekreślenia (`fillers.js` + `renderClipText`) — logika usuwania z S-04 nigdy nie powstała; zalega kilka martwych symboli oraz bajtowo identyczny duplikat HTML w katalogu głównym; a CLAUDE.md opisuje nieistniejące `whisper-cli`, usuniętą funkcję i błędną nazwę modelu.

## Pożądany stan końcowy

Martwy ogon komend, martwe symbole, funkcja filler-words i duplikat HTML w katalogu głównym znikają; pętla silnika whisper ma jedno źródło prawdy (`drive_engine`); warstwa AI jest wyłącznie OpenRouter (kod Gemini/Claude oraz selektor dostawcy `<select>` usunięte, picker modeli OpenRouter zachowany); menedżer modeli zyskuje działającą kontrolkę usuwania; CLAUDE.md odpowiada kodowi; `roadmap.md` odzwierciedla zaparkowane/re-scope'owane slice'y; a nadpisany folder `s-04` zostaje skasowany (właściciel re-planuje). Suita regresji + `cargo check` zielone; UI bez zmian poza usuniętym przekreśleniem filler, usuniętym selektorem dostawcy oraz nową kontrolką usuwania modelu.

## Podjęte decyzje

| Decyzja | Wybór | Dlaczego (1 zdanie) | Źródło |
| --- | --- | --- | --- |
| Podział step1-import.js | Odłożyć do S-16 | S-16 przepisuje całą powłokę kroku; podział teraz byłby wyrzucony. | Plan |
| Picker OpenRouter | Zostawić bez zmian | Właściciel chce zachować odkrywanie modeli w aplikacji. | Plan |
| Dostawcy AI | Tylko OpenRouter (usunąć Gemini + Claude) | Decyzja właściciela; usunięcie zamiast de-duplikacji blokiem dispatchu. | Właściciel |
| Pętla silnika whisper | Wyodrębnić `drive_engine` | Usuwa ~45 zduplikowanych linii Rust; logika anulowania w jednym miejscu. | Plan |
| `delete_model` | Podłączyć kontrolkę usuwania | Dokończenie zarejestrowanej, ale nieużywanej komendy; odzysk miejsca. | Plan |
| Funkcja filler | Usunąć całkowicie | Re-scope S-04 rezygnuje z usuwania filler; kod produkcyjny to tylko podgląd. | Plan |
| Backlog | Odrzucić S-06 + S-14, uprościć S-13 | Szczupły zakres aplikacji jednego właściciela; north-star osiągalny bez nich. | Plan |
| S-04 | Skasować folder, re-scope w roadmapie | Usuwanie filler odrzucone, operacje segmentów do ponownego zaplanowania. | Plan |
| Komendy render | Bezpieczne do usunięcia | `load_project` jest schema-agnostic; czytają osobne pliki. | Research |

## Zakres

**W zakresie:** usunięcie 6 komend render-* + `sanitize_name`; wyodrębnienie `drive_engine`; usunięcie `whisperModelPath`; skasowanie `fillers.js` + przekreślenia; usunięcie dostawców Gemini/Claude (skasowanie `models.js`, `buildClaudeContent`, selektora dostawcy) na rzecz wyłącznie OpenRouter; podłączenie UI `delete_model`; un-export ~11 helperów; usunięcie głównego `ReelAutomatorAI.html`; poprawa CLAUDE.md; aktualizacja roadmapy (park S-06/S-14, uproszczenie S-13, re-scope S-04); skasowanie `context/changes/s-04/`.

**Poza zakresem:** podział `step1-import.js` (→ S-16); picker OpenRouter (zostaje); przebudowa operacji segmentów (→ przyszłe S-04); uproszczenie S-03; jakakolwiek zmiana eksportera/parsera/frame-math/schematu `.reelproj`.

## Architektura / podejście

Trzymamy się przepisu usuwania z F-01 — najpierw grep wszystkich konsumentów, ogrodzenie regresją przed i po, stringi po polsku, poprawa dokumentów w tej samej zmianie. Trzy niezależne fazy w kolejności backend → frontend → docs/backlog, każda za zielonym checkiem. Fazy 1–2 to kod (`cargo check` + regresja + manualne UI); Faza 3 to dokumentacja/porządki.

## Fazy w skrócie

| Faza | Co dostarcza | Kluczowe ryzyko |
| --- | --- | --- |
| 1. Backend Rust de-bloat | Usunięcie komend render + helper `drive_engine` | `drive_engine` musi zachować semantykę cancel/kill |
| 2. Frontend de-bloat + usunięcie filler | Usunięcie martwych symboli/filler, OpenRouter-only, UI usuwania modelu, usunięcie głównego HTML | Fallback bez `words` w `renderClipText` + ścieżki OpenRouter muszą przetrwać; A/B compare staje się model-vs-model na OpenRouter |
| 3. Docs + porządki backlogu | Poprawki CLAUDE.md, park/re-scope roadmapy, kasacja s-04 | Wewnętrzna spójność roadmapy po odrzuceniu slice'ów |

**Wymagania wstępne:** brak (de-bloat bez zależności). Suita regresji zielona na starcie.
**Szacowany wysiłek:** ~1–2 sesje na 3 fazy.

## Otwarte ryzyka i założenia

- Wyodrębnienie `drive_engine` dotyka gorącej ścieżki transkrypcji — anulowanie trzeba zweryfikować manualnie (brak osieroconego procesu potomnego).
- Usunięcie przekreślenia filler to celowa, widoczna dla użytkownika zmiana w liście reeli kroku 2.
- Usunięcie Gemini/Claude degeneruje porównanie A/B z provider-vs-provider do model-vs-model na OpenRouter — akceptowalne (wejścia `compareModelA/B` różnicują).
- Zakłada brak innego konsumenta komend render, dostawców czy `fillers.js` poza zweryfikowanymi grepem.

## Kryteria sukcesu (skrót)

- Cały zweryfikowany grepem martwy kod usunięty; `cargo check` + suita regresji zielone; brak zalegających referencji; brak symboli Gemini/Claude w `src`.
- Analiza AI (OpenRouter, single + A/B compare), transkrypcja/alignment oraz usuwanie modelu działają; krok 2 renderuje bez przekreślenia.
- CLAUDE.md i roadmap.md wiernie odzwierciedlają kod i backlog; folder `s-04` zniknął.
