# Reels EDL Automator

Aplikacja desktopowa (macOS), która zamienia pliki napisów na osie montażowe dla edytorów
wideo. Transkrybuje wideo lokalnie (WhisperX), wykorzystuje model LLM do wyboru najlepszych
momentów na „rolki" (reels) i eksportuje gotowe do importu osie czasu jako **EDL**,
**FCP XML** lub **DaVinci Resolve Lua**.

Zbudowana w Tauri 2 (backend w Rust + frontend Vite/vanilla-JS). Cały interfejs jest po polsku.

---

## Instalacja (dla użytkowników)

### Wymagania

| Wymaganie | Dlaczego |
| --- | --- |
| **Mac z procesorem Apple Silicon** (M1 / M2 / M3 / M4) | Aplikacja zawiera komponenty natywne tylko dla ARM. **Maki z procesorem Intel nie są jeszcze obsługiwane.** |
| **macOS 11 Big Sur lub nowszy** | Minimalna wersja wymagana przez Tauri 2 / WebView. |
| **Klucz API OpenRouter** | Potrzebny do etapu doboru rolek przez AI. Pobierz na https://openrouter.ai/keys |

Wszystko inne (FFmpeg, silnik transkrypcji WhisperX, modele wyrównania) jest **dołączone
wewnątrz aplikacji** — nie trzeba instalować niczego więcej.

### Kroki

1. **Pobierz** najnowszy plik `reel-automator_x.y.z_aarch64.dmg` ze strony
   [Releases](../../releases).
2. **Otwórz plik DMG** i przeciągnij **reel-automator** do folderu **Aplikacje**.
3. **Pierwsze uruchomienie — ominięcie Gatekeepera.** Aplikacja nie jest (jeszcze)
   notaryzowana przez Apple, więc zwykłe dwukrotne kliknięcie pokaże komunikat
   *„reel-automator jest uszkodzony / nie można otworzyć"*. To normalne dla niepodpisanych
   aplikacji — plik **nie jest** w rzeczywistości uszkodzony. Aby otworzyć:
   - **Kliknij prawym przyciskiem** (lub Ctrl-klik) na aplikację → **Otwórz** → potwierdź
     **Otwórz** w oknie dialogowym.
   - Jeśli to nie pomoże, uruchom raz w **Terminalu**:
     ```bash
     xattr -dr com.apple.quarantine /Applications/reel-automator.app
     ```
   Trzeba to zrobić **tylko raz** — potem aplikacja otwiera się normalnie.
4. **Dodaj klucz API.** Otwórz aplikację → **Ustawienia** → wklej klucz API **OpenRouter**.
   (Opcjonalnie: klucz HuggingFace, jeśli chcesz rozpoznawanie mówców / diaryzację.) Klucz
   jest przechowywany bezpiecznie w **Pęku kluczy macOS (Keychain)** — nigdy nie opuszcza
   Twojego komputera i nie jest częścią żadnego pliku do pobrania.

To wszystko. Transkrypcja działa **offline** na Twoim Macu; tylko etap doboru rolek przez AI
łączy się z OpenRouter.

> **Uwaga o szybkości:** pierwsza transkrypcja po uruchomieniu jest wolna (~40–70 s),
> ponieważ dołączony silnik rozpakowuje się i ładuje PyTorch przy zimnym starcie. To normalne.

---

## Budowanie ze źródeł (dla programistów)

### Wymagania wstępne

- **macOS na Apple Silicon**
- **Rust** przez [rustup](https://rustup.rs) (`cargo` w PATH)
- **Node.js** 20+ oraz **npm**
- **Python 3.10 lub 3.11** (sidecar WhisperX wymaga tego zakresu; 3.12+ może zepsuć paczki torch/whisperx)

### Konfiguracja

Duże pliki natywne są **wykluczone z gita** i nieobecne w świeżym klonie — trzeba je pobrać
i zbudować, w przeciwnym razie build Tauri zakończy się błędem brakującego `externalBin`:

```bash
git clone <repo-url> REEL_AUTOMATOR
cd REEL_AUTOMATOR

npm install

# 1. Pobierz statyczny sidecar FFmpeg (~52 MB)
sidecar/fetch-ffmpeg.sh

# 2. Zbuduj sidecar silnika WhisperX + przygotuj modele wyrównania (~290 MB, chwilę trwa)
sidecar/build.sh

# 3. Uruchom w trybie deweloperskim
npm run tauri dev
```

### Najczęstsze polecenia

```bash
# Tryb dev (serwer Vite + okno Tauri)
npm run tauri dev

# Build produkcyjny → tworzy .app + .dmg w src-tauri/target/
npm run tauri build

# Tylko sprawdzenie typów Rust (szybkie)
~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml

# Testy regresyjne (poprawność parsera + eksporterów)
node --experimental-vm-modules test/regression.js

# Formatowanie
npx prettier --write "src/**/*.{js,css,html}"
```

---

## Wtyczka do DaVinci Resolve (Workflow Integration)

Oprócz samodzielnej aplikacji projekt zawiera **wtyczkę Workflow Integration (WI) do
DaVinci Resolve** (`resolve-plugin/`) — ten sam interfejs Reels Automator, ale osadzony
jako panel **wewnątrz DaVinci Resolve Studio**. Zamiast eksportować plik EDL/XML/Lua i
importować go ręcznie, wtyczka steruje projektem Resolve bezpośrednio przez skryptowe API:

- **Rolki → oś czasu** — tworzy w otwartym projekcie jedną oś czasu ze wszystkimi rolkami
  (rozdzielonymi ustawioną przerwą), z markerami — bez eksportu pliku pośredniego.
- **Napisy** — wstawia napisy na ścieżkę napisów, startując od punktu In osi czasu.
- **Transkrypcja (WhisperX)** — ta sama lokalna transkrypcja co w aplikacji desktopowej.
- **Audio z osi czasu Resolve** — przycisk „Z osi czasu Resolve" renderuje audio zakresu
  In/Out bieżącej osi czasu (przez preset renderowania) i podaje je do transkrypcji.

### Wymagania

- **DaVinci Resolve Studio** — panele Workflow Integration działają tylko w wersji **Studio**
  (płatnej), nie w darmowym DaVinci Resolve.
- **Mac z Apple Silicon** oraz natywny plik pomostowy `WorkflowIntegration.node` z pakietu
  DaVinci Resolve Developer SDK (dołączony do instalacji Resolve Studio).

### Budowanie i instalacja (dla programistów)

Wtyczka WI to zwykły **folder**, który hostuje sam Resolve (HTML/JS + backend Node +
natywny `WorkflowIntegration.node`) — nie jest osobną aplikacją `.app`, więc nie ma czego
podpisywać. Zbuduj i zainstaluj jednym skryptem z katalogu repozytorium:

```bash
# Zbuduj renderer + zainstaluj wtyczkę do katalogu WI Resolve
sidecar/install-resolve-plugin.sh
```

Skrypt: buduje frontend (`npm run build:resolve`), kopiuje pliki wtyczki do
`/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/Reels-Automator/`,
tworzy dowiązanie `binaries` → `src-tauri/binaries` (sidecary FFmpeg/WhisperX nie są
kopiowane, tylko linkowane) i czyści atrybut kwarantanny.

> **Zanim uruchomisz skrypt:** upewnij się, że masz pobrane sidecary (`sidecar/fetch-ffmpeg.sh`
> + `sidecar/build.sh`) oraz skopiowany `resolve-plugin/WorkflowIntegration.node` z SDK Resolve
> (`…/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/`). Bez pliku
> pomostowego panel się załaduje, ale zgłosi, że Resolve jest niedostępny.

Resolve skanuje katalog wtyczek tylko przy starcie — po instalacji **całkowicie zamknij
(⌘Q) i uruchom ponownie DaVinci Resolve**, następnie otwórz
**Workspace → Workflow Integrations → Reels Automator**.

Szczegóły techniczne (układ katalogów, przywracanie plików wykluczonych z gita) opisuje
`resolve-plugin/README.md`.

---

## Obsługiwane platformy

| Platforma | Status |
| --- | --- |
| macOS — Apple Silicon | ✅ Obsługiwana |
| macOS — Intel (x86_64) | ❌ Jeszcze nie — wymaga buildów sidecarów x86_64 |
| Windows | 🚧 Port w toku — zob. `context/foundation/windows-port-guide.md` |

---

## Uwagi o dystrybucji

Wydawany plik DMG jest obecnie **niepodpisany i nienotaryzowany** — dlatego pierwsze
uruchomienie wymaga kroku prawy przycisk → Otwórz opisanego powyżej. Aby dostarczyć build
typu „kliknij dwa razy i po prostu działa" dla nietechnicznych użytkowników, aplikacja wraz
z dołączonymi sidecarami musi zostać podpisana certyfikatem Apple Developer ID i
notaryzowana przez Apple. Ta praca nie jest jeszcze wykonana.
