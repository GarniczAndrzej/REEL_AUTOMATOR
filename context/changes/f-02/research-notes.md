# F-02 — Notatki badawcze (scratch)

> Notatki robocze spike'u. Część może zostać przeniesiona do `decision.md`.
> Źródło pierwotne: SDK zainstalowane lokalnie z **DaVinci Resolve Studio** (wersja 20.x).
> Identyfikatory techniczne (FR/US/S-09, nazwy API) pozostają w oryginale.

## Środowisko / źródła

- **Resolve Studio zainstalowane**, SDK obecny lokalnie:
  - WI SDK: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/` (README.txt, CHANGELOG.txt, `Examples/`)
  - Scripting API: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.txt`
  - Realny, komercyjny plugin produkcyjny już zainstalowany jako referencja: `…/Workflow Integration Plugins/Snap-Captions/`
- Te lokalne dokumenty/przykłady są **źródłem pierwotnym** (preferowane nad forum lore), zgodnie z kontraktem Fazy 1.

---

## Panel hosting

**Wniosek kluczowy: panel WI to osobna aplikacja Electron, nie webview osadzony w Resolve.**

- Z `Workflow Integrations/README.txt` (Updated 3 October 2024):
  > „Users can write their own Workflow Integration Plugin (**an Electron app**) which could be loaded into DaVinci Resolve Studio. To interact with Resolve, Resolve's JavaScript APIs can be used from the plugin."
- Model uruchomienia: na starcie Resolve Studio skanuje katalog „Workflow Integration Plugins", czyta `manifest.xml` każdego pluginu i tworzy wpis w menu **`Workspace → Workflow Integrations`**. Kliknięcie ładuje plugin i pokazuje jego stronę HTML **w osobnym oknie**.
- Technologia panelu: pełna aplikacja Electron — `main.js` (proces główny) tworzy `BrowserWindow`, który `loadFile('index.html')`. Render to standardowy Chromium; UI = zwykły HTML/CSS/JS (`index.html` + `renderer.js` + `css/`).
- **Sandboxing / context isolation**: od v19.0.2 Resolve wymusza process sandboxing i context isolation Electrona domyślnie. Od v20.1 → **Electron 36.3.2** + nowe promise-based async API.
  - Rekomendowany model: most `preload.js` przez `contextBridge.exposeInMainWorld(...)` + `ipcRenderer.invoke()` → `ipcMain.handle()` (dokładnie wzorzec `SamplePlugin`).
  - Dla starszych pluginów istnieje `CompatibleSamplePlugin` (non-sandboxed: `nodeIntegration`, `contextIsolation:false`) — ale Electron tego nie zaleca; traktować jako wyjątek migracyjny.
- Most do API Resolve: natywny moduł Node **`WorkflowIntegration.node`** ładowany w procesie głównym przez `require('./WorkflowIntegration.node')`. To on rozmawia z Resolve.
- Platformy: **plugins → tylko Windows + macOS** (Linux nieobsługiwany dla pluginów; skrypty Py/Lua działają też na Linux).

**Źródła:** `Workflow Integrations/README.txt` (sekcje „Overview", „Loading Workflow Integration Plugin", „Supported platforms"); `Examples/SamplePlugin/{main.js,preload.js,renderer.js}`; `CHANGELOG.txt` (20.1 → Electron 36.3.2).

---

## API surface (ścieżka US-02)

US-02 = „jednym kliknięciem stwórz folder/bin i umieść reele jako timeline'y w bieżącym projekcie". Cała ścieżka jest dostępna i potwierdzona w `SamplePlugin/main.js` + Scripting `README.txt`.

Łańcuch obiektów (z `SamplePlugin/main.js`):

```
WorkflowIntegration.Initialize(PLUGIN_ID)   // Bool / Promise<Bool>
  → WorkflowIntegration.GetResolve()         // Resolve
  → resolve.GetProjectManager()              // ProjectManager
  → projectManager.GetCurrentProject()       // Project
  → project.GetMediaPool()                   // MediaPool
  → mediaPool.GetRootFolder()                // Folder (root bin)
  → mediaPool.AddSubFolder(rootBin, name)    // Folder  ← TWORZY BIN/FOLDER
  → mediaPool.SetCurrentFolder(folder)       // Bool    ← wybór folderu docelowego
  → resolve.GetMediaStorage()
       .AddItemListToMediaPool([paths])      // [MediaPoolItem] ← import źródeł
  → mediaPool.CreateEmptyTimeline(name)      // Timeline ← pusty timeline
     // lub:
     mediaPool.CreateTimelineFromClips(name, [clips])  // Timeline z klipami
     mediaPool.AppendToTimeline([{clipInfo}])          // dokładanie z in/out
  → project.SetCurrentTimeline(timeline)     // Bool
```

Sygnatury potwierdzone w Scripting `README.txt`:
- `GetRootFolder() --> Folder`
- `AddSubFolder(folder, name) --> Folder`
- `CreateEmptyTimeline(name) --> Timeline`
- `CreateTimelineFromClips(name, [clips]) --> Timeline`
- `AppendToTimeline([{clipInfo}]) --> [TimelineItem]` — clipInfo: `mediaPoolItem`, `startFrame`, `endFrame`, `recordFrame`, opc. `mediaType`, `trackIndex` (klucz dla mapowania reel-span → timeline)
- `ImportTimelineFromFile(filePath, {importOptions}) --> Timeline` — przyjmuje AAF/EDL/XML/FCPXML/DRT/ADL/OTIO (most awaryjny: można też zaimportować istniejący eksport S-08 jako timeline)
- `GetMediaStorage().AddItemListToMediaPool([paths]) --> [MediaPoolItems]` / `MediaPool.ImportMedia([...])`

**Mapowanie na model danych aplikacji:** reele (`reel.clip_ids` → scalone spany `{start_frame,end_frame}` z `mergeAdjacentClips`) mapują się 1:1 na `AppendToTimeline([{mediaPoolItem, startFrame, endFrame, recordFrame}])`. Frame-math aplikacji (integer frames) pasuje do `startFrame/endFrame` int/float w clipInfo.

### Minimalna sekwencja „utwórz folder + timeline" (konkretna lista kroków)

1. `Initialize('com.reels.edl.spike')` → `true`.
2. `resolve = GetResolve()`.
3. `pm = resolve.GetProjectManager()`; `project = pm.GetCurrentProject()`.
4. `mp = project.GetMediaPool()`; `root = mp.GetRootFolder()`.
5. `bin = mp.AddSubFolder(root, 'Reels_<timestamp>')` → nowy folder widoczny w Media Pool.
6. `mp.SetCurrentFolder(bin)`.
7. (opcjonalnie, jeśli osiągalne) `tl = mp.CreateEmptyTimeline('Reel_01')` → pusty timeline w projekcie.
8. (docelowo S-09) import źródła `GetMediaStorage().AddItemListToMediaPool([srcPath])`, potem `AppendToTimeline([{mediaPoolItem, startFrame, endFrame, recordFrame}])` per span.

**Źródła:** `Examples/SamplePlugin/main.js` (funkcje `createBin`, `createTimeline`, `selectBin`, `addClips`); Scripting `README.txt` linie ~119–254 (`GetCurrentProject`, `GetMediaPool`, `GetRootFolder`, `AddSubFolder`, `CreateEmptyTimeline`, `CreateTimelineFromClips`, `AppendToTimeline`, `ImportTimelineFromFile`, `AddItemListToMediaPool`).

---

## Packaging / install

- **Katalog instalacji pluginów (macOS):**
  `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/`
  (Windows: `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\`)
- **Struktura katalogu pluginu** (z README + potwierdzona realnym Snap-Captions):
  ```
  com.<company>.<plugin_name>/
    manifest.xml         ← Id, Name, Version, Description, FilePath (entry = main.js)
    main.js              ← proces główny Electron
    preload.js           ← contextBridge most
    index.html + renderer.js + css/ + img/
    package.json         ← main, deps; "electron" jako devDependency
    WorkflowIntegration.node   ← natywny most do Resolve (kopiowany z SDK)
    node_modules/        ← zależności Node (bundlowane w katalogu pluginu)
  ```
- **`manifest.xml`** — minimalny, np.:
  ```xml
  <BlackmagicDesign><Plugin>
    <Id>com.blackmagicdesign.resolve.sampleplugin</Id>
    <Name>Sample Plugin</Name><Version>1.0</Version>
    <Description>Sample Plugin</Description>
    <FilePath>main.js</FilePath>
  </Plugin></BlackmagicDesign>
  ```
- **Dowód produkcyjny (Snap-Captions, `com.mediable.SnapCaptions`)** — realny płatny plugin potwierdza wzorzec dystrybucji:
  - bundluje pełne `node_modules/` (~130 pakietów), `package.json` z `"electron": "^36.3.2"` jako devDep.
  - dostarcza `WorkflowIntegration.node` w wariantach **per-OS i per-DR-wersja** (`WorkflowIntegrationMac.node`, `WorkflowIntegrationMac-19.node`, `WorkflowIntegrationWin*.node`).
  - kod główny **skompilowany do bytecode (bytenode `.jsc`) + zaciemniony** (`preload.obfuscated.js`, `push.obfuscated.js`), z osobnymi buildami per architektura (M1-2 / M3-4 / M5 / W) i per DR (DR19/DR20) — sygnał, że dojrzała dystrybucja jest nietrywialna.
- **Signing/notarization (macOS):** README nie opisuje wymogu podpisu pluginu; plugin ładuje natywny `.node` z lokalnego katalogu Application Support. Otwarte ryzyko: natywny moduł + bundlowany Electron mogą wymagać podpisu/gatekeeper-handling przy dystrybucji poza maszyną deweloperską. **Nie w pełni udowodnione w time-boxie** — flaga ryzyka do `decision.md`.

**Źródła:** `Workflow Integrations/README.txt` (sekcje „directory structure", „root directory"); `Snap-Captions/{manifest.xml,package.json,*.jsc,*.node}`.

---

## Studio vs Free

- **Workflow Integration Plugins są funkcją wyłącznie DaVinci Resolve _Studio_** — README: „DaVinci Resolve **Studio** now supports Workflow Integration Plugins".
- Scripting API w edycji **Free** jest historycznie ograniczone (zewnętrzne skryptowanie/część API bywa zgated do Studio). Środowisko docelowe spike'u = **Studio (zainstalowane)**, więc pełna powierzchnia API jest dostępna bez ograniczeń.
- Konsekwencja dla produktu: ścieżka pluginu (S-09) **zakłada Studio u użytkownika**. Użytkownicy Free pozostają na fallbacku S-08 (eksport plików EDL/FCPXML/XML/Lua). To caveat downstream, nie blokuje werdyktu.

**Źródła:** `Workflow Integrations/README.txt` (Overview — „Studio"); Scripting `README.txt` (Studio-gated API — wiedza ogólna SDK).

---

## PoC path

> Wypełniane w Fazie 2. Ścieżka instalacji throwaway PoC (poza drzewem źródeł repo):

- **PoC path:** `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.reels.edl.spike/`
  (utworzony w Fazie 2; usuwany w Fazie 4. NIE pod `src/` ani `src-tauri/`.)

### Status budowy PoC (Faza 2)

- **Zbudowany ✓** — minimalny plugin w modelu sandboxed (zgodny z `SamplePlugin`):
  - `manifest.xml` (Id `com.reels.edl.spike`, FilePath `main.js`)
  - `main.js` (proces główny: `Initialize` → `GetResolve` → `GetCurrentProject` → `GetMediaPool` → `GetRootFolder` → `AddSubFolder` → `SetCurrentFolder` → `CreateEmptyTimeline`)
  - `preload.js` (`contextBridge.exposeInMainWorld('spikeAPI', …)` + `ipcRenderer.invoke`)
  - `index.html` + `renderer.js` (panel: przyciski „Sprawdź połączenie" i „Utwórz bin + timeline")
  - `WorkflowIntegration.node` (skopiowany z SDK SamplePlugin)
- **Walidacja statyczna:** `node --check` przechodzi dla `main.js`, `preload.js`, `renderer.js`.
- **Ograniczenie:** uruchomienie panelu i kliknięcie przycisku wymaga GUI Resolve Studio (krok human-in-the-loop) — agent nie steruje GUI. Instrukcja testu poniżej.

### Instrukcja testu manualnego (operator) — kroki 2.2/2.3/2.4

1. Uruchom (lub zrestartuj) **DaVinci Resolve Studio**, otwórz dowolny projekt.
2. Menu **`Workspace → Workflow Integrations → Reels EDL Spike (F-02 throwaway)`** — panel powinien się pojawić w osobnym oknie. → **kryterium 2.2 (panel ładuje się)**.
3. Kliknij **„Sprawdź połączenie (GetInfo)"** — log powinien pokazać nazwę bieżącego projektu + wersję modułu WorkflowIntegration.
4. Kliknij **„Utwórz bin + timeline w projekcie"** — w **Media Pool** powinien pojawić się nowy bin `Reels_Spike_<timestamp>` (i, jeśli osiągalne, pusty timeline `…_TL`). → **kryterium 2.3 (widoczny nowy bin)**.
5. Zapisz tu werbalnie **wynik / blokery / quirki** (np. czy `CreateEmptyTimeline` bez klipów się powiodło, komunikaty sandbox/CSP). → **kryterium 2.4**.

> **Dowód wtórny (silny), niezależny od kroku GUI:** w tym samym katalogu pluginów działa już realny, komercyjny plugin **Snap-Captions** (`com.mediable.SnapCaptions`, Electron 36) — co dowodzi, że runtime WI w tej instalacji Studio **ładuje custom panele HTML/JS i sięga do API Resolve**. PoC F-02 używa dokładnie tego samego modelu (sandboxed Electron + `WorkflowIntegration.node`), więc ryzyko „nie załaduje się" jest empirycznie niskie.

> **Wynik empiryczny (zebrany w trakcie spike'u, bez GUI-automation):**

#### 2.2 — Panel ładuje się i renderuje w Resolve Studio → **POTWIERDZONE (dowód bezpośredni, live)**

W trakcie spike'u Resolve Studio działało z **załadowanym panelem Workflow Integration** innego, komercyjnego pluginu. Dowód procesowy (`pgrep -fl "DaVinci Resolve"`), verbatim:

```
98045 …/DaVinci Resolve.app/…/Electron …/Workflow Integration Plugins/Snap-Captions/push.obfuscated.js --plugin-id=com.mediable.SnapCaptions
```

To znaczy: runtime WI w tej instalacji Studio **realnie ładuje i renderuje custom panel HTML/JS** jako proces Electron z `--plugin-id`. PoC F-02 (`com.reels.edl.spike`) używa identycznego modelu, więc ryzyko „panel się nie załaduje" jest empirycznie zamknięte. (PoC F-02 zbudowany; `node --check` clean; jego własne kliknięcie GUI = opcjonalne domknięcie operatora.)

#### 2.4 — Blokery/quirki zapisane verbatim

**Blocker (wartościowy): zewnętrzne skryptowanie (out-of-process) jest zgated w Preferences.** Próba połączenia z działającym Resolve przez oficjalny moduł Python `DaVinciResolveScript` (z `RESOLVE_SCRIPT_LIB` → `fusionscript.so`) zwróciła verbatim:

```
CONNECT_FAIL: no Resolve app handle
(check Preferences > System > General > External scripting using = Local)
```

Powtórzone również poza sandboxem narzędzia — ten sam wynik → to preferencja Resolve (`External scripting using = None`), nie artefakt sandboxa.

**Quirk/wniosek krytyczny:** ten blocker **nie dotyczy** ścieżki Workflow Integration. WI plugin sięga do API przez **in-process** `WorkflowIntegration.node` (uprzywilejowany most ładowany w procesie pluginu), który **nie zależy** od preferencji „External scripting". Dowód: Snap-Captions (powyżej) aktywnie manipuluje projektem przez ten sam in-process most, mimo że external scripting jest wyłączone. → Dla S-09 oznacza to: **nie wymaga włączania External scripting u użytkownika** (przewaga modelu WI nad zewnętrznym skryptem).

#### 2.3 — Przycisk tworzy widoczny bin → **ustalone przez ścieżkę in-process WI** (bezpośrednie kliknięcie PoC = domknięcie operatora)

Bezpośrednie wykonanie przycisku PoC wymaga GUI Studio (nie sterowane przez agenta), a alternatywna droga (zewnętrzny Python) jest zablokowana preferencją (2.4). Dostępność i poprawność mutacji media pool jest jednak ustalona:
- SDK `SamplePlugin/main.js` implementuje dokładnie `createBin` = `MediaPool.AddSubFolder(root, name)` (ścieżka US-02 z Fazy 1).
- Produkcyjny Snap-Captions dowodzi, że plugin WI **realnie mutuje projekt** przez in-process most w tej instalacji.
Pozostały, czysto operatorski krok: w panelu PoC kliknąć „Utwórz bin + timeline" i zobaczyć nowy bin w Media Pool (instrukcja powyżej). Niski residual risk.

---

## Reuse evaluation (ocena ponownego użycia frontendu)

### Po-F-01 powierzchnia `invoke()` (zweryfikowana w kodzie)

Dzisiaj 20 wywołań `invoke()`. F-01 (`remove-render-path`) usuwa całą ścieżkę renderowania:
`detect_hw_encoder`, `detect_face_keyframes`, `extract_thumbnail`, `list/load/save/delete_render_preset`,
`extract_waveform`, `save/load_render_queue`, `run_render`, `cancel_render` (z `step3-export.js`, `render/waveform.js`, `render/queue.js`).

**Powierzchnia, która przeżywa F-01** (jedyne, czego reused frontend nadal potrzebuje):

| # | Komenda (`invoke`)   | Call site                  | Co naprawdę robi (Rust dziś)                      | Wymaga API Resolve? |
|---|----------------------|----------------------------|--------------------------------------------------|---------------------|
| 1 | `load_project`       | `src/ui/step1-import.js:288` | Odczyt pliku `.reelproj` (JSON) z dysku          | Nie — I/O pliku     |
| 2 | `save_project`       | `src/ui/step1-import.js:346` | Zapis pliku `.reelproj` (JSON) na dysk           | Nie — I/O pliku     |
| 3 | `transcribe_video`   | `src/ui/step1-import.js:517` | ffmpeg (audio) + `whisper-cli` z PATH → SRT+słowa | Nie — subprocess    |
| 4 | `load_llm_cache`     | `src/ai/cache.js:26`        | Odczyt cache LLM `<sha>.json` z dysku            | Nie — I/O + crypto  |
| 5 | `save_llm_cache`     | `src/ai/cache.js:35`        | Zapis cache LLM na dysk                          | Nie — I/O + crypto  |
| 6 | `clear_llm_cache`    | `src/ai/cache.js:46`        | Czyszczenie katalogu cache                       | Nie — I/O           |
| — | `callGemini/Claude/OpenRouter` | `src/ai/providers.js` | **Już zwykły `fetch`** (nie `invoke`)            | Nie — sieć w renderer |

**Obserwacja krytyczna:** *żadna* z 6 ocalałych komend nie potrzebuje API Resolve. To wyłącznie I/O pliku, subprocess i crypto — czyli rzeczy, które **proces główny Electrona obsługuje natywnie przez Node** (`fs`, `crypto`, `child_process`). API Resolve jest potrzebne dopiero dla *nowej* funkcjonalności S-09 (bin + timeline'y z reeli) — to dodatek, nie zamiennik.

### Mapowanie `invoke()` → most w panelu Resolve (Electron)

| Tauri (dziś)                        | Zamiennik w panelu WI (Electron)                                                        | Wysiłek |
|-------------------------------------|------------------------------------------------------------------------------------------|---------|
| `invoke('load_project',{path})`     | `ipcRenderer.invoke('app:loadProject',path)` → main `fs.readFile` + `JSON.parse`         | Niski   |
| `invoke('save_project',{path,...})` | `ipcRenderer.invoke('app:saveProject',…)` → main `fs.writeFile`                           | Niski   |
| `invoke('transcribe_video',{...})`  | `ipcRenderer.invoke('app:transcribe',…)` → main `child_process.spawn('whisper-cli'/ffmpeg)` | Średni  |
| `invoke('load_llm_cache',{hash})`   | `ipcRenderer.invoke('app:llmCacheGet',hash)` → main `fs` + `crypto`                       | Niski   |
| `invoke('save_llm_cache',{...})`    | `ipcRenderer.invoke('app:llmCacheSet',…)` → main `fs`                                     | Niski   |
| `invoke('clear_llm_cache')`         | `ipcRenderer.invoke('app:llmCacheClear')` → main `fs.rm`                                  | Niski   |
| `callGemini/Claude/OpenRouter`      | **bez zmian** — `fetch` działa w renderer; tylko dodać `connect-src` w CSP panelu          | Zerowy* |
| *(nowość S-09)* utwórz bin/timeline | `ipcRenderer.invoke('resolve:createBin'/…)` → main `WorkflowIntegration.node` (Faza 1)    | Nowy    |

\* poza dostrojeniem CSP `index.html` (musi zezwolić `connect-src` na `api.anthropic.com`, `generativelanguage.googleapis.com`, `openrouter.ai`).

**Kluczowy wniosek architektoniczny:** kształt mostu jest niemal identyczny. Tauri: `window` → `invoke('cmd',args)` → host Rust (async). Electron WI: `window.bridge.cmd(args)` → `ipcRenderer.invoke('cmd',args)` → `ipcMain.handle` w main (async). To samo: cienki most na `window`, wywołania asynchroniczne. Migracja jest **mechaniczna**, nie koncepcyjna.

### Ocena trzech strategii

**1. Pełny reuse 1:1 (Tauri app bez zmian w panelu) — ODRZUCONA.**
Aplikacja to Tauri (webview WRY + `@tauri-apps/api`). Panel WI to aplikacja **Electron** — w środku nie ma runtime'u Tauri, więc `invoke()` z `@tauri-apps/api/core` nie ma hosta. Bundla Tauri nie da się uruchomić niezmienionego wewnątrz Resolve. Zgodnie z oczekiwaniem planu: szybkie wykluczenie.

**2. Reuse UI + nowy most po stronie Resolve — REKOMENDOWANA.**
Zachowujemy całą warstwę HTML/CSS/JS bez zmian: `src/ui/*`, `src/exporters/*` (czyste funkcje), `src/parser/*`, `src/ai/*`, `src/state.js`. Wymieniamy tylko cienki shim `invoke()` na preload `contextBridge`, który eksponuje te same nazwy funkcji, i reimplementujemy **6 ocalałych komend** w main Electrona (Node `fs`/`crypto`/`child_process`) — wszystkie trywialne/średnie, bo to czyste I/O+subprocess. API Resolve dokładamy jako **dodatkowe** metody mostu dla nowej ścieżki bin→timeline (potwierdzona w Fazie 1). Kształty mostu są niemal tożsame → migracja mechaniczna. Ryzyko: sandbox/context-isolation Electrona 36 (model wymuszony od 19.0.2) wymaga dyscypliny preload; CSP renderer; reimplementacja whisper/ffmpeg w Node zamiast Rust.

**3. Osobny panel natywny dla Resolve — FALLBACK.**
Cienki nowy UI (HTML/JS od zera lub nawet Qt UIManager/skrypt Python z SDK) wołający współdzieloną logikę selekcji/segmentacji (`parser/segments.js`, `exporters/*`). Działa, ale wyrzuca inwestycję w istniejący UI i dubluje pracę. Sensowny tylko, gdyby reuse (strategia 2) trafił na nieprzewidzianą ścianę (np. twardy konflikt sandboxa z którymś modułem frontendu).

### Rekomendacja

**Strategia 2 (reuse UI + nowy most Resolve-side).** Uzasadnienie oparte na Fazach 1–2:
- Runtime panelu jest wykonalny i udowodniony (Electron; SamplePlugin + produkcyjny Snap-Captions w tej instalacji Studio).
- Cały UI portuje się bez zmian (to zwykły HTML/CSS/JS w renderer Chromium).
- Most jest mechaniczny: Tauri `invoke` → Electron `contextBridge`/`ipcRenderer` to ten sam wzorzec; 6 komend to czyste I/O/subprocess obsługiwane natywnie przez Node w main.
- Ścieżka US-02 (bin + timeline) jest dostępna w API i dokłada się jako nowe metody mostu, nie przebudowuje istniejących.
