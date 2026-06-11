# F-02: Spike runtime'u wtyczki Resolve — Brief planu

> Pełny plan: `context/changes/f-02/plan.md`

## Co i po co

Time-boxowany (~1 dzień) spike badawczy, który rozstrzyga największą niewiadomą techniczną projektu: **czy runtime DaVinci Resolve Workflow Integration jest wykonalny i czy istniejący frontend Tauri da się w nim ponownie wykorzystać?** (PRD Open Question #2; FR-030; US-02.) Spike kończy się zapisanym **werdyktem 3-stanowym** — `Go` / `Go-with-rework` / `Park` — w `context/changes/f-02/decision.md`, a gdy werdykt nie brzmi `Park`, dołącza **kontrakt integracyjny** dla S-09.

## Punkt wyjścia

S-09 (`resolve-plugin-handoff`, sztandarowa funkcja „obsługa z wnętrza Resolve") jest `blocked` do czasu tego werdyktu. Wtyczka jest niezbudowana i nieudowodniona; PRD oznacza ją jako „największe pojedyncze ryzyko techniczne". Frontend (`src/`, Vite + waniliowy JS) jest webowy, ale sprzężony z backendem Rust przez wywołania `invoke()` — i to one, nie sam HTML/CSS, są blokerem ponownego użycia.

## Stan docelowy

Istnieje `context/changes/f-02/decision.md` z jednoznacznym werdyktem 3-stanowym, dowodami z badania i PoC (czy panel HTML/JS faktycznie ładuje się w Resolve Studio i sięga do API), rekomendacją strategii reuse oraz — o ile nie `Park` — skonkretyzowanym kontraktem integracyjnym dla S-09. Drzewo źródeł repo pozostaje nietknięte; artefakty PoC usunięte.

## Kluczowe decyzje

| Decyzja                  | Wybór                                                        | Dlaczego (1 zdanie)                                                                 | Źródło  |
| ------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------- |
| Głębokość spike'u        | Desk research + cienki PoC „smoke test"                     | Załadowany panel to jedyny pewny dowód; sama dokumentacja bywała myląca co do hostingu paneli | Plan    |
| Środowisko Resolve       | Resolve Studio (płatne), zainstalowane                      | Pełne API DaVinciResolveScript bez ograniczeń edycji Free                          | Plan    |
| Zakres reuse             | Ocena wszystkich trzech strategii                           | Pełny obraz: reuse 1:1 / UI + nowy most / osobny panel natywny                     | Plan    |
| Kształt werdyktu         | 3-stanowy (`Go` / `Go-with-rework` / `Park`)                | Oddaje realny wariant „wykonalne, ale wymaga mostu backendowego"                   | Plan    |
| Lokalizacja dokumentu    | `context/changes/f-02/decision.md` (folder zmiany)          | Współlokowany z notatkami roboczymi spike'u                                        | Plan    |
| Time-box                 | ~1 dzień                                                    | Tyle, by zamienić ryzyko w ugruntowany werdykt bez przeinwestowania w slice fundamentowy | Plan    |

## Zakres

**W zakresie:** badanie SDK i runtime'u; jednorazowy PoC „hello panel"; mapowanie po-F-01 powierzchni `invoke()`; ocena 3 strategii reuse; werdykt 3-stanowy + kontrakt dla S-09; sprzątnięcie PoC.

**Poza zakresem:** budowa S-09; jakakolwiek zmiana w `src/` lub `src-tauri/`; oczekiwanie na F-01; pełne rozstrzyganie pakowania/podpisywania; ścieżka edycji Free.

## Architektura / podejście

Najpierw desk research (model runtime'u z SDK Studio), potem cienki empiryczny smoke test zabijający ryzyko „czy to się w ogóle załaduje?", potem uporządkowana ocena trzech strategii reuse względem po-F-01 powierzchni `invoke()` (która po F-01 to tylko ~6 komend + wywołania AI, które już dziś są zwykłym `fetch`), a na końcu spisany werdykt. PoC jest celowo minimalny i jednorazowy.

## Fazy w skrócie

| Faza                          | Co dostarcza                                              | Kluczowe ryzyko                                           |
| ----------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| 1. Desk research SDK/runtime  | Notatki: hosting paneli, API, pakowanie, gating Studio/Free | Dokumentacja niepełna lub myląca                          |
| 2. PoC smoke test (jednorazowy) | Dowód, że panel ładuje się i sięga do API Resolve         | Panel się nie ładuje / API nieosiągalne (cenne dla werdyktu) |
| 3. Ocena reuse frontendu      | Mapowanie `invoke()`→most + rekomendacja strategii        | Błędne mapowanie na powierzchnię sprzed F-01              |
| 4. Dokument decyzji + sprzątanie | `decision.md` z werdyktem + kontraktem; usunięcie PoC     | Werdykt zbyt ogólny, by S-09 mógł na nim planować         |

**Prerekwizyty:** Resolve Studio zainstalowane; znajomość po-F-01 powierzchni `invoke()` (opisana w planie). Brak zależności od ukończenia F-01 — fazy biegną równolegle.
**Szacowany wysiłek:** ~1 dzień, 4 fazy (research → PoC → ocena → dokument).

## Otwarte ryzyka i założenia

- Jeśli Faza 2 trafi na twardą ścianę (panel się nie ładuje / API nieosiągalne), należy przerwać wcześnie i zapisać to jako wynik skłaniający do `Park`, zamiast wypalać cały time-box.
- Edge case'y pakowania/podpisywania mogą zostać oznaczone jako ryzyko, nie w pełni udowodnione w ramach 1 dnia.
- Werdykt `Park` jest poprawnym, nieblokującym wynikiem — S-09 ma wtedy fallback do S-08 (eksport plików).

## Kryteria sukcesu (podsumowanie)

- Istnieje `decision.md` z jednym jednoznacznym werdyktem 3-stanowym.
- Gdy nie `Park`: kontrakt integracyjny jest na tyle konkretny, że S-09 może na nim planować (lista komend mostu + pakowanie + strategia reuse).
- Drzewo źródeł repo nietknięte; artefakty PoC usunięte.
