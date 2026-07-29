# @jinn-network/marketplace-pipeline

The daemon's marketplace application: the pluggable operator claim predicate, execution wiring
(work-kind → harness/model/plugins/credential config), spend/AI-unit self-protection caps, the
two-party engagement composition of the marketplace binding's venue verbs with an embedded
`TaskExecutionBackend` peer (ruling §7.18), and the §9 TaskEngine carve disposition as
documentation-as-code — a composition LIBRARY proven by tests, not a live daemon cutover.

See the design: `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md` §7/§9.
Implementation plan: `docs/superpowers/plans/2026-07-28-marketplace-binding.md` Milestone M6.

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

## Status

Milestone M6 complete (plan M6.1–M6.3). Live `client/src/daemon/*` cutover remains out of scope
(migration-mechanics session).
