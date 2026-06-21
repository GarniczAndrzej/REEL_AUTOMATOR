# App Crash Fix (S-21) — Plan Brief

> Pełny plan: `context/changes/app-crash-fix/plan.md`
> Research: `context/changes/app-crash-fix/research.md`

## Co i dlaczego

Aplikacja losowo, po cichu zamyka się w trakcie sesji podczas `npm run tauri dev`. Nie było powtarzalnego repro ani logu. Research wskazuje, że najbardziej prawdopodobny mechanizm to **OOM → cichy SIGKILL** (proces po prostu znika, bez paniki Rusta i bez błędu JS), z trzema konkretnymi wzmacniaczami w ścieżce transkrypcji WhisperX. Plan robi jednocześnie dwie rzeczy: dodaje instrumentację, która ujawni *następny* crash, oraz prewencyjnie usuwa dwa najpewniejsze wzmacniacze OOM i jedną minę release'ową.

## Punkt wyjścia

Brak jakichkolwiek globalnych handlerów błędów w `src/` (każda awaria async jest niewidoczna) i brak haka paniki w Rust — więc crash nie zostawia śladu. W `drive_engine` (`whisper.rs:273-274`) bufory `stdout_buf`/`stderr_buf` to zwykłe `String`y rosnące przez cały przebieg; istnieje też wyścig cancel/completion, który może osierocać wielogigabajtowe procesy torch. `panic = "abort"` (`Cargo.toml:48`) działa tylko w release.

## Stan docelowy

Następny losowy crash przestaje być cichy: hak paniki Rust loguje przyczynę, a globalne listenery JS (`error`/`unhandledrejection`) logują i pokazują polski `toast()`. `stderr_buf` jest ograniczony do ogona ~64KB (bez wpływu na payload JSON w `stdout_buf`), anulowana transkrypcja zawsze ubija swój proces silnika (brak osieroconych workerów torch), a build release zawiera panikę zamiast abortować cały proces.

## Kluczowe decyzje

| Decyzja | Wybór | Dlaczego | Źródło |
| --- | --- | --- | --- |
| Zakres | Instrumentacja + naprawa top kandydatów | Bez repro czekanie na sygnał może trwać w nieskończoność; naprawiamy najpewniejsze wzmacniacze OOM od razu, instrumentacja jako siatka bezpieczeństwa | Plan |
| Limit bufora stderr | Odrzucać nie-PROGRESS, trzymać ogon | Zabija wzmacniacz OOM, zachowuje kontekst błędu pokazywany przy niezerowym exit | Plan |
| Wyścig orphan | Ubijanie dziecka w `drive_engine` | Driver posiada cały cykl życia dziecka, brak okna gdzie handle = None i nikt nie ubija | Plan |
| `panic = "abort"` (release) | Zmiana na `unwind` | Jednolinijkowe utwardzenie, usuwa realną ścieżkę crashu w produkcji | Plan |
| Zakres frontendu | Globalne handlery + minimalne fixy (FileReader onerror) | Łapie sygnał crashu JS i jeden cichy data-loss bez refaktoru robustności | Plan |
| Guard regresji | Wydzielony helper + test jednostkowy w Rust | Realny automatyczny guard przeciw regresji OOM, izolowany od async drivera | Plan |

## Zakres

**W zakresie:** hak paniki Rust; globalne listenery JS + `FileReader.onerror`; ograniczenie `stderr_buf` (helper + test); domknięcie wyścigu cancel/completion; `panic = "unwind"` w release.

**Poza zakresem:** owijanie wszystkich handlerów fire-and-forget w try/catch; martwa ścieżka waveform; timeouty ffmpeg; ring-buffer/temp-file dla stdout; automatyczne testy JS dla globalnych handlerów; zmiany UX/timingu anulowania.

## Architektura / podejście

Cztery fazy w kolejności zalecanej przez research: najpierw instrumentacja (by każdy crash w dalszej pracy był już rejestrowany), potem dwa wzmacniacze OOM, na końcu mina release. Fazy 2 i 3 dotykają `drive_engine`, ale są rozdzielone dla czystych, niezależnie weryfikowalnych diffów (limit pamięci vs cykl życia procesu). `stdout_buf` (payload JSON, parsowany w `whisper.rs:517` i `:717`) pozostaje nietknięty — ograniczany jest tylko `stderr_buf`.

## Fazy w skrócie

| Faza | Co dostarcza | Główne ryzyko |
| --- | --- | --- |
| 1. Instrumentacja | Hak paniki Rust + globalne listenery JS + FileReader onerror | Hak nie może tłumić błędu (guardrail S-21) |
| 2. Limit bufora stderr | Ograniczony ogon + test jednostkowy | Nie przyciąć przez pomyłkę `stdout_buf` (payload) |
| 3. Wyścig orphan | Ubijanie dziecka w driverze | Podwójny kill na granicy completion/cancel |
| 4. Utwardzenie release | `panic = "unwind"` | Brak — zmiana jednolinijkowa |

**Prerequisites:** działające sidecary (`whisperx-engine` + ffmpeg) i `align_models/` przywrócone (`fetch-ffmpeg.sh` + `build.sh`) do manualnej weryfikacji transkrypcji.
**Szacowany wysiłek:** ~1–2 sesje, 4 małe fazy.

## Otwarte ryzyka i założenia

- Bez repro naprawiamy najpewniejsze hipotezy, nie potwierdzoną przyczynę — instrumentacja z Fazy 1 jest zabezpieczeniem, gdyby przyczyna była inna.
- Weryfikacja cyklu życia sidecara jest manualna (Activity Monitor) — wymaga zbudowanych sidecarów; jedyny automatyczny test to ograniczony bufor w Rust.
- `panic = "unwind"` w release nie tłumaczy crashu w dev — to oddzielne utwardzenie produkcji.

## Kryteria sukcesu (skrót)

- Następny crash zostaje zalogowany (hak Rust lub listener JS) zamiast znikać po cichu.
- Pamięć aplikacji nie rośnie nieograniczenie przy gadatliwym stderr; brak osieroconych procesów torch po wielu anulowaniach.
- `cargo test` (test ograniczonego ogona) i `node test/regression.js` przechodzą; pełny pipeline import → transkrypcja → analiza → eksport działa.
