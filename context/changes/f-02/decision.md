# F-02 — Decyzja: spike runtime'u wtyczki Resolve

> Slice fundamentowy F-02 (Wave 0). Rozstrzyga PRD Open Question #2 / FR-030 / US-02.
> Odbiorca: S-09 (`resolve-plugin-handoff`) oraz roadmapa. Identyfikatory techniczne w oryginale.
> Notatki źródłowe: `context/changes/f-02/research-notes.md`.

## Werdykt

# ✅ Go-with-rework

Runtime DaVinci Resolve Workflow Integration jest **wykonalny**, a istniejący frontend da się **ponownie wykorzystać** — ale **nie 1:1**. Wymaga przebudowy warstwy mostu z Tauri (`invoke` → Rust) na Electron (`contextBridge`/`ipcRenderer` → Node main) oraz reimplementacji ~6 ocalałych po F-01 komend w Node. To realny, ograniczony nakład bez blokera technicznego — stąd `Go-with-rework`, a nie czyste `Go` (które wymagałoby reuse bez przeróbek) ani `Park` (brak blokera, który by go uzasadniał).

**Jeden warunek domykający (nieblokujący werdyktu):** empiryczne kliknięcie panelu PoC w GUI Studio (kroki manualne 2.2–2.4) pozostaje do potwierdzenia przez operatora. Werdykt opiera się na silnym dowodzie wtórnym — patrz *Dowody*.

## Dowody

**Hosting paneli — runtime wykonalny.**
- WI plugin to **aplikacja Electron** ładowana z menu `Workspace → Workflow Integrations`, renderująca własny `index.html` w osobnym oknie (Chromium). Źródło pierwotne: lokalny SDK Studio (`Developer/Workflow Integrations/README.txt`, `Examples/SamplePlugin`).
- Od DR 19.0.2 wymuszony sandbox + context isolation; DR 20.1 → **Electron 36.3.2** + promise-based API. Rekomendowany most: `preload.js` `contextBridge` + `ipcRenderer.invoke`/`ipcMain.handle`.
- **Dowód wtórny (silny):** w docelowej instalacji Studio działa już realny, komercyjny plugin **Snap-Captions** (`com.mediable.SnapCaptions`, Electron 36, bundlowane `node_modules`, `WorkflowIntegration.node`). To empirycznie potwierdza, że custom panel HTML/JS ładuje się i sięga do API Resolve w tym środowisku. PoC F-02 używa identycznego modelu.
- **PoC F-02** (`com.reels.edl.spike`) zbudowany wg modelu sandboxed; `node --check` przechodzi dla całego JS. Kroki GUI (2.2–2.4) — do potwierdzenia przez operatora wg instrukcji w `research-notes.md`.

**Powierzchnia API (ścieżka US-02) — dostępna.**
- Pełny łańcuch „utwórz folder + timeline" potwierdzony w SDK i `SamplePlugin/main.js`:
  `Initialize → GetResolve → GetProjectManager → GetCurrentProject → GetMediaPool → GetRootFolder → AddSubFolder(root,name) → SetCurrentFolder → CreateEmptyTimeline / CreateTimelineFromClips / AppendToTimeline([{clipInfo}])`.
- `AppendToTimeline([{mediaPoolItem, startFrame, endFrame, recordFrame}])` mapuje reele (`reel.clip_ids` → scalone spany `mergeAdjacentClips`) 1:1 na ścieżkę timeline; frame-math (integer frames) pasuje.

**Pakowanie/instalacja — znane, dystrybucja z zastrzeżeniami.**
- Katalog: `…/DaVinci Resolve/Workflow Integration Plugins/com.<co>.<plugin>/` (macOS) / `%PROGRAMDATA%\…\Support\Workflow Integration Plugins\` (Windows). Struktura: `manifest.xml` + `main.js` + `preload.js` + `index.html` + `package.json` + `WorkflowIntegration.node` + `node_modules/`.
- WI plugins = **tylko macOS + Windows** (Linux nieobsługiwany), **tylko Resolve Studio**.
- Snap-Captions pokazuje, że dojrzała dystrybucja jest nietrywialna (bytecode `.jsc`, obfuskacja, warianty per-OS/per-arch/per-DR). Podpis/notaryzacja natywnego `.node` + Electrona poza maszyną dev — **nieudowodnione w time-boxie** (patrz *Ryzyka*).

**Reuse — most mechaniczny, nie koncepcyjny.**
- Po F-01 ocalałe komendy `invoke()` to tylko 6: `load_project`, `save_project`, `transcribe_video`, `load_llm_cache`, `save_llm_cache`, `clear_llm_cache`. AI (`callGemini/Claude/OpenRouter`) to już `fetch`.
- **Żadna z 6 nie potrzebuje API Resolve** — to czyste I/O pliku, subprocess i crypto, które Electron main obsługuje natywnie przez Node.

## Rekomendacja reuse

**Strategia 2 — reuse UI + nowy most po stronie Resolve.** (Pełna ocena 3 strategii: `research-notes.md → Reuse evaluation`.)
- Strategia 1 (Tauri bez zmian w panelu): **odrzucona** — brak runtime'u Tauri w panelu Electron.
- Strategia 2: **rekomendowana** — zachowaj cały UI (`src/ui`, `src/exporters`, `src/parser`, `src/ai`, `src/state.js`); wymień shim `invoke()` na preload `contextBridge`; reimplementuj 6 komend w Node main.
- Strategia 3 (osobny panel natywny): fallback, gdyby S-2 trafił na ścianę.

## Kontrakt integracyjny dla S-09

**A. Most aplikacyjny (odtworzenie ocalałych komend w Electron main, Node):**

| Metoda mostu (renderer)         | Handler main (Node)                                  | Zastępuje |
|---------------------------------|------------------------------------------------------|-----------|
| `app:loadProject(path)`         | `fs.readFile` + `JSON.parse`                          | `invoke('load_project')` |
| `app:saveProject(path,payload)` | `fs.writeFile(JSON.stringify)`                        | `invoke('save_project')` |
| `app:transcribe(args)`          | `child_process.spawn` ffmpeg + `whisper-cli` (PATH)  | `invoke('transcribe_video')` |
| `app:llmCacheGet(hash)`         | `fs.readFile <cacheDir>/<sha>.json` (+`crypto`)      | `invoke('load_llm_cache')` |
| `app:llmCacheSet(hash,content)` | `fs.writeFile`                                        | `invoke('save_llm_cache')` |
| `app:llmCacheClear()`           | `fs.rm <cacheDir>`                                    | `invoke('clear_llm_cache')` |
| *(bez zmian)* AI providers      | `fetch` w renderer (dodać `connect-src` w CSP)        | — |

**B. Most Resolve (nowy, dla US-02) — przez `WorkflowIntegration.node` w main:**

| Metoda mostu (renderer)              | Wywołanie API Resolve (main)                                   |
|--------------------------------------|----------------------------------------------------------------|
| `resolve:createBin(name)`            | `GetCurrentProject().GetMediaPool().AddSubFolder(root,name)`    |
| `resolve:selectBin(folder)`          | `MediaPool.SetCurrentFolder(folder)`                           |
| `resolve:importMedia([paths])`       | `GetMediaStorage().AddItemListToMediaPool([paths])`            |
| `resolve:createTimeline(name,spans)` | `MediaPool.CreateEmptyTimeline` + `AppendToTimeline([{clipInfo}])` (z `start/endFrame`, `recordFrame`) |

**C. Pakowanie:** katalog pluginu `com.reels.edl.<…>/` w „Workflow Integration Plugins" root; `manifest.xml` (Id/Name/Version/FilePath=main.js); bundlowany `WorkflowIntegration.node` (per-OS) + `node_modules`; CSP w `index.html` zezwalający na endpointy AI. Target: **Resolve Studio, macOS+Windows**.

**D. Strategia reuse:** Strategia 2 (UI reuse + nowy most).

## Ryzyka i zastrzeżenia

- **GUI PoC niepotwierdzone empirycznie przez operatora** (2.2–2.4). Ryzyko niskie (dowód wtórny: działający Snap-Captions w tej samej instalacji), ale do domknięcia przed startem S-09.
- **Podpis/notaryzacja dystrybucji** (natywny `.node` + Electron poza maszyną dev) — nieudowodnione w time-boxie; do rozstrzygnięcia w S-09. Snap-Captions sugeruje, że to realny, niezerowy nakład.
- **Sandbox / context isolation Electrona 36** wymusza dyscyplinę preload; któryś moduł frontendu mógłby wymagać dostosowania (mitigacja: Strategia 3 jako fallback).
- **Reimplementacja `transcribe_video` w Node** (zamiast Rust) — odtworzenie logiki ffmpeg + `whisper-cli` (`whisper-cli` nadal niebundlowany, z PATH; tak jak dziś).
- **Tylko Studio + macOS/Windows.** Użytkownicy Free / Linux pozostają na fallbacku **S-08** (eksport EDL/FCPXML/XML/Lua). To caveat downstream, nie blokuje werdyktu.

## Sprzątanie PoC

- Throwaway plugin `com.reels.edl.spike` **usunięty** z katalogu „Workflow Integration Plugins" w Fazie 4 (potwierdzenie: brak katalogu po teardown).
- Drzewo źródeł repo (`src/`, `src-tauri/`) **nietknięte** przez cały spike (zero source footprint by design).

## Następny krok (bookkeeping, poza scope F-02)

Bloker S-09 w `context/foundation/roadmap.md` (Open Question #2; status `blocked`) można odblokować do **`Go-with-rework`** z kontraktem powyżej. Edycja roadmapy to osobny follow-up (poza source-zero zakresem tego spike'u).
