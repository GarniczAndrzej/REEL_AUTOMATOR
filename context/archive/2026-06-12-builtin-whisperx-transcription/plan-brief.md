# Wbudowana transkrypcja WhisperX + alignment słowny + menedżer modeli — Brief planu

> Pełny plan: `context/changes/builtin-whisperx-transcription/plan.md`

## Co i po co

Zastępujemy zależny od `$PATH` `whisper-cli` (whisper.cpp) **wbudowanym, świadomym systemu silnikiem WhisperX** dającym tekst + **forsowany alignment na poziomie słów**, bez osobnej instalacji. To slice **S-05** (FR-001…FR-007) i najcięższy element ścieżki jakości: alignment słowny jest tym, co gwarantuje kluczowe kryterium PRD — **~0% cięć w środku słowa**. Na bazie nowego silnika dokładamy menedżer modeli, segmentację opartą na słowach, import/eksport transkryptu i opcjonalną diaryzację.

## Punkt wyjścia

Dziś `transcribe_video` (`src-tauri/src/whisper.rs`) wyciąga audio sidecar-em FFmpeg, woła `whisper-cli` z `$PATH` (`-osrt -oj`), parsuje zgrubne offsety tokenów jako `words[]` i cache'uje `<hash>.{srt,json}`. Front (`src/ui/step1-import.js`) ma ręczny wybór **ścieżki** modelu `.bin`. Dane słów są **ulotne** (nigdy nie zapisywane), a projekt `.reelproj` jest w schemacie **v3**. Jedyny dziś bundlowany runtime to sidecar FFmpeg (`externalBin`).

## Stan docelowy

Użytkownik upuszcza wideo, aplikacja transkrybuje je **w pełni lokalnie wbudowanym WhisperX** (bez instalacji), tworząc segmenty z alignmentem słownym zasilające selekcję AI. Może przeglądać **listę modeli** (pobrany / brak / gotowy), pobrać brakujący z %/prędkością/ETA, **zaimportować** istniejące `.srt`/`.vtt` (opcjonalnie dociągając je do audio), **wyeksportować** transkrypt i opcjonalnie włączyć **diaryzację**. Stare projekty v3 i stare wpisy cache whisper.cpp dalej działają (bez wymuszonej re-transkrypcji).

## Kluczowe decyzje

| Decyzja                         | Wybór                                                | Dlaczego                                                                 | Źródło |
| ------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| Pakowanie silnika               | WhisperX jako sidecar PyInstaller                    | Prawdziwy forsowany alignment — realizuje FR-002 i kryterium ~0% mid-word | Plan   |
| Dystrybucja modeli              | Pobieranie na żądanie do app data dir                | Mały instalator, zgodne z FR-003 (pobieranie z postępem)                | Plan   |
| Model alignmentu                | Bundlowany na etapie PyInstaller; lista pokazuje gotowość | Rdzeń alignmentu działa offline od razu; menedżer weryfikuje gotowość | Plan   |
| Zakres                          | Najpierw rdzeń silnika, reszta fazami               | De-ryzykuje wymianę silnika; pipeline selekcja→eksport bez regresji     | Plan   |
| Cache                           | Wersjonowanie klucza, stare wpisy ważne             | Brak wymuszonej re-transkrypcji istniejących projektów                  | Plan   |
| Segmentacja                     | Bezpośrednio z timestampów słów (import .srt → parseSRT) | Najwyższa wierność, naturalna baza pod trym słowny (S-06)           | Plan   |
| Import transkryptu              | Opcjonalny alignment, gdy jest wideo                | Szybki import bez wideo, trym słowny dostępny na życzenie               | Plan   |
| Diaryzacja                      | Domyślnie wył.; token HF przy włączeniu             | Rdzeń nigdy nie blokuje się na konfiguracji HF/pyannote                  | Plan   |
| Trwałość słów                   | `words[]` na zdaniach, `.reelproj` → v4             | Dane słów stają się trwałym stanem dla S-06; v3 ładuje się tolerancyjnie | Plan   |
| Platformy                       | macOS + Windows; warianty CPU/GPU na macOS          | PyInstaller wykrywa OS i dociąga zależności (decyzja użytkownika)        | Plan   |
| Testy                           | Regresja na fixture'ach + ręczny przebieg silnika   | Zachowuje deterministyczny strażnik; sidecar ~1 GB poza unit-testami    | Plan   |

## Zakres

**W zakresie:** sidecar WhisperX (mac+win, CPU/GPU mac), wymiana silnika w backendzie + anulowanie + wersjonowany cache, segmentacja ze słów + trwałość v4, menedżer modeli z pobieraniem, import + opcjonalny alignment + eksport transkryptu, opcjonalna diaryzacja.

**Poza zakresem:** tryb auto jednym kliknięciem (S-07), UI trymu słownego / snap-to-pause (S-06), metadane per-reel (odroczone), usunięcie sidecara FFmpeg, zmiana schematu selekcji LLM (S-01), zdalny katalog modeli.

## Architektura / podejście

Zamrożony PyInstaller-em CLI WhisperX uruchamiany jako sidecar (jak FFmpeg), zwracający **jeden znormalizowany JSON** na stdout (`{ segments:[{start,end,text,words:[…]}], language }`) i postęp na stderr. Rust parsuje ten jeden kontrakt; SRT jest pochodną, nie źródłem prawdy. Front buduje `sentences[]` wprost ze słów; import `.srt`/`.vtt` dalej idzie przez `parseSRT`/`parseVTT` — obie ścieżki zbiegają się na tym samym kształcie.

## Fazy w skrócie

| Faza | Co dostarcza | Główne ryzyko |
| ---- | ------------ | ------------- |
| 1. Pakowanie sidecara WhisperX | Wbudowany, świadomy OS silnik + model alignmentu | Najcięższa nieznana: PyInstaller Python na 2 OS + GPU/CPU |
| 2. Wymiana silnika + cache | Sterowanie sidecarem, postęp, anulowanie, wersjonowany cache | Lifecycle procesu, mapowanie błędów |
| 3. Segmentacja ze słów + v4 | Gap-free segmenty ze słów, trwałe `words[]`, schemat v4 | Zbieżność dwóch ścieżek segmentacji, frame-math |
| 4. Menedżer modeli | Rejestr + pobieranie z %/ETA + weryfikacja SHA-256 | Nowa zależność HTTP, weryfikacja sumy |
| 5. Import + alignment + eksport | Ujednolicony import, „dociągnij do audio", eksport `.srt`/`.vtt` | Drugi tryb silnika (align-only) |
| 6. Opcjonalna diaryzacja | Przełącznik wył. domyślnie, token HF, etykiety mówców | Zewnętrzny bloker (token HF + dostęp pyannote) |

**Wymagania wstępne:** F-01 (zrobione). Token Hugging Face + dostęp do modeli pyannote — tylko dla opcjonalnej diaryzacji (Faza 6), nigdy na ścieżce rdzenia.
**Szacowany wysiłek:** duży — ~6 faz; Faza 1 (pakowanie) to największa niewiadoma, celowo na początku.

## Otwarte ryzyka i założenia

- **Pakowanie na 2 platformach + warianty GPU/CPU** to znacząco większy zakres pakowania niż dzisiejszy pojedynczy binarny FFmpeg — realne ryzyko dla harmonogramu; podpisywanie/notaryzacja macOS i build Windows mogą wymagać osobnej iteracji.
- Rozmiar instalatora rośnie przez bundlowany model alignmentu (założenie: akceptowalne dla offline-first rdzenia).
- Pokrycie językowe modelu alignmentu: rdzeń jest polski; inne języki mogą wymagać dodatkowych modeli align.
- Brak crate'a HTTP w `Cargo.toml` dziś — Faza 4 dodaje zależność pobierania ze strumieniowym postępem.

## Kryteria sukcesu (skrót)

- Na maszynie **bez `whisper-cli` i bez Pythona na PATH** pełna transkrypcja działa lokalnie i daje czysty eksport EDL.
- Granice cięć padają **między słowami** (~0% w środku słowa).
- Istniejące projekty v3 i stary cache działają bez wymuszonej re-transkrypcji; v4 zapisuje i odczytuje `words[]`.
