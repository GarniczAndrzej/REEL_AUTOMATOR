# F-01: Usunięcie ścieżki renderowania + bariera regresji — Brief planu

> Pełny plan: `context/changes/f-01/plan.md`
> Roadmapa: `context/foundation/roadmap.md` §F-01
> Strumienie (footprint): `context/foundation/streams.md`

## Co i dlaczego

Reels Automator odchodzi od renderowania MP4 wewnątrz aplikacji. Ten change usuwa całą ścieżkę renderowania FFmpeg i wszystkie funkcje edytora wideo (crop 9:16, logo, wypalanie napisów, macierz kodeków, kolejka renderu, detekcja enkodera sprzętowego, śledzenie twarzy) oraz odłożoną funkcję Metadane/miniatury. Sidecar FFmpeg **zostaje** — używają go transkrypcja Whisper i UI fali (waveform). To slice **F-01** (PRD **FR-038**); odblokowuje S-01 i S-05.

## Punkt wyjścia

Ścieżka renderowania jest wpleciona w backend Rust (`rendering.rs`, `face_detect.rs`, część `ffmpeg.rs`, rejestracja komend w `lib.rs`) i frontend (`src/render/*`, `renderConfig` w `state.js`, undo/redo i save/load, zakładki Render + Metadane w `step3-export.js`). Jedyną automatyczną barierą jest `test/regression.js` (parser + eksportery EDL/XML/Lua).

## Stan docelowy

Aplikacja nie zawiera kodu renderowania, zakładki Render, zakładki Metadane, `renderConfig` ani śledzenia twarzy. Sidecar FFmpeg działa nadal (Whisper + waveform). Moduły selekcji przeniesione do `src/selection/`. Stare pliki `.reelproj` v2 wczytują się czysto (martwe pola pomijane), nowe zapisy to v3. Pełny pipeline import → selekcja AI → scalanie segmentów → eksport EDL/XML/Lua działa, a bariera regresji jest zielona.

## Kluczowe decyzje

| Decyzja                          | Wybór                                              | Dlaczego                                                              | Źródło |
| -------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| Lokalizacja modułów selekcji     | Nowy katalog `src/selection/`                      | Uczciwe nazewnictwo (brak renderu); zgodne z `streams.md`            | Plan   |
| Los `extract_thumbnail` + Meta   | Usunąć całą zakładkę Metadane                       | Zrzuca też powierzchnię odłożonego FR-019 jednym przebiegiem         | Plan   |
| Wczytywanie starych `.reelproj`  | Bump do v3 + strip przy zapisie                    | Jawna ewolucja schematu; stare pliki wczytują się tolerancyjnie      | Plan   |
| Zakres testów                    | Istniejący suite + przypadek back-compat `.reelproj` | Testuje realne ryzyko: load gubiący `renderConfig`                  | Plan   |
| `prompt.js` (główny schemat AI)  | Nie ruszać (tylko `buildMetadataPrompt` usunąć)    | To plik S-01; zmiana schematu należy do S-01                          | Plan   |
| Sidecar FFmpeg                    | Zostaje                                             | Wymagany przez Whisper (audio) i waveform                            | Roadmapa |

## Zakres

**W zakresie:** usunięcie backendu renderu (Rust), frontendu renderu + `renderConfig`, zakładek Render i Metadane, przeniesienie `fillers.js`/`timeline.js`/`waveform.js` do `src/selection/`, migracja `.reelproj` do v3, nowy przypadek regresji.

**Poza zakresem:** sidecar FFmpeg (zostaje), `mergeAdjacentClips` i eksportery (bez zmian), główny schemat `prompt.js` (S-01), split `step2-analyze.js` / refaktor R1 (S-01), zmiany w `project.rs` (Rust), migracja cache Whisper/waveform.

## Architektura / Podejście

Cztery fazy, każda kończąca się barierą regresji: (1) backend Rust — usuń `rendering.rs`/`face_detect.rs`, przytnij `ffmpeg.rs`, wyrejestruj komendy; (2) frontend renderu + przeniesienie ocalałych modułów do `src/selection/`; (3) usunięcie funkcji Metadane; (4) schemat v3 + przypadek regresji back-compat. `project.rs` (Rust) jest schema-agnostyczny — migracja v3 dzieje się wyłącznie po stronie JS.

## Fazy w skrócie

| Faza                                   | Co dostarcza                                          | Główne ryzyko                                              |
| -------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| 1. Backend render teardown (Rust)      | Usunięty backend renderu; `cargo check` zielony      | `ffmpeg.rs` współdzielony — nie usunąć `run_ffmpeg_output` |
| 2. Frontend render + przeniesienie     | Usunięty UI renderu; moduły w `src/selection/`       | `renderConfig` wpleciony w undo/redo i save/load          |
| 3. Usunięcie funkcji Metadane          | Brak zakładki Metadane i miniatur                    | Splątanie `thumbnailTimestamp` z głównym schematem `prompt.js` |
| 4. `.reelproj` v3 + bariera regresji   | Migracja v3 + nowy przypadek testu                   | Load gubiący dane stare; import do NLE musi pozostać czysty |

**Warunki wstępne:** brak (F-01 jest pierwszym slice'em; działa na `master`). Uruchom regresję przed i po.
**Szacowany wysiłek:** ~1-2 sesje, 4 fazy; duża, ale dobrze zmapowana delecja, zero niewiadomych.

## Otwarte ryzyka i założenia

- `thumbnailTimestamp` może być częścią głównego schematu selekcji w `prompt.js` — jeśli tak, zostawić pole dla S-01 i usunąć tylko konsumentów UI (zweryfikować grepem).
- Usunięcie zakładki Render z `step3-export.js` (1229 LoC) nie może naruszyć zakładek eksportu EDL/XML/Lua — bariera regresji to chroni.
- Stare pliki `.reelproj` muszą wczytać się tolerancyjnie — guardrail PRD „`.reelproj` load nie może regresować".

## Kryteria sukcesu (skrót)

- Pipeline import → selekcja AI → scalanie → eksport EDL/XML/Lua działa end-to-end; brak renderu MP4 w aplikacji.
- `cargo check`, `npm run tauri build` i `node --experimental-vm-modules test/regression.js` (z nowym przypadkiem) zielone.
- Stary `.reelproj` (z `renderConfig`) wczytuje się i eksportuje czysto; nowy zapis to v3 bez martwych pól.
