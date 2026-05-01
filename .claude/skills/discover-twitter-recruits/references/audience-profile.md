# Audience profile — who counts as a Jinn recruit

Companion to the `discover-twitter-recruits` skill. Defines the conversion bar in operational terms. Read once at the start of a discovery session.

## §1. The conversion question

For every candidate, the only question that matters is:

> Would this person plausibly run a Jinn solver, build adjacent tooling, contribute code or research, or boost the protocol with intellectual reach?

If the answer to all four is no, the candidate is out — no matter how thesis-perfect their wording is. Discovery is an audience filter, not a language filter.

## §2. Priority audiences

These are the audiences `growth/CLAUDE.md` names. In priority order:

### §2.1 — Priority 1 (operators / builders / contributors)

- **Ex-Bittensor subnet operators.** Validators or miners who have run on TAO subnets, especially in agent-shaped subnets (Numinous SN6, Score SN44, BitMind SN34). Already know the operator economics, already capable of running staked services.
- **OLAS Polystrat / Pearl operators.** Anyone who has run Pearl, Trader Quickstart, or built on the Mech Marketplace. Direct functional overlap with the Jinn client; lowest-friction operational conversion.
- **ERC-8004 registry builders.** People who index, score, or visualise the on-chain agent registry — `@yieldfreaks` (AHM), `@8004_scan`, comparable accounts. Adjacent infra, would naturally extend coverage to a new outcome-attested registry.
- **Agent-verification / observability / evaluation tooling builders.** People shipping registries, dashboards, evaluation harnesses, or scoring pipelines. `@ta_eis_eauton` / Silverarrow (autoharness) is the canonical example. Functional adjacency to Jinn's evaluator role.

### §2.2 — Priority 2 (prediction-side technical audiences)

- **Prediction-tool builders.** People building forecasting platforms, market-maker bots, or aggregation systems over markets like Polymarket / Kalshi.
- **Numerai-orbit forecasters.** Already trained on the paradigm "labelled history → unlabelled future → paid by accuracy." Jinn's Prediction SolverNet is that pattern generalised.
- **MiroFish-orbit quants.** Adjacent technical audience; substantial overlap with Numerai people in practice.
- **Polymarket / Kalshi bot operators.** Independents who already run prediction stacks against live oracles. Direct candidate operators for the Prediction SolverNet.

### §2.3 — Tier 3 (amplifiers — separate output bucket)

People with primitives-not-platforms instincts who *repost* and *curate* rather than build. Will not run a node. Will broadcast to the right audience if a primitive lands well in their hands.

Output amplifiers in a separate section of the skill's response, never collapsed into the main list. Their conversion shape is different (a quote-tweet or essay reference, not a solver instance) and conflating the two distorts the recruitment lattice.

## §3. Out-of-scope audiences

These look thesis-aligned in language but do not convert. Each is a real failure case from past discovery rounds — naming them prevents reverting to the same shapes.

| Audience | Why excluded |
|---|---|
| Enterprise AI consultants (CIO-register posts on agent infrastructure) | Won't run nodes; audience is corporate buyers, not protocol contributors. Example failure: `@JohnCarbrey`. |
| JS/TS framework engineers (state-machine / orchestration framework builders) | Wrong stack; their work composes around chat-protocol abstractions, not on-chain economic loops. Example failure: `@DavidKPiano`. |
| Agent-memory / agent-skills product founders | Selling, not buying. Their incentive is to position their product as the missing piece, not to integrate into a verification protocol. Example failure: `@tokenrip_`. |
| Generic crypto-AI shillers | Token-pumping register, hashtag spam, no real artefact. Caught by language-pattern matching; rejected on profile-check. |
| VC analysts / "AI x crypto" thread-writers | Won't operate, won't build. May reach an audience that includes operators, but the audience routes through them only when the thesis is already public — i.e. once recruitment is mature, not as a recruitment channel. |
| Bots dressed as builders | OpenClaw agents (🦞 sign-off), one-shot zinger accounts, shill rings posting identical-shape content. Always rejected. See `search-strategy.md` §3 for detection. |
| Real-product-with-token-pump | An account ships a thesis-aligned product (registry, oracle, eval tool) but the surrounding feed is `$TICKER` shilling, gated-by-token-holding social engineering, or pump-style RTs. The product does not outweigh the §4 patterns. The @gingersamurai lesson generalises: profile-check the *whole feed*, not the on-thesis tweet. Example failure: `@helixaxyz` (real ERC-8004 reputation oracle + heavy `$CRED` shilling). |
| Same content posted multiple days from one account (cron / scheduled repost pattern) | YELLOW — likely a content-agent or scheduling tool, not a shill ring. Not a hard kill. Profile-check for a human operator behind the project (look for tags / co-builders / hackathon submissions). Re-route recommendation to the human if found. Distinct from shill-ring (identical content across many accounts on the same day = HARD kill). Example: `@Maxibtc2009` (cron content-agent for Observer Protocol; re-routed to `@boydcohen`). |

## §4. Defining traits of real recruits

When in doubt between a Priority 1/2 candidate and an out-of-scope one, the following signals bias toward "real":

- Ships a verifiable artefact: linked repo, dashboard, dataset, paper, deployed product.
- Engages with the right orbit: replies to and gets replies from `@autonolas`, `@numinous_ai`, `@opentensor`, a16z crypto on agent infrastructure threads, Numerai accounts.
- Uses real project names, not generic crypto-AI vocabulary. "OLAS Mech", "Numinous SN6", "ERC-8004 registry", "tau2 benchmark" — concrete. "AI agent economy", "the agentic future", "Web3 AI" — generic.
- Posts a *pattern* over time: weekly methodology updates, a steady stream of work-in-progress, replies to others' substance. Not a single thesis-perfect tweet that surfaced in search.
- Geographic signals from `bird about <handle>` are coherent with their stated context. Not a hard rule, but accounts with mismatched country signals + promotional register + token tickers are nearly always shill rings.

## §5. The two-tier rule

The skill's main list contains *only* Priority 1 and Priority 2 accounts that pass the profile-check. Amplifiers go in a separate tier. Out-of-scope candidates that were considered but rejected go in the SKIPPED section (audit trail, not output). The boundary between tiers must be sharp — collapsing them is the most common failure mode of this kind of discovery work.

## §6. The canonical first-touch bridge

All successful first-touch outreach in this skill's calibration history follows the same shape:

> Methodology question that engages a specific gap the candidate has already named, asking them to extend their thinking one step further toward the Jinn frame, without naming Jinn.

Sub-patterns by cluster (full detail in `cluster-model/references/bridge-shapes.md`):

- **AI cluster:** flip the eval economics — task distribution from external creators with stake.
- **Crypto cluster:** agents-as-participants in mech-design they already understand.
- **AI × crypto cluster:** name the layer they ship as scaffolding for the outer loop with stake.
- **Bitcoin-maxi-adjacent:** trust-score adversarial mechanism design (stake / reputation / external rater).

The question must not be answerable from the candidate's own README, post, or pinned thread. Proves you actually engaged with the work.

Calibration evidence (2026-04-29 to 2026-05-01):
- `@yieldfreaks` — peer-recognition reply within 5 hours.
- `@ta_eis_eauton` (Silverarrow) — warm reply, cross-linked to `@Vtrivedy10`.
- `@TreebeardAI`, `@Vtrivedy10`, `@boydcohen` — outreach in flight; pending outcomes will refine the sub-patterns.

Do not skip this section when proposing a first-touch reply. If the proposed question fails the not-answerable-from-README test, rework it.
