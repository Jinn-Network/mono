# Use Jinn tasks to show tangible benefit on an open-source codebase

> **Status (2026-06-30): superseded by DR-2026-06-30 (tokenless, OLAS-native).** Jinn drops the native token and the sovereign chain; OLAS is the economic layer. For the current direction read `spec/2026-06-30-tokenless-olas-native.md` and `log/decisions/2026-06-30-tokenless-olas-native-pivot.md`.

- **Version:** 0.1 (Discussion draft)
- **Date:** 2026-06-08
- **Author:** oaksprout (drafted with Opus)
- **Status:** Open for discussion
- **Related:**
  - GitHub Milestone #2 — "Solvers improving on SWE-rebench v2" (the synthetic-task sibling of the milestone proposed here)
  - [`spec/2026-05-28-harness-as-policy-learning-architecture.md`](2026-05-28-harness-as-policy-learning-architecture.md) — the learning roadmap (held-out exam, L0–L5 ladder)
  - `SPEC.md` §Tokenomics (lines 11–13, 49–53) — value is the bonded economy; corpus is a public good
  - [`spec/2026-04-23-default-learning-restorer-design.md`](2026-04-23-default-learning-restorer-design.md) — the only specced "buyer" of corpus knowledge
  - EPIC [#601](https://github.com/Jinn-Network/mono/issues/601) — Demonstrate solver learning

## Summary

Use Jinn's own learning loop on **real, merged tasks from this repo** to produce a reproducible result: a cheap base model running a learned harness solves real coding tasks **at materially lower cost** than the same model without the harness — demonstrated on an open-source codebase (this one).

The framing throughout: **learning is the product; the corpus is fuel, not freight.** We are not building a data marketplace. We are showing that the learning loop produces tangible, verifiable benefit on real work.

## Why this, why now

We can already show learning on **synthetic** tasks — Milestone #2, SWE-rebench. The gap is that synthetic tasks are not *live human demand*; they were curated for benchmarkability, not surfaced because someone bore a cost to get an outcome.

The claim a non-tribal reader values in sixty seconds is **cost**:

> A cheap base model running Jinn's learned harness matches or beats an expensive frontier model on real coding work, for a fraction of the price.

For operators and builders, that is the recruitment claim: *here is the engine working on real work — come help build it.*

## What "real" means

**Demand that cost something to express.** The day-1, fully-Legible proxy is a task that **got merged** — reviewed, accepted, shipped, provable on GitHub. The highest-value slice is a task that fixed a **live, on-chain-verifiable failure** (an event that stopped firing, now fires).

## The flow (no new harvesting product required)

The flow already exists: our own engineering pipeline. Each merged PR is a real task with a built-in check.

- **Source:** merged `Jinn-Network/mono` PRs → each reduced to `(task, clean repro, deterministic check)`.
- **"Merged" is selection, not grade.** It decides which tasks enter the slate; it is never the result, because you cannot re-run "did a human merge it."
- **Two checks:** green tests (cheap, high volume) and live-problem-resolved (the on-chain-verifiable headline).
- **Two task flows, two jobs:** SWE-rebench (volume → statistical power, Milestone #2) and our own merged PRs (real → the headline). Synthetic for power, our repo for the claim.

Privacy is a non-issue here: the tasks are already public and merged. Harvesting from *other people's* private sessions — the broader idea — is deferred until there is a proven payoff to justify asking for the data, and is then an opt-in, reduce-to-clean-repro flow, not a "blast it on chain" flow.

## The result is a deterministic check

With / without the learned harness, **same base model, same task** → measured delta on cost, speed, reliability. Measured on the **held-out exam** ([#818](https://github.com/Jinn-Network/mono/issues/818) `jinn eval`), before vs after a training period, with a confidence interval (per DR-2026-05-28). Holding task and model fixed and toggling only the harness isolates the harness's contribution.

## Proposed milestone

**Name:** Jinn improves Jinn — learned harness beats baseline on real merged tasks

**Type:** outcome-gated (matches Milestones #1–#3; not time-gated).

**Gate:** On a held-out, versioned slate of real tasks reduced from merged `Jinn-Network/mono` PRs (each = `task + clean repro + deterministic check`), the **learned harness checkpoint** solves the slate at **≥30% lower inference cost per solved task** than the **same base model running a frozen baseline harness**, at **no worse pass rate** — measured via `jinn eval` ([#818](https://github.com/Jinn-Network/mono/issues/818)) before/after a training period, reported with a confidence interval. The slate includes **≥1 live-failure task whose fix is verifiable on-chain**, as the headline demonstration.

**Baseline:** same base model, frozen baseline harness (isolates the harness). Optionally also report against a named frontier model for the cost story.

**Measurement / check:** held-out exam ([#818](https://github.com/Jinn-Network/mono/issues/818)); held-out slate primitive ([#817](https://github.com/Jinn-Network/mono/issues/817)); a `client/scripts/check-milestone-N.ts` progress script (mirrors `check-milestone-2.ts`).

**Depends on:** #818, #817. Parent epic [#601](https://github.com/Jinn-Network/mono/issues/601). Sibling of Milestone #2 (same result on synthetic tasks).

**Dials to set:** the 30% cost threshold; the slate size; whether the headline metric is cost or pass-rate.

## How this sits with the tokenomics

Already consistent with canonical posture — **no canonical-doc change required:**

- **SPEC.md:11-13** — "JINN does not capture value by enclosing access to [the corpus]. JINN captures value by attaching to the scarce coordination surfaces around it: the live, bonded economy."
- **SPEC.md:53** — "No marketplace cuts, settlement fees, or x402 take. Transactions stay forkable."
- The harness-as-policy spec already frames the cross-operator corpus as a **data-density / GTM** question (§1.1, §7), not a product.

This proposal operationalises that posture; it does not amend it.

## The one open strategic question

Is the data marketplace a **product** (indexed tasks+solutions sold to model builders; "Jinn is the first buyer"), or **plumbing** for the learning loop?

Canonical docs currently say plumbing: the only specced "buyer" of corpus knowledge is the **learning restorer** ([`spec/2026-04-23-default-learning-restorer-design.md`](2026-04-23-default-learning-restorer-design.md)) — an agent paying peer operators for trajectories to improve its own work. There is no protocol-as-buyer mechanism anywhere.

This proposal assumes **plumbing** and builds the learning result. Choosing **marketplace-as-product** would amend SPEC.md's Tokenomics frame and warrants its own `canonical-changes` Discussion and a ratified decision record before any build. Worth resolving explicitly rather than carrying two readings forward.

## What this does not yet prove

- **Transfer (the product claim):** that the learned harness helps on a codebase it has never seen. Out of scope — the *next* milestone. Until then the claim is codebase-specific, not "works on any repo."
- **Survivorship:** merged-only tasks lean toward the already-doable (harness-as-policy spec §7). Slate curation ([#817](https://github.com/Jinn-Network/mono/issues/817)) must resist drift toward easy instances.
- **Volume on the own-repo flow** is bounded by our merge rate; SWE-rebench supplies the statistical power.
