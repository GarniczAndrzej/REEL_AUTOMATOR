# Wtyczka DaVinci Resolve (S-09 `resolve-plugin-handoff`) — Brief planu

> Pełny plan: `context/changes/resolve-plugin-handoff/plan.md`
> Research: `context/changes/resolve-plugin-handoff/research.md`

## Co i po co

Budujemy wtyczkę **DaVinci Resolve Workflow Integration** (aplikacja Electron, macOS), która
osadza istniejący frontend Reels Automator bez forka i steruje API skryptowym Resolve w czterech
trybach: **D** reels → osie czasu, **C** transkrypt → ścieżka napisów, **B** transkrypcja WhisperX
w panelu, **A** auto-zbieranie audio z bieżącej osi czasu. To sztandarowy wyróżnik z roadmapy
(FR-030, FR-031, US-02) i zarazem największe pojedyncze ryzyko techniczne. F-02 zwróciło werdykt
`Go-with-rework`: runtime jest sprawdzony na żywo w Studio, a strategia ponownego użycia ustalona
(Strategy 2 — zachować HTML/CSS/JS, przebudować warstwę IPC).

## Punkt wyjścia

Frontend (`src/ui`, `exporters`, `parser`, `ai`, `state.js`) jest gotowy do ponownego użycia;
eksporter Lua (`src/exporters/lua.js`) już koduje kontrakt `AppendToTimeline` + markery dla trybu D.
Każde wywołanie backendu używa wzorca `await import('@tauri-apps/api/core')`, a wykrywanie hosta jest
niejawne — **pod Electronem te importy zawiodą i `cache.js`/`api-key.js`/`video-meta.js` po cichu
przestaną działać**, dopóki nie przejdą przez jawny adapter. Żywa powierzchnia mostka to
**20 komend `invoke()` + 3 rodziny pluginów/API Tauri**, a nie 6 z nieaktualnego kontraktu F-02.

## Stan docelowy

Edytor otwiera **Workspace → Workflow Integrations → Reels Automator** w Resolve Studio i przechodzi
cały pipeline bez wychodzenia z Resolve: panel auto-zbiera audio osi czasu (A), transkrybuje przez
WhisperX (B) lub przyjmuje `.srt`, wrzuca napisy jednym kliknięciem (C) i tworzy datowany folder z
każdym reelem jako osobną osią czasu plus media w Media Pool (D). Przy braku API (Resolve Free /
non-Studio) panel po cichu przechodzi na eksport plików S-08.

## Kluczowe decyzje

| Decyzja | Wybór | Dlaczego | Źródło |
| --- | --- | --- | --- |
| Tryb B (transkrypcja w panelu) | Pełny port WhisperX, faza ostatnia z trybów | Pełna parność end-to-end w Resolve; zaplanowana po D/C, by nie blokować wartości | Plan |
| Fazowanie | Most+D rdzeń → C → B → A | Najpierw sztandarowy FR-030 na najniższym ryzyku (eksportery), potem cięższe porty | Plan |
| Platforma | Tylko macOS w tym slice | Zgodne z powierzchnią F-02 i sidecarami aarch64; Windows jako follow-up | Plan |
| Podpisywanie | Dev-install teraz, podpis/notaryzacja jako ostatnia faza | Odblokowuje pracę funkcjonalną; izoluje nieudowodnione ryzyko dystrybucji | Plan |
| Tryb D — budowa osi | Reuse eksportera + `ImportTimelineFromFile` | Reuse eksporterów chronionych regresją; mniej nowej powierzchni API | Plan / Research |
| Tryb C — napisy | Import `.srt` jako ścieżka główna, weryfikacja API w fazie | Pewna ścieżka mimo braku stabilnego API tworzenia napisów | Plan / Research |
| Tryb A — audio | Tylko render-to-file; gdy niedostępny → ręczny import pliku | Render-to-file łapie miks osi; ślepy fallback FFmpeg na źródło myliłby audio przy zmontowanej osi | Plan / Research |
| Układ repo | Nowy `/resolve-plugin`, importuje wspólny `src/` | Jedno źródło prawdy UI/eksporterów; brak forka/dryfu | Plan |
| Adapter backendu | Jeden moduł + jawny capability-check | Likwiduje ciche no-op; jeden punkt routingu Tauri ⇄ Electron | Plan / Research |
| Pamięć/klucze | Ścieżki Electron + `safeStorage`, świeży namespace | Natywne prymitywy, bez dodatkowego natywnego `.node` do podpisania | Plan |
| Fallback dostępności | Sonda API przy starcie → auto-przełączenie na S-08 | Zgodne z FR-031; jeden punkt detekcji; łagodna degradacja | Plan |
| Weryfikacja | Regresja zielona + skryptowana checklista manualna na fazę | Chroni czysty pipeline; honoruje bramkę manualną przy żywym Resolve | Plan |

## Zakres

**W zakresie:** host Electron WI (manifest/main/preload/`.node`); adapter platformy + capability-check;
port komend `fs`/`crypto`/`safeStorage`; tryby D/C/B/A; sonda dostępności + fallback S-08; pełny port
sidecara WhisperX (silnik + modele align + ffmpeg jako `extraResources`); podpis + notaryzacja macOS.

**Poza zakresem:** build Windows; fork lub kopia `src/`; zmiany zachowania aplikacji Tauri; migracja
cache z Tauri; natywny moduł `keytar`/`keyring`; zmiany promptów/schematu LLM; automatyczny harness
integracyjny Resolve; `CreateSubtitlesFromAudio` dla trybu C.

## Architektura / podejście

Nowy katalog `/resolve-plugin` (Electron) importuje istniejący `src/` jako drugi target Vite. `main.js`
ładuje `WorkflowIntegration.node` in-process (most NIE wymaga preferencji „External scripting").
`preload.js` wystawia `window.bridge` przez `contextBridge` + `ipcRenderer.invoke` ⇄ `ipcMain.handle`.
Cały frontend woła backend przez jeden **adapter platformy** z jawnym capability-checkiem. Tryby
nakładają się w kolejności wartość-najpierw/ryzyko-pod-kontrolą: D (reuse eksporterów przez
`ImportTimelineFromFile`) → C (import SRT) → B (port sidecara) → A (źródło audio dla B). Podpisywanie
jest izolowane na końcu.

## Fazy w skrócie

| Faza | Co dostarcza | Główne ryzyko |
| --- | --- | --- |
| 1. Most + fundament | Panel ładuje się w Resolve; adapter + capability-check; komendy trywialne; fallback S-08 | Ciche no-op `cache/api-key/video-meta` pod Electronem |
| 2. Tryb D | Reels → datowany folder + osie czasu (reuse eksportera + import) | Pułapka frame-math (kursor 0-based, fps); wierność importu |
| 3. Tryb C | Transkrypt → ścieżka napisów (import SRT) | Brak pewnego bezpośredniego API napisów |
| 4. Tryb B | Port WhisperX do Node + bundling silnika/modeli | Reaping sierot torch; podpis/rozmiar bundla |
| 5. Tryb A | Auto-zbieranie audio osi czasu (render-to-file; gdy brak → ręczny import) | Dostępność render-to-file w runtime WI |
| 6. Pakowanie | Podpis + notaryzacja macOS; ładowanie na czystej maszynie | Nieudowodniony podpis natywnego `.node` + sidecarów (F-02) |

**Wymagania wstępne:** S-01, S-05, S-08, F-02 (wszystkie done/rozstrzygnięte); sidecary przywrócone
przez `sidecar/build.sh` + `sidecar/fetch-ffmpeg.sh`; Resolve Studio (macOS) do weryfikacji manualnej.
**Szacowany wysiłek:** ~6 faz, duży slice — most i port sidecara to najcięższe fazy; realnie kilka
sesji na fazę przy ryzykownych (1, 4, 6).

## Otwarte ryzyka i założenia

- **Render-to-file (tryb A)** może nie być dostępny w runtime WI → degradacja do **ręcznego importu
  pliku** z polskim komunikatem (ślepy dekod źródła z Media Pool dałby audio źródła, nie miks osi —
  błędne przy zmontowanej osi).
- **Bezpośrednie API napisów (tryb C)** historycznie nie istnieje → import SRT jako ścieżka pewna;
  weryfikacja wersji Resolve w fazie.
- **Podpis/notaryzacja** natywnego `.node` + Electron + sidecarów poza maszyną dev jest nieudowodniona
  (time-box F-02) — izolowana jako ostatnia faza.
- **`ImportTimelineFromFile`** zależy od wierności importera Resolve — checklista manualna musi
  potwierdzić, że klatki klipów lądują tam, gdzie trzeba (bez przesunięcia o godzinę).
- Założenie: capability-check `window.bridge` poprawnie odróżnia hosta Tauri od Electron we wszystkich
  20 miejscach wywołań.

## Kryteria sukcesu (skrót)

- Edytor uruchamia panel z Workspace → Workflow Integrations i przechodzi A→B→(selekcja)→C/D bez
  wychodzenia z Resolve Studio.
- Przy braku API panel auto-przechodzi na eksport plików S-08 (FR-031).
- Regresja (`node --experimental-vm-modules test/regression.js`) zielona przez wszystkie fazy; podpisany
  + notaryzowany bundle ładuje się na czystej maszynie macOS.
