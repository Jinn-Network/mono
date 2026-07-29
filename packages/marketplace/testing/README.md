# @jinn-network/marketplace-testing

Conformance testing kit for the Jinn marketplace binding tree. Consumes
`@jinn-network/marketplace-{binding,projector}`, `@jinn-network/task-execution-testing`, and
`@jinn-network/record-discovery-testing` as production dependencies — the marketplace-tree
placement described in the plan's Finding F6 (a literal slice inside
`@jinn-network/task-execution-testing`, the backend-local precedent, would invert dependencies:
a foundation-tree testing package would end up depending on the application-tree
`@jinn-network/marketplace-binding`).

See the design: `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md` §13.
Implementation plan: `docs/superpowers/plans/2026-07-28-marketplace-binding.md` (Milestones
M2.5, M3.5, M4.5, M5.3, M7.2 register this kit's suites).

## Suites

The package currently runs:

- the TEP core kit's `describeTaskExecutionBackendContract` **un-parameterized**, as a sanity
  suite (ruling §7.19) — the core kit stays profile-agnostic;
- the natively-authored §16.2 marketplace-profile conformance (signed documents, mandatory
  `executionIds`/`evidenceRecords`, executor-signed Deliveries, dispatch-binding,
  `evaluationSpecification` digest equality) against the requester-facing binding;
- the natively-authored projector-determinism + reorg suite, reusing
  `@jinn-network/record-discovery-testing`'s `reorged` + `derivation-consistency` conformance
  vectors as building blocks (neither kit exports a profile-parameterized or
  projector-determinism describe-function to re-expose, per Finding F6); its vectors cover
  ordered split batches, replay idempotency, cross-batch joins/capacity/top-up, monotonic
  sequences, Submission-only retraction, Attempt `lost` → genuine-terminal correction, and
  fail-closed canonical selection for malformed or ungrounded corrections;
- the today-generation anvil-fork escrow-lifecycle fixtures and the Attempt-URI two-party
  agreement checks (requester/operator/third-party independent computation).

The evaluation-leg and revised-contract suites remain later milestones in the same plan.

Consumed by component packages as a **devDependency only, never a production dependency** — but
note this kit does not itself appear in `binding`/`projector`/`pipeline`'s `package.json`
(see `binding`'s README for why: a two-way portal cycle breaks the standalone `node-modules`
linker). "The relevant conformance kit run" for those packages is this package's own `yarn test`.
