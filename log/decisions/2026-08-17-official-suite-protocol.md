# DR-2026-08-17-b — Official suite protocol (Terminal-Bench 2.1)

- **Date:** 2026-08-17
- **Status:** **Accepted 2026-08-17.** Ratified by operator instruction to
  implement the Terminal-Bench 2.1 official-suite train (issue
  [#2739](https://github.com/Jinn-Network/mono/issues/2739)).
- **Owning docs:** the publication interoperability profile; Colophon
  self-serve; the benchmark-product GTM plan (copy); product-design pointer
  addendum.
- **Amends (at ratification):**
  [`docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md`](../../docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md)
  (TB 2.1 protocol object, two-axis comparability, Hub export as derived
  artifact, Direct-mode grain: one Job per arm);
  [`spec/2026-08-13-colophon-self-serve.md`](../../spec/2026-08-13-colophon-self-serve.md)
  §5.5;
  [`docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md`](../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md)
  §8.3;
  [`docs/superpowers/specs/2026-08-05-benchmark-product-design.md`](../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md)
  (pointer addendum only).
- **Supersedes in part:** [DR-2026-08-17](./2026-08-17-runtime-engine-direct-mode.md)
  decision 6 only (Harbor batching and Hub export are now scheduled for TB
  2.1). Decisions 1–5 and 7 stand. Historical Harbor job import remains
  refused.
- **Does not amend:** `GROWTH.md`.

## Context

Colophon can lock a Harbor selection and run one Terminal-Bench 2.0 task with
one trial. Wearing the Terminal-Bench 2.1 suite name on that cousin method is
the same overclaim as overlay-on-Inspect: legitimacy for an official suite is
that **their** method ran.

Terminal-Bench 2.1 as specified (dataset
`terminal-bench/terminal-bench-2-1` at the leaderboard content-hash pin,
≥5 trials per task, default timeouts and no resource overrides, ATIF
trajectories, Hub upload then `lb submit`) is the first named official
protocol Colophon will lock. Slices (1 task, 10 tasks, full) are how a
publisher runs cheaply. They do not defer batching or Hub export, and they
do not make a 1-task run a leaderboard row.

Hub export is a Harbor-shaped copy of a Colophon-accounted run so the
publisher can feed Terminal-Bench’s submit flow. The checkable claim of
record remains the Colophon/Jinn bundle.

## Decisions

1. **Named protocol is Terminal-Bench 2.1**, not 2.0. Dataset id
   `terminal-bench/terminal-bench-2-1`. Revision is the leaderboard pin in
   that suite’s `leaderboard/src/leaderboard/core/hub.py` (`DATASET_REF`),
   re-read and sealed at implementation. The existing TB 2.0 one-task path
   stays and cannot claim `terminal-bench-2.1`.

2. **Official trial settings.** Planned trials k ≥ 5 per selected task;
   `timeout_multiplier` unset or `1.0`; no agent or verifier timeout
   overrides; no resource overrides; ATIF required for Hub packaging.
   Harbor `retry.max_retries` is **3** for Terminal-Bench 2.1, matching
   maintainer `harbor-framework/terminal-bench-2-1` `configs/leaderboard.yaml`
   (`n_attempts: 5`, `retry.max_retries: 3`). Official `-k 5` is five locked
   scientific replicates (five TEP Submissions with `attempts.maxTotal = 1`).
   Each Harbor retry that starts work is that cell’s next Colophon dispatch
   (replacement), not a sixth replicate. TB 2.0 keeps `max_retries: 0`.
   `source_trial` (regrade) stays refused. Until retry starts were Colophon
   dispatches, Colophon locked `0` so Harbor could not hide salvage under one
   dispatch ([#2752](https://github.com/Jinn-Network/mono/issues/2752) closes
   that delta).

3. **Comparability is two-axis.** Report v2 gains no new required fields.
   A sealed product `SuiteProtocolSelection` binds through the existing Run
   extension `https://spec.jinn.network/extensions/benchmark-publication/v1`
   registration artifacts. The Colophon claim package surfaces:
   - `execution_conformance` — trial settings match the protocol for the
     selected tasks;
   - `coverage` — `one_task` | `ten_task` | `full` | `custom`;
   - `leaderboard_submit_ready` — `full` and `execution_conformance` and
     ≥5 trials on every dataset task accounted after collect as judged or
     Harbor-error 0, and ATIF bytes present on the retained Harbor job
     (not quote-time `atifRequired`). Quote/lock method bits never set this
     true.
   Named slice membership is the lexicographic first 1 / first 10 / all
   task names from the pinned snapshot, sealed at select. Custom picks are
   legal and cannot be `full` or `leaderboard_submit_ready`.
   When not `leaderboard_submit_ready`, Report `limitations[]` carries a
   canonical sentence. A 1-task × 5 run may be protocol-faithful execution
   and still not a TB 2.1 leaderboard row.

4. **One Harbor Job per arm** spanning that arm’s selected tasks × k planned
   trials. Two-arm Colophon comparison = two Harbor jobs. `n_concurrent_trials`
   may exceed 1 across cells, never two Attempts on one Submission. Job
   identity for this grain is Run + arm, not Submission. Each Trial binds
   1:1 to a pre-sealed cell **as it starts**. A Harbor in-job retry that
   starts work is a new Submission for the same cell, bound in the planned
   job. Replacements Harbor will not retry (excluded exceptions, or the
   planned job already finished) are filled by a tiny follow-up Harbor job
   (`n_attempts` = 1). Evidence is not merged. Hub export still copies the
   planned Run+arm job.

5. **Hub export is a derived artifact, not the claim of record.** From a
   `leaderboard_submit_ready` run, emit an uploadable Harbor job plus
   `harbor upload --public` (or equivalent) and `uv run lb submit`
   instructions. Named-slice protocol-faithful runs may retain or upload the
   job for inspection and must not be packaged as a leaderboard submission.
   Custom / unverifiable runs refuse suite-named Hub export. Copy must say
   community submissions are currently closed and that Colophon does not
   place the row. A foreign completed Hub job still cannot be imported as a
   synthesized TEP run.

6. **Aggregation.** TB accuracy is mean binary reward over trials (errors
   count as 0). Do not use `binary-instrument` majority-k. Use the registered
   method that averages all judged replicates per task (wilson@1 is
   acceptable). That is a parameter lock, not a new statistical invention.

7. **Harbor version.** PyPI’s latest stable Harbor line at ratification is
   `0.21.x` (0.21.0 plus 0.21.1.dev nightlies). TB 2.1’s README installs
   unpinned `harbor`. Keep `SUPPORTED_HARBOR_VERSION_RANGE = "0.21.x"`.
   An official TB 2.1 claim is refused if the byte-pinned executable is
   outside that range.

8. **Quote before full-suite lock.** Quote shows `tasks × arms × 5`, env pin,
   Harbor version, and the three comparability bits. A full-suite lock
   without that quote is refused. CI never downloads the full dataset.

9. **Out of this train.** Official SWE-bench Verified, Inspect-as-specified
   (and Inspect eval-set batching), npm `@colophon-claims` custody,
   historical Harbor import, and Colophon-as-leaderboard are follow-on
   issues, not this work.

## Consequences

- Direct-mode Harbor batching for TB 2.1 is scheduled (issues #2740–#2743).
  Inspect remains one execution per cell.
- GTM may describe TB 2.1 as a named protocol Colophon wraps. Inspect copy
  stays “select a supported Inspect task.”
- A cousin method on TB tasks still cannot wear the suite name.

## Alternatives rejected

- **One comparability bit.** A protocol-faithful 1-task run is not a
  leaderboard row; collapsing those facts would overclaim.
- **New required Report v2 fields.** Comparability is product-private plus
  existing `limitations[]`.
- **Five one-trial Harbor jobs as the official shape.** Hub static analysis
  requires k≥5 inside the uploaded job.
- **Wait for a live partner campaign before batching or Hub export.** Slices
  are how we run cheaply, not how we defer the train.

## Ratification

Ratified on 2026-08-17 by the operator’s instruction to implement the
attached TB 2.1 official-suite train. Changing who owns the campaign,
merging a Job into one Execution, synthesizing TEP for a foreign Hub job,
or wearing the suite name on a custom method requires a superseding record.
