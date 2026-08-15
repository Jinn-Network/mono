# Evaluation Runner Design

- **Date:** 2026-07-26
- **Status:** approved; implementation planning completed on 2026-07-27. **Superseded in part 2026-07-28** — see the note immediately below.
- **Superseded in part (2026-07-28):** Per the Local Execution Backend design ([`2026-07-27-local-execution-backend-design.md`](./2026-07-27-local-execution-backend-design.md) §10.4, §17), `@jinn-network/evaluation-runner` will **not** be built as a standalone package. The **host-orchestration half** of this design is superseded: the durable-job premise (§1, §3.4); `EvaluationAttemptCheckpointStore` + the recovery ladder (§14.3, §15); `attemptId` idempotency (§8.1); `EvaluationReceiptV1` (§19); the `network.jinn.evaluation.attempt.*` event vocabulary (§7.2); the cooperative-cancellation chain (§15.5); and the execution-provider abstraction (§5.4, §13). The **evaluator-adapter core survives and composes as-is** into the evaluation harness under the local backend: the evaluator-adapter contract (§11); evaluator registrations (§10, including `interruptionBehavior` §10.3); Attestation Issuer composition (§17); and the operational-failure-never-a-failing-verdict rule (§18). Three ideas are adopted stack-wide: `interruptionBehavior`, the seal-once prepared-bytes checkpoint (backend design §9.1), and `recoveryAdvice` (backend design §6.3). The signer posture changes per backend §10.4 — the evaluator Agent key arrives as a `secrets/` reference-forward resolved from a `capabilityGrant`, replacing the host-side signer isolation of §5.5 / §23.4. Implementation: [`../plans/2026-07-28-local-execution-backend.md`](../plans/2026-07-28-local-execution-backend.md); superseded plan: [`../plans/2026-07-27-evaluation-runner.md`](../plans/2026-07-27-evaluation-runner.md).
- **Scope:** a host-neutral application capability that evaluates exact Task and Result
  artifacts through a registered evaluator and issues Result Evaluation Evidence
- **Out of scope:** concrete evaluator implementations and deployment

## 1. Decision

Jinn will provide a reusable, embeddable **Evaluation Runner** focused exclusively on Result
Evaluation.

The Runner is a method-neutral execution kernel. It resolves exact evaluation material, invokes
one host-approved evaluator adapter, checkpoints the completed outcome, preserves selected
supporting evidence, delegates claim construction and signing to the Attestation Issuer, and
returns a stable operational receipt.

The Runner is not a durable service. A production hosting application wraps each invocation in
its own durable evaluation job and supplies its existing database, queue, workflow engine, or
equivalent control plane. The host also supplies evaluator registrations, execution providers,
credentials, repository access, and final submission behavior.

The selected architecture is therefore:

```text
durable host job
      |
      v
embeddable Evaluation Runner
      |
      +--> exact Evidence Retrieval
      +--> registered evaluator adapter
      +--> host-supplied execution provider
      +--> Evidence Repository
      `--> Attestation Issuer
                |
                v
       signed Result Evaluation
                |
                v
 optional host submission, Contribution, or Publication
```

There is no Runner-level distinction among deterministic, model, human, or delayed evaluation.
Those are compatibility scenarios implemented by evaluator adapters and their execution
providers. The Runner has one Result Evaluation lifecycle.

Execution Verification remains a separate claim family and requires a separate sibling design.
Any orchestration mechanics that appear generic remain internal until a second application proves
that extraction is useful.

## 2. Rationale

The Evidence substrate already owns the lower-level semantics and persistence boundaries:

- Evidence Protocol defines immutable Result Evaluation statements bound to exact Task and Result
  subjects.
- Attestation Issuer prepares, signs, validates, and commits conforming DSSE-wrapped in-toto
  statements through an injected signer.
- Evidence Repository preserves exact record and artifact bytes with content-addressed,
  idempotent writes.
- Discovery indexes independent evaluations without choosing a winner.
- Local Evidence Runtime composes local repository and discovery bindings.

What remains above those components is shared application behavior:

- resolve the exact material the evaluator must inspect;
- invoke a replaceable evaluation method without granting it ambient authority;
- distinguish an evaluator conclusion from an operational failure;
- preserve rich findings and selected supporting evidence;
- make expensive or nondeterministic evaluations recoverable;
- bind the completed outcome to the exact subjects, method, specification, evaluator, and evidence;
- and expose one stable request, lifecycle, failure, and receipt contract to different hosts.

Leaving this work to every marketplace, benchmark, plugin, factory, or third-party consumer would
duplicate the most sensitive orchestration and recovery logic. Putting it in the Attestation
Issuer would make the issuer acquire execution, retrieval, and application lifecycle concerns.
Creating a central service would duplicate host control planes and prematurely own workers,
credentials, queues, and deployment policy.

An embeddable Runner with host-owned durability supplies the shared semantics without introducing
another mandatory service.

## 3. Architectural approaches considered

### 3.1 Reusable Evaluation Runner library

A host-neutral library resolves subjects, invokes an evaluator adapter, validates and checkpoints
the outcome, stores selected evidence, and delegates issuance.

This provides consistent safety and evidence behavior while remaining useful locally, in a
marketplace worker, or in a third-party host. On its own, however, a library call does not preserve
a multi-hour job through process loss.

### 3.2 Durable evaluation worker or service

A long-running service accepts jobs, persists state, operates workers, and exposes a network API.

This supplies durability centrally but also acquires deployment, credentials, queues, worker
capacity, tenant isolation, and operational policy. Existing Jinn consumers already have different
control planes and execution environments. Requiring a new service would add complexity before a
shared deployment need is demonstrated.

### 3.3 Consumer-specific orchestration

Each consumer calls evaluator code and Attestation Issuer directly.

This maximizes local freedom but causes exact-subject binding, cancellation, output validation,
artifact retention, failure semantics, signing recovery, and receipts to drift across consumers.

### 3.4 Chosen hybrid

Use the reusable library from approach 3.1 as the shared execution kernel. Require production
hosts to persist a durable evaluation job around it. Permit optional consumer-owned worker or
transport adapters without placing a queue or service inside the Runner package.

This is the standard production split between a durable control plane and replaceable workers:

```text
host control plane --> worker --> Evaluation Runner --> evaluator provider
        |                              |
        `-------- durable state <------'
```

## 4. Result Evaluation boundary

Result Evaluation answers:

> Does this exact Result, or exact set of Results, satisfy this exact Task under the identified
> evaluation specification and method?

Execution Verification answers a different question:

> Is the claimed execution process acceptable under an identified verification policy?

The Runner may evaluate a Result using tests, model judgment, human review, or later observations.
It does not conclude:

- whether the Result was produced through an allowed process;
- whether an execution trace is authentic;
- whether tools or procedures required by a process policy were used;
- whether the Result was copied or substituted during execution;
- or whether an Execution Evidence record is internally trustworthy.

An evaluation method may inspect Execution Evidence as explicitly allowed context when that
material helps judge the Result. It must not silently turn process verification into a Result
Evaluation verdict.

Protocol conformance, artifact integrity, signature validity, identity binding, evaluator trust,
marketplace admission, and Result quality remain separate conclusions.

## 5. Ownership boundary

### 5.1 Evaluation Runner owns

- resolving the requested evaluator registration and configured specification default;
- requesting exact Task, Result, specification, method, relationship, and allowed-context material;
- verifying that the registration supports the resolved specification;
- invoking the evaluator adapter with one attempt identity, deadline, and cancellation signal;
- validating and checkpointing a completed evaluator outcome;
- distinguishing operational failure from `pass`, `fail`, and `inconclusive`;
- snapshotting and storing explicitly selected claim-evidence artifacts;
- composing the exact input for Attestation Issuer;
- checkpointing exact prepared attestation bytes;
- committing those bytes through Attestation Issuer;
- emitting lifecycle events and typed operational failures;
- and returning an Evaluation Receipt.

### 5.2 Hosting application owns

- durable job creation, queueing, leasing, and restart recovery;
- evaluator registration storage and authorization;
- selecting the evaluator registration and evaluation specification;
- containers, remote workers, model clients, human-review systems, and other execution providers;
- provider credentials and signer capabilities;
- retry, escalation, and operator policy;
- private operational logs and telemetry;
- submission to marketplaces, benchmarks, Contribution, or Publication;
- signature verification, identity binding, and trust policy;
- aggregation, ranking, settlement, reward, and reputation.

### 5.3 Evaluator adapter owns

- understanding the selected specification or specification family;
- applying its rubric and outcome mapping;
- translating resolved material into work for its execution provider;
- validating provider-specific output;
- returning the detailed outcome and normalized protocol verdict;
- identifying the time at which its conclusion was made;
- and selecting which reports are claim evidence.

### 5.4 Execution provider owns

- the environment in which method-specific work occurs;
- process, container, remote-worker, model, or human interaction;
- filesystem and network isolation;
- resource quotas and cleanup;
- provider authentication and credentials;
- and provider-specific cancellation.

### 5.5 Attestation Issuer owns

- constructing the in-toto Statement;
- constructing and signing the DSSE envelope;
- protocol conformance validation;
- retaining the exact signed bytes supplied for commit;
- and idempotent record persistence through Evidence Repository.

The Runner composes these responsibilities. It does not duplicate them.

## 6. Package and dependency structure

The reusable package is:

```text
packages/evidence/evaluation-runner
npm: @jinn-network/evaluation-runner
```

`packages/evidence` is a domain grouping, not a claim that the Runner is part of the lower-level
substrate. Architecturally, the package sits above the substrate.

Proposed public subpaths are:

```text
@jinn-network/evaluation-runner
@jinn-network/evaluation-runner/schemas
@jinn-network/evaluation-runner/testing
```

The root exports the Runner and its application ports. `/schemas` exports language-neutral JSON
Schemas and fixtures. `/testing` exports reusable evaluator-registration and host contract tests.

The package depends on:

```text
@jinn-network/evidence-protocol
@jinn-network/attestation-issuer
@jinn-network/evidence-repository
```

The host injects:

```text
EvaluationMaterialResolver
EvaluationAttemptCheckpointStore
EvaluatorRegistration collection
EvidenceRepository
registered signing capabilities
```

The package must not depend on:

- Evidence Local Runtime or another concrete repository binding;
- Discovery, Contribution, or Publication;
- a marketplace, benchmark, plugin, Autopilot, or TaskCoordinator;
- a wallet, blockchain, model provider, container engine, or test harness;
- a durable workflow product;
- or a particular identity or reputation system.

Concrete adapters belong to their owning applications or separate adapter packages.

## 7. Standards and portable contracts

The Runner reuses established standards where they fit without adopting an unrelated workflow or
lineage model.

### 7.1 Serialized schemas

JSON Schema 2020-12 defines portable representations for:

- `EvaluationRequestV1`;
- lifecycle-event data;
- `EvaluationFailureV1`;
- `EvaluationReceiptV1`;
- and attempt checkpoints that a host may persist.

Signed record types are composed from Evidence Protocol schemas rather than copied.

### 7.2 Lifecycle events

Lifecycle events use a CloudEvents 1.0 envelope. Jinn owns only the event types and data schemas:

```text
network.jinn.evaluation.attempt.started.v1
network.jinn.evaluation.attempt.progress.v1
network.jinn.evaluation.attempt.completed.v1
network.jinn.evaluation.attempt.failed.v1
network.jinn.evaluation.attempt.canceled.v1
```

W3C Trace Context may correlate the host, worker, Runner, and provider. Trace identifiers remain
operational metadata and never enter the signed Result Evaluation merely because they were
propagated.

OpenLineage and CDEvents provide useful lifecycle precedents, but their full Job/Dataset and CI/CD
models do not define Jinn evaluation semantics. The Runner does not claim conformance to them.

### 7.3 Error transport

The core failure model is transport-neutral. An HTTP adapter serializes it with RFC 9457 Problem
Details. A gRPC adapter maps its broad error class to the corresponding canonical status.

### 7.4 Compatibility

Operational schemas carry an explicit version. Additive optional fields are permitted. A breaking
semantic change requires a new schema version.

No mandatory service transport is defined. The schemas permit a future HTTP, RPC, queue, or
cross-language worker adapter without making that adapter part of the core package.

## 8. Evaluation request

One request produces at most one Result Evaluation over one exact Task and one non-empty set of
exact Result subjects.

The application-facing shape is:

```text
EvaluationRequestV1
├── schemaVersion: 1
├── attemptId: opaque host-scoped identifier
├── task: exact ResourceDescriptor
├── results: non-empty exact ResourceDescriptor array
├── specification: optional exact ResourceDescriptor
├── evaluatorRegistrationId: host-local identifier
├── context: explicitly allowed ResourceDescriptor array
├── deadline: optional absolute RFC 3339 timestamp
├── supersedes: optional exact earlier-claim descriptors
├── disputes: optional exact earlier-claim descriptors
└── extensions: optional namespaced operational input
```

Omitting `specification` means use the exact default that the application explicitly selected
when configuring the Runner. Omission is invalid when no application default exists. The package
never activates a built-in specification merely because this field is absent.

### 8.1 Attempt identity

`attemptId` is supplied by the host. It is the idempotency identity of one requested evaluator
attempt, not a content digest and not an evidence-record identity.

The attempt ID is not derived from Task, Result, specification, or evaluator identity. Repeating
an evaluation intentionally uses a new attempt ID, even when all content inputs are unchanged.

The same attempt ID means recover or resume the same logical attempt. It must not be used to
silently perform another nondeterministic evaluation.

### 8.2 Multiple Results

If a method judges several Result artifacts jointly, one request names every covered Result and
produces one joint verdict.

If the Results require independent conclusions, the host creates independent requests and attempt
IDs. An adapter does not return an array of unrelated Result Evaluation claims from one request.

For a multi-file Result, the request follows the Evidence Protocol subject rules: it names the
content-bound Result manifest and any individual files directly addressed by the verdict.

### 8.3 Supporting context

Context is an allowlist, not an invitation to search. The Runner retrieves only the exact
descriptors supplied.

The original Execution Evidence record is optional. A Result Evaluation may operate using only the
Task, Result, specification, and method. If the method requires an execution record, trace, test
fixture, reference answer, deployment observation, or other material, the request names it
explicitly.

### 8.4 Absolute deadline

The request carries an absolute deadline rather than a retry-resetting duration. The host may
apply a stricter deadline. Retrieval, adapter execution, provider work, checkpointing, signing, and
repository access receive the resulting cancellation signal.

## 9. Evaluation specification and defaults

Every Runner request resolves to one exact evaluation specification.

The specification defines:

- the criteria or rubric;
- the detailed outcome expected from the evaluator;
- how that outcome maps to `pass`, `fail`, or `inconclusive`;
- required measurements and supporting evidence;
- applicable limits or allowed external access;
- and any method requirements needed to interpret the result.

The Runner does not define success thresholds and does not invent a general policy language.

A specification may include a JSON Schema for the detailed outcome and a machine-readable mapping
where the method permits one. The Runner validates the outcome structure when possible. It does
not attempt to prove that arbitrary evaluator code or a human correctly applied the rubric.

The package may ship a named, versioned standard specification for simple Task-satisfaction
evaluation. It is never selected silently. Resolution precedence is:

1. exact request-specific specification;
2. exact application-configured default;
3. reject the request.

The exact descriptor of the selected default appears in the claim like any other specification.
No hidden Runner policy determines a verdict.

## 10. Evaluator registrations

The hosting application registers the evaluators it permits.

```text
EvaluatorRegistration
├── registrationId
├── adapter
├── exact evaluationMethod descriptor
├── specificationCompatibility validator
├── evaluatorIdentity source
├── DsseSigner capability
├── outcome validator
└── interruptionBehavior
```

The registration ID is local operational configuration. It does not appear in portable evidence.

### 10.1 Specification compatibility

The registration validates whether it can apply the resolved specification before evaluator work
begins. Compatibility may be with one exact specification or a documented family.

If no registered adapter supports the specification, the request fails with
`FAILED_PRECONDITION`. The Runner never downloads evaluator code, installs tools, or creates an
execution environment because a specification asks it to.

### 10.2 Method descriptor

The exact evaluation-method descriptor should content-bind or precisely describe:

- adapter and normalizer versions;
- controlled evaluator code;
- model and provider configuration;
- prompts and tool policies;
- container, harness, or external service dependencies;
- opaque hosted or human components;
- and known limitations.

The specification says what is judged. The method says how this evaluator performed the judgment.

Any permitted per-run configuration that materially affects the evaluation creates a new exact
method descriptor. Secrets, credentials, and private endpoints do not enter the descriptor.

### 10.3 Interruption behavior

Each registration declares one behavior:

- `repeatable`: it is safe to invoke the method again before an outcome checkpoint, normally
  because the evaluation is deterministic;
- `recoverable`: the adapter or provider can retrieve the prior result using `attemptId`;
- `nonrepeatable`: an uncertain interrupted invocation cannot be repeated under the same
  `attemptId`.

This declaration guides recovery. It does not replace production checkpointing.

## 11. Evaluator-adapter contract

The smallest evaluator capability is one asynchronous operation:

```text
evaluate(
  exact resolved Task,
  exact resolved Results,
  resolved specification,
  allowed resolved context,
  attempt identity,
  absolute deadline and cancellation signal
)
  -> CompletedEvaluation
```

The adapter receives method-specific execution providers when the host constructs it. The Runner
does not define a universal container, model, or human-review interface.

`CompletedEvaluation` contains:

```text
CompletedEvaluation
├── detailedOutcome: specification-defined JSON value or exact artifact
├── verdict: pass | fail | inconclusive
├── evaluatedAt: RFC 3339 timestamp
├── measurements: optional protocol-compatible measurements
├── explanation: optional non-empty text
├── limitations: optional text array
├── claimEvidence: optional new contents or exact existing descriptors
├── evaluatorExecution: optional exact Execution Evidence descriptor
└── authenticatedEvaluatorContext: optional registration-owned identity result
```

The adapter does not return or override:

- Task or Result subject identities;
- evaluation specification identity;
- evaluation method identity;
- signing capability;
- repository;
- or publication destination.

Those bindings remain under Runner and host control.

An adapter applies the specification and returns the protocol verdict. The Runner validates the
required shape but does not reinterpret scores or invent thresholds.

An operational interruption is not `CompletedEvaluation`. Provider failure, invalid output,
timeout, cancellation, or adapter crash follows the typed failure path and produces no verdict.

## 12. Evidence Retrieval and exact material

The Runner owns a narrow consumer-side port:

```text
EvaluationMaterialResolver
  resolve(exact descriptors, deadline, cancellation)
    -> immutable digest-verified material
```

Evidence Retrieval remains a separate capability. A host implements the port using a local
repository, cache, remote repository, or another exact source.

The resolver contract requires:

- every returned item matches its requested SHA-256 digest;
- every materialized item remains bound to its original ResourceDescriptor;
- material stays immutable for the evaluation lifetime;
- missing, inaccessible, and corrupt content are distinguished;
- no search, ranking, "latest" resolution, or substitution occurs;
- and cancellation and deadlines propagate.

The Runner passes the same Task and Result descriptors through three stages:

1. Evidence Retrieval verifies and materializes them.
2. The evaluator consumes material bound to them.
3. Attestation Issuer receives them as statement subjects.

The adapter cannot replace or rename subjects in its output.

The Runner also resolves the exact specification, method descriptor, relationship targets, and
allowed context before use. Pre-existing Task, Result, specification, method, and context bytes
are not copied into the target repository merely because an evaluation is issued.

Choosing a "latest" Task or Result is a host or Discovery decision made before request creation.
The request freezes exact content. If it names an older digest, that exact older content is
evaluated. If the material is unavailable, resolution fails and no claim is issued.

## 13. Method-neutral execution

The Runner has no `evaluationType` or method-category branch.

```text
evaluation specification --> evaluator adapter --> execution provider
                                      |
                                      v
                              completed outcome
                                      |
                                      v
                              Evaluation Runner
```

The execution provider may be:

- an isolated test container;
- a remote deterministic worker;
- a model client;
- an authenticated human-review system;
- a delayed observation service;
- or another future host-approved capability.

The Runner sees only a registered adapter, verified material, progress, and a completed outcome or
operational failure.

Delayed, private, marketplace, benchmark, and local evaluation are host composition contexts, not
Runner modes.

## 14. Lifecycle and durable state

The host job, evaluator attempt, and evidence record are distinct:

```text
host job ID
`-- evaluator attempt ID
    `-- signed Result Evaluation record digest
```

### 14.1 Host job state

The host owns durable job state:

```text
queued --> running --> completed
                  |--> failed
                  `--> canceled
```

`completed` means a signed evaluation was committed:

- a `pass` verdict is completed;
- a `fail` verdict is completed;
- an `inconclusive` verdict is completed.

Infrastructure failure is failed. Cancellation is canceled. Publication and marketplace
acceptance are outside this state model.

The host must serialize active work for one attempt through a lease, compare-and-set transition,
or equivalent mechanism. Concurrent deliveries must not both begin an unprotected
`nonrepeatable` evaluator invocation.

### 14.2 Runner lifecycle events

The Runner emits:

- `started`;
- `progress`;
- `completed`;
- `failed`;
- `canceled`.

Progress data may identify:

- `resolving`;
- `evaluating`;
- `checkpointing`;
- `storing-evidence`;
- `issuing`.

Evaluator-specific progress such as awaiting a reviewer remains detail, not a universal state.

Events may be delivered more than once. CloudEvent IDs support deduplication. Events are
notifications; the host job record and committed receipt remain authoritative.

### 14.3 Checkpoint store

A production host supplies:

```text
EvaluationAttemptCheckpointStore
├── load(attemptId)
├── saveCompletedOutcome(...)
├── savePreparedAttestation(...)
└── saveReceipt(...)
```

Writes must reject stale concurrent transitions. A host may implement the port with the same
database or workflow engine that owns the job. The port is not a Runner-owned workflow engine.

A local or test host may use an ephemeral implementation and accept that it cannot recover safely
after process loss.

The checkpoints retain:

1. the exact completed evaluator outcome and claim-evidence material;
2. the exact prepared signed attestation bytes;
3. the final repository receipt.

Credentials and private-key material never enter a checkpoint.

## 15. Recovery, retries, and cancellation

### 15.1 Before outcome checkpoint

An interruption before the completed outcome is durably checkpointed leaves the evaluator attempt
uncertain.

- A `repeatable` adapter may reconstruct the same outcome.
- A `recoverable` adapter must retrieve the prior provider result by `attemptId`.
- A `nonrepeatable` adapter must not run again under that attempt ID.

If an earlier nondeterministic outcome cannot be recovered, the host closes the attempt as
`failed` with reason `completion-state-unknown`. A genuine repetition receives a new attempt ID.

### 15.2 After outcome checkpoint

Retries reuse the exact completed outcome and claim-evidence material. They do not invoke the
evaluator again.

### 15.3 After attestation preparation

Retries reuse the exact prepared DSSE envelope bytes. They do not sign again. This preserves the
Attestation Issuer recovery rule: the prepared bytes are the retry unit.

### 15.4 After repository commit

Committing the same prepared bytes is content-addressed and idempotent. If the first commit
succeeded but its response was lost, retry returns the existing record rather than creating a new
claim.

Once the final Evaluation Receipt is checkpointed, every retry returns it.

### 15.5 Cancellation

Cancellation is cooperative and propagates through retrieval, adapter execution, external
providers, signing, checkpointing, and repository operations.

If cancellation is observed before record commit, no claim is committed. If cancellation races
with a successful commit, the repository receipt is authoritative: the immutable evaluation
exists and the job completes.

An issued evaluation is never deleted or rewritten to simulate cancellation.

## 16. Outcome and supporting evidence

The Result Evaluation preserves the evaluator's conclusion without forcing every method into one
detail schema.

### 16.1 Protocol-compatible fields

The adapter may return:

- `pass`, `fail`, or `inconclusive`;
- scalar measurements with names and optional units;
- explanation;
- limitations.

These map directly to the Result Evaluation predicate.

### 16.2 Rich findings

When the specification defines criterion trees, labels, annotations, categories, or another rich
outcome, the Runner serializes that outcome once using a documented deterministic JSON encoding.
It checkpoints and stores those exact bytes as a findings artifact referenced by the claim.

The Runner does not flatten or discard the detailed conclusion merely to fit scalar protocol
measurements.

### 16.3 Claim-evidence artifacts

An adapter may supply:

- new artifact contents for the Runner to snapshot and store;
- or an existing exact ResourceDescriptor for the Runner to resolve and verify.

A bare URI is insufficient.

Before signing, the Runner:

- applies host-configured artifact count and size limits;
- treats names, media types, and content as untrusted;
- snapshots new bytes;
- computes exact digests;
- writes the bytes through the injected Evidence Repository;
- and uses repository-backed descriptors in the claim.

Only artifacts explicitly selected as claim evidence enter this path. Raw logs, model transcripts,
temporary files, crash dumps, and other diagnostics remain host-owned.

There are no publication-candidate or exposure labels in v1.

### 16.4 Store-before-claim order

All newly produced claim evidence is stored before the claim is prepared. A signed evaluation
therefore never references a newly produced report that was not durably preserved.

If claim issuance later fails, content-addressed artifacts may remain unreferenced. Recovery reuses
them. Storage does not imply publication.

## 17. Attestation Issuer composition

After outcome checkpointing and artifact storage, the Runner calls Attestation Issuer with:

- exact Task and Result descriptors;
- evaluator Agent IRI;
- `evaluatedAt`;
- verdict;
- exact specification and method descriptors;
- measurements, explanation, and limitations;
- stored evidence descriptors;
- optional `supersedes` and `disputes` descriptors;
- and permitted protocol extensions, if any.

Attestation Issuer returns a prepared attestation containing exact signed bytes and its record
digest. The Runner checkpoints that prepared result before commit.

Attestation Issuer then commits the same bytes through the injected Evidence Repository and returns
its repository receipt.

The Runner writes newly produced supporting artifacts directly through the Repository contract.
It never constructs, signs, validates, or commits a competing claim format.

## 18. Failure model

`EvaluationFailureV1` describes why no signed evaluation completed.

```text
EvaluationFailureV1
├── schemaVersion: 1
├── attemptId
├── phase
├── canonicalCode
├── reason
├── safeDetail
├── occurredAt
└── recoveryAdvice
```

Phases are:

```text
request
resolution
evaluation
checkpoint
evidence-storage
attestation-preparation
attestation-commit
```

Broad codes use established gRPC meanings:

```text
INVALID_ARGUMENT
FAILED_PRECONDITION
NOT_FOUND
PERMISSION_DENIED
UNAUTHENTICATED
DEADLINE_EXCEEDED
CANCELLED
RESOURCE_EXHAUSTED
ABORTED
UNAVAILABLE
INTERNAL
DATA_LOSS
```

Jinn-specific reasons include:

```text
unknown-evaluator-registration
unsupported-specification
subject-not-found
subject-digest-mismatch
invalid-evaluator-output
provider-unavailable
outcome-checkpoint-failed
signing-failed
claim-conformance-failed
repository-commit-failed
completion-state-unknown
```

A single `retryable` boolean is too vague. Recovery advice is:

- `retry-step`;
- `resume-attempt`;
- `new-attempt-required`;
- `operator-action-required`;
- `do-not-retry`.

The host retains final retry authority.

Failure events carry only safe details. Provider responses, submitted content, stack traces,
credentials, and other sensitive diagnostics remain in private host logs.

An invalid evaluator response is an operational failure. It is not an `inconclusive` verdict.
`Inconclusive` is emitted only when the evaluator successfully concludes, under its specification,
that available evidence does not support `pass` or `fail`.

## 19. Evaluation Receipt

A completed invocation returns:

```text
EvaluationReceiptV1
├── schemaVersion: 1
├── attemptId
├── completedAt
├── resultEvaluation:
│   ├── recordDigest
│   ├── repositoryReference
│   `── repositoryStatus: created | existing
└── claimEvidenceReceipts
```

The receipt does not duplicate:

- Task or Result subjects;
- evaluator identity;
- method or specification;
- verdict or measurements;
- explanation or limitations.

Those values remain authoritative in the signed Result Evaluation record.

The receipt is operational and is not another evidence family. It connects a host attempt to one
immutable claim. A `completed` lifecycle event carries this receipt.

A receipt does not imply:

- Execution Verification;
- signature verification;
- identity binding or trust;
- marketplace acceptance;
- contribution or public admission;
- reward or settlement;
- publication;
- or superiority over another evaluation.

A separate signature-verification report and externally known publication status remain consumer
state and do not enter this receipt.

## 20. Evaluator identity, signing, and trust

### 20.1 Evaluator identity source

The evaluator Agent IRI comes from the host-controlled registration, not from ordinary untrusted
request or evaluator output.

A registration may contain:

- a fixed absolute IRI for a deterministic or model-based evaluator service;
- or a trusted identity resolver for a dynamically selected human or service evaluator.

For human review, the authenticated review provider supplies reviewer context to the registration's
identity resolver. The Runner does not accept an arbitrary reviewer IRI as ordinary findings data.

### 20.2 Signing capability

The registration supplies an injected `DsseSigner` capability. It may call a local isolated
signer, HSM, wallet service, or organizational attestation service.

The Runner never receives private-key bytes, reads wallet files, persists signing credentials, or
infers identity from credentials.

### 20.3 Evaluator and signer may differ

The evaluator Agent and signing key are separate:

```text
evaluator Agent: authenticated human reviewer
signer: organization-operated attestation service
```

The predicate records the evaluator IRI. The DSSE signature records the signing key identifier.
The claim does not imply that those identifiers name the same actor.

### 20.4 External identity and trust

Marketplace wallets, ERC-8004 identities, organizational identities, and other systems may map to
evaluator IRIs above the Runner. The Runner never infers such a mapping. A host may use an injected
identity authority when it needs to establish continuity.

A valid signature proves only that a supplied key signed the exact bytes. It does not prove:

- that the key belongs to the claimed evaluator;
- evaluator competence, independence, or reputation;
- marketplace authorization;
- correctness of the verdict;
- or suitability for a consumer.

Consumers own key resolution, signature verification, identity binding, and trust policy.
`verifyDsseSignatures` may be used by such a consumer, but it is not a Runner verdict or trust
gate.

## 21. Repeated, corrected, and disputed evaluations

Multiple and conflicting evaluations over the same exact Task and Results are normal. The Runner
never computes consensus, selects a winner, or uses "latest wins."

### 21.1 New evaluation

A new attempt ID represents a new evaluation. It may use the same Task, Results, specification,
method, and evaluator and still produce a distinct claim.

### 21.2 Supersession

A correction is a new request containing exact `supersedes` descriptors.

Before evaluator execution, the Runner resolves every referenced claim and confirms:

- exact bytes match the descriptor;
- the record is a conforming Result Evaluation;
- and it covers the same exact Task and Result subject set.

After a static or dynamic evaluator identity has been resolved, but before claim preparation, the
Runner also confirms that the earlier evaluator Agent IRI matches the new evaluator.

An injected identity authority may establish continuity between different evaluator IRIs. The
Runner never infers continuity.

An evaluator may issue an `inconclusive` claim that supersedes an earlier claim when withdrawing a
conclusion without a replacement `pass` or `fail`.

### 21.3 Dispute

A dispute is another new Result Evaluation containing exact `disputes` descriptors.

The Runner resolves the earlier claim and confirms that it is a conforming evaluation over the
same exact subjects. The disputing evaluator may have a different identity.

A dispute communicates disagreement. It does not invalidate, hide, mutate, or delete the earlier
claim.

### 21.4 Consumer authority

Discovery may expose supersession and dispute edges. Consumers decide whether to honor them. In
particular, protocol conformance alone does not establish that a superseding identity is
authorized or that a dispute is correct.

## 22. Optional evaluator Execution Evidence

The act of evaluating may itself be captured through the existing Execution Recorder.

```text
original Task + Results
        |
        v
evaluator adapter + provider
        |
        +--> detailed outcome artifact
        `--> evaluator Execution Evidence
                    |
                    v
        Result Evaluation evidence reference
```

This capture is optional and host-supplied. The core Runner cannot observe a remote container,
model service, or human system on its own.

An evaluator registration may provide an execution-capture wrapper around its adapter. The wrapper
finalizes the evaluator Execution before Result Evaluation issuance and returns its exact metadata
descriptor as supporting evidence.

The order avoids a cycle:

1. evaluator work produces its detailed outcome;
2. optional evaluator Execution Evidence is finalized;
3. Result Evaluation references that exact record as supporting evidence;
4. the evaluator Execution record does not reference the later signed evaluation.

Execution recording does not prove process integrity. A separate Execution Verification claim may
later assess that evaluator Execution.

### 22.1 Operational measurements

By default:

- conclusion-relevant scores, labels, and test counts belong in Result Evaluation;
- evaluator wall time, CPU, GPU, model tokens, and cost belong in evaluator Execution Evidence;
- queue time, worker retries, and checkpoint latency belong in host telemetry;
- marketplace payment and reward belong in marketplace policy.

A resource or cost measurement appears in Result Evaluation only when the evaluation specification
explicitly makes it part of the conclusion.

## 23. Security and privacy

The central security rule is:

> Authority comes from host configuration; Task, Result, context, provider responses, and
> evaluator output are untrusted data.

### 23.1 Runner safeguards

The Runner:

- accepts only host-registered evaluator adapters;
- never installs or executes code named by a request;
- resolves content only through the injected resolver;
- verifies every exact descriptor;
- retrieves only allowlisted context;
- bounds input, outcome, and evidence count and size;
- validates structured output before checkpointing;
- treats artifact names, media types, explanations, and findings as untrusted;
- never interprets evaluator output as commands;
- propagates cancellation and deadlines;
- stores evidence before signing;
- never serializes credentials into portable or checkpoint data;
- and sanitizes operational failures.

### 23.2 Execution-provider safeguards

The host and provider own:

- process and container isolation;
- filesystem and network policy;
- CPU, memory, storage, and time quotas;
- credential scoping;
- model-provider permissions;
- human authentication;
- and temporary-material cleanup.

An adapter that evaluates untrusted code must use an appropriate isolated provider. In-process
execution is a host trust decision, not a Runner safety guarantee.

### 23.3 Model and prompt safety

Task and Result content cannot grant authority.

A model adapter must keep evaluator instructions separate from evaluated content, bound tools and
network access, exclude secrets from prompts and evidence, and validate provider output. Prompt
injection may affect the evaluator's judgment, but it must not grant filesystem, signing,
publication, or marketplace authority.

### 23.4 Signer isolation

The signer capability is not supplied to evaluator code unless the host explicitly and
incorrectly couples them. A compromised evaluator therefore does not automatically acquire
signing authority.

### 23.5 Private evidence

Retrieval, evidence artifacts, optional evaluator Execution Evidence, the signed evaluation, and
operational logs may all remain in private stores.

Issuance does not publish.

A signed claim may reveal subject names, digests, evaluator identity, explanation, and
measurements even when subject bytes remain private. Contribution and Publication must review
those disclosures independently. The Runner performs no automatic scrubbing, announcement, or
publication.

## 24. Reference flows

### 24.1 Common flow

```text
1. Host creates a durable job and attempt ID.
2. Host calls Runner with exact references and a registered evaluator.
3. Runner resolves the specification default, registration, and exact material.
4. Registration confirms specification compatibility.
5. Runner invokes the adapter.
6. Adapter uses its host-supplied provider.
7. Adapter returns a specification-defined outcome or operational failure.
8. Runner validates and checkpoints the exact completed outcome.
9. Optional evaluator Execution Evidence is finalized.
10. Runner stores findings and selected claim evidence.
11. Attestation Issuer prepares and signs the Result Evaluation.
12. Runner checkpoints exact prepared bytes.
13. Attestation Issuer commits those bytes.
14. Runner checkpoints and returns the Evaluation Receipt.
15. Host submits, publishes, aggregates, or keeps the claim private.
```

### 24.2 Deterministic test evaluator

The host registers a test adapter with an exact harness and container method descriptor. The
specification names tests, criteria, and verdict mapping. The adapter uses an isolated provider and
returns test counts, verdict, and a test-report artifact.

Observed test failure may produce a `fail` verdict. A missing Runner dependency, provider crash, or
container infrastructure failure produces an operational failure and no verdict.

The registration may declare `repeatable` only when exact inputs, method, environment, and mapping
make reconstruction safe.

### 24.3 Model evaluator

The host registers a model adapter with a bounded client and exact method descriptor covering model,
prompt, tools, sampling, normalizer, and limitations. The specification supplies the rubric and
outcome schema.

The adapter parses and validates the provider response. An invalid response is operational
failure. A valid evaluator conclusion that the evidence is insufficient may be `inconclusive`.

The registration is `recoverable` when it can retrieve a provider result by attempt ID; otherwise
an uncertain interrupted invocation is `nonrepeatable`.

### 24.4 Human evaluator

The host registers a human-review adapter backed by an authenticated review provider. The
specification identifies the review form or rubric. The provider returns authenticated reviewer
context, conclusion time, detailed outcome, and selected evidence.

Waiting for a reviewer is progress owned durably by the host/provider. The method descriptor
honestly describes a human process. The signer may be an organizational service rather than the
human reviewer.

### 24.5 Delayed evaluation

The host schedules an ordinary evaluation job after the original Execution. Exact Task and Result
identities remain unchanged. Later observations are captured as exact context or supporting
artifacts, and `evaluatedAt` records when the conclusion was made.

No special Runner mode or original Execution record is required unless the selected method needs
one.

### 24.6 Private and Contribution flow

A local host supplies private retrieval, repository, checkpoint, and signer capabilities. The
Runner issues and stores the claim without announcing it.

A later Contribution workflow may inspect the claim and selected artifacts, apply its own privacy
and admission policy, and publish allowed unchanged bytes. If scrubbing changes bytes, the
derivative has a new identity and cannot silently replace evidence named by the original signed
claim.

### 24.7 Marketplace integration

The marketplace:

1. chooses an allowed evaluator registration and specification;
2. creates and persists an evaluation job;
3. invokes the Runner;
4. receives the signed record receipt;
5. separately verifies signature, identity, authorization, and evaluator reputation;
6. submits the claim and decides acceptance, settlement, or reward.

Marketplace Attempt state, wallets, rewards, and settlement never enter the Runner. A `pass`
evaluation does not itself mark a marketplace Attempt accepted.

### 24.8 Benchmark integration

A benchmark orchestrator expands its frozen matrix into independent evaluation jobs. Each job
names exact Task, Result, specification, and evaluator inputs and receives one Result Evaluation.

The benchmark retains the matrix, campaign identity, repetitions, and aggregate statistics.
Runner receipts do not select a winner or combine claims.

### 24.9 Plugin or local integration

A plugin or local application embeds the Runner with:

- a local resolver;
- a local repository/runtime;
- a local durable or ephemeral checkpoint store;
- registered evaluator adapters;
- and an injected signer.

It can issue private evaluations offline without a marketplace, blockchain, public repository, or
publication service.

### 24.10 Third-party integration

A system outside the monorepo may use the npm package directly or implement a transport adapter
against the published JSON Schemas. It supplies the same resolver, checkpoint, repository,
registration, and signer capabilities.

No Jinn-specific marketplace or wallet dependency is required.

### 24.11 Interrupted issuance

Recovery loads the attempt checkpoint:

- completed outcome present: do not rerun the evaluator;
- prepared attestation present: do not sign again;
- committed receipt present: return it;
- uncertain nondeterministic execution: do not silently repeat it.

The exact immutable claim is reused whenever issuance already succeeded.

## 25. Testing and evaluator conformance

### 25.1 Evaluator-registration contract kit

Every registration must demonstrate:

- specification compatibility is checked before work begins;
- exact resolved inputs are used without substitution;
- cancellation and deadline signals propagate;
- declared interruption behavior is accurate;
- completed output conforms to the selected specification;
- operational failure cannot become a verdict;
- detailed findings and evidence remain byte-stable after checkpointing;
- dynamic evaluator identity uses the trusted registration path;
- and untrusted output cannot override subjects, method, specification, signer, or repository.

Method-specific correctness remains the adapter owner's responsibility.

### 25.2 Runner conformance suite

The shared suite covers:

- deterministic `pass`, `fail`, and `inconclusive`;
- model output normalization and invalid output;
- human evaluation and authenticated identity;
- delayed evaluation;
- multiple independent evaluations over the same subjects;
- joint and independent multi-Result behavior;
- exact Task and Result binding;
- missing, corrupt, stale, mutable, or substituted subjects;
- context allowlisting;
- optional and absent supporting evidence;
- optional evaluator Execution capture;
- private evaluation with no publication;
- timeout and cancellation;
- concurrent delivery and stale checkpoint rejection;
- process interruption before and after each checkpoint;
- deterministic, recoverable, and nonrepeatable retry behavior;
- evidence storage before claim preparation;
- Attestation Issuer, signer, checkpoint, and repository failures;
- idempotent commit returning `created` and `existing`;
- cancellation racing with commit;
- corrections and disputes;
- unknown protocol extension preservation;
- signature validity remaining separate from verdict and trust;
- and marketplace, benchmark, plugin/local, and third-party fixtures.

Hostile fixtures include:

- incorrect digests;
- mutable materialized inputs;
- malformed or oversized findings;
- unsafe artifact names;
- path-like metadata;
- prompt-injection content;
- provider crashes;
- repeated lifecycle events;
- and conflicting checkpoint writes.

Tests must establish two central invariants:

1. Runner failures cannot be mistaken for negative evaluation verdicts.
2. Every issued claim binds the exact subjects the evaluator was given.

## 26. Explicit non-goals

Evaluation Runner does not own:

- task scheduling or marketplace Attempt lifecycle;
- production of the original execution Result;
- Evidence Retrieval search, ranking, or "latest" selection;
- canonical evidence mutation;
- Execution Verification;
- signature-verification policy or identity trust;
- wallet or key custody;
- evaluator reputation;
- marketplace settlement or reward;
- contribution, publication, scrubbing, or corpus policy;
- derivation, skill generation, or task mining;
- a container platform, model gateway, human-review product, or workflow language;
- a central queue, worker fleet, or hosted service;
- automatic consensus across conflicting evaluations;
- a universal definition of Result quality;
- or public exposure labels.

## 27. Deferred work

The following work is intentionally deferred and does not block this design:

- concrete deterministic, model, human, and delayed-observation adapters;
- a general Evidence Retrieval implementation behind `EvaluationMaterialResolver`;
- optional HTTP, RPC, queue, and worker adapters;
- an Execution Verification Runner sibling design;
- contribution-time exposure classification and publication policy;
- concrete identity-binding and evaluator-trust systems;
- and extraction of generic claim-running mechanics if a second Runner proves genuine duplication.

These are separate designs. They must not be hidden inside the initial Evaluation Runner
implementation.

## 28. Settled invariants

- V1 produces Result Evaluation only.
- One invocation produces at most one claim.
- Every claim names the exact Task and every exact Result evaluated.
- The evaluation specification defines the detailed outcome and verdict mapping.
- The evaluator adapter applies that specification.
- The Runner has no evaluation-mode enum.
- The host supplies every authority-bearing capability.
- The Runner stores the structured outcome required to preserve the conclusion and only those
  additional artifacts explicitly selected as claim evidence.
- Rich findings survive as exact artifacts.
- Operational failure never becomes a negative verdict.
- `pass`, `fail`, and `inconclusive` are all completed evaluations.
- Production recovery checkpoints the outcome, prepared bytes, and receipt.
- Nondeterministic work is never silently repeated under the same attempt ID.
- Attestation Issuer remains the sole canonical claim producer.
- Evaluator identity, signing identity, signature validity, identity binding, and trust remain
  separate.
- Multiple and conflicting evaluations remain append-only.
- Corrections and disputes create new claims.
- Issuance never implies publication, marketplace acceptance, trust, reward, or superiority.
- No new mandatory service, workflow engine, sandbox, or protocol family is introduced.

## 29. Authoritative related designs

- [Jinn Execution Evidence Protocol](./2026-07-23-jinn-execution-evidence-protocol-design.md)
- [Evidence Layer Architecture](./2026-07-25-evidence-layer-architecture.md)

This design composes those decisions. If an implementation detail appears to require changing
their protocol or substrate ownership boundaries, it requires a separate design decision rather
than an implicit exception here.
