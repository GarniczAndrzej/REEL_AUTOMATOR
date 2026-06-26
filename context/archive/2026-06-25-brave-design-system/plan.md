# BRAVE Design System Re-theme — Implementation Plan

## Overview

Re-skin the Reels EDL Automator app to the **BRAVE** visual language defined in
`DesignNotes/design-system.md`: a near-monochrome identity on a warm near-black
canvas (`#141313`), soft off-white type (`#DDDDDD`), **DM Sans** as the single UI
typeface, **white/light** (not purple) interaction states, BRAVE functional-color
hexes reserved for app-state feedback, and the **BRAVE logo** (inline SVG in a white
chip) replacing the current `▶ Reels EDL Automator` text logo.

The strategy is a **token remap, not a rename**: the existing `:root` token *names*
in `src/styles.css` (`--bg`, `--surface`, `--accent`, `--text`, `--mono`, …) are
kept and only their *values* change. Because 381 `var(--…)` call sites already
reference these tokens, the palette/type swap cascades through the whole app from a
single `:root` edit. The remaining work is sweeping the **un-tokenized color/font
leaks** (raw hex/rgba in CSS, canvas draws, inline styles, the error banner) and
swapping the logo.

## Current State Analysis

- **`src/styles.css`** (1663 lines) defines the active design system in `:root`
  (`src/styles.css:11-53`): purple accent (`--accent: #7c6dfa`, `--accent2: #a695ff`),
  bluish near-black (`--bg: #0d0d10`), functional `--green/--amber/--red`, text
  `--text/--text2/--text3`, and **two fonts** — `--display: 'Syne'` and
  `--mono: 'DM Mono'`. Fonts load via an `@import` at `src/styles.css:1`.
- **`--mono` is the body workhorse**, not a code font: it is referenced in 20 rules
  (`src/styles.css:59,114,126,…`), including body, inputs, and buttons — because the
  app currently uses DM Mono everywhere. A handful of those usages are genuine
  code/timecode/EDL/XML/Lua preview surfaces (e.g. `src/styles.css:1089,1141,1188`).
- **`--accent` is used in 37 rules** plus **purple `rgba(124,109,250,…)` literals** at
  `src/styles.css:245,258,268,470,1016,1029,1030,1097,1464,1465,1468,1582,1628`.
- **Raw hex literals** that bypass tokens: `#000` / `#fff` at
  `src/styles.css:331,356,628,661,821`.
- **Color leaks outside CSS:**
  - Canvas draws: `src/selection/timeline.js:41` (`rgba(124,109,250,0.75)` clip fill),
    `:29` (`rgba(255,255,255,0.04)`), `:48` (`#ffffff` playhead);
    `src/selection/waveform.js:58` (`rgba(138,124,255,0.85)`), `:59`
    (`rgba(120,120,150,0.30)`).
  - Error banner: `src/main.js:68` hardcodes `background:#c0392b;color:#fff`.
  - **Inline styles** in `src/index.html` and ~11 JS files
    (`src/main.js`, `src/ui/export-popover.js`, `src/ui/settings-modal.js`,
    `src/ui/step2-prompt-panel.js`, `src/ui/step2-preset-bar.js`,
    `src/ui/auto-mode/progress-panel.js`, `src/ui/auto-mode/orchestrator.js`,
    `src/ui/import/segments.js`, `src/ui/import/project-io.js`,
    `src/ui/import/transcribe.js`, `src/ai/openrouter-picker.js`). Most reference
    tokens (`var(--text3)`) and thus re-theme for free; a few set raw font-sizes only
    (harmless) and must be checked for hardcoded colors.
- **Header logo**: `src/index.html:11-13` renders `<div class="logo"><div class="logo-icon">▶</div>Reels EDL Automator</div>`.
- **Vite** uses `root: 'src'` (`vite.config.js:6`), so static assets must live under
  `src/` and be referenced relatively. The logo will be **inline SVG** (provided by
  the user), so no binary asset bundling is required.
- **No automated CSS guard.** `test/regression.js` covers only parser/exporters;
  verification of this change is manual/visual. The regression suite must still pass
  (proves nothing visual broke logic).

## Desired End State

The app renders entirely in the BRAVE language: warm near-black canvas, `#DDDDDD`
type, DM Sans throughout the UI with monospace retained only on technical
(EDL/XML/Lua/timecode) surfaces, white/light interaction states with **no purple
anywhere** (CSS, canvas, or inline), BRAVE functional hexes for status feedback only,
and the BRAVE logo in a white chip in the header. All user-facing strings remain
Polish. `node --experimental-vm-modules test/regression.js` stays green.

### Key Discoveries:

- Token **remap (keep names)** turns a 381-site change into a single `:root` edit —
  chosen explicitly to minimize churn and regression risk.
- `--mono` is a **body** font today, so remapping it to DM Sans flips the body for
  free; a **new `--code` token (= DM Mono)** must be introduced and applied to the
  genuine code/preview surfaces so timecode columns stay aligned.
- Purple survives in **three places tokens don't reach**: raw `rgba(124,109,250,…)`
  in CSS, canvas `fillStyle`s, and the `main.js` error banner — these are the Phase 2
  sweep targets.
- Synchronous JS dialogs crash Tauri's WKWebView (see `lessons.md`) — irrelevant to
  styling but do **not** introduce any `alert/confirm/prompt` while touching JS files.

## What We're NOT Doing

- **Not** renaming tokens to the spec's `--color-*` vocabulary (decision: remap
  values, keep names). The CSS reads slightly off-spec by name; that's accepted.
- **Not** implementing the puzzle-block background motif — only the `--block` token is
  added now; the motif is a deferred follow-up.
- **Not** dropping monospace entirely — a dedicated `--code` token survives for
  technical surfaces.
- **Not** touching parser/exporter logic, frame math, or any non-visual behavior.
- **Not** changing any Polish copy (except removing the "Reels EDL Automator" text
  logo string, which the spec forbids).
- **Not** folding incidental Prettier reformatting into these commits (see
  `lessons.md`) — keep each commit scoped.

## Implementation Approach

Three phases, each independently reviewable and each leaving the app in a coherent
(if, mid-sequence, partially-purple) state:

1. **Foundation** — one `:root` rewrite + `@import` swap cascades the palette and
   type across every tokenized surface.
2. **Leak sweep** — eliminate every un-tokenized purple/old-palette reference (CSS raw
   literals, canvas, error banner, JS/HTML inline) and repoint code surfaces to
   `--code`.
3. **Logo** — replace the text logo with the inline SVG in a white chip.

## Phase 1: Token & Font Foundation

### Overview

Rewrite the `:root` block and the font `@import` in `src/styles.css` so the BRAVE
palette and DM Sans cascade through all 381 tokenized usages. Introduce two new
tokens (`--code`, `--block`) without yet wiring `--code` to surfaces (Phase 2 does
that).

### Changes Required:

#### 1. Font import

**File**: `src/styles.css` (line 1)

**Intent**: Load DM Sans (the new workhorse) and keep DM Mono available for code
surfaces; drop Syne.

**Contract**: Replace the `@import url('…DM+Mono…&family=Syne…')` with an import for
`DM+Sans:wght@400;500;700` plus `DM+Mono:wght@400;500` (DM Mono retained solely for
the `--code` token). Per the spec, DM Sans weights 400/500/700 are all in use.

#### 2. `:root` token remap

**File**: `src/styles.css` (`:root`, lines 11-53)

**Intent**: Swap every token *value* to its BRAVE equivalent while keeping the token
*names* unchanged, so all existing `var(--…)` references re-theme automatically.

**Contract**: Value mapping (names on the left are the existing tokens; do not rename):

- Neutrals: `--bg: #141313`, `--surface: #1C1B1B` (bg-elevated), `--surface2: #222121`
  (surface), `--surface3: #2E2D2D` (≈ border-strong tier for the third elevation),
  `--border: #2E2D2D`, `--border2: #3D3C3C`.
- Accent → **white/light** (monochrome interaction): `--accent: #FFFFFF`,
  `--accent2: #EAEAEA` (light-hover). All 37 accent usages thus become white/light.
- Text: `--text: #DDDDDD`, `--text2: #9B9B9B`, `--text3: #6E6E6E`.
- Functional (BRAVE hexes, app-state only): `--green: #4ADE80`, `--amber: #FBBF24`,
  `--red: #F87171`; add `--info: #60A5FA`.
- Fonts: `--display: 'DM Sans', …`, `--mono: 'DM Sans', …` (body workhorse → DM Sans),
  and **add** `--code: 'DM Mono', monospace` for technical surfaces.
- Add `--block: #1E1D1D` (decorative puzzle-block token; motif deferred).
- Add an on-light text token for white surfaces if not already derivable:
  `--text-on-light: #141313` (used by primary buttons / logo chip).

Keep the existing spacing/radius/shadow tokens as-is unless a value contradicts the
spec; the spec's radius/spacing scale is compatible with the current one.

### Success Criteria:

#### Automated Verification:

- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- App builds: `npm run tauri build` (or `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml` + `vite build`) completes without errors
- No remaining reference to `Syne` in `src/styles.css`: `grep -ni syne src/styles.css` returns nothing

#### Manual Verification:

- App canvas is warm near-black `#141313`; body type is `#DDDDDD` in DM Sans
- No purple appears on any **tokenized** surface (buttons, inputs, focus borders, links)
- Status colors (success/warning/error) render in the new BRAVE hexes
- Headings render in DM Sans (bold), not Syne

**Implementation Note**: After completing this phase and all automated verification
passes, pause for manual confirmation before proceeding.

---

## Phase 2: De-purple the Leaks & Repoint Code Surfaces

### Overview

Eliminate every un-tokenized old-palette reference that Phase 1 couldn't reach, and
point the genuine code/timecode/EDL/XML/Lua preview surfaces at the new `--code`
(DM Mono) token so numeric columns stay aligned.

### Changes Required:

#### 1. Purple `rgba()` and raw hex in CSS

**File**: `src/styles.css`

**Intent**: Replace hardcoded purple and bare black/white literals with monochrome
token-based values.

**Contract**: At each purple `rgba(124,109,250,α)` site
(`lines 245,258,268,470,1016,1029,1030,1097,1464,1465,1468,1582,1628`) substitute a
white/light equivalent — `rgba(255,255,255,α)` for fills/borders/focus rings, tuned
so emphasis reads on the dark canvas. At the raw-hex sites
(`lines 331,356,628,661,821`) replace `#fff` with the appropriate token
(`var(--text)` for type on dark, `var(--color-light)`/`#fff` only where a true white
chip/on-light surface is intended) and `#000` with `var(--text-on-light)`.

#### 2. Repoint code/preview surfaces to `--code`

**File**: `src/styles.css`

**Intent**: Keep monospace only where it earns its place (aligned timecodes, EDL/XML/
Lua export previews); everything else stays DM Sans (already handled by the `--mono`
remap in Phase 1).

**Contract**: Identify the code/preview rules among the 20 `var(--mono)` usages — the
export-preview `<pre>` blocks and timecode/numeric columns (e.g. `src/styles.css:1089,
1141,1188`, plus any export popover preview) — and change those to `var(--code)`.
Leave body/input/button `--mono` usages on DM Sans.

#### 3. Canvas draw colors

**File**: `src/selection/timeline.js`, `src/selection/waveform.js`

**Intent**: De-purple the timeline clip fill and waveform so the selection UI matches
the monochrome language.

**Contract**: `timeline.js:41` clip fill `rgba(124,109,250,0.75)` → a white/light
value (e.g. `rgba(255,255,255,0.75)`); `:29` track bg and `:48` playhead stay
white-based (already monochrome — verify contrast). `waveform.js:58` active peak
`rgba(138,124,255,0.85)` → white-based; `:59` inactive peak stays neutral grey. These
are 2D-canvas `fillStyle` strings, not CSS — they cannot read CSS vars, so use literal
monochrome values consistent with the token palette.

#### 4. Error banner

**File**: `src/main.js` (line 68)

**Intent**: Replace the hardcoded crimson error banner with the BRAVE danger token.

**Contract**: The inline `background:#c0392b;color:#fff` → use `var(--red)` (BRAVE
`#F87171`) for background with an appropriately dark/`--text-on-light` foreground for
contrast. Keep the Polish message text unchanged.

#### 5. Inline styles in HTML + JS

**File**: `src/index.html` and the ~11 JS files listed in Current State Analysis

**Intent**: Ensure no inline style reintroduces the old palette.

**Contract**: Grep each file for hardcoded colors (`#` hex, `rgba(`, named colors) in
inline `style=`/`.style`/`cssText`. Most inline styles only set `font-size` or already
use `var(--…)` — leave those untouched. Replace any hardcoded color with the matching
token. Do **not** introduce synchronous dialogs while editing JS (see `lessons.md`).

### Success Criteria:

#### Automated Verification:

- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- No purple literals remain in CSS: `grep -nE '124, *109, *250|7c6dfa|a695ff|138, *124' src/styles.css` returns nothing
- No purple literals remain in JS: `grep -rnE '124, *109, *250|138, *124, *255|7c6dfa' src --include='*.js'` returns nothing
- No `#c0392b` remains: `grep -rn 'c0392b' src` returns nothing

#### Manual Verification:

- Timeline clip blocks and waveform render white/grey, no purple
- Error banner renders in BRAVE danger color with legible text
- EDL/XML/Lua export previews and timecode columns are monospaced and aligned
- Non-code UI text is DM Sans
- A full click-through (import → analyze → export, settings modal, auto-mode) shows no purple anywhere

**Implementation Note**: After completing this phase and all automated verification
passes, pause for manual confirmation before proceeding.

---

## Phase 3: BRAVE Logo

### Overview

Replace the `▶ Reels EDL Automator` text logo in the header with the BRAVE wordmark
SVG. The asset is provided at `DesignNotes/BRAVE-LOGO.svg` and is **self-framing** — it
already renders as a white box with the BRAVE wordmark in black (a black inner rect +
white even-odd top path with letter-shaped holes), i.e. the spec's preferred on-dark
"black wordmark on white chip" badge. **No separate white-chip wrapper is needed.**

### Changes Required:

#### 1. Header logo markup

**File**: `src/index.html` (lines 11-13)

**Intent**: Swap the text logo for the BRAVE wordmark; remove the forbidden "Reels EDL
Automator" wordmark string and the `▶` icon.

**Contract**: Replace the `.logo` inner markup (`<div class="logo-icon">▶</div>` + text)
with the BRAVE wordmark. **Inline the SVG** from `DesignNotes/BRAVE-LOGO.svg` directly
into the markup (preferred — no Vite `root: 'src'` asset-path/bundling concern, crisp at
any size). The SVG is self-framing, so do not wrap it in an extra white box. Native size
is `148.328×46`; constrain to a header-appropriate height (e.g. cap the rendered height
~28–32px) while keeping aspect ratio and respecting the `88px` minimum legible width.
Add `aria-label="BRAVE"`. Never recolor, stretch, or rotate the mark.

#### 2. Logo container styles

**File**: `src/styles.css` (`.logo` / `.logo-icon` rules)

**Intent**: Retire the old `▶` accent-square styling and give the inline SVG correct
sizing + clear space.

**Contract**: Remove `.logo-icon` (the old `▶` accent square) styling. Update `.logo`
to size the inline `<svg>` (height-constrained, `width: auto`) with clear space ≥ the
cap-height of the "B" around it. Since the SVG already supplies its own white box, the
`.logo` container itself needs no background.

### Success Criteria:

#### Automated Verification:

- App builds without errors (`vite build` / `npm run tauri build`)
- No "Reels EDL Automator" / "REEL AUTOMATOR" text-logo string remains in the header: `grep -n 'Reels EDL Automator' src/index.html` returns nothing in the `.logo` block (the `<title>` may keep the product name)

#### Manual Verification:

- Header shows the BRAVE wordmark in a white chip, crisp at the rendered size
- Clear space and minimum width respected; logo not stretched or recolored
- Logo legible against the near-black header

**Implementation Note**: After completing this phase and all automated verification
passes, pause for final manual confirmation.

---

## Testing Strategy

### Automated:

- `node --experimental-vm-modules test/regression.js` after each phase — proves the
  parser/exporter pipeline is untouched (this change is visual-only).
- The `grep` guards listed per phase confirm no old-palette literal survives.

### Manual Testing Steps:

1. Launch `npm run tauri dev`; confirm canvas, type, and fonts match BRAVE.
2. Walk import → transcribe → analyze → export; open the settings modal, export
   popover, and auto-mode panel — verify no purple and consistent DM Sans.
3. Trigger an error (e.g. bad API key) to verify the error banner color.
4. Load a project and open the reel editor; check the timeline canvas + waveform.
5. Verify the header logo chip across window sizes.

## Performance Considerations

Negligible. One additional font family (DM Sans) loads; DM Mono is retained. Inline
SVG adds no network request. No runtime logic changes.

## Migration Notes

None — purely presentational. No `.reelproj` schema, state, or stored-data changes.

## References

- Design system spec: `DesignNotes/design-system.md`
- Reference assets: `DesignNotes/{BRAVE-LOGO.png, 3000x2500 BRAVE.png, PHOTO-POST.png}`
- Current tokens: `src/styles.css:11-53`
- Lessons (Tauri dialogs, commit scope): `context/foundation/lessons.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Token & Font Foundation

#### Automated

- [x] 1.1 Regression suite passes — 5f36a97
- [x] 1.2 App builds without errors — 5f36a97
- [x] 1.3 No `Syne` reference remains in `src/styles.css` — 5f36a97

#### Manual

- [x] 1.4 Canvas `#141313`, body type `#DDDDDD` in DM Sans — 5f36a97
- [x] 1.5 No purple on any tokenized surface — 5f36a97
- [x] 1.6 Status colors render in BRAVE hexes — 5f36a97
- [x] 1.7 Headings render in DM Sans, not Syne — 5f36a97

### Phase 2: De-purple the Leaks & Repoint Code Surfaces

#### Automated

- [x] 2.1 Regression suite passes — 39bb7cc
- [x] 2.2 No purple literals remain in CSS — 39bb7cc
- [x] 2.3 No purple literals remain in JS — 39bb7cc
- [x] 2.4 No `#c0392b` remains — 39bb7cc

#### Manual

- [ ] 2.5 Timeline + waveform render monochrome
- [ ] 2.6 Error banner in BRAVE danger color, legible
- [ ] 2.7 EDL/XML/Lua previews + timecodes monospaced and aligned
- [ ] 2.8 Non-code UI text is DM Sans
- [ ] 2.9 Full click-through shows no purple

### Phase 3: BRAVE Logo

#### Automated

- [x] 3.1 App builds without errors — 39bb7cc
- [x] 3.2 No text-logo string remains in the header `.logo` block — 39bb7cc

#### Manual

- [ ] 3.3 BRAVE wordmark in white chip, crisp
- [ ] 3.4 Clear space + minimum width respected
- [ ] 3.5 Logo legible against near-black header
