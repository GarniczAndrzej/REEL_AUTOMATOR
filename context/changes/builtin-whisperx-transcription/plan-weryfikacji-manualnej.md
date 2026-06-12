# Plan weryfikacji manualnej — builtin-whisperx-transcription

> Kod jest gotowy i scommitowany (fazy p1–p6). Automatyczne kryteria weryfikowalne
> w sesji headless są zaznaczone: **15/39**. Ten dokument opisuje **24 pozostałe
> pola** z sekcji `## Progress` w `plan.md` — wszystkie wymagają sprzętu, GUI lub
> zasobów zewnętrznych, których nie da się sprawdzić w sesji headless.
>
> **Zasada:** zaznaczaj `- [x]` w `plan.md` **tylko po realnym wykonaniu kroku**.
> Nie wolno fabrykować weryfikacji. Pola zostają `- [ ]`, dopóki krok nie przejdzie.

---

## 0. Stan obecny (co już zrobione)

- **Naprawiony błąd pakowania (krytyczny na macOS).** Pierwotnie `build.sh`
  wpiekał model alignment (~2,4 GB) **do** binarki → onefile Mach-O ~2,6 GB,
  którego macOS 26 **nie ładuje** (`dyld: syscall to map cache into shared region
  failed`, abort przed `main`). Model jest teraz trzymany **obok** sidecara, nie
  w środku: binarka schudła do **~283 MB** i uruchamia się normalnie.
- Sidecar (CPU) w `src-tauri/binaries/`:
  - `whisperx-engine-aarch64-apple-darwin` (~283 MB, Mach-O arm64, adhoc)
  - `src-tauri/binaries/align_models/pl/` (~2,4 GB, obok binarki)
  - oba w `.gitignore`; `tauri.conf.json → bundle.resources` wysyła `align_models`.
  - **Wariant GPU/Metal trzeba przebudować** (`GPU=1 sidecar/build.sh`) — stary
    `-gpu` (2,6 GB) był wpieczony i jest nieaktualny.
- **Self-test przechodzi headless** (zweryfikowane):
  `{"ok": true, "version": "1.0.0", "gpu": true, "device": "mps",
  "alignment_model_ready": true}`. Silnik znajduje `align_models` obok siebie;
  warstwa Rust dodatkowo przekazuje ścieżkę przez `--align-model-dir`.
- Zaznaczone pole: **1.2** (skrypt builda emituje binarkę z sufiksem triple).
- `cargo check` + regresja (169/169) zielone po zmianach pakowania.

---

## 1. Wymagania wstępne

| Zasób | Do czego | Pola |
|---|---|---|
| Mac Apple Silicon (ten) | self-test, transkrypcja, align, GUI | 1.3–1.5, 1.7, 2.x, 3.x, 4.x, 5.x, 6.x |
| Czysta maszyna Windows (bez Pythona) | build + uruchomienie wariantu Windows | 1.6 |
| Próbka wideo PL z mową (np. 1–3 min) | realne przebiegi transkrypcji/align | 1.4, 2.4–2.7, 3.x, 4.7, 5.4, 6.x |
| NLE: Premiere Pro lub DaVinci Resolve | import wyeksportowanego EDL | 3.7, 5.5 |
| Token Hugging Face + akceptacja licencji pyannote | diaryzacja | 6.4–6.6 |
| Internet | pobranie modelu transkrypcji (Faza 4) | 4.5, 4.7 |

Kontrakt CLI silnika (z `sidecar/README.md`):

```
whisperx-engine --audio A.wav --model large-v3 --language pl [--diarize --hf-token T]
whisperx-engine --align-only --audio A.wav --transcript T.srt --language pl
whisperx-engine --selftest
```

Kody wyjścia: `0` ok · `10` brak modelu · `11` błąd dekodowania audio ·
`12` błąd alignment · `13` błąd diaryzacji · `14` błąd transkrypcji · `1` wewn. · `2` użycie.

---

## 2. Faza 1 — silnik sidecar (macOS + Windows)

### 1.3 — `--selftest` zwraca `ok: true` (czysty PATH)
- **Kroki:** w normalnym terminalu (nie w harnessie):
  ```bash
  src-tauri/binaries/whisperx-engine-aarch64-apple-darwin --selftest
  ```
  Potwierdź, że `whisper-cli` nie ma w PATH: `command -v whisper-cli` → puste.
- **Oczekiwane:** JSON `{"ok": true, "version": ..., "gpu": ..., "device": ...,
  "alignment_model_ready": true}`, kod wyjścia 0.
- **Po sukcesie:** zaznacz `1.3` w `plan.md`.

### 1.4 — sidecar samodzielnie drukuje poprawny JSON na próbce WAV
- **Kroki:** przygotuj `sample.wav` (16 kHz mono — patrz ekstrakcja FFmpeg w
  `whisper.rs`). Najpierw pobierz model transkrypcji (Faza 4) **albo** użyj trybu
  `--align-only` z gotowym transkryptem (model alignment jest dobity):
  ```bash
  src-tauri/binaries/whisperx-engine-aarch64-apple-darwin \
    --align-only --audio sample.wav --transcript sample.srt --language pl
  ```
- **Oczekiwane:** na stdout jeden poprawny dokument JSON zgodny z kontraktem
  (`{language, segments:[{start,end,text,words:[...]}]}`), na stderr linie
  `PROGRESS phase=... percent=...`.
- **Po sukcesie:** zaznacz `1.4`.

### 1.5 — wariant Metal szybszy od CPU
- **Najpierw przebuduj wariant GPU** (stary `-gpu` był wpieczony, 2,6 GB):
  `GPU=1 sidecar/build.sh` → `whisperx-engine-aarch64-apple-darwin-gpu` (~283 MB).
- **Kroki:** uruchom ten sam realny klip przez oba warianty i zmierz czas:
  ```bash
  time src-tauri/binaries/whisperx-engine-aarch64-apple-darwin     --audio sample.wav --model large-v3 --language pl >/dev/null
  time src-tauri/binaries/whisperx-engine-aarch64-apple-darwin-gpu --audio sample.wav --model large-v3 --language pl >/dev/null
  ```
  Wariant `-gpu` w `--selftest` powinien raportować `"gpu": true, "device": "mps"`.
- **Oczekiwane:** wariant `-gpu` (Metal) jest mierzalnie szybszy na zdolnej maszynie.
- **Po sukcesie:** zaznacz `1.5`.

### 1.6 — build Windows działa na czystej maszynie (bez Pythona)
- **Kroki:** na maszynie Windows z Pythonem 3.10/3.11 uruchom `sidecar/build.sh`
  (Git Bash) — wygeneruje `whisperx-engine-x86_64-pc-windows-msvc.exe`. Przenieś
  na **czystą** maszynę Windows bez Pythona i odpal `... --selftest`.
- **Oczekiwane:** `--selftest` zwraca `ok: true` bez zainstalowanego Pythona.
- **Po sukcesie:** zaznacz `1.6`.

### 1.7 — dobity model alignment działa offline
- **Kroki:** odłącz sieć i uruchom `--align-only` (jak w 1.4).
- **Oczekiwane:** forced alignment przechodzi bez dostępu do sieci; `words[]` mają
  sensowne znaczniki czasu.
- **Po sukcesie:** zaznacz `1.7`.

> Po Fazie 1 (zwłaszcza 1.5 + 1.6) zatrzymaj się na potwierdzenie, zanim ruszysz dalej.

---

## 3. Faza 2 — silnik end-to-end, anulowanie, cache

Uruchom aplikację: `npm run tauri dev`. Kolejne pola sprawdzasz w GUI (Krok 1 — Import).

### 2.4 — realny klip napędza silnik z postępem transcribe → align
- **Kroki:** wczytaj wideo, uruchom transkrypcję.
- **Oczekiwane:** pasek postępu pokazuje fazy transkrypcji i alignmentu; na końcu
  pojawiają się segmenty.
- **Po sukcesie:** zaznacz `2.4`.

### 2.5 — anulowanie w trakcie nie zostawia śmieci
- **Kroki:** uruchom transkrypcję i anuluj w połowie. Sprawdź brak procesu-sieroty
  (`pgrep -f whisperx-engine`) i brak tymczasowego WAV.
- **Oczekiwane:** stan „anulowano" (po polsku), brak orphana, brak plików temp.
- **Po sukcesie:** zaznacz `2.5`.

### 2.6 — każda ścieżka błędu pokazuje swój polski komunikat
- **Kroki:** wywołaj kolejno: brak modelu (kod 10), uszkodzone audio (11), błąd
  alignment (12). Sprawdź różne, konkretne komunikaty PL.
- **Oczekiwane:** brak ogólnego „coś poszło nie tak"; każdy przypadek ma swój tekst.
- **Po sukcesie:** zaznacz `2.6`.

### 2.7 — projekt ze starym cache nie transkrybuje ponownie
- **Kroki:** otwórz projekt mający stary wpis `whisper-cache/<hash>.{srt,json}`
  (whisper.cpp). Sprawdź trafienie w cache (brak uruchomienia silnika).
- **Oczekiwane:** brak ponownej transkrypcji; wynik z cache.
- **Po sukcesie:** zaznacz `2.7`.

---

## 4. Faza 3 — segmentacja słowna, persystencja v4, EDL w NLE

### 3.4 — segmenty bez luk, ponumerowane, czytają się jak zdania
- **Oczekiwane:** w edytorze segmenty są gap-free i ponumerowane. → zaznacz `3.4`.

### 3.5 — granice na słowach (brak cięć w środku słowa)
- **Kroki:** wyrywkowo sprawdź kilka cięć na osi.
- **Oczekiwane:** żadne cięcie nie wypada w środku słowa. → zaznacz `3.5`.

### 3.6 — zapis → wczytanie projektu v4 zachowuje `words[]`
- **Kroki:** zapisz `.reelproj`, wczytaj ponownie, sprawdź obecność `words[]`.
- **Oczekiwane:** `words[]` przetrwały round-trip. → zaznacz `3.6`.

### 3.7 — wyeksportowany EDL importuje się czysto do NLE
- **Kroki:** wyeksportuj EDL, zaimportuj do Premiere/Resolve.
- **Oczekiwane:** import bez błędów, bez regresji względem ścieżki SRT. → zaznacz `3.7`.

---

## 5. Faza 4 — menedżer modeli i pobieranie

### 4.4 — lista modeli: downloaded / missing / ready przy pierwszym uruchomieniu
- **Oczekiwane:** statusy poprawne na świeżej instalacji. → zaznacz `4.4`.

### 4.5 — pobieranie z żywym %/prędkością/ETA + weryfikacja
- **Kroki:** pobierz brakujący model.
- **Oczekiwane:** widoczne %/prędkość/ETA; po weryfikacji SHA-256 model staje się
  używalny. → zaznacz `4.5`.

### 4.6 — uszkodzone/przerwane pobranie odrzucone z polskim komunikatem
- **Kroki:** zasymuluj uszkodzony URL/przerwanie.
- **Oczekiwane:** plik częściowy usunięty, jasny komunikat PL. → zaznacz `4.6`.

### 4.7 — transkrypcja używa wybranego, pobranego modelu end-to-end
- **Oczekiwane:** wybrany model napędza realny przebieg. → zaznacz `4.7`.

---

## 6. Faza 5 — import / align / eksport transkryptu

### 5.3 — import `.srt`/`.vtt` (bez wideo) ładuje segmenty tekstowe
- **Oczekiwane:** segmenty tekstowe zasilają selekcję bez `words[]`. → zaznacz `5.3`.

### 5.4 — „dopasuj do audio" dokłada znaczniki słów do importu
- **Kroki:** przy wczytanym wideo użyj przycisku align.
- **Oczekiwane:** importowane segmenty dostają `words[]`. → zaznacz `5.4`.

### 5.5 — wyeksportowany `.srt`/`.vtt` re-importuje się czysto
- **Oczekiwane:** eksport zgadza się z transkryptem na ekranie. → zaznacz `5.5`.

---

## 7. Faza 6 — opcjonalna diaryzacja (token HF)

### 6.3 — przełącznik OFF → zero udziału HF/diaryzacji
- **Oczekiwane:** transkrypcja działa bez żadnego kontaktu z HF. → zaznacz `6.3`.

### 6.4 — ważny token HF → segmenty z etykietami mówców
- **Kroki:** włącz przełącznik, podaj ważny token HF (zaakceptuj licencję pyannote),
  uruchom przebieg.
- **Oczekiwane:** segmenty/słowa mają `speaker`. → zaznacz `6.4`.

### 6.5 — brak/zły token → jasny polski błąd, rdzeń nadal działa
- **Oczekiwane:** odrębny komunikat PL; transkrypcja bez diaryzacji nadal możliwa.
  → zaznacz `6.5`.

### 6.6 — etykiety mówców przetrwają zapis → wczytanie
- **Oczekiwane:** `speaker` przetrwa round-trip projektu. → zaznacz `6.6`.

---

## 8. Zamknięcie zmiany (gdy wszystkie 39 pól `- [x]`)

1. Sprawdź, że w `## Progress` (`plan.md`) nie ma już `- [ ]`.
2. W `change.md` ustaw `status: implemented`, `updated: <dzisiejsza data>`
   (nie ruszaj `archived_at`).
3. **Commit epilogu** — zacommituj końcowy write-back SHA do `plan.md` +
   zmianę statusu w `change.md`:
   `chore(builtin-whisperx-transcription): close out plan (epilogue)`.
4. Uruchom `/10x-archive`, aby przenieść folder zmiany do `context/archive/`.

> Sugerowana kolejność wykonania: Faza 1 (macOS: 1.3–1.5, 1.7) → Faza 4 (model do
> realnych przebiegów) → Faza 2 → Faza 3 (w tym EDL w NLE) → Faza 5 → Faza 6 →
> osobno 1.6 na maszynie Windows. Po każdej fazie zatrzymaj się na potwierdzenie.
