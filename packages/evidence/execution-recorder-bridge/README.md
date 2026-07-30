# `@jinn-network/execution-recorder-bridge`

A host-owned, language-neutral standard-input/output transport for the Jinn
Execution Recorder. It maps versioned JSON requests directly onto
`@jinn-network/execution-recorder`'s public lifecycle and returns its
responses unchanged — it defines no new capture semantics of its own.

## Process ownership and scope

One bridge process owns exactly one injected `EvidenceRepository` and may
multiplex several Recorder workspaces concurrently within that single
process. It has no durable state outside the Recorder workspaces it drives:
restarting the bridge process loses nothing that a `resume` request cannot
recover (see [Resume after restart](#resume-after-restart)).

This package does not migrate, wrap, or replace any existing host, CLI, or
producer integration. It is an additional, optional transport standing
alongside direct in-process use of `@jinn-network/execution-recorder`; no
task in its implementation plan touches a host, a release channel, or a
cutover path.

## Wire protocol

Requests and responses are newline-delimited JSON objects — one JSON value
per line, no embedded newlines. The bridge reads and writes UTF-8.

### Request envelope

```ts
{
  protocol: "jinn.execution-recorder.bridge/v1",
  id: string,      // non-empty; echoed back on the matching response
  method: "hello" | "start" | "resume" | "captureInput"
    | "captureRuntimeObservation" | "attachNativeTrace" | "finalize",
  params: object,
}
```

### Response envelope

```ts
// success
{ protocol: "jinn.execution-recorder.bridge/v1", id: string, ok: true, result: unknown }

// failure
{
  protocol: "jinn.execution-recorder.bridge/v1",
  id: string,
  ok: false,
  error: { domain: "bridge" | "recorder" | "repository", code: string, message: string, details?: object },
}
```

### Methods

| Method                      | Params                                     | Result                                                        |
| ---------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| `hello`                       | `{}`                                         | `{ bridgeVersion, recorderVersion, protocol }`                   |
| `start`                       | Recorder's `StartExecutionRecordingInput`, with every `ArtifactSource` replaced by a wire artifact source (below) | `{ executionId, status, receipt? }` |
| `resume`                      | `{ workspaceDir }`                           | `{ executionId, status, receipt? }`                               |
| `captureInput`                | `{ target, input }`                          | `{ executionId, status, receipt? }`                               |
| `captureRuntimeObservation`   | `{ target, observation }`                    | `{ executionId, status, receipt? }`                               |
| `attachNativeTrace`           | `{ target, trace }`                          | `{ executionId, status, receipt? }`                               |
| `finalize`                    | `{ target, outcome, endedAt, results?, nativeTrace? }` | Recorder's `FinalizeExecutionResult`, unchanged                |

`target` identifies the mutation's attached recording:

```ts
{ workspaceDir: string, executionId: `urn:uuid:${string}` }
```

`hello` and `start` never require a `target` (there is nothing attached yet);
every other method does.

### Wire artifact sources

The wire never carries an `AbortSignal`, and it never carries a Node.js
`Buffer` or `Uint8Array` directly — bytes are base64-encoded:

```ts
{ kind: "bytes", base64: string, mediaType: string, name?: string }
{ kind: "path", path: string, mediaType: string, name?: string }
```

`base64` must be the canonical re-encoding of its own bytes; the bridge
rejects any other encoding of the same content as `INVALID_REQUEST`. A
`path` source names a location the bridge process itself can read at the
moment the request is dispatched — the Recorder snapshots its exact bytes
during `start` (or during the capture call that references it), so a later
mutation of that file has no effect on what was recorded.

## Request correlation and cross-workspace concurrency

Every request carries a caller-assigned `id`; every response echoes it
unchanged, including `PARSE_ERROR` responses for a standard-input line that
was not valid JSON at all — those use `id: ""` because no caller ID could be
recovered from unparseable input. The bridge accepts and dispatches requests
concurrently and writes responses in the order their dispatch resolves,
which need not match the order the requests arrived in. A caller that sends
multiple requests before reading responses must correlate them by `id`, not
by response order.

Operations targeting the same `workspaceDir` are serialized: a `finalize`
for workspace A never runs concurrently with another operation on workspace
A. Operations on independent workspaces make progress independently — a
slow write on one workspace never blocks a `hello`, or any operation on a
different workspace.

## Resume after restart

The bridge keeps its attached `ExecutionRecording` handles only in transient
process memory. After a process restart (or when a second bridge process
wants to drive a workspace a first process opened), send an explicit
`resume` request with the workspace's `workspaceDir` before sending any
mutation for it — the bridge never resumes a workspace implicitly. `resume`
also completes any finalization that was interrupted mid-write (see
[Errors](#errors)): if the Recorder recovers a receipt during `resume`, that
receipt appears in the `resume` response's `result.receipt`.

## Errors

Every error response's `domain` identifies which layer produced it:

- `"bridge"` — the bridge's own request-shape and dispatch errors (see
  `RECORDER_BRIDGE_ERROR_CODES` in `src/errors.ts`: `PARSE_ERROR`,
  `INVALID_REQUEST`, `UNSUPPORTED_PROTOCOL`, `METHOD_NOT_FOUND`,
  `RECORDING_NOT_ATTACHED`, `EXECUTION_ID_MISMATCH`, `INTERNAL_ERROR`).
- `"recorder"` — an `ExecutionRecorderError` from
  `@jinn-network/execution-recorder`, identified by its own `code`.
- `"repository"` — an `EvidenceRepositoryError` from the injected
  `EvidenceRepository`, identified by its own `code`.

`message` is always a bridge-owned, sanitized description keyed off `code` —
never the dependency's own `Error#message`, which can embed a local
filesystem path (for example, a Recorder `UNSAFE_PATH` failure). `details`
never carries `cause`, a stack trace, request payloads, artifact bytes,
repository credentials, or a source path. Standard output carries protocol
responses only; standard error is reserved for the bridge's own startup
diagnostics (see [Filesystem CLI](#filesystem-cli)) and never carries
payload bytes, credentials, sensitive paths, or a stack trace either.

## Capture-policy separation

The bridge has no capture policy of its own: it does not decide what to
capture, when to capture it, or how to react to a `CaptureDiagnostic` (for
example a missing native trace or missing completed-outcome result). Every
such decision belongs to the process on the other end of the wire — the
bridge only maps its requests onto the Recorder's existing lifecycle and
returns the Recorder's own diagnostics unchanged.

## Filesystem CLI

The published binary composes a real filesystem `EvidenceRepository` and
serves the protocol over its own standard input and output:

```console
$ jinn-execution-recorder-bridge --repository-root ./evidence-state
```

`--repository-root` is required and may be given once; it accepts an
absolute or relative path (relative paths resolve against the process's
current working directory, same as `createFilesystemEvidenceRepository`).
Missing, duplicated, or unrecognized arguments exit `2` with a one-line
usage message on standard error. A Repository that fails to initialize (for
example, an existing path that is not a directory) exits `1` with one
sanitized line on standard error — never the raw dependency error, which may
embed the repository path.

## Private data and exact-byte warnings

Task text, artifact bytes, native trace content, and Result content all
pass through this process. None of it is redacted, summarized, or
transformed — the bridge's entire job is exact-byte transport. Treat
standard input, standard output, and the Repository's storage root with the
same care you would give the underlying evidence: nothing here is
access-controlled or encrypted by this package.

## Composing with the Local Evidence Runtime

The bridge accepts any `EvidenceRepository`, so a host that already runs
`@jinn-network/evidence-local-runtime` can inject its `runtime.repository`
instead of a bare filesystem Repository — that composition happens entirely
in the host process, before it constructs the bridge or the filesystem CLI:

```ts
import { openLocalEvidenceRuntime } from "@jinn-network/evidence-local-runtime";
import { createExecutionRecorderBridge } from "@jinn-network/execution-recorder-bridge";

const runtime = await openLocalEvidenceRuntime({ rootDir: "evidence-state" });
const bridge = createExecutionRecorderBridge({ repository: runtime.repository });
```

The published `jinn-execution-recorder-bridge` binary always composes a bare
filesystem Repository; wiring it to a Local Evidence Runtime instead is a
host-side composition choice this package does not make for you.
