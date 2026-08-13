# Demo-1 Haiku suitability and E2 design machinery

**Date:** 2026-08-13

**Scope:** offline method implementation only. This packet did not select a real task, invoke a
model, run Docker, perform a preview/rehearsal, or claim achieved power. It adds no Benchmark,
Run, Matrix, Report, evidence, or publication record kind.

## Existing boundary

The machinery is a product-owned continuation of `jinn.demo1.pre-run-freeze.v2`. It consumes the
winner's already-frozen suitability tasks, rehearsal tasks, and official task order through
`buildDemo1RehearsalPlanFromFreeze`. It cannot rank a new candidate, change the outcome-blind task
rules, or substitute a task after seeing an outcome. Its two schemas are explicitly local method
artifacts:

- `jinn.demo1.rehearsal-plan.v1`; and
- `jinn.demo1.e2-design-decision.v1`.

Both carry `artifactKind = local-method-artifact-not-evidence-record`. Canonical digests use the
existing benchmarking-records serializer. Decimal evidence is stored as fixed decimal strings so
the artifacts remain exact I-JSON rather than relying on floating-point JSON numbers.
The decision binds the exact plan digest and normalized rehearsal-input digest;
`verifyDemo1E2Design` independently rebuilds every interval, estimate, simulation, selection, and
cell schedule from those inputs and rejects any substituted derived field.

The rehearsal-plan basis contains the pre-run freeze digest, its selection-basis digest, and all
three frozen task pools. Six resolved non-zero uint32 seeds are the first big-endian word of a
domain-separated SHA-256 digest: suitability schedule, E2 schedule, empty-loadout interval,
primary power simulation, official schedule, and secondary sensitivity. They exist before any
lock or execution.

## Haiku suitability

The plan contains exactly six tasks from six repositories, true no-file only, with two replicates:
12 seeded cells. The assessment accepts at most two attempts per cell. A second attempt is legal
only after `pre-dispatch-infrastructure-failure`; a model outcome, timeout, authentication error,
launcher incompatibility, or ordinary failure can never receive a retry.

The result is `pass` only when all conditions hold:

- all 12 cell identities are accounted;
- at least 10 cells return a non-timeout valid grader PASS/FAIL;
- no model, authentication, or launcher incompatibility occurs;
- no more than two timeout FAILs occur; and
- the valid PASS count is within the inclusive range 2 through 10.

Unresolved pre-dispatch infrastructure or missing accounting is `inconclusive`. An incompatibility
or a completed threshold failure is `fail`. Both stop with measurements; there is no Sonnet or
other automatic fallback. The assessment embeds observations in canonical cell order, and the
design path recomputes and verifies the assessment before it may use a passing result.

## E2 schedule and empty-loadout diagnostic

The E2 plan contains exactly 10 tasks from at least five repositories and five replicates. It
schedules 150 primary cells across Skill, `CLAUDE.md`, and true no-file, plus 50 same-task
empty-loadout diagnostic cells. Repository identities must be disjoint across suitability, E2,
and every task in the frozen official order.

Empty loadout may become the official third arm only when both independently evidenced
structural checks are `match`:

- loader behavior is indistinguishable; and
- model-visible context is indistinguishable.

The same 10 tasks also feed the existing clustered `paired-delta@1` interval, with source
repository clusters, a frozen seed, 20,000 resamples, and alpha `0.0500`. The interval for
empty-loadout minus true-no-file must be wholly within `[-0.1000, +0.1000]`. Any structural
mismatch/unverifiability or either escaping bound retains true no-file and labels the loadout
axis `unverifiable`.

## Rehearsal estimates

Complete 10 × 5 × 4-arm input is mandatory. Timeout outcomes score zero and are reported per arm.
The decision records:

- mean within-task sample variance for every E2 condition;
- unequal-group one-way ANOVA repository ICC for the task-level Skill-minus-`CLAUDE.md`
  differences;
- per-arm timeout counts, denominators, and rates; and
- all six pairwise Pearson correlations of task-level arm rates, with an explicit zero-variance
  reason when a correlation is not estimable.

The simulation variance model subtracts the observed five-replicate measurement variance from the
task-difference variance, floors latent variance at zero, divides latent variance into repository
and within-repository components using the ICC, and retains the observed replicate-variance
coefficient. If every rehearsal repository is a singleton, repository clustering is not
estimable and the method stops without a power claim.

## Exhaustive official sizing

For every feasible prefix of the pre-run-frozen official order with at least five tasks and two
repositories, the method evaluates every positive replicate count satisfying
`tasks × replicates × 3 <= 600`. No result-informed reranking or task replacement occurs.

`demo1-gaussian-cluster-monte-carlo@1` performs 2,000 deterministic simulations per design. Each
simulation combines a repository normal effect, task normal effect, and replicate measurement
effect from the E2 variance model, centered on the preregistered `0.21` Skill-minus-`CLAUDE.md`
effect. A simulated design succeeds when the lower two-sided alpha `0.0500` normal bound for the
source-cluster robust mean is above zero.

Selection is mechanical:

1. among designs with simulated power at least `0.80`, choose the fewest cells;
2. ties prefer more repositories, then more tasks, then fewer replicates;
3. if none reaches `0.80`, choose the strongest simulated design within 600, with the same
   repository/task/replicate tie order; and
4. binary-search the selected design's deterministic power curve to 0.0001 and seal its achieved
   MDE. If even effect `1.0000` misses `0.80`, seal `greater-than-1.0000` rather than fabricating a
   reachable MDE.

The selected artifact freezes `topUpPolicy = forbidden-after-lock`. The secondary
`(Skill ∪ CLAUDE.md) versus control` variance model is evaluated only after primary selection and
emits an achieved-MDE sensitivity. It appears in `excludedSelectionInputs` and carries
`mayAlterPrimarySizing = false`.

## Stop boundary

No non-null power claim exists when Haiku has not passed, rehearsal input is absent/incomplete,
repository clustering is not estimable, or no feasible official prefix exists within 600 cells.
This implementation therefore cannot turn the current pre-run STOP inventory into a power,
capability, completion, or publication claim. Real task selection and every execution remain
operator-gated follow-on work.
