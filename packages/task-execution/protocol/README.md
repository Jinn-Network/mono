# @jinn-network/task-execution-protocol

Pure, I/O-free reference implementation of the Jinn Task Execution Protocol (TEP) v1: types,
JSON Schemas, sealing + digest functions, the observation fold, family validators, and
deterministic Attempt-URI derivation. No I/O, no Jinn dependencies — Evidence Protocol
references are structural `{ family, digest }` fields, not a package dependency.

See the design: `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md`.
Carried-amendment implementation notes: `docs/superpowers/specs/2026-07-28-tep-v1-implementation-addendum.md`.

## The frozen public surface

Records: `TaskSpecification`, `SubmissionRecord`, `DeliveryRecord`, `DispatchContext`,
`ProtocolObservation`, `ResourceDescriptor`, `EvidenceRecordReference`, `AttemptDescriptor`
(a projection materialized by a backend's `observe()`, §9/§22).

Pure functions: `sealTask` / `sealSubmission` / `sealDelivery` (JCS + I-JSON enforcement),
`documentDigest`, `validateTask` / `validateSubmission` / `validateDelivery` /
`validateDispatchContext` / `validateObservation`, `foldObservations` (§10.4),
`deriveAttemptUri` (§9.2 UUIDv5, exports the frozen `TEP_ATTEMPT_NAMESPACE`), and
`mergeRequirements` (the profiles §5.1 tighten-only run-pinning merge, carried amendment 1).

## The seal-once rule (§6.1)

Every sealed document family (Task, Submission, Delivery) canonicalizes exactly once with
RFC 8785 JCS under I-JSON at sealing. Those bytes are the document forever — no consumer ever
re-canonicalizes to check a digest. `documentDigest(bytes)` always hashes the exact bytes
received, never a re-derived form.

## Fixtures

`fixtures/golden-task-execution-v1/` — a complete local-and-marketplace scenario pair over one
Task digest, plus a key-order-sensitive equivalence record (`equivalence/`). `fixtures/adversarial-v1/`
— the §24 adversarial minimum set; this package ships the fixture bytes plus a `manifest.json`
describing each case's expected disposition. `@jinn-network/task-execution-testing` (a sibling
package, not built by this milestone) drives the conformance assertions against them.
