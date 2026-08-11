# Colophon — Design System

**Colophon** is a standalone product that lets people and authorized agents compare multiple agent
configurations on the same work, choose how the results are evaluated, and publish a benchmark claim
whose method, evidence, failures and conclusions can be independently inspected.

It runs on Jinn infrastructure. It is **not** a Jinn-branded product — see *Jinn attribution* below.

- **Category descriptor:** benchmark publishing for agent configurations
- **Five-second read:** *Compare agents on the same work.*
- **Deeper promise:** *Publish benchmark claims people can check.*
- **Flagship artifact:** the public report. Everything else is an entrance to it.

**Sources for this engagement.** The standalone benchmarking product charter supplied in chat. No
codebase, Figma file, existing brand assets or font binaries were attached — the identity here is
original work, developed from the charter plus current category research (Braintrust, LangSmith,
Langfuse, Arize Phoenix, W&B Weave, Laminar, Latitude, Confident AI, Inspect/UK AISI, and public
benchmark surfaces including SWE-bench Verified leaderboards and Terminal-Bench). Full strategy,
territories, naming research and validation plan: **`guidelines/brand-package.md`**.

---

## Content fundamentals

**Voice.** Editorial, exact, unhurried — a serious technical periodical, not a lab report and not a
sales page. Colophon states things; it does not sell them.

**Person.** Second person for the builder: *"you lock the method."* Third person for the artifact:
*"this report records 1,500 expected executions."* Never "we" in product copy; "we" only in company
writing.

**Casing.** Sentence case everywhere — buttons, headings, nav, table headers. The one exception is
the small-caps label style: 11px, uppercase, 0.08em tracking, used for field labels and eyebrows.
Never title case.

**Emoji:** none, anywhere. **Exclamation marks:** none. **Em dashes:** sparingly.

**Numbers carry their denominator and their date.** Not "62% pass rate" but
`312 / 500 tasks · run 2026-08-04`. A bare percentage is a bug.

**Limitations are set in body type.** Caveats never shrink into grey fine print. If a guarantee has
a boundary, the boundary is written out in the same size as the result:

> Colophon observed these executions and recorded their outputs. That establishes what was run and
> what came back. It does not establish that the evaluators reached correct verdicts.

**Machine values are set in mono.** IDs, digests, counts, slugs, timestamps, CLI, JSON. If a human
didn't write it, it's IBM Plex Mono.

**Words we prefer:** method locked before execution · expected executions · returned · accounted for ·
observed by Colophon · self-reported · evaluator-attested · conflicted · retained disagreement ·
incomplete · unverifiable · recomputable · inspectable · clone · rerun · challenge.

**Words we avoid:** verified · certified · proven · independent · trusted · official · audited ·
guaranteed · best · state-of-the-art · objective · ground truth · seal. The full policy — including
the narrow cases where *verified*, *independent* and *official* are permitted — is in
`guidelines/brand-package.md` §9.

**Agent-facing verbs are fixed and never synonymised.** `import_tasks` · `configure_entrant` ·
`set_assurance` · `preview_run` · `request_quote` · `lock_method` · `launch_run` · `cancel_run` ·
`inspect_result` · `draft_report` · `publish_report` · `cite_report` · `clone_benchmark` ·
`rerun_benchmark` · `challenge_report`. The string in the button is the string in the API and in the
audit log.

**Examples in the wild**

| Surface | Copy |
|---|---|
| Hero | Compare agents on the same work. |
| Hero sub | Run two or more configurations against one task set, choose how the results are judged, and publish a claim whose method, evidence and failures anyone can inspect. |
| Report headline | Three harness loadouts on the same 500 tasks |
| Method lock | Method locked before execution — no change after this point is reflected in the official result. |
| Cancel warning | Cancelling does not remove expected executions from the accounting. They are published as incomplete. |
| Badge | `colophon | 71.1% · 500 tasks | Observed` |
| Footer | Built on Jinn. |

---

## Visual foundations

**The metaphor is ink on paper, not glass on black.** A Colophon surface looks like a well-set
technical publication: hairline rules instead of drop shadows, generous margins, real footnotes,
marginalia, a printer's mark, and an imprint that states how the work was made.

**Colour.** Warm paper `#f7f4ed` and warm ink `#14120e` — never blue-grey. One accent: printer's
vermilion `#c7402a`, used for the mark, the reference entrant, live state and rules of emphasis, and
**never** to mean "good." Indigo carries links and attestation; moss and ochre carry *met* and
*conflicted*. Dark theme (`[data-theme="dark"]`) inverts to warm black `#14120e`, not blue-black.

**Verdicts are six states, not two:** met, unmet, conflicted, attested, incomplete, unverifiable. The
palette has to be able to say "we don't know."

**Evidence texture.** Fill encodes *how* a result was obtained, independent of what it was: solid =
observed by the platform · 45° hatch = attested by a party · vertical rule = evaluators conflicted ·
dot screen = missing / not returned. Texture is always redundant with colour and with a word, so
nothing is lost in greyscale or to a colour-blind reader. Overlay opacity is capped at 0.28.

**Type.** Newsreader (display and reading body) · Public Sans (UI and labels) · IBM Plex Mono (data).
15px UI base, 17px reading body, 1.26 scale from 11px to 78px. Display sizes track −0.02em; labels
track +0.08em.

**Spacing.** 8px baseline, steps 2 → 160px. Three page widths: 1240px app shell, 880px report, 720px
prose. Reading measure 66ch.

**Backgrounds.** Flat paper. No photography, no gradients, no meshes, no textures behind content, no
full-bleed imagery, no illustration. The only tonal shift is the one dark section on the marketing
page (the agent-native block) and the sunken `--surface-inset` used for code and quiet panels. If a
surface needs interest, it comes from rules, numerals and typography.

**Borders and rules.** Edges are rules. 1px `--rule` for containers and table rows; 2px `--rule-heavy`
above section heads; 3px `--rule-accent` for live state and the top edge of a report card. Rules do
the work shadows do elsewhere.

**Shadows.** Effectively absent. `--shadow-raise` is available but unused in the kits; `--shadow-pop`
and `--shadow-overlay` exist only for dialogs and menus that float above the page. A card has no
shadow — it has a rule.

**Corner radii.** 0–4px, and mostly 2–3px. Nothing is pill-shaped except the switch. Cards are ruled
boxes, not floating rounded panels.

**Cards** are: `--surface-card` (`#fffdf8`) + 1px `--rule` + 4px radius + no shadow. A header band
ruled off from the body, an optional footnote band ruled off at the bottom. Report cards add a 3px
vermilion top slab.

**Transparency and blur.** Almost never. `--overlay-scrim` at 44% and a 2px blur exist for modal
scrims only. No frosted glass, no translucent panels, no backdrop filters in content.

**Animation.** `cubic-bezier(.2,0,0,1)`, 120–260ms, colour and position only. Live runs **tick** on a
one-second cadence — counters increment and bars extend by real amounts. Nothing pulses, glows,
bounces, shimmers or breathes. `prefers-reduced-motion` zeroes every duration.

**Hover.** Text links shift from indigo to vermilion and the underline goes to `currentColor`.
Buttons and rows shift background one step (transparent → `--surface-inset`, or ink → ink-800). No
lift, no scale, no shadow bloom.

**Press.** Colour deepens one step. No shrink, no transform. `--inset-press` is available for
controls that need to read as physically depressed.

**Focus.** 2px `--focus-ring` (indigo) at 2px offset, on everything interactive. Deliberately a
different hue from every verdict colour.

**Inverted surfaces — one rule.** `--paper` and the other semantic tokens flip under
`[data-theme="dark"]`; `--ink-*` and `--vermilion-*` do not. So anything painted on a *fixed* ink or
vermilion ground must use `--ink-50`, never `--paper` — otherwise it goes dark-on-dark in dark theme.
This applies to the primary and accent buttons, the ink `Tag`, the switch knob, the badge's source
field and the site's dark block. The asterism mark is the one exception: on ink it stays
`--vermilion-500`, which is stable across themes and reads as the brand's ink stamp.

**Data visualization.** Bars and rules only. Accounting bars are denominated by *expected*
executions, so missing work occupies real width. Ranking bars use vermilion for the reference entrant
and neutral ink for the rest — position and label carry the ranking, not hue. No pie charts, no area
fills, no gradients, no 3D, no sparkline decoration.

**Imagery.** There is none, by design. If product imagery is ever needed, it is a screenshot of a real
report on paper-coloured ground, warm and unfiltered — no dark-mode hero shots, no perspective mockups.

---

## Iconography

**No icon set was supplied with this engagement.** The system uses **Lucide** (v0.446) from CDN as a
documented substitution — 1.6px stroke, rounded caps, geometric, which matches the drawn-with-a-pen
feel of the rest of the identity better than filled or duotone sets.
**⚠️ Flagged: replace with the product's own set if one exists.**

- **Usage:** `<script src="https://unpkg.com/lucide@0.446.0/dist/umd/lucide.min.js">`, then the
  `Icon` wrapper in each UI kit (`ui_kits/*/Icon.jsx`) renders `<i data-lucide="name">`.
- **Sizes:** 15px in dense UI, 16px default, 20px in nav. Stroke stays 1.6 at every size.
- **Colour:** always `currentColor`. Icons never carry their own colour.
- **Icons in use:** `layers`, `list-checks`, `git-compare`, `scale`, `activity`, `file-text`,
  `terminal`, `receipt`, `copy`.

**Forbidden glyphs.** No checkmark used as a verdict or a trust signal. No shield. No seal, rosette,
ribbon or crest. No sparkles, orbs, robot heads, chat bubbles or circuit traces. A verdict is a
`VerdictChip` with a word in it — never a tick.

**Emoji:** never. **Unicode as iconography:** only the asterism ⁂ (as the brand mark, redrawn in
`assets/mark.svg`) and the footnote markers `†` `‡` `§`, which are typographic, not decorative.

**Brand assets** (`assets/`): `mark.svg` (solid asterism), `mark-open.svg` (outline),
`mark-rule.svg` (divider ornament), `logo-lockup.svg` (mark + wordmark), `favicon.svg`. The mark is
an original redrawing of a standard typographic glyph, not a reconstruction of anyone's logo.

---

## Jinn attribution

The one approved string is **"Built on Jinn."** It appears in the report imprint, the site footer's
legal line, the infrastructure/about page, docs and verification pages — always at the smallest type
size on the page, in `--text-faint`, with no mark and no lockup. It never appears in the product name,
hero, primary navigation, workflow terminology, report headlines, social cards, badges or campaign
language. No co-branded identity, and no Jinn colour, type, motif or vocabulary anywhere in this
system. Full policy: `guidelines/brand-package.md` §14.

---

## Index

| Path | What it is |
|---|---|
| `styles.css` | Entry point — imports everything in `tokens/`. Consumers link this one file. |
| `tokens/fonts.css` | `@font-face` for Newsreader, Public Sans, IBM Plex Mono (Google Fonts CDN) |
| `tokens/colors.css` | Ink & paper, printer's inks, semantic text/surface/rule, six verdict states, dark theme |
| `tokens/typography.css` | Families, 1.26 scale, leading, weights, tracking, measures, named type roles |
| `tokens/space.css` | 8px baseline scale, gutters, page widths |
| `tokens/surfaces.css` | Radii, border weights, shadows, card recipe, overlay scrim |
| `tokens/evidence.css` | Evidence textures and accounting-bar geometry |
| `tokens/motion.css` | Easing, durations, the one-second live tick, reduced-motion override |
| `tokens/base.css` | Element resets, link and focus styling, selection |
| `guidelines/brand-package.md` | **The full 18-section brand package** — strategy, territories, naming, verbal and visual identity, claim system, Jinn policy, risks, validation |
| `guidelines/*.card.html` | 17 foundation specimen cards (Brand, Colors, Type, Spacing, Evidence) |
| `assets/` | Asterism mark, open mark, rule ornament, lockup, favicon |
| `thumbnail.html` | Project tile |
| `SKILL.md` | Agent Skills entry point |

**Components** (`components/`, namespace `window.ColophonDesignSystem_55942c`)

| Group | Components |
|---|---|
| `core/` | `Button` `IconButton` `Input` `Select` `Checkbox` `Switch` `Tag` |
| `editorial/` | `Card` `SectionHead` `Footnote` `Callout` `Imprint` |
| `evidence/` | `VerdictChip` `AssuranceMeter` `CompletenessBar` `DisagreementStrip` |
| `claim/` | `ClaimBadge` `ReportCard` `CiteBlock` `MethodLock` |

Each has a sibling `.d.ts` (props contract) and `.prompt.md` (what & when, usage, variants).

*Intentional additions:* no source defined a component inventory, so this is an authored set. The
four `evidence/` and four `claim/` components are not generic primitives — they exist because the
brand's core job is representing uncertainty and making claims portable, and no standard set covers
that. `Imprint` and `Footnote` likewise encode editorial rules that would otherwise be re-invented
per page.

**UI kits** (`ui_kits/`)

| Kit | Surfaces |
|---|---|
| `report/` | **The flagship.** Published benchmark report: masthead, method lock, comparison table, method, assurance & accounting, disagreement, cite/embed/clone/rerun, imprint |
| `app/` | Benchmark workspace: sidebar, step rail, entrant comparison table, assurance selector, live run with agent activity log, publish screen with generated claim assets |
| `site/` | Marketing site: hero with live proof elements, four pillars, agent-native block, published-report index, footer |
