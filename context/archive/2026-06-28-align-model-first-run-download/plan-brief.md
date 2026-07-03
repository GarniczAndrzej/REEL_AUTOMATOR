# Align Model First-Run Download — Brief planu

> Pełny plan: `context/changes/align-model-first-run-download/plan.md`

## Co i dlaczego

Wyłączamy ~1,2 GB polski model wyrównania (wav2vec2) z paczki aplikacji macOS,
żeby DMG zmalał z **~4,7 GB do ~400 MB** (mieści się w limicie 2 GB pojedynczego
zasobu w GitHub Releases). Model jest pobierany **raz, przy pierwszym użyciu** —
leniwie przy pierwszej transkrypcji **oraz** przez dedykowany przycisk „Pobierz
model wyrównania" w menedżerze modeli — do zapisywalnego cache użytkownika, a
potem używany **offline** przy każdym kolejnym uruchomieniu.

## Punkt wyjścia

Fundament w Rust jest **już częściowo gotowy (niezacommitowane w `engine.rs`)`**:
`align_model_dir()` wskazuje teraz zapisywalny `app_cache_dir()/align_models`, a
nowa `align_model_present()` wykrywa pobrany model (glob `*.safetensors`). Brakuje:
silnik nie pobiera do tego katalogu, wymuszony tryb offline (`HF_HUB_OFFLINE`)
blokuje pierwsze pobranie, a pakowanie (`tauri.conf.json` + `build.sh`) wciąż
dołącza model.

## Stan docelowy

Świeża instalacja: pierwsza transkrypcja (lub przycisk) pobiera model raz z polskim
paskiem postępu; druga transkrypcja działa w pełni offline z identycznym
wyrównaniem słów i eksportem EDL/XML/Lua. Bez sieci przy pierwszym uruchomieniu
użytkownik widzi **konkretny** polski komunikat o potrzebie internetu, a nie ogólny
błąd wyrównania. DMG ~400 MB, bez `align_models/` w paczce.

## Kluczowe decyzje

| Decyzja | Wybór | Dlaczego | Źródło |
| --- | --- | --- | --- |
| Kto decyduje offline/pobieranie | Silnik (nie Rust) | Silnik zna mapę język→repo whisperx i ma `model_cache_only`; Rust nie wie per-język | Plan |
| Obsługa języków | Per-język | `align_model_present` jest agnostyczne; PL obecny blokowałby pobranie innego języka | Roadmap pytanie → użytkownik |
| Pierwszy run bez sieci | Konkretny polski komunikat (exit 15) | Uczciwy, akcjonowalny — nie myli „brak sieci" z „zepsute wyrównanie" | Użytkownik |
| Wyzwalanie pobierania | Dedykowany przycisk + leniwie | Pasek + rozmiar jak przy modelach transkrypcji; spójny UX | Użytkownik |
| Format pobierania | Tylko safetensors (`snapshot_download` + `allow_patterns`) | Pomija zbędny `pytorch_model.bin` (źródło podwojenia rozmiaru) | Plan |
| Tryb offline (zimny start) | `model_cache_only=True` przy ładowaniu | Zachowuje ~50 s oszczędności na etag, mimo usunięcia globalnego env offline | Plan |

## Zakres

**W zakresie:** un-bundling modelu PL, pobieranie per-język na żądanie (leniwe +
przycisk), reuse offline, usunięcie modelu z pakowania, komunikat offline (exit 15),
karta modelu wyrównania w menedżerze.

**Poza zakresem:** port Windows / inne platformy (S-24), weryfikacja SHA-256
pobrania, zmiany w ścieżce Cohere poza wspólnym `_align`, dokładność statusu UI dla
języków torchaudio (np. `en`), jakiekolwiek zmiany parsera/eksporterów/frame-math.

## Architektura / podejście

Jedna funkcja silnika `_ensure_align_model(language, model_dir, allow_download)`
decyduje: ładuj offline gdy w cache, pobieraj (z postępem) gdy brak. Wywołują ją
`_align` (leniwie) i nowy tryb `--fetch-align-model` (przycisk). Selftest pozostaje
„tylko-raport" (`allow_download=False`). Rust przestaje wymuszać offline na
ścieżkach transkrypcji/wyrównania (selftest dalej offline), dodaje pasmo `download`
w `map_progress`, komendy `download_align_model` + `align_model_status`, oraz
mapowanie exit 15. Front dodaje kartę modelu wyrównania (rozmiar, status, „Pobierz",
postęp `align-download-progress`).

## Fazy w skrócie

| Faza | Co dostarcza | Główne ryzyko |
| --- | --- | --- |
| 1. Silnik | `_ensure_align_model`, `--fetch-align-model`, exit 15, postęp, hiddenimport | Layout HF/snapshot_download w zamrożonym binarium |
| 2. Rust | Zdjęcie wymuszonego offline, pasmo `download`, komendy, komunikat exit 15 | Niezablokowanie pierwszego pobrania, regresja zimnej ścieżki |
| 3. Front | Karta modelu wyrównania + postęp + tekst plakietki | Spójność UX z pobieraniem modeli (PL stringi) |
| 4. Pakowanie | Usunięcie `bundle.resources` + stagingu z `build.sh` | Ciężka weryfikacja: pełny build + pobranie 1,2 GB |

**Wymagania wstępne:** S-05 (silnik WhisperX, `--align-model-dir`); sidecary +
ffmpeg odtworzone skryptami build (git-ignored — [[whisperx-sidecar-build]]).
**Szacowany wysiłek:** ~2–3 sesje na 4 fazy; ciężka weryfikacja tylko przy pełnym
przebudowaniu (build + realne pobranie 1,2 GB + przebieg offline).

## Otwarte ryzyka i założenia

- `snapshot_download` musi zapisać layout HF, który później znajdzie
  `from_pretrained(local_files_only=True)` — zakładamy zgodność (oba używają
  standardowego cache HF). Fallback: pozwolić `load_align_model(model_cache_only=False)`
  pobrać niejawnie.
- Zamrożony sidecar musi importować `huggingface_hub.snapshot_download` — dodać do
  `hiddenimports` w spec, jeśli `--selftest`/fetch zgłosi błąd importu.
- Karta UI odzwierciedla przypadek PL/HF (safetensors); języki torchaudio (`en`) to
  udokumentowane ograniczenie statusu.

## Kryteria sukcesu (skrót)

- DMG ~400 MB, bez `align_models/` w paczce; pierwsza transkrypcja pobiera model raz.
- Druga transkrypcja w pełni offline, identyczne wyrównanie + eksporty.
- Pierwszy run bez sieci → konkretny polski komunikat (exit 15), nie ogólny błąd.
