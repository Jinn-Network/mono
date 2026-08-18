# DR-2026-08-18 — Inspect-as-specified official suite protocol

- **Date:** 2026-08-18
- **Status:** **Accepted 2026-08-18.** Ratified by operator instruction to
  implement the Inspect-as-specified official-suite train (issue
  [#2745](https://github.com/Jinn-Network/mono/issues/2745)).
- **Owning docs:** the publication interoperability profile; Colophon
  self-serve; the benchmark-product GTM plan (copy); product-design pointer
  addendum; Inspect runtime adapter notes.
- **Amends (at ratification):**
  [`docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md`](../../docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md)
  (§8 official suite protocol: second named protocol);
  [`spec/2026-08-13-colophon-self-serve.md`](../../spec/2026-08-13-colophon-self-serve.md)
  §5.5;
  [`docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md`](../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md)
  §8.3;
  [`docs/superpowers/specs/2026-08-05-benchmark-product-design.md`](../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md)
  (pointer addendum only);
  [`packages/benchmark-product/INSPECT-RUNTIME.md`](../../packages/benchmark-product/INSPECT-RUNTIME.md)
  (official suite section; first-slice grain unchanged).
- **Supersedes in part:** [DR-2026-08-17-b](./2026-08-17-official-suite-protocol.md)
  decision 9 only (Inspect-as-specified is no longer “out of this train”).
  Terminal-Bench 2.1 decisions stand. Inspect eval-set batching and Harbor Job
  overlay remain deferred.
- **Does not amend:** `GROWTH.md`.

## Context

Inspect is a framework (`inspect-ai` plus `inspect_evals`), not a named
leaderboard like Terminal-Bench 2.1. There is no Inspect Hub submit. Wearing
`inspect-as-specified` means **this sealed eval, run as specified**: the
operator picks the eval; Colophon locks pin, coverage, k, scorers, and
aggregation. It is not wearing GAIA, Cybench, or SWE-bench Verified. Claim of
record remains the Colophon bundle.

The existing cousin `colophon runtime inspect select` stays. It does not
attach a suite object and cannot become `leaderboardSubmitReady` under this
protocol.

## Decisions

1. **Named protocol is Inspect-as-specified**, family id
   `protocol: "inspect-as-specified"`. The operator selects any Inspect eval
   the runtime can resolve. Do not mint `inspect-evals/gaia` (or any other
   eval id) as a `SuiteProtocolSelection` discriminant this train. The sealed
   `datasetId` / task reference names which eval. Upstream boards (GAIA test
   upload, Inspect Hub / Flow) are out of Colophon.

2. **One Inspect Task is the eval-set for this train.** Catalog grain is
   **samples** (the thing one cell already executes). Coverage reuses product
   enums `one_task` | `ten_task` | `full` | `custom` to mean lexicographic
   first 1 / first 10 / all / custom **sample ids** from the sealed catalog.
   For this protocol `one_task` = one sample. Do not add `one_sample` this
   train.

3. **Specified Inspect epochs map onto Jinn replicates.** Worker stays
   `epochs: 1`. `runOptions.epochs` stays refused. Planned k equals the sealed
   specified epochs (resolved eval config `epochs` / `Epochs(n, reducer)` if
   present, else `1`; the operator may set explicitly; seal whatever ran).
   No `inspect eval-set` orchestration and no Harbor Job overlay this train.

4. **Aggregation is two-stage Inspect analysis, not Matrix votes.** Epoch-
   reduce per sample (default `mean`; Task may set `pass_at_k` / `mode` / …)
   then sample-aggregate (`accuracy` / `mean`). That reconstructed Inspect
   number is the suite metric. Boolean `passValue` projections stay the cell
   vote. Do not report the Boolean rate as the official Inspect score.
   `inspectMetrics` and `inspectEpochReducers` remain pinned native analysis.

5. **Comparability stays two-axis.** Report v2 gains no new required fields.
   Reuse `leaderboardSubmitReady` with Inspect-named copy: it means
   **as-specified complete**, not a Hub/leaderboard row.
   - `execution_conformance` — adapter `inspect`, Inspect `0.3.255`, Task
     default solver, no `--limit`, worker `epochs: 1`, planned k equals
     specified epochs;
   - `coverage` — named slice or custom sample ids from the sealed catalog;
   - `leaderboard_submit_ready` — `full` coverage, execution conformance,
     Matrix `replicates === specifiedEpochs`, and after collect every sample
     × k accounted `judged` or `unscorable`, with an exclusive native `.eval`
     per cell.
   Quote/lock never set it true. Canonical limitation names
   **Inspect-as-specified**. Copy: Colophon does not place an Inspect Hub row.

6. **Pin at select, not a global “the Inspect pin”.** Seal `inspect-ai`
   `0.3.255` plus the existing wheel SHA, the task reference and resolved
   source SHA, Inspect Evals `task_version` when the resolved Task exposes
   `N-X` (omit rather than invent), the ordered sample-id catalog snapshot
   digest (not a HuggingFace git SHA; not TB’s `sha256:` dataset-content
   hash), `sampleLimit` unset, and solver = Task default. Any `--solver`
   override is custom / not `executionConformance`. Sample ids may contain
   `/` (for example `HumanEval/0`); do not loosen Terminal-Bench 2.1’s
   `^[^/]+$` rule.

7. **Per-cell sampleId overlay.** The shared selection is a template with no
   single `sampleId`. The launcher writes `inspect-run.json` with `sampleId`
   from the cell’s Task. OCI still requires exact `sampleId` per execution.
   Adapter id stays `"inspect"`. Do not invent a second adapter.

8. **Derived View bundle, not Hub.** `colophon runtime inspect-as-specified
   export` copies correlated per-cell `.eval` logs for `inspect view` /
   `--bundle-dir` semantics. Ready + `full` → suite-named bundle copy. Named
   slice → `inspection-upload` only. Cousin, custom, or non-conforming →
   refuse suite-named export. Do not add Harbor Hub export on this adapter.
   Do not emit GAIA-test upload files. The View bundle is not the claim of
   record.

9. **Cousin firewall.** `runtime inspect select` must not write
   `protocol: "inspect-as-specified"`. Cousin Inspect remains a legal venue.
   Wearing the suite name requires the suite selection schema
   `jinn.network/benchmark-product/inspect-as-specified-selection/1`.
   Binary-judge is unchanged.

10. **Out of this train.** Multi-task Inspect `eval-set` CLI; unlocking
    Inspect `--epochs N` inside one `.eval`; Inspect Hub / Flow as a venue
    row; Harbor Job overlay; binary-judge changes; Inspect’s SWE-Bench Task
    wearing `swe-bench-verified`; bumping `inspect-ai==0.3.255` / OCI
    `inspect-evals==0.16.0`; treating `gaia` plus `gaia_level1/2/3` as a
    non-overlapping full set.

## Consequences

- Inspect remains one execution per cell. Specified epochs are Jinn
  replicates, not an Inspect inner loop.
- GTM may describe Inspect-as-specified as a named protocol Colophon wraps.
  Cousin Inspect copy stays “select a supported Inspect task.”
- A cousin method on an Inspect eval still cannot wear the suite name.
- Eval-set grouping stays correlation only ([DR-2026-08-17](./2026-08-17-runtime-engine-direct-mode.md)).
  One Inspect eval of many samples is never one Execution Evidence record.

## Alternatives rejected

- **GAIA-only named discriminant.** The operator picks the eval; the sealed
  catalog names it.
- **`one_sample` coverage enum.** That would fork `SUITE_COVERAGE` for TB
  and Verified.
- **Unlocking `--epochs` inside one `.eval`.** Repeats would fold unless
  artifacts split; k is Jinn replicates instead.
- **New Report v2 field `official_report_ready`.** Reuse
  `leaderboardSubmitReady` with Inspect-named copy.
- **A second Inspect adapter id.** OCI, worker, scoring projections, and
  exclusive-log assurance stay one path.

## Ratification

Ratified on 2026-08-18 by the operator’s instruction to implement the
attached Inspect-as-specified official-suite train. Changing who owns the
campaign, merging many samples into one Execution, placing an Inspect Hub
row, or wearing the suite name on a cousin/custom method requires a
superseding record.
