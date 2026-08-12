# @jinn-network/marketplace-testing

Conformance testing kit for the Jinn marketplace binding tree. Consumes
`@jinn-network/marketplace-{binding,projector}`, `@jinn-network/task-execution-testing`, and
`@jinn-network/record-discovery-testing` as production dependencies. Its evaluation-leg suite
also consumes `@jinn-network/trust-testing` so its decision-grade vectors resolve genuine sealed
KeyBinding fixtures rather than hand-shaped resolver objects — the marketplace-tree
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
- the reusable `describeNamedChecks` evaluation-leg suite: exact pair-derived bytes, strict
  verdict-code mapping, requester self-claim-on-solve, evaluator distinctness, and settlement
  trust joins against parsed, sealed `@jinn-network/trust-testing` bindings;
- the today-generation snapshot-backed Anvil escrow-lifecycle fixtures and the Attempt-URI two-party
  agreement checks (requester/operator/third-party independent computation).

The revised-contract suite remains a later milestone in the same plan.

The **venue conformance kit** (operator-daemon composition design §6.6) is the subject-parameterized
suite the tier-3 chain adapters must satisfy. It publishes four subpath exports from
`@jinn-network/marketplace-testing/venue-conformance`: the legacy-derived revert-classification
fixtures and their driver (`VENUE_REVERT_FIXTURES`, `describeVenueRevertClassification`), the
broadcast-profile driver (`describeBroadcastProfileConformance`, seven relayer obligations), the
log-source driver (`describeLogSourceConformance`, seven chunking and dual-cursor obligations), and
the snapshot-backed Anvil integration backbone (`withForkVenue`, `describeForkVenueConformance`;
the `Fork` names are retained for API compatibility). Every driver
declares its own subject interfaces and imports nothing from
`@jinn-network/marketplace-venue-base`, so the kit's fixtures are authoritative before an
implementation exists; `src/venue-conformance.test.ts` is the runner that binds the real
`createBaseVenue` facade to all four. Run it with:

```bash
yarn vitest run src/venue-conformance.test.ts
```

The Anvil blocks need Foundry's `anvil` on `PATH` and load the repository's committed
`client/test/_support/fixtures/anvil-base-v3-state/state.json`; they perform no live RPC calls.
Source-tree consumers may point `JINN_MARKETPLACE_ANVIL_STATE_PATH` at another local copy of that
same fixture. A missing or unreadable fixture fails loudly and never falls back to a network.
Without `anvil`, local package runs report these blocks skipped; Marketplace CI installs the pinned
Anvil version, so the blocking PR check always executes them.

Live Base Sepolia drift and the canonical deployed-address configuration belong to
`.github/workflows/environment-suite.yml`, whose real T2/T3 loops run separately from PR
verification. They are intentionally not evidence produced by this deterministic conformance kit.

Consumed by component packages as a **devDependency only, never a production dependency** — but
note this kit does not itself appear in `binding`/`projector`/`pipeline`'s `package.json`
(see `binding`'s README for why: a two-way portal cycle breaks the standalone `node-modules`
linker). "The relevant conformance kit run" for those packages is this package's own `yarn test`.
