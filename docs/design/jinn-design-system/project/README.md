# Jinn Design System

> *A decentralised network for training agentic fulfilment of outcomes.*

---

## What is Jinn?

Jinn is a protocol. Participants — engineers, designers, BD, operators, almost anyone technical enough to run an agent harness — **summon** outcomes into the network, and the network coordinates training, fulfilment, and verification across its nodes.

The vocabulary is deliberate: *summon, bind, vow, vessel, wish, smoke, seer, wane*. The visuals are not. Visually, the system is **protocol brutalism** — hairlines, mono type, sky-blue ink on moon-bone, touched by oil-lamp gold. Square corners, no ornament. The contrast between evocative copy and stark UI is the brand.

### This system is headless by design

**Jinn's long-term brand is co-created with its participants.** This design system is a *starting point*, not a law. Everything here — palette, sigils, even the name-as-wordmark — is expected to be forked, re-skinned, and remixed by node operators, product teams, and community contributors. Document what you change; that's the vow.

When in doubt: **keep the words, loosen the visuals.**

---

## Sources

No source materials were provided for this system. The brand was invented from the one-line description above, with direction set by the project owner across a question round (audience, vibe, palette, tone). **There is no existing codebase, Figma file, or prior brand artifact** — everything here is original.

If source material becomes available later, it should supersede this document. See `assets/` for all marks and `ui_kits/` for the product recreations.

---

## Index

```
├── README.md                    ← you are here
├── SKILL.md                     ← agent skill manifest
├── colors_and_type.css          ← color tokens + type scale + webfonts
├── foundations.css              ← spacing, radii, shadows, motion, utilities
├── assets/
│   ├── logo-sigil.svg           ← primary mark — "The Vessel"
│   ├── logo-wordmark.svg        ← sigil + "jinn" italic wordmark
│   ├── mark-smoke.svg           ← alt mark — rising line
│   ├── mark-binding.svg         ← alt mark — bound vow
│   └── mark-node.svg            ← alt mark — network participant
├── fonts/                       ← webfonts (loaded from Google Fonts CDN; no local files)
├── preview/                     ← registered design-system cards
├── ui_kits/
│   └── explorer/                ← on-chain explorer UI kit
│       ├── index.html           ← interactive KPI + wish-table view
│       ├── Chrome.jsx           ← Logo, TopNav, SearchBox, StatusBar
│       ├── Data.jsx             ← StatusChip, KPI, WishRow, TableHead
│       └── WishDetail.jsx       ← right-pane scrying log
└── slides/                      ← technical-talk deck (6 slides)
    ├── index.html               ← use arrow keys to navigate
    ├── Slides.jsx               ← all slide components
    └── deck-stage.js            ← scaling + keyboard nav shell
```

---

## Content Fundamentals

**Voice:** mystical, evocative, a touch poetic — but never precious. The words do the magic so the visuals don't have to.

**Lexicon:** swap technical verbs for vow-language whenever it doesn't obscure meaning:

| Generic        | Jinn                      |
|----------------|---------------------------|
| submit a job   | **summon** an outcome     |
| a running job  | a **wish in smoke**       |
| a completed job| a **bound vow**           |
| a node         | a **vessel**              |
| a validator    | a **seer**                |
| stake          | **bind**                  |
| unstake        | **release**               |
| failure        | the wish **wanes**        |
| logs           | the **scrying**           |
| network status | the **ether**             |

**Person:** *you* to the reader, *we* rarely (and only on marketing). Inside product surfaces, no person — just commands and state.

**Casing:**
- **Titles & headlines:** sentence case. (`Summon an outcome` — not `Summon An Outcome`.)
- **UI labels:** ALL CAPS MONO with `letter-spacing: 0.14em`. Reserved for eyebrows, column headers, status chips. Never for body or for anything a user reads at length.
- **Button labels:** sentence case (`Bind vessel`, not `BIND VESSEL`). Caps is for *status*, not *action*.
- **Numbers:** tabular. Always show units. Commas for thousands.

**Punctuation:**
- **Em dashes** — yes, liberally. They match the serif's rhythm.
- **Oxford commas** — yes.
- **Exclamation points** — no. A jinn doesn't exclaim.
- **Ellipses** — only for in-progress states (`Binding…`) or genuine poetic trail-off.

**Emoji:** **never.** Not in product, not in marketing, not in docs. The iconography is the sigils, the typography, and the words. Emoji break the spell.

**Specific examples of the voice:**

> ✗ *"Error: job failed after 3 retries."*
> ✓ **"The wish waned. Three attempts, no smoke."**

> ✗ *"🎉 Welcome to Jinn! Let's get you set up."*
> ✓ **"Welcome, vessel. Speak your first wish."**

> ✗ *"Stake 500 tokens to become a validator."*
> ✓ **"Bind 500 tokens. Become a seer."**

> ✗ *"Click here to view logs."*
> ✓ **"Read the scrying →"**

> ✗ *"Something went wrong. Please try again."*
> ✓ **"The ether refused. Try once more."**

Don't force it. If the vow-language obscures a critical action — a billing warning, a security prompt, a legal consent — drop the metaphor and speak plainly. Clarity beats mood every time the user's money or safety is on the line.

---

## Visual Foundations

### Colors
A nocturnal palette — sky-blue ink, moon-bone, lamplight gold. Primary surface is **blue-900** (`#0c1628`), accented with luminous **blue-400** (`#7aa7dc`) and highlighted by **gold-400** (`#dcb866`) used sparingly. Dark-first: the protocol lives in the dark. Light mode exists, but the canonical rendering is ink-on-black with bone text. See `colors_and_type.css` for the full scale and semantic tokens (`--bg`, `--fg`, `--accent`, status colors).

### Typography
**Two voices, no sans.** *Instrument Serif* for display and italic pull-quotes; *JetBrains Mono* for literally everything else — UI, body, data, code. The absence of a utility sans is deliberate: mono body text is the brutalist tell. See `colors_and_type.css`.

Serif is for **feeling**. Mono is for **doing**.

### Spacing
4-px base, rigid geometric scale (4, 8, 12, 16, 24, 32, 48, 64, 96, 128). No half-steps. If a design needs something between `space-5` and `space-6`, pick one — don't invent `space-5.5`.

### Backgrounds
Flat color is the default. **No gradients** as decoration (the one exception: protection gradients over imagery). Optional subtle **textures** are defined in `foundations.css`:
- `.texture-grid` — 24px hairline grid, ~6% opacity. Used on hero sections.
- `.texture-dots` — 16px dot grid, ~12% opacity. Used on empty states.
- `.texture-scan` — CRT-ish scanlines, ~18% opacity. Used rarely, for the "in smoke" / processing state only.

**Imagery:** when used (rare), tonally warm — sepia, oil-lamp amber, dust. Never saturated. Grain acceptable. No stock photography of people. Abstract, astronomical, architectural, cartographic, or documentary-technical (circuit traces, old manuscripts, star charts).

### Borders
Hairlines. `1px solid var(--border)` is the default for every container. Borders are the primary unit of visual hierarchy — we use *more borders* and *less shadow* than a typical system.
- `--border` — default, dim
- `--border-strong` — for emphasis, selected states
- `--border-accent` — gold tone, for accent/primary state
- `--border-dashed` — for pending, ephemeral, or "in smoke" states

### Shadows
**Used sparingly.** When used, they are **hard offset shadows** (no blur), in ink:
- `--shadow-hard-sm` — `2px 2px 0 ink-950`
- `--shadow-hard` — `4px 4px 0 ink-950`
- `--shadow-hard-lg` — `6px 6px 0 ink-950`

One exception, `--shadow-float`, is a soft blur — reserved **only** for floating overlays (menus, toasts, modals) where the container must visibly lift off the surface. Never use it on cards, buttons, or inputs.

### Corner radii
**Softened brutalism.** Subtle rounding everywhere — not razor-square, not pillowy.
- `--radius-1` (4px) — chips, small inputs, tight affordances
- `--radius-2` (6px) — **default** for buttons, inputs, small cards
- `--radius-3` (10px) — panels, large cards, images, dialogs
- `--radius-pill` — status chips only

### Animation & motion
**Short, linear, no bounce.** Things appear. Things state-change. Things do not bounce, overshoot, or spring.
- `--dur-fast` 80ms — hover, focus, small state
- `--dur-base` 140ms — most transitions
- `--dur-slow` 240ms — panel reveals, page transitions
- Easing: **linear** is the default. `cubic-bezier(0.4, 0, 0.2, 1)` is available but used rarely. **Never** `ease-out-back`, `ease-out-elastic`, or any spring.

The exception: the one permitted "magical" motion is a **slow fade** (up to 600ms) reserved for the `.wish` display element when it first appears. That's the only place we lean into the mysticism.

### Hover & press states
- **Hover on buttons/links:** accent brightens (`--accent` → `--accent-hover`). No scale, no glow.
- **Hover on cards:** `border-color` goes from `--border` to `--border-strong`. No shadow, no lift.
- **Press:** the element's background darkens 1 step (`--bg-elevated` → `--bg`). No scale-down.
- **Disabled:** 40% opacity, `cursor: not-allowed`, no interactivity.
- **Focus:** always a 2px solid accent outline with 2px offset. Visible, sharp, no glow.

### Transparency & blur
**Almost never.** `backdrop-filter: blur()` is banned for UI chrome (headers, toolbars). The one permitted use is the `--shadow-float` overlays — no blur, but a soft shadow. If a designer feels they need glass, they need a border instead.

Semi-transparency (`rgba`) is fine for:
- Protection gradients over imagery (`.protect-top` / `.protect-bottom`)
- Texture overlays (always ≤20% opacity)
- Nothing else.

### Cards
A card is a `.panel`: square, hairline border, no shadow. Hover darkens the border. That's the whole anatomy. Cards do not float. Cards do not glow. If you need hierarchy between cards, use *layout* (size, position, borders around groups), not shadow-depth.

### Layout rules
- **Fixed elements** are allowed for: primary nav (top or side), status bar (bottom of explorer), floating toast region. Nothing else should be fixed.
- **Full-bleed** is encouraged on marketing surfaces — dividers should reach edge-to-edge, section transitions should use a single hairline.
- **Grid:** 8-column at large, 4 at tablet, 1 at mobile. 24px gutters.
- **Max content width:** 1440px. Long-form copy caps at ~72ch for readability.

---

## Iconography

**Approach:** minimal, mono-line, 1.5–2px stroke weight, square terminals, currentColor fills. Icons are **glyphs**, not illustrations. They are always monochrome. They live at 16px, 20px, and 24px; at anything larger they become sigils (see below).

**What Jinn uses for icons:**

1. **Brand sigils** (`assets/mark-*.svg`, `assets/logo-*.svg`) — these are the native iconography of the brand. Use the sigils for concepts that have a Jinn-native meaning (a *node* is `mark-node`, a *bound vow* is `mark-binding`, a *wish in smoke* is `mark-smoke`). Five canonical sigils ship with this system.

2. **Lucide** (CDN) — for everything else (UI affordances: chevron, close, search, copy, etc.). Stroke weight 1.5px matches our sigils. Load from CDN:

   ```html
   <script src="https://unpkg.com/lucide@latest"></script>
   <i data-lucide="arrow-right"></i>
   <script>lucide.createIcons();</script>
   ```

   > **⚠ Substitution flagged:** Lucide is a stand-in pending a native Jinn icon set. When in use, size at 16/20/24px only, `stroke-width="1.5"`, `currentColor`.

**What Jinn does not use:**
- ❌ **Emoji** — ever. See Content Fundamentals.
- ❌ **Filled / Material-style icons** — wrong weight, wrong vibe.
- ❌ **Multi-color icons** — everything is `currentColor`.
- ❌ **Unicode characters as icons** (no `✓`, `✗`, `→` inside UI chrome — these read as typewriter noise; use actual sigils or Lucide).
  - *Exception:* `→` is permitted as part of link text (`Read the scrying →`) where it reads as punctuation, not iconography. Same for `—`.
- ❌ **Decorative illustrations of jinn, lamps, smoke, stars as literal imagery.** The sigils are the only permitted symbolic visuals.

---

*Continue to `SKILL.md` for the agent-invocable skill, `ui_kits/explorer/` for the explorer kit, and `slides/` for the technical-talk template.*
