# Ocenione zaznaczenie AI → czysty eksport EDL (S-01) — Brief planu

> Pełny plan: `context/changes/scored-selection-edl/plan.md`

## Co i dlaczego

S-01 to ★ slice „north star" — dowód wedge'a end-to-end: z transkrypcji
powstają reele ocenione przez AI (`virality_score` 0–100 + cztery osie
Hook/Flow/Value/Trend + jednozdaniowy `reason` + znaczniki
`hook`/`body`/`punchline`), które eksportują się do czystego CMX3600 `.edl`
importującego się do NLE ze znacznikami jako prawdziwe markery osi czasu. Żaden
MP4 nie jest renderowany. Slice otwiera prep-refaktor **R1** (rozbicie
1279-liniowego `src/ui/step2-analyze.js`), bo to odblokowuje Wave 2.

## Punkt wyjścia

Schemat LLM zwraca dziś tylko `{ reel_name, clip_ids }` (`src/ai/prompt.js`).
`step2-analyze.js` to monolit ze współdzielonym stanem (undo, drag/trim/focus,
preview); jedyna zewnętrzna powierzchnia to `init`/`undo`/`redo`
(`src/main.js`). Walidacja jest szczątkowa — `clip_ids` nieistniejące w
transkrypcji trafiają do eksportera. Test regresji wymusza EDL **bajt-w-bajt
identyczny** z legacy. R2 (`getApiKey/setApiKey`) już wszedł.

## Stan docelowy

Uruchomienie zaznaczenia AI daje reele z widoczną odznaką `virality_score` i
`reason` w karcie reela. Niepoprawny JSON nigdy nie dociera do eksportera —
edytor dostaje czytelny polski komunikat z zachowanym surowym tekstem do
poprawki (FR-018). Eksport EDL zawiera linie `* LOC` dla hook/body/punchline
importujące się jako markery; punchline zawsze w zaznaczeniu. Starsze projekty
bez ocen ładują się i pokazują `brak oceny`. Regresja zielona.

## Kluczowe decyzje

| Decyzja | Wybór | Dlaczego | Źródło |
| --- | --- | --- | --- |
| Model znaczników | Referencje `clip_id` (`markers.{hook,body,punchline}`) | Nie wypadną poza zbiór segmentów, trywialna walidacja, czyste mapowanie na record-frame | Plan |
| Format markerów w EDL | Linie `* LOC` (locator) | Standard CMX3600 importowany jako prawdziwe markery; emitowane tylko gdy obecne → byte-identical legacy zachowany | Plan |
| Sekwencja R1 | Najpierw R1, własna faza + commit | Refaktor bez zmiany zachowania, odwracalny; zgodny ze streams.md „opening move" | Plan |
| Kształt oceny | `virality_score` + 4 osie `scores.{hook,flow,value,trend}` + `reason` | Pełna transparentność triażu; osie nazewniczo oddzielone od `markers` | Plan |
| Walidacja (FR-018) | Ścisła na kształcie, łagodna na nowych polach | Blokuje śmieci przed eksporterem, toleruje modele pomijające oceny → `brak oceny` | Plan |
| Model Claude | Bump do `claude-opus-4-8` | Najnowszy Opus dla zadania, które JEST produktem | Plan |
| Prompt-caching | `cache_control` na statycznym prefiksie (system+segmenty) | Realne oszczędności tokenów w pętli iteracji; uzupełnia disk-cache | Plan |
| Powtarzalność | `temperature: 0.1` dla wszystkich 3 providerów | Ten sam transkrypt → niemal identyczne reele (FR-014) | Plan |
| Zakres markerów | Tylko EDL (`edl.js`) | Zgodne z footprintem streams.md; xml/lua to S-08 | Plan |
| UI oceny w S-01 | Minimalna odznaka read-only + reason | Edytor widzi ocenę dla dowodu wedge'a; sort/grey to S-02 (FR-020) | Plan |
| Kompatybilność wsteczna | Tolerancja, bez bumpu schematu, `brak oceny` | Pola opcjonalne additive; FR-033 + byte-identical zachowane | Plan |

## Zakres

**W zakresie:** R1 (rozbicie step2 na `step2-reel-list.js` /
`step2-prompt-panel.js` / `step2-segment-ops.js` + cienki orchestrator);
ocenowy schemat LLM + guidance promptu; bump modelu + temp 0.1 +
Claude prompt-caching; współdzielony `validateReels` na wszystkich 4 ścieżkach
wejścia; minimalna odznaka score + reason; markery `* LOC` w EDL; przypadki
regresji.

**Poza zakresem:** markery w XML/Lua (S-08); lista-z-sortowaniem/wyszarzaniem
(S-02); presety promptu (S-03); reorder/filler (S-04); preview rework (S-15);
keychain (S-11); bump schematu `.reelproj`; jakakolwiek zmiana zachowania w
fazie 1.

## Architektura / podejście

Cztery fazy, każda własny commit, bramkowane regresją. Faza 1 (R1) to refaktor
bez zmiany zachowania, wykonany i zweryfikowany w izolacji — jego jedyna realna
bramka (ręczny smoke step 2) nie jest splątana z pracą feature'ową. Fazy 2–4
budują ocenę na rozbiciu: schemat/providery (kontrakt) → walidacja + UI
(bezpieczna konsumpcja) → markery EDL (eksport). Obowiązuje reguła CLAUDE.md
„zmiana schematu → zaktualizuj KAŻDEGO konsumenta + zgrepuj nazwę pola".

## Fazy w skrócie

| Faza | Co dostarcza | Główne ryzyko |
| --- | --- | --- |
| 1. R1 split | 3 moduły per-surface + cienki orchestrator, bez zmiany zachowania | Brak automatycznego pokrycia UI — bramką jest ręczny smoke |
| 2. Schemat + providery | Ocenowy schemat LLM, model 4-8, temp 0.1, Claude cache | Fan-out schematu na wszystkich konsumentów; kolejność prefiksu cache |
| 3. Walidacja + UI | `validateReels` na 4 ścieżkach, odznaka score + reason | Pominięcie ścieżki wejścia; zbyt ostra/luźna walidacja |
| 4. Markery EDL | Linie `* LOC` mapowane na record-frame, warunkowo | Złamanie byte-identical; błędne mapowanie record-frame |

**Warunki wstępne:** F-01 (done), R2 (done). Worktree `reel-wt-selection` na
`stream/scored-selection-edl`.
**Szacowany nakład:** ~4 sesje (po jednej na fazę), fazy 2–3 najgęstsze.

## Otwarte ryzyka i założenia

- R1 nie ma testów UI — regresja chroni tylko parser/eksportery. Ręczny smoke
  step 2 jest faktyczną bramką; commituj R1 osobno, by był odwracalny.
- Konwencje koloru/nazwy markerów `* LOC` różnią się nieco per NLE — wymaga
  ręcznego sprawdzenia importu (Resolve/Premiere).
- Modele LLM bywają niespójne w zwracaniu nowych pól — walidacja degraduje
  łagodnie (`brak oceny`) zamiast odrzucać cały wynik.

## Kryteria sukcesu (skrót)

- Zaznaczenie AI daje reele z widocznym `virality_score` + `reason`; powtórny
  przebieg jest niemal identyczny.
- Niepoprawny JSON nigdy nie dociera do eksportera — czytelny błąd + zachowany
  surowy tekst.
- `.edl` importuje się do NLE z markerami hook/body/punchline w poprawnych
  miejscach; punchline zawsze w zaznaczeniu; projekty bez markerów eksportują
  się bajt-w-bajt jak wcześniej.
