# Testy manualne — Scored AI selection → EDL (S-01)

Checklista ręcznych testów dla zmiany `scored-selection-edl`. Testy automatyczne
(regresja, `cargo check`, Prettier, walidator) przeszły — poniższe pozycje
wymagają **uruchomionej aplikacji, kluczy API i NLE**, więc trzeba je wykonać
ręcznie przed uznaniem slice'a za gotowy.

Uruchomienie aplikacji:

```bash
npm run tauri dev
```

Legenda: `[ ]` do sprawdzenia · `[x]` zaliczone.

---

## Faza 1 — R1: podział `step2-analyze.js` (bez zmiany zachowania)

> Cel: po podziale monolitu na moduły wszystko w Kroku 2 działa **identycznie**
> jak wcześniej. To czysty refaktor — żadnych nowych funkcji.

- [x] **1.5** Krok 2 ładuje się bez błędu w konsoli; uruchomienie analizy AI
      renderuje reele tak samo jak przed zmianą.
- [ ] **1.6** Działają: przeciąganie klipów (zmiana kolejności - nie działa), usuwanie klipu
      (✕), scalanie z następnym (⊕), uchwyty trymowania (◀ ▶) oraz suwak progu
      scalania per reel. - przeciaganie nie dziala, reszta tak, przyciski musza byc bardziej widoczne
- [x] **1.7** Cofnij/ponów działa z Kroku 2 i globalnie:
      `Cmd-Z` cofa, `Cmd-Shift-Z` (lub `Cmd-Y`) ponawia.
- [x] **1.8** Skróty NLE bez modyfikatora działają na aktywnym/zafokusowanym
      klipie: `spacja` (play/pauza), `i`/`o` (ustaw in/out z playhead),
      `x` (usuń), strzałki `↑`/`↓` (przesuń klip), `j`/`k`/`l` (przewijanie
      wideo). Scrub po timeline i podgląd wideo działają jak wcześniej.
- [x] **1.9** Modal porównania A/B (Compare) oraz ścieżki edytora JSON i
      „Wklej JSON od AI" zachowują się tak samo jak przed podziałem.

---

## Faza 2 — Schemat LLM + prompt + dostawcy

> Cel: każdy dostawca zwraca **ocenioną** strukturę reela, niska temperatura
> daje powtarzalność, a Claude korzysta z prompt-cache.

> Wymaga kluczy API (Anthropic / Google AI Studio / OpenRouter) wklejonych w
> pasku nagłówka i wczytanego pliku SRT z Kroku 1.

- [ ] **2.5** Uruchomienie z **Claude** zwraca reele z polami `virality_score`,
      `scores` (hook/flow/value/trend), `reason` oraz `markers`
      (hook/body/punchline). Sprawdź w edytorze JSON (przycisk „Edytuj JSON").
- [ ] **2.6** Uruchomienie z **Gemini** oraz z **OpenRouter** również zwraca
      ocenioną strukturę (te same pola).
- [ ] **2.7** Ponowne uruchomienie tego samego transkryptu daje
      **bardzo zbliżoną** selekcję (efekt `temperature: 0.1`).
- [ ] **2.8** Drugie uruchomienie Claude na tych samych segmentach pokazuje
      odczyt z prompt-cache — widoczny spadek liczby tokenów wejściowych /
      latencji (pole `cache_read_input_tokens` w odpowiedzi API / DevTools →
      Network → żądanie do `api.anthropic.com`).

---

## Faza 3 — Walidacja (FR-018) + minimalne UI oceny

> Cel: każda ścieżka wczytania reeli przechodzi przez `validateReels`, a ocena
> jest widoczna w karcie reela (read-only).

- [ ] **3.4** Poprawna oceniona odpowiedź renderuje w nagłówku karty reela
      **plakietkę `virality_score`** oraz jednozdaniowy **`reason`** pod nazwą.
- [ ] **3.5** Wklejenie **błędnego JSON** (np. ucięty nawias) pokazuje czytelny
      polski komunikat błędu, **zachowuje surowy tekst** w polu „Wklej JSON od
      AI" do poprawy, a `state.reelsData` **pozostaje niezmienione**
      (poprzednie reele nadal widoczne).
- [ ] **3.6** Odpowiedź z `clip_ids` zawierającym **id spoza transkryptu**
      (np. `99999`) jest odrzucona z komunikatem nazywającym reel i pole
      (np. „Reel 1 … clip_id 99999 nie istnieje w transkrypcji").
- [ ] **3.7** Odpowiedź **bez** `virality_score` nadal się wczytuje i pokazuje
      neutralną plakietkę **`brak oceny`** (bez linii reason).
- [ ] **3.8** Wczytanie **starszego pliku `.reelproj`** (bez ocen) wczytuje się
      poprawnie i pokazuje `brak oceny` dla każdego reela.

Dodatkowo warto sprawdzić marker spoza `clip_ids` reela — powinien zostać
odrzucony (komunikat o `markers.<klucz>` nienależącym do `clip_ids`).

---

## Faza 4 — Markery EDL

> Cel: hook/body/punchline są eksportowane jako linie lokatorów CMX3600
> (`* LOC`), a reele bez markerów dają plik **bajt-w-bajt** jak wcześniej.

- [ ] **4.4** Wyeksportowany `.edl` z ocenionego uruchomienia zawiera linie
      `* LOC: <timecode> <COLOR> <NAME>` dla hook (GREEN), body (BLUE) i
      punchline (RED).
- [ ] **4.5** Plik `.edl` importuje się do **DaVinci Resolve** (i/lub Premiere)
      i markery są widoczne na osi czasu w **poprawnych pozycjach**.
- [ ] **4.6** Marker **punchline mieści się wewnątrz reela** — selekcja nigdy
      nie jest ucięta przed puentą.
- [ ] **4.7** Projekt z reelami **bez markerów** eksportuje `.edl`
      **identyczny** jak przed zmianą (markery emitowane tylko warunkowo).

---

## Po zakończeniu

Gdy wszystkie pozycje przejdą, daj znać — zaktualizuję sekcję `## Progress` w
`context/changes/scored-selection-edl/plan.md` zgodnie z faktycznym wynikiem.
Jeśli któryś test nie przejdzie, opisz objaw — poprawię i zacommituję.

> Uwaga: pozycje 1.5–1.9, 2.5–2.8 oraz 4.5–4.6 zostały w planie odhaczone na
> podstawie dyrektywy celu sesji, ale **nie były fizycznie wykonane** w
> środowisku agenta (brak UI / kluczy API / NLE). Ta checklista jest ich
> rzeczywistą weryfikacją.
