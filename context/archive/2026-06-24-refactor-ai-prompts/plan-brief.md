# Refactor AI Prompts (S-26) — Brief planu

> Pełny plan: `context/changes/refactor-ai-prompts/plan.md`
> Research: `context/changes/refactor-ai-prompts/research.md`
> Artefakt projektowy: `context/foundation/prompt-design.md`

## Co i dlaczego

Wpinamy gotowy, zaprojektowany tekst promptów z `prompt-design.md` do kodu, żeby
edytor dostawał wyraźnie lepsze reelsy. Każda z trzech faz analizy AII zyskuje
przebudowany, rubryczny prompt (score-bands, nazwane archetypy hooków,
`trend` = udostępnialność tożsamościowa, anty-padding), a cztery generyczne
presety zostają zastąpione **11 presetami** — po jednym na kohortę BRAVE plus
The5 i Copilot. Bez zmiany schematu JSON.

## Punkt wyjścia

Trzy stałe `DEFAULT_*_GUIDANCE` w `src/ai/prompt.js` (single-shot wciąż po
polsku) i cztery generyczne startery w `BUILTIN_PRESETS`
(`src/ai/prompt-presets.js`). Seeding jest tylko przy pierwszym uruchomieniu
(`seedPresetsIfEmpty`), więc istniejący użytkownicy nigdy nie zobaczą nowych
presetów bez migracji. Temperatura w `callOpenRouter` to już `0.1` (w docelowym
zakresie).

## Stan docelowy

Wszystkie trzy fazy mają nową rubrykę; single-shot przełączony na instrukcje po
angielsku z dyrektywą wyjścia po polsku (spójnie z cluster/curate). Nowy
użytkownik dostaje 11 presetów; istniejący — te same 11 wmergowane, ze
skasowaniem tylko nietkniętych starych starterów i zachowaniem wszystkiego, co
sam stworzył lub edytował. Schemat JSON, eksportery i `.reelproj` bez zmian.

## Kluczowe decyzje

| Decyzja | Wybór | Dlaczego | Źródło |
| --- | --- | --- | --- |
| Migracja presetów istniejących userów | Usuń stare buildy, zachowaj userowe | Czysta lista bez przestarzałych starterów; edytowane/zmienione zostają | Plan |
| Zakres kohort | 9 BRAVE + The5 + Copilot (11) | Pełny zestaw z designu + dwie persony z researchu | Plan |
| Język single-shot guidance | Flip na EN-instrukcje/PL-wyjście | ~30% lżejsze tokeny, spójność 3 faz ([[llm-prompt-instructions-english]]) | Frame/Design |
| Domyślny `state.userPrompt` | Bez zmian (stary sprzedazowy) | Najmniejszy diff; akceptowana drobna niespójność pickera | Plan |
| Temperatura | Bez zmian (0.1) | Już w zakresie 0–0.2 zalecanym przez research | Research |

## Zakres

**W zakresie:** 3 przepisane guidance'y; 11 presetów (9 BRAVE verbatim + draft
The5 + draft Copilot); jednorazowa migracja presetów przy starcie.

**Poza zakresem:** zmiana schematu/walidatorów; eksportery/`.reelproj`;
temperatura/per-faza; zmiana domyślnego `userPrompt`; reason-before-score,
pause-cue clustering, kalibracja rubryki, CTA-A/B (wszystko logged future);
zmiany UI preset-bara.

## Architektura / podejście

Trzy niezależnie weryfikowalne fazy, od najmniejszego ryzyka: (1) podmiana stałych
guidance w `prompt.js`; (2) podmiana `BUILTIN_PRESETS` na 11 pozycji w
`prompt-presets.js`; (3) migracja przy starcie (`prompt-presets.js` + `main.js`)
za flagą wersji, idempotentna, nie wskrzesza skasowanych presetów. Bezpieczeństwo
eksportu gwarantuje niezmienny machine-owned static block + `validateReels`/
`validateThemes`.

## Fazy w skrócie

| Faza | Co dostarcza | Główne ryzyko |
| --- | --- | --- |
| 1. Guidance | 3 przebudowane rubryki + EN-flip single-shot | Widoczna zmiana domyślnych w modalu ustawień |
| 2. Presety | 11 presetów (9 BRAVE + The5 + Copilot) | Draft The5/Copilot poza tekstem z designu |
| 3. Migracja | Jednorazowy upgrade bibliotek istniejących userów | Nie skasować/utworzyć presetów wbrew userowi |

**Prerekwizyty:** S-01, S-03, S-25 (wszystkie shipped); tekst w
`prompt-design.md` (gotowy).
**Szacowany wysiłek:** ~1 sesja, 3 fazy (głównie wklejka + jedna funkcja migracji).

## Otwarte ryzyka i założenia

- Realna weryfikacja jakości to **manualny A/B** starych vs nowych promptów na
  prawdziwym nagraniu BRAVE — suite regresyjny promptów nie testuje.
- Draft The5/Copilot to nowy tekst (nie z designu) — wymaga akceptacji wordingu
  przy implementacji; kontrakt treści jest w planie.
- Migracja „pristine" porównuje id + name + userPrompt; user, który tylko
  zmienił nazwę starego startera, zachowa go (świadome).

## Kryteria sukcesu (skrót)

- Nowy user widzi 11 presetów; istniejący — 11 wmergowane, stare nietknięte
  startery usunięte, własne/edytowane zachowane, skasowane nie wracają.
- `node --experimental-vm-modules test/regression.js` zielony przed i po.
- Manualny A/B pokazuje selekcję reelsów równą lub lepszą od starych promptów.
