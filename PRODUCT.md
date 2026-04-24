# Product

## Register

brand

> PRODUCT.md carries one default. Jinn's default is `brand` because the primary surface is its narrative — essays, slides, sigils, wordmark, BD conversation — with product UI (explorer, daemon, dashboards) acting as reference implementations of that narrative. The register can be overridden per task: `$impeccable` commands working inside `client/`, `ui_kits/explorer/`, or any dashboard surface should treat the work as `product`.

## Users

Jinn's participants are **technical enough to run an agent harness**. Five overlapping roles, roughly ordered by onboarding depth:

- **Creators** — teams and individuals who summon outcomes into the network. Come from engineering, research, product, or BD. Write specifications, pay fees, evaluate results.
- **Node operators (vessels)** — engineers running the daemon against a Safe-held stake. Care about uptime, rewards economics, recovery from failure modes. Long sessions against terminals and dashboards.
- **Seers (evaluators)** — validators who verify restoration claims. Technical enough to read evidence; economically motivated to be honest. Care about evidence schemas and challenge mechanisms.
- **Protocol engineers** — smart-contract and client developers building on or integrating with Jinn. Care about ABIs, addresses, deployment artifacts, and ERC-8004 / ERC-8128 specifications.
- **Community contributors** — designers, BD, writers, node operators who extend the brand surface itself. The "headless" stakeholders who fork and document variants of the system.

**Context of use:** dark screens, long sessions, attention split with editors and terminals. Readers of essays are the same people later staking 500 OLAS — the marketing surface and the settings pane are visited by one person. Writing for one, writing for the other, but never assume either audience wants to be sold to.

## Product Purpose

Jinn is a decentralised network for training agentic fulfilment of outcomes. It defines a loop — Creation → Execution → Evaluation → Knowledge — where outcomes are published with fees, vessels attempt fulfilment, seers verify, and verified artifacts (outcome, trajectory, score triplets) accumulate as ERC-8004 knowledge.

Phase 0 (complete) proved the loop on OLAS + Base. Phase 1a (complete) deployed the JINN token, DAO, and distribution contracts on testnet. Phase 1b (in progress) is hardening — anti-farming decay, challenge mechanism, ve-JINN gauge voting, evidence schema. Phase 2 is mainnet launch. Phase 3 is autonomy: USDC revenue exceeds JINN emissions and governance is fully ve-JINN.

**Success looks like** a self-sustaining protocol where the economic engine (outcome fees) funds the training loop without emissions subsidy, and where the brand narrative has enough gravity that community operators ship their own variants on the shared protocol primitives.

## Brand Personality

**Three words: mystical, brutalist, headless.**

The voice is poetic but precise. The words do the magic (*summon, bind, vow, vessel, wish, smoke, seer, wane*) so the visuals stay stark — terminal-schematic, engineering-diagram, hairline-bordered. The contrast between evocative copy and austere UI is the brand.

**Emotional goals:**

- **Technical confidence.** Readers should believe the people behind this can ship contracts and daemons. The way to convey it is evidence (addresses, ABIs, deployment logs), not adjectives.
- **Reverence without preciousness.** The mystical vocabulary earns trust by being consistent, not by being florid. A jinn doesn't exclaim.
- **Clarity on consequential actions.** The moment money moves, safety is at stake, or legal consent is asked for, the mysticism steps aside. Plain speech wins there.

**Voice discipline:**

- Second person (`you`) with the reader. First person plural (`we`) only in marketing, rarely.
- Sentence case for titles, headlines, buttons (`Bind vessel`).
- ALL CAPS MONO for status labels only — eyebrows, chips, column headers.
- Tabular numerals with units. Commas for thousands.
- No exclamation points. Ellipses only for in-progress states (`Binding…`) or poetic trail-off.
- Em dashes, liberally — they match the serif's rhythm.
- Never emoji.

## Anti-references

Jinn is explicitly **not** any of the following. Each is named so that when a render drifts toward it, you can call it out precisely.

- **"Crypto → neon on black."** The default DeFi reflex — saturated neon green or purple accents on pure black, frosted-glass trading panels, animated candlestick heros. Most L2 front pages. Jinn is night-blue on moon-bone, not neon on black.
- **Purple-gradient SaaS chrome.** 2020-era Stripe / Linear's early palette / Vercel's former gradient era. Dashboards that look like they were poured out of the same design-token generator. Jinn has no decorative gradients.
- **Glassmorphic blur stacks.** VisionOS, iOS 15+ Control Centre, Glow-heavy dashboard redesigns. `backdrop-filter: blur()` as decoration. Jinn uses hairlines instead.
- **Emoji-as-decoration landing pages.** Slack / Notion / most Y-Combinator landing pages. 🚀 and 🎉 as bullet markers. Jinn uses no emoji anywhere. Ever.
- **Bouncy, springy motion.** iOS bounce-scrolls, `ease-out-back`, `ease-elastic`, any spring. Jinn is linear; things appear.
- **Material-filled iconography.** Google products generally. Filled, rounded glyphs at mid-contrast. Jinn's icons are mono-line, stroke 1.5, square terminals, currentColor.
- **Stock photography of people.** Unsplash startup tropes — smiling engineers, diverse team at whiteboard. Jinn's imagery (when used at all) is abstract, astronomical, architectural, cartographic, or documentary-technical.
- **Sickly SaaS green, fire-engine red, mustard yellow.** Status color clichés. Jinn's status palette is muted: `vow-green` (cool teal), `wane` (deep lamplight), `break-red` (cool iron), `seer-violet` (night-watcher purple).

**Category-reflex check:** if a render could be guessed as "crypto → neon on black" from the category alone, it has failed the brand.

## Design Principles

Five strategic lines. These override individual visual tokens if they conflict — the tokens serve the principles.

1. **Keep the words, loosen the visuals.** The protocol invariants are the lexicon (*summon, bind, vow, vessel, wish, smoke, seer, wane*) and the non-negotiables (no emoji, no gradient, no sans, plain speech on money/safety/legal). Everything else — palette, sigils, type pairing, surface treatment — is narrative, and narrative is allowed to fork per operator, per surface, per community. Multiple visual dialects can coexist on the same protocol.

2. **The words do the magic; the visuals stay stark.** Evocative copy is the mysticism budget. The visual system balances it by being schematic and engineering-diagram precise. If the copy leans poetic, the UI leans plain. If both lean mystical at once, the brand curdles into LARP.

3. **Clarity beats mood when consequences are real.** Drop the vow-language the moment money moves, safety is on the line, or legal consent is being requested. `"Bind 500 tokens"` is fine in marketing; a transaction confirmation reads `"Stake 500 OLAS to become a seer. Funds will be locked for 90 days."` The brand survives plain speech; it does not survive a mis-worded staking confirmation.

4. **Participants are co-authors, not users.** Anyone with a stake in the network — tokens, reputation, a deployed vessel — has standing to propose brand or protocol direction. Contribution to the brand is a first-class form of participation, not marketing overhead. The rule when you change something: **document what you changed**. That is the vow.

5. **Protocol before narrative.** Two change classes, treated differently. A change to the loop, the lexicon, or a non-negotiable is a **protocol change** — it needs marking as a proposal, not slipped in as a design tweak. A change to a colour, a sigil, a surface treatment is a **narrative change** — just ship it and document it. Knowing which is which is the skill.

## Accessibility & Inclusion

Target **WCAG 2.1 AA** across product surfaces, with AAA for critical labels (focus indicators, error copy, affordance names).

- **Contrast.** Body text and interactive surfaces are ≥ 4.5:1 on `#0c1628`; large text and primary accents clear AAA at ≥ 7:1. Verified in the existing palette.
- **Motion.** Respect `prefers-reduced-motion: reduce`. The 600ms `.wish` slow-fade becomes instant; all other transitions fall back to `0ms linear`. No choreographed sequences.
- **Color is never the sole signal.** Status always pairs colour with a label (chip text, icon, or sibling caption). Charts and diagrams label data directly, not only by hue.
- **Keyboard.** Every interactive element is focusable. Focus outlines are 2px solid `--accent` with 2px offset, visible in both themes, never removed without replacement. Logical tab order matches visual order.
- **Touch targets.** ≥ 44 × 44 px on any touch surface (the mobile drawer, mobile nav, mobile forms).
- **Dark-first means contrast-first.** Light mode exists but must meet the same standards. No surface is "acceptable in dark only" and ported to light later.
- **Copy at reading grade.** Vow-language is acceptable in marketing and long-form. Product chrome (errors, confirmations, legal) reads plain — aim for grade 8–10, not grade 16.
- **Sigils at small sizes.** Below 16px, fall back to the solid-dot variant of each sigil. Stroke-based marks become unreadable at that scale.
