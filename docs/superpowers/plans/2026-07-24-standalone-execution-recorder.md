# Standalone Execution Recorder Implementation Plan

**Date:** 2026-07-24

**Status:** Approved

**Base design:** [Jinn Execution Recorder Design](../specs/2026-07-24-jinn-execution-recorder-design.md)

## Summary

Create `packages/execution-recorder` as
`@jinn-network/execution-recorder@0.1.0`: a producer-neutral Node/TypeScript
library that durably captures one live execution, constructs one conforming
Execution Evidence record, and commits exact bytes through an injected
`EvidenceRepository`.

The package depends only on:

- `@jinn-network/evidence-protocol@0.1.0`;
- `@jinn-network/evidence-repository@0.1.0`; and
- the Node 22 standard library.

It does not depend on repository bindings, Autopilot, the plugin, marketplace
code, Git, signing, evaluation, verification, publication, or scrubbing.

This implementation covers the recorder package only. Producer-specific
adapters follow separately and consume the same public API.

## Task 1: Package and frozen contracts

Create the independent ES2022/Yarn 4.13.0 package with a package-local
lockfile, TypeScript configuration, root exports, `./testing` export, and
fixture wildcard export.

Freeze the public lifecycle:

```ts
createExecutionRecorder({
  repository: EvidenceRepository,
}): ExecutionRecorder;
```

`ExecutionRecorder` exposes `start()` and `resume()`.
`ExecutionRecording` exposes:

```ts
readonly executionId: `urn:uuid:${string}`;
readonly status: "open" | "finalizing" | "finalized";
readonly receipt?: FinalizedExecutionReceipt;

captureInput(...): Promise<void>;
captureRuntimeObservation(...): Promise<void>;
attachNativeTrace(...): Promise<void>;
finalize(...): Promise<FinalizeExecutionResult>;
```

`StartExecutionRecordingInput` contains:

- caller-owned `workspaceDir`;
- optional `urn:uuid:` Execution ID;
- strict RFC 3339 `startedAt`;
- record name, description, and producer-supplied absolute license IRI;
- exact Task;
- initial inputs and optional exact repository-state aggregate;
- Executor and Producer Agents using absolute IRIs;
- a Runtime Specification with at least one controlled component or
  content-bound opaque-component observation;
- optional extension properties; and
- optional `AbortSignal`.

`FinalizeExecutionInput` contains an outcome, strict RFC 3339 `endedAt`, zero
or more exact Results, and an optional final native trace.

Export concrete capture types for byte/path artifact sources, files,
non-empty acyclic aggregates, Tasks, repository state, Results, runtime
components, opaque descriptors, traces, resource/environment observations,
Agents, identifiers, capture origins, and JSON-valued extensions.

Repeating the same entity ID, role, digest, normalized metadata, and origin is
a no-op. Reusing an identity incompatibly is a recording conflict. Extensions
cannot replace recorder-owned identity, digest, lifecycle, timestamp, or
relationship fields.

Stable expected diagnostics:

- `NATIVE_TRACE_MISSING`;
- `COMPLETED_RESULT_MISSING`.

Stable exceptional error codes:

- `INVALID_CAPTURE_INPUT`;
- `RECORDING_NOT_FOUND`;
- `WORKSPACE_VERSION_UNSUPPORTED`;
- `RECORDING_CONFLICT`;
- `WORKSPACE_CORRUPT`;
- `CAPTURED_OBJECT_CORRUPT`;
- `UNSAFE_PATH`;
- `RECORDING_FINALIZED`;
- `OPERATION_ABORTED`;
- `IO_FAILURE`;
- `PROTOCOL_CONFORMANCE_FAILED`.

Repository errors propagate unchanged.

Use TDD for input validation, aggregate validation, extension collision
rules, error codes, and public exports.

Commit: `feat(execution-recorder): define recorder contracts`

## Task 2: Durable workspace

Implement an attempt-scoped private workspace:

```text
workspace.json
objects/sha256/<prefix>/<remaining-hex>
journal/<zero-padded-revision>.json
```

The immutable marker records format version and Execution ID. Captured bytes
are copied to same-directory temporary files, flushed, published without
overwriting, and referenced by an immutable journal transition. Journal
entries contain revision, predecessor digest, event type, and payload.

Replay ignores temporary files and rejects gaps, broken chains, corruption,
unsupported versions, or stale concurrent writers. New directories and
files default to `0700` and `0600`. Reject workspace symlinks, traversal,
non-regular artifact sources, captured-object corruption, and incompatible
concurrent mutation.

Use TDD for source mutation after capture, object identity, replay, partial
writes, corruption, permissions, symlinks, stale writers, and cancellation.

Commit: `feat(execution-recorder): add durable recording workspace`

## Task 3: Pure evidence mapper

Map immutable recording state to the existing flattened RO-Crate model:

- record metadata becomes the Root Dataset and Metadata Descriptor;
- Task, inputs, repository state, runtime, trace, and Results become
  content-bound entities;
- Execution becomes `CreateAction + prov:Activity`;
- runtime components and aggregates use `hasPart`;
- Results use `prov:wasGeneratedBy`;
- trace uses `about` and `conformsTo`;
- duration is generated from the Execution timestamps;
- Root creator/date and a capture Activity identify capture provenance; and
- per-capture origins use W3C PROV qualified attribution with stable
  recorder-specific role URNs, never trust scores.

Create minimal contextual Agent, license, format, and role entities where
needed. Preserve extensions after reserved-key checks.

Serialize deterministically using fixed graph ordering, recursively sorted
object keys, two-space indentation, and one trailing newline. Do not claim
RFC 8785 conformance.

Use TDD for completed, failed, and abandoned documents; exact artifact and
relationship mappings; all capture origins; deterministic bytes; extension
preservation; and reference-validator conformance.

Commit: `feat(execution-recorder): construct execution evidence`

## Task 4: Resumable lifecycle

Implement:

- idempotent `start()` for new or identically initialized workspaces;
- `resume()` with complete object and journal verification;
- incremental input, runtime-observation, and native-trace capture;
- immediate byte snapshotting before successful return;
- status and persisted receipt exposure; and
- rejection of finalized mutation.

The producer serializes mutation. The recorder detects stale instances and
conflicting concurrent writes.

Use TDD for generated/supplied IDs, start retry, resume, capture idempotence,
capture conflicts, primary trace selection, finalized reopening, and aborted
operations.

Commit: `feat(execution-recorder): capture resumable execution state`

## Task 5: Finalization and recovery

Finalization:

1. snapshots final Results and trace material;
2. returns sorted missing-material diagnostics if incomplete;
3. chooses and persists one `finalizedAt`;
4. builds deterministic metadata bytes;
5. validates those exact bytes with `validateExecutionEvidence`;
6. persists a finalization intent containing its fingerprint, metadata
   digest, and sorted unique artifact digests;
7. writes artifacts in digest order, journaling every success;
8. writes the `execution-evidence` record after all artifact writes;
9. persists and returns the receipt.

`resume()` retries a pending repository commit. Repeating the same
finalization returns the same receipt; changing it after intent or success is
a conflict. `EvidenceRepositoryError` remains unchanged.

Use TDD with failure injection before and after every repository operation,
including resumed writes, repeated finalization, changed intent, validation
failure, artifact-first ordering, and exact receipt recovery.

Commit: `feat(execution-recorder): finalize conforming execution evidence`

## Task 6: Producer contract and distribution

Export from `@jinn-network/execution-recorder/testing`:

- `ExecutionProducerContractDriver`;
- contract scenario and observation types; and
- `describeExecutionProducerContract(...)`.

Scenarios cover completed, failed, abandoned, and interrupted-finalization
executions. The kit independently retrieves metadata/artifacts, validates the
record, checks integrity, and verifies the producer started capture before
execution and retained its Execution ID and receipt.

Ship fixtures, README, compiled output, and packed-install smoke coverage.
The smoke test installs packed Protocol, Repository, and Recorder tarballs in
a temporary consumer and proves the root, `./testing`, and fixture exports
without a binding or producer dependency.

Add `execution-recorder-ci.yml` to perform immutable installs, dependency
builds, typecheck, tests, build, and pack smoke in Protocol → Repository →
Recorder order.

Commits:

- `feat(execution-recorder): add producer contracts and fixtures`;
- `ci(execution-recorder): verify standalone package`.

## Global constraints

- The Evidence Protocol is normative and remains unchanged.
- The recorder emits exactly one Execution Evidence record for one
  Execution.
- Workspace format v1 is private resumability state, not interchange.
- Exact bytes define artifact and record identity.
- A successful finalization always references a conforming record.
- Finalization is not evaluation, verification, signing, or a truth claim.
- Repository selection is injected; no binding is mandatory.
- The package is publish-ready but is not published in this work.
- Autopilot, marketplace, scrubbing, public derivation, discovery, historical
  import, evaluation, verification, and retention remain out of scope.
- New source is Apache-2.0 with SPDX headers, and every commit is DCO signed.

## Verification

From the package directories, using Node 22 or newer:

```text
evidence-protocol: yarn check:profile, yarn typecheck, yarn test, yarn build
evidence-repository: yarn typecheck, yarn test, yarn build
execution-recorder: yarn typecheck, yarn test, yarn build, yarn pack:smoke
```

Run `git diff --check` and an independent whole-branch specification,
durability, security, and code-quality review before handoff.
