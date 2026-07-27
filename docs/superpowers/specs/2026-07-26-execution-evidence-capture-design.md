# Execution Evidence Capture Design

**Status:** Draft for review
**Capability:** Execution Evidence Capture
**Delivery stop line:** Design only. Do not begin bridge implementation, host
migration, or cutover.

## 1. Purpose

Execution Evidence Capture is the producer-side application capability that
observes one live agent execution and preserves complete Jinn Execution
Evidence.

The capability must be independently usable by:

- the Jinn plugin running inside Hermes;
- a marketplace operator that does not use the Jinn plugin; and
- an unrelated third-party agent host.

Capture must not depend on the Jinn plugin, Autopilot, a marketplace package, a
particular agent host, a repository binding, or a repository checkout. Its
durable output is a conforming Execution Evidence record and its exact
content-addressed artifacts.

This design builds on the settled Evidence Protocol, Evidence Repository,
Execution Recorder, Discovery, Local Evidence Runtime, Attestation Issuer, and
Derivation/Publication boundaries. It does not redefine them.

## 2. Decision summary

Execution Evidence Capture is an application capability, not a new domain
package or central service.

```text
Host lifecycle
    |
    v
Host-specific Capture adapter
    |
    +-- TypeScript host ----------> Execution Recorder
    |
    `-- non-TypeScript host ------> Recorder Bridge ------> Execution Recorder
                                                                  |
                                                                  v
                                                        Evidence Repository
```

The Execution Recorder remains the sole shared semantic capture contract.
Host adapters translate host-native lifecycle events directly into Recorder
declarations. The Recorder Bridge is a language-neutral transport binding for
that same contract, not a second `begin`/`observe`/`finish` abstraction.

One host-owned bridge process may multiplex several execution recordings. One
repository and security context are configured for each bridge process. Each
recording still has its own Execution ID and durable Recorder workspace.

## 3. Why this shape

Three architecture shapes were considered.

| Shape | Benefit | Cost | Decision |
| --- | --- | --- | --- |
| New reusable Capture library above the Recorder | One apparently simpler host API | Duplicates Recorder lifecycle, validation, recovery, and declaration semantics | Rejected |
| Long-running Capture service or daemon | Natural cross-language and remote boundary | Adds service discovery, authentication, global state, another failure domain, and operator burden | Rejected |
| Host-specific integrations only | Minimal central code | Every non-TypeScript host reinvents transport, recovery, and error behavior | Rejected alone |
| Recorder plus host adapters and an optional host-owned bridge | Preserves one semantic contract while providing cross-language access | Requires a small versioned transport and host supervision | Chosen |

This follows the useful separation in producer-side telemetry systems without
turning Execution Evidence into ordinary sampled telemetry. OpenTelemetry keeps
language-native instrumentation and SDK processing close to the producer,
defines exporter boundaries, and reserves out-of-process collection for cases
that need it. Its SDK specification also requires processors to serialize
export calls for one exporter while allowing separate pipelines
([OpenTelemetry Tracing SDK](https://opentelemetry.io/docs/specs/otel/trace/sdk/)).
The Collector models receivers, processors, and exporters as separately
configured pipeline components
([OpenTelemetry Collector configuration](https://opentelemetry.io/docs/collector/configuration/)).

The Jinn-specific conclusion is:

- keep host observation in the host;
- keep durable evidence semantics in the Recorder;
- use a private child process only to cross a language/runtime boundary; and
- keep indexing, transformation, and publication downstream.

Persistent telemetry queues also demonstrate the value of restart-isolated,
durable producer state: queued material can continue after process restart
([OpenTelemetry Collector exporter helper](https://pkg.go.dev/go.opentelemetry.io/collector/exporter/exporterhelper)).
The Recorder workspace already provides this guarantee, so the bridge must not
add a competing queue or journal.

## 4. Responsibilities and dependency direction

### Host

The host owns:

- the agent lifecycle and termination authority;
- deciding what constitutes one actual run;
- the mapping from host, session, task, and attempt identifiers to a Jinn
  Execution ID;
- selection of `required` or `best-effort` capture policy;
- durable storage of Execution ID, workspace path, and final receipt in host
  control state;
- native transcript production or durable hook-trace staging;
- repository and bridge security configuration; and
- retention, deletion, consent, and operational policy.

### Host-specific Capture adapter

The adapter owns:

- translating host-native events into Recorder calls;
- starting capture durably before the first agent action;
- identifying observed, reported, and externally observed facts correctly;
- serializing operations for one execution;
- supervising and restarting a bridge when one is used;
- resuming interrupted recordings;
- mapping every terminal host outcome to `completed`, `failed`, or `abandoned`;
  and
- surfacing capture state without representing incomplete capture as
  finalized evidence.

The adapter is host-specific by design. There is no shared adapter lifecycle
interface above the Recorder.

### Observation scope

The host adapter may expose configuration that selects optional observations
before they are captured, such as resource metrics or additional environment
descriptors. That configuration belongs to the host integration because only
the host knows what it can observe and what is material to the execution.

Observation scope cannot:

- omit material required by the Evidence Protocol while still claiming
  complete finalized evidence;
- rewrite bytes already presented for capture;
- turn the Recorder into a scrubber or disclosure-policy engine; or
- change producer-observed facts into inferred trust claims.

This is capture-scope selection, not redaction. Once supplied, bytes are
preserved exactly. Disclosure-safe transformations happen later through
Derivation.

### Execution Recorder

The Recorder owns:

- exact-byte snapshotting;
- the durable, private, append-only recording workspace;
- idempotence, conflict detection, and crash recovery;
- construction of the Execution Evidence graph;
- protocol validation;
- immutable finalization;
- repository writes; and
- recovery of the same final receipt after interruption.

### Recorder Bridge

The bridge owns:

- versioned JSON framing over standard input/output;
- JSON-safe conversion of Recorder declarations;
- transient handle lookup for attached recordings;
- per-recording operation serialization;
- concurrency between independent recordings;
- stable transport errors; and
- delegation to one injected Recorder and Repository.

The bridge does not own an execution registry, durable queue, agent process,
capture policy, repository selection per request, indexing, or publication.

### Downstream systems

Evidence Repository owns exact-byte persistence. Local Evidence Runtime may
add durable announcements and asynchronous indexing. Discovery owns disposable
read projections. Attestation, evaluation, derivation, and publication remain
separate application capabilities.

Dependency direction is one-way:

```text
host adapter
    -> Recorder public API, or Recorder Bridge protocol
        -> Execution Recorder
            -> Evidence Protocol
            -> Evidence Repository contract
                -> selected repository binding

repository announcements
    -> indexing and Discovery

repository records
    -> attestation, evaluation, derivation, and publication
```

No Evidence substrate package imports a host, plugin, Autopilot, or marketplace
package.

## 5. Identity and correlation

The existing Recorder identity model is authoritative:

- one actual agent run has one Jinn Execution ID and one Recorder workspace;
- the Recorder generates or accepts a `urn:uuid:` Execution ID;
- resuming infrastructure around the same continuing run reuses that
  Execution ID and workspace;
- launching a retry or new run creates a new Execution ID;
- a finalized execution is immutable; and
- one marketplace attempt may correlate several Execution IDs.

Hermes session IDs, plugin session IDs, marketplace attempt IDs, task IDs, and
other host identifiers remain external correlations. Adapters record needed
correlations through protocol identifiers or extensions with explicit property
IRIs; they do not replace the Execution ID.

The Recorder cannot decide whether a host event represents a resume or a new
run. That interpretation belongs to the host and must be covered by its adapter
conformance tests.

The adapter also supplies stable entity IDs, actor IRIs, license IRIs, runtime
component identities, identifier-property IRIs, and capture origins. The
Recorder validates and preserves those declarations but does not infer them
from host names or marketplace state. If the Evidence Protocol cannot represent
a required fact, the integration reports a protocol defect rather than hiding
the fact in a parallel record model.

## 6. Lifecycle and recovery

The durable state machine is the Recorder's existing state machine:

```text
absent
  |
  | start succeeds durably
  v
open
  |
  | finalize intent is persisted
  v
finalizing
  |
  | artifacts and record are stored; receipt is persisted
  v
finalized
```

- Missing required material leaves the recording `open`.
- A crash in `open` resumes capture from the same workspace.
- A crash in `finalizing` resumes idempotent Repository writes.
- `finalized` is immutable and always returns the same receipt.
- A new retry starts from `absent` with a new Execution ID and workspace.

Bridge attachment is transient and is not another durable state. After bridge
restart, the host explicitly attaches the workspace with `resume`.

### Start

Before launching the executor, the adapter durably starts a recording with:

- exact Task bytes and identity;
- initial inputs;
- exact repository or source state when applicable;
- Executor Agent and evidence producer;
- Runtime Specification and controlled or opaque components;
- execution start time;
- host correlations; and
- an existing or generated Execution ID.

The host may begin the agent action only after `start` succeeds in `required`
mode.

### Record

While open, the adapter records newly discovered material inputs, runtime
observations, and the richest available native trace. Operations are
idempotent for the same identity and bytes. Reusing an identity with conflicting
bytes or metadata is an error.

Concurrent host callbacks are serialized by the adapter or bridge for one
workspace. Exact duplicate declarations succeed idempotently. Conflicting
duplicates and stale handles preserve the Recorder's conflict errors rather
than being silently reordered or overwritten.

### Finalize

Every terminal host outcome maps to exactly one evidence outcome:

| Host outcome | Evidence outcome |
| --- | --- |
| Successful run with a Result | `completed` |
| Executor or run failure | `failed` |
| Cancellation, lost worker, or deliberate termination | `abandoned` |

A completed execution requires at least one Result. Failed and abandoned
executions preserve Results when they genuinely exist but may have none.
Every outcome requires a primary trace. Missing required material returns
diagnostics and leaves the recording open.

Finalization is idempotent. A successful finalization makes the recording
immutable and returns a durable unsigned receipt.

### Bridge interruption

The bridge has no durable state beyond Recorder workspaces and the configured
repository. After a bridge crash, the host relaunches it with the same
repository configuration and explicitly calls `resume` for each continuing
workspace.

If interruption occurs during repository writes, Recorder recovery reuses
already written content-addressed objects and completes or recovers the same
receipt.

### Capture policy

Every host integration explicitly declares one policy:

- `required`: capture must start before execution. An unrecoverable capture
  failure asks the host to prevent or terminate the run.
- `best-effort`: the host may continue after unrecoverable capture failure, but
  it reports evidence as unavailable or incomplete and cannot advertise a
  successful receipt.

Transient bridge or repository failures first use retry and Recorder recovery.
The Recorder and bridge report state; they never terminate the executor
themselves.

Capture exposes no new application-wide status enum. Direct integrations use
the Recorder's `open`, `finalizing`, and `finalized` statuses, finalization
diagnostics, domain-preserving errors, and final receipt. A host may add
operational states such as “capture unavailable” for its own `best-effort`
policy, but those states do not enter the Evidence Protocol or bridge contract.

## 7. Captured graph and native trace

Each recording captures the protocol-shaped evidence graph:

- one exact Task;
- material input artifacts;
- repository state when applicable;
- Runtime Specification and controlled or opaque components;
- executor, producer, and other relevant actors;
- timestamps and outcome;
- exact Results; and
- one primary execution trace.

Every captured declaration identifies its origin as producer-observed,
executor-reported, or externally observed. Origin is provenance, not a trust
score.

The adapter maps host facts to the Recorder's existing Task, artifact,
repository-state, agent, runtime, observation, trace, Result, and record
declarations. The Recorder owns structural graph construction and protocol
validation. Neither the adapter nor the bridge invents another event,
trajectory, episode, outcome, receipt, or record schema.

For every host, the richest available host-native transcript or trace is the
primary trace. The adapter supplies exact bytes, media type, a stable format
IRI identifying the actual host format, and relevant correlations.

The repository owns an immutable, content-addressed copy. A source path is a
staging convenience only: the Recorder reads, hashes, and copies its bytes
before acknowledging the operation. A source path or URL may be recorded as
provenance, but finalized evidence never depends on it remaining available.
The bridge does not fetch arbitrary URLs.

If a host exposes no native transcript, its adapter may construct a durable,
append-only hook trace. That trace uses its own declared format and
producer-observed provenance. It must never be represented as the host's native
trace. Following a host crash, the adapter attaches the complete available
prefix when finalizing the execution as failed or abandoned.

Normalized, scrubbed, summarized, or public-friendly traces are derived
artifacts. They do not replace or mutate the private original.

## 8. Recorder Bridge contract

The bridge is a Node 22 executable and importable server package named
`@jinn-network/execution-recorder-bridge`.

One bridge process:

- is launched and supervised by one host process;
- has one Repository instance and security context;
- may serve several recordings concurrently;
- serializes mutations within one workspace;
- exposes no network listener; and
- writes protocol responses only to standard output and diagnostics only to
  standard error.

Hosts that require another repository or credential boundary launch another
bridge process.

### Transport

Version 1 uses newline-delimited JSON over standard input/output. Each request
and response contains the protocol identifier
`jinn.execution-recorder.bridge/v1` and a caller-generated request ID.
Independent responses may complete out of request order, so callers correlate
them by request ID.

The semantic methods mirror the Recorder:

- `start`
- `resume`
- `captureInput`
- `captureRuntimeObservation`
- `attachNativeTrace`
- `finalize`

`hello` is transport-only and returns bridge, Recorder, and protocol version
information. Future transport-only health, cancellation, or shutdown operations
must not create alternative evidence semantics.

Mutation requests identify the workspace and expected Execution ID. A bridge
restart does not silently infer host intent: the host must attach the workspace
again with `resume`.

Artifact sources have two JSON-safe representations:

- a local regular-file path plus media type and optional name; or
- base64-encoded exact bytes plus media type and optional name.

The bridge converts either form to the Recorder's existing `ArtifactSource`.
It rejects ambiguous sources, invalid base64, malformed requests, unsupported
protocol versions, unknown methods, unattached recordings, and Execution ID
mismatches before invoking a mutation.

Recorder and Repository failures preserve their domain and stable error code.
Bridge failures use bridge-specific stable codes. Responses never expose stack
traces, credentials, artifact bytes, or private source contents.

### Repository composition

The importable bridge server accepts an injected `EvidenceRepository`, keeping
the core usable with local or remote bindings.

When a host composes Local Evidence Runtime, it passes
`runtime.repository` to the Recorder or bridge. Capture never depends on the
Runtime's Catalog, Indexer, Journal, or concrete filesystem layout.

The initial executable composes the filesystem Repository binding from an
explicit repository root supplied at process startup. Adding another official
binding is an additive bridge-launch composition, not a protocol change.
Repository credentials never appear in per-recording commands.

### Package and source-tree structure

There is no `execution-evidence-capture` package. The future cross-language
transport belongs in one sibling Evidence package:

```text
packages/evidence/execution-recorder-bridge/
```

Its semantic dependencies point only to the Execution Recorder and Evidence
Repository public contracts. The filesystem executable may compose the
Repository's public filesystem subpath at the outermost process entrypoint.
The bridge core does not import Local Evidence Runtime or another concrete
binding.

Host adapters remain with their hosts. A future Hermes adapter therefore stays
under the Jinn plugin's source tree, while marketplace and third-party adapters
stay in their own applications. They are not moved into the Evidence package
tree.

Capture owns no persistent filesystem format beyond the Recorder workspace.
Native transcript files and hook-generated staging traces remain host-owned
until the Recorder snapshots them. The bridge has no recovery files, registry,
queue, or interchange workspace of its own.

## 9. Receipt, indexing, and trust semantics

A successful Recorder receipt contains:

- Execution ID;
- content-addressed Evidence record reference;
- referenced artifact identities; and
- finalization timestamp.

The host durably persists the receipt with its correlation state. If the
process stops after repository storage but before the host saves the receipt,
`resume` recovers the same receipt.

A receipt means the exact artifacts and conforming record are durably stored.
It does not mean the execution is correct, verified, signed, indexed, scrubbed,
published, or accepted by a marketplace.

When Local Evidence Runtime is used, repository announcements feed
asynchronous indexing. Index failure degrades Discovery but does not invalidate
capture. A caller that requires discoverability waits for indexing as a
separate application step.

Attestation issuers may later sign observation or verification claims.
Evaluators may assess Results. Derivation may produce scrubbed or normalized
records. Publication may transfer explicitly selected originals or
derivatives. None can mutate the original record or Recorder receipt.

## 10. Privacy and security

Captured evidence is private by default. Local and remote describe persistence,
not disclosure status.

Capture preserves exact supplied bytes and performs no implicit redaction,
summarization, or sanitization. It also does not intentionally copy credential
values merely to describe a runtime; secret-bearing components use safe
identifiers or opaque descriptors.

The application must enforce:

- owner-only Recorder workspaces and staging files where supported;
- regular-file and safe-path validation;
- no payload, credential, or sensitive-path logging;
- repository credentials supplied only in the bridge startup context;
- separate bridge processes for separate users or credential boundaries;
- authenticated transport and encryption policy in remote bindings;
- deliberate correlation minimization; and
- host-owned backup, retention, deletion, consent, and data-handling policy.

Required capture is not permission to publish or collect unrelated ambient
data. A shareable form is a new derived record with explicit provenance.

## 11. Required flows

### Hermes with the Jinn plugin

The Hermes adapter allocates an Execution ID and workspace, starts recording
through the bridge before the first agent action, records hook observations,
preserves Hermes's native transcript, finalizes the terminal outcome, and
stores the receipt with Hermes session correlations. Bridge restart resumes the
workspace. Unexpected Hermes termination finalizes the available trace and
honest failed or abandoned outcome.

For a completed execution, the Task, selected environment observations,
Runtime Specification, material inputs, primary trace, and Results are present
before finalization. The receipt returns as soon as Repository persistence
succeeds. Local indexing may complete asynchronously, and no publication
occurs.

### Failed or abandoned execution

The adapter attaches the richest available trace, supplies any Results that
actually exist, and declares the observed `failed` or `abandoned` outcome.
Missing primary trace material prevents finalization and remains visible as
diagnostics. A `best-effort` host may continue its primary work after capture
failure, but it cannot present the run as finalized evidence.

### Interrupted finalization

If the process stops after some Repository writes, the host relaunches the
bridge with the same Repository, calls `resume` for the workspace, and lets the
Recorder complete its persisted finalization intent. Content-addressed writes
are reused and the same receipt is returned.

### Marketplace operator without the plugin

The operator starts a local adapter near each worker before launch, records the
accepted Task, inputs, source state, runtime, executor, trace, and Results, and
writes through its configured Repository. Its attempt state stores one or more
Execution receipts. Assignment, evaluation, settlement, and wallet behavior
remain external.

### Independent third-party host

The host maps its lifecycle to the Recorder directly in TypeScript or through
the bridge. It chooses its repository and capture policy without importing the
Jinn plugin, Autopilot, marketplace code, or a concrete repository package into
the Evidence substrate.

Across all flows, interruption is resumable, executor failure does not erase
captured evidence, incomplete material does not finalize, and only a successful
receipt supports a finalized-evidence claim.

## 12. Conformance

The Recorder producer-contract suite remains authoritative and must run against:

- direct TypeScript Recorder usage; and
- the Recorder Bridge path.

Bridge-specific tests cover:

- protocol version and request correlation;
- JSON-safe exact-byte decoding;
- source-path snapshot behavior;
- direct mapping of every Recorder method;
- stable error-domain preservation;
- per-workspace serialization;
- concurrency across independent workspaces;
- explicit resume after bridge restart;
- Execution ID mismatch rejection;
- clean standard output and sanitized standard error;
- actual child-process operation with the filesystem Repository; and
- packed-package imports and binary execution.

Host adapters add conformance scenarios for start-before-execution, host
identity mapping, native trace selection, durable fallback trace staging, every
terminal outcome, capture policies, and host/bridge crash recovery.

Passing conformance establishes behavioral compatibility. It does not establish
truth, trust, completeness of host observation, Result quality, or permission
to disclose.

## 13. Future pre-migration implementation boundary

When separately authorized, the first foundation build would include:

- the `@jinn-network/execution-recorder-bridge` package;
- the versioned standard-input/output protocol;
- the importable bridge server with Repository injection;
- the filesystem-backed executable;
- bridge producer-contract and process tests;
- package build, typecheck, and packed-install smoke coverage;
- relevant Evidence package CI inclusion; and
- bridge operator and integrator documentation.

A future foundation build must stop before migration or cutover.

That future foundation build must not modify:

- `apps/jinn-agent/plugins/jinn/`;
- Hermes hook registration or session state;
- the current in-memory capture buffer;
- `EpisodeV1` production or consumers;
- Autopilot or marketplace execution adapters;
- existing host runtime behavior;
- feature flags or production configuration;
- evidence publication, attestation, or derivation flows; or
- release channels, package publication, deployment, or cutover state.

A future foundation may prove Hermes compatibility using synthetic fixtures and
contract drivers, but it must not wire the bridge into a live Hermes path.

## 14. Later migration and deferred work, not authorized here

When separately authorized, Hermes migration will replace end-of-session
in-memory-only capture with live Recorder calls through the bridge. During a
bounded compatibility period, `EpisodeV1` may continue beside Capture for
legacy consumers, but it never moves into the Recorder or bridge. Execution
Evidence is the authoritative captured record, and legacy marketplace fields
remain application concerns.

Existing `EpisodeV1` records are not retroactively promoted to complete
Execution Evidence. Historical import may preserve known material and
explicitly report gaps, but cannot reconstruct missing runtime state, original
bytes, or provenance.

Native SDKs in other languages, a network daemon, per-request repository
selection, automated redaction, attestation, publication, and historical
reconstruction remain deferred.

One non-blocking packaging follow-up remains for a future foundation build:
the stacked monorepo needs an approved Yarn development-resolution strategy for
the Recorder's transitive Evidence Protocol dependency. That build concern must
not add a new semantic dependency or change the architecture above.

## 15. Explicit non-goals

Capture does not own:

- evidence search, retrieval, ranking, recommendation, or corpus membership;
- public/private federation;
- evaluation, verification, signing, key resolution, or trust inference;
- task scheduling, Attempt lifecycle authority, agent launch, or termination;
- marketplace assignment, settlement, reputation, rewards, or wallet state;
- derivation, skill generation, task mining, scrubbing, or publication;
- retention enforcement or Repository deletion;
- a new Evidence Protocol record family;
- a replacement Repository, object store, Journal, Indexer, Catalog, or Local
  Evidence Runtime;
- a public network service or machine-wide daemon;
- a cross-host execution registry;
- a generic host event or trajectory schema; or
- the Recorder's private workspace as an interchange format.

Host-owned temporary trace staging may be cleaned up under host retention
policy. Capture introduces no separate temporary-workspace lifecycle that
would justify deletion authority.

## 16. Future foundation acceptance criteria

A future foundation implementation will be complete when:

1. A non-TypeScript-style test client can start, record, attach an exact trace,
   and finalize one execution through the child-process bridge.
2. Retrieved metadata and artifact bytes pass the existing Evidence Protocol,
   Repository, and Recorder producer-contract checks.
3. The same workspace can be resumed through a fresh bridge instance and
   recover the same receipt.
4. Two independent recordings can progress concurrently while mutations for
   one workspace remain serialized.
5. Invalid transport input and dependency failures return stable, sanitized,
   domain-preserving errors.
6. The packed executable works with a filesystem Repository on Node 22.
7. The diff contains no host migration, legacy capture, consumer cutover,
   publication, or deployment changes.
