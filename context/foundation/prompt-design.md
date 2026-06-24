---
title: AI-analysis prompt design — per-phase rewrites + BRAVE cohort presets
status: design (ready to wire in S-26)
created: 2026-06-24
backs: S-26 (refactor-ai-prompts)
---

# AI-analysis prompt design

Engineered prompt text for the AI-selection pipeline, ready to drop into
`src/ai/prompt.js` (per-phase guidance defaults) and `src/ai/prompt-presets.js`
(per-cohort `userPrompt` presets). This is the design artifact behind roadmap
slice **S-26**; it is *authored* here and *wired in* by that slice.

## How prompts compose (two editable layers)

Every analysis call is assembled by the builders in `src/ai/prompt.js` as:

```
userPrompt  →  [machine-owned static block: segments + RESPONSE_FORMAT]  →  guidance
```

- The **static block** (segment list + JSON response-format example) is
  machine-owned and *always* injected — editing prompts can never break the
  export pipeline (`validateReels` / `validateThemes` stay the safety gate).
- **Two layers are editable**, and this doc redesigns both:
  1. **Per-phase guidance** — the rubric/system layer:
     `DEFAULT_CLUSTER_GUIDANCE` (Stage 1), `DEFAULT_CURATE_GUIDANCE` (Stage 2),
     `DEFAULT_SCORING_GUIDANCE` (single-shot). One per analysis phase.
  2. **`userPrompt` presets** — the editor's per-job creative framing
     (`BUILTIN_PRESETS` in `prompt-presets.js`). Redesigned as one preset per
     **BRAVE cohort**.

The three phases (S-25): **Stage 1 cluster** (cheap big-context model →
`{themes:[{title, candidate_ids[]}]}`), **Stage 2 curate** (premium model →
scored reel schema, per theme bucket), and the **single-shot** fallback for
short transcripts (scored schema over all segments at once).

## Language policy

Per the established lesson ([[llm-prompt-instructions-english]]): **instruction
blocks are written in English** (English tokenizes ~30 % leaner than Polish and
the guidance rides on every call), with an **explicit directive to write all
model OUTPUT in Polish** (`reel_name`, `reason`, theme `title`). The per-cohort
`userPrompt` presets stay **Polish** — they are the editor's primary, frequently
edited creative surface, they are short, and the whole UI is Polish.

> **S-26 update (2026-06-24, shipped):** the cohort presets below were flipped to
> **English instructions** during implementation (user-directed), extending the
> same English-instruction/Polish-output policy to the `userPrompt` layer. The
> shipped presets use a labeled `AUDIENCE → LOOK FOR → HOOK → LENGTH → CTA`
> structure and end with a Polish-output anchor; picker **names** stay Polish.
> The Polish text in the section below is the original design draft — see
> `src/ai/prompt-presets.js` for the shipped English wording.

## Research-backed principles applied

| Principle | Source | How it shows up here |
| --- | --- | --- |
| Structure beats length; clear specs in labelled sections, not prose | [Prompt Eng. Best Practices 2026](https://promptbuilder.cc/blog/prompt-engineering-best-practices-2026) | Every guidance block is `ROLE → TASK → RUBRIC → CONSTRAINTS → OUTPUT` with hard headers |
| Reasoning degrades past ~3k tokens; instruction sweet spot ~150–300 words | [SuperPrompts 2026](https://superprompts.app/blog/prompt-engineering-best-practices-2026) | Guidance kept tight; rubric uses compact score-bands, not paragraphs (also: guidance sits *after* the cacheable prefix, so verbosity is paid per Stage-2 bucket) |
| Assign a domain role first to unlock domain knowledge | [Mercity — Advanced Prompt Eng.](https://www.mercity.ai/blog-post/advanced-prompt-engineering-techniques/) | Each phase opens with an explicit expert role |
| Rubric scoring: define each axis with concrete anchors; low temperature | [Promptfoo LLM-rubric](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/llm-rubric/), [RULERS](https://www.emergentmind.com/topics/rulers-rubric-unification-locking-and-evidence-anchored-robust-scoring) | Hook/Flow/Value/Trend get explicit 0–100 score bands |
| Define fuzzy concepts; use "MUST"/"make sure" for hard constraints | [Vizard Spark](https://vizard.ai/spark), short-form clip-selection guidance | "What makes a strong clip" is spelled out; punchline inclusion is a MUST |
| Good short-form clip = hook in first 3 s, one clear point, self-contained, early tension | [MindStudio short-form system](https://www.mindstudio.ai/blog/ai-short-form-video-creation-skill-system) | Encoded directly in the curate/scoring rubric |
| Few-shot helps but over-prompting hurts — keep examples minimal | [Few-shot dilemma (arXiv)](https://arxiv.org/html/2509.13196v1) | No bulky in-prompt examples; the machine-owned JSON example is the only shot |
| LLMs can't reliably distinguish fine-grained scores (73 vs 76); small scales / bands calibrate far better | [QASkills LLM-as-a-Judge 2026](https://qaskills.sh/blog/llm-as-a-judge-evaluation-guide-2026), [LangChain](https://www.langchain.com/resources/llm-as-a-judge) | The 0–100 axes are expressed as **score bands** (85–100 / 60–84 / …) — effectively 4 buckets; the raw `virality_score` int is cosmetic, the band is the signal |
| Name the hook archetype — vague "stops the scroll" underperforms a named pattern | [thecontentlabs (4k videos)](https://thecontentlabs.app/blog/what-goes-viral-in-2026-data-study), [Kompozy](https://kompozy.io/how-to/write-viral-hooks) | Curate/scoring rubric names **Hot Take · Investigator · Proof Drop · Contrarian** (Proof Drop = number/chart → highest saves, ideal for number-heavy course material) |
| Start the clip mid-moment at the peak hook, not the chronological opening | [autoclip — viral clip formula](https://autoclip.dev/blog/viral-clip-formula-what-makes-clips-go-viral) | Reorder-for-retention is explicit; "start at the peak hook moment" added to the curate TASK |
| `trend` / shareability = identity alignment, not generic "viral feel" | [autoclip](https://autoclip.dev/blog/viral-clip-formula-what-makes-clips-go-viral) | `trend` axis redefined as *identity-aligned shareability* (would a viewer send this to signal their values/group?) |
| Verbosity/length bias — judges over-reward long answers | [alatirok playbook](https://alatirok.com/llm-as-a-judge-production-playbook/) | Explicit "tighter is better; do not reward length, penalize padding" in curate + single-shot |
| Low temperature for selection/scoring — high temp degrades JSON adherence + score consistency | [OpenReview — Temperature in LLM-as-Judge](https://openreview.net/pdf/b4752d5b8dfb25d70ebab0a58122e2cd81cb447b.pdf), [alatirok](https://alatirok.com/llm-as-a-judge-production-playbook/) | Implementation note: run curate/single-shot at temp 0–0.2; Stage-1 clustering may go slightly higher |

> Full evidence + citations: `context/changes/refactor-ai-prompts/research.md`.

---

## Phase 1 — Stage-1 clustering guidance (`DEFAULT_CLUSTER_GUIDANCE`)

Cheap, big-context model. Sorts the full segment list into thematic piles; emits
**no** segment text back (output stays tiny).

```text
ROLE: You are a content strategist triaging a long Polish webinar/course
recording into themed buckets that will later become short vertical Reels.

TASK: Read the numbered segments and group them into thematically coherent
clusters ("themes"). Each theme is one candidate Reel.

WHAT MAKES A GOOD THEME:
- One clear, self-contained idea, story, demo, or argument a viewer could grasp
  without the rest of the recording.
- Enough material to build a 20–90 s Reel: a hook moment + supporting body +
  a payoff/conclusion.
- Prefer themes with an emotional beat, a concrete number/result, a strong
  claim, or an "aha" insight — these travel on social.

RULES:
- Aim for ~10 themes; list ~15–25 of the strongest candidate ids per theme,
  roughly ordered by how central each segment is to the theme.
- A segment may appear in more than one theme if it genuinely fits both.
- Use ONLY segment ids that exist in the list below. NEVER invent ids.
- Skip pure filler (greetings, "can you hear me?", logistics, dead air).

OUTPUT: Write every "title" value in Polish — a short, scroll-stopping topic
label (max ~8 words), not a generic heading. Return ONLY the JSON.
```

## Phase 2 — Stage-2 curation guidance (`DEFAULT_CURATE_GUIDANCE`)

Premium model. Receives one theme bucket; builds the best Reel and scores it on
the fixed S-01 schema.

```text
ROLE: You are an elite short-form video editor and social strategist who turns
long Polish recordings into high-retention vertical Reels (TikTok / Reels /
Shorts).

TASK: You receive the segments of ONE theme. Build the single best possible
Reel from them and score it. Select only the strongest segments and order them
as HOOK → BODY → CTA/PUNCHLINE. You may reorder segments for retention; start
the Reel at the PEAK hook moment (often mid-thought), not the chronological
opening — never cut before the key message.

A STRONG REEL:
- Lands its hook in the first ~3 seconds. Prefer a named hook archetype:
  HOT TAKE (bold opinion), INVESTIGATOR (a question/mystery to resolve),
  PROOF DROP (a concrete number/result/claim — strongest for educational
  content), or CONTRARIAN (inverts what the audience assumes; the Reel must then
  actually back it up).
- Makes ONE clear point and is understandable without the rest of the recording.
- Builds to a payoff — an insight, result, or call to action.
- Runs ~20–90 s; tighter is better — do NOT reward length, penalize padding and
  dead air. Every second must advance the point or hold tension.

SCORING — rate 0–100 on each axis, then set virality_score as the overall
(axis-consistent) judgement:
- hook  (opening strength): 85–100 instant scroll-stop · 60–84 solid open ·
  40–59 slow/contextual · <40 no hook.
- flow  (montage logic): 85–100 seamless, self-contained · 60–84 minor jumps ·
  40–59 needs context · <40 disjointed.
- value (substance): 85–100 memorable takeaway · 60–84 useful · 40–59 generic ·
  <40 filler.
- trend (identity-aligned shareability — would a viewer send this to signal
  their values/group, or because it's a strong shareable angle?): 85–100 strong
  identity/share pull · 60–84 some pull · 40–59 niche · <40 flat.

CONSTRAINTS:
- The selection MUST include the punchline segment.
- markers.hook / markers.body / markers.punchline MUST be clip_ids drawn from
  THIS reel's clip_ids.

OUTPUT: Write "reel_name" and "reason" in Polish ("reason" = exactly one
sentence). Return ONLY the JSON.
```

## Phase 3 — Single-shot scoring guidance (`DEFAULT_SCORING_GUIDANCE`)

Short-transcript fallback: one call over all segments. Same rubric as curation,
but it also has to *find* the reels (no upstream clustering).

```text
ROLE: You are an elite short-form video editor and social strategist who turns
long Polish recordings into high-retention vertical Reels.

TASK: From the full segment list, find every Reel worth cutting and score each.
Build as many strong Reels as the material genuinely supports — do not pad with
weak ones. For each Reel select the strongest segments and order them
HOOK → BODY → CTA/PUNCHLINE (reordering is allowed; never cut before the key
message). A segment may belong to at most one Reel.

A STRONG REEL: hook in the first ~3 s (prefer a named archetype — HOT TAKE /
INVESTIGATOR / PROOF DROP / CONTRARIAN) · ONE clear, self-contained point ·
builds to a payoff · ~20–90 s, tighter is better — penalize padding/dead air ·
start at the peak hook moment, not the chronological opening.

SCORING — rate 0–100 per axis, then set virality_score as the overall
(axis-consistent) judgement:
- hook  85–100 instant scroll-stop · 60–84 solid · 40–59 slow · <40 none.
- flow  85–100 seamless/self-contained · 60–84 minor jumps · <40 disjointed.
- value 85–100 memorable takeaway · 60–84 useful · <40 filler.
- trend (identity-aligned shareability) 85–100 strong identity/share pull ·
  60–84 some pull · <40 flat.

CONSTRAINTS:
- Each selection MUST include its punchline segment.
- markers.{hook,body,punchline} MUST be clip_ids from that Reel's clip_ids.
- Skip filler (greetings, logistics, dead air).

OUTPUT: Write "reel_name" and "reason" in Polish ("reason" = one sentence).
Return ONLY the JSON.
```

---

## BRAVE cohort presets (`userPrompt` layer, Polish)

BRAVE EDUCATION Sp. z o.o. (Poznań) runs **cohort-based AI courses** (5–6 weeks,
live sessions, project not exam). The recordings fed into this app are their
webinars/lessons; each preset frames reel selection around **marketing one
cohort to its audience**. Replace the four generic starters in `BUILTIN_PRESETS`
with these (keep the structure `{ id, name, userPrompt }`).

Cohorts confirmed via [brave.courses](https://www.brave.courses/) /
[brave.inc/about](https://brave.inc/about): AI_devs, 10xDevs, AI_Managers,
AI Product Heroes, AI_Marketers, AI_Sales, AI HR, AI_Enterprise, plus the
AI 360 / general bundle. Each preset shares one spine — *audytorium → czego
szukać → długość → CTA* — tuned per persona.

> Note: these are intentionally shorter than the old starters — the per-phase
> guidance now carries the rubric/structure, so the `userPrompt` only supplies
> **cohort framing**, not montage rules (avoids duplicating instructions and
> keeps per-call tokens down).

### `builtin-brave-ai-devs` — "AI_devs (programiści)"
```text
Wytnij reelsy promujące kohortę AI_devs — kurs AI dla programistów.
Audytorium: developerzy, którzy chcą realnie budować z LLM-ami (agenci, RAG, API), nie tylko czytać o AI.
Czego szukać: konkretne momenty techniczne, które budują wiarygodność — działające demo, architektura rozwiązania, „to faktycznie działa", liczby/wyniki, twarda wiedza praktyczna.
Hook: konkretny problem techniczny lub zaskakujący wynik w pierwszych sekundach.
Długość: 30–75 s. Unikaj fragmentów czysto organizacyjnych.
CTA: jeśli pojawia się zachęta do nauki/dołączenia — potraktuj ją jako punchline Reela.
```

### `builtin-brave-10xdevs` — "10xDevs (GenAI w kodzie)"
```text
Wytnij reelsy promujące kohortę 10xDevs — generatywne AI w całym cyklu wytwarzania oprogramowania.
Audytorium: inżynierowie oprogramowania, którzy chcą pracować 10x szybciej z AI (agentic coding, asystenci, automatyzacja).
Czego szukać: momenty „przed/po", realne przyspieszenie pracy, konkretne triki i workflow, efekt „wow, tak się da".
Hook: obietnica oszczędności czasu lub zaskakująca demonstracja produktywności.
Długość: 30–75 s.
CTA: zachętę do wejścia na wyższy poziom pracy z AI ustaw jako puentę.
```

### `builtin-brave-ai-managers` — "AI_Managers (liderzy)"
```text
Wytnij reelsy promujące kohortę AI_Managers — wdrażanie AI w pracy menedżera, w zespołach i organizacji.
Audytorium: menedżerowie i liderzy decydujący o strategii i wdrożeniu AI w firmie.
Czego szukać: argumenty biznesowe — ROI, konkretne liczby, ryzyka, framework/Canvas wdrożenia, decyzje strategiczne, „jak to poukładać w organizacji".
Hook: biznesowy problem lub mocna teza o przyszłości pracy z AI.
Długość: 30–90 s.
CTA: zachętę do uporządkowania wdrożenia AI ustaw jako puentę.
```

### `builtin-brave-product-heroes` — "AI Product Heroes (product)"
```text
Wytnij reelsy promujące kohortę AI Product Heroes — budowanie produktów z AI.
Audytorium: product managerowie i twórcy produktów, którzy chcą budować z AI od pomysłu do wdrożenia.
Czego szukać: momenty od pomysłu do produktu — discovery, MVP, decyzje produktowe, walidacja, konkretne przykłady zbudowanych rzeczy.
Hook: realny problem produktowy albo szybka droga od zera do działającego produktu.
Długość: 30–90 s.
CTA: zachętę do zostania product builderem ustaw jako puentę.
```

### `builtin-brave-ai-marketers` — "AI_Marketers (marketing)"
```text
Wytnij reelsy promujące kohortę AI_Marketers — narzędzia AI do skutecznych kampanii marketingowych.
Audytorium: marketerzy, którzy chcą tworzyć i prowadzić kampanie szybciej i lepiej dzięki AI.
Czego szukać: konkretne narzędzia i workflow, efekty „przed/po", oszczędność czasu, realne przykłady kampanii i treści.
Hook: zaskakujący efekt kampanii lub konkretny trik z narzędziem AI.
Długość: 25–75 s.
CTA: zachętę do podniesienia skuteczności marketingu z AI ustaw jako puentę.
```

### `builtin-brave-ai-sales` — "AI_Sales (sprzedaż)"
```text
Wytnij reelsy promujące kohortę AI_Sales — AI w procesie sprzedaży.
Audytorium: handlowcy i liderzy sprzedaży, którzy chcą domykać więcej dzięki AI.
Czego szukać: konkretne momenty z procesu sprzedaży — prospecting, kwalifikacja, follow-up, konwersja, realne liczby i skrypty.
Hook: konkretny problem sprzedażowy albo wynik (więcej leadów / wyższa konwersja).
Długość: 25–75 s.
CTA: zachętę do usprawnienia sprzedaży z AI ustaw jako puentę.
```

### `builtin-brave-ai-hr` — "AI HR (HR)"
```text
Wytnij reelsy promujące kohortę AI HR — AI w obszarze HR.
Audytorium: specjaliści i liderzy HR, którzy chcą wykorzystać AI w rekrutacji, onboardingu i rozwoju ludzi.
Czego szukać: konkretne zastosowania AI w HR — szybsza rekrutacja, automatyzacja procesów, lepsze decyzje o ludziach, realne przykłady.
Hook: bolączka HR-owa lub konkretny efekt usprawnienia procesu.
Długość: 30–80 s.
CTA: zachętę do wprowadzenia AI w HR ustaw jako puentę.
```

### `builtin-brave-ai-enterprise` — "AI_Enterprise (korporacje)"
```text
Wytnij reelsy promujące AI_Enterprise — programy transformacji AI dla dużych firm.
Audytorium: decydenci w dużych organizacjach planujący transformację AI na skalę.
Czego szukać: argumenty o skali i transformacji — diagnoza kompetencji, wdrożenie w całej organizacji, ryzyka, governance, mierzalne efekty.
Hook: mocna teza o transformacji lub konkretny efekt skali.
Długość: 40–90 s.
CTA: zachętę do rozpoczęcia transformacji AI w organizacji ustaw jako puentę.
```

### `builtin-brave-ai-360` — "AI 360 / ogólny (BRAVE)"
```text
Wytnij viralowe reelsy edukacyjne o AI promujące szkolenia BRAVE (oferta AI 360 — wszystkie role: marketing, produkt, sprzedaż, HR, devs).
Audytorium: ambitne, kreatywne osoby, które chcą realnie nauczyć się używać AI w pracy.
Czego szukać: najmocniejsze, samodzielne momenty „aha" o AI — konkretne insighty, zaskakujące fakty, praktyczne porady, które działają niezależnie od kontekstu nagrania.
Hook: mocny, zatrzymujący scroll insight o AI w pierwszych 3 sekundach.
Długość: 20–60 s. Im bardziej treściwy fragment, tym lepiej.
CTA: zachętę do praktycznej nauki AI z BRAVE ustaw jako puentę.
```

---

## Implementation notes (for S-26)

- Phases 1–3 replace the three `DEFAULT_*_GUIDANCE` constants in
  `src/ai/prompt.js`. The machine-owned `RESPONSE_FORMAT` /
  `CLUSTER_RESPONSE_FORMAT` blocks and `validateReels` / `validateThemes` stay
  **unchanged** — the JSON schema is not touched, so no exporter / `.reelproj`
  consumer changes (CLAUDE.md "update every consumer" rule has no new field to
  thread). `state.systemPrompt` / `clusterPrompt` / `curatePrompt` already seed
  from these constants (`src/state.js:111,115,116`).
- The cohort presets replace `BUILTIN_PRESETS` in `src/ai/prompt-presets.js`
  (same `{ id, name, userPrompt }` shape). `seedPresetsIfEmpty()` only seeds on
  first run, so a migration for existing users (who already have the 4 old
  starters in `localStorage.edl_prompt_presets`) must be decided in S-26 — see
  the slice's Unknowns.
- Keep all user-facing strings Polish; keep instruction blocks English with the
  Polish-output directive ([[llm-prompt-instructions-english]]).
- **Temperature (verify in `src/ai/providers.js` → `callOpenRouter`):** run the
  curate + single-shot scoring calls at low temperature (0–0.2) — high temp
  degrades JSON-format adherence and score consistency. Stage-1 clustering
  (creative theme-finding) may run slightly higher. This is a runtime/config
  check, not a prompt-text change, but it's part of making the rubric trustworthy.
- No parser/exporter/frame-math impact → run
  `node --experimental-vm-modules test/regression.js` to confirm green before/
  after (it should be unaffected; prompts are not exercised by the suite).

### Logged as future (explicitly NOT S-26 — touch the frozen schema or projection)

These came out of the research but change more than guidance text, so they are
out of scope for S-26 and recorded here so they aren't lost:

- **Reason-before-score** — best practice puts the model's justification *before*
  the score (chain-of-thought → less impulsive verdicts). The frozen
  `RESPONSE_FORMAT` emits `virality_score`/`scores` before `reason`. A future
  schema revision could move `reason` first or add a short `analysis` field
  ahead of scores.
- **Pause-duration cues for clustering** — feeding inter-sentence pause durations
  into the Stage-1 projection measurably improves topic-boundary detection. The
  WhisperX path already yields word timestamps, so pauses are free — but adding
  them changes `formatSentenceMin`, so it's a separate experiment.
- **Rubric calibration** — tune the score-band anchors against a small
  human-labeled gold set (Cohen's κ ≥ 0.6). Largest trust win, largest effort.
- **CTA convention A/B** — for educational reels, test "end on the payoff/insight"
  vs the current "CTA-as-punchline" ending.

See `context/changes/refactor-ai-prompts/research.md` for full evidence.
