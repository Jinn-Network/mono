# Audience profile — who counts as a Jinn recruit

Companion to the `discover-twitter-recruits` skill. Defines the *conversion bar* in operational terms — skill-internal calibration only. The canonical priority audience is in [`GROWTH.md`](../../../../GROWTH.md) §3 (current target cluster) + §4 (GTM phase clusters). This file does not redefine the priority list; it documents what the *operational filter* checks for.

## §1. The conversion question

For every candidate, the only question that matters is:

> Would this person plausibly run a Jinn client, build adjacent tooling, contribute code or research, or boost the protocol with intellectual reach?

The four conversion roles are named in GROWTH §5 (the loop's *Engage* function): operator, contributor, evaluator, amplifier. If a candidate maps to none of those for the current GROWTH §3 target cluster, they are out — no matter how thesis-perfect their wording is. Discovery is an audience filter, not a language filter.

## §2. Audience derivation

Read GROWTH §3 (target cluster) and §4 (GTM phases) at the start of every discovery session. Sample primarily against §3; sample §4 phases lighter, only when the active sprint or a refine-skill output flags a phase-transition check.

The historical priority lists (Priority 1 / Priority 2 / Tier 3) that lived in this file have been retired. They are now derived from GROWTH §3 (currently named: AI builders — eval-harness builders, agent-observability tooling, RL-environment authors, shadow-eval practitioners, public-benchmark contributors). When the target cluster changes, this file does not need to change — the derivation re-targets automatically.

**Amplifiers** remain a separate output bucket regardless of target cluster (their conversion shape is a quote-tweet or essay reference, not a node — conflating them with operators distorts the recruitment lattice).

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
| Founders / core team / official research voices of jinn-adjacent or competing protocols | Won't convert. Their skin-in-the-game is in their own protocol; the recruitment ask ("come participate in Jinn") is structurally wrong for them. Engaging them on methodology reads as competitive intel-gathering, not peer dialogue. The recruitment frame is *participants on someone else's protocol*, not protocols themselves. Example failures (2026-05-05 round): `@agentropy` (founder of a Bittensor-inheriting protocol on Base), `@apo11o` (Allora chief scientist / research lead). Operative distinction — recruit *miners on SN50*, not the SN50 owner; recruit *Numerai signal submitters*, not Richard Craib; recruit *Allora workers/reputers*, not the Allora team. |
| Third-party analytics / curator / education orgs over a protocol's ecosystem | Sit *over* a protocol with their own positioning stake — covering Jinn would conflict with their existing alignment. Audience-shape, not participant-shape. May become Tier 3 amplifiers later if the thesis is already public, but not first-round recruits. Example failures (2026-05-05): `@SubnetAIQ` (subnet-quality dashboard over all 128 Bittensor subnets), `@manifoldlabs` (Bittensor research/education group with Targon/BrainPlay ecosystem stake). Distinction from real Tier 3 amplifiers (`@VictorVL_EN`): true amplifiers have no protocol-team stake, just curate. Org-with-ecosystem-stake is a different shape. |

## §4. Defining traits of real recruits

When in doubt between an in-cluster candidate (current GROWTH §3 target) and an out-of-scope one, the following signals bias toward "real":

- Ships a verifiable artefact: linked repo, dashboard, dataset, paper, deployed product.
- Engages with the right orbit: replies to and gets replies from `@autonolas`, `@numinous_ai`, `@opentensor`, a16z crypto on agent infrastructure threads, Numerai accounts.
- Uses real project names, not generic crypto-AI vocabulary. "OLAS Mech", "Numinous SN6", "ERC-8004 registry", "tau2 benchmark" — concrete. "AI agent economy", "the agentic future", "Web3 AI" — generic.
- Posts a *pattern* over time: weekly methodology updates, a steady stream of work-in-progress, replies to others' substance. Not a single thesis-perfect tweet that surfaced in search.
- Geographic signals from `bird about <handle>` are coherent with their stated context. Not a hard rule, but accounts with mismatched country signals + promotional register + token tickers are nearly always shill rings.

## §5. The two-tier rule

The skill's main list contains *only* candidates inside the current GROWTH §3 target cluster (and adjacent §4 phase clusters when the active sprint allows) that pass the profile-check. Amplifiers go in a separate tier. Out-of-scope candidates that were considered but rejected go in the SKIPPED section (audit trail, not output). The boundary between tiers must be sharp — collapsing them is the most common failure mode of this kind of discovery work.

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
