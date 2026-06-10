---
project: Reels Automator
version: 1
status: draft
created: 2026-06-10
updated: 2026-06-10
source: context/foundation/roadmap.md (v1)
purpose: plan paralelizacji worktrees — które plasterki mogą być budowane jednocześnie w oddzielnych git worktrees
---

# Strumienie: plan paralelnych worktrees

> Towarzysz do `roadmap.md`. Roadmap porządkuje plasterki według **zależności**.
> Ten plik porządkuje je po **rozłączności plików** — co może faktycznie być budowane
> obok siebie w oddzielnych worktrees bez kolizji podczas merge'a.
>
> **Dwa plasterki są bezpieczne dla worktree razem tylko gdy oba warunki są spełnione:**
> 1. Żaden nie jest warunkiem wstępnym drugiego (bezpieczne ze względu na zależności — z roadmapy).
> 2. Nie edytują tych samych plików (bezpieczne ze względu na zajętość — z tego dokumentu).
>
> Tabela "Streams" w roadmapie spełnia (1). Nie spełnia (2):
> pięć plasterków (S-01, S-02, S-03, S-04, S-14) przepisuje ten sam plik 1408-wierszowy
> `src/ui/step2-analyze.js`. Paralelizm zależności ≠ paralelizm worktree.

## Stan repozytorium (2026-06-10)

- Repo git obecne, pojedyncza gałąź `master` @ `dc538d1`, brak jeszcze worktrees.
- Bazowa commit `0a728e2` = pracująca aplikacja *przed* usunięciem ścieżki renderowania.
- Jedynym automatycznym zabezpieczeniem jest `node --experimental-vm-modules test/regression.js`
  (parsowanie + eksportery EDL/XML/Lua). Każda fala poniżej kończy się jego uruchomieniem.

## Zajętość plików na plasterek

Primary = plasterek jest właścicielem/tworzy te pliki. **Plik wspólny gorący** = edytowany przez 2+ plasterki;
to są powierzchnie konfliktu merge'a.

| Plasterek | Pliki główne (będące własnością) | Pliki wspólne gorące, które dotyka |
| ----- | --------------------- | --------------------------- |
| **F-01** remove-render | `src/render/*` (usunięcie), `src-tauri/src/rendering.rs` + `face_detect.rs` (usunięcie), `tauri.conf.json` | `src-tauri/src/lib.rs`, `src/ui/step3-export.js`, `src/main.js`, `src/state.js`, `test/regression.js` |
| **F-02** resolve-spike | *(żaden kod — pisze dokument decyzji)* | — |
| **S-01** scored-selection-edl | `src/ai/prompt.js`, `src/ai/providers.js`, `src/ai/models.js`, `src/exporters/edl.js` | `src/ui/step2-analyze.js`, `src/state.js`, `test/regression.js` |
| **S-02** reel-list-ui | `src/styles.css` (lista) | `src/ui/step2-analyze.js` |
| **S-03** prompt-presets | `src/ai/presets.js` (nowy), preset file IO w `src-tauri` | `src/ai/prompt.js`, `src/ui/step2-analyze.js`, `src/state.js` |
| **S-04** segment-tuning | `src/parser/segments.js`, `src/render/fillers.js`† | `src/ui/step2-analyze.js`, `src/state.js`, `test/regression.js` |
| **S-05** whisperx | `src-tauri/src/whisper.rs`, `src/ui/step1-import.js`, moduł segmentacji | `src-tauri/src/lib.rs`, `tauri.conf.json`, `src/state.js` |
| **S-06** word-trim | konsument zeitstempel słów, heurystyka snap | `src/ui/step2-analyze.js`, `src/state.js` |
| **S-07** auto-mode | orkiestrator postępu etapów | `src/main.js`, `src/ui/step1-import.js`, `src/ui/step2-analyze.js`, `src/ui/step3-export.js` |
| **S-08** export-set | `src/exporters/xml.js`, `src/exporters/lua.js`, `src/exporters/fcpxml.js` (nowy) | `src/ui/step3-export.js`, `test/regression.js` |
| **S-09** resolve-plugin | runtime wtyczki / host panelu | `src/ui/step3-export.js` (kablowanie fallback) |
| **S-10** i18n | `src/i18n/*` (nowe klucze) | **każdy plik `src/ui/*` + `src/main.js`** |
| **S-11** keychain | moduł keychain `src-tauri`, `src/ai/openrouter-picker.js` | `src/ai/providers.js`, `src/main.js`, `src/ui/step1-import.js`, `src/ui/step2-analyze.js`, `src-tauri/src/lib.rs` |
| **S-12** error-states | — | `src/ui/step1-import.js`, `src/ui/step2-analyze.js`, `src/ui/step3-export.js` |
| **S-13** keyboard | moduł klawiatury | `src/main.js`, `src/ui/step2-analyze.js` |
| **S-14** quality-flags | moduł post-pass wiszącej referencji | `src/ai/prompt.js`, `src/ui/step2-analyze.js` |
| **S-15** preview | moduł preview/playback | `src/ui/step2-analyze.js` |

† `src/render/fillers.js` to logika strony selekcji (Polski zestaw słów wypełniających), nie logika
renderowania. **F-01 musi go zachować** (przenieść do `src/parser/fillers.js` lub `src/selection/`)
ponieważ S-04 od niego zależy. Zaznacz to wyraźnie w planie F-01.

## Mapa konfliktu plików gorących

Pliki, które decydują, co może działać równolegle:

| Plik gorący | Plasterki, które go edytują | Konsekwencja |
| -------- | ------------------- | ----------- |
| `src/ui/step2-analyze.js` (1408 LoC) | S-01, S-02, S-03, S-04, S-06, S-07, S-11, S-12, S-13, S-14, S-15 | **Wąskie gardło.** Prawie wszystko na frontendie przechodzi tutaj. Musi być podzielony (patrz Prep R1) lub te plasterki się szeregują. |
| `src/state.js` (68 LoC) | F-01, S-01, S-03, S-04, S-05, S-06 | Niska dotkliwość: edycje to *addytywne* typy/pola w różnych regionach. Wyląduj S-01 najpierw, rebase reszta. |
| `src/ai/prompt.js` (85 LoC) | S-01, S-03, S-14 | S-01 ustawia schemat; S-03 go de-hardkoduje; S-14 dodaje reguły. Szereguj: S-01 → S-03 → S-14. |
| `src-tauri/src/lib.rs` | F-01, S-05, S-11 | Lista rejestracji komend. F-01 usuwa 4; S-05/S-11 dodają. F-01 ląduje pierwsza → inne robią rebase czysty. |
| `test/regression.js` | F-01, S-01, S-04, S-08 | Tylko dodawanie testów; konflikty to trywialne tekstowe dodatki. |
| `src/ui/step3-export.js` (1229 LoC) | F-01, S-07, S-08, S-09, S-12 | F-01 usuwa kartę renderowania najpierw; S-08 wtedy ją posiada. |
| `src/main.js` | F-01, S-07, S-11, S-13 | Routing etapów + czytania kluczy. |
| miejsca czytania kluczy (`edl_apikey`) | S-11 vs S-01/S-02 | 4 pliki go czytają dzisiaj; patrz Prep R2. |

## Przygotowawcze refaktory, które odblokują paralelizm

Rób to **wewnątrz plasterka, który ląduje pierwszy**, nie jako zmiana standalone — konwertują
dwie najgorsze powierzchnie konfliktu na pliki będące własnością.

- **R1 — podziel `step2-analyze.js`** (rób to jako otwarcie S-01).
  Wyciągnij plik 1408-wierszowy na: `step2-reel-list.js` (→ S-02), `step2-prompt-panel.js`
  (→ S-03), `step2-segment-ops.js` (→ S-04), zostawiając `step2-analyze.js` jako cienki
  orkiestrator. Po tym S-02/S-03/S-04/S-14/S-15 każdy posiada inny plik i
  stają się prawdziwymi partnerami worktree zamiast szeregowych.
- **R2 — abstrakcja `getApiKey()/setApiKey()`** (rób to jako otwarcie S-11,
  *przed* S-01 jeśli to możliwe). Zastąp 4 bezpośrednie czytania `localStorage.edl_apikey_*`
  jednym helperem. Wtedy S-11 zamienia backing store helpera (keychain) bez
  dotykania providers/step1/step2, i przestaje konfliktować z S-01.

## Fale paralelne

Każda fala = zestaw worktrees bezpiecznych do jednoczesnego uruchomienia. Merge'uj falę, uruchamiaj
regresję, potem otwórz następną. "⇒ porządek merge'a" rozwiązuje addytywne edycje plików wspólnych (state.js, prompt.js, lib.rs).

### Fala 0 — fundamenty (2 worktrees)
| Worktree | Plasterek | Dlaczego bezpieczny równolegle |
| --- | --- | --- |
| `wt-remove-render` | **F-01** | Jedynym budowniczym powierzchni renderowania. |
| `wt-resolve-spike` | **F-02** | Tylko badanie — pisze doc, zero nakładania kodu. |

F-01 jest **jedynym** czymś dotykającym `src/render/*`, `rendering.rs`, `face_detect.rs`,
kartę renderowania i listę handlera `lib.rs`. Nic innego nie może działać podczas gdy robi to —
wszyscy konfliktuję na lib.rs, step3, state.js, main.js. Wyląduj F-01 → regresja zielona → Fala 1.
*(Helper R2 S-11 może też być wsunięty tutaj, ponieważ jest wolny od warunków wstępnych i tylko
pomaga późniejszym falom.)*

### Fala 1 — dwa silniki + hartowanie (3 worktrees)
Po merge'u F-01.
| Worktree | Plasterek | Zajętość | Obserwacja nakładania |
| --- | --- | --- | --- |
| `wt-selection` | **S-01** (inkl. R1 split) | `src/ai/*`, `edl.js`, dzieli `step2-*` | `state.js`, `regression.js` |
| `wt-whisperx` | **S-05** | `whisper.rs`, `step1-import.js`, `lib.rs`, `tauri.conf` | `state.js` |
| `wt-keychain` | **S-11** (inkl. R2) | moduł keychain, `openrouter-picker.js` | `lib.rs`, miejsca czytania klucza |

S-01 = AI frontendu + eksporter; S-05 = backend Rust + step1; S-11 = credentials.
Głównie rozłączne. Jedyne wspólne pliki to **addytywne**: `state.js` (S-01/S-05/S-11),
`lib.rs` (S-05/S-11). **⇒ porządek merge'a: S-01 → S-05 → S-11**, rebase'ując każdy na
poprzednim. Robienie R1 wewnątrz S-01 i R2 wewnątrz S-11 to co czyni Falę 2 szerokią.

### Fala 2 — powierzchnie selekcji + exporty (do 5 worktrees, *wymaga R1*)
Po merge'u S-01. Bez R1 te szeregują się na `step2-analyze.js`; z R1 każdy posiada plik.
| Worktree | Plasterek | Posiadany plik (post-R1) |
| --- | --- | --- |
| `wt-reel-list` | **S-02** | `step2-reel-list.js` |
| `wt-prompt-presets` | **S-03** | `step2-prompt-panel.js` + `prompt.js`¹ |
| `wt-segment-ops` | **S-04** | `step2-segment-ops.js` + `segments.js` |
| `wt-export-set` | **S-08** | `exporters/*` + `step3-export.js` (całkowicie rozłączny od step2 — najbezpieczniejszy partner) |
| `wt-quality-flags` | **S-14** | moduł post-pass + `prompt.js`¹ |

¹ S-03 i S-14 oba dotykają `prompt.js`. **⇒ porządek merge'a w ramach fali: S-03 → S-14**
(albo uruchom S-14 w Fali 3). S-08 dotyka ani step2 ani prompt.js — to
czystszy równoległy plasterek w całym projekcie i może się zacząć zaraz gdy S-01 ląduje.

### Fala 3 — zależne od transkrypcji + auto + stany (po S-04 & S-05)
| Worktree | Plasterek | Warunki wstępne spełnione przez | Obserwacja nakładania |
| --- | --- | --- | --- |
| `wt-word-trim` | **S-06** | S-04 + S-05 | `step2-segment-ops.js` |
| `wt-auto-mode` | **S-07** | S-01 + S-05 | `main.js`, wszystkie kroki — utrzymuj cienkie (tylko orkiestracja) |
| `wt-error-states` | **S-12** | S-01 + S-05 | wszystkie kroki — cienkie przejście konsolidacyjne |
| `wt-preview` | **S-15** | S-04 | własny moduł preview |

S-07 i S-12 oba się rozciągają na wszystkie trzy pliki step; jeśli oba działają, **⇒ merge S-12 → S-07**
(stany błędu najpierw, potem auto-mode przeprowadza się przez nie). S-06 i S-15 posiadają moduły → wolne.

### Fala 4 — przecinające się + zablokowane (głównie szeregowe)
| Worktree | Plasterek | Notatka |
| --- | --- | --- |
| `wt-keyboard` | **S-13** | wymaga S-02 + S-04; `main.js` + mapa klawiatury step2 |
| `wt-resolve-plugin` | **S-09** | **zablokowany** dopóki F-02 zwróci "viable"; inaczej parkuje się w fallback S-08 |
| `wt-i18n` | **S-10** | **uruchom samotnie.** Dotyka każdy plik UI — ekstrakcja łańcuchów musi być *ostatnim* przejściem obejmującym interfejs użytkownika, aby łańcuchy były ekstrahowane raz. Nie rób worktree-parallel S-10 z czymś, co edytuje `src/ui/*`. |

## Komendy worktree

```bash
# z głównego checkoutu (master). Jeden worktree + gałąź na plasterek:
git worktree add ../reel-wt-selection    -b stream/scored-selection-edl
git worktree add ../reel-wt-whisperx     -b stream/builtin-whisperx-transcription
git worktree add ../reel-wt-keychain     -b stream/keychain-credentials

# każdy worktree to pełny niezależny checkout — uruchamiaj dev/testy wewnątrz:
cd ../reel-wt-selection && npm run tauri dev
node --experimental-vm-modules test/regression.js   # przed I po każdym plasterku

# zintegruj skończony stream:
cd <główny checkout>
git merge --no-ff stream/scored-selection-edl
node --experimental-vm-modules test/regression.js   # brama przed otwarciem następnej fali

# czyść:
git worktree remove ../reel-wt-selection
```

Nazewnictwo gałęzi odbija **Change ID** z roadmapy (`stream/<change-id>`) aby worktree
mapował 1:1 do jednostki `/10x-plan <change-id>`.

## Praktyczne zasady

1. **Jeden plasterek = jeden worktree = jedna gałąź = jeden Change ID.** Nie bundluj.
2. **Uruchamiaj regresję przed i po** każdym plasterku (jedynym zabezpieczeniem; F-01 i S-08
   to wysokie ryzyka usunięcia/zmiany formatu, które PRD wyznacza).
3. **Addytywne pliki wspólne** (`state.js`, `lib.rs`, `regression.js`) → rozwiąż przez
   porządek merge'a, nie przez unikanie; konflikty są trywialne.
4. **Strukturalne pliki wspólne** (`step2-analyze.js`, `prompt.js`) → plasterek, który
   ląduje pierwszy robi split/abstrakcję (R1/R2) aby późniejsze plasterki posiadały pliki.
5. **S-10 (i18n) i F-01 (remove-render) nigdy nie są co-paralelne z pracą UI** —
   dotykają wszystkiego; daj każdemu swoje spokojne okno.
```
