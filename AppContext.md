# Reels Automator — kontekst aplikacji (stan docelowy)

**Reels Automator** to desktopowa aplikacja macOS i Windows, która zamienia długie nagrania wideo w gotową **selekcję najlepszych momentów (reels)** i zapisuje je jako **oś czasu (timeline) w pliku EDL** (oraz innych formatach wymiany montażowej). Całe przetwarzanie odbywa się **lokalnie na komputerze użytkownika**. Interfejs jest dwujęzyczny — **angielski i polski** — oparty o klucze tłumaczeń (i18n), a nie zaszyte na sztywno stringi (patrz „Kluczowe cechy produktu → Dwujęzyczność").

Aplikacja jest tworzona **z myślą o montażystach**. Jej jedynym zadaniem jest **jak najszybciej wskazać idealne fragmenty** z długiego nagrania i przekazać je jako gotowy timeline do profesjonalnego programu — **DaVinci Resolve, Premiere Pro lub Final Cut Pro** — gdzie montażysta kończy pracę. Reels Automator **nie renderuje finalnego wideo** ani nie zastępuje programu montażowego; jest szybkim narzędziem do transkrypcji i doboru momentów, które oszczędza najbardziej żmudny etap pracy.

> **Rozstrzygnięcie „render vs brak renderu".** Stan docelowy jest jednoznaczny: aplikacja **eksportuje wyłącznie timeline**, nie renderuje MP4. Wcześniejszy tor renderu FFmpeg (Phase 1: `rendering.rs`, zakładka „Render") jest traktowany jako **legacy do wycięcia**, nie jako funkcja produktu. Cała energia idzie w selekcję AI i czyste granice cięć — bo skoro app nie renderuje, jej *jedynym produktem jakości* jest trafny dobór fragmentów.

---

## Główny problem

Ręczne wyławianie krótkich, „viralowych" fragmentów z długich nagrań (podcast, wywiad, wykład, webinar) jest bardzo czasochłonne. Zanim montażysta w ogóle zacznie właściwy montaż, musi:

- przepisać nagranie (transkrypcja),
- przesłuchać cały materiał i znaleźć najlepsze, najbardziej angażujące fragmenty,
- ręcznie odtworzyć te cięcia i ich kolejność na osi czasu w swoim programie montażowym.

Reels Automator automatyzuje właśnie ten wstępny, najbardziej mozolny etap — **transkrypcję i selekcję momentów** — i oddaje wynik jako **gotowy timeline do zaimportowania**. Cała dalsza praca (kadrowanie, napisy, logo, render) zostaje po stronie programu montażowego, którego montażysta już używa.

---

## Główny przepływ — trzy kroki

Aplikacja prowadzi użytkownika przez trzy kroki. Kroki są widoczne **na dole okna** (jak w DaVinci Resolve). Możliwy jest też tryb „jednym kliknięciem" przy pomocy dodania API — automatyczna analiza AI przeprowadza materiał przez cały pipeline aż do eksportu timeline'u.

**Tryb auto = jeden ciągły pasek postępu, nie łańcuch modali.** Ponieważ auto (import → transkrypcja → analiza AI) potrafi trwać minuty, tryb ten pokazuje **jeden, ciągły wskaźnik etapów** (Import → Transkrypcja → Wyrównanie → Diaryzacja → Segmenty → Selekcja AI → Metadane) z procentem bieżącego etapu, **przyciskiem anulowania** na każdym etapie i automatycznym „przejdź do kroku X, gdy gotowe". Żaden etap nie blokuje okna modalem — użytkownik widzi, co się dzieje, i może przerwać.

### Krok 1 — Import i transkrypcja

- **Źródło materiału — dwie drogi:**
  - przeciągnij i upuść lokalny plik wideo,
  - albo wklej adres URL (YouTube / Vimeo / itp.) — aplikacja pobiera lokalnie strumień w najwyższej dostępnej jakości. Dostępny jest wybór rozdzielczości przed pobraniem oraz pasek postępu.
- **Jedno okno importu** z odtwarzanym podglądem wideo oraz panelem transkrypcji. Pola (nazwa projektu, plik transkrypcji dla eksportu, inne konieczne informacje itd.) są **auto-uzupełniane, ale edytowalne**.
- **Transkrypcja lokalna (WhisperX) — wbudowany silnik:** transkrypcja działa w pełni offline na komputerze użytkownika i jest **standardowym, zawsze dostępnym sposobem** uzyskania transkryptu (nie wymaga żadnego zewnętrznego serwisu ani osobnej instalacji przez użytkownika). Jeden lokalny przebieg wykonuje naraz:
  1. **transkrypcję** mowy na tekst,
  2. **wyrównanie czasowe na poziomie pojedynczego słowa** (forced alignment) — dokładne, dopracowane znaczniki czasu każdego słowa, dzięki czemu cięcia w eksportowanym timeline trafiają dokładnie na granice wypowiedzi,
  3. **diaryzację** — etykiety mówców (mówca A, mówca B, …) przy każdym słowie. Diaryzacja jest częścią standardowego przebiegu, nie dodatkiem; etykiety mówców zasilają zarówno selekcję AI (granice tematyczne w rozmowach), jak i eksport `.md` z podziałem na mówców.
- **Modele i pobieranie:** aplikacja ma wbudowaną listę dostępnych modeli z oznaczeniem, czy dany model jest już pobrany. Po wybraniu niepobranego modelu pojawia się okno z prośbą o pobranie i wyborem ścieżki docelowej; pobieranie pokazuje procent, prędkość i pozostały czas. Postęp samej transkrypcji też jest widoczny.
- **Transkrypt od razu zasila analizę AI:** po zakończeniu transkrypcji jej wynik jest **automatycznie cięty na ponumerowane segmenty zdań i przekazywany jako wejście do Kroku 2 (analiza AI)** — bez ręcznego eksportu/importu pliku pośredniego. Użytkownik może przejść od wczytania wideo do gotowej selekcji reels jednym ciągiem.
- **Eksport transkryptu (opcjonalny):** możliwość zapisania gotowego `.srt` (również na poziomie słowa) oraz `.srt` / `.vtt`.
- **Import gotowej transkrypcji:** plik `.srt` / `.vtt` można wczytać zamiast robić transkrypcję od zera (transkrypt z importu zasila analizę AI tak samo jak ten z WhisperX).
- **Dokładne segmenty:** segmenty zdań pokrywają cały materiał, bez luk, tak aby materiał nie był pocięty w momentach, gdy nikt nic nie mówi.
- **Przycisk „automatyczna analiza AI"** (tylko po wgraniu API, z potwierdzeniem) obok wczytanych plików: jedno kliknięcie prowadzi przez import → transkrypcję WhisperX → wyrównanie → diaryzację → utworzenie segmentów → analizę AI i od razu przechodzi dalej. Umożliwia również powrót do wcześniejszych kroków.

### Krok 2 — Analiza AI (dobór reelsów)

**Jak AI wybiera reels — mechanika:**

AI **nie analizuje samego wideo** — pracuje wyłącznie na **tekście transkrypcji** z Kroku 1. Działa to tak:

1. Transkrypcja jest pocięta na **ponumerowane segmenty zdań** — każdy ma stały **numer ID**, treść i znaczniki czasu (timecode). Cała ta lista (ID + tekst + czasy) trafia do promptu razem z poleceniem użytkownika.
2. Zadaniem AI **nie jest wymyślanie momentów cięcia, lecz wybór i ułożenie istniejących segmentów**. Dla każdego proponowanego reela model zwraca **listę numerów ID segmentów** (`clip_ids`) w wybranej kolejności, nazwę reela oraz ocenę i uzasadnienie (patrz schemat poniżej). Reel = uporządkowany zestaw wskazanych segmentów.
3. Dzięki temu **cięcia zawsze lądują na realnych granicach segmentów** (a po wyrównaniu WhisperX — na granicach słów), a nie w przypadkowych miejscach. AI może też zmienić kolejność wypowiedzi lub pominąć słabsze fragmenty, dobierając z całego nagrania najmocniejszą narrację.
4. Przy **wielu źródłach** segmenty są pogrupowane i oznaczone (`[ŹRÓDŁO 1]`, `[ŹRÓDŁO 2]`, …), a AI ma zakaz mieszania segmentów z różnych plików w jednym reelu.

**Schemat odpowiedzi selekcji (rozszerzony):** dla każdego reela model zwraca, obok `reel_name` i `clip_ids`, także:

- **`virality_score` (0–100)** — ocena potencjału klipu liczona na czterech osiach jak u liderów rynku (Opus Clip, Vizard): **Hook / Flow / Value / Trend**. To **pierwszorzędne narzędzie decyzyjne montażysty**, nie metadana opcjonalna.
- **`reason` (1 zdanie)** — krótkie uzasadnienie oceny i wyboru, które tłumaczy `virality_score` i ułatwia triage.
- **markery `hook` / `body` / `punchline`** — punkty czasowe wewnątrz reela (początek, rozwinięcie, puenta) z timecode'ami; trafiają jako markery do eksportowanego timeline i wymuszają, by selekcja pilnowała obecności puenty (nie urywała przed nią).

**Generowanie metadanych** — osobny przebieg per reel, który na podstawie tekstu danego reela zwraca **tytuł, opis, hashtagi i słowa kluczowe SEO** (opcjonalne, wykorzystywane w eksporcie tekstowym `.md` w Kroku 3).

**UI listy reels (scoring jako element pierwszorzędny):**

- **odznaka z `virality_score`** przy każdym reelu + **sortowanie wg wyniku**,
- **jednolinijkowy `reason`** pod każdą rolką — główny sygnał, dlaczego to mocny fragment,
- słabsze reels są wizualnie wyszarzone, ale nadal można je wybrać.

**Wybór modelu i kontrola użytkownika:**

- Model językowy podłączany przez **API** (Claude / Gemini / OpenRouter, do wyboru). Niskie temperatury / niski `effort` dla powtarzalnych wyników (sterowanie powtarzalnością dopasowane do modelu — patrz „Architektura wydajności").
- **Edytowalny prompt systemowy + presety (pełny CRUD jak projekty):** użytkownik może edytować **prompt systemowy** sterujący zachowaniem modelu przy selekcji oraz wprowadzić własny prompt użytkownika. Prompt systemowy nie jest zaszyty w kodzie.
  - **UI presetów:** lista presetów po lewej, edytor po prawej, akcje „zapisz jako", duplikuj, usuń, edytuj oraz eksport/import jako plik `.json` (z wyborem ścieżki).
  - **Wbudowane presety startowe:** „podcast biznesowy", „wywiad ekspercki", „wykład edukacyjny", „klipy merytoryczne". Presety użytkownika są trwale zapisywane.
- **Tryb „prywatne AI"** — eksport gotowego promptu do pliku `.md`, uruchomienie go w dowolnym własnym/zewnętrznym modelu i **wklejenie zwrotnego JSON** z reelsami z powrotem do aplikacji (przycisk wklejania własnego JSON, z walidacją struktury).
- **Edytor JSON reels** — ręczna korekta doboru segmentów.
- **Porównanie dwóch dostawców (A/B):** uruchomienie dwóch modeli równolegle na tym samym promptcie, wizualne porównanie, które segmenty wybrał każdy z nich **oraz różnicy `virality_score`**, i decyzja: weź wynik A, weź B albo **scal oba**.

**Odporność na zły JSON z LLM:** odpowiedź modelu przechodzi przez walidację struktury przed użyciem. Jeden nadmiarowy przecinek czy nadmiarowy fence nie wywala analizy bez śladu — użytkownik dostaje **czytelny komunikat błędu** z możliwością ponowienia lub ręcznego wklejenia/poprawy JSON (patrz „Stany puste i obsługa błędów").

**Długie nagrania (chunking long-form):** dla materiału dłuższego niż ~30–40 min selekcja działa dwustopniowo zamiast wpychać cały transkrypt jednym promptem — chroni to przed degradacją uwagi w środku długiego kontekstu („lost in the middle") i tnie koszt (szczegóły w „Architektura wydajności i kosztów").

### Krok 3 — Eksport timeline (przekazanie do programu montażowego)

To jest **finalny krok i główny rezultat aplikacji**: przekazanie wybranej selekcji jako gotowej osi czasu. Render finalnego wideo **nie odbywa się w aplikacji** — robi to docelowy program montażowy.

- **Lekka korekta selekcji przed eksportem** (lista, nie pełny edytor wideo):
  - lista reels po lewej, tekst segmentów danego reela po prawej,
  - **dostrajanie granic segmentu** — dodawanie/odejmowanie sekund z przodu i z tyłu (bardzo dokładnie, na poziomie słowa po wyrównaniu WhisperX), z handle „dociągnij do najbliższej pauzy/oddechu",
  - zmiana kolejności segmentów, scalanie sąsiednich segmentów (suwak progu łączenia, z sensownym domyślnym progiem), usuwanie segmentów,
  - opcjonalny podgląd odtwarzania wybranego reela zsynchronizowany z listą segmentów.
- **Usuwanie przerywników (fillerów) — opcjonalne:** automatyczne pomijanie „yyy", „eee" itp. na poziomie słowa, dzięki czemu cięcia w eksportowanym timeline są od razu ciaśniejsze. Montażysta może to wyłączyć i dociąć samodzielnie.
- **Eksport gotowego timeline'u do programów montażowych** (kluczowy i jedyny rezultat dostawy):
  - **uniwersalny `.edl`** — format CMX3600, główny i domyślny format eksportu, zgodny z większością programów,
  - **DaVinci Resolve — wtyczka uruchamiana wewnątrz programu (główna droga):** aplikacja działa **jako wtyczka (Workflow Integration Plugin) osadzona bezpośrednio w DaVinci Resolve** — montażysta uruchamia ją **z menu samego Resolve** (`Workspace → Workflow Integrations → Reels Automator`) i pracuje w **panelu wewnątrz okna programu**, bez przełączania się do osobnej aplikacji i bez odrywania od montażu. Z poziomu tej wtyczki cały pipeline (import, transkrypcja, analiza AI, dostrojenie selekcji) jest dostępny obok osi czasu. Po zatwierdzeniu reels wtyczka **przez API Resolve sama zakłada nowy folder w bieżącym projekcie** (np. `Reels Automator` z datą / nazwą projektu) i umieszcza tam wygenerowane reels jako osobne timeline'y wraz z dograniem materiału źródłowego do Media Pool — **jednym kliknięciem, bez wklejania skryptu i bez importu pliku pośredniego**. Wtyczka korzysta z kontekstu już otwartego projektu (wykrywa aktywny projekt, materiał i oś czasu).
  - **Tryb samodzielny (standalone) + eksport plikowy (fallback):** tę samą aplikację można uruchomić **jako osobne okno** (dla montażystów spoza Resolve oraz pod Premiere / Final Cut / CapCut). Wtedy DaVinci dostaje wynik przez eksport plikowy — skrypt Lua (wklejany do konsoli) oraz `.fcpxml` — używany też automatycznie, gdy wtyczka nie ma dostępu do API.
  - **Premiere Pro** — XML w formacie FCP7 (xmeml),
  - **Final Cut Pro** — `.fcpxml` (natywny format wymiany Final Cut Pro X; **inny niż xmeml FCP7 używany przez Premiere** — generowany osobno; xmeml nie zaimportuje się natywnie do Final Cut Pro X),
  - **CapCut** — eksport projektu do formatu draftu CapCut (folder projektu z plikiem `draft_content.json`), tak aby cięcia, kolejność klipów i segmenty trafiły bezpośrednio na oś czasu CapCut.

  Cała praca — wybór reels, cięcia, kolejność klipów, segmenty — przenosi się do docelowego programu, gdzie montażysta kontynuuje pracę (kadrowanie 9:16, napisy, logo, korekcja, render) bez odtwarzania montażu od nowa.
- **Plik `.md` na każdy reel (repurposing pod social/SEO)** — opcjonalny, tworzony obok eksportu timeline'u. Zawiera tytuł, odznakę z `virality_score`, opis pod social media, blok hashtagów, pełny transkrypt oraz wariant z etykietami mówców (gdy dostępna diaryzacja).

---

## Stany puste i obsługa błędów

Happy-path to nie wszystko — najczęstsze realne momenty UX to brak konfiguracji i błędy zewnętrzne. Aplikacja ma jawne, czytelne stany dla:

- **brak klucza API** — komunikat „dodaj klucz w ustawieniach", z odnośnikiem do miejsca konfiguracji; tryb auto i analiza AI są zablokowane do czasu dodania klucza (transkrypcja lokalna działa nadal),
- **`whisper-cli` lub model nie zainstalowany / nie pobrany** — wskazanie, czego brakuje, i okno pobrania modelu (z procentem, prędkością, czasem),
- **LLM zwrócił zły JSON** — czytelny komunikat zamiast cichego wywalenia analizy, z opcją ponów / wklej ręcznie poprawiony JSON (tryb „prywatne AI" jest tu ścieżką ratunkową),
- **URL się nie pobrał** (niedostępny, geo-block, zła jakość) — komunikat z możliwością ponowienia lub wgrania pliku lokalnie,
- **pusty projekt / brak reels** — stan pusty z podpowiedzią następnego kroku, nie martwy ekran.

---

## Praca z klawiatury / skróty

Narzędzie dla montażystów, więc szybkość pracy z klawiatury jest wymogiem, nie dodatkiem. Klawiatura obsługuje co najmniej:

- przełączanie między reelsami (poprzedni / następny),
- accept / reject reela,
- dostrajanie granic segmentu strzałkami (z przodu / z tyłu, na poziomie słowa),
- przechodzenie między krokami 1–2–3.

---

## Kluczowe cechy produktu

- **Narzędzie dla montażystów, nie „zamknięta skrzynka"** — aplikacja wykonuje wyłącznie wstępny etap (transkrypcja + selekcja) i oddaje **gotowy timeline** do DaVinci Resolve, Premiere Pro, Final Cut Pro (FCPXML) oraz CapCut. Finalny montaż i render pozostają w docelowym programie. Brak renderu MP4 w aplikacji jest decyzją, nie luką (patrz „Co NIE wchodzi w zakres").
- **Wtyczka wewnątrz DaVinci Resolve (bez odrywania od montażu)** — aplikacja uruchamia się **jako panel-wtyczka osadzona w samym Resolve** (Workflow Integration, dostępna z menu `Workspace`), więc montażysta pracuje nad selekcją reels **bez wychodzenia z programu montażowego**. Z poziomu wtyczki, jednym kliknięciem, powstaje **nowy folder w bieżącym projekcie z gotowymi timeline'ami reels** (przez API Resolve), bez ręcznego importu. Tę samą aplikację można też uruchomić samodzielnie (standalone); eksport plikowy (EDL / Lua / FCPXML / XML / CapCut) pozostaje uniwersalnym wariantem zapasowym.
- **Najlepsza możliwa transkrypcja, lokalnie** — wbudowany **lokalny WhisperX** wykonuje w jednym przebiegu transkrypcję, wyrównanie na poziomie słowa i diaryzację, a wynik **od razu trafia do analizy AI** bez ręcznego importu — dzięki temu droga od wideo do selekcji reels jest płynna, a cięcia w eksportowanym timeline trafiają dokładnie na granice słów.
- **Selekcja AI z oceną i uzasadnieniem** — każdy reel ma `virality_score` (Hook/Flow/Value/Trend) i jednozdaniowy `reason`, wyeksponowane jako pierwszorzędny element listy. Prompt systemowy jest edytowalny i zapisywany jako presety.
- **Szybkość przede wszystkim** — celem jest dojście od surowego nagrania do gotowego do importu pliku EDL w jak najkrótszym czasie (architektura prędkości niżej).
- **W pełni lokalne i prywatne przetwarzanie** — wideo nie opuszcza komputera użytkownika. Jedyny wyjątek to zapytania do API modelu językowego (analiza tekstu transkrypcji).
- **Kontrola dostępu i bezpieczeństwo poświadczeń** — klucze API są trzymane w bezpiecznym magazynie poświadczeń systemu operacyjnego (keychain / Credential Manager), nie w plaintext. Aplikację można dodatkowo zabezpieczyć **blokadą kodem PIN / hasłem** (ekran odblokowania przy starcie).
- **Zarządzanie danymi (pełny CRUD)** — tworzenie, otwieranie, aktualizacja i usuwanie **projektów** (`.reelproj`), **presetów promptów systemowych** (zapisywanych przez użytkownika) oraz pełna edycja **listy reelsów i segmentów** (dodawanie, edycja, zmiana kolejności, scalanie, usuwanie). Cały stan jest trwale zapisywany w pliku projektu.
- **Projekt zapisywany i wczytywany jako plik** — można wrócić do pracy później z odtworzonym stanem.
- **Dwujęzyczność (i18n jako wymóg techniczny)** — interfejs po angielsku i polsku oparty o **mechanizm kluczy tłumaczeń**, a nie stringi zaszyte w kodzie. Dwujęzyczność jest wymaganiem implementacyjnym, nie deklaracją — bez warstwy tłumaczeń nie powstanie.
- **Aplikacja desktopowa, dwa tryby uruchomienia** — ta sama aplikacja działa **jako wtyczka osadzona w DaVinci Resolve** (Workflow Integration Plugin, główny tryb — uruchamiana z menu Resolve) oraz **samodzielnie, jako osobne okno** (dla pracy poza Resolve). Najpierw macOS, Windows w kolejnym wydaniu.

---

## Architektura wydajności i kosztów

Cel: „od surowego nagrania do EDL jak najszybciej", przy rozsądnym koszcie wywołań LLM. Stan docelowy zakłada:

1. **Zrównoleglone metadane** — generowanie metadanych per reel działa współbieżnie (limit ~4–6 równoległych wywołań), nie sekwencyjnie. Przy kilkunastu reelsach to największy pojedynczy zysk prędkości na tym etapie.
2. **Prompt caching (Claude)** — transkrypt + prompt systemowy to duży, stały prefiks powtarzany w każdym wywołaniu (selekcja → metadane per reel → ewentualny re-run/A-B). Stały blok (system + lista segmentów) jest cache'owany (`cache_control: ephemeral`), część zmienna (polecenie użytkownika, ID reela) na końcu — odczyt z cache ~0.1× ceny wejścia, niższa latencja.
3. **Dobór modelu per etap** — selekcja reels (rozumowanie nad całym transkryptem) na mocniejszym modelu (Opus / Sonnet); metadane per reel (tytuł/opis/hashtagi) na tańszym i szybszym (Haiku). W obrębie jednego etapu trzymany jeden model, by nie unieważniać cache.
4. **Batch API do metadanych** — w trybie wsadowym („wygeneruj metadane dla wszystkich reels naraz", gdy nie zależy na natychmiastowości) Message Batches obniżają koszt o ~50%.
5. **Dwustopniowa selekcja dla długich nagrań** — zamiast jednego wielkiego promptu: (a) chunk transkryptu na bloki ~10–20 min, (b) tani przebieg „kandydaci" (shortlist segmentów wartych reela) per chunk, (c) drogi przebieg scoringu/ułożenia tylko na shortlistcie. Poprawia trafność i mocno tnie koszt na materiale >30–40 min.
6. **Streaming długich odpowiedzi** — by nie wpadać w timeouty przy dużym `max_tokens`.
7. **Cache wyników** — transkrypcja jest cache'owana po hashu pliku; selekcja AI również jest cache'owana (klucz: hash transkryptu + prompt + model), żeby re-run nie płacił ponownie.

---

## Jak dostarczać wysokiej jakości reels i segmenty

To jest serce produktu. Ponieważ aplikacja nie renderuje wideo, jej **jedynym produktem jakości** jest *trafny dobór fragmentów* i *czyste granice cięć*. Poniższe zasady (research nad Opus Clip, Vizard, Reap, Submagic, Descript oraz literaturą o segmentacji transkryptu) to **operacje na tekście transkrypcji + znacznikach WhisperX**, więc mieszczą się w lokalnym i tekstowym zakresie produktu.

### A. Jakość segmentu (czyste, samodzielne cięcia)

Najczęstsza wada słabych narzędzi: klip zaczyna się w połowie myśli albo urywa przed puentą — „czuć automat". Klucz to **kompletna myśl** i **granice na realnych pauzach mowy**.

- **Cięcia na granicy słowa, nie zdania na siłę** — wyrównanie WhisperX to umożliwia; używaj go przy dostrajaniu początku/końca segmentu (handle „dociągnij do najbliższej pauzy/oddechu").
- **Łączenie zbyt krótkich segmentów** — fragmenty < ~10 s scalaj z sąsiadem na podstawie bliskości czasowej i semantycznej (suwak progu łączenia z sensownym domyślnym progiem).
- **Granice na interpunkcji i prozodii** — segment obejmuje co najmniej jedną pełną jednostkę prozodyczną (wypowiedź między pauzami), kończy się na znaku interpunkcyjnym, nigdy w środku słowa.
- **Wykrywanie „wiszących odniesień"** — AI oznacza reels otwierające się od zaimka/odniesienia bez kontekstu („jak mówiłem", „to jest właśnie to") i albo dobiera segment wprowadzający, albo obniża ocenę.

### B. Jakość reela (trafny wybór i mocna narracja)

Klip oceniany jest na osiach **Hook / Flow / Value / Trend** — i tym karmiony jest `virality_score` oraz prompt selekcji:

- **Wartość i merytoryka (nadrzędne kryterium)** — reels muszą być **wysoce wartościowe i merytoryczne**: niosące konkretną myśl, wiedzę, wniosek lub mocną tezę, a nie tylko chwytliwe czy emocjonalne. Hak ma przyciągać do **treści, która coś wnosi** — clickbait bez substancji jest gorszym reelem niż mniej efektowny, ale merytoryczny fragment. AI premiuje segmenty o wysokiej gęstości informacyjnej i samodzielnej wartości dla widza, a obniża ocenę fragmentom pustym lub czysto wypełniającym.
- **Hook (pierwsze ~3 s)** — reel musi przyciągać od razu: pytanie, mocne stwierdzenie, kontrowersja, humor. AI wybiera segment otwierający pod kątem haka, a nie chronologii. Brak haka = niższa ocena.
- **Flow (łuk narracji)** — kompletny łuk: hook → rozwinięcie → puenta/wniosek. Pokrywa się z markerami `hook` / `body` / `punchline` — selekcja pilnuje obecności puenty, a nie urywa przed nią.
- **Trend / temat** — opcjonalne dopasowanie do tematów i słów kluczowych zadanych przez użytkownika w promptcie.
- **Cel długości pod platformę** — podpowiadaj/oznaczaj długość reela: TikTok ~15–30 s, Instagram Reels ~30–60 s, YouTube Shorts ~60–90 s. AI dobiera liczbę segmentów pod docelowy zakres.

### C. Prompt selekcji LLM (twarde reguły)

- **Zakaz parafrazy** — model wybiera i porządkuje istniejące `clip_ids`, nigdy nie zmienia tekstu (przeciwdziała „streszczaniu zamiast cytowania").
- **Wymóg samodzielności** — jawnie: „każdy reel musi być zrozumiały bez reszty nagrania, zaczynać się od haka i kończyć puentą".
- **Wymóg wartości i merytoryki** — jawnie: „wybieraj wyłącznie fragmenty wartościowe i merytoryczne — niosące konkretną wiedzę, wniosek lub mocną tezę; pomijaj treści puste, dygresje i wypełniacze, nawet jeśli brzmią efektownie".
- **Wykrywanie wiszących odniesień** — oznaczaj reels otwierające się od zaimka/odniesienia bez kontekstu; dobierz segment wprowadzający albo obniż score.
- **Cel długości pod platformę** — TikTok 15–30 s / Reels 30–60 s / Shorts 60–90 s; dobieraj liczbę segmentów pod zakres.
- **Specyficzność zamiast ogólników** — prompt z jasnym odbiorcą, tonem i kryteriami daje lepsze wyniki niż „znajdź ciekawe momenty".
- **Niska temperatura / niski `effort`** — dla powtarzalności. Sposób sterowania zależy od modelu (na najnowszych modelach Anthropic powtarzalnością steruje `effort` + prompt, nie `temperature`).
- **Uzasadnienie wyboru** — model zwraca krótkie `reason` per reel, co ułatwia montażyście triage i tłumaczy `virality_score`.

### D. Sygnały z audio i diaryzacji (wciąż lokalnie, tekstowo)

Bez analizy obrazu, ale z lokalnego audio/WhisperX, można pozyskać dodatkowe sygnały jakości: **długie pauzy** (naturalne punkty cięcia), **śmiech/oklaski** (markery emocji), **zmiany mówcy** z diaryzacji (granice tematyczne w rozmowach). Realne wzbogacenie selekcji bez wychodzenia poza obecny zakres.

> Źródła: [Opus Clip — Virality Score (Hook/Flow/Value/Trend)](https://help.opus.pro/docs/article/virality-score) · [Vizard — AI Podcast Clip Generator / Spark 1.0](https://vizard.ai/tools/ai-podcast-clip-generator) · [Reap — czym jest agent klipujący (kompletna myśl, padding, unikanie cięć w pół zdania)](https://reap.video/blog/what-is-a-clipping-agent) · [Choppity — najlepsze generatory klipów (sygnały, długości platform)](https://www.choppity.com/blog/best-ai-podcast-clip-makers-generators/) · [Murf — AI podcast clips (wykrywanie zmian mówcy, emocji, kompletności myśli)](https://murf.ai/blog/how-to-use-ai-to-make-podcast-clips) · [BrassTranscripts — prompty LLM (zakaz parafrazy, cytowanie zamiast streszczania)](https://brasstranscripts.com/blog/powerful-llm-prompts-transcript-optimization) · [Extend — semantic chunking (granice zdań, scalanie < 10 s, jednostki prozodyczne)](https://www.extend.ai/resources/semantic-chunking-methods-5-best-practices-rag-results) · [Two-stage LLM dla precyzyjnych timestampów w długich transkryptach (TimeStampEval)](https://arxiv.org/html/2511.11594v1) · [Chunking strategies / „lost in the middle" (Weaviate)](https://weaviate.io/blog/chunking-strategies-for-rag)

---

## Co NIE wchodzi w zakres

- **Renderowanie finalnego wideo (MP4 / inne kontenery)** — to zadanie docelowego programu montażowego. Aplikacja eksportuje wyłącznie timeline. Istniejący tor renderu FFmpeg (Phase 1) jest **legacy do wycięcia**, nie funkcją produktu.
- **Wbudowany edytor wideo** — kadrowanie do 9:16, pozycja/skala materiału, podgląd kanwy, macierz kodeków, kolejka renderu.
- **Automatyczne kadrowanie / centrowanie mówiącej twarzy** — realizowane w programie montażowym.
- **Dodawanie logo i gradientów** — realizowane w programie montażowym.
- **Wypalanie napisów na obrazie (subtitle burn-in).**
- Chmura / SaaS oraz współdzielenie projektów między użytkownikami.
- Funkcje współpracy zespołowej (wspólna biblioteka, hosting AI).
- Czysto webowa wersja aplikacji (przeglądarkowa).
- System pluginów (poza dedykowaną wtyczką DaVinci Resolve).
- Linux.
- Architektura wieloregionowa / wysoka dostępność (HA).

---

## Kryteria sukcesu

Każde kryterium ma zdefiniowane zdarzenie pomiarowe — inaczej jest martwe.

- **Akceptacja AI ≥ 75%** — *„akceptacja"* = reel **wyeksportowany bez zmiany `clip_ids`** względem propozycji AI. Mierzone jako odsetek wyeksportowanych reels spełniających ten warunek.
- **Szybkość do timeline** — czas od zakończenia importu do gotowego pliku EDL, mierzony w trybie auto; cel: istotnie krótszy niż ręczne przesłuchiwanie i odtwarzanie cięć w programie montażowym (porównanie na tym samym materiale).
- **Dokładność cięć** — dzięki wyrównaniu na poziomie słowa cięcia trafiają na granice wypowiedzi; pomiar: odsetek granic segmentów wypadających w środku słowa (cel: ~0%) oraz obecność puenty (`punchline`) w reelu.
- **Bezbłędny import** — wyeksportowane pliki (EDL / FCPXML / XML / Lua / CapCut draft) importują się poprawnie do DaVinci Resolve, Premiere Pro, Final Cut Pro i CapCut bez ręcznych poprawek struktury (weryfikacja realnym importem).
- **Integracja jako wtyczka Resolve** — aplikacja uruchamia się z menu DaVinci Resolve jako osadzony panel i pozwala dojść do gotowych reels bez wychodzenia z programu; timeline'y powstają **jednym kliknięciem w nowym folderze bieżącego projektu** (przez API), bez wklejania skryptu czy importu pliku. W trybie samodzielnym / przy niedostępnym API aplikacja automatycznie korzysta z eksportu plikowego.
- **Mierzalny zysk prędkości metadanych** — czas etapu metadanych po zrównolegleniu maleje ~5–10× względem przebiegu sekwencyjnego na projekcie z ≥8 reelsami.
- **Skuteczność prompt cachingu** — `usage.cache_read_input_tokens > 0` na drugim i kolejnym wywołaniu z tym samym transkryptem.
