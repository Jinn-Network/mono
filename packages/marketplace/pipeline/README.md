# @jinn-network/marketplace-pipeline (deprecated)

This package is the frozen legacy daemon marketplace application: the pluggable operator claim predicate, execution wiring
(work-kind → harness/model/plugins/credential config), spend/AI-unit self-protection caps, the
two-party engagement composition of the marketplace binding's venue verbs with an embedded
`TaskExecutionBackend` peer (ruling §7.18), and the §9 TaskEngine carve disposition as
documentation-as-code — a composition LIBRARY proven by tests, not a live daemon cutover.

Native mode does not enter this pipeline. New product code keeps claim, spend, capability,
harness, model, credential and prioritisation choices in tier-4 composition, using neutral
preclaim helpers from `@jinn-network/task-execution-backend` and transaction mechanics from
`@jinn-network/marketplace-binding`. The package remains independently publishable only while
the explicit legacy operator loop imports it; Phase D deletes it when that consumer reaches zero.

## Public surface

- `CLAIM_NOTHING`, `evaluateClaimPredicate`, `takeEveryRunnable`, `matchLegacyManifestDigest`
- `checkCaps`, `resolveWiringEntry`, `runPinningConstraint`, `wiringHonorsPinning`
- `buildEngagement`, `runPipeline` (claim → finalized gate → two-party submit → wait → converge → settle)
- `TASK_ENGINE_CARVE`, `TASK_ENGINE_FAILED_CARVE`, `carveOwnerForFailed`

Production code types against `TaskExecutionBackend` and `@jinn-network/marketplace-binding`
venue verbs only. `@jinn-network/task-execution-backend-local` is declared for the assembly
dependency edge and packed-type closure; concrete assembly construction stays at the host edge.
`@jinn-network/task-execution-testing` is a dev-only dependency for the in-memory fake backend
in unit tests.

## Transition status

All root exports are deprecated and behavior-frozen. CI rejects new client consumers outside the
explicit legacy allowlist and rejects new runtime exports. See DR-2026-08-03.
