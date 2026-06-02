# Claude Code prompts — Intro to Jinn SVGs

Four SVGs for `growth/docs/2026-04-24-intro-to-jinn.md`. Run each prompt in its own Claude Code session, from repo root.

Design system lives in a worktree: `.claude/worktrees/admiring-bardeen-8dcde0/docs/design/jinn-design-system/project/`. If that path is gone, substitute the current location.

---

## Prompt 0 — shared preamble (paste at the top of every prompt)

```
Before generating anything, read these files end-to-end:

1. .claude/worktrees/admiring-bardeen-8dcde0/docs/design/jinn-design-system/project/SKILL.md
2. .claude/worktrees/admiring-bardeen-8dcde0/docs/design/jinn-design-system/project/README.md
3. .claude/worktrees/admiring-bardeen-8dcde0/docs/design/jinn-design-system/project/colors_and_type.css
4. .claude/worktrees/admiring-bardeen-8dcde0/docs/design/jinn-design-system/project/foundations.css
5. .claude/worktrees/admiring-bardeen-8dcde0/docs/design/jinn-design-system/project/assets/mark-smoke.svg
6. .claude/worktrees/admiring-bardeen-8dcde0/docs/design/jinn-design-system/project/assets/mark-node.svg
7. .claude/worktrees/admiring-bardeen-8dcde0/docs/design/jinn-design-system/project/assets/mark-binding.svg
8. .claude/worktrees/admiring-bardeen-8dcde0/docs/design/jinn-design-system/project/assets/logo-sigil.svg

Non-negotiables:
- Dark-first. Background --blue-900 (#0c1628). Never black.
- Square corners only. Hairline 1px borders.
- No gradients as decoration. No emoji. No rounded corners except chips/pills (not used here).
- Two type voices only: JetBrains Mono for all labels/data, Instrument Serif italic for the single mystical pull-quote if any.
- Colour tokens: --blue-400 (#7aa7dc) sky accent, --gold-400 (#dcb866) lamplight hint, --vow-green (#6a9b8f), --wane (#b8802f), --break-red (#a85a5a), --seer-violet (#7a6db0), --slate-400 (#7d8ba3) smoke.
- Gold is a hint, not a fill. Use it for one element of emphasis, not everywhere.
- Aesthetic: protocol brutalism. Terminal-schematic, not illustrative. Think engineering diagram drawn by someone who reads hex.
- SVG must be self-contained (no external font imports embedded — use generic fallbacks in the font-family string). Include `<title>` and `<desc>` for accessibility.
- Include a viewBox. Width should scale to container. No hardcoded pixel width on the root.
- Output to `growth/docs/assets/` with the filename specified per prompt.
- Do not reference an image file; inline the SVG content.

If anything in the brief below conflicts with the design system, the design system wins. Flag the conflict and ask before compromising.
```

---

## Prompt 1 — hero: "Decentralised mining of outcome solutions"

```
[shared preamble above]

Create: growth/docs/assets/hero-mining.svg

Brief:
A single wide SVG (viewBox roughly 1600x720, portrait-free) that reads as the hero for an essay titled "Decentralised mining of outcome solutions." It sits directly under an h1 and above the first paragraph. Treat it as a schematic, not a scene.

What it must convey at a glance:
1. Many distinct, independent solvers (nodes) — not a single actor.
2. They are extracting verified knowledge from a substrate of incoming outcome requests.
3. The yield is a lattice of (outcome, trajectory, score) triplets — not arbitrary data, structured artifacts.

Composition suggestion (adapt if you find better):
- Left third: a faint grid or ribbon of incoming outcome requests, rendered as small mono-labelled rectangles drifting rightward. Labels like `outcome#0x4a…`, no lorem.
- Middle third: a constellation of ~9–12 solver nodes (reuse or adapt mark-node.svg as the motif). Hairline connections between some nodes — peer network, not hub-and-spoke. One or two have a faint gold halo to indicate active mining.
- Right third: a tidy vertical stack of triplet artifacts rendered as three-row cards — row labels `outcome / trajectory / score` in --fg-dim, values abstracted as short hex strings in --fg. Each card has a hairline border. A single gold tick on one row on one card — "verified" — not on all of them.
- A thin horizontal baseline running the full width, broken where the solvers sit (they interrupt the line, they're the work).
- Far bottom-right: eyebrow label `ERC-8004 ARTIFACT` in uppercase mono, --fg-muted, tracking-label.

Rules of restraint:
- No literal pickaxes, no literal mines, no coins. "Mining" is metaphor; the visual is signal extraction, not mineshafts.
- No human figures. No arrows with gradient tails. Arrows, if any, are single-pixel lines with a small triangle head.
- Motion is implied by spacing and repetition, not by speed lines.
- Maximum two accent colours in the frame: sky (--blue-400) for structure, gold (--gold-400) for the single "verified" mark. Everything else is --fg, --fg-muted, --fg-dim, --border.

Accessibility:
- <title>Decentralised mining of outcome solutions</title>
- <desc> that names the three visual zones (ingress, solver network, triplet yield) in one sentence each.

Deliverable: the SVG file, plus a one-paragraph note in your reply explaining any design-system conflicts you had to resolve.
```

---

## Prompt 2 — mechanism 1: Flywheel

```
[shared preamble above]

Create: growth/docs/assets/mechanism-flywheel.svg

Brief:
Diagram the verification flywheel. Sits under the heading "Flywheel" in the "How it works" section. Square-ish viewBox, roughly 1200x900.

What it must convey:
1. A closed loop: Create → Solve → Evaluate → (triplet emitted) → feeds back into Create.
2. Evaluator ≠ solver is structural. The solver node and evaluator node are visually distinct and sit on opposite sides of the loop, connected by the artifact, not by trust.
3. Every turn of the loop emits a (outcome, trajectory, score) triplet as an ERC-8004 artifact.

Composition:
- Four stations arranged on a square, not a circle (we don't do soft loops):
  - Top-left: `CREATOR` — posts outcome. Small stack of outcome rectangles under it.
  - Top-right: `SOLVER` — adapt mark-node.svg. Shows plan + evidence as two stacked rows.
  - Bottom-right: `EVALUATOR` — adapt mark-node.svg with a different internal mark (a single hairline horizontal line — "reads"). Visually different from solver. Label it `independent` in --fg-muted underneath.
  - Bottom-left: `TRIPLET` — a three-row artifact card labelled `outcome / trajectory / score`, adapting mark-binding.svg as a sigil beside it. Eyebrow label `ERC-8004`.
- Connecting lines between stations are hairline, with small triangle arrowheads. The path is Creator → Solver → Evaluator → Triplet → back to Creator.
- The Solver↔Evaluator edge is dashed, not solid. Annotate it `evaluator ≠ solver` in --fg-dim mono.
- A single gold hairline traces the full loop underneath — implies the compounding memory. Do not fill the loop interior.

Type:
- Station titles: JetBrains Mono, weight 500, uppercase, tracking-label.
- Sublabels: JetBrains Mono, weight 400, --fg-muted.
- No serif in this diagram. This is a schematic, not a quote.

Rules of restraint:
- No curved arrows. Use right angles.
- No numbering (1, 2, 3, 4) on the stations — the arrow direction is the ordering.
- The triplet card is the only element with three visible rows. Nothing else uses three-row layout.
- No icons for the concepts (no scales for evaluator, no pen for creator).

Accessibility:
- <title>Jinn verification flywheel</title>
- <desc> that walks the loop in one sentence and names the evaluator ≠ solver rule.
```

---

## Prompt 3 — mechanism 2: Training via DAO incentives

```
[shared preamble above]

Create: growth/docs/assets/mechanism-dao-training.svg

Brief:
Diagram how JINN-directed emissions steer the network's attention. Sits under "Training via DAO incentives." Square-ish viewBox, roughly 1200x900.

What it must convey:
1. JINN holders (multiple, distinct) direct emissions.
2. The protocol routes those emissions to one or more SolverNets.
3. The SolverNet receiving the most JINN-direction visibly "pulls more" solvers and accumulates a deeper corpus of verified triplets.

Composition:
- Top band: 5–7 small holder glyphs — each is a hairline square containing the letter `J` in mono (JINN balance). Holders are not identical: different sizes of square denote different balances. No names. No avatars.
- Between holders and SolverNets: a narrow middle band showing thin lines — emission direction — dropping from each holder toward a specific SolverNet. Line thickness in this band varies: more JINN pointed = thicker line (still hairline; use 1px vs 2px, not heavy strokes). The direction is vote-weight, not transfer.
- Middle band: three SolverNets arranged horizontally:
  - `PREDICTION` — receives the most lines. Below it, a denser cluster of solver nodes (reuse mark-node.svg small).
  - `SOLVERNET B` — placeholder name in --fg-dim (`coming`). Thinner cluster.
  - `SOLVERNET C` — same treatment. Thinner still.
  - The "winning" SolverNet has a hairline gold box around it. One element of gold, used once.
- Bottom band for the Prediction SolverNet only: a horizontal strip of stacked triplet cards (three-row, as defined in the hero) receding into --fg-dim — the growing corpus. The other two SolverNets show a single sparse triplet each, to make the asymmetry legible.
- Eyebrow labels top-left: `JINN HOLDERS` / middle: `EMISSIONS` / bottom: `VERIFIED TRIPLETS`.

Type and colour rules:
- Mono only. No serif.
- The only accent colour present is --blue-400 for structural emphasis (the emission band) and --gold-400 on exactly one element: the box around the winning SolverNet.
- Everything else is --fg / --fg-muted / --fg-dim / --border.

Rules of restraint:
- No charts, no bars, no percentages. The asymmetry is shown by density, not numbers.
- No "reward" graphics. No coin icons. JINN is a letter, not a token-face.
- Do not imply a specific vote outcome with coloured fills — only line density.

Accessibility:
- <title>JINN-directed emissions train SolverNets</title>
- <desc>: one sentence naming holders directing emissions, three SolverNets, and the asymmetric triplet accumulation.
```

---

## Prompt 4 — mechanism 3: Marketplace-agnostic ingress

```
[shared preamble above]

Create: growth/docs/assets/mechanism-ingress.svg

Brief:
Diagram how outcome requests reach Jinn from any upstream marketplace through a single normalised interface. Sits under "Marketplace-agnostic ingress." Wide viewBox, roughly 1600x720 to match the hero proportion.

What it must convey:
1. Multiple distinct upstream sources pour outcome requests in. None is privileged.
2. Jinn normalises them at a single ingress boundary.
3. Downstream of ingress, the solver network is one network — source of truth erased.

Composition:
- Left column: four labelled source columns, each a vertical stack of 3–5 outcome request rectangles sliding rightward. Labels, top-to-bottom in mono uppercase eyebrow style:
  - `ERC-8183`
  - `OLAS MECH`
  - `MPP`
  - `...` (literal ellipsis — "whatever comes next")
  Each source column has its own subtle differentiating mark (a single hairline glyph above the column) but uses the same palette. No colour-coding per source.
- A single vertical hairline wall running full height labelled `JINN INGRESS` — vertical mono text along its spine, tracking-label, --fg-muted. The wall is broken into four gates, one per source. Each gate is a simple notch (a tiny square cutout), not an arrow.
- Right of the wall: outcome requests continue rightward but their labels have been normalised — all now in the same schema, e.g. `outcome#<hex>`. Source origin is no longer visible. This is the point.
- Far right: the solver network (adapt mark-node.svg, small cluster) — one network. A hairline gold underline beneath the cluster marks it as the same solver set as the other two mechanism diagrams (visual continuity).
- Eyebrow labels: top-left `SOURCES`, centre-top (above wall) `INGRESS`, top-right `SOLVER NETWORK`.

Rules of restraint:
- No pipes, no funnels, no tubes. The wall-with-gates is the metaphor; do not replace it with plumbing.
- No logos for ERC-8183, OLAS, MPP. Wordmarks in mono only.
- Arrows between source columns and their gates are hairline right-angles, not curves.
- One use of gold (the underline on the solver cluster). No other gold in the frame.

Type and colour:
- Mono only. No serif.
- --blue-400 for the gate cutouts and the ingress wall outline.
- --fg-muted for source labels, --fg for normalised outcome labels.

Accessibility:
- <title>Marketplace-agnostic ingress to Jinn</title>
- <desc>: one sentence naming the sources, the single ingress boundary, and the unified solver network downstream.
```

---

## After all four are generated

Drop the four SVGs into `growth/docs/2026-04-24-intro-to-jinn.md` at these anchor points:

- Hero — directly under the h1, before "What Jinn is".
- Flywheel — directly under the `**Flywheel.**` bold label, before its paragraph.
- DAO training — same pattern under `**Training via DAO incentives.**`.
- Ingress — same pattern under `**Marketplace-agnostic ingress.**`.

Check them together at normal reading width. If any one of them overpowers the others, cut detail from the loudest until the four read as a set.
