# `@jinn-network/execution-recorder`

Durable, producer-neutral capture of Jinn execution evidence.

The recorder accepts facts observed by any execution producer, snapshots their
exact bytes, constructs an Execution Evidence Protocol document, and writes the
document and artifacts through an injected `EvidenceRepository`. It has no
dependency on an Autopilot, CLI, scheduler, sandbox, model provider, or concrete
repository binding.

## Boundary

This package owns capture lifecycle, crash-recoverable workspace state,
protocol-conforming evidence construction, and persistence through the
repository contract. It deliberately does not:

- evaluate an execution or its result;
- verify identities or signatures, sign claims, or decide trust;
- publish evidence or select a filesystem, OCI, or other repository binding;
- scrub, redact, derive, or prepare captured material for disclosure; or
- implement retention, deletion, indexing, marketplace, or access policy.

A finalized receipt is an unsigned set of content references. It is not an
evaluation, verification, endorsement, or publication decision.

## Repository injection

Install this package with the producer's chosen implementation of
`@jinn-network/evidence-repository`, then inject the contract:

```ts
import type {
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import {
  createExecutionRecorder,
} from "@jinn-network/execution-recorder";

export function recorderFor(repository: EvidenceRepository) {
  return createExecutionRecorder({ repository });
}
```

The same durable repository must be supplied when recovering an interrupted
finalization. Repository errors remain repository errors; recorder input,
workspace, conflict, cancellation, I/O, and conformance failures use
`ExecutionRecorderError` and its stable `code`.

## Lifecycle and recovery

1. Call `start(...)` with a dedicated `workspaceDir`, initial task, actors,
   runtime, and any initial inputs. Repeating the same start declaration is
   idempotent; an incompatible declaration conflicts.
2. While the recording is `open`, call `captureInput(...)`,
   `captureRuntimeObservation(...)`, and `attachNativeTrace(...)`. Byte sources
   are copied and path sources are read into the workspace before the operation
   resolves.
3. Call `finalize(...)` with the outcome, end time, results, and optionally the
   native trace. Missing evidence returns `{ finalized: false, diagnostics }`
   without pretending the recording is complete.
4. Persist a successful receipt and treat the workspace as immutable. A
   successful result is `{ finalized: true, receipt }`.
5. After a process interruption, call `resume({ workspaceDir })`. An `open`
   recording can continue, a `finalizing` recording resumes idempotent
   repository writes, and a `finalized` recording exposes its durable receipt.

Only one mutation stream may advance a workspace at a time. Stale handles and
incompatible retries fail with `RECORDING_CONFLICT`; producers must serialize
capture operations and recovery.

## Consumer obligations

The producer remains responsible for:

- starting capture before the executor and recording accurate observed facts;
- distinguishing producer-observed, executor-reported, and externally observed
  origins, including the responsible observer or reporter;
- choosing stable entity identifiers and supplying correct media types,
  timestamps, licenses, runtime descriptions, and outcome;
- protecting the workspace and any source paths because captured bytes may be
  confidential or unsafe to publish;
- retaining the workspace and receipt for as long as recovery or later access
  is required, and applying its own deletion policy;
- reusing the same repository after interruption and independently validating
  or verifying retrieved evidence before relying on it; and
- installing the optional `vitest` peer only when using the producer contract
  test export.

For path-backed sources, the recorder rejects symbolic links and snapshots the
regular file visible during capture. Producers should still prevent concurrent
writes to source files while they are being observed.

## Workspace format

The workspace is a private, versioned, attempt-scoped recovery format. Version 1
contains a `workspace.json` marker, an append-only hash-linked journal, and
content-addressed captured objects. It is not an interchange format or a public
evidence crate, and consumers must not inspect or mutate its internals.

On POSIX systems recorder-owned directories and files are restricted to modes
`0700` and `0600`. Those permissions are defense in depth, not encryption or
scrubbing. The recorder never uploads the workspace and never removes it;
confidentiality, backup, retention, and deletion remain the consumer's
responsibility. Unsupported versions, tampering, missing objects, and unsafe
paths fail closed during replay.

## Testing producers

The optional testing export supplies the reusable producer contract:

```ts
import {
  describeExecutionProducerContract,
} from "@jinn-network/execution-recorder/testing";

describeExecutionProducerContract(() => createProducerContractDriver());
```

Synthetic contract assets are exported below
`@jinn-network/execution-recorder/fixtures/producer-contract-v1/*`. They cover
completed, failed, abandoned, and interrupted-finalization recovery behavior;
they do not represent a historical execution.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

Licensed under Apache-2.0.
