# SPEC

**What this doc is / is not.** This is the canonical specification of the Jinn protocol — the loop, roles, on-chain primitives, and current phase boundaries. It is not a changelog of design exploration, an implementation plan, or a place for ratified material to be silently restated; ratified material is consolidated here. Changes go through CODEOWNERS review with a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions); see [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md).

<!-- Other sections to be populated as they ratify; see GitHub Discussions for upstream proposals. -->

## Economics

> Provenance: DR-2026-06-30 (tokenless, OLAS-native) — [`log/decisions/2026-06-30-tokenless-olas-native-pivot.md`](log/decisions/2026-06-30-tokenless-olas-native-pivot.md) and [`spec/2026-06-30-tokenless-olas-native.md`](spec/2026-06-30-tokenless-olas-native.md). Supersedes the JINN-token tokenomics (GitHub Discussion [#69](https://github.com/Jinn-Network/mono/discussions/69)).

### Frame

Jinn is **tokenless and OLAS-native**. There is no JINN token and no sovereign chain. **OLAS** (on Base) is the permanent unit of both stake and reward; Jinn inherits OLAS's economic and security base rather than bootstrapping its own. Operators earn OLAS for verified, completed-loop work in the launcher-funded loop Create → Solve → Evaluate → Learn.

The knowledge substrate Jinn produces is a public good — readable, mirrorable, inspectable. Jinn does not capture value by enclosing access to it. Knowledge is **recorded now** — each `(task, solution, verdict)` tuple anchored on-chain — and **priced later**; the future knowledge-pricing layer is where the get-better incentive lives.

### The reward gate

Reward is for *completed-loop activity*, not for passing. A solver's OLAS staking-activity counter increments once their solution receives *any* verdict — a **loop-completion gate**, not a quality gate. An evaluator's counter increments on delivering a verdict. Pass/Fail is recorded (knowledge + reputation) but **never gates OLAS** — so a wrong or malicious Fail can never deny a solver their earnings, and no challenge mechanism is required at v0.

### Two reward streams

1. **OLAS staking emissions** — the bootstrap subsidy. Free to Jinn: it directs its veOLAS to its staking nominee, and the staking contract distributes OLAS to operators whose activity counter clears the liveness bar.
2. **Curator funding** — the real, demand-funded economy. The Curator (the *launcher*, in `spec/2026-06-30-tokenless-olas-native.md`) escrows a marketplace delivery fee per task; on delivery it settles to the operator. As Curators fund real goals this stream — not the subsidy — sustains the network.

Gating the *free* stream on "has a verdict" is done by delaying the counter increment in the recorder until a verdict lands — no escrow, no clawback. The *funded* stream is inherently pay-on-delivery and stays ungated: it is the delivery fee, not a quality reward.

### Zero-capital onboarding

Operators stake through the stOLAS `ExternalStakingDistributor`: the bond is *lent* from the depositor pool, the operator is recorded as the **curating agent** and keeps the curating-agent share (≈85% of staking rewards per the live proxy config), funding only ~$15–30 of ETH for gas. No OLAS is locked.

### Roles

**Curator.** Launches and configures a SolverNet — an objective, the evaluation criteria attempts are graded against, and how many attempts — and funds its tasks (the Curator-funding stream). The demand side; does not stake or earn from staking. Its self-interest is the built-in quality control: it stops funding SolverNets that produce junk.

**Operator.** Runs a node that solves and/or evaluates whatever SolverNet it has joined, and earns OLAS from both streams. Role is per-task, not per-operator. The user-facing surface an operator interacts with to run a node is canonical in [`operator/OPERATOR-APP-SPEC.md`](operator/OPERATOR-APP-SPEC.md).

**Evaluator.** Judges a solution against the Curator-defined goal and records a verdict; an operator plays this role per-task. A solver cannot evaluate its own solution (self-eval prevention, default-on, testnet-relaxable).

**App.** Consumes the knowledge substrate. For now it reads freely — the corpus is a public good, recorded now and priced later; there is no chain-level access gate.

### On-chain enforceable vs. economically held

**On-chain enforceable.** Distinct identities; self-eval prevention; reward flows only to identities that completed real loops; task / evidence / verdict are publicly recorded. The only Jinn-custom code is **one activity checker + one thin recorder** — everything else (Mech Marketplace, OLAS service / mech / Safe, the stOLAS distributor, the staking proxy, veOLAS nomination) is OLAS-native and unmodified.

**Economically held.** Quality, for now, is carried by Curator self-interest (they stop funding junk) and reputation, not by contract. Storage and serving are operator self-interest. Fork resistance is coordination, not code: a fork inherits zero substrate, zero verdict lineage, zero funded Curators.

### Honest limits (Legibility)

- **Independence.** The chain proves distinct addresses, not distinct parties; Sybil is possible.
- **Correctness.** Nothing on-chain proves a result is right; this rests on honest evaluators.
- **Supplemental, not a wage.** ≈$29/mo per staking slot; the 100-slot program caps at ≈$3,500/mo network (OLAS ≈$0.028, 2026-06-29). Depth must come from the Curator-funded stream.
- **Legibility downgrade** vs the prior token design: you can prove "a loop completed," not "this was verified correct and rewarded accordingly." Disclose this in any external framing.

### Deferred

- **Quality / get-better incentive** → knowledge-pricing, a future design.
- **Evaluator-quality controls** (quorum, consensus-outlier) → optional at v0, re-addable in the checker / recorder.
- **Per-SolverNet staking contracts** → a lever pulled only near the 100-slot cap or when a SolverNet needs its own reward rate.
