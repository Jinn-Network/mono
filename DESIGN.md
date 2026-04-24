---
name: Jinn
description: A decentralised network for training agentic fulfilment of outcomes.
colors:
  bg: "#0c1628"
  bg-elevated: "#142340"
  bg-sunken: "#070d18"
  fg: "#f2f7fc"
  fg-muted: "#a4b0c2"
  fg-dim: "#7d8ba3"
  border: "#1f3a66"
  border-strong: "#7aa7dc"
  border-accent: "#c9a048"
  accent-sky: "#7aa7dc"
  accent-sky-hover: "#a8c8ea"
  accent-gold: "#dcb866"
  accent-gold-hover: "#ead08e"
  vow-green: "#6a9b8f"
  wane: "#b8802f"
  break-red: "#a85a5a"
  seer-violet: "#7a6db0"
typography:
  display:
    fontFamily: "Instrument Serif, Times New Roman, serif"
    fontSize: "88px"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "0"
  display-xl:
    fontFamily: "Instrument Serif, Times New Roman, serif"
    fontSize: "120px"
    fontWeight: 400
    lineHeight: 0.95
    letterSpacing: "0"
  headline:
    fontFamily: "Instrument Serif, Times New Roman, serif"
    fontSize: "48px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "17px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "-0.01em"
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0.14em"
  wish:
    fontFamily: "Instrument Serif, Times New Roman, serif"
    fontSize: "26px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
rounded:
  none: "0"
  chip: "4px"
  default: "6px"
  panel: "10px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
  "8": "64px"
  "9": "96px"
  "10": "128px"
components:
  button-primary:
    backgroundColor: "{colors.accent-sky}"
    textColor: "{colors.bg-sunken}"
    rounded: "{rounded.default}"
    padding: "10px 20px"
  button-primary-hover:
    backgroundColor: "{colors.accent-sky-hover}"
    textColor: "{colors.bg-sunken}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    rounded: "{rounded.default}"
    padding: "10px 20px"
  button-ghost-hover:
    backgroundColor: "transparent"
    textColor: "{colors.accent-sky}"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.chip}"
    padding: "2px 8px"
  chip-accent:
    backgroundColor: "transparent"
    textColor: "{colors.accent-sky}"
    rounded: "{rounded.chip}"
    padding: "2px 8px"
  chip-solid:
    backgroundColor: "{colors.fg}"
    textColor: "{colors.bg}"
    rounded: "{rounded.chip}"
    padding: "2px 8px"
  card:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.fg}"
    rounded: "{rounded.panel}"
    padding: "24px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.default}"
    padding: "10px 12px"
---

# Design System: Jinn

## 1. Overview

**Creative North Star: "Protocol Brutalism"**

Jinn is protocol brutalism. The surface is a deep night-blue (`#0c1628`). Hierarchy is carried by hairline 1px borders, not shadows. The type system is two voices only — Instrument Serif for *feeling*, JetBrains Mono for *doing* — with no sans anywhere. Sky-blue ink (`#7aa7dc`) threads structure; lamplight gold (`#dcb866`) is reserved for a single point of emphasis on any surface. The contrast between evocative copy (*summon, bind, vow, vessel, wish, smoke, seer, wane*) and stark, engineering-diagram UI is the brand.

The system is **headless by design**. Palette, sigils, even the wordmark are expected to be forked by node operators and community contributors. The protocol invariants — the lexicon, the two-voice type system, the no-emoji / no-gradient / no-sans rules — are fixed. The narrative layer is not.

This system explicitly rejects: dark-mode-plus-neon crypto aesthetics, purple-gradient SaaS chrome, glassmorphic blurred containers, emoji anywhere, bouncy springy motion, Material-style filled icons, and stock photography of people. If a render could be guessed as "crypto → neon on black" from the category alone, it has failed the system.

**Key characteristics:**

- Dark-first. Canonical rendering is sky-blue ink on moon-bone, touched by lamplight.
- Hairline borders are the primary hierarchy. Shadows are rare; blurs are banned for UI chrome.
- Two type voices: serif for feeling, mono for doing. No sans.
- Softened-brutalist radii (4 / 6 / 10). Never razor-square, never pillowy.
- Linear motion. No bounce, overshoot, or spring.
- Emoji never. Ever. The sigils and the words are the iconography.

## 2. Colors: Sky, Moon, Lamplight

A nocturnal palette — sky-blue ink on moon-bone, touched by oil-lamp gold. Dark-first; light mode exists but the canonical rendering is the protocol in deep night.

### Primary

- **Sky** (`#7aa7dc`): primary accent. Links, active states, strong borders, structural emphasis in diagrams. Hover brightens to **Bright Sky** (`#a8c8ea`).
- **Moon-bone** (`#f2f7fc`): primary foreground. All body copy, data, code, default icon fill.

### Secondary

- **Lamplight Gold** (`#dcb866`): secondary accent, used as a *hint* rather than a fill. Verified states, a single point of emphasis per surface, the border of a selected or primary element. Canonical static form is `#c9a048` (used for `border-accent`). Hover brightens to **Bright Lamplight** (`#ead08e`).

### Tertiary (status)

- **Vow Green** (`#6a9b8f`): success, bound, completed. A cool teal-green, never the sickly SaaS green.
- **Wane** (`#b8802f`): warning, unresolved, pending. A deep lamplight, not yellow.
- **Break Red** (`#a85a5a`): error, broken. Cool iron-red, never fire-engine.
- **Seer Violet** (`#7a6db0`): info, reading, in-smoke. Night-watcher purple.

### Neutral

- **Deep Night** (`#0c1628`): primary dark surface. The canonical background.
- **Elevated Night** (`#142340`): cards, panels, elevated surfaces.
- **Void** (`#070d18`): sunken surfaces, vessel interior, modal scrim anchor.
- **Smoke 300** (`#a4b0c2`): muted foreground — eyebrow labels, secondary text.
- **Smoke 400** (`#7d8ba3`): dim foreground — tertiary text, placeholder captions.
- **Dark Hairline** (`#1f3a66`): the default 1px border, on every container.

### Named Rules

**The Gold-as-Hint Rule.** Gold is a hint, not a fill. One gold element of emphasis per surface. If a design has gold in two places, one of them is wrong. The verified tick, the single selected chip, the accent border on a primary affordance — pick one.

**The No-Pure-Neutral Rule.** Never `#000` or `#fff`. Every neutral carries a sky-blue tint. `#070d18` is the darkest permitted; `#f2f7fc` is the lightest.

**The One-Voice Rule.** A screen has one primary accent. Sky carries structure; gold carries emphasis. Never both loud at once.

## 3. Typography

**Display Font:** Instrument Serif (Times New Roman, serif)
**Body / UI / Data Font:** JetBrains Mono (ui-monospace, SF Mono, Menlo, monospace)
**No sans. Ever.**

**Character:** The serif is for *feeling* — the mystical pull-quote, the headline of an essay, the wish. The mono is for *doing* — every UI label, every data value, every line of body copy, every code block. The absence of a utility sans is deliberate: mono body text is the brutalist tell.

### Hierarchy

- **Display** (400, 88px, line-height 1.05): marketing hero headlines only. Instrument Serif.
- **Display XL** (400, 120px, line-height 0.95): the single biggest mark on a landing page.
- **Headline** (400, 48px, line-height 1.2): section heads in long-form content. Instrument Serif.
- **Title** (500, 17px, line-height 1.2, tracking -0.01em): in-product section titles. JetBrains Mono.
- **Body** (400, 14px, line-height 1.7, tracking -0.01em): default body copy. Cap line length at ~72ch.
- **Label** (500, 11px, tracking 0.14em, UPPERCASE): eyebrows, column headers, status chips. Never for anything a user reads at length.
- **Wish** (italic 400, 26px, line-height 1.5): the one decorative flourish — the pull-quote. Slow-fade entrance permitted up to 600ms.

### Named Rules

**The Two-Voices Rule.** Serif for feeling, mono for doing. If a string is neither display headline nor mystical pull-quote, it is mono. Period.

**The Labels-in-Caps, Actions-in-Sentence Rule.** ALL CAPS MONO is for *status* — eyebrows, chips, column headers. Sentence case is for *action* — button labels, titles, headlines (`Bind vessel`, not `BIND VESSEL`).

## 4. Elevation

Jinn is flat by default. Hierarchy comes from **hairline borders**, not shadows. Borders do the work of depth that other systems hand to elevation.

### Shadow Vocabulary (rare, used only when structurally required)

- **Hard offset small** (`box-shadow: 2px 2px 0 0 #070d18`): optional accent on interactive cards or tiles.
- **Hard offset** (`box-shadow: 4px 4px 0 0 #070d18`): pressed/held states on buttons or tiles.
- **Hard offset large** (`box-shadow: 6px 6px 0 0 #070d18`): rare; marketing hero tiles only.
- **Float shadow** (`box-shadow: 0 12px 32px -8px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.3)`): the only soft blur permitted. Reserved for floating overlays (menus, toasts, modals) where the container must visibly lift off the surface.

### Named Rules

**The Hairline-over-Shadow Rule.** Hierarchy is carried by *more borders* and *less shadow* than a typical system. If you need to separate two surfaces, add a border first; elevate second; never both.

**The No-Float-on-Chrome Rule.** `--shadow-float` is for overlays only. Never on cards, buttons, inputs, or any resting-state container.

**The No-Glass Rule.** `backdrop-filter: blur()` is banned for UI chrome (headers, toolbars, panels). If a designer feels they need glass, they need a border instead.

## 5. Components

### Buttons

- **Shape:** softened-brutalist (`rounded.default`, 6px).
- **Primary:** Sky fill (`#7aa7dc`) on Void text (`#070d18`); 10px × 20px padding; sentence case; JetBrains Mono 500.
- **Hover:** background brightens to `#a8c8ea`. No scale, no glow.
- **Focus:** 2px solid `#7aa7dc` outline with 2px offset.
- **Press:** background darkens one step. No scale-down.
- **Ghost:** transparent background, moon-bone text, hairline border. On hover, text and border both shift to sky.
- **Disabled:** 40% opacity, `cursor: not-allowed`, no interactivity.

### Chips

- **Shape:** `rounded.chip` (4px) for default chips; `rounded.pill` (999px) for *status* chips only.
- **Default:** transparent background, `#a4b0c2` text, 1px hairline border, ALL CAPS MONO, letter-spacing 0.14em.
- **Accent:** transparent background, sky text, sky border.
- **Solid:** moon-bone fill, deep-night text. Used rarely, for emphasised status.
- **Status variants:** `vow-green`, `wane`, `break-red`, `seer-violet` on both border and text — never on a filled background.

### Cards (Panels)

- **Corner style:** `rounded.panel` (10px).
- **Background:** `bg-elevated` (`#142340`). Flat color, never gradient.
- **Border:** 1px hairline (`#1f3a66`).
- **Shadow:** none at rest. Hover darkens the border from `--border` to `--border-strong` (sky). No lift, no glow.
- **Internal padding:** 24px default (`space.5`).
- **Never nest cards in cards.**

### Inputs

- **Shape:** `rounded.default` (6px).
- **Style:** `bg` fill (`#0c1628`), 1px hairline border, mono body type.
- **Focus:** 2px solid sky outline with 2px offset. Visible, sharp, no glow.
- **Error:** border and helper text shift to `break-red` (`#a85a5a`).
- **Disabled:** 40% opacity, not-allowed cursor.

### Navigation

- **Top nav:** fixed allowed. Flat surface, single hairline divider at base, ALL CAPS MONO labels, letter-spacing 0.14em.
- **Hover:** label color shifts from `fg-muted` to `fg`. No underline, no pill, no color wash.
- **Active:** label is `fg` with a 1px sky underline offset 4px below the text.
- **Mobile:** collapses to a drawer with the same typography and hairline treatment.

### Sigils (Signature Component)

Five canonical brand marks ship with the system: `logo-sigil`, `logo-wordmark`, `mark-smoke`, `mark-binding`, `mark-node`.

- **Color:** always `currentColor`. Monochrome only; never multi-color.
- **Stroke:** 1.5–2px, square terminals.
- **Sizing:** 16 / 20 / 24px as icons; ≥40px as sigils. Below 16px, drop to the solid dot variant.
- **Style:** mono-line, square-terminal glyphs — not illustrations.

### Named Rules

**The No-Emoji Rule.** Never. Not in product. Not in marketing. Not in docs. The sigils, the typography, and the words are the iconography. Emoji break the spell.

**The Sigil-before-Lucide Rule.** For Jinn-native concepts (node, vow, smoke, wish, seer), use the brand sigil. For generic UI affordances (chevron, search, close, copy), Lucide at `stroke-width="1.5"` is permitted as a stand-in, pending a native Jinn icon set.

## 6. Do's and Don'ts

### Do

- **Do** use JetBrains Mono for every label, value, body line, and code block.
- **Do** use Instrument Serif *only* for display headlines, section heads, and the italic pull-quote (`.wish`).
- **Do** use hairline 1px borders as the primary hierarchy. More borders, less shadow.
- **Do** use gold as a single point of emphasis per surface — the verified tick, one selected chip, one active border.
- **Do** use sentence case for titles, headlines, and button labels (`Bind vessel`).
- **Do** use ALL CAPS MONO with `letter-spacing: 0.14em` for labels, eyebrows, and status chips — never for anything read at length.
- **Do** use softened-brutalist radii: chip 4px, default 6px, panel 10px.
- **Do** tint every neutral toward `#0c1628`. If a neutral could be guessed as pure gray, add 0.005–0.01 of blue chroma.
- **Do** drop the vow-language (*summon, bind, vow, vessel, wish, smoke, seer, wane*) whenever money, safety, or legal consent is on the line. Clarity beats mood.
- **Do** document any change you make. The brand is headless; you're a co-author, not a user.

### Don't

- **Don't** use emoji. Ever. Not in product. Not in marketing. Not in docs.
- **Don't** use `#000` or `#fff`. The darkest permitted neutral is `#070d18`; the lightest is `#f2f7fc`.
- **Don't** use a sans font. The two-voices rule is the system.
- **Don't** use gradients as decoration. The one exception is the top/bottom protection gradient over imagery (`.protect-top`, `.protect-bottom`).
- **Don't** use `backdrop-filter: blur()` for UI chrome. If you want glass, use a border.
- **Don't** use `ease-out-back`, `ease-out-elastic`, or any spring curve. Linear is default; `cubic-bezier(0.4, 0, 0.2, 1)` is the rare exception.
- **Don't** use `--shadow-float` on cards, buttons, or inputs. Overlays only.
- **Don't** nest cards inside cards. Ever.
- **Don't** stack gold on gold. One gold element of emphasis per surface.
- **Don't** use dark-mode-plus-purple-gradient crypto chrome. Jinn is night-blue on moon-bone; if a render reads as "crypto → neon on black", it has failed the system.
- **Don't** use Material-style filled icons or multi-color iconography. Everything is `currentColor`, stroke 1.5px, square terminals.
- **Don't** invent new vow-language without marking it as a proposal. The lexicon is protocol, not narrative.
