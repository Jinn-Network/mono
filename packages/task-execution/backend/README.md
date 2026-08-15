# @jinn-network/task-execution-backend

The Jinn Task Execution Protocol (TEP) v1 backend contract: the operational interface a binding
implements to submit work, observe its lifecycle, recover after a restart, and retrieve results.
Depends on `@jinn-network/task-execution-protocol` only — no other Jinn package, no I/O of its
own.

See the design: `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md`
§14 (backend contract) and §15 (capability model). Carried-amendment implementation notes:
`docs/superpowers/specs/2026-07-28-tep-v1-implementation-addendum.md`.

## The frozen contract surface (§22)

- **`TaskExecutionBackend`** (§14) — `capabilities`, `submit`, `observe`, `recover`,
  `deliveries`, `fetchDelivery` are mandatory; `preflight`, `watch`, `cancel`, `fetchArtifact`
  are optional capabilities.
- **`BackendCapabilities`** (§15 + carried amendment 1) — a declarative statement of what a
  backend supports, including the `runPinning` block (profiles §5.2: supported pinning keys,
  their inventories, and the `enforced` | `attested` enforcement posture).
- **Supporting types** — `SubmissionAck`, `ObservationSnapshot`, `ObservationCursor`,
  `ReconciliationReport` (`matching | absent | contradictory`), `CancelAck`
  (terminal-state-aware), `DeliveryRef`, `PreflightRequest` / `PreflightReport`.
- **Policy-neutral preclaim helpers** — `validateRequirementsAgainstRunPinning` and
  `verifyPreclaim` establish only whether a backend can honor a requested profile, requirements,
  isolation pin and preflight. Product claim, spend and prioritisation policy stays above this
  package.
- **`TaskExecutionError`** — carries a §13 category (imported from `task-execution-protocol`;
  the enum has exactly one source), a `retryable` flag, optional `detail`, and namespaced native
  annotations. The error-category enum lives in `protocol`; this class is the one place the
  vocabulary surfaces as a throwable error (Global Constraints — no duplicate enum).

## The four prohibitions (§14)

The contract must never expose: shared-mutation capability (no repository pushes, no GitHub
verbs), credential passthrough, application-lifecycle authority, or settlement operations.

## Honesty rules a conforming backend must satisfy

- `submit` takes both sealed documents as **exact bytes**, never parsed-and-reserialized objects.
- `observe` never infers success from liveness; it distinguishes running, terminal, and unknown.
- `recover` is mandatory — a backend that cannot recover is not a conforming backend.
- A pinning key a backend does not declare in `runPinning` is a typed `unsupported-requirement`
  rejection at `submit`, never a silent degradation.

`@jinn-network/task-execution-testing` (a sibling package) ships the csi-sanity-style
`describeTaskExecutionBackendContract` suite that proves these rules against any implementation,
starting with its own in-memory fake.
