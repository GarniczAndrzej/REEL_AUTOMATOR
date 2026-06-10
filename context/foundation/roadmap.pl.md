---
project: Reels Automator
version: 1
status: draft
created: 2026-06-10
updated: 2026-06-10
prd_version: 1
main_goal: quality
top_blocker: decisions
language: pl
source: roadmap.md
---

# Roadmapa: Reels Automator

> Wyprowadzona z `context/foundation/prd.md` (v1) + automatycznie zbadana baza kodu.
> Edytuj w miejscu; archiwizuj, gdy zostanie zastąpiona.
> Wycinki (slices) poniżej są ułożone w kolejności zależności. Tabela „W skrócie” jest indeksem.
> Polskie tłumaczenie pliku `roadmap.md` (wersja kanoniczna). Identyfikatory zmian, oznaczenia FR/US i statusy pozostają w oryginale jako klucze techniczne.

## Przypomnienie wizji

Reels Automator przechodzi od „transkrypcja + selekcja + render” do **narzędzia z transkrypcją lokalną (local-first) i selekcją AI, którego jedynym produktem jest czysta oś montażowa (editing timeline)** przekazywana do własnego NLE montażysty. Ścieżka renderowania MP4 przez FFmpeg oraz wszystkie elementy edytora wideo w aplikacji (kadrowanie 9:16, logo, wypalanie napisów, macierz kodeków, kolejka renderowania, śledzenie twarzy) to dziedzictwo (legacy) do usunięcia. Ponieważ aplikacja już nie renderuje, jej **klin produktowy (product wedge)** — jedna cecha, której usunięcie sprawiłoby, że stałaby się nieodróżnialna od zwykłego narzędzia do transkrypcji — to *dokładna, samowystarczalna selekcja momentów z cięciami przypiętymi do rzeczywistych granic słów*, przetwarzana w pełni na urządzeniu (poza maszynę trafia wyłącznie tekst transkrypcji).

## Gwiazda północna (North star)

**S-01: Punktowana selekcja → eksport czystego EDL** — to kamień milowy walidacji, ponieważ udowadnia klin produktowy od początku do końca na realnym materiale: nagranie staje się punktowanymi przez AI reelami, które eksportują się jako oś montażowa importująca się czysto do NLE, bez renderowania jakiegokolwiek MP4.

> „Gwiazda północna” oznacza tu najmniejszy wycinek end-to-end, którego udane dostarczenie udowodniłoby kluczową hipotezę produktową — umieszczony tak wcześnie, jak pozwalają na to warunki wstępne, bo wszystko inne ma znaczenie tylko wtedy, gdy to działa. S-01 celowo działa na *istniejącej* ścieżce transkrypcji, by pętlę selekcja→eksport udowodnić zanim pojawi się cięższy silnik WhisperX (S-05).

## W skrócie

| ID    | Change ID                   | Efekt (użytkownik może …)                                          | Warunki wstępne      | Odniesienia PRD                                      | Status   |
| ----- | --------------------------- | ------------------------------------------------------------ | ------------------ | --------------------------------------------- | -------- |
| F-01  | remove-render-path          | (fundament) usunięta ścieżka renderowania FFmpeg; bariera regresji na zielono | —               | FR-038                                        | ready    |
| F-02  | resolve-plugin-spike        | (fundament) zapisana decyzja o wykonalności wtyczki Resolve   | —                  | FR-030 (bramki), US-02                         | ready    |
| S-01  | scored-selection-edl        | otrzymać reele AI punktowane wg Hook/Flow/Value/Trend i wyeksportować czysty EDL | F-01        | FR-010, FR-011, FR-012, FR-014, FR-017, FR-018, FR-026, FR-033 | proposed |
| S-02  | scoring-first-reel-list     | segregować reele na liście posortowanej wg wyniku, z uzasadnieniami | S-01               | FR-020                                        | proposed |
| S-03  | prompt-presets              | edytować prompt systemowy i zarządzać presetami promptów    | S-01               | FR-015, FR-016                                | proposed |
| S-04  | segment-tuning-ops          | zmieniać kolejność, łączyć, usuwać segmenty i wycinać słowa-wypełniacze     | S-01               | FR-022, FR-023                                | proposed |
| S-05  | builtin-whisperx-transcription | transkrybować lokalnie z wyrównaniem na poziomie słów + zarządzać modelami | F-01            | FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007 | proposed |
| S-06  | word-level-boundary-trim    | precyzyjnie korygować granice cięć na poziomie słów ze snap-do-pauzy    | S-04, S-05         | FR-021                                        | proposed |
| S-07  | auto-mode-pipeline          | uruchomić cały potok jednym kliknięciem z etapowym postępem     | S-01, S-05         | FR-008, FR-009                                | proposed |
| S-08  | timeline-export-set         | eksportować Premiere XML, FCPXML i Resolve Lua (ze znacznikami)   | S-01               | FR-027, FR-028, FR-029                        | proposed |
| S-09  | resolve-plugin-handoff      | przekazać reele do Resolve z wnętrza Resolve jednym kliknięciem  | S-01, S-08, F-02   | FR-030, FR-031, US-02                         | blocked  |
| S-10  | en-pl-i18n                  | przełączać cały interfejs między angielskim a polskim           | S-02, S-04         | FR-034                                        | proposed |
| S-11  | keychain-credentials        | przechowywać klucze API w keychainie systemu, nigdy w plaintext           | —                  | FR-035                                        | ready    |
| S-12  | empty-error-states          | widzieć jawne stany puste/błędu zamiast cichych awarii   | S-01, S-05         | FR-036                                        | proposed |
| S-13  | keyboard-navigation         | obsługiwać przegląd i strojenie w całości z klawiatury           | S-02, S-04         | FR-037                                        | proposed |
| S-14  | selection-quality-flags     | otrzymać flagi grupowania źródeł i wiszących odniesień            | S-01               | FR-013, FR-025                                | proposed |
| S-15  | reel-preview-playback       | podejrzeć odtwarzanie reela zsynchronizowane z jego listą segmentów    | S-04               | FR-024                                        | proposed |

## Strumienie (Streams)

Pomoc nawigacyjna — grupuje elementy współdzielące łańcuch warunków wstępnych. Kanoniczna kolejność wciąż żyje w grafie zależności poniżej; ta tabela to proponowana kolejność czytania w poprzek równoległych ścieżek.

| Strumień | Temat                       | Łańcuch                                                        | Notatka                                                                 |
| ------ | --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| A      | Pokład selekcji i eksportu     | `F-01` → `S-01` → `S-02` / `S-03` / `S-04` → `S-08` → `S-14` / `S-15` | Kręgosłup gwiazdy północnej; cel jakości stoi na czele pętli punktowanej selekcji. |
| B      | Transkrypcja lokalna         | `S-05` → `S-06` / `S-07` / `S-12`                           | Odgałęzia od `F-01`; wyrównanie na poziomie słów odblokowuje kryterium dokładności cięć. |
| C      | Integracja z Resolve         | `F-02` → `S-09`                                             | Najpierw spike (główny bloker = decyzje); `S-09` dołącza do Strumienia A przy `S-08`. |
| D      | i18n, bezpieczeństwo i klawiatura   | `S-11` / `S-10` / `S-13`                                    | `S-11` gotowy samodzielnie; `S-10` i `S-13` dołączają do Strumienia A przy `S-04`. |

## Baza (Baseline)

Co jest już obecne w bazie kodu na dzień 2026-06-10 (zbadane automatycznie + potwierdzone przez użytkownika).
Fundamenty poniżej zakładają, że to istnieje, i NIE odbudowują tego od zera.

- **Frontend:** obecny — vanilla JS + Vite, potok `src/ui/stepN-*.js` nad jednym `state.js` pub/sub.
- **Backend / API:** obecny — komendy Rust Tauri 2 zarejestrowane w `src-tauri/src/lib.rs`.
- **Dane / trwałość:** obecne — `.reelproj` JSON (schema v2) przez `src-tauri/src/project.rs`, domyślne serde dla wstecznej zgodności.
- **Transkrypcja:** częściowa — `src-tauri/src/whisper.rs` woła `whisper-cli` z PATH (nie zbundlowany, bez wbudowanego wyrównania na poziomie słów, bez diaryzacji). Przebudowane przez S-05.
- **Selekcja AI:** częściowa — `src/ai/providers.js` + `prompt.js` istnieją, ale schemat to STARY kształt title/hook/description: bez `virality_score`, bez znaczników `hook/body/punchline`, bez cache'owania promptów `cache_control`. Przebudowane przez S-01.
- **Poświadczenia:** plaintext — klucze API żyją w `localStorage` (`edl_apikey_*`); brak keychaina systemu. Migrowane przez S-11.
- **i18n:** brak — wszystkie napisy interfejsu zakodowane na sztywno po polsku; brak warstwy kluczy tłumaczeń. Dodane przez S-10.
- **Ścieżka renderowania:** obecna — pełny render filter-graph FFmpeg + kolejka + śledzenie twarzy. Usunięte przez F-01 (FR-038).
- **Deploy / infra:** obecne — bundle desktopowy Tauri, tylko macOS, sidecar FFmpeg z sufiksem architektury; brak CI.
- **Obserwowalność:** nie dotyczy — lokalne, jednoużytkownikowe narzędzie desktopowe.

## Fundamenty (Foundations)

### F-01: Usunięcie ścieżki renderowania + bariera regresji

- **Efekt:** (fundament) render filter-graph FFmpeg, UI/zakładka renderowania, kolejka renderowania, wykrywanie enkodera sprzętowego, wypalanie napisów, nakładka logo i klatki kluczowe śledzenia twarzy zostają usunięte; zbundlowany sidecar FFmpeg jest zachowany (wciąż używany do ekstrakcji audio + miniatur); zestaw regresyjny przechodzi przed i po, dowodząc że potok selekcja → segment → eksport przetrwał.
- **Change ID:** remove-render-path
- **Odniesienia PRD:** FR-038; bariery ochronne (zachowany potok, matematyka całkowitoklatkowa, wczytywanie `.reelproj`)
- **Odblokowuje:** S-01 (kurczy powierzchnię konsumentów zmiany schematu — brak ścieżek `renderConfig`, przez które trzeba przeprowadzić `virality_score`); barierę regresji, na której polega każda bariera „nie wolno zregresować”.
- **Warunki wstępne:** —
- **Równolegle z:** F-02
- **Blokery:** —
- **Niewiadome:** —
- **Ryzyko:** Duże usunięcie — niebezpieczeństwem jest ciche zepsucie potoku eksportu lub wczytywania `.reelproj`. Uruchom `node --experimental-vm-modules test/regression.js` przed i po; zestaw jest jedynym automatycznym strażnikiem. Sekwencjonowane jako pierwsze, by krytyczna dla jakości praca lądowała na odchudzonej, ogrodzonej bazie kodu.
- **Status:** ready

### F-02: Spike runtime'u wtyczki Resolve

- **Efekt:** (fundament) zapisana decyzja odpowiadająca, czy runtime DaVinci Resolve Workflow Integration (API DaVinciResolveScript, hosting panelu, pakowanie) jest wykonalny i czy istniejący frontend Tauri może być w nim ponownie użyty — wraz z określonym kontraktem integracji, jeśli odpowiedź brzmi tak.
- **Change ID:** resolve-plugin-spike
- **Odniesienia PRD:** FR-030 (bramki), US-02, PRD Pytanie Otwarte #2
- **Odblokowuje:** redukuje blokującą niewiadomą na S-09; zamienia „czy ta sztandarowa funkcja jest w ogóle budowalna?” w zatwierdzoną/odłożoną decyzję.
- **Warunki wstępne:** —
- **Równolegle z:** F-01 oraz całą budową Strumieni A/B (badanie, nie budowa).
- **Blokery:** —
- **Niewiadome:** Czy frontend Tauri może hostować się wewnątrz panelu Resolve Workflow Integration, czy wtyczka potrzebuje osobnego runtime'u? — Właściciel: użytkownik. Blokuje: nie (ten fundament JEST rozwiązaniem; sam na nic nie czeka).
- **Ryzyko:** To pojedyncza największa niewiadoma techniczna projektu. Zrobienie tego jako wczesnego, równoległego spike'u (główny bloker = decyzje) zapobiega zobowiązaniu S-09 do wycinka dostawczego zanim wykonalność jest znana. Jeśli odpowiedź to „niewykonalne”, S-09 wraca do awaryjnego eksportu plików (S-08) i zostaje odłożony.
- **Status:** ready

## Wycinki (Slices)

### S-01: Punktowana selekcja AI → eksport czystego EDL  (★ gwiazda północna)

- **Efekt:** Montażysta uruchamia selekcję AI na transkrypcji i otrzymuje reele, z których każdy niesie `virality_score` (Hook/Flow/Value/Trend) + jednoliniowy `reason` + znaczniki `hook/body/punchline`, może ręcznie edytować JSON reeli i eksportuje CMX3600 `.edl`, który importuje się czysto do NLE z zachowanymi znacznikami.
- **Change ID:** scored-selection-edl
- **Odniesienia PRD:** FR-010, FR-011, FR-012, FR-014, FR-017, FR-018, FR-026, FR-033; NFR (powtarzalność, cache'owanie promptów, walidacja-przed-użyciem)
- **Warunki wstępne:** F-01
- **Równolegle z:** S-05, S-11
- **Blokery:** —
- **Niewiadome:**
  - Czy dodanie `virality_score` + znaczników do schematu Reel psuje zgodność importu EDL/`.reelproj`? — Właściciel: zespół. Blokuje: nie (pokryte barierą regresji + domyślnymi serde).
- **Ryzyko:** Zmiana schematu LLM w `src/ai/prompt.js` dotyka każdego konsumenta (providers, edytor step-2, eksportery) — obowiązuje reguła z CLAUDE.md „zaktualizuj każdego konsumenta + grep nazwy pola”. Waliduj odpowiedź przed użyciem (FR-018), by żaden niezwalidowany obiekt nie dotarł do potoku eksportu. Ten wycinek JEST klinem; poprawność tutaj to produkt.
- **Status:** proposed

### S-02: UI listy reeli „najpierw wynik”

- **Efekt:** Montażysta widzi reele jako listę z odznaką `virality_score` przy każdym, sortowalną wg wyniku, jednoliniowym `reason` pod każdym reelem, a słabsze reele wizualnie wyszarzone, lecz wciąż wybieralne.
- **Change ID:** scoring-first-reel-list
- **Odniesienia PRD:** FR-020; US-01 („reele sortują się wg wyniku”)
- **Warunki wstępne:** S-01
- **Równolegle z:** S-03, S-04, S-08, S-14, S-11
- **Blokery:** —
- **Niewiadome:** —
- **Ryzyko:** Czyste UI nad schematem S-01; niskie ryzyko. Sekwencjonowane tuż po gwieździe północnej, bo punktowana lista to główna powierzchnia segregacji montażysty — wynik jest użyteczny tylko wtedy, gdy jest soczewką dla listy.
- **Status:** proposed

### S-03: Edytowalny prompt systemowy + presety

- **Efekt:** Montażysta edytuje (już nie zakodowany na sztywno) prompt systemowy, dostarcza prompt użytkownika i zarządza presetami promptów (zapisz-jako, duplikuj, usuń, edytuj; import/eksport jako `.json` przez wybór ścieżki); wbudowane presety startowe są dostarczane, a presety użytkownika trwają.
- **Change ID:** prompt-presets
- **Odniesienia PRD:** FR-015, FR-016
- **Warunki wstępne:** S-01
- **Równolegle z:** S-02, S-04, S-08, S-14, S-05, S-11
- **Blokery:** —
- **Niewiadome:** —
- **Ryzyko:** Trwałość presetów + import/eksport są proste; jedyna ostra krawędź to utrzymanie edytowalnego promptu w zgodzie ze stałym schematem JSON ustanowionym przez S-01 — dowolny prompt musi nadal wywoływać zwalidowany kształt.
- **Status:** proposed

### S-04: Strojenie segmentów — kolejność / łączenie / usuwanie / wycinanie wypełniaczy

- **Efekt:** Montażysta zmienia kolejność segmentów, łączy sąsiednie segmenty (suwak progu łączenia z sensowną wartością domyślną), usuwa segmenty i opcjonalnie wycina słowa-wypełniacze („yyy”, „eee”, …) na poziomie słów; zachowanie wypełniaczy jest przełączalne.
- **Change ID:** segment-tuning-ops
- **Odniesienia PRD:** FR-022, FR-023
- **Warunki wstępne:** S-01
- **Równolegle z:** S-02, S-03, S-08, S-14, S-05, S-11
- **Blokery:** —
- **Niewiadome:** —
- **Ryzyko:** `mergeAdjacentClips` pozostaje źródłem spanów eksportu; zmiana zachowania łączenia musi zachować nienaruszoną matematykę całkowitoklatkową i nie zregresować eksporterów (bariera regresji). Wycinanie wypełniaczy na poziomie słów jest best-effort dopóki S-05 nie dostarczy znaczników czasowych słów — tu dostarczany jest fallback na poziomie zdań.
- **Status:** proposed

### S-05: Wbudowana transkrypcja WhisperX + wyrównanie na poziomie słów + menedżer modeli

- **Efekt:** Montażysta importuje lokalne wideo metodą przeciągnij-i-upuść, uruchamia w pełni lokalną wbudowaną transkrypcję dającą tekst + wymuszone wyrównanie na poziomie słów bez osobnej instalacji, przegląda listę modeli (pobrane vs brakujące) i pobiera brakujący model (wybór ścieżki, %/prędkość/ETA), może zamiast tego zaimportować istniejący `.srt`/`.vtt`, może wyeksportować transkrypcję i otrzymuje transkrypcję auto-podzieloną na ponumerowane segmenty bez luk, zasilające selekcję bezpośrednio; diaryzacja działa w tym samym przebiegu jako opcja włączana (opt-in).
- **Change ID:** builtin-whisperx-transcription
- **Odniesienia PRD:** FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007
- **Warunki wstępne:** F-01
- **Równolegle z:** S-01, S-02, S-03, S-04, S-08, S-14, S-11
- **Blokery:** Token Hugging Face + dostęp do modelu pyannote dla opcjonalnej diaryzacji (zewnętrzne — tylko opt-in; rdzenna ścieżka transkrypcja + wyrównanie nigdy nie jest tym blokowana).
- **Niewiadome:**
  - Jak zbundlować WhisperX (+ wyrównanie) jako wbudowany silnik zastępujący `whisper-cli` z PATH i jak zmigrować/zachować istniejący kontrakt cache SRT+word-JSON? — Właściciel: zespół. Blokuje: nie (trudne zadanie budowy, nie niewiadoma wykonalności — ale rozbroić wcześnie).
- **Ryzyko:** Najcięższy wycinek na ścieżce jakości — wyrównanie na poziomie słów gwarantuje główne kryterium ~0%-w-środku-słowa. Wymiana silnika zmienia komendę transkrypcji, pakowanie i klucz/format cache; zachowaj lub zmigruj cache, by istniejące projekty nie transkrybowały od nowa.
- **Status:** proposed

### S-06: Korekta granic na poziomie słów + snap-do-pauzy

- **Efekt:** Montażysta koryguje granice segmentów dodając/odejmując czas z przodu/z tyłu z precyzją na poziomie słów, z uchwytem „przyciągnij do najbliższej pauzy/oddechu”.
- **Change ID:** word-level-boundary-trim
- **Odniesienia PRD:** FR-021
- **Warunki wstępne:** S-04, S-05
- **Równolegle z:** S-07, S-12, S-15
- **Blokery:** —
- **Niewiadome:**
  - Jaki sygnał definiuje „pauzę/oddech” do przyciągania — luki ciszy w czasie słów, czy sonda energii audio? — Właściciel: zespół. Blokuje: nie.
- **Ryzyko:** Zależy od znaczników czasowych słów z S-05; heurystyka snap to jedyna realna decyzja projektowa. Trzymaj całą arytmetykę całkowitoklatkową.
- **Status:** proposed

### S-07: Tryb auto jednym kliknięciem + etapowy postęp

- **Efekt:** Montażysta wyzwala automatyczny przebieg jednym kliknięciem (po ustawieniu klucza API, z potwierdzeniem), który napędza import → transkrypcję → wyrównanie → diaryzację → segmentację → selekcję AI i auto-przechodzi dalej, z możliwością powrotu do wcześniejszych kroków; pojedynczy ciągły etapowy wskaźnik postępu pokazuje % per etap, przycisk anulowania per etap i brak blokującego modala.
- **Change ID:** auto-mode-pipeline
- **Odniesienia PRD:** FR-008, FR-009
- **Warunki wstępne:** S-01, S-05
- **Równolegle z:** S-06, S-08, S-12
- **Blokery:** —
- **Niewiadome:** —
- **Ryzyko:** Orkiestracja nad wycinkami, które muszą już istnieć; ostre krawędzie to anulowalność w trakcie etapu i nieblokowanie okna. Sekwencjonowane po tym, jak oba silniki — selekcja (S-01) i transkrypcja (S-05) — są realne.
- **Status:** proposed

### S-08: Pełny zestaw eksportu osi — Premiere XML / FCPXML / Resolve Lua

- **Efekt:** Montażysta eksportuje FCP7 xmeml `.xml` (Premiere), `.fcpxml` (Final Cut Pro X, generowany osobno od xmeml) i skrypt konsoli DaVinci Resolve `.lua` — wszystkie niosące nowe znaczniki i importujące się czysto.
- **Change ID:** timeline-export-set
- **Odniesienia PRD:** FR-027, FR-028, FR-029
- **Warunki wstępne:** S-01
- **Równolegle z:** S-02, S-03, S-04, S-14
- **Blokery:** —
- **Niewiadome:**
  - Czy `.fcpxml` (nowy, odrębny format) potrzebuje własnego modelu znaczników/timecode w przeciwieństwie do eksportera xmeml? — Właściciel: zespół. Blokuje: nie.
- **Ryzyko:** XML i Lua to eksportery `preserved`, których struktura jest krucha i testowana importem w realnych NLE — dodanie znaczników nie może zepsuć importu. FCPXML jest zupełnie nowy. Rozszerz zestaw regresyjny o przypadek per format w tej samej zmianie.
- **Status:** proposed

### S-09: Wbudowana wtyczka DaVinci Resolve (przekazanie jednym kliknięciem)

- **Efekt:** Montażysta uruchamia Reels Automator z `Workspace → Workflow Integrations`, kończy selekcję we wbudowanym panelu, a jedno kliknięcie tworzy nowy datowany folder w bieżącym projekcie Resolve z każdym reelem jako osobną osią czasu i mediami źródłowymi w Media Pool — bez wklejania skryptu, bez importu plików; gdy API Resolve jest niedostępne, aplikacja automatycznie wraca do eksportu plików.
- **Change ID:** resolve-plugin-handoff
- **Odniesienia PRD:** FR-030, FR-031, US-02
- **Warunki wstępne:** S-01, S-08, F-02
- **Równolegle z:** S-10, S-13
- **Blokery:** —
- **Niewiadome:**
  - Czy runtime Workflow Integration jest wykonalny i czy frontend Tauri może być w nim ponownie użyty? — Właściciel: użytkownik. Blokuje: tak (rozwiązane przez F-02; do tego czasu tego wycinka nie da się zaplanować).
- **Ryzyko:** Sztandarowy wyróżnik i największe pojedyncze ryzyko techniczne. Pozostaje zablokowany dopóki F-02 nie zwróci werdyktu wykonalności; zestaw eksportu plików (S-08) jest zawsze dostępnym fallbackiem, więc produkt dostarcza nawet jeśli wtyczka nie powstanie.
- **Status:** blocked

### S-10: Internacjonalizacja EN/PL

- **Efekt:** Montażysta przełącza cały interfejs między angielskim a polskim; cały tekst UI pochodzi z kluczy tłumaczeń, a nie z napisów zakodowanych na sztywno.
- **Change ID:** en-pl-i18n
- **Odniesienia PRD:** FR-034
- **Warunki wstępne:** S-02, S-04
- **Równolegle z:** S-11, S-13, S-09
- **Blokery:** —
- **Niewiadome:** —
- **Ryzyko:** Przekrojowy refaktor ekstrakcji napisów dotykający każdego pliku UI. Sekwencjonowane po tym, jak istnieją nowe powierzchnie listy selekcji (S-02) i strojenia (S-04), by napisy wyekstrahować raz, a nie ponownie z UI, które dopiero ma być przepisane.
- **Status:** proposed

### S-11: Klucze API w keychainie systemu

- **Efekt:** Klucze API montażysty są przechowywane w bezpiecznym magazynie poświadczeń systemu (macOS Keychain / Windows Credential Manager) i nigdy nie są utrwalane w plaintext.
- **Change ID:** keychain-credentials
- **Odniesienia PRD:** FR-035
- **Warunki wstępne:** —
- **Równolegle z:** zasadniczo wszystkie wycinki (brak warunku wstępnego)
- **Blokery:** —
- **Niewiadome:** —
- **Ryzyko:** Dotyka każdego miejsca odczytu/zapisu klucza (`edl_apikey_*` w pickerze OpenRouter, selekcja step-2, panel porównania). Niskie ryzyko koncepcyjne; praca to znalezienie wszystkich miejsc wywołań. Niezależne od potoku selekcji, więc może działać kiedykolwiek jako równoległe zadanie hartowania.
- **Status:** ready

### S-12: Jawne stany puste/błędu

- **Efekt:** Montażysta widzi jawne stany puste/błędu zamiast cichych awarii: brak klucza API (AI zablokowane, transkrypcja wciąż działa), whisper/model niezainstalowany, niepoprawny JSON LLM, pusty projekt / brak reeli.
- **Change ID:** empty-error-states
- **Odniesienia PRD:** FR-036
- **Warunki wstępne:** S-01, S-05
- **Równolegle z:** S-06, S-07
- **Blokery:** —
- **Niewiadome:** —
- **Ryzyko:** Każdy stan należy do funkcji, która musi już istnieć (niepoprawny-JSON ↔ S-01, model-niezainstalowany ↔ S-05). Cienki przebieg konsolidacji; ryzykiem jest przeoczenie stanu, nie implementacja jednego.
- **Status:** proposed

### S-13: Akcje sterowane klawiaturą

- **Efekt:** Montażysta steruje kluczowymi akcjami z klawiatury: poprzedni/następny reel, akceptuj/odrzuć, koryguj granice segmentów (poziom słów) i przechodzi między krokami 1–2–3.
- **Change ID:** keyboard-navigation
- **Odniesienia PRD:** FR-037
- **Warunki wstępne:** S-02, S-04
- **Równolegle z:** S-09, S-10
- **Blokery:** —
- **Niewiadome:** —
- **Ryzyko:** Zależy od tego, czy powierzchnie listy reeli (S-02) i strojenia (S-04) są celowalne klawiaturą. Korekty na poziomie słów degradują się do poziomu zdań dopóki nie pojawi się S-06. Persona jawnie ceni szybkość klawiatury, więc to istotne produktowo, nie polish.
- **Status:** proposed

### S-14: Flagi jakości selekcji — grupowanie źródeł + wiszące odniesienia

- **Efekt:** Przy wielu plikach źródłowych segmenty są grupowane i etykietowane (`[ŹRÓDŁO 1]`, …), a modelowi zabrania się mieszać segmenty z różnych plików w jednym reelu; reele otwierające się niewyjaśnionym zaimkiem/odniesieniem („wiszące odniesienia”) są flagowane i albo wciągają wprowadzający segment, albo mają obniżony wynik.
- **Change ID:** selection-quality-flags
- **Odniesienia PRD:** FR-013, FR-025
- **Warunki wstępne:** S-01
- **Równolegle z:** S-02, S-03, S-04, S-08
- **Blokery:** —
- **Niewiadome:**
  - Czy wykrywanie wiszących odniesień jest po stronie promptu (model sam flaguje), czy heurystyką post-przebiegu nad tekstem segmentu? — Właściciel: zespół. Blokuje: nie.
- **Ryzyko:** Oba to miłe-w-posiadaniu udoskonalenia reguły selekcji (FR-013, FR-025 są nice-to-have). Wyostrzają jakość selekcji, ale klin jest udowadnialny bez nich — trzymane późno w Strumieniu A.
- **Status:** proposed

### S-15: Podgląd odtwarzania reela

- **Efekt:** Montażysta opcjonalnie podgląda odtwarzanie wybranego reela zsynchronizowane z jego listą segmentów.
- **Change ID:** reel-preview-playback
- **Odniesienia PRD:** FR-024
- **Warunki wstępne:** S-04
- **Równolegle z:** S-06, S-12
- **Blokery:** —
- **Niewiadome:**
  - Czy podgląd odtwarza wideo źródłowe przewijane po spanach reela, czy zszyte audio-only scrub? — Właściciel: zespół. Blokuje: nie.
- **Ryzyko:** Nice-to-have. Sidecar jest zachowany do użycia audio/miniatur, więc podgląd nie musi wskrzeszać żadnego usuniętego kodu renderowania — trzymaj go ściśle odczyt/przewijanie, nigdy render.
- **Status:** proposed

## Przekazanie do backlogu (Backlog Handoff)

| Roadmap ID | Change ID                      | Sugerowany tytuł zgłoszenia                                   | Gotowy do `/10x-plan` | Notatki                                            |
| ---------- | ------------------------------ | ------------------------------------------------------- | --------------------- | ------------------------------------------------ |
| F-01       | remove-render-path             | Usuń ścieżkę renderowania FFmpeg; dodaj barierę regresji         | tak                   | Uruchom `/10x-plan remove-render-path`               |
| F-02       | resolve-plugin-spike           | Spike: wykonalność runtime'u Resolve Workflow Integration   | tak                   | Rozwiązuje PRD Pytanie Otwarte #2; odblokowuje S-09            |
| S-01       | scored-selection-edl           | Punktowana selekcja AI → eksport czystego EDL (gwiazda północna)     | nie                    | Wymaga F-01                                       |
| S-02       | scoring-first-reel-list        | UI listy reeli „najpierw wynik”                              | nie                    | Wymaga S-01                                       |
| S-03       | prompt-presets                 | Edytowalny prompt systemowy + zarządzanie presetami              | nie                    | Wymaga S-01                                       |
| S-04       | segment-tuning-ops             | Kolejność / łączenie / usuwanie segmentów + wycinanie wypełniaczy      | nie                    | Wymaga S-01                                       |
| S-05       | builtin-whisperx-transcription | Wbudowana transkrypcja WhisperX + wyrównanie na poziomie słów  | nie                    | Wymaga F-01; ciężki; migracja cache               |
| S-06       | word-level-boundary-trim       | Korekta granic na poziomie słów + snap-do-pauzy                | nie                    | Wymaga S-04, S-05                                 |
| S-07       | auto-mode-pipeline             | Tryb auto jednym kliknięciem + etapowy postęp                   | nie                    | Wymaga S-01, S-05                                 |
| S-08       | timeline-export-set            | Zestaw eksportu Premiere XML / FCPXML / Resolve Lua          | nie                    | Wymaga S-01                                       |
| S-09       | resolve-plugin-handoff         | Wbudowana wtyczka DaVinci Resolve (przekazanie jednym kliknięciem)    | nie                    | Zablokowane werdyktem F-02                          |
| S-10       | en-pl-i18n                     | Internacjonalizacja EN/PL                              | nie                    | Wymaga S-02, S-04                                 |
| S-11       | keychain-credentials           | Przenieś klucze API do keychaina systemu                            | tak                   | Brak warunku wstępnego; równoległe hartowanie              |
| S-12       | empty-error-states             | Jawne stany puste/błędu                              | nie                    | Wymaga S-01, S-05                                 |
| S-13       | keyboard-navigation            | Przegląd i strojenie sterowane klawiaturą                       | nie                    | Wymaga S-02, S-04                                 |
| S-14       | selection-quality-flags        | Grupowanie źródeł + flagi wiszących odniesień              | nie                    | Wymaga S-01                                       |
| S-15       | reel-preview-playback          | Podgląd odtwarzania reela                                   | nie                    | Wymaga S-04                                       |

## Otwarte pytania roadmapy

1. **Jaka jest estymacja `delivery_weeks` dla tej zmiany?** — Właściciel: użytkownik. Blokuje: `roadmap-wide` (tylko tempo; nie blokuje żadnego konkretnego wycinka). Trwały wysiłek po godzinach potwierdzony 2026-06-10; brak twardego terminu.
2. **Czy runtime wtyczki DaVinci Resolve Workflow Integration jest wykonalny i czy frontend Tauri może być w nim ponownie użyty?** — Właściciel: użytkownik. Blokuje: `S-09`. To najwyższe ryzyko techniczne projektu; F-02 (`resolve-plugin-spike`) to slot, który je rozwiązuje. Rozwiąż przed zobowiązaniem S-09 do wycinka dostawczego.
3. **Bundlowanie WhisperX + migracja cache** — jak dostarczyć WhisperX (+ wyrównanie, + opcjonalna diaryzacja pyannote z obsługą tokenu HF) jako wbudowany silnik zastępujący `whisper-cli` z PATH, zachowując lub migrując kontrakt cache SRT+word-JSON? — Właściciel: zespół. Blokuje: nie (trudne zadanie budowy wewnątrz S-05, wyłonione tutaj, bo obejmuje transkrypcję + cache'owanie + pakowanie).

## Odłożone (Parked)

- **Render wideo w aplikacji / edytor wideo (jakikolwiek przyszły powrót)** — Dlaczego odłożone: PRD §Non-Goals twarda blokada — „jego nieobecność jest tożsamością produktu”. (Uwaga: F-01 *usuwa* istniejącą ścieżkę renderowania; ten wpis blokuje jej kiedykolwiek powrót.)
- **Chmura / SaaS / współpraca / hostowane AI** — Dlaczego odłożone: PRD §Non-Goals twarda blokada — w pełni lokalne, jednoużytkownikowe.
- **Wersja przeglądarkowa/webowa aplikacji** — Dlaczego odłożone: PRD §Non-Goals (z AppContext.md).
- **Wsparcie Linux** — Dlaczego odłożone: PRD §Non-Goals; najpierw macOS, Windows później.
- **Ogólna architektura wtyczek poza integracją z Resolve** — Dlaczego odłożone: PRD §Non-Goals.
- **Architektura multi-region / wysokiej dostępności** — Dlaczego odłożone: PRD §Non-Goals; pojedyncze urządzenie.
- **Pobieranie z URL (YouTube/Vimeo)** — Dlaczego odłożone: zbiór odroczonych PRD §Non-Goals (późniejsza zmiana).
- **Eksport draftu CapCut** — Dlaczego odłożone: zbiór odroczonych PRD §Non-Goals.
- **Porównanie A/B providerów + scalanie** — Dlaczego odłożone: zbiór odroczonych PRD §Non-Goals.
- **Batch API** — Dlaczego odłożone: zbiór odroczonych PRD §Non-Goals.
- **Dwuetapowe dzielenie long-form** — Dlaczego odłożone: zbiór odroczonych PRD §Non-Goals.
- **Tryb „Prywatne AI” eksport-promptu / wklejenie-z-powrotem** — Dlaczego odłożone: zbiór odroczonych PRD §Non-Goals.
- **Generowanie metadanych per reel (tytuł/opis/hashtagi/SEO)** — Dlaczego odłożone: PRD FR-019 ODROCZONE; repurposing social/SEO, nie dostarczanie osi.
- **Eksport `.md` per reel** — Dlaczego odłożone: PRD FR-032 ODROCZONE; artefakt social/SEO, odroczony z FR-019.
- **Blokada PIN / hasłem aplikacji przy starcie** — Dlaczego odłożone: PRD §Access Control — późniejsze hartowanie bezpieczeństwa, nie ta dostawa.

## Zrobione (Done)

(Pusto przy pierwszym generowaniu. `/10x-archive` dopisuje tutaj — i przełącza Status pasującego elementu na `done` — gdy zmiana, której `Change ID` pasuje do elementu roadmapy, jest archiwizowana. NIE wypełniaj z góry.)
