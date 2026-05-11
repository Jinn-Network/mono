# BRAND

**What this doc is / is not.** This is the canonical voice and posture canon for Jinn — the rules that govern any user-facing artifact (UI, slides, docs, marketing copy) and the line between what is protocol-immutable and what is forkable. It is not the lexicon (term definitions live in `GLOSSARY.md`) and it is not the visual-token spec (`DESIGN.md` and `DESIGN.json` remain the visual sidecar until they are folded in via their own spec). The long-form design system at `docs/design/jinn-design-system/` becomes this doc's appendix.

## Voice

### Lead from structure, not from fear

The problem Jinn solves is a structural gap: the internet has no native productive economy. Block space is abundant, AI is increasingly capable, the connective tissue between them is missing. That is the headline.

The problem is *not* a threat. We do not lead with "centralised AI will capture all value", "platforms will own the next economy", "value will accrue to a small number of actors". That framing is available to anyone who wants it; the market can supply it. Supplying it is not our job.

Why this matters:

- The most durable theses in this space — Bitcoin, Ethereum — led from what becomes possible, not from what we must defend against. The antagonist appeared once, clinically, and disappeared. The construction did the rhetorical work.
- A reader who arrives at the threat through their own reasoning holds it more firmly than a reader who is handed it. Inferred conviction outlasts injected urgency.
- Defensive framing inverts the architecture of the argument: Jinn becomes "the alternative to the bad thing" rather than "the architecture that compounds fastest". The first is reactive. The second is structurally dominant.
- Fear-bait reads as marketing register. Operators we want to recruit pattern-match it instantly and discount the rest.

How to apply:

- Open from the gap and the construction. The state of the field is supporting evidence, not headline.
- If the antagonist appears, it appears once, in a flat tone, then disappears.
- Reject reviewer notes that ask for "more urgency", "the existential problem", or "frame X as a threat" — those are good instincts in someone else's piece, not ours. Decline politely, hold the line.
- The four structural properties (less extractive, more neutral, more composable, more efficient) carry the argument. They are the positive claim. They do not need a villain.

The market makes its own threats. We make the case for what is structurally inevitable.

### Stake-claiming and white space

Most positioning vocabulary in the decentralised-AI cluster is already owned. Leading from a phrase a competitor has earned reads as imitation, regardless of intent.

Crowded territory — avoid leading copy with these phrases:

- **"Decentralised network for AI"** — Bittensor.
- **"Decentralised training"** / **"Open Stack for Self-Improving Agents"** — Prime Intellect.
- **"Self-improving"** / **"collective intelligence"** / **"intelligence layer"** — Allora.
- **"Co-own AI"** / **"unified network for off-chain services"** — Olas.
- **"AI agent launchpad"** / **"tokenise agents"** — Virtuals.
- **"Encrypted data"** / tournament framing — Numerai.

White space Jinn plants in:

- **Economy** as the category noun (not marketplace, stack, layer, or network).
- **Solve** as the verb (not train, predict, aggregate, or orchestrate).
- **Outcomes** as the noun for what gets solved.
- The **network-runs-without-us** property — only Jinn can credibly stress-test this; the six competitors above are all VC-backed companies, multisigs, or hedge funds.

How to apply: when writing positioning copy, run a thirty-second collision check against the territory above. If the lead phrase belongs to a competitor, refactor before publishing. If a desired claim sits in their territory, demote it — subordinate clause, second sentence, or move it to a downstream artifact entirely. The competitive landscape moves; revisit this list on the same cadence as canonical-doc reviews.

## Canonical introduction

The smallest user-facing artifact Jinn ships is its self-description in ≤160 characters. Treat the canonical line as a Schelling point in the same sense the loop and the lexicon are: forkable surfaces converge on it because the cost of fragmentation outweighs the upside of a personal variant, not because anyone is enforcing it. The line is canon, not protocol — proposing a replacement is a normal canonical-doc PR, not a structural change.

> The decentralised economy where agents learn to solve. As your agent learns, the network learns.

This line travels everywhere Jinn is introduced in compressed form: X bio, link previews, conference chyrons, slide footers, the first sentence of cold outreach, the lede of explainer posts. Operators producing user-facing surfaces should converge on it; if a community-driven variant gains real adoption, propose it as a replacement here rather than ship a quiet alternative.

Longer canonical formats (one-sentence, one-paragraph, one-page) are deferred to a future spec — likely paired with `THESIS.md` once that doc is populated.

## Posture: headless and co-created

This is brand posture, not decoration. Jinn is a *headless brand* in the sense Other Internet defined in [*Headless Brands*](https://otherinter.net/research/headless-brands/) — read the essay before doing brand work.

A headless brand has three properties:

1. **No centralized managerial control.** No entity (not the founding team, not the DAO, not a brand council) owns the brand presence. Participants drive the narrative.
2. **Immutable protocol foundations.** A small set of core design decisions is fixed so that narratives can layer on top without fragmenting. Bitcoin's 21M supply and proof-of-work are the canonical example.
3. **User-stakeholder incentives.** Users are financial stakeholders and workers in the network; they stand to gain from adoption, so they spread their own interpretations of the brand.

Coherence in a headless brand comes from *consensus across competing narratives on shared protocol primitives*, not from enforcement of a single story. Bitcoin holders disagree about whether it's electronic cash, a store of value, or a financial asset — and the brand is stronger for the disagreement, not weaker, because they all commit to the same chain.

### Protocol — immutable; don't fork without a proposal

- **The loop.** Creation → Execution → Evaluation → Knowledge. This is the whole shape of Jinn.
- **The lexicon.** *summon, bind, vow, vessel, wish, smoke, seer, wane, release, scrying, ether, bound, broken.* These are the coordination vocabulary. Definitions live in `GLOSSARY.md` (the canonical dictionary). New terms are proposals, not unilateral additions.
- **The content non-negotiables.** No emoji. No decorative gradients. No uncoined vow-language without proposal. Plain speech on money, safety, and legal consent.
- **The role structure.** Creator, restorer, evaluator. What they do, not how they're depicted.

These are the things that, if they drift, make the brand something else. Treat them like a protocol change: propose, discuss, ratify.

### Narrative — remix freely; document the change

- **Palette.** The current blue/gold system was chosen in a single session; it is explicitly a starting point. Other operators may skin their surfaces in other directions.
- **Type.** Instrument Serif + JetBrains Mono is one committed pairing. Another valid Jinn surface could use different type entirely, as long as it maintains the serif-for-feeling / mono-for-doing split (or justifies a departure).
- **Sigils and wordmark.** The "vessel" mark is an invented starting point. Alt sigils, community-drawn marks, per-surface identities are all welcome.
- **Surface treatment.** Card anatomy, layout grids, radii, density — all narrative, all forkable per surface.
- **Iconography beyond the five sigils.** Lucide is a substitution; anyone can commit to a different icon family.

A bound vow dashboard run by one operator and a wish-creation surface run by another can look radically different and both still be Jinn, provided they share the loop and the words.

### What "headless" does *not* mean

- It does **not** mean "anything goes." Without the protocol primitives, the brand has no center of gravity and cannot coordinate attention — that's the failure mode the essay warns about (Bitcoin Cash-style fragmentation).
- It does **not** mean the starting-point system is disposable. Defaults have gravity. The visuals in `DESIGN.md` will shape early perception of Jinn whether or not they're labeled as "one narrative." Ship defaults you would be proud to have become canonical.
- It does **not** absolve the design system of rigor. Headless brands still require high craft at the protocol layer — the *harder* the primitives are to change, the more carefully they must be designed.

## Operational rule

**Keep the words, loosen the visuals.**

- Words are protocol. Changes to the lexicon, the loop, or the non-negotiables are proposals with a paper trail.
- Visuals are narrative. Palette swaps, sigil variants, type substitutions, layout shifts — just document what you changed and why, and ship it.

## When in doubt

If you can't tell whether a change is protocol or narrative, ask: *would Jinn still be Jinn without this?* If yes, it's narrative — you can fork. If no, it's protocol — write a proposal.

## Visual sidecar

Visual canon currently lives in:

- [`DESIGN.md`](DESIGN.md) — visual spec in [Google Stitch format](https://stitch.withgoogle.com/docs/design-md/format/): YAML frontmatter with colours, typography, radii, spacing, and component tokens; six-section prose body.
- [`DESIGN.json`](DESIGN.json) — sidecar extending the frontmatter with tonal ramps, canonical OKLCH, shadow/motion/breakpoint tokens, and drop-in component HTML/CSS.
- [`docs/design/jinn-design-system/`](docs/design/jinn-design-system/) — long-form design system; appendix to this doc.

Folding `DESIGN.md` and `DESIGN.json` into the canonical `BRAND.md` is a separate spec; until then, treat the above as authoritative for visual tokens but read `BRAND.md` first to know what is protocol and what is narrative.

## Appendix: orphan claims

Strong claims that the canonical introduction deliberately does not carry. Each has an assigned home so the bio does not sprawl and the claim does not go homeless.

| Claim | Lives in |
|---|---|
| "Solve any problem" — the ambition | `THESIS.md` (when populated) and pinned X post |
| "Open data" — system property of the loop | Long-form pitch / explainer thread / docs |
| "Bonded / staked economy" — operator lens | Operator-recruitment copy, runbook intro |
| "Go alone fast, go together far" — culture line | Manifesto opener, closing line of thesis posts |

Bio names what Jinn is. Properties live one click deeper.
