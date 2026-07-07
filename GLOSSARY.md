# GLOSSARY

**What this doc is / is not.** This is the canonical dictionary of Jinn-specific terms — *vessel, vow, summon, smoke, seer, wane*, and the rest of the lexicon. It is not a place to debate naming or capture brand voice (see `BRAND.md`); definitions here are load-bearing and may not be redefined elsewhere in the repo. Historical and deprecated names are included so renames stay searchable and unambiguous — see "Deprecated and historical names" at the bottom. Changes go through CODEOWNERS review with a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions); see [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md).

<!-- Sections expand as terms ratify; see GitHub Discussions for upstream proposals. -->

## Tokens and economic primitives

Jinn is **tokenless and OLAS-native** (DR-2026-06-30 — [`spec/2026-06-30-tokenless-olas-native.md`](spec/2026-06-30-tokenless-olas-native.md)). There is no JINN token; OLAS is the unit of both stake and reward. The retired JINN-token terms are kept for searchability under "Deprecated and historical names".

| Term | Usage notes |
|------|-------------|
| Jinn | The protocol and the network. Title case in prose. Jinn has no token of its own. |
| OLAS | The permanent unit of both stake and reward. Operators earn OLAS for verified, completed-loop work. Lives on Base: `0x54330d28ca3357F294334BDC454a032e7f353416`. |
| veOLAS | Vote-escrowed OLAS. Jinn directs its veOLAS to its staking nominee to fund the emissions reward stream. Replaces veJINN's emissions-direction job. |
| curating agent | The on-chain identity recorded when an operator stakes via the stOLAS distributor; keeps the curating-agent share (≈85%) of staking rewards. How a zero-capital operator is credited. |
| stOLAS distributor | The OLAS `ExternalStakingDistributor` that lends the staking bond from a depositor pool and records the staker as curating agent — Jinn's zero-capital onboarding rail. |
| staking emissions | Reward stream (1): OLAS distributed to operators whose activity counter clears the staking liveness bar. The bootstrap subsidy. |
| Curator funding | Reward stream (2): the marketplace delivery fee a Curator escrows per task, which settles to the operator on delivery. The demand-funded economy. |
| loop-completion gate | The rule that a solver's activity counter increments on *any* verdict (loop completed), never on Pass. Reward is gated on loop completion, not on quality. |

### Insider allocation

Any distribution mechanism that places tokens in the hands of parties before useful network activity has occurred: pre-mint, founder bag, team unlock, early-investor cliff, advisor allocation, treasury allocation that is not itself activity-gated.

Jinn has none of these. Naming this explicitly is load-bearing in pitch and growth material — it is the single sharpest structural differentiator.

## Roles

### Curator

The role that launches and configures a SolverNet — sets its objective, the evaluation criteria attempts are graded against, and funds its tasks (the Curator-funding reward stream). The demand side; does not stake or earn from staking. In the tokenless-OLAS model (DR-2026-06-30) the Curator no longer stakes a token to direct emissions — emissions direction is Jinn's veOLAS nomination, not a per-Curator lock.

Replaces the earlier names "Launcher" and "Trainer" — *Trainer* inherited the LLM-training frame; *Launcher* named the act (launching a SolverNet) rather than the role. (`spec/2026-06-30-tokenless-olas-native.md` calls this role the *launcher*.)

## Network primitives and process

### Solution

What is stored in the corpus and matched against a submitted task. A solution can be any of these forms, or any combination of them:

- a skill (callable function)
- a plugin
- a prompt set
- a harness configuration
- a full environment (e.g. a Docker image)

A SolverNet's Curator specifies which solution formats their SolverNet accepts.

In external writing, never leave "solution" as an abstract noun without at least one concrete example.

### Attempt

One run of an agent (a solver) at a task: the task itself, the loadout (model, harness, plugins/skills), the full conversation and per-step tool payloads, and the outcome. The **attempt** is the unit the network accumulates — contributed to the corpus (scrubbed, consented, published to IPFS, anchored on-chain) and counted as on-chain activity when a solver claims and delivers.

"Attempt" is neutral on success: the corpus holds failed attempts as well as passing ones, and the network learns from both. It is the user-facing noun across the explorer and the CLI.

Replaces the informal "task trace" and "contribution" (as a noun — *contribute* and *contributor* remain the verb and the role). The signed container an attempt is published in is still an *envelope* (below); the reusable artifact extracted from attempts is a *Solution* (above).

### Corpus

The network's accumulating collection of attempts — a public good of scrubbed, consented traces, and the substrate the network searches and learns over. Named consistently across the explorer's Corpus surface and the CLI's corpus commands.

### Envelope

The signed container format an attempt is published in — a manifest plus the scrubbed trace artifact, held on IPFS and anchored on-chain. An **internal/technical** term: it appears in the indexer schema (`capture_envelope_meta`), the SDK, and the wire format, but is not shown on user surfaces. Users see *attempts*, not envelopes.

### Learning

In Jinn, the network learns by doing — running attempts, scoring them, accumulating the corpus, and improving the search across it. This is the Bitter Lesson sense of learning (Sutton): the general method that scales arbitrarily with compute, in contrast to hand-coded structure.

Used in place of "training" in external contexts. Builders hear "training" as gradient descent on a model; "learning" carries the same conceptual weight without the LLM collapse.

## Deprecated and historical names

Included so renames remain searchable and unambiguous. Do not use the deprecated forms in new writing.

| Deprecated | Current | Notes |
|------------|---------|-------|
| task trace | attempt | Informal name for a published attempt; use "attempt" on user surfaces. |
| contribution (noun) | attempt | The published unit is an *attempt*. *Contribute* / *contributor* remain valid for the act and the operator role. |
| capture envelope (user-facing) | attempt | *Envelope* stays as the internal container term; the user-facing noun is *attempt*. |
| Trainer | Curator | Renamed to drop the LLM-training frame. |
| Launcher | Curator | Earlier name that described the act (launching a SolverNet) rather than the role. |
| training | learning | In external contexts (pitch decks, marketing, growth, external docs). "Training" remains acceptable in internal / technical writing where the LLM frame is not at risk. See BRAND.md "Replace 'training' in external contexts". |
| JINN (token) | OLAS | The native protocol token was dropped by DR-2026-06-30 (tokenless, OLAS-native); OLAS is now the unit of stake and reward. Historical references survive in phase-history docs and contract names (e.g. `JinnRouter`). Do not describe a JINN token in new writing. |
| veJINN | veOLAS nomination | Vote-escrowed JINN directed JINN emissions across staking contracts; superseded — Jinn now directs veOLAS to its OLAS staking nominee. |
| JinnDistributor | — | The JINN reward-distribution contract; deleted by DR-2026-06-30. Reward now flows via OLAS staking emissions + the stOLAS distributor. No successor term. |
