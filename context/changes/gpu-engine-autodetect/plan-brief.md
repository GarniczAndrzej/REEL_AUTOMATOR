# Autodetekcja silnika GPU — skrót planu

> Pełny plan: `context/changes/gpu-engine-autodetect/plan.md`
> Research: `context/changes/gpu-engine-autodetect/research.md`

## Co i po co

Ścieżka GPU na Windows jest dziś ślepym zaułkiem: wpis `engine-gpu-windows-x86_64` w `src/deps/deps-spec.json` ma zastępczy URL `RELEASE_HOST` i puste `sha256`, na którym downloader celowo zatrzymuje się fail-closed. Żadna maszyna nigdy nie uruchomiła silnika GPU.

Research zmierzył wyjście na prawdziwym sprzęcie: artefakt 3,08 GB to przypadek pakowania, nie wymóg. Transkrypcję wykonuje CTranslate2, którego zwykłe koło z PyPI jest już CUDA-capable i potrzebuje wyłącznie dwóch bibliotek cuBLAS. Torch jest potrzebny tylko do wyrównania wav2vec2 i diaryzacji pyannote. Zamrożenie **CT2-CUDA + torch-CPU + cuBLAS** daje plik **983,7 MB** — mieści się pod limitem 2 GB na zasób w GitHub Releases, z ~1 GB zapasu.

Dzięki temu artefakt można hostować i przypiąć SHA-256 przez **istniejący** downloader z S-29, zachowując kotwicę zaufania (`validate_hashes()`, `deps.rs:809`) w całości. Bez lokalnego budowania, bez provisioningu Pythona, bez osłabiania łańcucha dostaw.

## Punkt wyjścia

Silnik nie widzi własnej CUDA: `_detect_device()` (`whisperx_engine.py:131`) pyta `torch.cuda.is_available()`, co pod torch-CPU jest trwale `False` — zamrożony plik z researchu raportował `"gpu": false`, mając w środku działającą CUDA. Wykrywanie sprzętu to pojedynczy `nvidia-smi -L` → `bool` (`deps.rs:219`), niezdolny zobaczyć kartę AMD ani Intela. `gpu_sidecar_present()` (`engine.rs:30`) ignoruje staged deps root, choć `engine_bin_path()` (`engine.rs:201`) go czyta — więc silnik GPU zainstalowany wyłącznie przez downloader byłby uruchamiany jako GPU, a odznaka pokazywałaby CPU. Dodatkowo dwa błędy trzymają okno ZALEŻNOŚCI zamknięte: `transcription_ready` jest ślepe na wariant, a `edl_deps_setup_dismissed` nigdy nie wygasa.

## Stan docelowy

Na maszynie z NVIDIĄ i sterownikiem powyżej progu CUDA 12.x pierwsze uruchomienie otwiera okno ZALEŻNOŚCI, które po polsku podaje: jaka karta, ile VRAM, jaki sterownik i dlaczego wybrano wariant GPU. Użytkownik pobiera ~984 MB zweryfikowane po SHA-256; tania sonda potwierdza, że CUDA się inicjalizuje i cuBLAS się ładuje. Transkrypcja idzie na GPU, wyrównanie i diaryzacja na torch-CPU.

Na maszynie z Radeonem lub Intelem to samo okno mówi to wprost — z nazwą karty — i wyjaśnia, że silnik transkrypcji jej nie obsługuje, więc zainstalowano wariant CPU. Jeśli CUDA mimo wszystko padnie przy pierwszej realnej transkrypcji, aplikacja ponawia raz na CPU, zapisuje werdykt „GPU nieużywalne na tej maszynie" i informuje o tym. Użytkownik nigdy nie trafia w ślepy zaułek.

## Kluczowe decyzje

| Decyzja | Wybór | Dlaczego | Źródło |
| --- | --- | --- | --- |
| Kształt artefaktu | Utrzymać podział CPU/GPU; cuBLAS wpieczony w exe GPU (~984 MB) | To dokładnie ta konfiguracja, którą research zbudował i zmierzył; schemat `deps-spec.json` i downloader zostają nietknięte, użytkownicy CPU zachowują 464 MB | Plan |
| Koszt wyrównania na CPU | Zmierzyć w bramce Fazy 1 + zaprojektować furtkę `engine-gpu-full` | Cała argumentacja o rozmiarze opiera się na liczbie, której nikt nie ma; pomiar kosztuje jedno popołudnie | Plan |
| Głębokość detekcji | `nvidia-smi --query-gpu` (nazwa, VRAM, compute cap, sterownik); bramka tylko na progu sterownika | Ten sam pojedynczy zmemoizowany spawn, ale daje uczciwe polskie zdanie; próg sterownika to liczba opublikowana, próg compute cap byłby wymyślony | Plan |
| Próg sterownika | Windows `527.41` (zgodność minor-version CUDA 12.x) | Tablica 2 release notes CUDA: pasmo `>= 525 && < 580`. `575.51.03` to sterownik dołączony do 12.9, nie próg | Plan |
| Weryfikacja po instalacji | Tania sonda (`get_cuda_device_count` + preload cuBLAS) **plus** siatka bezpieczeństwa w runtime | Sonda łapie udokumentowaną awarię ładowania cuBLAS; siatka łapie `no kernel image available`, czego żadna tania sonda nie wykryje | Research + Plan |
| AMD / Intel | Enumeracja DXGI przez crate `windows` | Jedyny mechanizm odróżniający „obecny Radeon, nieobsługiwany" od „brak GPU" — czyli różnica między uczciwym a mylącym komunikatem | Plan |
| `transcription_ready` | Bez zmian; nowe `variant_satisfied` napędza wyłącznie auto-otwarcie | Wyłączenie działającego silnika CPU po to, by reklamować szybszy, byłoby regresją i zablokowałoby każdy checkout `tauri dev` | Plan |
| Zakres odrzucenia okna | Klucz `{ specVersion, variant }` | Zmiana zestawu zależności albo sprzętu otwiera okno raz; poprawnie wyposażona maszyna nigdy nie jest nagabywana | Plan |
| Furtka `engine-gpu-full` | Zaprojektowana, wysłana fail-closed, aktywowana tylko jeśli pomiar tego zażąda | Fail-closed downloader czyni uśpiony wpis dowodnie nieszkodliwym — dokładnie to robi dziś dla wpisu GPU | Plan |

## Zakres

**W zakresie:** przebudowa silnika GPU (CT2-CUDA + torch-CPU + cuBLAS); rozdzielenie urządzenia CT2 od urządzenia torch; hook preloadujący cuBLAS; `build.sh` bez `.venv-gpu`, cuBLAS z przypiętego koła `nvidia-cublas-cu12` (win_amd64); hosting + przypięcie SHA-256; uczciwy profil sprzętu (NVIDIA + DXGI dla AMD/Intel); próg sterownika; naprawa `gpu_sidecar_present`; sonda po instalacji + jednorazowy fallback na CPU w runtime; panel sprzętowy po polsku; naprawa obu błędów auto-otwarcia; jawny przycisk „Ponów" (F4 z plan-review).

**Poza zakresem:** budowanie czegokolwiek na maszynie użytkownika (Open Question #1 rozstrzygnięte — hosting działa); akceleracja ROCm/AMD (upstreamowe błędy CT2 #2016 i #2021, brak sprzętu w zespole); zamiana silnika ASR na whisper.cpp + Vulkan (FR-002 wymaga wymuszonego wyrównania zewnętrznego transkryptu); hosting `engine-gpu-full` w tej zmianie; wystawienie `gpu-full` w UI (tylko `REEL_ENGINE_VARIANT`); wznawianie pobierania HTTP-range; parser, eksportery, selekcja, matematyka klatek; macOS.

## Architektura / podejście

Silnik przestaje mieć jedno `device`, a zaczyna mieć dwa: `ct2_device` sondowane przez `ctranslate2.get_cuda_device_count()` i `torch_device` sondowane przez `torch.cuda.is_available()` / MPS. Mogą się prawomocnie różnić (`cuda` / `cpu` w wysyłanym buildzie GPU). Szew, który to umożliwia, whisperx już udostępnia: `model = model or WhisperModel(...)` (`whisperx/asr.py:357`) — gotowy `WhisperModel` na CUDA trafia jako `model=`, a `load_model` dostaje `vad_device` dla VAD na torch-CPU.

Konsekwencja warta odnotowania: `--device` nadpisuje **wyłącznie** urządzenie CT2, więc ten sam kod źródłowy obsługuje wszystkie trzy warianty — uśpiony build `engine-gpu-full` dostaje wyrównanie na GPU za darmo, bo w jego wnętrzu `torch.cuda.is_available()` jest po prostu prawdą.

Po stronie Rusta `resolve_variant` zachowuje czystość i testowalność; jego trzeci parametr zmienia znaczenie z `gpu_present` na `gpu_usable`. DXGI pozostaje **sygnałem wyłącznie raportującym** — obecność karty nigdy nie decyduje o wariancie.

## Fazy w skrócie

| Faza | Co dostarcza | Główne ryzyko |
| --- | --- | --- |
| 1. Rozdzielenie urządzeń, pakowanie cuBLAS, bramka pomiarowa | Zamrożony artefakt GPU ~984 MB + zmierzone czasy faz | Wyrównanie na CPU może zdominować czas — to jedyne nośne, niezmierzone założenie |
| 2. Hosting, przypięcie, spec | Prawdziwy URL + SHA-256; uśpiony wpis `engine-gpu-full` | Hosting gigabajta jest trudno odwracalny; suma kontrolna musi zgadzać się co do bajtu |
| 3. Uczciwa detekcja sprzętu | `gpu_info()`, próg sterownika, DXGI; naprawa `gpu_sidecar_present` | Zmiana sygnatury `engine_sidecar()` promieniuje na klucz cache i odznakę |
| 4. Weryfikacja po instalacji + siatka runtime | Sonda `--capability` + jednorazowe ponowienie na CPU | Interakcja ponowienia z anulowaniem — najbardziej ryzykowna logika w tej zmianie |
| 5. Okno ZALEŻNOŚCI | Panel sprzętowy PL, auto-otwarcie świadome wariantu, zakres odrzucenia, „Ponów" | Migracja starego `'1'` w localStorage |

**Wymagania wstępne:** S-29 (spec, downloader, bramka sum kontrolnych, deps root, `detect_variant()`, UI ZALEŻNOŚCI); maszyna z NVIDIĄ do pomiaru; dostęp do repozytorium `GarniczAndrzej/reel-automator-deps`.

**Szacowany wysiłek:** ~4–6 sesji przez 5 faz; Faza 1 zdominowana czasem zamrażania PyInstallera (10–30 min na build) i pomiarem.

## Otwarte ryzyka i założenia

- **Wyrównanie i diaryzacja przechodzą na torch-CPU.** Jeśli zdominują czas, przypięty artefakt jest już wyhostowany, a jedynym wyjściem jest koło torch cu128 (3,5 GB) — czyli powrót ponad limit 2 GB. Bramka B w Fazie 1 istnieje właśnie po to.
- **Ścieżka AMD/Intel nigdy nie zobaczy prawdziwego Radeona przed użytkownikami.** Pokrywają ją testy jednostkowe nad zamockowanym vendor id; literówka w stałej by się wysłała.
- **Tania sonda nie dowodzi, że CUDA działa.** `get_cuda_device_count() > 0` dowodzi sterownika, udany preload dowodzi bibliotek. Żadne nie dowodzi, że sterownik ma obrazy jąder dla architektury tej karty — stąd siatka w runtime.
- **Zamrożone onefile rozpakowuje się do `%TEMP%` przy każdym spawnie.** Użytkownicy GPU płacą ~984 MB ekstrakcji za każdym uruchomieniem silnika, mniej więcej dwukrotność builda CPU.
- **`specVersion` 1 → 2 otworzy okno raz każdemu istniejącemu użytkownikowi.** To zamierzone, ale będzie wyglądać jak regresja, jeśli nikt tego nie zapowie.
- **cuBLAS 12.9 z PyPI wobec bibliotek 12.8, na których mierzył research.** Ta sama główna wersja soname, ale plan przypina linię 12.8 i zapisuje SHA-256 koła, żeby build był odtwarzalny.

## Kryteria sukcesu (skrót)

- Prawdziwy reel transkrybuje się od początku do końca przez zainstalowany exe GPU na RTX 5070 Ti, z `device: "cuda"` w payloadzie — dowód CUDA **przez zamrożony plik**, nie tylko w venv
- Wyczyszczony deps root pobiera i weryfikuje ~984 MB po SHA-256, a sonda potwierdza cuBLAS
- Właściciel Radeona widzi po polsku nazwę swojej karty i powód wyboru wariantu CPU — zamiast ciszy
- Maszyna, która pominęła okno, nie jest nagabywana; maszyna, która zmieniła sprzęt albo zestaw zależności, widzi je raz
- `node --experimental-vm-modules test/regression.js` pozostaje zielony przed i po
