# Demo-1 E3 statistical assurance packet

**Date:** 2026-08-13

**Scope:** pre-lock evidence for E3 H4, H5, H7, and the deterministic part of H13.
This packet does not change `paired-delta@1`, any public schema, any existing method fixture,
Wilson output, or an E3 register status. Locked-slate and post-run checks remain pending.

## Independent reference pin

The endpoint oracle is an independently written Python implementation, not a translation that
imports or executes the TypeScript estimator. It replays the frozen xorshift32-v1 cluster draws,
uses CPython's documented [`statistics.NormalDist`](https://docs.python.org/3.11/library/statistics.html#statistics.NormalDist)
for the normal CDF and inverse CDF, and selects an order statistic using the inverse empirical
CDF (Hyndman-Fan type 1).

- Runtime used: CPython `3.11.0`, standard library only.
- Generator: `packages/benchmarking/aggregate/scripts/generate-paired-delta-oracles.py`
- Generator SHA-256: `a5369fd7b3ead9f86ffcf29815c607f41d003cfa19079e167a91fd8e6ad4236e`
- Frozen oracle: `packages/benchmarking/aggregate/src/stats/oracles/paired-delta-bca.python-3.11.0.v1.json`
- Oracle SHA-256: `09189872493e725b86189ef95fcf4d2a9a1adaabea1b2c7f28faabec6304bcbe`
- Regeneration check: `python3 packages/benchmarking/aggregate/scripts/generate-paired-delta-oracles.py --check packages/benchmarking/aggregate/src/stats/oracles/paired-delta-bca.python-3.11.0.v1.json`

The fixture freezes every rate, task, repository-cluster assignment, seed, resample count,
alpha, observed value, acceleration, tie count, tie mass, bias correction, adjusted quantile,
order-statistic index, endpoint, cluster manifest, draw count, and sorted-resample-vector digest.

## H4 — two-sided BCa endpoint oracle

All three fixtures use 20,000 resamples and a two-sided alpha of `0.05`. Production is checked
against the independent lower and upper endpoints separately at `alpha / 2` and
`1 - alpha / 2`, with the same seed and resample count. The test preserves the pre-declared
tolerance: no more than one adjacent sorted order statistic and no more than `0.002` in absolute
rate units.

| Fixture | Repository shape | Strict external endpoint |
|---|---:|---:|
| `balanced-six-singletons` | `1,1,1,1,1,1` | `[-0.3333333333333333, 0.5]` |
| `unequal-correlated-clusters` | `1,2,3,4` | `[-0.075, 0.07142857142857142]` |
| `discrete-tie-mass` | `1,1,1,1,1,1` | `[-0.14583333333333334, 0.10416666666666667]` |

The production calls match all six endpoint values within the bound, preserve the exact cluster
manifest, and each report `resamples × clusterCount` unique draws. The injected-call regression
also asserts both endpoint calls receive the same seed and resample count.

## H5 — exact strict-tie decision and mid-p audit

`paired-delta@1` v1 keeps its existing exact convention: bias correction counts only bootstrap
statistics strictly below the observed task-average statistic. This packet does not retrofit
mid-p semantics into the versioned method. Mid-p (`below + ties / 2`) is frozen as the mandatory
sensitivity calculation.

| Fixture | Tie mass | Strict endpoint | Mid-p endpoint | Zero decision |
|---|---:|---:|---:|---|
| `balanced-six-singletons` | `0.1407` | `[-0.3333333333333333, 0.5]` | `[-0.25, 0.5833333333333334]` | both cross zero |
| `unequal-correlated-clusters` | `0.02725` | `[-0.075, 0.07142857142857142]` | `[-0.0625, 0.07142857142857142]` | both cross zero |
| `discrete-tie-mass` | `0.12405` | `[-0.14583333333333334, 0.10416666666666667]` | `[-0.125, 0.125]` | both cross zero |

The audit is deliberately non-vacuous: at least one bound moves by more than `0.005` on every
synthetic case even though the zero-exclusion decision is unchanged. For the locked slate, the
report must publish the realized tie mass, both strict and mid-p endpoints, and whether their
sign/zero decision agrees. A disagreement cannot be hidden in an appendix.

## H7 — declared task-average estimand

The declared estimand is the unweighted mean over paired tasks of `p(candidate) - p(baseline)`.
The unequal-cluster fixture has repository sizes `1,2,3,4` and ANOVA intraclass correlation
`0.9695982627578719`. An exact enumeration of all `4^4 = 256` whole-cluster bootstrap selections
gives:

- observed task average: `0.015`;
- exact expected bootstrap mean: `0.012665771728271737`;
- absolute centering offset: `0.002334228271728262`;
- strict BCa interval half-width: `0.0732142857142857`; and
- offset / half-width: `0.03188214224799578`.

The offset is therefore below both pre-declared bounds: `0.005` absolute and 10% of interval
half-width. The test independently re-enumerates the selections and recomputes the unequal-size
ANOVA ICC. The same audit must be rerun on the locked slate's actual repository-size profile;
this synthetic result does not substitute for that post-lock equality check.

## H13 — deterministic replicate-aggregation sensitivity recipe

The headline remains **mean-rate**: within each `(task, arm)`, divide judged passes by judged
replicates, subtract baseline from candidate per task, then average equally over paired tasks.
The post-run sensitivity table uses the identical paired-task set and reports two additional
deterministic collapses:

1. **any-pass:** arm value is one iff at least one judged replicate passes;
2. **strict-majority:** arm value is one iff passes are strictly more than half of judged
   replicates; an even tie is zero.

For each rule, apply the locked cluster manifest and the locked seed/resamples/alpha to the same
two-sided clustered BCa procedure. Publish the point estimate, endpoints, and sign/zero decision
for all three rules. Mean-rate remains the preregistered headline even when a sensitivity differs.
The test contains an outcome-changing frozen example (`1/6`, `1/3`, and `0` respectively) so the
recipe cannot silently collapse into three aliases.

## Remaining run-specific obligations

This packet supplies engineering evidence only. Before dispatch or after results as specified by
the register, Demo-1 must still bind the oracle fixture/generator digests, run the H5 and H7 audits
on the locked slate, publish the H13 table, and close each corresponding E3 item against those
exact artifacts. No model, Docker cell, preview, rehearsal, or official cell was run here.
