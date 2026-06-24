# Auto Mode Pipeline (S-07) — Brief planu

> Pełny plan: `context/changes/auto-mode-pipeline/plan.md`
> Badania: `context/changes/auto-mode-pipeline/research.md`

## Co i po co

Budujemy **konfigurowalny tryb automatyczny uruchamiany jednym kliknięciem**, który
łączy istniejące etapy potoku — Transkrypcja (z wyrównaniem + opcjonalną
diarazycją, na ustawieniach z boksu WhisperX w kroku 1) → Segmentacja → Analiza AI
(potok S-25 cluster→curate) → Eksport — bez ręcznych przejść między etapami. Cel:
zrealizować obietnicę roadmapy S-07 (FR-008/FR-009) — od surowego wideo do gotowych
reelsów w jednym kliknięciu — a dodatkowo dać użytkownikowi kontrolę nad tym, które
etapy się wykonują i jakie wyjścia powstają, oraz tryb wsadowy dla wielu plików.

## Punkt wyjścia

Każdy etap już istnieje jako wywoływalna jednostka mutująca `state`
(`transcribeWithWhisper`, `alignToWords`, `segmentFromWords`, `runAIAnalysis`).
Powierzchnia UI jest render-on-change (`surface.js` odsłania sekcje na podstawie
`state`), więc automatyczne przechodzenie między krokami jest darmowe. Istnieją już
dwa mechanizmy anulowania (JS `AbortController` dla AI, Rust `cancel_transcription`
dla WhisperX) i dwie rozłączne powierzchnie postępu. Potok AI (S-25) jest gotowy i
ma własne ponawianie per-bucket oraz częściowy commit — trzeba go tylko sterować.

## Stan docelowy

Użytkownik z ustawionym kluczem API klika **„Tryb automatyczny”** nad krokiem 1,
w nieblokującym pływającym panelu zaznacza, które etapy uruchomić i jakie wyjścia
wygenerować (zależności wymuszane automatycznie), po czym: w trybie pojedynczym
potok przeprowadza wczytany dokument przez wybrane etapy z auto-przewijaniem i
anulowaniem per-etap; w trybie wsadowym N plików przetwarzanych jest po kolei, a
wybrane wyjścia każdego pliku zapisywane są do jednego wskazanego folderu — bez
ruszania pojedynczego dokumentu na powierzchni.

## Kluczowe decyzje

| Decyzja | Wybór | Dlaczego | Źródło |
| --- | --- | --- | --- |
| Gałęzie wejścia | Wideo i SRT | Oba realne punkty wejścia aplikacji | Plan |
| Semantyka Stop | Przyciski anulowania per-etap | Zgodnie z dosłownym brzmieniem roadmapy; anulowanie etapu wcześniejszego przerywa cały bieg, anulowanie AI zachowuje gotowe buckety | Plan |
| Bramka przed startem | Async `ask()` tylko gdy istnieją reelsy | Bezfrykcyjny pierwszy bieg, ochrona pracy przy ponowieniu; bez synchronicznego `confirm` (lessons.md) | Plan |
| Diaryzacja | Wg `state.diarize` | Brak nowej polityki; bez tokenu HF — pominięcie z toastem, nie błąd | Plan |
| Wybór etapów | Checkboxy: Transkrypcja / Segmentacja / Analiza AI / Eksport | Transkrypcja niesie wyrównanie+diaryzację+słowa z boksu WhisperX kroku 1 jako jeden przełącznik | Plan |
| Model wsadowy | Headless → pliki do wskazanego folderu | Unika niemożliwego „5 plików w jednym state”; folder wybierany raz (reguła zapisu) | Plan |
| Wyjścia | SRT, VTT, `.md`, słowo-JSON (multi); EDL/XML/Lua gdy są reelsy | Pokrywa dostępne wyjścia eksporterów | Plan |
| Postęp | Nieblokujący pływający panel | Spełnia „pop-up” i „bez blokującego modala” naraz | Plan |
| Sterowanie AI | Eksportowany awaitowalny wrapper `runAnalysis({apiKey, signal})` | Bez sięgania do DOM kroku 2; czysty sygnał zakończenia | Research §B + Plan |
| Powrót do wcześniejszych kroków | Tylko-do-odczytu podczas biegu | Zapobiega mutacji `state.sentences` w trakcie analizy | Plan |

## Zakres

**W zakresie:** orkiestrator pojedynczego dokumentu; nieblokujący panel postępu z
anulowaniem per-etap; konfigurowalny zestaw etapów + wybór wyjść; tryb wsadowy
headless do folderu; awaitowalny wrapper AI; pomocnicze czyste funkcje
generujące + zapis do folderu.

**Poza zakresem:** re-implementacja strategii AI (S-25), jej ponawiania i commitu;
zmiana schematu LLM / formatów eksportu / `.reelproj`; osobne okno OS (panel jest
nakładką in-app); zrównoleglenie transkrypcji (jeden globalny reaper/kanał
postępu); auto-start przy upuszczeniu wideo; zapis wyników wsadowych do `.reelproj`.

## Architektura / podejście

Nowe drzewo `src/ui/auto-mode/` (orchestrator, progress-panel, config, batch,
index) rejestrowane w `main.js` przed `initSurface()`. Kontrakt orkiestratora:
„wywołaj wejście etapu, poczekaj, zmutuj `state` + `emit()`, przejdź dalej”.
Pojedynczy `AutoRunController` śledzi żywy etap i kieruje anulowanie do właściwego
prymitywu. Tryb wsadowy wywołuje `transcribe_video` bezpośrednio per plik
(sekwencyjnie — wymuszone przez globalny reaper/event), generuje wyjścia czystymi
funkcjami i zapisuje przez `saveTextToFolder` (`save_text_file`).

## Etapy w skrócie

| Etap | Co dostarcza | Główne ryzyko |
| --- | --- | --- |
| 1. Seam AI + orkiestrator (pojedynczy) | Pełny bieg jednym kliknięciem; bramka, gardy, gałąź SRT/wideo | Refaktor `runAIAnalysis` do awaitowalnego wrappera bez DOM |
| 2. Nieblokujący panel postępu + anulowanie per-etap | Jeden ciągły wskaźnik etapów; routing anulowania | Połączenie dwóch źródeł sygnału postępu; brak pułapki fokusu |
| 3. Wybór etapów + wyjść | Checkboxy etapów + multi-wybór wyjść z zależnościami | Reguły zależności (greying nieprawidłowych kombinacji) |
| 4. Tryb wsadowy (headless → folder) | Kolejka N wideo, zapis wyjść per plik do folderu | Czyste funkcje generujące; brak wycieku „ostatniego” wideo do state |

**Prerekwizyty:** S-01 (selekcja) i S-05 (transkrypcja) — gotowe; S-23 (anulowanie
AI) i S-25 (potok) — gotowe; klucz OpenRouter ustawiony.
**Szacowany wysiłek:** ~4–5 sesji na 4 fazy (faza 4 najcięższa).

## Otwarte ryzyka i założenia

- Tryb wsadowy z analizą AI per plik wymaga ścieżki danych per-wideo niezależnej od
  współdzielonej powierzchni — do potwierdzenia przy implementacji fazy 4.
- Każdy spawn WhisperX jest zimny (37–67 s) — bieg wsadowy będzie długi z założenia;
  panel musi pozostać nieblokujący z żywym %.
- Lever `cache_control` z S-25 jest tu bezczynny; oszczędności wejścia daje
  minifikacja Stage-1, a cache dyskowy czyni ponowny bieg niezmienionego transkryptu
  praktycznie darmowym (caveat F1).

## Kryteria sukcesu (skrót)

- Wideo + klucz → reelsy end-to-end jednym kliknięciem; powierzchnia auto-przewija.
- Wybór „tylko Transkrypcja + SRT” produkuje wyłącznie wskazane wyjścia tekstowe.
- Wsad 3 plików zapisuje 3 zestawy wyjść do wybranego folderu; pojedynczy dokument
  nietknięty.
- Anulowanie per-etap zatrzymuje żywy etap i zostawia spójny stan; suita
  regresyjna nadal przechodzi.
