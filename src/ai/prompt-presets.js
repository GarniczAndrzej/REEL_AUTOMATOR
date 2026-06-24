// Preset library for userPrompt (FR-016 / S-03). Backed by localStorage key
// `edl_prompt_presets`. Seeded with built-in Polish starters on first run;
// fully editable/deletable by the user.

const LS_KEY = 'edl_prompt_presets';

// S-26: version flag gating the one-time builtin migration (see
// `migrateBuiltinPresets`). Bumping the version re-runs the merge once.
const MIGRATION_FLAG = 'edl_presets_builtin_migration';
const MIGRATION_VERSION = 's26-v1';

/** @typedef {import('../state.js').PromptPreset} PromptPreset */

/**
 * Built-in starter presets, one per BRAVE cohort plus The5 + Copilot (S-26).
 * INSTRUCTIONS are English (labeled AUDIENCE → LOOK FOR → HOOK → LENGTH → CTA),
 * per [[llm-prompt-instructions-english]] — English tokenizes ~30% leaner and a
 * preset rides on every call; each ends with an explicit "write reel_name and
 * reason in Polish" anchor so model OUTPUT stays Polish even if the per-phase
 * guidance is cleared. Names stay as cohort identities (Polish UI labels). Each
 * preset carries only cohort framing — the montage/scoring rubric lives in the
 * per-phase guidance (`DEFAULT_*_GUIDANCE`), so presets stay short and don't
 * duplicate it. The5 + Copilot are drafted from the research persona cards.
 * @type {PromptPreset[]}
 */
export const BUILTIN_PRESETS = [
  {
    id: 'builtin-brave-ai-devs',
    name: 'AI_devs (programiści)',
    userPrompt: `Cut Reels promoting the AI_devs cohort — an AI course for software developers.
AUDIENCE: developers who want to actually BUILD with LLMs (agents, RAG, APIs), not just read about AI.
LOOK FOR (strongest first): a working demo, solution architecture, real numbers/results, "it actually works" moments, hard practical know-how that builds credibility.
HOOK: a specific technical problem or a surprising result in the first seconds.
LENGTH: 30–75 s. Skip purely organizational segments.
CTA: if a prompt to learn or join appears, treat it as the Reel's punchline.
OUTPUT: write reel_name and reason in Polish.`,
  },
  {
    id: 'builtin-brave-10xdevs',
    name: '10xDevs (GenAI w kodzie)',
    userPrompt: `Cut Reels promoting the 10xDevs cohort — generative AI across the whole software-delivery lifecycle.
AUDIENCE: software engineers who want to work 10x faster with AI (agentic coding, assistants, automation).
LOOK FOR (strongest first): before/after speed-ups, concrete tricks & workflows, "wow, you can do that" demos, real productivity gains.
HOOK: a time-saving promise or a surprising productivity demo.
LENGTH: 30–75 s.
CTA: make the payoff point at leveling up how they work with AI.
OUTPUT: write reel_name and reason in Polish.`,
  },
  {
    id: 'builtin-brave-ai-managers',
    name: 'AI_Managers (liderzy)',
    userPrompt: `Cut Reels promoting the AI_Managers cohort — adopting AI in a manager's work, across teams and the organization.
AUDIENCE: managers and leaders who decide AI strategy and rollout in the company.
LOOK FOR (strongest first): ROI and concrete numbers, an adoption framework/canvas, strategic decisions, risks, "how to structure this in the org".
HOOK: a business problem or a strong claim about the future of work with AI.
LENGTH: 30–90 s.
CTA: make the payoff point at putting AI adoption in order.
OUTPUT: write reel_name and reason in Polish.`,
  },
  {
    id: 'builtin-brave-product-heroes',
    name: 'AI Product Heroes (product)',
    userPrompt: `Cut Reels promoting the AI Product Heroes cohort — building products with AI.
AUDIENCE: product managers and product builders who want to build with AI from idea to launch.
LOOK FOR (strongest first): concrete examples of things actually shipped, idea-to-product moments — discovery, MVP, product decisions, validation.
HOOK: a real product problem or a fast path from zero to a working product.
LENGTH: 30–90 s.
CTA: make the payoff point at becoming a product builder.
OUTPUT: write reel_name and reason in Polish.`,
  },
  {
    id: 'builtin-brave-ai-marketers',
    name: 'AI_Marketers (marketing)',
    userPrompt: `Cut Reels promoting the AI_Marketers cohort — AI tools for effective marketing campaigns.
AUDIENCE: marketers who want to create and run campaigns faster and better with AI.
LOOK FOR (strongest first): before/after results, concrete tools and workflows, time saved, real campaign and content examples.
HOOK: a surprising campaign result or a concrete trick with an AI tool.
LENGTH: 25–75 s.
CTA: make the payoff point at boosting marketing effectiveness with AI.
OUTPUT: write reel_name and reason in Polish.`,
  },
  {
    id: 'builtin-brave-ai-sales',
    name: 'AI_Sales (sprzedaż)',
    userPrompt: `Cut Reels promoting the AI_Sales cohort — AI in the sales process.
AUDIENCE: salespeople and sales leaders who want to close more deals with AI.
LOOK FOR (strongest first): real numbers and scripts, concrete moments from the sales process — prospecting, qualification, follow-up, conversion.
HOOK: a specific sales problem or a result (more leads / higher conversion).
LENGTH: 25–75 s.
CTA: make the payoff point at improving sales with AI.
OUTPUT: write reel_name and reason in Polish.`,
  },
  {
    id: 'builtin-brave-ai-hr',
    name: 'AI HR (HR)',
    userPrompt: `Cut Reels promoting the AI HR cohort — AI in the HR domain.
AUDIENCE: HR specialists and leaders who want to use AI in recruiting, onboarding, and people development.
LOOK FOR (strongest first): concrete AI uses in HR — faster recruiting, process automation, better people decisions, real examples.
HOOK: an HR pain point or a concrete process-improvement result.
LENGTH: 30–80 s.
CTA: make the payoff point at bringing AI into HR.
OUTPUT: write reel_name and reason in Polish.`,
  },
  {
    id: 'builtin-brave-ai-enterprise',
    name: 'AI_Enterprise (korporacje)',
    userPrompt: `Cut Reels promoting AI_Enterprise — AI transformation programs for large companies.
AUDIENCE: decision-makers in large organizations planning AI transformation at scale.
LOOK FOR (strongest first): measurable outcomes, org-wide rollout, competency diagnosis, governance, risks — the scale-and-transformation arguments.
HOOK: a strong claim about transformation or a concrete at-scale result.
LENGTH: 40–90 s.
CTA: make the payoff point at starting an AI transformation in the organization.
OUTPUT: write reel_name and reason in Polish.`,
  },
  {
    id: 'builtin-brave-ai-360',
    name: 'AI 360 / ogólny (BRAVE)',
    userPrompt: `Cut viral educational AI Reels promoting BRAVE training (the AI 360 offer — all roles: marketing, product, sales, HR, devs).
AUDIENCE: ambitious, creative people who want to genuinely learn to use AI at work.
LOOK FOR (strongest first): the strongest self-contained "aha" moments about AI — concrete insights, surprising facts, practical tips that work regardless of the recording's context.
HOOK: a strong, scroll-stopping AI insight in the first 3 seconds.
LENGTH: 20–60 s. The denser the segment, the better.
CTA: make the payoff point at practical AI learning with BRAVE.
OUTPUT: write reel_name and reason in Polish.`,
  },
  {
    id: 'builtin-the5',
    name: 'The5 (founderzy / systemy)',
    userPrompt: `Cut Reels promoting The5 — a system for building a scalable company (Tomasz Karwatka, in collaboration with BRAVE).
AUDIENCE: founders and entrepreneurs building scalable companies (services or tech), 1–4 years in, overwhelmed by chaos, who want systems, not motivation.
LOOK FOR (strongest first): sharp truths about founder chaos, concrete scaling frameworks and systems, "stop being your own company's bottleneck" moments, building a company that runs without the owner.
HOOK: a strong claim or a painful truth about running a company in the first 3 seconds (Hot Take / Contrarian fit Karwatka's voice).
LENGTH: 30–90 s.
CTA: make the payoff point at the book "The 5." / the The5 System / joining the movement — NOT at learning an AI tool.
OUTPUT: write reel_name and reason in Polish.`,
  },
  {
    id: 'builtin-copilot',
    name: 'Copilot (niedoużywany)',
    userPrompt: `Cut Reels for employees who HAVE Microsoft 365 Copilot but use it shallowly (only meeting notes) and don't know what's next.
AUDIENCE: office workers at European companies whose employer bought them Copilot; fluent in Office but not AI enthusiasts; afraid of falling behind.
LOOK FOR (strongest first): "you're using 5% of Copilot" moments, concrete safe wins on real tasks (Excel, PowerPoint, Outlook), simple "for my role, do this" recipes, answers to data-security worries.
HOOK: a contrarian or Proof-Drop opening that names the underuse ("You pay for Copilot and use 5%") in the first 3 seconds.
LENGTH: 25–70 s.
CTA: make the payoff point at "learn to use Copilot well" or one concrete prompt that saves an hour. Emotion: relief and not falling behind, not technical ambition.
OUTPUT: write reel_name and reason in Polish.`,
  },
];

/**
 * Read the preset library from localStorage. Always returns an array (never throws).
 * @returns {PromptPreset[]}
 */
export function loadPresets() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Overwrite the entire preset library in localStorage.
 * @param {PromptPreset[]} list
 * @returns {boolean} true if the write succeeded, false if it threw (e.g. quota)
 */
export function savePresets(list) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed the built-in presets if the store is absent (first run). Does nothing
 * if the user already has a library (even an empty one written by a prior session).
 */
export function seedPresetsIfEmpty() {
  try {
    if (localStorage.getItem(LS_KEY) === null) {
      savePresets(BUILTIN_PRESETS);
      // A fresh install already holds the current builtins, so stamp the
      // migration flag (S-26) — `migrateBuiltinPresets()` is then a no-op.
      localStorage.setItem(MIGRATION_FLAG, MIGRATION_VERSION);
    }
  } catch {}
}

/**
 * Snapshot of the 4 generic starters retired in S-26 (Phase 2). Frozen here
 * verbatim from the pre-S-26 `BUILTIN_PRESETS` so `migrateBuiltinPresets()` can
 * detect a *pristine* old starter (id + name + userPrompt all unchanged) and
 * remove only those — a renamed or edited starter is user work and is kept.
 * @type {PromptPreset[]}
 */
const RETIRED_BUILTINS = [
  {
    id: 'builtin-sprzedazowy',
    name: 'Sprzedażowy (webinar)',
    userPrompt: `Stwórz viralowe reelsy sprzedażowe z tego webinaru.

Zasady:
- Każdy Reel: HOOK (mocny wstęp) → BODY (rozwinięcie) → CTA (wezwanie do działania)
- Długość: 30–90 sekund
- Możesz zmieniać kolejność segmentów zachowując logiczny sens
- Szukaj emocjonalnych momentów, konkretnych liczb, historii i CTA
- Stwórz tyle Reelsów ile możesz z wartościowego materiału`,
  },
  {
    id: 'builtin-edukacyjny',
    name: 'Edukacyjny',
    userPrompt: `Wytnij z nagrania najcenniejsze fragmenty edukacyjne jako krótkie reelsy.

Zasady:
- Każdy Reel: jeden konkretny insight lub lekcja do zapamiętania
- Długość: 20–60 sekund
- Priorytetyzuj momenty „aha", definicje, porady krok po kroku
- Każdy Reel musi mieć jasny tytuł tematyczny
- Unikaj fragmentów, gdzie prowadzący pyta o pytania lub robi przerwy`,
  },
  {
    id: 'builtin-storytelling',
    name: 'Storytelling / historia',
    userPrompt: `Znajdź w nagraniu najmocniejsze fragmenty narracyjne i ułóż z nich emocjonalne reelsy.

Zasady:
- Każdy Reel: problem → zwrot akcji → rozwiązanie lub refleksja
- Długość: 45–90 sekund
- Szukaj anegdot, metafor, osobistych doświadczeń mówcy
- Hook musi wciągnąć widza w pierwszych 3 sekundach
- Zachowaj naturalny rytm narracji — nie urywaj w połowie zdania`,
  },
  {
    id: 'builtin-highlights',
    name: 'Najlepsze chwile (highlights)',
    userPrompt: `Wybierz absolutne perełki z nagrania — momenty, które warto obejrzeć niezależnie od kontekstu.

Zasady:
- Każdy Reel to jeden wyrazisty, samodzielny fragment
- Długość: 15–45 sekund
- Szukaj śmiesznych, zaskakujących lub bardzo konkretnych momentów
- Każdy Reel powinien działać bez znajomości reszty nagrania
- Im krótszy i bardziej treściwy — tym lepiej`,
  },
];

/**
 * One-time, flag-guarded migration of existing users to the S-26 builtins.
 * Runs at most once per `MIGRATION_VERSION`: removes pristine retired starters,
 * merges in any missing new `builtin-*` presets, and preserves every other
 * preset (user-created, or a retired starter the user renamed/edited). Never
 * throws on boot (mirrors `seedPresetsIfEmpty`); never re-adds a builtin the
 * user later deleted, because the flag stops it from running again.
 */
export function migrateBuiltinPresets() {
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === MIGRATION_VERSION) return;

    const current = loadPresets();

    // Drop only *pristine* retired starters (id + name + userPrompt all match
    // the frozen original). A renamed/edited one differs and is kept.
    const kept = current.filter((p) => {
      const retired = RETIRED_BUILTINS.find((r) => r.id === p.id);
      if (!retired) return true; // user-created or already a new builtin
      const pristine =
        p.name === retired.name && p.userPrompt === retired.userPrompt;
      return !pristine;
    });

    // Append any new builtin not already present (by id).
    const presentIds = new Set(kept.map((p) => p.id));
    const merged = [
      ...kept,
      ...BUILTIN_PRESETS.filter((b) => !presentIds.has(b.id)),
    ];

    if (savePresets(merged)) {
      localStorage.setItem(MIGRATION_FLAG, MIGRATION_VERSION);
    }
  } catch {}
}

/**
 * Return a preset by id, or undefined if not found.
 * @param {string} id
 * @returns {PromptPreset | undefined}
 */
export function getPreset(id) {
  return loadPresets().find((p) => p.id === id);
}

/**
 * Append a new preset (assigns a fresh id via crypto.randomUUID).
 * @param {{ name: string, userPrompt: string }} preset
 * @returns {PromptPreset | null} the persisted preset, or null if the write failed
 */
export function addPreset({ name, userPrompt }) {
  const preset = { id: crypto.randomUUID(), name, userPrompt };
  return savePresets([...loadPresets(), preset]) ? preset : null;
}

/**
 * Overwrite an existing preset's fields by id. Unknown ids are a no-op.
 * @param {string} id
 * @param {Partial<Pick<PromptPreset, 'name' | 'userPrompt'>>} updates
 * @returns {boolean} true if the write succeeded
 */
export function updatePreset(id, updates) {
  const list = loadPresets().map((p) =>
    p.id === id ? { ...p, ...updates } : p,
  );
  return savePresets(list);
}

/**
 * Delete a preset by id. Unknown ids are a no-op.
 * @param {string} id
 * @returns {boolean} true if the write succeeded
 */
export function removePreset(id) {
  return savePresets(loadPresets().filter((p) => p.id !== id));
}
