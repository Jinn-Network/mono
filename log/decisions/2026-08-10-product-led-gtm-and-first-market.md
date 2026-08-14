# DR-2026-08-10 — Product-Led GTM and Default First Market

- **Date:** 2026-08-10
- **Status:** **Accepted 2026-08-14.** Decisions 2 and 3 were already operative through the
  charter and GTM plan §6. Decision 1 ratified when the GROWTH.md rewrite merged.
  (Drafted in-session at operator direction, Ritsu, 2026-08-10.)
- **Ratification note (2026-08-14).** Decision 1's stated path below was *"a linked GitHub
  Discussion and a CODEOWNERS-approved GROWTH.md PR."* **The Discussion step was waived by
  operator ruling (Ritsu, 2026-08-14)** — explicitly waived, not overlooked. The GROWTH.md
  PR merged without a linked Discussion and with the repository's canonical-doc check red,
  which is the honest record: the check correctly reported that no Discussion existed. This
  follows the precedent of the 2026-07-07 GROWTH.md rewrite, which was owner-authorised
  directly at Oak's instruction; both waivers are recorded in GROWTH.md's own footer rather
  than left implicit. The waiver covers the Discussion step only — it does not amend
  [`spec/2026-04-28-canonical-docs.md`](../../spec/2026-04-28-canonical-docs.md), which
  still governs every other canonical-doc change.
- **Owning docs:** [`GROWTH.md`](../../GROWTH.md) (strategy layer, decision 1); the
  standalone benchmark product charter v0.2 §5 (session-attached, not in-repo) and the
  program plan [`2026-08-05-standalone-benchmarking-product-program.md`](../../docs/superpowers/plans/2026-08-05-standalone-benchmarking-product-program.md) §3
  (decision 2); the GTM plan
  [`2026-08-10-benchmark-product-gtm-plan.md`](../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md) §6
  (decision 3)
- **Amends (at ratification):** GROWTH.md §1–§3 via its own canonical-process PR;
  program plan §3 via a dated addendum pointing back here; the charter amendment is
  recorded here directly (the charter is session-attached). The GTM plan §6 already
  carries decision 3's operational form.

## Context

Two live authority conflicts surround the benchmark product's go-to-market, flagged by
the GTM plan's authority note but resolved nowhere:

1. **GROWTH.md is canonical and harness-first.** Its 2026-07-07 strategy layer says
   "Jinn ships a harness, not a marketplace… using it is the funnel," with a
   Hermes/OpenClaw beachhead and a Telegram-first CTA. The benchmark product program
   (charter v0.2, program plan 2026-08-05, PR
   [#2541](https://github.com/Jinn-Network/mono/pull/2541)) has since built a
   standalone, separately branded Tier 4 product whose distribution object is the
   published benchmark report — a different surface, funnel, and audience than the
   harness. The GTM plan drafts around that product and cites "the explicit product
   decision that [GROWTH.md] is stale" — a decision that was never recorded. **This DR
   is that decision, made explicit and routed properly.**

2. **The first market is recorded as fixed.** Program plan §3: "First market: public
   comparative benchmarking for coding-agent/harness/skill/plugin/tool/loadout
   builders" — presented as a closed product decision (charter §5). The GTM plan
   instead proposes demand-led domain selection with coding as one hypothesis among
   five. Left unresolved, implementation builds toward coding-agent users while GTM
   samples other domains, and two authority documents contradict each other
   indefinitely.

A third problem is internal to the GTM plan: its original discovery gate required
*completed campaigns in three-plus materially different domains* before beachhead
selection. The shipped product runs what its intake and adapters support (SWE-bench-shaped
tasks, the prediction-forecast profile, the local venue, the shipped launcher and
evaluator set); completing a campaign in an unsupported domain means building
environments, task intake, and evaluator adapters first. As written, the gate mandated
that build spend before any demand signal. The operator ruled for commitment-gated
building instead: at this stage we do things that don't scale, but only when a customer
has committed — never speculatively.

## Decisions

1. **The GROWTH.md strategy layer becomes product-led; the engine is retained
   unchanged.** The benchmark product is the distribution surface: the funnel is
   trigger-based outbound to teams facing a live benchmark claim or decision, plus
   artifact-led distribution through published, verifiable reports. The harness-first
   strategy layer (§1–§3) retires to `growth/archive/` exactly as the pre-2026-07-07
   strategy did; it is not deleted history, and reviving it later goes through the loop
   like anything else. The engine (§4–§8: loadout, instrument, written predictions,
   one-knob discipline, Mayfield rungs) is deliberately retained — it survived the last
   strategy retirement and it survives this one. **Ratification path:** this decision
   ratifies only via the canonical-doc process — a linked GitHub Discussion and a
   CODEOWNERS-approved GROWTH.md PR. Until that PR merges, GROWTH.md remains
   authoritative as written. *(Superseded 2026-08-14: the Discussion step was waived by
   operator ruling — see the ratification note in the header. The clause is left as
   written rather than rewritten, so the record shows what the bar was and that it was
   deliberately lowered.)*

2. **Coding-agent builders become the default beachhead, not a fixed decision.** The
   charter §5 / program plan §3 first-market sentence is amended from a closed decision
   to: *default beachhead — coding-agent, harness, skill, plugin, tool, and loadout
   builders — revisable by the commitment-gated discovery process (decision 3).* Coding
   stays the default because it is what the shipped product runs today and where
   distribution already reaches. The default is displaced only when another domain
   outperforms it on the GTM plan's selection rubric across completed, committed
   campaigns — and a beachhead change is itself a product decision recorded by DR,
   never a silent GTM drift. At ratification the program plan §3 gains a dated addendum
   pointing here; the charter amendment is recorded by this paragraph.

3. **Domain discovery is commitment-gated and engine-instrumented.** Two tracks with
   deliberately different cost profiles:
   - **Interviews are sampled deliberately across the domain pools.** Breadth is
     enforced where it costs only conversations. This is the control against
     availability bias — without it, "demand-led" selection degrades into "selection by
     who we already knew."
   - **Campaigns — and any adapter, environment, or evaluator build they need — are
     triggered only by a committed customer.** The commitment bar is four-element, all
     required: the customer pays something (even a nominal design-partner fee — a
     costly signal, not revenue); supplies representative tasks or the material to
     derive them; names the specific decision or claim the report will support; and has
     a real deadline. Enthusiasm without all four does not trigger a build.
   - **Build discipline:** customer-triggered adapters, environments, and evaluator
     flows land as ordinary platform packages under the existing tier rules — never in
     the product tree. The product's consumption contract
     ([design §3](../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md))
     is not relaxed for urgency. Doing things that don't scale applies to the
     commercial motion, not to code boundaries.
   - **Measurement discipline:** discovery attempts run through the GROWTH.md engine —
     written prediction before each attempt, one variable at a time, at least two
     attempts before a verdict acts. The rubric is the scoring instrument; the engine
     keeps a five-domain × ten-criterion comparison at small N from selecting a
     beachhead on noise. Domain cost comparisons separate one-time platform build from
     recurring campaign cost, so the first non-coding domain is not artificially
     penalized against coding, where the build is already sunk.

   The operational form of this decision is the GTM plan §6 as rewritten
   ([`2026-08-10-benchmark-product-gtm-plan.md`](../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md)).

## Deliberately unresolved

The GROWTH.md revision text itself (drafted in the follow-up PR that the Discussion
gates, not here); whether any harness-side growth motion survives as a secondary lane
for the Hermes surface or archives entirely (a GROWTH.md-PR question); the GTM plan's
venue-honest claim-language edits (its §3–§4 pitch currently outruns the Phase 0–3
local-venue guarantees — a copy revision against design §7.1/§8.1, tracked as GTM-plan
follow-up, no decision needed here); pricing, hosting, and billing posture (explicitly
hypothesis-status in the GTM plan; hosting implies architecture the product design
defers).

## Provenance

In-session GTM plan review (Claude Fable 5 session, 2026-08-10): three tensions
identified against the repository record — the discovery gate as an engineering roadmap
in disguise, pitch language outrunning the shipped venue, and the two authority
conflicts above. Operator rulings (Ritsu, 2026-08-10): build for a customer when one
commits ("at the beginning we do things that don't scale"), never speculatively; retain
demand-led domain selection with coding as the revisable default; draft this DR and the
§6 gate rewrite.
