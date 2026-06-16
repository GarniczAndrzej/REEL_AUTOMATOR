# Redesign UI/UX — prostszy, odchudzony flow (S-16) — Brief planu

> Pełny plan: `context/changes/s-16/plan.md`
> Research: `context/changes/s-16/research.md`

## Co i po co

Przepisujemy trzykrokowy kreator `goStep(n)` (`import → analiza → eksport`) w **jedną ciągłą powierzchnię roboczą**, gdzie import/transkrypcja, przegląd ocenionych reelsów + strojenie segmentów oraz eksport czytają się jako jedno zadanie, a nie trzy osobne ekrany. Konfiguracja aplikacji (klucz API, model, przerwa scalania) trafia do **okna ustawień**, eksport staje się **popoverem szybkiego eksportu**, a ustawienia projektu auto-wypełniają się z dodanego wideo. To czysty rewrite prezentacji/orkiestracji — bez zmian w eksporterach i matematyce klatek, wszystkie napisy po polsku.

## Punkt wyjścia

`goStep(n)` (`main.js:8-14`) to 7 linii bez żadnego bramkowania — wszystkie trzy panele są zawsze w DOM, nawigacja jest asymetryczna, a wejście do pustego eksportu kończy się `alert()`em. `step1-import.js` to monolit 1122 linii (S-17 odłożył jego podział tu). Stan zawiera duplikaty (`videoFilename` vs `videoFilename2`, globalny vs per-reel próg scalania). Warstwa wizualna jest czysta i oparta o tokeny; ~80 linii martwego CSS render-queue i pozostałości S-17 (modal porównania, przycisk cache AI) wciąż żyją w kodzie.

## Stan docelowy

Edytor otwiera jedną powierzchnię: dodaje wideo (i opcjonalnie `.srt`), ustawienia projektu auto-wypełniają się, transkrypcja startuje gdy brak SRT. Sekcja przeglądu odsłania się wraz z danymi; lista reelsów pokazuje kompaktowe oceny Hook/Flow/Value/Trend bez osi czasu i odtwarzania w liście. Eksport idzie przez popover (EDL/XML/Lua z przodu; SRT/VTT/`.md`/kopiuj-prompt pod „więcej”). Klucz API, model i przerwa scalania żyją w oknie ustawień; przerwa scalania utrwala się między sesjami. Powiadomienia informacyjne to toasty; tylko akcje destrukcyjne nadal używają natywnego `confirm()`.

## Kluczowe decyzje

| Decyzja | Wybór | Dlaczego | Źródło |
| --- | --- | --- | --- |
| Model układu | Progresywny pojedynczy panel (sekcje odsłaniają się ze stanu) | Realizuje „jeden flow” przy najmniejszym ryzyku rewrite'u | Plan |
| Elementy nakładające się na inne slice'y (#8/#6/#14) | Zbuduj „domy”, użyj istniejącego | S-16 pozostaje czystym rewrite'em prezentacji; brak podwójnej pracy | Plan |
| Okno ustawień | Modal (wzorzec `.modal-overlay`) | Zero nowych prymitywów layoutu, spójne z obecnymi modalami | Plan |
| Utrwalanie przerwy scalania | Worek ustawień w `localStorage` | Wzorzec `edl_whisper_advanced` już istnieje | Plan |
| Zestaw eksportu | EDL/XML/Lua + rozwijane „więcej” | Progresywne ujawnianie w popoverze | Plan |
| Lista reelsów | Usuń odtwarzanie + oś czasu, pokaż oceny składowe | Duża wygrana deklatteru; `Reel.scores` już w schemacie | Plan |
| Konsolidacja stanu | Skonsoliduj teraz, tolerancyjny load (schema v5) | Usuwa źródło duplikacji, nie tylko jej UI | Plan |
| Feedback | Lekki toast; `confirm()` zostaje dla destrukcyjnych | Usuwa blokujące dialogi psujące „czysty flow” | Plan |
| Diaryzacja | Do modala zaawansowanego WhisperX | Funkcja rzadka i data-only — poza głównym flow | Plan |
| Fazowanie | Fundament → shell → sekcje → polish | Ryzykowne zmiany stanu lądują pierwsze za testami round-trip | Plan |

## Zakres

**W zakresie:** jednolita powierzchnia + bramkowanie sekcji, okno ustawień, popover eksportu, auto-wypełnianie ustawień projektu, deklatter listy reelsów, podział `step1-import.js`, konsolidacja stanu (schema v5), helper toast, usunięcie martwego CSS i pozostałości S-17, regularizacja odstępów/skali.

**Poza zakresem:** zmiany w eksporterach/matematyce klatek; pełen zakres S-08/S-04/S-02; kolejka transkrypcji + pliki audio (#13); tryb jasny / pełny reskin; „naprawianie” zachowań celowych (etykiety mówców data-only, save zawsze pyta o lokalizację); własny modal confirm.

## Architektura / podejście

Bottom-up, od najmniejszego ryzyka. Faza 1 ląduje ryzykowną plumbing stanu/schematu + prymitywy współdzielone (worek ustawień, toast) za testem round-trip oraz wszystkie czyste usunięcia. Faza 2 zastępuje `goStep` kontrolerem progresywnej powierzchni sterowanym stanem (`emit()`) + modal ustawień. Faza 3 przenosi kontrolki każdej sekcji w nowy shell, dzieląc `step1-import.js` wzorcem `step2-*` (orkiestrator + submoduły). Faza 4 to regularizacja wizualna + pełny pas akceptacyjny.

## Fazy w skrócie

| Faza | Co dostarcza | Główne ryzyko |
| --- | --- | --- |
| 1. Fundament | Konsolidacja stanu (v5), worek ustawień, toast, usunięcie martwego kodu/pozostałości S-17 | Tolerancyjny load starych `.reelproj`; ogon plumbing stanu |
| 2. Shell + bramkowanie | Progresywna powierzchnia zamiast `goStep`, modal ustawień | Powierzchnia wygląda na pół-zmigrowaną między P2 a P3 |
| 3. Przeniesienie sekcji | Podział step1, auto-wypełnianie, deklatter listy, popover eksportu | Brak siatki regresyjnej UI; zachowanie hooków canvas |
| 4. Restyle + akceptacja | Regularizacja odstępów/skali, pełna lista akceptacyjna | Ręczna weryfikacja to jedyny strażnik UI |

**Prerequisites:** brak (slice prereq-free; ma wylądować przed S-13 klawiatura).
**Szacowany wysiłek:** ~4 sesje, po jednej na fazę (Faza 3 najcięższa — podział monolitu + wszystkie deklattery).

## Otwarte ryzyka i założenia

- Pozostałości S-17 (#9) NIE były usunięte — S-16 musi je usunąć (research się mylił; potwierdzone gripem).
- Brak automatycznej regresji UI — `regression.js` chroni tylko parser/eksportery; reszta to ręczna akceptacja.
- Usunięcie osi czasu per-reel (#14) nie może zabrać hooków waveform-trim (`.clip-waveform`/`data-sentence-id` zostają).
- CLAUDE.md mówi schema v3, writer jest na v4 → bump do v5; dokument poprawiany w Fazie 4.

## Kryteria sukcesu (skrót)

- Pełna ścieżka happy path działa na jednej powierzchni: wideo (± SRT) → analiza → eksport każdego formatu.
- Round-trip save/load (w tym stary plik v3/v4) i utrwalanie ustawień między restartami.
- Czysty, ciągły flow bez martwych kontrolek; wszystkie napisy po polsku; brak blokujących dialogów informacyjnych.
