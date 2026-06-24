---
date: 2026-06-24T19:18:29+0200
researcher: GarniczAndrzej
git_commit: 363801c2c45ff7c663551d8f67291a1309cf2762
branch: master
repository: REEL_AUTOMATOR
topic: "Prompt-engineering best practice (clustering / curation / reels) + BRAVE cohort personas + Microsoft Copilot-Europe underuser persona"
tags: [research, prompt-engineering, llm-as-judge, short-form, brave-cohorts, personas, copilot, marketing]
status: complete
last_updated: 2026-06-24
last_updated_by: GarniczAndrzej
---

# Research: Prompt-engineering best practice + per-course personas + Copilot-Europe underusers

**Date**: 2026-06-24T19:18:29+0200
**Researcher**: GarniczAndrzej
**Git Commit**: 363801c2c45ff7c663551d8f67291a1309cf2762
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

For change `refactor-ai-prompts` (roadmap **S-26**), research:
1. **Prompt-engineering best practice** for the app's three AI phases — thematic **clustering**, **curation**/scoring, and short-form **reel creation**.
2. **Per-course personas** for BRAVE Education cohorts — `AI_Sales`, `10xDevs`, `AI_Marketers`, `AI Product Heroes`, and **The5** — so each cohort preset produces "the best effect" per reel.
3. A **Microsoft Copilot–Europe underuser** persona — employees in European companies who *have* M365 Copilot but underuse it and want to get better — to seed a future Copilot course preset.

Scope agreed with user: **research dossier only** (citations, no presets — those go in `/10x-plan`); **full persona cards**; Copilot lens = **underusers inside European companies**.

## Summary

- The existing design (`context/foundation/prompt-design.md`) is already well-aligned with 2025–2026 prompt-engineering best practice. The **highest-value new findings** that should feed S-26's plan:
  1. **Fine-grained 0–100 scoring is the single weakest part of the current rubric.** Current research consensus is that LLMs cannot reliably distinguish 73 from 76; small scales (1–5, or several **binary** criteria) calibrate far better. The design already mitigates this with **score *bands*** (85–100 / 60–84 / …), which is effectively bucketing — keep the bands, treat the raw `virality_score` integer as cosmetic, and consider documenting that the bands (not the exact number) are what the model should reason about.
  2. **Reasoning-before-score (chain-of-thought) beats score-first.** The fixed JSON schema currently emits `virality_score`/`scores` *before* `reason`. Best practice puts the justification first so the score is a conclusion, not an impulse. The schema is frozen for S-26 (no field changes), so this is a **note for a future schema revision**, not this change — but worth recording.
  3. **Temperature must be low (0–0.2) for selection/scoring.** Higher temperature degrades JSON-format adherence and score consistency; it only helps in genuinely ambiguous exploration. Verify the OpenRouter call temperature for the curate/scoring phases.
  4. **Verbosity / length bias** is a documented judge failure — longer ≠ better. The reel rubric already says "tighter is better"; an explicit "do not reward length; penalize padding" instinct is supported by the literature.
  5. **Clustering = topic segmentation + map-reduce.** The app's Stage-1 cluster → Stage-2 curate is textbook divide-and-conquer/map-reduce. Two upgrades the literature supports: segment by **topic/semantic boundary** (already done — sentences, not tokens), and feed **pause durations** as boundary cues (the WhisperX word timestamps make this *free* — a candidate future enhancement, out of S-26 scope).
  6. **Hook archetypes are nameable and rankable.** Large-N studies converge on a small set of high-performing hooks — **Hot Take**, **Investigator** (question/mystery), **Proof Drop** (a number/receipt/chart → highest *saves*), **Contrarian**. Naming these in the curate guidance gives the model sharper targets than "stops the scroll."
- **BRAVE catalog** confirmed: BRAVE Education sp. z o.o. (founded 2022, Warsaw; 20 000+ graduates; clients ING, Samsung, Allegro, Orange, PwC). Cohort format: 4–6 weeks, live + project (not exam), 50–80 % completion (≈5× market). The "AI 360" role-based roster = AI_devs, 10xDevs, AI_Managers, AI Product Heroes, AI_Marketers, AI_Sales, AI HR, AI_Enterprise.
- **The5 is *not* an AI-skills cohort** — it is a separate brand by **Tomasz Karwatka**, produced *in collaboration with* BRAVE: a book ("The 5."), "The5 System" (frameworks/courses) and a charity LIVE event. Its audience is **founders/entrepreneurs scaling a company with systems**, not role-based AI learners. This materially changes how a The5 preset should select reels (build-a-company angle, not learn-a-tool angle).
- **Copilot-Europe underuser** is the clearest net-new persona. Headline reality: ~15 M paid seats = **3.3 % of 450 M** M365 commercial seats; only ~**35.8 %** of employees *with* access use Copilot actively; Europe runs ~**58 %** active-seat utilization (vs 64 % NA). The problem is **not access — it is "translation"**: people don't know *what* to use it for, *how* to prompt, *which* tasks are safe, or *where* it actually saves time. Managers experiment far more than ICs (46 % vs 26 %). This is the exact gap a "get good at Copilot" course sells into.

## Detailed Findings

### Area 1 — Prompt-engineering best practice (clustering / curation / reels)

#### 1a. Scoring / LLM-as-judge (the curation + single-shot phases)

The curate and single-shot phases are an **LLM-as-judge** problem (rate each candidate reel on axes, pick the best). The 2025–2026 literature is unusually consistent:

- **Keep the scale small; anchor every level.** "LLMs struggle to calibrate fine-grained distinctions consistently, so simpler scoring frameworks work better… Binary or low-precision scoring produces more reliable results than high-precision numerical scales." A 1–5 scale or *multiple binary criteria* beats 1–100, "because humans and models cannot reliably distinguish 73 from 76." Define each level concretely ("5 = …"), not "5 = excellent." ([LangChain — Calibrate LLM-as-Judge](https://www.langchain.com/resources/llm-as-a-judge); [QASkills LLM-as-a-Judge 2026](https://qaskills.sh/blog/llm-as-a-judge-evaluation-guide-2026); [Kinde — Done Right](https://kinde.com/learn/ai-for-software-engineering/best-practice/llm-as-a-judge-done-right-calibrating-guarding-debiasing-your-evaluators/))
  - **App fit:** `src/ai/prompt.js` rubric uses **0–100 per axis** but expressed as **bands** (85–100 / 60–84 / 40–59 / <40). The bands *are* the mitigation — they collapse 0–100 into 4 buckets, which is good practice. The raw `virality_score` integer should be regarded as display sugar, not a precise signal.
- **Reasoning before the score.** "Asking the judge to write its justification first (chain-of-thought) and the score last produces more accurate, less impulsive verdicts." ([QASkills](https://qaskills.sh/blog/llm-as-a-judge-evaluation-guide-2026); [Kinde](https://kinde.com/learn/ai-for-software-engineering/best-practice/llm-as-a-judge-done-right-calibrating-guarding-debiasing-your-evaluators/); G-Eval / Liu et al. EMNLP 2023 via [Monte Carlo](https://montecarlo.ai/blog-llm-as-judge/))
  - **App fit:** the frozen schema (`RESPONSE_FORMAT` in `src/ai/prompt.js:19`) emits `virality_score` + `scores` *before* `reason`. That is score-first. **Out of S-26 scope** (schema is frozen), but a flagged improvement for a later schema revision: put `reason` first, or add a short `analysis` field ahead of scores.
- **Temperature 0 for stability.** "Run the judge at temperature 0, or your scores wobble run-to-run." Higher temperature **degrades JSON-format adherence** and consistency; it only helps in deliberately ambiguous/exploratory grading. ([alatirok 2026 playbook](https://alatirok.com/llm-as-a-judge-production-playbook/); [OpenReview — Necessity of Setting Temperature in LLM-as-a-Judge](https://openreview.net/pdf/b4752d5b8dfb25d70ebab0a58122e2cd81cb447b.pdf))
  - **App fit:** check the temperature passed to `callOpenRouter` (`src/ai/providers.js`) for curate/scoring; low is correct here. Clustering (creative theme-finding) can tolerate slightly higher.
- **Force structured output; fail loud on parse error.** Use the provider's native JSON mode where available; "a judge that crashes is debuggable, a judge that silently returns 0 corrupts your metrics."
  - **App fit:** already strong — `validateReels` / `validateThemes` (`src/ai/validate.js`) is the loud-fail gate, and CLAUDE.md mandates schema validation before use. OpenRouter `response_format` JSON mode (model-dependent) is a possible hardening, separate from S-26.
- **Known biases to counter in rubric wording:** position bias, **verbosity/length bias** (longer looks more thorough — "do not reward length; penalize padding"), self-enhancement, sycophancy. ([QASkills](https://qaskills.sh/blog/llm-as-a-judge-evaluation-guide-2026); [alatirok](https://alatirok.com/llm-as-a-judge-production-playbook/))
- **Composite over single score.** Aggregate the axes into a pass/fail-style judgement rather than trusting one number — exactly what `virality_score` "consistent with the axes" already does. ([Monte Carlo](https://montecarlo.ai/blog-llm-as-judge/))

#### 1b. Clustering (Stage-1 thematic grouping)

- The Stage-1 → Stage-2 split is **map-reduce / divide-and-conquer** for long inputs that exceed comfortable reasoning length. The known risk is **inter-chunk dependency loss** — a theme that spans the whole recording can be fragmented if you ever chunk the transcript before clustering. ([LLM×MapReduce, ACL 2025](https://aclanthology.org/2025.acl-long.1341v2.pdf))
  - **App fit:** Stage-1 currently sees the *full* segment list in one call (minified `{id,text}` projection, `formatSentenceMin` in `src/ai/prompt.js:14`), so there is no chunk-boundary problem yet. If transcripts ever exceed the cluster model's context, a map-reduce collapse stage (per LLM×MapReduce) is the principled fix — note for scaling, not S-26.
- **Segment by topic/semantics, never fixed token count.** Transcripts are "one of the worst document types for standard RAG"; fixed-size chunks split a decision from its rationale. Topic-based or speaker-turn segmentation wins. ([Charles Chen wiki — RAG for transcripts](https://wiki.charleschen.ai/ai/processed/wiki/llm-core/rag/queries/domain/how-to-build-rag-for-meeting-notes-and-transcripts); [Cohere — Chunking Strategies](https://docs.cohere.com/page/chunking-strategies))
  - **App fit:** already correct — the parser merges SRT cues into punctuation-terminated *sentences* (`parseSRT`), so the cluster model reasons over coherent units.
- **Acoustic boundary cues help.** Hierarchical topic-segmentation work shows feeding **inter-sentence pause durations** measurably improves boundary detection ("`42 (pause=0.62s): …`"). ([Multi-Level Transcript Segmentation, arXiv 2601.02128](https://arxiv.org/html/2601.02128); [TreeSeg, arXiv 2407.12028](https://arxiv.org/html/2407.12028))
  - **App fit:** the WhisperX path already yields word-level timestamps, so pauses are derivable *for free*. Adding a pause hint to the Stage-1 projection is a **promising, low-cost future experiment** — explicitly out of S-26 (which only rewrites guidance text, no schema/projection change).
- **Hierarchical, multi-resolution themes** (TreeSeg) would let the user dial "how many reels" — architectural, future.

#### 1c. Short-form reel creation (curate selection + ordering)

Convergent findings from large clip datasets:

- **Hook in the first 1.5–3 s decides watch-vs-swipe.** TikTok's 2025 algorithm added a 3-second skip threshold. The first 3 s carry ~70 % of the decision. ([virvid](https://virvid.ai/blog/hooks-pattern-interrupts-viral-openers-in-2026); [Kompozy](https://kompozy.io/how-to/write-viral-hooks); [revid — 3M videos](https://www.revid.ai/blog/how-to-make-viral-tiktok-video))
- **Start mid-moment at the peak hook, not at the chronological opening.** "For clips from existing long-form content, the hook is often *not* the opening seconds of the moment… The best clip editors start the clip mid-moment at the peak hook, using the remaining content to provide context and payoff." This directly validates the app's "you may reorder segments for retention; never cut before the key message." ([autoclip — viral clip formula](https://autoclip.dev/blog/viral-clip-formula-what-makes-clips-go-viral))
- **Content density is *why* AI clipping beats humans.** "AI models select the 30-second window of maximum density from a 3-minute segment, while human editors often include too much setup and aftermath." Reinforces "tighter is better; no dead air." ([autoclip](https://autoclip.dev/blog/viral-clip-formula-what-makes-clips-go-viral))
- **Length: 30–60 s is the safe default; 60–90 s wins on watch-time when there's substance.** Sub-30 s works for punchlines/quotes. ([autoclip signals](https://autoclip.dev/blog/clip-virality-signals-data); [thecontentlabs — 4000 videos](https://thecontentlabs.app/blog/what-goes-viral-in-2026-data-study)). The design's per-cohort 20–90 s ranges sit correctly inside this.
- **Nameable hook archetypes (use these as rubric vocabulary):**
  - **Hot Take** — bold opinionated first sentence (~140K avg views).
  - **Investigator** — a question / unfolding mystery (~140K).
  - **Proof Drop** — a screenshot/chart/specific number/receipt → **highest saves by a wide margin** (best for *educational/reference* reels — i.e., BRAVE content). ([thecontentlabs](https://thecontentlabs.app/blog/what-goes-viral-in-2026-data-study))
  - **Contrarian** — invert the consensus to create tension the viewer must resolve (the video must then actually defend it; bait-and-switch tanks re-watch). ([Kompozy](https://kompozy.io/how-to/write-viral-hooks))
  - Weak openers to *avoid*: "So basically…", "Let me tell you about…", "Hey guys" — Story hooks average ~7K vs ~140K.
- **One emotion, picked deliberately** (Fear / Empathy / Outrage move the algorithm hardest), plus **shareability tied to identity** — "viewers share clips that reflect their values, humor, or group membership." This is a concrete definition for the rubric's fuzzy `trend` axis: *trend = identity-aligned shareability*, not generic "viral feel." ([autoclip](https://autoclip.dev/blog/viral-clip-formula-what-makes-clips-go-viral); [thecontentlabs](https://thecontentlabs.app/blog/what-goes-viral-in-2026-data-study))
- **End on the payoff, not the ask.** "Let the comment section be the CTA." Mild tension with the app's CTA/punchline-as-ending convention — for educational reels a strong *insight* payoff may convert better than an explicit "join the course." Worth A/B framing per cohort. ([thecontentlabs](https://thecontentlabs.app/blog/what-goes-viral-in-2026-data-study))

**Net for S-26:** the per-phase guidance rewrites in `prompt-design.md` are sound. The cheap, in-scope wins are vocabulary upgrades to the **curate/scoring guidance**: name the hook archetypes (esp. **Proof Drop** for BRAVE's number-heavy educational material), define `trend` as *identity-aligned shareability*, and add an explicit anti-padding line. Schema-level ideas (reason-before-score, pause cues) are **logged as future**, not this change.

### Area 2 — BRAVE cohort personas

**Catalog & company facts** ([brave.courses](https://www.brave.courses/); [brave.inc/about](https://brave.inc/about); [LinkedIn](https://pl.linkedin.com/company/brave-courses)): founded 2022, Warsaw HQ; 20 000+ graduates, 1 000+ teams, 200+ companies (ING, Allegro, Orange, PwC, Samsung). Cohort model: 4–6 weeks, **live sessions + a completion project, not an exam**, 50–80 % completion vs 5–15 % market. Tribe/identity positioning ("nie 'skończyłem kurs' — 'jestem absolwentem AI_devs'"). "AI 360" = the role-based bundle.

#### Persona card — 10xDevs (Przemek Smyrdek + Marcin Czarkowski / Przeprogramowani)
- **Who:** experienced software engineers, **not beginners** ("pierwsze kroki masz już za sobą"). Work on real production systems, greenfield *and* legacy/brownfield. 5-week program. ([10xdevs.pl](https://www.10xdevs.pl/); [przeprogramowani.pl/kurs](https://przeprogramowani.pl/kurs))
- **What it teaches:** AI-native software engineering across the *whole* SDLC — research, planning, implementation, CI/CD, test generation, legacy refactor, production maintenance. Tools: Cursor, Claude Code, Codex, GitHub Copilot, Aider. Explicitly **anti-"naive vibe coding."** Sister program to AI_devs (AI_devs = build your own agent; 10xDevs = work *with* the best agentic systems).
- **Pains:** AI hype fatigue; fear of being a "10x dev" in name only; messy legacy code; hallucination risk; "vibe coding" that doesn't survive production; falling behind peers.
- **Desires:** real velocity (5× faster legacy comprehension, tests in minutes), universal patterns that outlive any single model, professional credibility.
- **Objections:** "I already use Copilot" / "is this just prompts?" — answered by the full-cycle, production-grade, anti-toy positioning.
- **Converting hook (reel angle):** a **before/after productivity jolt** or a concrete "this actually ships to prod" demo. Proof-Drop a number (e.g., "5× faster on legacy"). Technical credibility over inspiration.

#### Persona card — AI_Sales (Szymon Negacz / WiseGroup–SellWise)
- **Who:** B2B salespeople, sales managers and directors in **consultative** sales (services, IT, manufacturing, modern tech) where the cycle lasts at least several days and depends on needs-analysis. 6-week program, 7–10 h/week. ([aisales.pl](https://www.aisales.pl/); [Negacz YouTube launch](https://www.youtube.com/watch?v=WLfWLN9q8Mg))
- **What it teaches:** **process first** — week 1 diagnoses & designs the sales process, *then* bolts AI on: week 2 prospecting (research + personalized outreach, tools Clay / Snov.io / Cellwise), week 3 qualification & needs discovery. Explicitly **not** "a list of random prompts."
- **Pains:** real resistance to AI from *both* clients and salespeople; fear AI makes outreach generic/spammy; no repeatable process; drowning in admin.
- **Desires:** close more, more leads, higher conversion; a *repeatable, AI-augmented* process; keep the human/advisory edge.
- **Objections:** "AI will make my outreach soulless," "this is just hype" — countered by process-first, practitioner-proven (WiseGroup experts) framing.
- **Converting hook (reel angle):** a concrete sales problem or a number (more leads / higher conversion). Show a *repeatable* AI move in the funnel (prospecting/qualification), not a gimmick. Punchline = "usprawnij sprzedaż z AI."

#### Persona card — AI_Marketers (Artur Jabłoński)
- **Who:** marketers (in-house + agency) running the full campaign lifecycle. ([brave.courses](https://www.brave.courses/))
- **What it teaches:** working with AI tools across the whole process of creating and running **effective campaigns** — not tool tourism, but campaign outcomes.
- **Pains:** tool overwhelm ("which of 100 AI tools?"), content-volume pressure, proving ROI/effectiveness, time scarcity.
- **Desires:** ship campaigns and content faster *and* better; concrete before/after wins; time saved.
- **Objections:** "AI content is generic," "another tool I won't adopt" — answered by real campaign examples and measurable lift.
- **Converting hook (reel angle):** a surprising campaign *result* or a concrete tool trick with a visible before/after. Proof-Drop the metric.

#### Persona card — AI Product Heroes (Wojtek Strzałkowski, ex-Allegro/Booking + Piotrek Kacała, ex-CD Projekt/GOG)
- **Who:** product managers and product builders who want to work "like top product firms." 5-week program. ([aiproductheroes.pl](https://aiproductheroes.pl/))
- **What it teaches:** the **complete AI product workflow — discovery → prototype → data analysis**; goal is to define a business problem and ship a *working prototype* in 5 weeks ("bez czekania na zasoby i decyzje"). Tools incl. PostHog, Claude/build tooling.
- **Pains:** blocked by engineering bandwidth/resources; ideas die in backlog; can't validate quickly; "PM who can't build."
- **Desires:** product sense + autonomy to validate and build solo; prototype to show clients/board; operate like world-class product orgs.
- **Objections:** "I'm not technical enough to build" — countered by AI-assisted prototyping (no-deep-code).
- **Converting hook (reel angle):** zero-to-working-prototype speed, or a real product-discovery insight. The "build it yourself without waiting" emotional beat (autonomy/empowerment).

#### Persona card — The5 (Tomasz Karwatka) — **distinct brand, not an AI-skills cohort**
- **What it is:** a separate venture by **Tomasz Karwatka** (Divante/Catch founder), produced **in collaboration with BRAVE** — a book "**The 5.**", the "**The5 System**" (proven frameworks + courses + interviews, meant to be shared with co-founders/teams/employees), and **The5 LIVE**, a charity premiere event (YouTube, proceeds to forest conservation "Połączona Puszcza Polska"). ([the5.live](https://the5.live/); [ksiazka.the5.tech](https://ksiazka.the5.tech/); referenced in [brave.inc/about](https://brave.inc/about) as "The Five")
- **Who (audience):** **founders / entrepreneurs building scalable companies** — service firms or tech startups. Sweet spot: 1–4 years in, "overwhelmed by chaos," fighting for stabilization, planning the next company, or eyeing international expansion. Wants **systems**, not motivation.
- **Who it is *NOT* for (explicit on the site):** people seeking motivational talk/coaching; "millionaire in 6 months" seekers; local businesses with no scaling plans; theory-lovers; anyone unwilling to do hard work on systems.
- **Pains:** operational chaos; founder-dependency; no repeatable systems; how to scale / expand abroad without repeating mistakes.
- **Desires:** turn a chaotic firm into a **system-run, scalable** company; proven frameworks from practitioners; build something that runs without the founder in every loop; belong to a serious builders' movement.
- **Objections:** "another business-guru book" — countered by practitioner credibility + charity/mission framing + "no theory."
- **Converting hook (reel angle):** a sharp founder-pain truth ("przytłoczony chaosem firmy?") or a concrete systems/scaling framework. Contrarian or Hot-Take hooks fit Karwatka's voice. **Crucially different from the AI cohorts:** the reel sells *building a company with systems*, and the CTA points at the book / The5 System / the movement — not at learning an AI tool.

> **Planning flag for S-26:** the user listed The5 alongside the AI cohorts, but its audience and CTA are structurally different. A The5 preset should *not* reuse the "learn-an-AI-skill" spine of the other cohorts; it needs its own founder/systems framing. Decide in `/10x-plan` whether The5 is in-scope for the BRAVE `BUILTIN_PRESETS` set or a separate preset family.

### Area 3 — Microsoft Copilot–Europe underuser persona

**Market reality (the gap the course sells into):**
- **Access ≫ usage.** ~15 M paid Copilot seats = **3.3 % of 450 M** M365 commercial seats (FY2026 Q2); 95 %+ of the potential base isn't actively using it. ([nojitter — 4 obstacles](https://www.nojitter.com/ai-automation/4-obstacles-impede-paid-microsoft-365-adoption); [TechMediaEire — Copilot Gap](https://www.techmediaeire.com/insights/the-copilot-gap-why-most-businesses-have-ai-at-their-fingertips-but-arent-using-it))
- **Even where rolled out, usage is shallow and decays.** Gartner (132 IT leaders, 2024): **60 %** started pilots, only **6 %** moved to large-scale deployment; **72 %** say employees *struggle to fit Copilot into daily routines*; **57 %** see engagement decline quickly after launch; only **3 %** report significant value. ([QueryNow — Past the stall](https://www.querynow.com/resources/whitepapers/past-the-stall-m365-copilot-rollouts); [techpartner.news — Gartner](https://www.techpartner.news/news/gartner-microsoft-copilot-hype-offset-by-roi-and-readiness-realities-618118))
- **Adoption curve collapses.** Avg enterprise adoption ~**34 % at 90 days → 8 %** where employees have alternative AI tools; only **35.8 %** of employees *with* access use Copilot actively (the other ~64 % is paid-for and idle). ([Acuity — 34%→8% collapse](https://acuityai.co/blog/microsoft-copilot-adoption-collapse-what-the-data-says); [Lighthouse adoption](https://www.lighthouseglobal.com/blog/microsoft-365-copilot-adoption))
- **Europe specifics:** ~**58 %** active-seat utilization (vs 64 % North America), with a stronger privacy/compliance posture. ([Worklytics benchmarks 2025](https://www.worklytics.co/resources/benchmark-copilot-gemini-adoption-2025-enterprise-averages-dashboard)). EU/UK regulatory scrutiny is real — the **Dutch government** commissioned a data-protection review flagging transparency/retention/accuracy gaps; **40 %** of orgs delayed rollout 3+ months over data **oversharing**. ([WebSearch summary, EU/UK governance]; [QueryNow](https://www.querynow.com/resources/whitepapers/past-the-stall-m365-copilot-rollouts))
- **The root cause is "translation," not access.** SMEs ask: "What should we actually use this for? How do we prompt it properly? Which tasks are safe to automate? Where does AI actually save time?" Without answers, Copilot "ends up sitting inside the software stack unused." Barriers reduce to **lack of confidence, unclear use cases, unanswered trust questions.** ([TechMediaEire](https://www.techmediaeire.com/insights/the-copilot-gap-why-most-businesses-have-ai-at-their-fingertips-but-arent-using-it); [Lighthouse](https://www.lighthouseglobal.com/blog/microsoft-365-copilot-adoption))
- **Usage clusters narrow:** Teams meeting recap, Word rewrite/summarize, Outlook drafting. **Excel and "new surfaces" (Loop/Whiteboard/OneNote) lag badly** — i.e., people use the shallow features and never reach the high-leverage ones. ([nojitter](https://www.nojitter.com/ai-automation/4-obstacles-impede-paid-microsoft-365-adoption))
- **Managers ≫ ICs in curiosity:** **46 %** of managers experiment with AI vs **26 %** of employees — leadership is excited, the people doing daily work were never shown how. ([TechMediaEire](https://www.techmediaeire.com/insights/the-copilot-gap-why-most-businesses-have-ai-at-their-fingertips-but-arent-using-it))
- **Training works:** orgs that train first (prompt maturity, use-case clarity, trust answers) see **2–3× higher** adoption than self-guided onboarding. The default Microsoft "adoption" metric is a lax **1 use / 28 days** — real value needs ~daily use. ([Lighthouse](https://www.lighthouseglobal.com/blog/microsoft-365-copilot-adoption); [techpartner.news](https://www.techpartner.news/news/gartner-microsoft-copilot-hype-offset-by-roi-and-readiness-realities-618118))

**Persona card — "Copilot Underuser" (European knowledge worker)**
- **Who:** office/knowledge worker at a mid-to-large European company that **bought M365 Copilot** for them. Uses it shallowly — meeting summaries in Teams, the odd email draft in Outlook — and assumes "that's about it." Likely 30s–50s, comfortable with Office, *not* an AI enthusiast.
- **Pains:** doesn't know **what** to use it for beyond summaries; doesn't know **how to prompt**; unsure **which tasks are safe** (data/GDPR worry); tried it once, got a mediocre answer, quietly stopped; vaguely afraid of **being left behind** as colleagues/younger hires pull ahead.
- **Desires:** feel **competent and current**; get real time back on repetitive work (reports, decks, spreadsheets, inbox); concrete, role-relevant recipes ("for *my* job, do *these* things"); confidence that they're using it *correctly and safely*.
- **Objections / frictions:** "I don't have time to learn another tool"; "it gave me a wrong/bland answer"; "is it safe to point it at company data?"; "the UI keeps changing." Low confidence is the dominant blocker, not capability.
- **Emotional hook that converts (reel angle):** *"You're paying for Copilot and using 5 % of it."* / *"Stop using Copilot just for meeting notes."* — a **Contrarian or Proof-Drop** hook that names the underuse, plus a single concrete "here's the one prompt that saves you an hour" payoff. Show a *before/after* on a real Office task (Excel/PowerPoint, since those are the neglected high-leverage surfaces). The emotion is **relief + not-being-left-behind**, not technical ambition.
- **Manager variant:** more curious already (46 % vs 26 %); hook on **team productivity + how to actually drive adoption** rather than personal prompting.

> **Planning flag:** a Copilot course is a different audience from BRAVE's "ambitious builders" tribe — it's the **anxious majority** who already have the tool. The preset's reel selection should favor **relatable underuse pain + one concrete safe win**, lighter on "become elite," heavier on "you already have this, here's how to not waste it."

## Code References

- `src/ai/prompt.js:19` — `RESPONSE_FORMAT` (frozen scored-reel JSON; `virality_score`/`scores` emitted *before* `reason` — relevant to the reason-before-score finding).
- `src/ai/prompt.js:43` — `DEFAULT_SCORING_GUIDANCE` (single-shot, Polish; 0–100 four-axis rubric).
- `src/ai/prompt.js:54` — `CLUSTER_RESPONSE_FORMAT` (themes schema) and `:68` `DEFAULT_CLUSTER_GUIDANCE`.
- `src/ai/prompt.js:81` — `DEFAULT_CURATE_GUIDANCE` (Stage-2, English instructions, Polish output).
- `src/ai/prompt.js:14` — `formatSentenceMin` (Stage-1 minified `{id,text}` projection — where a pause-duration cue could later be added).
- `src/ai/prompt.js:174` / `:200` / `:223` — `buildPrompt` / `buildClusterPrompt` / `buildCuratePrompt` (composition order: userPrompt → static block → guidance).
- `src/ai/prompt-presets.js:14` — `BUILTIN_PRESETS` (the 4 generic starters S-26 replaces with cohort presets).
- `src/ai/validate.js` — `validateReels` / `validateThemes` (loud-fail schema gate; satisfies the "fail loud, never silently default" judge guidance).
- `src/ai/providers.js` — `callOpenRouter` (verify scoring/curate temperature is low).
- `context/foundation/prompt-design.md` — the S-26 design artifact this research backs (3 guidance rewrites + 9 cohort presets + citations).

## Architecture Insights

- The app's pipeline is, in research terms, a **map-reduce LLM-as-judge over topic-segmented transcript units**: parse → sentence segmentation (topic-coherent units) → Stage-1 cluster (map) → Stage-2 curate+score (reduce/judge) → validated JSON → exporters. Each stage matches an established best-practice pattern, which is why the existing design holds up well.
- The **machine-owned static block + editable guidance/userPrompt** split (`buildStaticBlock`) is the right safety architecture: prompt edits can never break export because the JSON example + `validateReels` are always injected. This means S-26 can iterate aggressively on persona/guidance *text* with zero export risk.
- The **biggest unrealized lever** is calibration: none of the rubric anchors are currently tuned against a human gold set (Cohen's κ). That's a larger effort than S-26, but it's the thing that would most improve score trustworthiness. Logged as future.

## Historical Context (from prior changes)

- `context/foundation/lessons.md` — **[[llm-prompt-instructions-english]]** rule (English instruction blocks for ~30 % token leanness, Polish output via explicit directive) is already applied in `prompt-design.md` and consistent with "keep guidance tight" best practice.
- `context/foundation/prompt-design.md` (S-26 design) — already cites a comparable best-practice set (structure>length, role-first, rubric anchors, low temperature, minimal few-shot). **This research validates and extends it** with: small-scale/binary scoring, reason-before-score, named hook archetypes (Proof Drop / Hot Take / Investigator / Contrarian), `trend` = identity-shareability, map-reduce framing, and pause-cue clustering.
- Memory `[[brave-education-cohorts]]` — prior note that reels market BRAVE cohorts; this research adds full persona depth + the **The5-is-a-distinct-brand** correction and the **Copilot underuser** persona.

## Related Research

- `context/foundation/prompt-design.md` — primary related artifact (same change, design layer).
- No prior `context/changes/**/research.md` or `context/archive/**/research.md` on prompt-engineering personas found; this is the first.

## Open Questions

1. **The5 scope** — in-scope for the BRAVE `BUILTIN_PRESETS` set, or a separate founder/systems preset family with its own spine? (It is not an AI-skills cohort.)
2. **Copilot course preset** — is the planned Copilot course a BRAVE/The5 product, and should its preset ship in the same S-26 set or wait until the course exists?
3. **Reason-before-score** — worth a future schema revision (put `reason`/an `analysis` field before scores), or keep the frozen schema and accept score-first? (Out of S-26.)
4. **Temperature** — confirm the curate/scoring OpenRouter call runs at low temperature (0–0.2); raise only for Stage-1 creative clustering.
5. **Pause-cue clustering** — feed WhisperX pause durations into the Stage-1 projection as a future experiment? (Free data, schema-projection change → not S-26.)
6. **Calibration** — is there appetite to build a small human-labeled gold set to tune the rubric anchors (Cohen's κ ≥ 0.6)? Largest trust win, larger effort.
7. **CTA convention** — for educational BRAVE reels, A/B "end on payoff/insight" vs the current "CTA-as-punchline" ending?
