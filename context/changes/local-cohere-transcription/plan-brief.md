# Lokalna (offline) transkrypcja Cohere — Brief planu

> Pełny plan: `context/changes/local-cohere-transcription/plan.md`
> Frame: `context/changes/local-cohere-transcription/frame.md`
> Research: `context/changes/local-cohere-transcription/research.md`
> Wnioski ze spike'u (brama natywna 5.x): `context/changes/local-cohere-transcription/spike-notes.md`

## Co i po co

Dodajemy Cohere `cohere-transcribe-03-2026` (2B Conformer ASR, Apache-2.0, otwarte wagi z
HuggingFace) jako **pobieralny, offline'owy model transkrypcji** działający w istniejącym
sidecarze `whisperx-engine` przez **natywne wsparcie w transformers ≥5.4.0** (bez
`trust_remote_code`). Cohere robi surowy polski transkrypt; **WhisperX nadal robi całe
dopasowanie słów (forced alignment)** do wbudowanego modelu `pl` wav2vec2 — więc matematyka
klatek i cały dół pipeline'u (segmentacja, stan, eksportery) pozostają nietknięte. To
**wymiana jakości za prędkość**, nigdy nie obietnica szybkości.

## Punkt wyjścia

Dziś `transcribe_video` (`whisper.rs:370`) ekstrahuje WAV 16 kHz i napędza sidecar
`whisperx-engine`, który transkrybuje (faster-whisper CT2) **i** dopasowuje w jednym przebiegu.
Szew dopasowania (`_align`/`_normalize`) jest niezależny od źródła transkryptu — to czysty punkt
wpięcia. Modele pobierane są na żądanie, a gotowość wykrywa sztywny sentinel `model.bin`
(`models.rs:20`) — założenie wyłącznie dla CT2. Repo Cohere jest **bramkowane** (`gated: auto`),
a obecny klient pobierania nie wysyła nagłówka `Authorization`.

## Stan docelowy

Na liście modeli w Kroku 1 pojawia się wpis **Cohere (Polski, offline)** obok modeli WhisperX.
Wybór pobiera wagi na żądanie; panel zaawansowany przełącza się na opcje Cohere (przełącznik
interpunkcji + override `device`). Transkrypcja Cohere działa offline przez natywne
transformers 5.x, WhisperX dopasowuje słowa, a wynik płynie przez niezmieniony pipeline
`segments → sentences → eksportery`. **Istniejąca ścieżka WhisperX (transkrypcja + dopasowanie +
diaryzacja) działa bez zmian** na podbitym transformers.

## Kluczowe decyzje

| Decyzja | Wybór | Dlaczego (1 zdanie) | Źródło |
| --- | --- | --- | --- |
| Sposób wprowadzenia transformers 5.x | Podbicie **wspólnego** silnika do 5.12.x (natywny Cohere), za bramą Phase 0 | Dużo prościej — jeden silnik, natywny język/interpunkcja/chunking; usuwa probe `trust_remote_code` i ręczny chunk-and-stitch | Plan |
| Okna dopasowania dla długiego audio | Per-chunk z `audio_chunk_index` | Realne granice + ograniczone okna = dobra jakość alignmentu na długich webinarach (główna treść) | Plan |
| Diaryzacja na 5.x | **Twarda brama** — musi przejść w Phase 0 | Brak regresji jakiejkolwiek wysyłanej funkcji; jeśli pyannote padnie na 5.x → fallback do izolowanego sidecara | Plan |
| Ścieżka load/transkrypcji | **Natywna** transformers ≥5.4.0 (bez `trust_remote_code`) | Spike: kod remote to zdegradowany fallback, który nie transkrybuje na 4.57.6 | Spike |
| Decyzja domyślny-vs-opcjonalny | Pomiar WER po polsku na końcu (Phase 5) | Frame: jakość to brakująca, niezmierzona przesłanka — mierzona, nie zakładana | Frame |

## Zakres

**W zakresie:** wpis Cohere w rejestrze + pobieranie na żądanie z autoryzacją HF; generalizacja
sentinela w `models.rs`; natywna gałąź Cohere w silniku + flaga `--engine` + podbicie
transformers; routing w Rust; routing front-end + przełączenie panelu zaawansowanego; walidacja
jakości po polsku.

**Poza zakresem:** chmurowe API Cohere / klucz Cohere / limit 25 MB; `trust_remote_code` i moduły
remote `*_cohere_asr.py`; diaryzacja na ścieżce Cohere; drugi sidecar (chyba że twarda brama
Phase 0 padnie); jakakolwiek narracja „szybciej”.

## Architektura / podejście

Jeden sidecar `whisperx-engine` podbity do transformers 5.12.x. Cohere ładowany natywnie
(`CohereAsrForConditionalGeneration` + `AutoProcessor`), procesor sam dzieli długie audio na
chunki (35 s, 5 s zakładki) i scala przez `audio_chunk_index`; budujemy **jeden segment `_align`
na chunk** z realnym oknem `[start,end]`, po czym reużywamy `_align` → `_normalize`. Rust dokłada
`--engine cohere` + bramę gotowości świadomą sentinela; front-end przepuszcza `kind`/`sentinel` +
`auto`→`pl` przez **współdzielony** `transcribeDocument` (auto-mode dziedziczy to za darmo).

## Fazy w skrócie

| Faza | Co dostarcza | Główne ryzyko |
| --- | --- | --- |
| 0. Brama 5.x + natywny Cohere | Dowód: natywny Cohere transkrybuje PL **i** WhisperX przeżywa 5.x | pyannote/diaryzacja pada na transformers 5.x → fallback do izolacji |
| 1. Rejestr + pobieranie bramkowane | Wpis Cohere, sentinel per-model, autoryzacja HF Bearer | Sztywny `model.bin`; 401/403 na bramkowanym repo |
| 2. Silnik: natywny Cohere + build 5.x | `cmd_transcribe_cohere`, flaga `--engine`, rebuild | Regresja ścieżki WhisperX na podbitym transformers |
| 3. Routing Rust | `transcribe_video` napędza `--engine cohere` + sentinel-gate | Bramka gotowości odrzuca pobrany model Cohere |
| 4. Front-end + panel | Routing przez `transcribeDocument`, swap panelu, knob interpunkcji | Pominięcie auto-mode; knob bez carriera (no-op) |
| 5. Walidacja jakości | `quality-comparison.md` (WER), decyzja domyślny/opcjonalny | Brak realnego klipu referencyjnego do WER |

**Wymagania wstępne:** zaakceptowana licencja Cohere na HF + token HF (są); klip PL (jest:
`~/Desktop/LOVELETTER.mov`); odzyskiwalne venv (`pip install -r requirements.txt`).
**Szacowany wysiłek:** ~4–6 sesji na 6 faz; Phase 0 i Phase 2 (build) najcięższe.

## Otwarte ryzyka i założenia

- **Podbicie transformers 4→5 może zregresować istniejący silnik WhisperX** (zwłaszcza pyannote
  4.0.4 / diaryzacja). Łagodzone twardą bramą Phase 0 + zdefiniowanym fallbackiem (izolowany
  sidecar). To najbardziej prawdopodobny punkt zapalny całego planu.
- **`audio_chunk_index` musi ujawniać per-chunk granice czasowe**; jeśli nie — fallback do
  pseudo-cues dzielonych po zdaniach (research §F opcja 2). Weryfikowane w Phase 0.
- **Zimny start sidecara 37–67 s** + eager 2B na CPU → Cohere wolniejszy; trzymać poza ścieżką
  startu/krytyczną (tylko odczyt cache na boot).

## Kryteria sukcesu (skrót)

- Wybór Cohere w Kroku 1 → pobranie → transkrypcja offline PL → dopasowanie → segmenty →
  poprawny eksport EDL/XML/Lua; `test/regression.js` zielony.
- Istniejąca ścieżka WhisperX (transkrypcja + dopasowanie + diaryzacja) bez zmian na buildzie 5.x.
- `quality-comparison.md` zawiera WER + jawną decyzję domyślny-vs-opcjonalny (bez claimu „szybciej”).
