# Reels Automator — krytyka UX, prędkości i jakości selekcji AI

## Context

`AppContext.md` opisuje **stan docelowy** (transkrypcja WhisperX słowo+diaryzacja, import z URL, wtyczka DaVinci, brak renderu MP4, FCPXML/CapCut, presety promptów, A/B, `virality_score` + `reason`). Realny kod jest ~60% tej wizji i miejscami się z nią **kłóci** (renderuje MP4, używa `whisper-cli` bez diaryzacji, brak URL, brak FCPXML/CapCut/wtyczki, brak scoringu i edytowalnego promptu systemowego).

Zadanie użytkownika: (1) co poprawić w UX-ie `AppContext.md`, (2) krytyczna analiza całej aplikacji, (3) jak przyspieszyć, (4) jak maksymalnie podnieść jakość rolek wybieranych przez AI. Ten plan to uporządkowane rekomendacje + wskazówki implementacyjne na realnych plikach. Jest doradczy — nie każdy punkt trzeba robić, kolejność wg priorytetu.

Kluczowa obserwacja: skoro app **nie renderuje** (wg wizji), jej *jedynym produktem jakości* jest trafny dobór fragmentów i czyste granice cięć. Cała energia powinna iść w selekcję AI + dokładność cięć, nie w render.

---

## CZĘŚĆ A — UX `AppContext.md` (sam dokument / wizja)

Dokument jest mocny merytorycznie, ale jako spec UX ma luki. Co bym zmienił:

1. **Rozstrzygnij sprzeczność „render vs brak renderu".** Sekcja „Co NIE wchodzi w zakres" mówi „brak renderu MP4", ale kod ma pełny tor renderu (`rendering.rs`, zakładka Render w `step3-export.js`). Dokument musi jawnie powiedzieć: czy Phase 1 (render) zostaje jako legacy, czy jest wycinany. Bez tego każdy czytający (i agent) dostaje sprzeczny sygnał.
2. **Dodaj brakujący ekran „stanów pustych i błędów".** Dokument opisuje happy-path. Brakuje: co widzi user gdy brak klucza API, gdy `whisper-cli`/model nie zainstalowany, gdy LLM zwróci zły JSON, gdy URL się nie pobierze. To są najczęstsze realne momenty UX.
3. **Sklej obietnicę „jednym kliknięciem" z realnym feedbackiem postępu.** Tryb auto (import→transkrypcja→AI) potrafi trwać minuty. Spec powinien wymagać jednego, ciągłego paska/etapów z możliwością anulowania i „przejdź do kroku X gdy gotowe", a nie modalnych blokad.
4. **`virality_score` i `reason` muszą być częścią głównego UX listy, nie dodatkiem.** Dokument wspomina je przy metadanych. Powinny być pierwszorzędnym elementem: odznaka + sort + jednolinijkowy `reason` pod każdą rolką (to jest główne narzędzie decyzyjne montażysty — patrz Opus Clip/Vizard).
5. **Doprecyzuj presety promptów jako konkret UI** (lista po lewej, edytor po prawej, „zapisz jako", duplikuj, eksport `.json`) zamiast opisu prozą — to redukuje ryzyko, że implementacja rozjedzie się z intencją.
6. **Kryteria sukcesu: zamień „propozycję" na liczby do pomiaru.** „≥75% akceptacji AI" nie da się zmierzyć bez zdefiniowania zdarzenia „akceptacja" (np. rolka wyeksportowana bez zmiany `clip_ids`). Dopisz definicje metryk, inaczej kryteria są martwe.
7. **Dodaj sekcję „skróty klawiszowe / praca z klawiatury"** — narzędzie dla montażystów; przełączanie rolek, accept/reject, dostrajanie granic strzałkami to realny zysk szybkości i nie ma go w spec.
8. **i18n jako wymóg techniczny, nie zdanie.** „Interfejs po Angielsku i Polsku" — dopisz mechanizm (klucze tłumaczeń), bo dziś wszystkie stringi są twardo po polsku w kodzie. Inaczej dwujęzyczność nie powstanie.

---

## CZĘŚĆ B — Krytyczna analiza aplikacji (realny kod, najostrzej)

Najpoważniejsze braki/ryzyka jakości i UX (z odnośnikami do plików):

- **Brak `virality_score` i `reason`** — `src/ai/prompt.js` prosi tylko o `reel_name`+`clip_ids`, a metadane (`buildMetadataPrompt`) nie zwracają oceny. Montażysta nie ma czym priorytetyzować. To #1 brak jakościowy.
- **Prompt systemowy zaszyty w kodzie** — `src/ai/providers.js` (`"Jesteś ekspertem od montażu wideo. Zwracasz TYLKO czysty JSON…"`), identyczny dla wszystkich providerów, nieedytowalny. Brak presetów. Cała „inteligencja" doboru jest poza zasięgiem usera.
- **Metadane generowane sekwencyjnie** — pętla `await` per rolka w `src/ui/step2-analyze.js` (`generateMetadata`). Przy 10 rolkach to 10 round-tripów po kolei. Najłatwiejszy duży zysk prędkości (patrz Część C).
- **Brak diaryzacji** — `whisper.rs` daje słowa, ale nie etykiety mówców, mimo że wizja traktuje to jako standard. Bez tego granice tematyczne w rozmowach są słabsze.
- **Brak importu z URL** — tylko drag-drop/plik lokalny (`step1-import.js`). Wizja obiecuje YouTube/Vimeo.
- **Brak FCPXML / CapCut / wtyczki Resolve** — eksport to EDL + xmeml (FCP7, 12-letni format) + Lua do wklejenia. Wizja celuje we współczesny FCPXML, CapCut draft i osadzoną wtyczkę. „xmeml" nie zaimportuje się natywnie do Final Cut Pro X.
- **Cały transkrypt leci jednym promptem bez chunkingu** — przy długim podcaście (1–2 h) to ryzyko „lost in the middle" (degradacja uwagi w środku długiego kontekstu) i wysoki koszt. Brak strategii dla materiału >~30–40 min.
- **Brak walidacji/odporności na zły JSON z LLM** — caller robi `JSON.parse` po zdjęciu fence'ów; jeden nadmiarowy przecinek = wywalona analiza bez czytelnego komunikatu.

---

## CZĘŚĆ C — Jak przyspieszyć (prędkość + koszt)

Cel wizji: „od surowego nagrania do EDL jak najszybciej". Konkrety:

1. **Zrównoleglij metadane.** Zamień sekwencyjną pętlę w `generateMetadata` (`step2-analyze.js`) na `Promise.all` z limitem współbieżności (np. 4–6). Natychmiastowy 5–10× na tym etapie. Wzorzec współbieżności jest już w `src/render/queue.js` — można go odwzorować.
2. **Prompt caching (Claude).** Transkrypt + prompt systemowy to duży, stały prefiks powtarzany w każdym wywołaniu (selekcja, potem metadane per rolka, potem ewentualny re-run/A-B). Dodaj `cache_control: {type:"ephemeral"}` na stałym bloku (system + lista segmentów) w `callClaude` (`src/ai/providers.js`). Odczyt z cache ~0.1× ceny wejścia — to i koszt, i latencja. Warunek: stały bajt-w-bajt prefiks, część zmienna (polecenie usera, ID rolki) na końcu. Weryfikuj `usage.cache_read_input_tokens`.
3. **Dobór modelu per etap (Haiku/Sonnet/Opus).** Selekcja rolek (rozumowanie nad całym transkryptem) — Opus/Sonnet. **Metadane per rolka (tytuł/opis/hashtagi) — Haiku 4.5** (taniej i szybciej, jakość wystarcza). To realnie tnie koszt i czas etapu metadanych. Uwaga: zmiana modelu unieważnia cache, więc trzymaj jeden model w obrębie jednego etapu.
4. **Batch API do metadanych (gdy nie zależy na latencji).** Dla trybu „wygeneruj metadane dla wszystkich rolek naraz" Anthropic Message Batches = **−50% kosztu**, większość batchy <1 h. Dobre do trybu wsadowego/eksportu, nie do interaktywnego „pokaż teraz".
5. **Dwustopniowa selekcja dla długich nagrań (jakość + koszt).** Zamiast jednego wielkiego promptu: (a) chunk transkryptu na bloki ~10–20 min, (b) tani przebieg „kandydaci" (shortlist segmentów wartych rolki) per chunk, (c) drogi przebieg scoringu/ułożenia tylko na shortlistcie. Literatura pokazuje, że taki two-stage poprawia trafność i tnie koszt >90% vs. wpychanie całości. Mieści się w obecnym, tekstowym zakresie.
6. **Streaming dla długich odpowiedzi** w `callClaude`, by nie wpadać w timeouty SDK przy dużym `max_tokens`.
7. **Cache transkrypcji już jest** (`whisper.rs`, hash pliku) — dobrze; rozszerz cache także na wynik selekcji AI keyowany (hash transkryptu + prompt + model), żeby re-run nie płacił ponownie (częściowo jest `withLlmCache`).

---

## CZĘŚĆ D — Maksymalna jakość rolek wybieranych przez AI

To jest serce produktu. Zmiany w `src/ai/prompt.js` + `providers.js` + UI listy:

1. **Rozszerz schemat odpowiedzi selekcji o `virality_score` (0–100) i `reason` (1 zdanie) per rolka.** Score liczony na osiach jak u liderów rynku: **Hook / Flow / Value / Trend** (Opus Clip, Vizard). `reason` tłumaczy ocenę i ułatwia triage. To wymaga aktualizacji każdego konsumenta schematu (uwaga z CLAUDE.md: schemat jest „fixed").
2. **Markery `hook` / `body` / `punchline` z timecode'ami** wewnątrz rolki (wizja je wymienia, dziś są tylko jako stringi metadanych) — trafiają jako markery do EDL/timeline i wymuszają, by selekcja pilnowała obecności puenty.
3. **Edytowalny prompt systemowy + presety** (CRUD jak projekty, eksport/import `.json`). Wbudowane startowe: „podcast biznesowy", „wywiad ekspercki", „wykład", „klipy merytoryczne". Bez tego jakość jest zabetonowana.
4. **Twarde reguły w promptcie selekcji** (już częściowo w `buildPrompt`, dociśnij):
   - *Wartość/merytoryka nadrzędna nad clickbaitem* — premiuj wysoką gęstość informacyjną, obniżaj puste/wypełniające fragmenty.
   - *Samodzielność* — „każda rolka zrozumiała bez reszty nagrania, zaczyna się od haka, kończy puentą".
   - *Zakaz parafrazy* — wybierasz i porządkujesz istniejące `clip_ids`, nigdy nie zmieniasz tekstu (przeciwdziała streszczaniu).
   - *Wykrywanie wiszących odniesień* — oznaczaj rolki otwierające się od zaimka/odniesienia bez kontekstu i albo dobierz segment wprowadzający, albo obniż score.
   - *Cel długości pod platformę* — TikTok 15–30 s / Reels 30–60 s / Shorts 60–90 s; dobieraj liczbę segmentów pod zakres.
5. **Niska temperatura/`effort` dla powtarzalności** — jest 0.3 (`providers.js`); przy migracji na nowsze modele Anthropic uwaga: `temperature` jest usunięte na Opus 4.7/4.8 (400) — steruj `output_config.effort` i promptem zamiast temperatury.
6. **Czyste granice cięć na poziomie słowa** — używaj wyrównania słów (`s.words` z `mergeWordsIntoSentences`, `step1-import.js`) przy dostrajaniu początku/końca segmentu: handle „dociągnij do najbliższej pauzy/oddechu". Łącz segmenty <~10 s z sąsiadem (suwak progu już jest — dodaj sensowny domyślny próg).
7. **Sygnały z audio/diaryzacji (wciąż lokalnie, tekstowo):** długie pauzy = naturalne punkty cięcia; zmiana mówcy z diaryzacji = granica tematyczna; (opcjonalnie) śmiech/oklaski jako markery emocji. Wzbogaca selekcję bez analizy obrazu.
8. **A/B providerów już jest** (`step2-analyze.js`, „Porównaj dostawców") — dobre; dopnij do tego scoring, żeby porównanie pokazywało też różnicę `virality_score`, nie tylko które `clip_ids`.

---

## Pliki, które zmienia ten kierunek (reprezentatywnie)

- `src/ai/prompt.js` — schemat selekcji (+`virality_score`,`reason`,markery), twarde reguły, chunking long-form.
- `src/ai/providers.js` — prompt systemowy z presetu, prompt caching, dobór modelu per etap, streaming.
- `src/ai/models.js` — stałe modeli per etap (selekcja vs metadane).
- `src/ui/step2-analyze.js` — `Promise.all` w `generateMetadata`, UI scoringu/sortu/`reason`, edytor+presety promptu systemowego.
- `src-tauri/src/whisper.rs` — diaryzacja (etykiety mówców na słowach).
- `src/ui/step1-import.js` — import z URL (YouTube/Vimeo), spójny pasek postępu trybu auto.
- `src/exporters/` — nowy FCPXML i CapCut draft (obok EDL/xmeml/Lua).
- `AppContext.md` — punkty z Części A.

---

## Weryfikacja

- **Prędkość metadanych:** zmierz czas `generateMetadata` przed/po `Promise.all` na projekcie z ≥8 rolkami (oczekiwane 5–10×).
- **Prompt caching:** po dodaniu `cache_control` sprawdź `usage.cache_read_input_tokens` > 0 na drugim i kolejnym wywołaniu z tym samym transkryptem; jeśli 0 — szukaj cichego inwalidatora (zmienna data/UUID/nieposortowany JSON w prefiksie).
- **Jakość selekcji:** na 2–3 realnych transkryptach porównaj rolki przed/po zmianach promptu; sprawdź odsetek rolek z obecną puentą i bez wiszących odniesień; potwierdź, że `virality_score` koreluje z subiektywną oceną montażysty.
- **Regresja eksportu:** `node --experimental-vm-modules test/regression.js` po zmianach w exporterach; FCPXML/CapCut przetestuj realnym importem do FCP X / CapCut.
- **Rust:** `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml` po zmianach w `whisper.rs`.
- **E2E:** `npm run tauri dev` — przejdź import→transkrypcja→analiza→eksport w trybie auto, potwierdź feedback postępu i obsługę błędów (brak klucza API, zły JSON).

---

## Źródła researchu

- [Opus Clip — Virality Score (Hook/Flow/Value/Trend)](https://help.opus.pro/docs/article/virality-score)
- [Vizard — AI Podcast Clip Generator / Spark 1.0](https://vizard.ai/tools/ai-podcast-clip-generator)
- [Choppity — best AI podcast clip generators (sygnały, długości platform)](https://www.choppity.com/blog/best-ai-podcast-clip-makers-generators/)
- [Two-stage LLM dla precyzyjnych timestampów w długich transkryptach (TimeStampEval)](https://arxiv.org/html/2511.11594v1)
- [Chunking strategies / „lost in the middle" w długim kontekście (Weaviate)](https://weaviate.io/blog/chunking-strategies-for-rag)
- Anthropic API: prompt caching (`cache_control: ephemeral`, ~0.1× read), Message Batches (−50%), dobór modelu Haiku/Sonnet/Opus — referencja skill `claude-api`.
