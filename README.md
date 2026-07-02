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
