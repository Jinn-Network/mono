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
The new v3 artifact records:

- schema and slate version;
- evaluator semantics version;
- dataset and source splits;
- selection seed and policy version;
- validated-pool timestamp;
- distillation artifact identity;
- 24 entries containing instance ID, split, row hash, and validation evidence;
- an artifact hash over canonical selection inputs and entries.

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
