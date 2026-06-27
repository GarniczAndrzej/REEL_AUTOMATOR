# BRAVE — Design System

Derived from the reference assets in `DesignNotes/` (`BRAVE-LOGO.png`, `3000x2500 BRAVE.png`, `PHOTO-POST.png`). This is the visual language for the app's UI and any BRAVE-branded surface. All user-facing copy stays Polish.

> **Brand mark:** Use the **BRAVE logo** everywhere a wordmark/logo is required. Do **not** use a "REEL AUTOMATOR" text logo.

---

## 1. Brand essence

A confident, editorial, near-monochrome identity. A warm near-black canvas (`#141313`), soft off-white type (`#DDDDDD`), restrained grays, and a recurring **tetris/puzzle-block** motif in the background. The personality is bold and minimal — high contrast, lots of negative space, no decorative color.

| Principle | Expression |
|---|---|
| **High contrast** | Soft off-white on warm near-black; few mid-tones |
| **Editorial** | Large headline-led layouts, generous spacing |
| **Monochrome-first** | Color is the exception, not the rule |
| **Geometric** | Square/rounded-square blocks, the puzzle motif |

---

## 2. Logo

### BRAVE wordmark
- Heavy, bold **serif** wordmark (the `BRAVE-LOGO.png` asset). This is a fixed asset — **do not** re-typeset it in DM Sans.
- Two presentations:
  - **On dark:** white logo, or the logo inside a **solid white box** (logo art is black, sits on white chip) — see the badge usage in `3000x2500 BRAVE.png` and `PHOTO-POST.png`.
  - **On light:** black logo directly on the surface.

### Logo badge (preferred on dark surfaces)
```
┌──────────┐
│  BRAVE   │   ← black wordmark on white rectangle
└──────────┘
```
- White rectangle, ~`8px` horizontal / `6px` vertical padding around the mark.
- Corners: square (0px) to match the reference. Keep crisp.

### Clear space & sizing
- Clear space ≥ the cap-height of the "B" on all sides.
- Minimum legible width: **88px**.
- Never stretch, recolor (beyond black/white), rotate, or add effects.

---

## 3. Color

Near-monochrome. The palette is intentionally tiny.

### Brand anchors
| Token | Hex | Use |
|---|---|---|
| **Brand black** | `#141313` | The canvas — warm near-black, the base of everything |
| **Brand grey** | `#DDDDDD` | Titles & primary type — soft off-white, not pure `#FFFFFF` |

### Core neutrals
| Token | Hex | Use |
|---|---|---|
| `--color-bg` | `#141313` | Primary app/canvas background (brand black) |
| `--color-bg-elevated` | `#1C1B1B` | Cards, panels, modals on the canvas |
| `--color-surface` | `#222121` | Inputs, secondary surfaces |
| `--color-block` | `#1E1D1D` | Decorative puzzle blocks (slightly lifted from bg) |
| `--color-border` | `#2E2D2D` | Hairline borders, dividers |
| `--color-border-strong` | `#3D3C3C` | Focused/hovered borders |

### Text
| Token | Hex | Use |
|---|---|---|
| `--text-primary` | `#DDDDDD` | Headings, titles, primary copy (brand grey) |
| `--text-secondary` | `#9B9B9B` | Subheads, supporting copy |
| `--text-muted` | `#6E6E6E` | Captions, metadata, `/ brave.inc /` style labels |
| `--text-on-light` | `#141313` | Text on white/light surfaces (buttons, logo chip) |

> Titles and body type use **`#DDDDDD`**, not pure white — this softer grey is the brand's signature on the warm-black canvas. Reserve pure `#FFFFFF` only for the logo chip / light-surface fills where maximum contrast is intended.

### Inverted (light surface)
| Token | Hex | Use |
|---|---|---|
| `--color-light` | `#FFFFFF` | White chips, primary buttons, logo box |
| `--color-light-hover` | `#EAEAEA` | Hover state of white surfaces |

### Functional (use sparingly — only for app state)
| Token | Hex | Use |
|---|---|---|
| `--color-success` | `#4ADE80` | Confirmations |
| `--color-warning` | `#FBBF24` | Warnings |
| `--color-danger` | `#F87171` | Errors / destructive |
| `--color-info` | `#60A5FA` | Neutral info |

> Functional colors are for application feedback only (validation, transcription status, etc.). Marketing/brand surfaces stay monochrome.

---

## 4. Typography

**Primary typeface: `DM Sans` (Regular).** Use DM Sans for all UI and content type. The BRAVE logo serif is the *only* exception and ships as artwork.

```css
font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

Weights in play: **Regular (400)** as the workhorse, **Medium (500)** for UI labels/buttons, **Bold (700)** reserved for large display headlines (as seen in the reference). Default body is Regular.

### Type scale
| Token | Size / Line | Weight | Tracking | Use |
|---|---|---|---|---|
| `display` | 48 / 1.1 | 700 | -0.02em | Hero headlines (`Największe i najlepiej oceniane…`) |
| `h1` | 32 / 1.2 | 700 | -0.01em | Page titles |
| `h2` | 24 / 1.25 | 500 | -0.01em | Section titles (`Kreatywne myślenie`) |
| `h3` | 20 / 1.3 | 500 | 0 | Subsections |
| `body-lg` | 18 / 1.5 | 400 | 0 | Lead paragraphs |
| `body` | 15 / 1.5 | 400 | 0 | Default body |
| `small` | 13 / 1.45 | 400 | 0 | Secondary / names / metadata |
| `caption` | 11 / 1.4 | 500 | 0.08em (UPPER) | Labels, tags, `/ brave.inc /`, `#BRAVE AI MEETUP` |

### Headline treatment
- Large headlines: white, bold, tight leading (`1.1`), negative tracking, often **multi-line left-aligned**.
- Eyebrow/label text: uppercase, `--text-muted`, letter-spaced, frequently wrapped in slashes (`/ brave.inc /`) or hash (`#BRAVE AI MEETUP`).

---

## 5. Spacing & layout

8px base grid.

| Token | px |
|---|---|
| `--space-1` | 4 |
| `--space-2` | 8 |
| `--space-3` | 12 |
| `--space-4` | 16 |
| `--space-5` | 24 |
| `--space-6` | 32 |
| `--space-7` | 48 |
| `--space-8` | 64 |

- **Generous margins** — the references breathe. Hero padding ≥ `48px`.
- Left-aligned, top-weighted compositions: logo top-left, label top-right, content stacked below.
- Photos/media use rounded corners (`--radius-lg`) and sit within the dark frame with margin on all sides.

### Radius
| Token | px | Use |
|---|---|---|
| `--radius-sm` | 6 | Tags, small chips |
| `--radius-md` | 10 | Buttons, inputs |
| `--radius-lg` | 16 | Cards, media, photos |
| `--radius-block` | 4 | Decorative puzzle blocks |

---

## 6. The puzzle-block motif

A signature background texture: scattered square / L-shaped (tetromino) blocks in `--color-block`, only marginally lighter than the canvas. Quiet, never loud.

Guidelines:
- Tile from edges/corners; let it bleed off-canvas.
- Keep contrast subtle: blocks are `#1E1E1E` on `#0A0A0A` (barely visible — atmosphere, not pattern).
- Rounded `--radius-block` corners on individual cells.
- Never place behind small body text where it would harm legibility.

---

## 7. Components

### Buttons

**Primary (light)** — the `DOŁĄCZ DO NAS` style:
- White background (`--color-light`), black text (`--text-on-light`), Medium 500.
- Padding `12px 20px`, radius `--radius-md`, uppercase or sentence case.
- Hover: `--color-light-hover`.

**Secondary (outline):**
- Transparent bg, `1px` `--color-border-strong` border, `--text-primary` text.
- Hover: border → white, subtle bg `--color-surface`.

**Ghost:** text-only, `--text-secondary` → `--text-primary` on hover.

### Tags / chips
- The `DESIGN` / `WORKSHOP` style: outlined pill, `1px --color-border`, uppercase `caption`, `--text-secondary`.
- Padding `6px 12px`, radius `--radius-sm`.

### Cards
- `--color-bg-elevated` surface, `1px --color-border`, `--radius-lg`.
- Inner padding `24px`. Optional media at top with matching radius.

### Inputs
- `--color-surface` bg, `1px --color-border`, `--radius-md`, `--text-primary` text, `--text-muted` placeholder.
- Focus: border `--color-border-strong` / white, no heavy glow.

### Accent marks
- Plus (`+`) and four-point spark (`✦`) glyphs as separators/decoration (e.g. `20 000+ absolwentów ✦ 1000+ organizacji`), in `--text-muted` or white.

---

## 8. Elevation

Shadows are minimal — depth comes from value steps (bg → elevated → surface), not heavy drop shadows.

| Token | Value |
|---|---|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.4)` |
| `--shadow-md` | `0 4px 16px rgba(0,0,0,0.5)` |
| `--shadow-lg` | `0 12px 40px rgba(0,0,0,0.6)` |

---

## 9. CSS custom properties (starter)

```css
:root {
  /* neutrals */
  --color-bg: #141313;
  --color-bg-elevated: #1C1B1B;
  --color-surface: #222121;
  --color-block: #1E1D1D;
  --color-border: #2E2D2D;
  --color-border-strong: #3D3C3C;

  /* text */
  --text-primary: #DDDDDD;
  --text-secondary: #9B9B9B;
  --text-muted: #6E6E6E;
  --text-on-light: #141313;

  /* light surfaces */
  --color-light: #FFFFFF;
  --color-light-hover: #EAEAEA;

  /* functional */
  --color-success: #4ADE80;
  --color-warning: #FBBF24;
  --color-danger: #F87171;
  --color-info: #60A5FA;

  /* type */
  --font-sans: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  /* spacing */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;

  /* radius */
  --radius-sm: 6px;  --radius-md: 10px; --radius-lg: 16px; --radius-block: 4px;

  /* elevation */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.5);
  --shadow-lg: 0 12px 40px rgba(0,0,0,0.6);
}
```

Load DM Sans (e.g. self-hosted or Google Fonts):
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
```

---

## 10. Do & Don't

**Do**
- Keep surfaces near-black with white type; let layouts breathe.
- Use the BRAVE logo (white, or in a white chip) as the only wordmark.
- Reserve color strictly for application state feedback.
- Use the puzzle-block motif subtly for atmosphere.

**Don't**
- Don't introduce a "REEL AUTOMATOR" text logo — use BRAVE.
- Don't re-typeset the BRAVE mark in DM Sans.
- Don't add gradients, bright fills, or decorative color to brand surfaces.
- Don't crowd the layout — negative space is part of the brand.
