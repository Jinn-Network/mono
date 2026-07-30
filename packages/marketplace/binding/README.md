# @jinn-network/marketplace-binding

The chain-venue Task Execution Protocol (TEP) v1 binding: maps sealed Task / Submission /
Delivery documents onto the deployed OLAS-native Base substrate (TaskCoordinator + JinnRouterV3
+ OLAS Mech Marketplace), behind a two-contract-generation seam (`today` targets the deployed
contracts unchanged; `revised` targets the specified contract revision, built later).

See the design: `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md`. Implementation
plan: `docs/superpowers/plans/2026-07-28-marketplace-binding.md`.

## Scope landed so far (M0 + M1)

- The `ContractGeneration = "today" | "revised"` seam and the deployed today-mode address config
  (`src/generation.ts`, `src/addresses.ts`, design §5.4).
- Per-package sealing utilities for the binding's own backend-internal canonical bytes only —
  never a re-seal of a TEP or discovery document family (`src/order.ts`, `src/canonical-json.ts`,
  program §7.1/§7.14/§7.15).
- The marketplace Attempt-URI derivation: a thin adapter over
  `@jinn-network/task-execution-protocol`'s exported `deriveAttemptUri` +
  `TEP_ATTEMPT_NAMESPACE` — never re-derived (`src/attempt-uri.ts`, plan Milestone M1, must #2).
- The named, binding-side type declaration of the two-party engagement entry
  (`src/two-party-engagement.ts`) — the exact shape the pipeline will hand to the embedded local
  backend's assembly `submit` once that package lands (plan Finding F1; see below).

Document translation, posting, claiming, delivery convergence, the evaluation leg, and the
requester-facing `TaskExecutionBackend` implementation are later milestones (M2+), not in this
package yet.

## The two-party engagement entry (Finding F1)

`TwoPartyEngagement` names the surface the marketplace pipeline will pass to
`@jinn-network/task-execution-backend-local`'s assembly `submit` as an optional third parameter:
`submit(taskBytes, submissionBytes, engagement?: TwoPartyEngagement): Promise<SubmissionAck>`.
This widens the already-implemented, frozen `TaskExecutionBackend.submit(taskBytes,
submissionBytes)` (`packages/task-execution/backend/src/backend.ts:37`, Phase 2, merged) with an
optional parameter — additive, not a breaking change to the frozen 2-arg call sites. This plan
does **not** edit `backend/src/backend.ts`; the widening is dispositioned as a dated addendum on
the local-execution-backend plan and built into that package's assembly from day one (see plan
Finding F1 for the full reasoning: a Submission-document-field realization is impossible because
the deterministic URI depends on `attemptIndex`, known only at claim time; a separate `engage()`
method is disallowed by ruling §7.18).

## A note on the package.json dependency graph

This package's own production dependencies are exactly the five it needs for M0-M1 source:
`task-execution-{protocol,backend,profiles}` and `trust-{core,resolve}`. It deliberately does
**not** declare `@jinn-network/marketplace-testing` as a devDependency (a deviation from the
plan's M0.1 Step 1 literal preview): declaring it creates a two-way portal cycle
(`binding` devDep→`testing` prod-dep→`binding`), which empirically breaks Yarn's `node-modules`
linker for standalone portal projects (it refuses to write into a portal target's `node_modules`
outside the current project root). The rest of the already-built stack follows a one-directional
pattern instead — `task-execution-backend`/`task-execution-profiles`/`trust-resolve` do not
devDep their sibling testing/kit packages either; only the testing/kit package depends on the
components it exercises. `marketplace-testing`'s own conformance suite is what runs "the relevant
conformance kit" against this package, invoked as its own `yarn test`, not via an import from
here.
