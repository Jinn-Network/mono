# Jinn Execution Recorder Design

**Date:** 2026-07-24

**Status:** Approved design

**Scope:** A producer-neutral, durable TypeScript recorder that turns one live execution into one
conforming Jinn Execution Evidence record and commits it to an injected Evidence Repository.

## 1. Summary

Jinn has two settled foundation layers:

1. the [Execution Evidence Protocol](../../../packages/evidence-protocol/README.md), which defines
   and validates portable execution evidence; and
2. the [Evidence Repository](../../../packages/evidence-repository/README.md), which persists exact
   record and artifact bytes by SHA-256 without interpreting them.

What is missing is the producer-facing boundary between a live execution and those foundations.
An execution producer currently has to decide independently when to capture the Task, how to
preserve starting repository state, how to retain runtime configuration and native traces, how to
assemble a protocol record, and how to recover if the process stops halfway through.

`@jinn-network/execution-recorder` fills that gap. It is a published Node/TypeScript library with
three primary lifecycle phases:

```text
start → record → finalize
          ↑
        resume
```

The recorder captures mutable facts while they still exist, maintains a private attempt-scoped
workspace, constructs and validates one Execution Evidence record, stores its exact artifacts and
metadata through an injected repository, and returns a durable receipt.

It is not another evidence protocol, an execution runtime, a repository implementation, a
verification service, or a publication system.

## 2. Architecture

```text
External producer
  Autopilot / local plugin / marketplace operator
                       |
                       v
          Producer-owned adapter
                       |
                       v
      @jinn-network/execution-recorder
             |                  |
             v                  v
    Evidence Protocol   Evidence Repository contract
                                  |
                    +-------------+-------------+
                    |                           |
                    v                           v
             filesystem binding          OCI binding
```

The dependency direction is one-way:

- the recorder depends on the Evidence Protocol and Evidence Repository contract;
- producer adapters depend on the recorder;
- repository bindings implement the repository contract;
- Jinn packages never depend on a producer such as Autopilot; and
- the recorder never depends on a particular repository binding.

The package uses Node's standard library for its private recording workspace. It has no dependency
on Autopilot, the plugin, marketplace code, the filesystem repository binding, or the OCI binding.

### 2.1 Why Autopilot is an external adapter

Autopilot is moving to its own repository. This is the first real test of the boundary rather than
an inconvenience to work around.

The Autopilot repository owns code that translates its `AttemptManifest`, issue, worktree,
selected agent runtime, session output, and terminal attempt state into recorder calls. The Jinn
repository owns only the generic recorder and producer contract tests. Neither repository reaches
into the other's private types or files.

Autopilot consumes released package versions in the same way as any third-party producer. A later
local plugin or marketplace operator can implement the same integration without acquiring
Autopilot semantics.

### 2.2 Control-plane placement

The recorder belongs to the producer's supervising control plane, outside the executor whose work
it records. This follows the supply-chain separation in the
[SLSA build model](https://slsa.dev/spec/v1.2/terminology), where the control plane initializes the
execution and produces provenance while tenant-controlled steps run in a separate environment.

```text
Producer-controlled supervisor
  |-- producer adapter
  |-- Execution Recorder
  |-- private recording workspace
  `-- executor boundary
        `-- agent or worker process
```

The executor may report trace data, observations, and Results through producer-controlled
channels. It must not be treated as the authority for facts directly observed by the supervisor
and, in an isolated deployment, must not be able to mutate the recorder workspace.

The recorder does not claim that every deployment provides strong process or operating-system
isolation. Local tools may run the supervisor and executor under the same user. The captured
provenance must therefore distinguish supervisor-observed facts from executor-reported or
externally observed facts so that later verification policy can assess the actual boundary rather
than infer one from the use of this package.

## 3. Ownership boundary

### 3.1 The recorder owns

- creation or acceptance of the protocol Execution ID;
- a private, versioned, crash-resumable recording workspace;
- immediate stable copies and SHA-256 identities of supplied byte-bearing material;
- the operational recording state machine;
- idempotent capture operations;
- construction of flattened Execution Evidence metadata;
- validation with the Evidence Protocol reference validator;
- ordered, retry-safe writes through the Evidence Repository contract; and
- persistence and return of the finalized recording receipt.

### 3.2 The producer adapter owns

- deciding what the Task is;
- selecting materially supplied and consumed inputs;
- capturing a repository base commit and tree or another exact source snapshot;
- identifying the Executor Agent and evidence producer;
- describing the effective runtime and every controlled component available to it;
- identifying opaque hosted components without inventing unavailable implementation bytes;
- generating or locating the native trace;
- declaring whether each captured fact was observed by the producer, reported by the executor, or
  obtained from an external observer;
- deciding whether the execution completed, failed, or was abandoned;
- selecting exact Results;
- mapping producer lifecycle identifiers to the protocol Execution ID;
- deciding how recorder failures affect the producer's own lifecycle; and
- retaining or deleting the surrounding attempt workspace.

The recorder preserves facts supplied by the adapter. It does not discover which facts matter,
inspect a producer process, invoke Git, infer identities, or decide whether a producer's claims are
truthful.

### 3.3 Explicitly outside the recorder

The recorder does not own:

- execution or agent lifecycle;
- task marketplace state or economics;
- Result Evaluation or Execution Verification issuance;
- evaluator or verifier behavior;
- signature keys, identity resolution, or trust policy;
- scrubbing or derivation of public evidence;
- automatic publication;
- cataloging, search, ranking, or corpus views;
- retention policy or deletion;
- historical transcript mining; or
- migration from `EpisodeV1` or legacy stores.

Result Evaluations and Execution Verifications are one-shot attestations, not execution-length
recordings. A future attestation-issuer boundary may provide typed in-toto/DSSE construction,
caller-supplied signing, validation, and repository commit for those records. It is not part of
this package.

## 4. Public TypeScript surface

The exact field decomposition may be refined during implementation, but the public lifecycle and
ownership represented here are normative for this design:

```ts
export interface ExecutionRecorderOptions {
  readonly repository: EvidenceRepository;
}

export interface StartExecutionRecordingInput {
  readonly workspaceDir: string;
  readonly executionId?: `urn:uuid:${string}`;
  readonly startedAt: string;
  readonly task: TaskCapture;
  readonly initialInputs: readonly InputCapture[];
  readonly repositoryState?: RepositoryStateCapture;
  readonly executor: ExecutorCapture;
  readonly runtime: RuntimeCapture;
  readonly producer: ProducerCapture;
  readonly signal?: AbortSignal;
}

export interface ResumeExecutionRecordingInput {
  readonly workspaceDir: string;
  readonly signal?: AbortSignal;
}

export interface ExecutionRecording {
  readonly executionId: `urn:uuid:${string}`;

  captureInput(
    input: InputCapture,
    options?: RecordingOperationOptions,
  ): Promise<void>;

  captureRuntimeObservation(
    observation: RuntimeObservationCapture,
    options?: RecordingOperationOptions,
  ): Promise<void>;

  attachNativeTrace(
    trace: NativeTraceCapture,
    options?: RecordingOperationOptions,
  ): Promise<void>;

  finalize(
    outcome: FinalizeExecutionInput,
    options?: RecordingOperationOptions,
  ): Promise<FinalizeExecutionResult>;
}

export function createExecutionRecorder(
  options: ExecutionRecorderOptions,
): ExecutionRecorder;
```

The recorder instance exposes `start()` and `resume()` operations returning an
`ExecutionRecording`. The producer supplies one attempt-scoped `workspaceDir`; there is no
recorder-managed global root or implicit registry.

### 4.1 Artifact sources

Byte-bearing inputs accept exact bytes or a local regular-file path:

```ts
export type ArtifactSource =
  | {
      readonly bytes: Uint8Array;
      readonly mediaType: string;
      readonly name?: string;
    }
  | {
      readonly path: string;
      readonly mediaType: string;
      readonly name?: string;
    };
```

A path is an input convenience, not evidence identity. The recorder copies and hashes its bytes
during the capture operation. The final record never relies on the source path continuing to
exist and does not expose that private path unless the producer deliberately supplies it as
protocol metadata.

Higher-level capture types correspond directly to protocol roles rather than introducing a new
generic step model:

- Task;
- input artifact;
- exact repository or source state;
- controlled runtime component;
- opaque runtime observation descriptor;
- native trace; and
- Result.

The recorder does not shell out to Git or archive a directory implicitly. A producer that claims
an exact Git tree supplies a content-bound representation of that tree and its declared Git
identity.

### 4.2 Capture origin

Every capture declaration identifies how the producer obtained the fact. The public capture types
carry an origin equivalent to:

```ts
export type CaptureOrigin =
  | {
      readonly kind: "producer-observed";
      readonly observer: AbsoluteIri;
    }
  | {
      readonly kind: "executor-reported";
      readonly reporter: AbsoluteIri;
      readonly capturedBy: AbsoluteIri;
    }
  | {
      readonly kind: "external-observed";
      readonly observer: AbsoluteIri;
      readonly capturedBy: AbsoluteIri;
    };
```

This is capture provenance, not a trust score. The recorder maps it to the protocol's existing
Agent and provenance relationships; it does not add a new record family or decide whether an
observer is trustworthy.

For example, the operator can directly observe the Task bytes it supplied and the container digest
it launched, while a token count reported only by the hosted model remains executor- or
external-reported. A verification policy can treat those signals differently later.

### 4.3 Idempotence keys and conflicts

Every repeatable capture operation identifies its intended protocol entity. Repeating an operation
with the same entity identity, role, and bytes succeeds without changing the workspace. Reusing an
identity with different bytes or incompatible metadata produces a stable conflict error.

Exactly one artifact is selected as the primary native trace. Additional derived projections may
be supplied as ordinary artifacts or protocol extensions, but cannot replace the primary trace.

Unknown extension fields allowed by the Evidence Protocol are preserved. Extensions cannot
override recorder-owned core identities, lifecycle, relationships, digests, or provenance.

## 5. Durable workspace

The caller supplies a new or existing directory dedicated to one execution recording:

```ts
const recording = await recorder.start({
  workspaceDir: join(attemptDir, "evidence"),
  // ...
});
```

The recorder owns the format and contents beneath that directory. The producer owns the
surrounding attempt directory and its retention.

The workspace contains, conceptually:

- a format and state marker;
- the Execution ID;
- immutable captured objects addressed by SHA-256;
- capture declarations and provenance;
- finalization intent while a commit is in progress; and
- the final receipt after success.

Its exact layout is an implementation detail, not an interchange standard. Versioning exists only
to let compatible recorder releases resume their own durable state. Other implementations
interoperate through finalized Evidence Protocol records, not by exchanging recorder workspaces.

Mutable workspace state uses an append-only journal or an equivalent transactional mechanism. This
follows the same durability principle as a persistent write-ahead log used by resilient collection
pipelines; OpenTelemetry recommends persistent WAL-backed storage when losing captured data during
a restart is unacceptable. See
[OpenTelemetry Collector resiliency](https://opentelemetry.io/docs/collector/resiliency/).

Before a successful capture operation returns, the recorder:

1. writes the captured bytes to a same-workspace temporary object;
2. flushes the bytes;
3. atomically publishes the content-addressed object;
4. appends or atomically publishes a monotonically revisioned state transition;
5. flushes the transition and relevant directory metadata where the platform supports it; and
6. only then reports success.

Recovery replays committed transitions, verifies their referenced object digests, and ignores
incomplete temporary objects or transitions. The implementation must not use an in-place mutable
JSON document as the sole durable state.

New directories and files default to owner-only permissions. The recorder rejects symbolic-link
traversal, path escapes, non-regular artifact inputs, incompatible workspace versions, and
corrupted state. It does not follow source paths after capture.

The producer must serialize mutation of one recording. The recorder detects incompatible
concurrent or stale-revision writes and returns a conflict rather than silently losing captured
facts.

## 6. Lifecycle

### 6.1 Start

`start()` records the information that must be preserved before an executor changes the world:

- exact Task bytes and identity;
- initially supplied inputs;
- repository base commit and tree or another source snapshot, when applicable;
- Executor Agent identity;
- the Runtime Specification and controlled components available to the producer;
- opaque component observations for unavailable hosted components;
- evidence producer and capture provenance;
- execution start time; and
- an existing or generated `urn:uuid:` Execution ID.

Creation succeeds only after this starting material is durably captured. A producer should call it
before launching the executor.

### 6.2 Record

While the execution is open, the adapter may durably attach:

- additional inputs discovered to have been materially consumed;
- resource or opaque runtime observations; and
- the richest available native trace.

Capture operations snapshot supplied bytes before returning. The producer may stop and later call
`resume()` from another process using the same workspace.

### 6.3 Finalize

`finalize()` means: finish the mutable recording, create its immutable Execution Evidence object,
and store that object.

The caller supplies:

- execution outcome: completed, failed, or abandoned;
- completion time;
- exact Results when present; and
- any final native-trace material not already attached.

The recorder then:

1. captures the final supplied material;
2. checks that the recording contains the facts required for its declared outcome;
3. constructs the canonical flattened Execution Evidence serialization;
4. validates the exact metadata bytes with the Evidence Protocol;
5. stores referenced artifact bytes through the injected repository;
6. stores the metadata bytes as an `execution-evidence` record;
7. persists a final receipt in the workspace; and
8. returns that receipt.

A completed execution requires a Result. Failed and abandoned executions may have none, as defined
by the protocol.

### 6.4 Finalization guarantee

If finalization returns a receipt, the exact referenced metadata bytes conform to the Execution
Evidence Protocol at the time they were finalized.

This guarantee is structural, not epistemic. Finalization does not establish that:

- supplied claims are true;
- an executor performed the work;
- a trace is authentic or complete;
- a Result is correct; or
- an actor or key should be trusted.

The receipt is an unsigned operational result, not an Execution Verification. Consumers can and
should independently validate retrieved bytes. A capture service that wants to make a signed
assertion about what it observed issues a separate Execution Verification under an explicit
policy.

### 6.5 Finalization result

Incomplete capture is an expected result, not an exception:

```ts
export type FinalizeExecutionResult =
  | {
      readonly finalized: true;
      readonly receipt: FinalizedExecutionReceipt;
    }
  | {
      readonly finalized: false;
      readonly diagnostics: readonly CaptureDiagnostic[];
    };

export interface FinalizedExecutionReceipt {
  readonly executionId: `urn:uuid:${string}`;
  readonly record: EvidenceRecordReference;
  readonly artifacts: readonly EvidenceArtifactReference[];
  readonly finalizedAt: string;
}
```

For example, finalizing a completed execution without a Result returns missing-material
diagnostics and leaves the recording open. The producer can add the Result and retry.

### 6.6 Recovery and immutability

Finalization persists its intent before repository writes. Artifacts are written before metadata,
so no stored record can refer to artifacts the recorder has not attempted to commit.

If a process stops during finalization:

- `resume()` recognizes the pending finalization;
- already successful repository writes are reused;
- remaining idempotent writes continue; and
- the same receipt is recovered or completed.

Content-addressed artifacts left unreferenced by an interrupted finalization are harmless. The
recorder does not require a repository transaction or delete API.

Repeating `finalize()` with the same material returns the persisted receipt. Repeating it with
different material after success returns a conflict. A finalized recording cannot be reopened or
edited.

A correction or public derivative is a new evidence record with explicit provenance, created by a
separate derivation workflow. Recorder v1 does not implement that workflow.

## 7. Errors

Expected missing capture facts are reported through `FinalizeExecutionResult`. Exceptional
failures throw `ExecutionRecorderError` with stable codes covering:

- invalid capture input;
- recording not found;
- incompatible workspace version;
- recording conflict or concurrent mutation;
- corrupted workspace or captured object;
- unsafe path or symbolic-link traversal;
- finalized-record mutation;
- operation cancellation; and
- recorder workspace I/O failure.

Evidence Repository failures retain their existing `EvidenceRepositoryError` type, stable code,
and cause. The recorder does not flatten access denial, dependency failure, repository corruption,
or network unavailability into an undifferentiated recorder error.

An operation either durably advances the workspace or leaves it resumable. It must never report
success before captured bytes and the associated state transition are durable.

## 8. Privacy and repository selection

Recording workspaces contain unsanitized private Task, input, trace, runtime, and Result material.
The recorder:

- never scrubs implicitly;
- never publishes implicitly;
- never chooses a repository binding;
- never interprets a repository as public or private; and
- never transfers a record between repositories.

The producer explicitly injects the repository. Autopilot's first integration uses the filesystem
binding. A producer may later inject an OCI repository, but that is an explicit publication and
access decision outside recorder policy.

Public derivation remains a separate transformation that creates safe derived artifacts and a new
metadata record under the protocol's derivation rules. Copying exact private bytes from a
filesystem repository to OCI is transport, not scrubbing.

## 9. Producer integrations

### 9.1 Autopilot

The first external integration follows this sequence:

```text
Create Autopilot attempt
    |
    +-- allocate or receive Execution ID
    +-- start recording before executor spawn
    +-- persist Execution ID in AttemptManifest
    |
Run attempt
    |
    +-- preserve native trace
    +-- capture runtime observations and additional inputs
    |
Reach terminal attempt state
    |
    +-- finalize completed, failed, or abandoned execution
    +-- persist repository reference and receipt in AttemptManifest
```

The attempt ID and Execution ID are related but distinct concepts. Autopilot retains an explicit
mapping even when both happen to use UUIDs.

Autopilot decides whether inability to finalize evidence blocks, degrades, or merely annotates its
own attempt. The recorder returns facts and errors; it does not acquire authority over the
Autopilot state machine.

The first integration stops after local finalization. It does not add OCI publication, scrubbing,
evaluation, execution verification, catalog registration, corpus mining, or marketplace behavior.

Its acceptance criterion is:

> A real Autopilot attempt can be interrupted, resumed, completed, and finalized into a conforming
> Execution Evidence record whose exact artifacts and metadata round-trip through a filesystem
> Evidence Repository.

### 9.2 Task marketplace operator

A task marketplace operator uses the same recorder without a marketplace-specific package change:

| Marketplace concept | Recorder or protocol role |
| --- | --- |
| Task listing or accepted assignment | Task and initial inputs |
| Marketplace attempt | External product record referencing one or more Execution IDs |
| Operator daemon or supervisor | Evidence producer and recorder control plane |
| Solver or agent | Executor Agent |
| Harness, container, model, and effective configuration | Runtime Specification |
| Worker logs or OpenTelemetry | Native trace |
| Patch, answer, artifact, or effect receipt | Result |
| Success, failure, or cancellation | Completed, failed, or abandoned outcome |
| Marketplace evaluator | Later Result Evaluation issuer |
| Execution auditor | Later Execution Verification issuer |
| Settlement rules | Consumer policy above the evidence records |

The operator starts recording before launching the worker, finalizes one Execution Evidence record
for each execution, and preserves the returned reference in its attempt state. One marketplace
attempt may reference several Execution IDs when it contains retries or subordinate executions;
the recorder still handles one execution at a time.

Wallet, ERC-8004, assignment, and settlement identities remain marketplace concerns mapped to
protocol IRIs through a later marketplace profile. A distributed operator runs the recorder on or
near the worker where exact bytes can be captured, while the injected repository may be remote.
Signed evidence required for settlement comes from later Evaluation or Verification issuers, not
from the unsigned recorder receipt.

This pressure test requires an adapter and application policy, but no change to the recorder's
TypeScript lifecycle, workspace, protocol output, or repository interface.

## 10. Historical transcripts

Transcript mining is not routed through the successful live-recorder guarantee.

A historical importer may use recorder construction utilities where facts are available, but it
must not reconstruct unknown starting trees, runtime components, or provenance from current state.
If required historical facts are absent, the importer can preserve a nonconforming candidate and
its conformance report directly through repository APIs, which intentionally do not enforce
protocol admission.

This keeps two paths honest:

- future work is captured at execution time and can satisfy the recorder's finalization
  guarantee; and
- historical work remains useful without being upgraded into claims unsupported by its source
  material.

## 11. Testing

The recorder package exports a producer contract kit and ships generic fixtures. It never imports
Autopilot.

The package test suite covers:

- start-time capture before mutable source files change;
- exact byte and digest preservation;
- preservation of producer-observed, executor-reported, and externally observed capture origins;
- correct provenance mapping without treating capture origin as a trust verdict;
- generated and caller-supplied Execution IDs;
- start, resume, and finalized workspace reopening;
- completed, failed, and abandoned execution outcomes;
- completed execution without a Result;
- required runtime components and opaque observation descriptors;
- primary native-trace selection;
- idempotent and conflicting repeated capture;
- missing-material diagnostics without closing the recording;
- crash recovery before and after object publication and journal transition persistence;
- journal replay that ignores incomplete temporary state and detects digest corruption;
- interruption before and after every repository write;
- identical and conflicting repeated finalization;
- workspace version and corruption failures;
- path escape and symbolic-link attacks;
- cancellation;
- repository error preservation;
- final record validation after repository retrieval;
- artifact integrity after retrieval;
- unknown protocol extension preservation; and
- packed installation without repository bindings or producer packages.

The producer contract kit accepts an adapter fixture and checks that the producer:

- starts capture before execution;
- supplies required starting facts;
- exposes a resumable attempt-scoped workspace;
- maps every terminal producer outcome to the correct protocol lifecycle;
- retains the Execution ID and final receipt; and
- produces records accepted by the Evidence Protocol validator.

The Autopilot repository runs that kit against its adapter and adds one end-to-end attempt test
against the filesystem repository. Compatibility is therefore enforced through released public
package APIs rather than coordinated monorepo source changes.

## 12. Settled decisions

- The package is `@jinn-network/execution-recorder`, not the broader
  `@jinn-network/evidence-recorder`.
- Recorder v1 is a Node/TypeScript library, not a daemon or language-neutral CLI.
- Capture is durable and resumable from v1.
- The producer supplies an attempt-scoped workspace.
- The recorder handles Execution Evidence only.
- The recorder belongs to the producer-controlled supervisor, not the executor.
- Capture provenance distinguishes producer-observed, executor-reported, and externally observed
  facts without assigning trust.
- Workspace mutation uses an append-only journal or equivalent atomic transactional mechanism.
- The lifecycle operation is named `finalize()`, not `seal()`.
- A successful finalization always references a conforming record.
- Finalization is not evaluation, verification, signing, or a truth claim.
- The receipt is operational and unsigned.
- Repository selection is injected and policy-free.
- The first external integration is Autopilot using the filesystem repository.
- A task marketplace operator uses the same recorder through its own adapter; attempts may map to
  one or more Execution IDs.
- Historical transcript import, public derivation, discovery, and consumer integration remain
  separate work.
