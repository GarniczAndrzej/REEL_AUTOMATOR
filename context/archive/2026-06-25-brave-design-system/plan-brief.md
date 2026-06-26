# System projektowy BRAVE — Plan Brief

> Pełny plan: `context/changes/brave-design-system/plan.md`

## Co i dlaczego

Przeskórowanie aplikacji Reels EDL Automator do języka wizualnego **BRAVE**
(`DesignNotes/design-system.md`): niemal-monochromatyczna tożsamość na ciepłej,
prawie-czarnej kanwie (`#141313`), miękka biel złamana `#DDDDDD` dla tekstu, **DM Sans**
jako jedyny krój UI, **białe/jasne** (zamiast fioletowych) stany interakcji, oraz
**logo BRAVE** (inline SVG w białym kaflu) zastępujące tekstowe logo
`▶ Reels EDL Automator`. Cel: spójna marka BRAVE we wszystkich powierzchniach aplikacji.

## Punkt wyjścia

Aplikacja używa dziś *innego* języka: fioletowy akcent (`--accent: #7c6dfa`), bardziej
niebieska czerń (`--bg: #0d0d10`) i **dwa kroje** — `Syne` (nagłówki) oraz `DM Mono`
jako podstawowy krój tekstu. Cały system żyje w `src/styles.css` (1663 linie, **381
użyć `var(--…)`**), z resztkami koloru poza tokenami: rysowanie na canvas
(`timeline.js`, `waveform.js`), baner błędu w `main.js`, surowe literały hex/rgba w CSS
oraz style inline w `index.html` i ~11 plikach JS.

## Stan docelowy

Aplikacja renderuje się w całości w języku BRAVE: ciepła prawie-czarna kanwa, tekst
`#DDDDDD`, DM Sans w UI z monospace zachowanym tylko na powierzchniach technicznych
(EDL/XML/Lua/timecode), białe/jasne stany interakcji **bez fioletu** (CSS, canvas,
inline), kolory funkcyjne BRAVE wyłącznie dla feedbacku stanu, oraz logo BRAVE w białym
kaflu w nagłówku. Całe copy pozostaje po polsku. Suite regresji pozostaje zielony.

## Kluczowe decyzje

| Decyzja                 | Wybór                                            | Dlaczego (1 zdanie)                                                              | Źródło |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- | ------ |
| Strategia tokenów       | Remap wartości, zachowaj nazwy                   | Zamienia zmianę w 381 miejscach na pojedynczą edycję `:root`; minimalny churn    | Plan   |
| Kroje pisma             | DM Sans + zachowany token `--code` (DM Mono)     | Marka w UI, a kolumny timecode/EDL/XML/Lua pozostają wyrównane (monospace)        | Plan   |
| Akcent                  | Biały / jasny                                     | Zgodne z monochromatyczną zasadą i wzorcem przycisku „DOŁĄCZ DO NAS"             | Plan   |
| Logo                    | Inline SVG (`DesignNotes/BRAVE-LOGO.svg`, samo-ramkujący) | Ostre w każdym rozmiarze; SVG sam jest białym kaflem z czarnym napisem — bez dodatkowego kafla | Plan   |
| Motyw puzzle-block      | Odroczony — tylko token `--block`                 | Skupia zmianę na palecie/typografii/logo; motyw jako follow-up                  | Plan   |
| Kolory funkcyjne        | Przyjęcie hexów BRAVE (`#4ADE80/#FBBF24/#F87171`) | Zgodność ze specyfikacją; konsolidacja banera błędu + statusów                  | Plan   |

## Zakres

**W zakresie:** `:root` w `styles.css` + wszystkie komponenty, style inline w
`index.html` i plikach JS, rysowanie canvas (timeline/waveform), baner błędu, logo,
kroje pisma — pełne, spójne przełączenie.

**Poza zakresem:** zmiana nazw tokenów na słownik `--color-*`; implementacja tła
puzzle-block (tylko token); usunięcie monospace; logika parsera/eksporterów/frame-math;
zmiany copy (poza usunięciem tekstowego logo); incydentalne reformatowanie Prettier.

## Architektura / podejście

Token **remap (zachowane nazwy)** sprawia, że zmiana palety i typografii kaskaduje z
jednej edycji `:root` przez wszystkie 381 stokenizowanych miejsc. Pozostała praca to
wymiacenie nie-stokenizowanych wycieków koloru/kroju (surowe literały w CSS, canvas,
baner błędu, inline JS/HTML) i podmiana logo. Trzy fazy, każda osobno weryfikowalna.

## Fazy w skrócie

| Faza                         | Co dostarcza                                                     | Główne ryzyko                                          |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| 1. Fundament tokenów i kroju | Przepisany `:root` + `@import` → BRAVE kaskaduje przez całe UI   | Token `--mono` to dziś krój body — wymaga nowego `--code` |
| 2. Wymiecenie wycieków       | Brak fioletu w CSS/canvas/JS; powierzchnie kodu na `--code`      | Rozproszone literały poza tokenami; trzeba je wszystkie znaleźć |
| 3. Logo BRAVE                | Tekstowe logo → inline, samo-ramkujący SVG                       | Dobór wysokości/clear-space w nagłówku |

**Prerekwizyty:** brak — SVG logo dostarczony (`DesignNotes/BRAVE-LOGO.svg`).
**Szacowany wysiłek:** ~1–2 sesje, 3 fazy; weryfikacja głównie manualna/wizualna.

## Otwarte ryzyka i założenia

- Brak automatycznego strażnika CSS — regresje wizualne wykrywane manualnie; suite
  regresji pilnuje tylko logiki parsera/eksporterów.
- Kolory canvas to literały `fillStyle` (nie czytają zmiennych CSS) — muszą być ręcznie
  zsynchronizowane z paletą tokenów.
- Logo dostarczone (`DesignNotes/BRAVE-LOGO.svg`) i samo-ramkujące (białe pudełko +
  czarny napis) — wstawiamy inline, bez dodatkowego kafla.
- Style inline w plikach JS: większość używa już tokenów lub tylko `font-size` — trzeba
  potwierdzić, że żaden nie wprowadza twardego koloru.

## Kryteria sukcesu (skrót)

- Aplikacja renderuje się w pełni monochromatycznie w BRAVE — zero fioletu w CSS,
  canvas i stylach inline.
- DM Sans w całym UI; monospace tylko na powierzchniach technicznych (EDL/XML/Lua/timecode).
- Logo BRAVE w białym kaflu w nagłówku; `node --experimental-vm-modules test/regression.js` zielony.
