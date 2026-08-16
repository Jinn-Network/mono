# DR-2026-08-17 — Runtime engine direct mode

- **Date:** 2026-08-17
- **Status:** **Accepted 2026-08-17.** Ratified by operator instruction to
  implement the engine integration contract (issue
  [#2733](https://github.com/Jinn-Network/mono/issues/2733)).
- **Owning docs:** the publication interoperability profile (operational form);
  the benchmark-product GTM plan (copy); Colophon self-serve §5.5 and
  [`packages/benchmark-product/INSPECT-RUNTIME.md`](../../packages/benchmark-product/INSPECT-RUNTIME.md)
  (adapter grain).
- **Amends (at ratification):**
  [`docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md`](../../docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md)
  §8.3 (direct-mode job grain);
  [`docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md`](../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md)
  §3, §8.1, §8.3, §15 (engine-wrap copy);
  [`spec/2026-08-13-colophon-self-serve.md`](../../spec/2026-08-13-colophon-self-serve.md)
  §5.5;
  [`packages/benchmark-product/INSPECT-RUNTIME.md`](../../packages/benchmark-product/INSPECT-RUNTIME.md);
  [`docs/superpowers/specs/2026-08-05-benchmark-product-design.md`](../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md)
  (pointer addendum only).
- **Does not amend:** `GROWTH.md` (positioning derives from the GTM plan; no
  canonical-doc Discussion).

## Context

Colophon is a Jinn claim product: it locks a method, accounts every expected
cell, and publishes a bundle a third party can check without trusting the
producer. Harbor and Inspect entered later as **how a cell runs**.

Public GTM copy described a different product: overlay on an existing eval
stack (“bring an existing Inspect evaluation,” “without replacing your existing
eval stack”). Shipped adapters invoke the engine once per cell under a Jinn
campaign. That mismatch makes the integration story dishonest without changing
the records.

The publication profile already separates identity from grouping: a Harbor Job
is not a Jinn Run; a Harbor Trial normally correlates to one TEP Attempt. v1
did not ship the allowed direct-mode shape (one Job spanning the Run). This
record freezes the contract so copy and the next adapter cannot treat
one-process-per-cell as identity, and cannot sell campaign overlay that did
not ship.

## Decisions

1. **Jinn owns lock, cell enumeration, retry/replacement, accounting, and
   Report.** Harbor, Inspect, and native own the trial (task load, agent,
   score, native files). Colophon does not invent a second campaign; it uses
   `@jinn-network/benchmarking-run` as already stated in the product design
   §3. “The product implements no orchestration of its own” means no second
   Colophon driver. It does not mean the engine’s campaign is the claim.

2. **Evidence stays atomic.** One locked cell = one TEP Submission
   (`attempts.maxTotal = 1`, `maxConcurrent = 1`) = one Attempt = one
   Execution Evidence record. A Harbor Job or Inspect eval-set is correlation
   only.

3. **Direct mode may batch trials; it must not merge evidence.** One engine
   job spanning the Run is allowed when each trial is bound to its Submission
   **as it starts**, retries/epochs stay pinned off, and replacements are new
   Submissions (tiny follow-up jobs). The profile already said a Harbor Job
   may conveniently span the Run; v1 did not ship that grain.

4. **v1 grain is an adapter constraint, not identity.** Harbor’s sealed
   `nAttempts: 1` / one-Job-one-Trial manifest and Inspect’s one execution per
   cell with `epochs=1` remain correct for what is shipped. Do not copy “one
   process per cell” into the next adapter as doctrine.

5. **Do not batch Inspect in this work.** Inspect’s native object is often one
   `.eval` log per eval. Per-cell invocation is how each Execution gets
   exclusive native bytes. Batching Inspect waits on a specified per-sample
   artifact rule (or an honest shared-log Collection-input rule). Not
   scheduled.

6. **Do not schedule Harbor batching, Hub, or foreign-job import.** Reopen
   batching only if Harbor is a live GTM surface **and** native artifacts are
   already per-trial. Existing `recordHarborDispatchMapping` support for a
   shared job with multiple trials is correlation machinery, not a project
   kickoff.

7. **GTM must describe engine wrap, not campaign overlay.** Keep “not a
   replacement for Inspect, Braintrust, or the customer’s internal stack.”
   Drop language that sounds like “bring the eval you already ran” or “keep
   using their job as the unit.”

## Consequences

- Live GTM and product specs describe Colophon as locking a Jinn comparison
  and running each cell through a framework engine. They do not promise
  Inspect eval-set or Harbor Job identity, Hub upload, or import of a finished
  foreign job.
- Direct-mode batching remains a named, unscheduled follow-up. Implementing
  an observer that watches a multi-trial job is a later `feat`, not implied by
  this DR.
- Marketplace composition is unchanged: one scheduler, one trial per posted
  Submission.

## Alternatives rejected

- **Unwind the Jinn campaign and hang Colophon on Harbor/Inspect as a
  plugin.** That cannot keep venue-portable cell identity, the native/SWE-bench
  path, or later marketplace claims of the same Submissions.
- **Schedule Harbor or Inspect batching in this change.** Copy honesty does
  not require changing launchers. Inspect batching would smear exclusive
  `.eval` bytes until a sample-level artifact rule exists.
- **Keep overlay copy because “integrate, don’t replace” is attractive.** For
  a verifiable-claims product, the sentence has to match the shipped seam.

## Ratification

Ratified on 2026-08-17 by the operator’s instruction to implement the runtime
engine integration contract. Later adapter work may ship the allowed batched
direct-mode grain without a superseding DR if it preserves decisions 1–3.
Changing who owns the campaign, merging a job into one Execution, or
reintroducing overlay GTM requires a superseding decision record.
