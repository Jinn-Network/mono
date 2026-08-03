# Phase C capability-convergence closure

This runbook closes the Phase C requester, discovery, task-supply, and transition-boundary work.
It does **not** authorize the Phase D native-default flip.

## Current safety posture

- Absent operator configuration still selects `legacy`.
- Explicit `native-v1` remains the only native execution mode.
- A chain-only `TaskCreated` match cannot resolve a requester posting WAL because it does not bind
  the Submission. Such operations remain broadcast-uncertain and require operator reconciliation.
- Task-supply and environment release groups are disabled and are not canary publication promises.
- No Base Sepolia receipt captured for an earlier commit may be represented as evidence for a
  later commit.

## Non-live acceptance

Use Node 22 and the repository-pinned Yarn version. From the repository root:

```sh
node --test \
  .github/scripts/platform-catalog.test.mjs \
  .github/scripts/transition-manifest.test.mjs \
  .github/scripts/phase-d-transition-deletion.test.mjs \
  .github/scripts/marketplace-source-boundaries.test.mjs \
  .github/scripts/task-execution-source-boundaries.test.mjs \
  .github/scripts/task-supply-package-inventory.test.mjs \
  .github/scripts/task-supply-source-boundaries.test.mjs \
  .github/scripts/prepublication-external-consumer.test.mjs
node .github/scripts/generate-architecture.mjs --check
```

Then run typecheck, unit/conformance, and packed-smoke scripts for every changed package. At
minimum this includes task-execution backend, marketplace binding/pipeline/venue-base,
task-posting, benchmarking marketplace, Record Discovery serve/evidence-journal, evidence local
runtime, and the client native requester/solver/evaluator recovery suites. The isolated
task-supply packed TypeScript consumer must compile all five task-supply package roots.

The native role closure must remain:

| Role | Catalog packages |
| --- | ---: |
| requester | 14 |
| operator | 23 |
| evaluator | 26 |
| independent consumer | 9 |
| union | 29 |

`@jinn-network/marketplace-pipeline` must be absent from the union.

## Exact-head hosted gate

1. Merge the Phase C implementation into its integration target.
2. Record the actual resulting 40-character commit SHA; do not predict the merge result.
3. Require every hosted and reusable verification job to succeed for that exact SHA.
4. Archive the catalog digest, generated topology, role-closure manifests, clean-consumer output,
   package tarball names and their cryptographic digests.
5. Any code change invalidates the candidate and requires the affected gates to rerun.

## Final Base Sepolia closure

Run the existing native-vertical closure procedure only after the exact-head hosted and packed
gates are green. The validated closure manifest must bind:

- `liveRun: true` and the exact merged Phase C commit;
- exact tarball/build and native-role manifest digests;
- the configured Base Sepolia deployment;
- requester, solver, evaluator, and independent-consumer reports;
- exact Task, Submission, Delivery, evidence, evaluation, and verdict identities;
- requester/backend and source-writer restart reports;
- requester, solver, evaluator, and evidence source heads; and
- both finalized solution and verdict settlements.

Archive the validated manifest outside the mutable working tree as immutable release evidence.
If the run fails or the source SHA moves, retain the failure report and start a new exact-head
candidate; never edit evidence to fit another commit.

## Phase D handoff

Phase D may consider the default flip only when the exact-head live receipt exists, all durable
native operations are resolved, the transition manifest validates, and every legacy usage signal
is zero for the approved observation window. Pipeline and other legacy deletions remain separate,
mechanical Phase D changes.

The daemon persists compatibility-use counters beside its SQLite database as
`<dbPath>.phase-d-transition-usage.v1.json`. `GET /v1/status` exposes the durable observation-window
start, counter values, and first/last observation timestamps under `phaseDTransitionUsage`; the
release owner archives these snapshots from every production instance for the full approved
window. Restarting a daemon must retain the same window and counters. A missing, corrupt, or reset
counter file invalidates the zero-use claim for that instance and starts a new observation window.
