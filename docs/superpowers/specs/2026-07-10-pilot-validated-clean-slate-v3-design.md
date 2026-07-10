# Validated Clean Pilot Slate V3

## Goal

Run the paired skill evaluation on a fixed 24-task SWE-rebench slate whose
denominator measures solver behavior rather than known benchmark or evaluator
failures. Stock, Haiku-skill, and Opus-skill arms must attempt exactly the same
tasks, and the run must remain resumable in bounded chunks.

## Admission Policy

The slate is selected from `nebius/SWE-rebench-leaderboard`, not the 20-row
smoke sample. A task is eligible only when all of the following hold:

1. The local `validated-pool.json` records `scorable: true` for the current
   `EVAL_SEMANTICS_VERSION`.
2. Every available dataset quality assessment classifies the task as `A`, with
   no true `B1` through `B6` flag.
3. Quality metadata is present and parseable. Missing or malformed metadata is
   excluded rather than treated as clean.
4. The task did not contribute evidence to either evaluated distilled skill
   set. Distillation provenance is read from the frozen eval-prep artifacts,
   and any source instance ID is excluded.
5. The row contains the fields needed by the solver and evaluator.

Selection is deterministic: eligible tasks are ordered by a stable hash of the
instance ID and slate seed, with `instance_id` as the final tie-break. The first
24 become slate v3. Selection does not depend on filesystem enumeration order
or network response order.

## Frozen Artifact

Add a versioned held-out slate artifact rather than modifying the existing v1
or v2 artifacts in place. The existing v2 is a nine-task baseline-failure
regression benchmark with different admission criteria; it remains unchanged.
The new v3 slate artifact retains the repository's existing
`held-out-slate.v1` format and records:

- schema and slate version;
- 24 instance IDs;
- an artifact hash over the canonical slate.

A sibling v3 screening report records the evaluator semantics version, dataset
and source splits, selection seed and policy version, validated-pool timestamp,
distillation artifact identity, and per-instance split, row hash, quality, and
validation evidence. The pilot checks both files before starting a new run.

The pilot verifies these bindings before a new run. Existing output directories
continue from their frozen `instances.json`; they are never silently changed by
a newer slate or validated pool.

## Pilot Integration

The default non-dry-run pilot source becomes the v3 slate. Explicit
`--instances` remains available for diagnostics. The 20-row sample task is no
longer the implicit smoke default.

Before freezing a new run, the pilot loads the production historical pool,
loads current-semantics scorable entries through `ValidatedPoolStore`, verifies
the v3 slate bindings, and materializes the 24 complete task rows. Admission
fails closed with an actionable error if the pool file is missing, semantics
are stale, a slate row changed, or fewer than 24 eligible tasks remain.

The three configured arms create 72 attempt records. `--max-new-solves` limits
each invocation, so operators can run six sessions at a time. Completed stock
attempts are reused on later invocations just like completed treatment attempts.

## Failure Handling

- Dataset quality warning or missing quality metadata: exclude during slate
  construction.
- Distillation provenance overlap: exclude during slate construction.
- Missing current validation or row-hash mismatch: reject the slate/run.
- Solver, grader, or rate-limit error: persist the existing terminal error
  record; reopen only with `--retry-errors`.
- Selection inputs change: create a new slate version, never mutate v3.

## Testing

Unit coverage will prove that admission requires both clean metadata and
current-semantics validation, rejects missing metadata, excludes all
distillation source IDs, and produces deterministic 24-task output and hashes.

Pilot tests will prove that default task loading uses the frozen v3 slate, all
three arms receive identical task IDs, explicit diagnostic instances still
work, stale validation fails closed, and chunked reruns make only the requested
new calls without repeating completed stock attempts.

No live solver or grader calls are made by unit tests.

## As-built errata (2026-07-10, post-run)

Recorded after the first live runs against this slate; each item names where
the shipped implementation or the first experiment diverged from this design.

1. **Quality screening as-built.** Admission point 2 ("every available dataset
   quality assessment") was implemented as a locally generated
   claude-haiku-4-5 screen over the 36 smallest-input validated candidates
   (34 rated `A`; one `B2`, one `B3` rejected), recorded in
   `held-out-slate.swe-rebench-v2.v3.quality-screen.json`. The deterministic
   hash selection therefore operated over ≤34 pre-screened candidates, and the
   slate inherits a smallest-input size bias. The screen replaced each task's
   `meta` wholesale rather than merging with dataset-provided assessments.
2. **Run-time admission verification not wired.** The fail-closed re-check
   described under Pilot Integration (`verifySelectedTaskAdmission`) exists
   and is unit-tested but is not called by `run-pilot.ts`; the pilot pins the
   frozen artifact by sha256 only. A semantics bump does not currently fail
   closed at run time.
3. **Repo-level leakage.** Exclusion (admission point 4) was instance-id-only.
   Three slate members share a repository with distillation source instances:
   `probabl-ai__skore-1229`, `probabl-ai__skore-1136` (source
   `probabl-ai__skore-1056`) and `gerlero__foamlib-315` (source
   `gerlero__foamlib-329`). These bias skill arms and are excluded from
   cross-repo analyses; they are, deliberately, the same-repo (rung-2)
   transfer probe set.
4. **Arm isolation was absent in the 2026-07-10 runs.** All arms ran against
   the shared `~/.jinn-agent`, so every arm's system prompt carried the full
   installed skills catalog (all 20 distilled skills, stock arm included) —
   the arms were not experimentally distinct, and all same-day arm
   comparisons (v2 slate 0/9-all-arms; v3 partial runs) are void as transfer
   evidence. Difficulty reads (stock-condition resolve rates) remain valid.
   Isolation is now per-arm `jinnAgentHome` homes built by
   `client/scripts/build-pilot-arm-homes.ts` and verified by a live
   system-prompt probe before spend; skills are lazy (manifest entry +
   `skill_view`), so runs testing knowledge rather than browsing propensity
   pass `--skills-nudge` (recorded as semantic in the manifest).
5. **Slate repurposing.** With stock at 71% on the screened subset, v3 is
   repurposed as the cost/efficiency eval (both-solve cost deltas,
   non-inferiority on solvable tasks); the difficulty/efficacy question moved
   to the v2 baseline-failure slate and the rung-2 probe.
