---
title: Graded reward signal for the learning loop (Lever A) — expose per-test score, thread it into the Consolidator's keep/revert gate
date: 2026-06-03
author: opus (brainstormed on design/graded-reward-signal-lever-a; operator adrianobradley/Ritsu)
status: design-locked — operator-reviewed; implementation plan next
version: 0.1
issue: https://github.com/Jinn-Network/mono/issues/1019
relates-to: >
  Discussion #770 (the RL-on-harness ladder + Oak's two comments — this implements
  the "cheaper lever" Oak names),
  DR-2026-05-27 (log/decisions/2026-05-27-rl-on-harness-survey.md — the six-component
  RL frame; reward is component #3, the ladder sharpens credit assignment #5),
  issue #764 (the Level-1 per-codeDigest selection-on-reward gate this enriches —
  client/src/learner/revert-decision.ts, revert-stats.ts),
  issue #986 + DR-2026-06-02-b (held-out efficacy: honest negative; this addresses the
  ONLINE reward variance #986 does not touch),
  PR #987 (paired McNemar in the OFFLINE exam — the discipline this mirrors online)
---

**Pre-reads (load-bearing):**

- **Discussion [#770](https://github.com/Jinn-Network/mono/discussions/770)** — the ladder this sits *beneath*. Read Oak's two comments: comment 1 (the certificate gate + the SE diagnosis — "variance reduction on the reward estimate" is the binding constraint, upstream of the ladder); comment 2 ("The reward signal #3 is needlessly lossy for SWE — a cheaper lever than the credit-assignment ladder #5").
- **`client/src/learner/revert-decision.ts` + `revert-stats.ts`** — the shipped Level-1 gate (#764). Today: a two-proportion z-test on the binary verdict, `minSamplesPerArm: 30`, unpaired. This is what we enrich.
- **`client/src/harnesses/impls/swe-rebench-v2-evaluator/index.ts:42–43, 74–88`** — the grader. It already computes `passed[]`/`failed[]` per test, then collapses to `score: passed_match ? 1 : 0` at line 88 and drops the arrays. This is the one line where the signal is destroyed.
- **DR-2026-06-02-b** (`log/decisions/2026-06-02-held-out-efficacy-measurement-power.md`) — the honest negative that isolated reward variance as a binding blocker. #986 fixes the *offline exam's* power; this fixes the *online loop's* signal.

---

## 1. Summary

The daemon's learning loop reverts harness mutations that don't help and keeps the
ones that do (#764, "Level 1 hill climbing on the harness"). Its only feedback is
the evaluator verdict, which collapses to **one bit** — `score ∈ {0,1}`. Under that
bit, an 18/20 near-fix is indistinguishable from a 0/20 no-op, so the keep/revert
gate needs many samples per harness state to separate signal from noise — and in
train mode the harness state (`codeDigest`) mutates every task, so those samples
never accumulate. The gate perpetually abstains (`insufficient_samples`) and the
loop does not close. This is the binding constraint Oak names in #770: **variance
on the reward estimate, upstream of the ladder.**

The grader **already computes the richer signal** — it runs every test and knows
`passed[]`/`failed[]` — then discards it one line before it could survive. **Lever A
is: stop discarding it.** Expose a graded score (`passedCount`/`totalCount`),
carry it on-chain alongside the existing bit (additive, never replacing), and feed
it into the Consolidator's gate as a **lower-variance estimator for the same
keep/revert decision**. Richer per-run reward × aggregation reaches confidence with
far fewer runs — direct relief for the scarce-sample bind, and it compounds with
every future rung of the #770 ladder.

**Two invariants make this safe** (derived from the 2025–2026 literature survey in
§3 and Oak's boundary in #770 comment 2):

1. **The graded score never overrules the bit.** Binary `actualPassed` stays the
   ground-truth objective; the graded score only reduces the *variance of the
   decision*. (Mirrors PR #987: paired McNemar reported *alongside*, never
   replacing, the marginal verdict.)
2. **The graded score is consumed only by the learning loop, never by emissions.**
   The operator reads its *own* runs to correct *itself* — no incentive to game. A
   graded score that sized on-chain reward *would* be gameable (claim 18/20 when
   it's 11/20), and that path is gated on the withheld-test challenge, which is **out
   of scope here.**

This spec covers Lever A only. Levers B (sample-banking / hold-`codeDigest`-fixed
cadence) and C (paired/matched online gate) are sequenced follow-ons (§9).

## 2. The gap, concretely

### 2.1 What "18/20" means in a SolverNet

A swe-rebench-v2 task is **one real GitHub bug** in a real repo. It ships two named
test sets: `FAIL_TO_PASS` (broken tests a correct fix must make pass) and
`PASS_TO_PASS` (already-passing tests a fix must not break). One **run** = the
solver's patch for that one bug, evaluated against that task's full test set. So
"18/20" = **18 of the 20 individual tests in this one solve of this one bug passed.**
Tests *within* a single run of a single task — not the same task across runs, not
different tasks.

Each run yields one graded score. The daemon tries its current harness state across
many different bugs, producing a *spread* of graded scores; the keep/revert decision
compares that spread under "with mutation" vs "without." (Comparing the *same* bug
under two states would be cleaner — that is Lever C, pairing — but train mode mutates
the state every task, so the two states rarely hit the same bug. Hence the rank-based
test + binary guardrail chosen in §5.4, which tolerate comparison across different
bugs of different difficulty.)

### 2.2 Where the signal dies

`swe-rebench-v2-evaluator/index.ts:88`:

```
score: result.passed_match ? 1 : 0,   // passed[]/failed[] dropped here
```

`passed_match` is *stricter* than "fraction passed" — it is a boolean for whether
the *exact* required test set matched. Pass 18 of 20 but miss 2 required
`FAIL_TO_PASS` and `passed_match = false` → published score 0, "18/20" gone. The
schema then forbids anything finer:
`score: z.union([z.literal(0), z.literal(1)])`
(`packages/sdk/src/payloads/swe-rebench-v2.ts:51–65`), and the indexer materializes
`actualScore` as only `"0"`/`"1"` (`packages/indexer/src/handlers.ts:744–759`).

### 2.3 Why the bit starves the gate

`revert-decision.ts` runs a two-proportion z-test with `minSamplesPerArm: 30`. With a
bit, separating a 55%-pass harness state from a 50% one needs large samples. With
per-task `codeDigest` churn in train mode, a single state rarely reaches 30 indexed
attempts, so the gate returns `insufficient_samples` and the loop never closes.

## 3. Prior art — why graded reward is safe *here* (2025–2026 survey)

The literature is split, and the split is exactly what tells us how to use the signal.

**Dense reward helps when grounded in executable tests.**
- **VeRPO** ([arXiv 2601.03525](https://arxiv.org/pdf/2601.03525), Jan 2026) — `r = passed/total` partial credit; resists hacking *because* it derives from real test execution, not a learned reward model: "a solution cannot artificially inflate its score; it can only improve by genuinely passing more tests." Reports solid gains over binary baselines.
- **SecureCodeRL** ([arXiv 2601.01184](https://arxiv.org/pdf/2601.01184)) — partial-credit + composite verifiable penalties; cuts hacking from 0.23–0.60 to ≤0.06 with no accuracy loss.

**Naïve dense reward backfires as a *gradient* signal.**
- **Exploring Pass-Rate Reward in RL for Code Generation** ([arXiv 2605.02944](https://arxiv.org/html/2605.02944), May 2026 — most recent, most on-point) — pass-rate reward does **not** beat binary in GRPO/RLOO. Three failure modes: (1) test-pass fraction is a *miscalibrated proxy* (an 84%-pass wrong approach can outrank a near-correct one-line-fix); (2) *intra-group gradient conflict* — 57.4% of tasks had conflicting gradient signs, partial-pass rollouts cancel; (3) reward hacking via overfitting the provided suite.

**Why the critique does not bind Lever A.** The May-2026 failure modes are specific
to using pass-rate as a *policy-gradient reward for weight updates*:

- **No gradients → no gradient conflict.** We use the graded score as a statistic
  for a *discrete keep/revert decision*, not as a gradient. Cancellation is
  structurally impossible.
- **Aggregate estimate, not per-solution credit.** The miscalibration critique is
  about *ranking individual solutions*. We estimate *the effect of a harness mutation
  on expected score across many bugs*; the law of large numbers recovers the
  harness-effect with lower variance than the bit, even when any single score is a
  noisy proxy.

The survey's two cautions map onto our two invariants (§1): "overfitting the provided
suite" is the gaming Oak's **withheld-test challenge** addresses, and it only bites on
the **emissions** side — invariant 2 quarantines us from it; "miscalibrated proxy"
is why the graded score is a **variance-reducer, not the objective** — invariant 1.

Framing refs: [From Reasoning to Agentic (credit-assignment survey), arXiv 2604.09459](https://arxiv.org/html/2604.09459v1); [AgentPRM, WWW 2026](https://dl.acm.org/doi/10.1145/3774904.3792551); [GRPO is Secretly a PRM, arXiv 2509.21154](https://arxiv.org/pdf/2509.21154). These confirm graded *outcome* reward (Lever A) and *process* reward (the ladder's higher rungs) are distinct axes.

## 4. Scope

**In scope.** Expose a graded per-run score from the swe-rebench-v2 evaluator; carry
it on-chain via an additive verdict payload; materialize it in the indexer; surface
per-attempt scores in the discovery query; add a two-tier (binary-primary,
graded-sensitivity) keep/revert decision to the Consolidator.

**Out of scope (sequenced follow-ons — see §9).** Lever B (cadence / sample-banking);
Lever C (paired online gate); any use of the graded score in the reward/emissions
path; the withheld-test challenge; non-swe-rebench-v2 SolverTypes; weight updates.

**Decision — on-chain (additive), not local-only.** The graded fields ride the
published verdict envelope and are materialized by the indexer, matching the existing
indexer-based #764 data path and unlocking **federated Level 1** ("which `codeDigest`s
across the network score best" — already queryable in shape, just needs the richer
field). Invariant 2 means on-chain *visibility* never implies emissions *use*.

## 5. Design

### 5.1 Reward production — additive `swe-rebench-v2-verdict.v2`

- **Grader** (`swe-rebench-v2-evaluator/index.ts`): populate `passedCount` /
  `totalCount` from the `passed[]`/`failed[]` arrays already in hand
  (`totalCount = |passed| + |failed|`, the union of the task's required test sets as
  the runner reports them). Keep emitting `score`/`passed_match` unchanged. No new
  computation.
- **Payload schema** (`packages/sdk/src/payloads/swe-rebench-v2.ts`): new
  `swe-rebench-v2-verdict.v2`, **additive** — retains v1's `score ∈ {0,1}` and
  `passed_match`; adds `passedCount: number`, `totalCount: number` (and, optionally,
  a derived `gradedScore = passedCount/totalCount` materialized downstream rather
  than stored, to keep one source of truth). v1 payloads remain valid; v2 is a
  superset. Bump the producer to emit v2; consumers that only know v1 ignore the
  extra fields.

### 5.2 Carrying it through — indexer materialization

- `packages/indexer/src/handlers.ts` (the verdict handler, ~744–759): parse the v2
  graded fields and materialize them on `verdictEnvelopeMeta` (new columns
  `passedCount` / `totalCount`, or a `gradedScore` real). The existing
  `actualScore`/`actualPassed` columns are untouched — the bit stays the bit;
  graded is a new, nullable, additive column so historical (v1) verdicts read as
  `gradedScore = null` and consumers fall back to the bit.

### 5.3 Discovery query — per-attempt graded scores

- `getCodeDigestRewards` (HTTP discovery; see #764 commits) today returns pass
  *counts* per `codeDigest`. The rank test (§5.4) needs the **per-attempt graded
  scores**, not just an aggregate. Extend `CodeDigestRewardRow` to carry
  `gradedScores: number[]` (the in-window per-attempt scores for that `codeDigest`),
  with `null` entries where a verdict predates v2. Keep the existing pass-count
  fields so the binary tier is unchanged.

### 5.4 The two-tier keep/revert gate

Augment, don't replace — mirroring PR #987.

- **New pure statistic** in `revert-stats.ts`: `mannWhitneyU(scoresA, scoresB)` →
  `{ u, z, pValue }`, two-sided, with tie correction; no I/O, unit-tested against
  hand-computed cases. (Rank-based per §3: robust to the bounded/bimodal/miscalibrated
  score distribution, assumes only "higher is usually better," not calibration.)
- **`decideRevert` becomes two-tier**:
  - **Tier 1 — binary (objective), unchanged.** Two-proportion z-test on
    pass/total, `minSamplesPerArm: 30`. If it returns `significant_regression`,
    revert — *gated on the graded direction agreeing* (graded delta ≤ 0); if binary
    says regress but graded says improve, **do not hard-revert** (new reason
    `binary_graded_disagree`, hold). This is the confirmation guardrail.
  - **Tier 2 — graded (sensitivity), new.** Only when Tier 1 returns
    `insufficient_samples` (the common train-mode case): run `mannWhitneyU` on the
    per-attempt graded scores at a lower floor `gradedMinSamplesPerArm` (~10). A
    significant graded regression → revert with reason
    `graded_regression_provisional`. Otherwise abstain as before.
- **Policy additions** (`RevertPolicy`, overridable via `implStateDir/policy.json`):
  `gradedMinSamplesPerArm` (default 10), `gradedAlpha` (default 0.05). Existing
  `minSamplesPerArm`/`alpha`/`recentAttemptsWindow` retained for Tier 1.
- **Reason enum** gains `graded_regression_provisional` and `binary_graded_disagree`.

### 5.5 The boundary guard (invariant 2)

- The spec records the boundary explicitly, and the implementation keeps graded
  fields off every emissions/reward code path. The graded columns are read by the
  learner discovery query and the Consolidator only. A test asserts no emissions/
  distribution code reads `gradedScore`. The withheld-test challenge is named as the
  prerequisite for ever sizing reward on a graded score.

## 6. Data flow

```
evaluator runs every test → passed[]/failed[]            (already computed)
  └─ grader: emit score∈{0,1}+passed_match (v1, unchanged)
             + passedCount/totalCount (v2, additive)
      └─ verdict envelope (v2 payload) → published on-chain
          └─ indexer materializes gradedScore on verdictEnvelopeMeta (nullable)
              └─ getCodeDigestRewards → gradedScores[] per codeDigest (in-window)
                  └─ Consolidator decideRevert (two-tier):
                      Tier 1 binary z-test (OBJECTIVE) ─┬─ sig regress + graded agrees → revert
                                                        ├─ sig regress + graded disagrees → hold
                                                        └─ insufficient → Tier 2
                      Tier 2 Mann-Whitney on gradedScores[] (SENSITIVITY)
                                                        └─ sig regress → provisional revert
```

## 7. Error handling & backward compatibility

- **v1 verdicts (no graded fields).** `gradedScore = null`; `gradedScores[]` entries
  null. Tier 2 sees `< gradedMinSamplesPerArm` non-null scores → abstains; the gate
  degrades exactly to today's binary-only behaviour. No regression for historical
  data or non-upgraded operators.
- **Unscorable runs (#476).** Excluded from the denominator on both tiers, never
  coerced to a fail — unchanged from today.
- **`totalCount = 0`.** Guard: a verdict with zero gradeable tests yields
  `gradedScore = null` (not 0/0), excluded from Tier 2.
- **Mixed v1/v2 windows.** Tier 1 (binary) runs on the full window; Tier 2 (graded)
  runs only on the v2 subset — so the sensitivity layer simply has less data early in
  the rollout, never wrong data.

## 8. Testing

- **`revert-stats.test.ts`** — `mannWhitneyU` against hand-computed U/z/p for:
  clean dominance, no-signal (identical distributions), heavy ties, tiny n, and the
  bimodal {0,1}-clustered case §3 warns about.
- **`revert-decision.test.ts`** — two-tier matrix: (a) binary significant regress +
  graded agrees → revert; (b) binary regress + graded improves → hold
  (`binary_graded_disagree`); (c) binary insufficient + graded significant regress →
  `graded_regression_provisional`; (d) binary insufficient + graded insufficient →
  abstain; (e) v1-only window → degrades to binary-only.
- **Payload round-trip** (`packages/sdk`) — v1 parses; v2 parses; a v1-only consumer
  reads a v2 payload and ignores graded fields; `totalCount=0` rejected/guarded.
- **Indexer materialization** — a v2 verdict envelope materializes `gradedScore`; a
  v1 envelope materializes `null`; `actualScore`/`actualPassed` unchanged in both.
- **Discovery** — `getCodeDigestRewards` returns `gradedScores[]` with nulls for
  pre-v2 attempts; window cap + manifest-cid scoping (the #764 fixes) still apply.
- **Boundary** — assert no emissions/distribution module imports/reads `gradedScore`.
- **Reuse #764's synthetic git-history fixture** (AC5), extended with graded scores,
  to drive the Consolidator end-to-end.

## 9. What this deliberately does NOT do

- **Lever B (cadence / sample-banking).** Holding `codeDigest` fixed longer per
  digest to bank samples — in tension with train-mode per-task mutation; touches the
  freeze-fence and train-mode semantics. Lever A *relieves* B's binding constraint
  (richer signal → fewer samples needed) but does not resolve it. File as a follow-on
  after Lever A produces evidence.
- **Lever C (paired online gate).** Comparing the *same* bug under two harness states
  (McNemar online) is the lowest-variance comparison, but in train mode the two
  states rarely share a bug — so C is *blocked on B*. C's real homes today are the
  frozen exam (PR #987, done) and L2 ablation. File after B.
- **Emissions use of the graded score.** Requires the withheld-test challenge
  (adversarial verification). Hard boundary (§5.5).
- **Other SolverTypes / weight updates.** Out of frame.

## 10. Threats to validity / open questions

- **`totalCount` definition.** Is it `|FAIL_TO_PASS ∪ PASS_TO_PASS|` as authored, or
  as the runner's log-parser actually reports (which can differ when a test errors at
  collection)? Implementation must pin one definition and log drift; the screening /
  gradeability machinery (#986) is the reference for "what counts as a gradeable
  test."
- **Cross-task comparability.** 18/20 on an easy bug ≠ 18/20 on a hard one. The rank
  test + binary guardrail mitigate but do not eliminate this; pairing (C) is the real
  fix. Acceptable for a *sensitivity* layer whose job is only to break the abstain
  tie, not to be the objective.
- **Does Tier 2 actually fire in production?** The whole point is to convert
  `insufficient_samples` abstentions into decisions. The #766/#986 measurement
  infrastructure should track the Tier-1-abstain → Tier-2-decision conversion rate as
  the primary evidence Lever A worked. If Tier 2 still rarely reaches
  `gradedMinSamplesPerArm`, that is the empirical signal that **B** (not a richer
  technique) is the next move — consistent with Oak's "binding constraint is upstream
  of the ladder."
