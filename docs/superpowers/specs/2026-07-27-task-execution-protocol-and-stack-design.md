# Jinn Task Execution Protocol and Stack v1

**Date:** 2026-07-27

**Status:** design approved section-by-section in session; architecture and adversarial review
findings resolved; written review pending

**Shape:** `design`

**Scope:** the stable, backend-neutral protocol for requesting agentic work, representing
execution Attempts, observing their lifecycle, and delivering results — plus the boundaries of
the stack above it (backend contract, bindings, applications)

**Out of scope:** implementation plan and sequencing details, storage engines, query APIs,
marketplace contract changes, evaluator implementations, Evidence Protocol record definitions,
and derived knowledge products

## 1. Problem statement

Jinn has three systems that request, execute, and hand back agentic work, and none of them share
a portable representation of that work:

- the **marketplace** has a signed `task.v1` document, an on-chain
  `AttemptRecord (taskId, attemptIndex, operator, requestId)`, and a signed
  `jinn.execution.v1` envelope — with three coexisting task identities (creator id, IPFS CID,
  sequential on-chain id), two digest families over the same envelope bytes
  (keccak256-of-JCS signature hash and CID-derived sha256), a signed-but-largely-unenforced
  `claimPolicy`, and a 40-field per-operator row mixing attempt, execution, delivery, and
  settlement state;
- **Autopilot V2** has `SessionExecutionBackend` (`start`/`recover`/`cancel`), whose `recover`
  is liveness-only ("PID gone" reads as completed), whose results never return through the
  interface, and whose `effort` requirement silently drops at the marketplace boundary; and
- **local execution** hands work to a coordinator process through prompts and manifests with no
  typed result at all.

Meanwhile the **Jinn Execution Evidence Protocol**
(`docs/superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md`) has settled the
retrospective side — "this execution happened, used this runtime, produced these Results, and
was evaluated or verified this way" — and explicitly obligates any task layer to preserve stable
references between its product records and the evidence entities (§13.1 of that design).

The missing piece is the prospective counterpart:

> This work is requested, under these constraints, with these expected outputs.

This specification defines that protocol — the **Task Execution Protocol (TEP)** — and the
stack above it:

```text
Task Execution Protocol
        ↓
Task Execution Backend contract
        ├── local execution binding
        ├── Jinn marketplace binding
        └── future remote/batch bindings
                ↓
Task-oriented applications
        ├── Autopilot
        ├── Jinn task marketplace
        ├── benchmark and evaluation systems
        └── other schedulers and agent applications
```

The two protocols interoperate through stable identities and content references. They are not
merged, and neither nests inside the other.

## 2. Decision and rationale

Jinn adopts **approach B: compose established standards with a thin Jinn profile**, authoring
exactly two bespoke objects — the immutable Task specification and the first-class Attempt —
because the standards audit (§3) found no existing standard that owns either, while every
surrounding concern has a mature, adoptable standard.

The rejected alternatives:

- **A — adopt an existing task protocol wholesale.** The only candidate with the right surface
  is A2A (v1.0.1, Linux Foundation). Its Task is the *server's mutable execution record*:
  server-minted non-URI identifiers, conversational history accruing in-band, no immutable task
  specification, no attempt identity, no content binding, and a canonical model that is itself a
  serialization (proto3/ProtoJSON) bound to a live client–server topology. Adopting it would
  smuggle a backend shape into the protocol. MCP Tasks is an experimental session-bound polling
  handle; GA4GH TES is container-argv batch compute with anonymous retry log entries.
- **C — fully bespoke.** Every non-core slot — event envelope, digest grammar, artifact
  references, signing envelope, canonicalization, schema language — has a boring, battle-tested
  standard. Re-deriving them costs interoperability and re-opens solved security problems (DSSE's
  PAE construction exists because naive sign-the-JSON schemes were repeatedly broken).

Composition also yields one coherent stack across both Jinn protocols: the Evidence Protocol
already chose content addressing by SHA-256 over exact bytes, `urn:uuid:` historical identities,
RFC 3339 timestamps, and DSSE/in-toto for signed claims. TEP adopts the same choices, so the two
protocols never disagree about what a name, digest, or signature means.

## 3. Standards audit

Primary sources fetched 2026-07-27; versions pinned per candidate. Full per-candidate analysis
was performed during the design session; this section records the conclusions.

### 3.1 Selected standards

| Slot | Standard | Adoption |
| --- | --- | --- |
| Lifecycle observation envelope | CloudEvents v1.0 (CNCF, JSON format) | Wholesale; Jinn extension attributes via its sanctioned mechanism |
| Observation ordering | CloudEvents `sequence` extension | Wholesale, with a TEP-profile fixed-width encoding (§10.1) because the extension orders lexicographically |
| Artifact references | in-toto ResourceDescriptor v1 + OCI digest grammar (`sha256:<hex>`) | Wholesale |
| Signing | DSSE v1 envelope; in-toto Statement v1 for assertions about digests | Wholesale; optional in core, required by profiles |
| Output and document schemas | JSON Schema 2020-12 | Wholesale |
| Canonicalization | RFC 8785 JCS, confined to digest derivation at sealing | Wholesale, narrowly scoped |
| Identity | RFC 9562 UUIDs as `urn:uuid:` URIs (RFC 9562 obsoletes RFC 4122; `urn:uuid:` semantics unchanged); identity-scheme-neutral IRIs | Wholesale; matches Evidence Protocol §5. Name-based UUIDv5 derivation for two-party Attempt minting (§9.2) |
| Timestamps | RFC 3339 (strict) | Wholesale |
| Correlation | CloudEvents distributed-tracing extension (`traceparent`) carrying W3C Trace Context values | Optional observation attribute (§10.1) |
| Spec/status separation | Kubernetes JobSpec/JobStatus pattern | As a structural rule |
| Requirements/preferences split | CWL `requirements` vs `hints` | As a structural rule |
| Failure blame axis | GA4GH TES v1.1 `EXECUTOR_ERROR` vs `SYSTEM_ERROR` | As the `task` vs `infrastructure` axis |
| Terminal-state discipline | A2A v1.0.1 (`REJECTED` distinct from `FAILED`; terminal states absorbing) | Vocabulary insight, not the object |
| Error taxonomy | gRPC status-code family | Prior art; TEP adds protocol-specific categories |
| Idempotency scoping | IETF Idempotency-Key draft's per-client scoping | As the (requester, backend) scoping rule (§12.2) |
| Capability negotiation | LSP client/server capabilities pattern | Prior art |
| Contract + conformance kit | CSI/csi-sanity and OCI runtime-spec/runtime-tools model | As the conformance architecture |

### 3.2 Rejected alternatives

| Candidate | Why not |
| --- | --- |
| A2A Task model (v1.0.1) | Mutable server-side execution record; no immutable spec, no Attempt, no content binding; server-minted IDs presuppose a live client–server topology |
| MCP Tasks extension | Experimental; a TTL-scoped polling handle around another request's result; no portable task representation to extract |
| GA4GH TES task document | Execution model is a container argv, not a goal specification; attempts anonymous; no digests; server-assigned id inside the request document |
| CWL / GA4GH WES | Workflow-level; validates that workflow graphs belong *above* a single-task protocol (WES layers over TES), so they are out of scope here |
| JSON-LD | Context processing, remote-context fetching, and canonicalization costs buy nothing over plain JSON with URI-valued type fields and namespaced extensions (the in-toto and CloudEvents choice). The Evidence Protocol uses JSON-LD via RO-Crate because it is a provenance *graph*; TEP documents are single records. Deliberate difference, not drift — the seam is digests and URIs, which both share |
| IPFS CID as identity | A CID is not a pure function of content bytes (codec and chunking dependent); CIDs remain locator hints, never identity |
| W3C PROV / ActivityStreams | Retrospective provenance / social vocabulary — the Evidence Protocol's territory, not the prospective protocol's |
| Temporal task model | Not a standard; its attempts are ordinals, not identities. Its declarative retry-policy shape informs the Task `requirements` design |

### 3.3 The two authored objects

No standard defines:

1. an **immutable prospective Task specification** — sealed before any executor exists,
   content-addressed, requester-neutral, reusable across backends; or
2. a **first-class Attempt** — an addressable engagement of an executor with its own identity,
   lifecycle, deliveries, and evidence correlation.

TEP authors exactly these two, shaped by the prior art above.

## 4. Ownership boundary

Four layers. Each concept in this specification belongs to exactly one.

### 4.1 Task Execution Protocol

Owns portable data, identities, relationships, and lifecycle semantics: the five record/entity
families (§5), their digests and URIs, the observation vocabulary and state fold, the error
category vocabulary, and conformance profiles.

It does not know: local process APIs, HTTP routes, queues, databases, marketplace contracts,
wallets, prices, rewards, GitHub, Autopilot, Kubernetes, or specific model providers.

### 4.2 Task Execution Backend contract

A language-level, service-neutral operational interface over the protocol (§14): submit,
observe, watch, cancel, recover, deliveries, capabilities, preflight — with the typed error
model of §13. The contract must never expose shared-mutation capability, credential
passthrough, application-lifecycle authority, or settlement operations.

### 4.3 Backend bindings

Concrete adapters that translate the backend contract to a substrate: the local
process/coordinator binding, the Jinn marketplace binding, and future remote-agent or
batch/container bindings. Bindings translate protocol concepts; they never redefine them.
Claims, leases, escrow, transport request identifiers, and settlement sequencing are
binding-internal.

### 4.4 Applications

Own decisions and policy: what work exists, backend selection, scheduling and prioritization,
decomposition, budget allocation, retry and competition policy, acceptance criteria, evaluation
policy, applying returned results, shared mutation, marketplace pricing and rewards, evaluator
selection, trust and admission, and user experience. Autopilot remains lifecycle and
shared-mutation authority for its own workflows; its lifecycle phases are GitHub-fact
predicates and never appear in the protocol.

## 5. Semantic model and record families

Five families. Three are sealed documents identified by exact bytes, one is a minted entity,
one is an append-only event stream.

| Family | Kind | Identity | Minted/sealed by |
| --- | --- | --- | --- |
| **Task** | sealed document | `sha256` of exact sealed bytes | requester (sealed once) |
| **Submission** | sealed dispatch document | `urn:uuid:` URI; its exact sealed bytes carry the reference digest | requester |
| **Attempt** | entity | `urn:uuid:` URI | backend side (§9.2) |
| **Lifecycle Observation** | CloudEvents event | (`source`, `id`) unique per producer; digest of exact bytes when referenced | backend (authoritative producer, §10.1) |
| **Delivery** | sealed record | `sha256` of exact sealed bytes | executor/backend side |

Cardinalities are deliberately non-containing:

- a Task may have many Submissions (across backends and time);
- a Submission may engage many Attempts, within its declared attempt bounds (§8);
- an Attempt belongs to exactly one Submission and one Task, names at most one executor, and
  never migrates between executors;
- an Attempt may correlate with zero or more Evidence Executions and may carry zero or more
  Deliveries (a failed Attempt may still deliver partial artifacts);
- a Delivery belongs to exactly one Attempt.

Canonical lifecycle truth is the observation log. Any "current status" — including the Attempt
descriptor a backend serves — is a derived projection, never a mutable protocol record. A
backend's internal registry contributes nothing lifecycle-bearing that is not present in the
observations: every reference and correlation fact a descriptor shows is carried by an
observation (`attempt-engaged`, `execution-observed`, `delivery-recorded`, `attempt-terminal`).

Deliberately **not** protocol records: claims and leases (backend-private), evaluation verdicts
(Evidence Protocol's `result-evaluation` family), acceptance/adoption/settlement states
(application), and Autopilot lifecycle phases (application-internal).

## 6. Identity and digest model

TEP adopts the Evidence Protocol's three-kind identity scheme unchanged.

### 6.1 Content identity and sealing

Every byte-bearing artifact and record named by TEP carries **SHA-256 over its exact bytes**,
written `sha256:<64 lowercase hex digits>` (the OCI/Evidence grammar). Inside a
ResourceDescriptor the in-toto shape `{ "digest": { "sha256": "<hex>" } }` is used.

**Sealing** applies to all three sealed document families (Task, Submission, Delivery). The
authoring implementation canonicalizes the document once with RFC 8785 JCS, under I-JSON
constraints, at the moment of sealing; the sealer MUST reject numbers not exactly representable
as I-JSON integers at sealing time (fractional quantities are strings), and the published JSON
Schemas restrict the same. **Those bytes are the document forever.** Verifiers hash the exact
bytes they received; no consumer ever re-canonicalizes to check a digest, and no system
parses-and-re-emits a sealed document and calls it the same document. Sealed documents travel
as bytes or by reference plus digest; an API that "loads" one keeps the original bytes
alongside the parsed view. The conformance kit checks producers (sealer output is valid JCS
under the I-JSON profile) and consumers (verification never re-canonicalizes) separately.

This rule is economically load-bearing: Result Evaluations in the Evidence Protocol bind exact
Task digests, so byte drift silently orphans a task's evaluation history, corpus linkage, and
cross-attempt comparability.

### 6.2 Minted entity identity

Submissions, Attempts, and executors are named by stable absolute URIs. Where no persistent
dereferenceable IRI exists, a generated `urn:uuid:` IRI is used (RFC 9562). Executor identity
follows the Evidence Protocol's Agent rules (§5.1 of that design) verbatim:
identity-scheme-neutral IRIs; wallets, ERC-8004 agent IDs, DIDs, organizational and local
identities attach as auxiliary identifiers *above* the protocol and are never the identity
itself. TEP mints no new URN namespace. Attempt minting rules, including deterministic
derivation for two-party bindings, are in §9.2.

### 6.3 Observation identity

CloudEvents' own rule: producers MUST ensure (`source`, `id`) is unique per distinct event.
When an observation is referenced as bytes (for example, a signed observation), its exact
serialized bytes carry a sha256 like any artifact.

### 6.4 Cross-references

Everywhere a TEP record points at content it uses one shape: the **in-toto ResourceDescriptor**
(`name`, `uri`, `digest`, `mediaType`, `downloadLocation`, `annotations`; at least one of
uri/digest/content). Digest is identity. IPFS CIDs (`ipfs://…`), gateway URLs, and Git object
identifiers are locator hints riding in `uri`/`downloadLocation`/`annotations` — never
identity. Bounded inline `content` is permitted for small values and always accompanied by its
digest.

Binding-native identifiers — on-chain `taskId` and `attemptIndex`, mech `requestId`,
transaction hashes, Autopilot `v2AttemptId` — are **correlation annotations** on Submission,
Attempt, and Delivery records, using namespaced annotation keys. They join records to
binding-internal state; they never name protocol entities.

References to Evidence Protocol records use the structural shape
`{ "family": "execution-evidence" | "result-evaluation" | "execution-verification",
"digest": "sha256:<hex>" }` plus, for executions, the Execution `urn:uuid:` IRI. This is a
structural convention, not a package dependency (§23).

### 6.5 Versioning of Tasks

Changing any sealed byte creates a new Task identity. Lineage is expressed *inside* the new
document via an optional `supersedes` ResourceDescriptor naming the predecessor Task digest —
lineage is therefore itself part of the sealed identity, and no mutable version pointer exists
anywhere in the protocol.

## 7. Task specification

The sealed Task document is plain JSON (I-JSON), vendor-tree media type
`application/vnd.jinn.task-execution.task.v1+json` (IANA registration is a follow-up, §28),
sealed per §6.1.

**Reserved profile URI:** `https://jinn.network/profiles/task-execution/1.0`. As with the
Evidence Protocol, this URI must resolve to the published human-readable profile before a
producer emits an external conformance claim under it.

### 7.1 Fields

| Field | Req | Meaning |
| --- | --- | --- |
| `protocol` | yes | TEP profile URI this document conforms to |
| `profile` | yes | URI of the **task profile**: the versioned domain contract for what this task means, its payload schema, and its output conventions (the generalization of `contractId.contractVersion` / the deprecated `solverType`) |
| `instructions` | yes | The work statement — the human/agent-readable request. This document, in its entirety, is what the executor receives |
| `payload` | no | Profile-typed structured body, valid against the profile's JSON Schema |
| `inputs` | no | Array of ResourceDescriptors for everything the work consumes: repository states (URL + immutable ref + optional tree digest), datasets, files, knowledge packets. Digest where exact identity matters. Confidential inputs per §7.5 |
| `outputs` | yes | Named required output slots: `{ name, mediaType, required, schema? }` where `schema` is an embedded or digest-referenced JSON Schema 2020-12 document for structured outputs |
| `requirements` | no | Mandatory execution constraints (§7.2) |
| `preferences` | no | Advisory hints (§7.2) |
| `evaluation` | no | ResourceDescriptor committing, by digest, to the canonical evaluation specification (§7.3) |
| `supersedes` | no | Lineage descriptor (§6.5) |
| `author` | no | Self-declared authorship IRI — deliberately optional and non-authoritative (§7.4) |
| namespaced extensions | no | §21.3 |

The sealed Task deliberately contains **no**: absolute deadlines or windows, claim policy,
attempt budgets, prices or rewards, requester identity as authority, dispatch nonce, backend
selection, credentials or capability grants, or any mutable field.

### 7.2 Requirements and preferences

The CWL-style split:

- **`requirements`** is a map of requirement key → value that a backend MUST honor or reject
  (typed `unsupported-requirement` rejection naming the offending key — never silent
  degradation). Core defines a small standard vocabulary: `maxAttemptDurationMs` (relative,
  never absolute), token/cost budgets, isolation class, network policy, `evidenceCapture`
  (whether Execution Evidence must be produced), tool/model constraints, and `effort`. Profiles
  add namespaced keys. A backend that does not recognize a requirement key MUST reject.
- **`preferences`** is the advisory counterpart. A backend MAY use or ignore preferences; it
  never rejects on them.

**`effort` is a core vocabulary key** with tiered values (`low | medium | high | xhigh | max`),
valid in either map: in `requirements` it is honor-or-reject; in `preferences` it is advisory.
One canonical key name on both sides is what prevents the current silent drop at the
marketplace boundary from recurring under a different spelling.

### 7.3 Evaluation declaration

The `evaluation` descriptor commits the creator, at sealing time, to the **semantic definition
of correctly done**: the exact rubric, test suite, or evaluation-task profile bytes, bound by
digest. It does not contain evaluator *policy* — who evaluates, how evaluators are selected or
paid, quorum, self-evaluation allowance, or dispute handling. Those are Submission-level
requirements (§8) and deployment-profile mechanics.

This split is deliberate: it fixes the current wart in which the marketplace *evaluator*
authors and signs the evaluation task document (so the evaluation input is not
creator-committed and the manifest's `evaluationFunction` binding is declaratory), and it keeps
one Task identity across contexts with different operational evaluation needs (production
work, benchmarking, local development). The sealed descriptor is the canonical acceptance
basis, not an exclusivity claim: the Evidence Protocol permits any number of evaluations
against the same Task/Result, each recording which specification it applied, and consumers
distinguish "evaluated per the task's own spec" from "evaluated by another standard" by
comparing digests.

The per-result evaluation Task *instance* ("evaluate result X against task Y") necessarily
comes into existence after a delivery and may be sealed by the evaluating deployment — that is
acceptable, and the substantive commitment survives, because the profile check binds the
evaluator's work to the creator-sealed specification: the evidence evaluation's
`evaluationSpecification` digest must equal the Task's sealed `evaluation` descriptor digest
(§18).

### 7.4 Authorship and authority

Attribution authority comes from a DSSE signature over the sealed bytes and from the
Submission's requester identity — never from fields inside the sealed document. The optional
`author` field is a self-declaration. This keeps Tasks requester-neutral and reusable: a
benchmark task attempted across networks is not owned by its first submitter.

### 7.5 Confidential inputs

A private input appears in the sealed Task as an opaque ResourceDescriptor only: name, digest,
media type, and access classification. **The sealed Task carries no capability references and
no resolution instructions** — an opaque resolver name meaningful to one backend would freeze
backend coupling into the requester-neutral identity, and a leaked confidential Task must not
be resubmittable by a third party into access.

Access is granted at dispatch: the Submission's `capabilityGrants` field (§8) maps input names
to capability references, which the backend resolves out-of-band — validating the *requester's*
authority over each grant before provisioning the executor with exactly the scoped access it
needs (the generalization of Autopilot's file-based credential handoff). The portable Task
remains shareable even when its inputs are not. Omission is not permitted when the requester
knows an input materially defines the work; bytes may be withheld, the fact of the input
remains.

### 7.6 No role enum

The current `restoration | evaluation` role field does not exist at the protocol layer. An
evaluation run is an ordinary Attempt of an evaluation-profile Task ("evaluate result X against
task Y"). The marketplace binding maps its verdict leg onto such a profile; core stays
role-agnostic.

## 8. Submission

The Submission is the dispatch record: everything about *this request to execute* that must not
contaminate Task identity. Vendor-tree media type
`application/vnd.jinn.task-execution.submission.v1+json`; **sealed per §6.1** (its exact bytes
carry its reference digest and any DSSE signature); DSSE-signed where a profile requires.

| Field | Req | Meaning |
| --- | --- | --- |
| `protocol` | yes | TEP profile URI |
| `submission` | yes | Requester-minted `urn:uuid:` URI |
| `task` | yes | ResourceDescriptor: the sealed Task digest plus locator hints |
| `requester` | yes | Requester IRI (identity rules of §6.2). In core this is an unauthenticated claim — see §20 |
| `idempotencyKey` | yes | Requester-chosen string, scoped to (requester, backend) — §12.2 |
| `nonce` | yes | Unpredictable dispatch value. Conveyed to every Attempt's executor inside the dispatch-context input artifact (§9.3) so it lands in content-bound Execution Evidence |
| `deadline` | yes | Absolute RFC 3339 execution deadline for Attempts under this Submission |
| `closeAt` | no | After this instant the backend engages no further Attempts |
| `attempts` | no | Attempt bounds: `{ maxTotal?, maxConcurrent? }` — the lifetime attempt budget and the concurrency cap for this Submission. Bindings map these to their mechanics (marketplace `maxClaims` implements `maxTotal`) |
| `evaluationRequirements` | no | The requester's operational evaluation needs: e.g. minimum count of independent verdicts, evaluator-distinct-from-executor, or none |
| `capabilityGrants` | no | Map of Task input name → capability reference for confidential inputs (§7.5). Resolved by the backend with requester-authority validation |
| `profileParameters` | no | Namespaced per-profile dispatch parameters (opaque to core) |
| correlation annotations | no | §6.4 |
| namespaced extensions | no | §21.3 |

**Honor-or-reject applies to dispatch parameters.** `attempts`, `evaluationRequirements`, and
`capabilityGrants` follow the same rule as Task requirements: a backend that cannot honor a
supplied value — including a backend with no deployment profile that interprets
`evaluationRequirements` — MUST reject at `submit` with `unsupported-requirement` naming the
field. Silent degradation is never conforming. `profileParameters` are the designated
opaque-to-core escape hatch and carry no such obligation beyond the named profile's own rules.

Deadline **composition** is an application concern: an application derives its own staleness
and reaping thresholds from the Submission deadline plus its post-delivery reserves (adoption,
review, settlement), rather than the protocol hard-coding any window arithmetic.

## 9. Attempt model

An **Attempt** is the unit of "an executor is engaged for a Task under a Submission."

### 9.1 Structure

- **Identity:** `urn:uuid:` URI minted on the backend side (§9.2), stable across process
  restarts and recovery.
- **References:** exactly one Task digest and one Submission URI; the executor IRI once known;
  the effective absolute deadline inherited from the Submission at engagement time.
- **Correlation:** namespaced annotations for binding-native identifiers (§6.4), and the
  **authoritative Attempt → [Evidence Execution ID] edge**, carried by `execution-observed`
  observations. One Attempt may correlate with several Executions (for example, a solve plus an
  in-attempt repair run). In-crate stamps (§18) are corroboration; the TEP observations own the
  edge.
- **Evaluator runs:** an evaluator run is an ordinary Attempt of an evaluation-profile Task
  (§7.6); nothing in the Attempt model distinguishes it.

The Attempt descriptor a backend serves through `observe` is a projection over the observation
log; the canonical facts are the observations (§5).

### 9.2 Minting, retries, and competition

Attempts are minted on the backend/executor side, because in the marketplace they come into
existence through operator claims the requester never initiates. Claim and lease mechanics are
backend-private; the protocol records the *fact* of engagement.

**Two-party bindings MUST mint deterministically.** Where the requester-side binding and the
executor observe an engagement independently (the marketplace: the binding sees the claim
event; the operator authors the Delivery), the Attempt URI is derived as a name-based UUIDv5
(RFC 9562 §5.5) over a binding-defined name built from the binding's native correlation tuple
(for the marketplace: chain id, coordinator address, `taskId`, `attemptIndex`). Both parties
compute the same URI without communicating, so the executor can name the Attempt in the sealed
Delivery bytes it signs. Single-party bindings (local) MAY mint random UUIDs.

**Retries and competition:**

- Application-driven retries always use a **new Submission** (new idempotency key). Under
  §12.2, resubmitting existing bytes is an idempotent no-op by design, and the backend
  contract deliberately has no "add an attempt" verb.
- Backend-initiated engagement of additional Attempts under a live Submission is legal only
  within the Submission's declared `attempts` bounds and before `closeAt`/`deadline`.
- Each retry is a new Attempt; concurrent Attempts on one Task are legal by design; Attempts
  never migrate between executors; the protocol never declares a winner among competing
  Attempts.

### 9.3 The dispatch-context input artifact

At engagement, the backend MUST convey to the executor a **dispatch-context input artifact** —
media type `application/vnd.jinn.task-execution.dispatch-context.v1+json`, content-bound like
any input — containing: the Task digest, the Submission URI, the Submission `nonce`, and the
Attempt URI. Because the Attempt URI is inside it, the artifact is unique per Attempt even
though the nonce is per-Submission: freshness comes from the nonce, per-Attempt distinction
from the Attempt URI.

The backend's obligation is to *convey* it as an input. Profiles that require Execution
Evidence (§16.2) additionally require that the resulting crate's captured inputs include this
artifact, and name the corresponding verification check — that is what makes it the
anti-retro-claiming measure (§18, §20): a crate sealed before dispatch cannot contain a value
minted at dispatch.

## 10. Lifecycle observations and state semantics

### 10.1 Observation envelope

Every lifecycle fact is a CloudEvents v1.0 event (JSON format):

- `id` + `source`: unique per producer; `source` is the observer URI (normally the backend);
- `subject`: the Attempt URI (attempt-scoped) or Submission URI (submission-scoped);
- `type`: reverse-DNS Jinn type (below);
- `time`: RFC 3339;
- `datacontenttype`: `application/json`; `dataschema`: the published payload schema URI;
- extension attributes: `sequence` (per the CloudEvents sequence extension, which orders
  **lexicographically** — TEP therefore mandates a fixed-width, zero-padded 16-digit decimal
  encoding, and the conformance kit includes ordering fixtures at the width boundary),
  `taskdigest` (the sealed Task digest, for subscriber-side filtering), and optionally
  `traceparent` (the CloudEvents distributed-tracing extension carrying W3C Trace Context
  values, for joining external telemetry).

**Authority.** The backend binding is the authoritative observation producer for Attempts under
its management. The `attempt-engaged` payload pins the **authoritative source URI** for that
Attempt, and that source MUST remain stable for the Attempt's lifetime (a producer that
rebuilds its durable log MUST re-emit observations with their original (`source`, `id`) pairs,
or emit them as new corroborating facts — never as a second authoritative stream). Consumers
establish authority from the engagement event; executors and other observers may emit
corroborating observations, which consumers fold separately. Observations are unsigned in
core; profiles MAY require DSSE-signed observations (§15) where spoofed sources are a concern.

### 10.2 Observation types

Submission-scoped:

| Type (prefix `network.jinn.task-execution.`) | Payload |
| --- | --- |
| `submission-accepted.v1` | echo of submission URI, task digest |
| `submission-rejected.v1` | error category (§13) + detail |
| `submission-closed.v1` | reason: deadline, requester close, capacity |

Attempt-scoped:

| Type | Payload |
| --- | --- |
| `attempt-engaged.v1` | attempt URI, task digest, submission URI, executor IRI (if known), effective deadline, authoritative source URI, dispatch-context descriptor (§9.3), correlation annotations |
| `attempt-started.v1` | start time; executor IRI if newly known |
| `progress.v1` | optional free-form `message`, optional `fraction` — no universal progress metric is imposed |
| `cancel-requested.v1` | reason, requesting party |
| `cancel-acknowledged.v1` | acknowledging party |
| `execution-observed.v1` | Execution `urn:uuid:`; optional evidence record reference `{family, digest}` |
| `delivery-recorded.v1` | Delivery digest + locator hints |
| `attempt-terminal.v1` | terminal state (§10.3), blame axis where applicable, error category + detail where applicable |

Observation payloads carry identifiers, digests, categories, and bounded free text — producers
MUST NOT place task instructions, input content, or artifact content in observation payloads,
and SHOULD bound free-text fields (`message`, `detail`) to 4 KiB and whole payloads to 64 KiB
(§20). Some bindings never observe `attempt-started` (a marketplace binding may see only claim
and delivery events); consumers MUST NOT treat its absence, or the unreachability of the
`running` state, as anomalous.

### 10.3 Derived Attempt states

| State | Meaning | Terminal |
| --- | --- | --- |
| `pending` | engaged, not yet executing (claimed/preparing) | no |
| `running` | execution underway | no |
| `delivered` | terminal outcome claimed as delivered (§10.4 note) | yes |
| `failed` | terminal without usable delivery; carries blame `task` (executor ran, work failed) or `infrastructure` (substrate fault) — the TES `EXECUTOR_ERROR`/`SYSTEM_ERROR` split | yes |
| `rejected` | executor/backend refused before execution began | yes |
| `cancelled` | terminated due to cancellation | yes |
| `expired` | deadline passed with no terminal observation (provisional — §10.4) | yes |
| `lost` | after exhaustive recovery the backend cannot determine the fate (quasi-terminal — §10.4) | yes |

The derived terminal state is **the state named by the authoritative `attempt-terminal`
observation**; the table is descriptive. A `cancelled` or `failed` Attempt with a
`delivery-recorded` observation stays `cancelled`/`failed` — deliveries may exist under any
terminal state (`partial` artifacts), and `delivered` is an outcome claim, not a statement
about artifact existence. `cancel-requested` is a flag on the derived state, not a state: a
cancel-requested Attempt may still legitimately reach `delivered` or `failed`.

### 10.4 The fold

State derivation is a defined pure fold over the authoritative source's observations (the
source pinned in `attempt-engaged`), ordered by `sequence`:

1. **Terminal states are absorbing** — a late non-terminal observation never un-terminates.
2. **Duplicates** are dropped on (`source`, `id`).
3. **Out-of-order tolerance**: the fold is order-insensitive up to the terminal observation;
   `sequence` (fixed-width, §10.1) resolves races among non-terminal observations.
4. **Contradictory terminals**: if the authoritative source emits more than one
   `attempt-terminal` (beyond the sanctioned cases below), the derived state is the first
   terminal in `sequence` order, and the snapshot carries a persistent `contradictory` flag —
   surfaced, never silently merged.
5. **`expired` is provisional.** It derives automatically when the deadline passes with no
   terminal observation, and it is always superseded by a later authoritative
   `attempt-terminal` whose facts predate or explain the gap (a partitioned backend's
   `delivered` arriving late is the normal case, not a contradiction). Backends SHOULD emit the
   explicit terminal observation when they detect expiry, SHOULD apply a clock-skew grace
   before doing so, and consumers deriving expiry locally MUST treat it as provisional.
6. **`lost` is quasi-terminal.** It is the one terminal state that a later authoritative
   `attempt-terminal` may supersede without raising the `contradictory` flag: when a partition
   heals and the true outcome becomes determinable (a chain shows a real delivery), the backend
   emits the corrective terminal and the fold accepts it. Any other terminal-to-terminal
   transition remains contradictory.

### 10.5 What is deliberately absent

`advertised`, `bid`, `claimed-for-payment`, `settled`, `rewarded`, `slashed`, economically
`disputed` — marketplace-internal. Acceptance/adoption states — application data (Autopilot's
adoption receipt is application state, not a protocol observation). Evaluation states —
Evidence claims arrive after Attempt terminality and change nothing here (§18). Losing a
settlement race is not `failed`: the binding maps a lost race to what actually happened to that
Attempt (typically `rejected` at claim time, or `delivered`-but-unsettled, which settlement
policy handles above the protocol).

## 11. Delivery and results

### 11.1 Delivery vs Result

A **Delivery** is the prospective protocol's operational handover record: "this Attempt hereby
returns these exact artifacts as its answer." A **Result** is the Evidence Protocol's
retrospective artifact role: "these exact bytes were generated by this Execution." Different
records in different protocols, binding the same bytes by the same sha256 — which is what makes
the evidence Result derivable from a Delivery without rewriting.

### 11.2 The Delivery record

Sealed per §6.1; identity = sha256 of exact bytes; vendor-tree media type
`application/vnd.jinn.task-execution.delivery.v1+json`; DSSE-signed where a profile requires.

| Field | Req | Meaning |
| --- | --- | --- |
| `protocol` | yes | TEP profile URI |
| `attempt` | yes | Attempt URI (computable by the delivery author under §9.2's deterministic minting) |
| `task` | yes | Sealed Task digest |
| `outputs` | yes | Named slots mirroring the Task's `outputs[]`, each a ResourceDescriptor (digest, media type, locators). Multi-file outputs use the Evidence Protocol's aggregate-manifest rule verbatim: per-file sha256 plus a content-bound manifest |
| `outcome` | yes | `fulfilled` \| `partial` \| `escalation` (with `escalationReason`) — escalation generalizes Autopilot's `human{reason}` |
| `executionIds` | no* | Evidence Execution `urn:uuid:` IRIs |
| `evidenceRecords` | no* | Evidence record references `{family, digest}` — the Execution Recorder's finalization receipt fields |
| `summary` | no | Executor's human-readable summary (bounded; no artifact content) |
| `supersedes` | no | Digest of an earlier Delivery **of the same Attempt** this one corrects |
| `createdAt` | yes | RFC 3339 |
| namespaced extensions | no | §21.3 |

\* Optional in core; the marketplace profile requires both (§16.2).

### 11.3 Rules

1. **Deliveries are immutable; corrections are new Deliveries** with `supersedes`. The
   `supersedes` target MUST be a Delivery of the same Attempt — a Delivery naming another
   Attempt's delivery is `invalid-document` (checkable whenever both records are held), which
   closes the forged-supersession attack against competitors. Whether a supersession is
   *accepted* remains application policy. Cycles are structurally impossible (digest references
   cannot point forward).
2. **Multiple and late deliveries are legal records**, each attributable to its Attempt.
   Competing Attempts' deliveries coexist; a delivery landing after cancel-request or after a
   competitor settled remains a historical fact. Selection is application policy; settlement
   races are marketplace policy.
3. **A failed or cancelled Attempt may deliver partial artifacts** (outcome `partial`), with
   evidence like anything else.
4. **Schema validation:** outputs must satisfy the Task's declared output schemas. The
   application is the enforcement point; a backend MAY pre-validate as an advertised
   capability. Delivered ≠ valid ≠ accepted — three separate judgments.
5. **No streaming in v1.** Intermediate checkpoints are `partial` Deliveries; streamed output
   is a future backend capability, not a protocol change.
6. **Evidence is not required by core** for a successful Attempt — a local development loop may
   deliver bare artifacts. Profiles requiring verified work (the marketplace) require the
   evidence references.

## 12. Cancellation and recovery

### 12.1 Cancellation

Three distinct facts:

1. **Request** — the application asks via the backend contract; the backend accepts (emitting
   `cancel-requested`) or refuses with a typed error (`unsupported-capability`,
   `attempt-not-found`). Cancelling an already-terminal Attempt is not an error: the backend
   returns an idempotent `CancelAck` reporting the terminal state, so cancel races have a
   defined outcome.
2. **Acknowledgement** — `cancel-acknowledged`: the executing side has been told and will try
   to stop. Nothing more.
3. **Termination** — the Attempt reaches `cancelled`, or it does not: remote execution may
   finish concurrently and reach `delivered` or `failed`. All outcomes are legitimate; the log
   records what happened.

Cancellation is a request and a lifecycle fact, never a rollback: the protocol makes no claim
that external side effects were undone. A post-cancel Delivery remains a historical record;
whether it is *accepted* is application policy ("cancel means stop accepting this result
through the official path" generalizes from the Autopilot marketplace design). Deadline expiry
requires no request: `expired` derives automatically (§10.4).

### 12.2 Recovery and idempotency

Protocol-level rules every binding must satisfy:

- **Durable records only.** Every protocol fact is re-derivable from durable records; no
  in-memory state is load-bearing. Attempt URIs are stable across restarts. Observations are
  durable; re-emitting one is idempotent by (`source`, `id`).
- **Idempotent submission, scoped and byte-exact.** The `idempotencyKey` is scoped to
  (requester, backend) — following the IETF Idempotency-Key draft's per-client scoping — so no
  other requester's key can capture or conflict with a submission. Within that scope: same key
  + **byte-identical sealed Submission** = the same Submission (return the existing
  acknowledgement); same key + any byte difference = typed `submission-conflict`, never silent
  replacement. A crash-retrying requester therefore persists and resends the exact sealed
  bytes — the same discipline the design already demands for Tasks. (Application-driven
  *deliberate* retries use a new Submission with a new key; §9.2.)
- **Reconciliation classification.** A recovering backend comparing its durable record against
  backend-native state (chain events, process tables, repository facts) MUST classify the
  comparison `matching | absent | contradictory` and fail loud on `contradictory` rather than
  guess. `absent` after exhaustive recovery is what legitimately produces `lost` — an honest "I
  cannot determine," never a default — and `lost` remains correctable per §10.4 rule 6.
- **Terminal facts survive.** After restart, a terminal Attempt's Deliveries and evidence
  references remain retrievable (`result-unavailable` is a loud error, not a shrug).
- **Idempotency does not erase distinct Attempts.** A retry after a genuine failure is a new
  Attempt under a new Submission; deduplication applies to Submissions, observations, and
  Deliveries — never to the fact that two executions happened.

## 13. Error model

Operational errors are strictly disjoint from work outcomes: a failed Attempt is a *successful*
`observe()` returning a terminal state; an error is the operation itself failing. Stable
categories, each with a machine-readable `retryable` flag; bindings map native failures into
these categories, may attach native detail, and never invent parallel taxonomies.

| Category | Meaning |
| --- | --- |
| `invalid-document` | protocol document fails schema or digest validation (including a cross-attempt `supersedes`) |
| `unsupported-profile` | backend does not implement this task profile |
| `unsupported-requirement` | a mandatory Task requirement or Submission dispatch parameter cannot be honored (named in the error) |
| `unsupported-capability` | verb or feature not supported by this backend |
| `invalid-reference` | dangling or malformed ResourceDescriptor or URI |
| `content-corruption` | bytes do not match the declared digest — always fail-loud |
| `access-denied` | caller lacks authority for the record, operation, or capability grant |
| `submission-conflict` | idempotency key reused with different Submission bytes (within its requester scope) |
| `attempt-not-found` | unknown Attempt URI |
| `dependency-unavailable` | referenced input or service unreachable |
| `backend-unavailable` | the backend itself is down or unreachable |
| `operation-aborted` | this call was interrupted (not the attempt) |
| `deadline-exceeded` | the operation timed out (distinct from attempt `expired`) |
| `transport-failure` | network or carrier failure |
| `result-unavailable` | terminal attempt, but delivery content is not retrievable |
| `protocol-violation` | backend returned semantically illegal data (e.g. an unsanctioned terminal-to-terminal transition) |

Deliberately absent: "race lost," "unstaked," "insufficient funds" — binding-native details
riding under these categories' detail fields or marketplace-internal state, not protocol
categories.

## 14. Backend contract

Working interface (TypeScript-first; names frozen at this level of granularity, signatures
refined at implementation):

```ts
interface TaskExecutionBackend {
  capabilities(): Promise<BackendCapabilities>;
  preflight?(request: PreflightRequest): Promise<PreflightReport>;   // optional capability
  submit(taskBytes: Uint8Array, submissionBytes: Uint8Array): Promise<SubmissionAck>;
  observe(ref: SubmissionUri | AttemptUri): Promise<ObservationSnapshot>;
  watch?(ref: SubmissionUri | AttemptUri, cursor?: ObservationCursor):
    AsyncIterable<ProtocolObservation>;                              // optional capability
  cancel?(attempt: AttemptUri, reason: string): Promise<CancelAck>;  // optional capability
  recover(ref: SubmissionUri | AttemptUri): Promise<ReconciliationReport>;
  deliveries(attempt: AttemptUri): Promise<DeliveryRef[]>;
  fetchDelivery(ref: DeliveryRef): Promise<Uint8Array>;              // exact bytes
  fetchArtifact?(descriptor: ResourceDescriptor): Promise<Uint8Array>; // optional capability
}
```

Semantic contracts:

- `submit` takes **both sealed documents as exact bytes** — never parsed-and-reserialized
  objects — because both carry byte identity and, under signing profiles, DSSE signatures over
  those exact bytes. Implementations pass parsed views alongside internally (the §6.1 "loads a
  document" pattern). Idempotent per §12.2; returns acceptance or a typed rejection.
- `preflight` generalizes Autopilot's fail-closed dry run: prove the configured backend end to
  end before real work is claimed.
- `observe` returns the derived state plus the observation log position. It is honest: it
  distinguishes running, terminal, and unknown; it never infers success from liveness.
- `watch` is a resumable, cursor-based push view over the same observation log. No callback
  topology is imposed; applications may poll `observe` instead.
- `recover` is **mandatory**: rebuild from durable records, reconcile against backend-native
  state, return the `matching | absent | contradictory` classification. A backend that cannot
  recover is not a conforming backend.
- `deliveries` + `fetchDelivery` are the result path (the verb today's
  `SessionExecutionBackend` lacks). `fetchDelivery` returns exact bytes; artifact retrieval may
  additionally be served via `fetchArtifact` or resolved by the caller from locators.
- `cancel` per §12.1 (terminal-state-aware, idempotent).

The contract must never expose: shared-mutation capability (no repository pushes, no GitHub
verbs), credential passthrough, application-lifecycle authority, or settlement operations.
This generalizes the marketplace-session design's rule that the session backend "may not expose
GitHub mutation capability."

## 15. Capability model

`BackendCapabilities` is a declarative record:

| Capability | Declares |
| --- | --- |
| `taskProfiles[]` | task profile URIs this backend can execute |
| `inputMediaTypes` / `outputMediaTypes` | consumable/producible media types |
| `maxArtifactBytes` | artifact size ceiling |
| `cancel`, `watch`, `preflight`, `fetchArtifact` | optional-verb support |
| `confidentialInputs` | can resolve capability grants / opaque descriptors |
| `evidenceCapture` | `none` \| `available` \| `always` |
| `signedObservations` / `signedDeliveries` | DSSE support |
| `deadlineEnforcement` | actively terminates at deadline vs merely reports expiry |
| `isolation[]` | runtime isolation classes offered |
| `attempts` | supported per-Submission attempt bounds (`maxTotal`, `maxConcurrent` ranges) |

Two rules keep this honest:

1. **Capabilities are statements, not proof.** They are where negotiation starts; verification
   and reputation of actual behavior live entirely above the protocol.
2. **Requirements and dispatch parameters are checked at `submit`.** A mandatory Task
   requirement or Submission dispatch parameter the backend does not declare and honor is a
   typed `unsupported-requirement` rejection before any Attempt exists — never a silent
   degradation.

## 16. Bindings

### 16.1 Local binding

The first binding and the conformance kit's reference implementation. It wraps the existing
coordinator/harness-engine machinery:

- sealed Task bytes are handed to the spawned agent process verbatim, alongside the
  dispatch-context input artifact (§9.3);
- the binding mints the Attempt URI at engagement; process lifecycle becomes observations
  (`preparing` → `pending`, spawn → `attempt-started`, exit → terminal), with the exit
  *outcome* determined from durable records, never from PID absence;
- `recover` reconciles the durable manifest against the process table per §12.2;
- Deliveries are written durably before being announced;
- Evidence Capture runs in the supervising control plane beside the executor (capture happens
  where execution occurs), feeding the Execution Recorder; the recorder receipt's
  `{family, digest}` and Execution ID go into the Delivery, and the dispatch-context artifact
  goes into the recorder's captured inputs.

Local execution is *a* binding, not the definition of execution: nothing in the protocol
assumes a PID, a filesystem, or a single host.

### 16.2 Jinn marketplace binding

The binding lives in the marketplace application tree (§23) and translates:

| Protocol concept | Marketplace realization (binding/application-internal) |
| --- | --- |
| Task (sealed bytes) | Uploaded to IPFS; the CID is a locator annotation; sha256 is identity. Today's `task.v1` splits: work statement → sealed Task; window/claim policy/creator → Submission-derived posting data |
| Submission | The on-chain post (`TaskCreated`), escrow funding, `maxClaims` implementing `attempts.maxTotal`, claim windows — fulfillment mechanics for the Submission's declared parameters |
| Attempt | On-chain `AttemptRecord (taskId, attemptIndex, operator)`; the Attempt URI is the deterministic UUIDv5 of §9.2 over (chain id, coordinator, `taskId`, `attemptIndex`), computable by both parties; mech `requestId` and transaction hashes ride as correlation annotations |
| Observations | Emitted by the binding from chain events (claim, Deliver, delivery claims) and operator engine states; creation, claim, and delivery anchors remain distinct, non-overwritable facts |
| Delivery | The signed execution envelope, converged on sha256 identity and DSSE signatures; envelope CID and keccak anchors remain binding-internal |
| Evaluation | The verdict leg becomes an Attempt of an evaluation-profile Task bound to the creator-sealed evaluation specification (§7.3); verdict codes, slots, and self-evaluation enforcement are marketplace profile policy |
| *(no protocol home)* | Settlement, delivery fees, activity weights, staking, race-loss handling, adoption-receipt mechanics — marketplace/application-internal |

**Marketplace profile requirements** (the deployment profile layered on core):

- signed Tasks and signed Submissions (DSSE over the exact sealed bytes);
- **executor-signed Deliveries**: the operator signs the exact sealed Delivery bytes — which it
  can author completely, because the Attempt URI is deterministically computable (§9.2);
- `executionIds` and `evidenceRecords` required on Deliveries;
- **dispatch binding**: the referenced Execution Evidence crate's captured inputs MUST include
  the dispatch-context artifact for the Attempt (§9.3), and the profile names the
  corresponding Execution Verification check (`dispatch-binding`) that settlement-grade
  consumers require;
- evaluation per the sealed specification, with the Evidence `evaluationSpecification` digest
  equal to the Task's sealed `evaluation` descriptor digest.

### 16.3 Future bindings

Remote agent-to-agent execution (an A2A or comparable transport carrying sealed TEP documents),
and batch/container execution. Bindings translate; they never redefine. No v1 work is gated on
them.

## 17. Application ownership

Applications own: task creation, scheduling and prioritization, backend selection,
decomposition, retry policy, concurrency, budgets, acceptance, evaluation policy, applying
returned artifacts, shared mutation, marketplace settlement, reputation, and user experience.

**Autopilot** (the canonical application walkthrough): Autopilot wins its branch claim and
opens the draft PR *before* any Task exists — lifecycle authority never moves. It seals a Task
under an Autopilot session task profile (workflow kind, task snapshot, workflow contract,
expected head as input descriptors — no credentials, no manifests, no publish authority),
submits with deadline, nonce, and evaluation requirements through either binding — same Task
bytes, same logical session. The Delivery returns a patch artifact, summary, and evidence
references; Autopilot's adoption coordinator validates and materializes it through the existing
session verbs (application acceptance: `delivered` ≠ adopted); adoption receipts, review
claims, and merge gates stay purely application-side. A marketplace operator produces results
and never receives GitHub mutation authority. The current `SessionExecutionBackend` migrates
verb-for-verb (§25).

## 18. Evidence Protocol crosswalk

| Task Execution concept | Evidence relationship |
| --- | --- |
| Task specification | Its sealed bytes **are** the Evidence Task artifact (`File`, `CreativeWork`, `prov:Plan`) — same sha256, no projection, no second description. The TEP task identity is stamped onto the evidence Task as an `identifier` PropertyValue (§18 note below) |
| Submission | Not an evidence entity. Its `nonce` reaches the crate through the per-Attempt dispatch-context input artifact (§9.3) |
| Attempt | Correlates with 1..N Execution `urn:uuid:` IRIs. The authoritative edge is carried by `execution-observed` observations; in-crate stamps are corroboration only |
| Actual runtime | Recorded by the Runtime Specification and Runtime Observation inside Execution Evidence. The Task's `requirements` are prospective and are never treated as fact about what ran |
| Delivered output | Delivery output descriptors carry the same sha256 the evidence Result binds — the Result is derivable from the Delivery without rewriting |
| Execution receipt | The Delivery's `evidenceRecords` + `executionIds` are exactly the Execution Recorder's finalization receipt fields |
| Evaluation | Separate Result Evaluation Evidence; subjects are the exact Task digest and Result digests. Profile check: its `evaluationSpecification` digest equals the Task's sealed `evaluation` descriptor digest |
| Process verification | Separate Execution Verification Evidence; subject is the exact crate metadata bytes. The marketplace profile's `dispatch-binding` check (§16.2) lives here |
| Backend status | Operational observations; never canonical Evidence |
| Marketplace acceptance | Application policy, not Evidence Protocol conformance |
| Settlement/reward | Marketplace state outside both protocols |

**Resolved:** the Task Execution Task bytes are used **directly** as the content-bound Evidence
Task artifact. The conditions are structural and guaranteed by this design: the document is
sealed byte-stable at authoring (§6.1) and is the exact artifact handed to the executor (§7.1).
No deterministic projection exists, so no two competing Task descriptions can arise.

**Crate-side stamps.** The concrete mechanism is the Execution Recorder's producer inputs: its
`executionIdentifiers` and per-entity identifier captures emit `identifier` PropertyValue
entries on the Execution and Task entities (the pattern Evidence §5.1 defines for Agents,
applied to other entities — an Evidence-profile minor addition this design depends on; the
exact scheme `propertyID` IRIs are a registration follow-up, §28). Producers under TEP SHOULD
stamp the Attempt URI via `executionIdentifiers`. Stamps corroborate; they never substitute for
the TEP-side edge, because crates are unsigned and identifiers are copyable strings.

**Anti-substitution at the seam** is layered, and honest about each layer's strength:

- the **dispatch-context artifact** (nonce + Attempt URI, content-bound into captured inputs)
  defeats *retro-claiming*: a crate sealed before dispatch cannot contain a value minted at
  dispatch. It does not by itself defeat *re-minting* (grafting the artifact into a re-sealed
  crate) — that is what the profile-named `dispatch-binding` verification check and
  executor-signed Deliveries address;
- the TEP records name the evidence **record digest** (not only the copyable Execution ID),
  and the crate carries the corroborating stamps — neither direction alone is authoritative;
  the TEP side owns the edge, and Execution Verification makes it trustworthy;
- Result Evaluations bind exact digests, so a substituted attempt with even trivially
  different task bytes inherits no verdicts.

Referencing rule: use the Execution `urn:uuid:` when meaning the historical run (stable across
scrubbed representations); use the record digest when meaning one exact serialization (what
verifications bind; a verification of a private crate does not transfer to its public
projection).

## 19. Required data flows

Scenario traces over the settled semantics. Each is derivable from the rules above; none
introduces new ones.

### 19.1 Local execution

Application seals a Task; submits (task bytes + submission bytes) to the local binding; binding
accepts (`submission-accepted`), mints an Attempt (`attempt-engaged`, pinning the authoritative
source and dispatch-context descriptor), spawns the agent (`attempt-started`); the recorder
captures evidence beside the executor, including the dispatch-context input; on completion the
binding seals the Delivery durably (outputs by digest, `executionIds`, `evidenceRecords`),
emits `delivery-recorded` and `attempt-terminal {delivered}`; the application fetches the
Delivery and decides acceptance. Nothing in the protocol asserted the result is good.

### 19.2 Marketplace execution

The same sealed Task bytes are submitted through the marketplace binding; the binding posts,
funds escrow, and maps `attempts.maxTotal` to `maxClaims` (binding-internal). An operator's
claim becomes `attempt-engaged` with the operator IRI, the deterministic Attempt URI (§9.2),
and on-chain correlation annotations. The operator authors and signs the Delivery (it can — the
Attempt URI is computable); mech delivery carries it; settlement (`claimSolutionDelivery`,
activity credit) remains invisible to the protocol. The application evaluates and accepts
separately. The Task digest — identical to the local run's — accrues both contexts' evidence.

### 19.3 Autopilot session

Per §17. Branch claim and PR precede the Task; the Task carries no credentials or authority;
the Delivery carries a patch, not a push; adoption is application acceptance; the backend never
becomes a lifecycle authority. Execution Evidence associates with the Attempt via
`execution-observed` and the Delivery's receipt fields.

### 19.4 Competing Attempts

One Submission with `attempts: { maxTotal: 3 }` engages up to three Attempts, each with its own
URI, lifecycle, Deliveries, and evidence. Evaluations may differ per delivery. Application
policy selects or rejects Results; the protocol declares no winner; an unselected `delivered`
Attempt stays `delivered`.

### 19.5 Retry after infrastructure failure

Attempt A reaches `attempt-terminal {failed, blame: infrastructure}`. The application (owner of
retry policy) decides to retry and submits a **new Submission** — same Task digest, new
`submission` URI, new idempotency key, new nonce — and the backend engages Attempt B. (The
backend itself may also engage further Attempts under the original Submission, but only within
its declared `attempts` bounds and before `closeAt`/`deadline`.) Both Attempts and their
evidence remain distinct historical facts; duplicate execution is detectable via the shared
Task digest and distinct Attempt URIs; the crash-retry of an *unacknowledged* submit is handled
separately by byte-exact idempotency (§12.2), not by new Submissions.

### 19.6 Cancellation

Application calls `cancel`; backend emits `cancel-requested` then `cancel-acknowledged`; the
remote executor finishes anyway and the Delivery lands; the log shows request, acknowledgement,
and `attempt-terminal {delivered}`. The Delivery and its evidence are historical facts; the
application declines to accept; no claim is made that side effects were reversed. A second
`cancel` after terminality returns the terminal-state-aware `CancelAck` (§12.1).

### 19.7 Confidential Task

The Task references a private repository state as an opaque descriptor (name, digest, media
type, access class — nothing else). The Submission's `capabilityGrants` maps that input name to
a capability reference; the backend validates the requester's authority over the grant, then
resolves it and provisions the executor with scoped access. A third party holding the leaked
Task bytes gains nothing by resubmitting them — it holds no grant. No credential appears in any
portable document; public observations carry URIs and digests only; the resulting evidence may
remain private, with digest commitments provable.

### 19.8 Delayed evaluation

An Attempt reaches `delivered` and is terminal. A week later an evaluator issues a Result
Evaluation binding the exact Task and Result digests. Nothing in TEP changes: no Task,
Submission, Attempt, observation, or Delivery record is rewritten; consumers discover the
evaluation through the evidence graph.

### 19.9 Backend recovery

The coordinator restarts. `recover` rebuilds from durable records: the Attempt URI is
unchanged; reconciliation against backend-native state classifies `matching` (resume
observation), `absent` (after exhaustive search → `attempt-terminal {lost}`), or
`contradictory` (fail loud, human attention). If the partition later heals and the true outcome
surfaces, the backend emits the sanctioned corrective terminal over `lost` (§10.4 rule 6).
Terminal Deliveries and evidence references remain retrievable. Resubmission is blocked by
byte-exact idempotency.

### 19.10 Third-party backend

An external implementer builds against `@jinn-network/task-execution-protocol` and
`…-backend`, passes the conformance kit (protocol fixtures + backend sanity suite), and any
Jinn application can submit to it — no marketplace, no Autopilot, no monorepo dependency.

## 20. Security and privacy

**Trust ladder** (inherited from the Evidence Protocol): profile conformance → artifact
integrity → signature validity → identity binding → consumer trust. No rung implies the next; a
conforming, signed Delivery can still be wrong; acceptance is always an application decision.

- **Untrusted Task specifications.** Task documents are data and convey no authority.
  Instructions are prompt-injection surface: executors and applications treat them as untrusted
  input; a Task cannot instruct a backend to exceed what the Submission's grants and the
  backend's own configuration allow — the sealed Task carries no grants at all (§7.5).
- **Malicious artifacts.** Delivered artifacts are validated (declared schemas, size ceilings,
  path rules) by the application before any effect; `delivered ≠ accepted` is the structural
  defense; digests make substitution detectable end to end.
- **Digest substitution / content corruption.** Exact-bytes verification everywhere;
  `content-corruption` is always fail-loud; size-then-digest verification per the OCI rule.
- **Replay and duplicates.** Requester-scoped, byte-exact idempotency (§12.2); observation
  dedupe on (`source`, `id`); Delivery identity by digest and same-Attempt `supersedes`
  (§11.3); the per-Attempt dispatch-context artifact defeats retro-claiming, with re-minting
  countered by the `dispatch-binding` verification check and executor-signed Deliveries
  (§18). **Core limitation, named:** core Submissions are unsigned and `requester` is an
  unauthenticated claim — an observer of Submission bytes could replay them to a *different*
  backend, minting Attempts attributed to a requester who never asked that backend. Deployments
  where this matters use the signed-Submission profile (marketplace does).
- **Stale claims and authority.** Claims/leases are backend-private, but the acceptance rule
  generalizes from Autopilot: applications re-read current authority facts and reject stale or
  contradictory results *before* side effects.
- **Impersonation and keys.** DSSE `keyid` is a hint, never a security decision; identity
  binding (key ↔ claimed IRI) is separate evidence and consumer policy, per Evidence §6.10.
  Delegated authority, where needed, is expressed as signed statements (in-toto) above the
  protocol — no marketplace-specific roles in core. Spoofed observation `source` values are
  countered by the pinned authoritative source (§10.1) and, where required, signed
  observations.
- **Credential isolation.** No credentials or capability references in sealed Tasks (§7.5);
  grants ride the Submission and are resolved with requester-authority validation;
  sanitized-environment mechanics are binding-internal.
- **Confidentiality and metadata leakage.** Producers MUST NOT place task instructions, input
  content, or artifact content in observation payloads or Delivery summaries; free-text fields
  are bounded (§10.2). Confidential Tasks keep bytes private while digest commitments remain
  provable; resulting evidence may remain private under the Evidence scrub/withhold model.
  These are producer obligations — confidentiality against a *malicious* producer is not
  claimed.
- **Resource exhaustion.** Bounded inline content; `maxArtifactBytes`; fixed-width `sequence`
  (no unbounded padding); advisory ceilings: observation payloads ≤ 64 KiB, free-text fields
  ≤ 4 KiB, `progress` emission throttled by producers; `watch` consumers apply backpressure or
  fall back to polling. Profiles set hard limits.
- **Cross-tenant leakage.** Backend implementations scope observation streams and delivery
  retrieval by caller authority (`access-denied`); the protocol's records carry no tenant
  concept — isolation is a backend obligation surfaced through the error model.
- **Capability misrepresentation.** Capabilities are claims (§15); verification and reputation
  are above the protocol; the conformance kit tests behavior, not honesty.
- **Cancellation limits.** §12.1 — no rollback claims, ever.

## 21. Serialization, carrier, versioning, and extensions

### 21.1 Serialization

The semantic model is the five families of §5. The canonical serialization is I-JSON. Each
record family has a published JSON Schema and a vendor-tree media type
(`application/vnd.jinn.task-execution.<family>.v1+json`; IANA registration is a follow-up,
§28). JSON-LD is deliberately not used (§3.2).

### 21.2 Carriers and envelopes

CloudEvents (JSON format) is the only carrier envelope in v1, used for observations. DSSE is
the only signing envelope: a signed record is a DSSE envelope whose `payloadType` is the
record's media type and whose payload is the exact sealed record bytes; assertions *about*
records (future authorization objects, receipts) are in-toto Statements whose subjects carry
the record digests. Transport bindings (HTTP service shape, queues, on-chain anchoring) are
deliberately unbound in v1 — the CloudEvents formats-vs-bindings split.

### 21.3 Extensions

Extension fields use namespaced keys (reverse-DNS or absolute-URI names). Consumers MUST
preserve unknown namespaced fields when copying or re-packaging records (trivially guaranteed
for sealed documents, which travel as exact bytes). Extensions MUST NOT override core
semantics — and because semantic contradiction in opaque fields is not generally
machine-checkable, the enforceable form of the rule is: **consumers MUST derive all core
semantics exclusively from core fields**; extensions may add information, never redirect
interpretation. A record whose extensions demonstrably contradict its core fields is
`invalid-document` where a validator can detect it.

### 21.4 Versioning

Profile and schema versions follow the Evidence Protocol's rules: **patch** clarifies without
changing accepted meaning; **minor** adds backward-compatible optional terms; **major** changes
required fields, required relationships, or existing semantics. Every record declares its
`protocol` (and, where applicable, task profile) URI. Deployment profiles MAY add stricter
requirements on top of core v1 (require signatures, require evidence, require specific task
profiles) and MUST NOT loosen core requirements or alter core meaning.

## 22. Public interfaces (freeze level)

Frozen at this granularity; field-level refinement happens at implementation without changing
names or responsibilities:

- **Records:** `TaskSpecification` (§7.1), `SubmissionRecord` (§8), `AttemptDescriptor` (§9,
  a projection), `ProtocolObservation` (CloudEvents + §10.2 payloads), `DeliveryRecord`
  (§11.2), `DispatchContext` (§9.3), `ResourceDescriptor` (in-toto v1),
  `EvidenceRecordReference` `{family, digest}`.
- **Backend contract:** `TaskExecutionBackend` (§14) with `BackendCapabilities` (§15),
  `SubmissionAck`, `ObservationSnapshot`, `ObservationCursor`, `ReconciliationReport`
  (`matching | absent | contradictory` + detail), `CancelAck` (terminal-state-aware),
  `DeliveryRef`, `PreflightRequest/Report`.
- **Errors:** `TaskExecutionError` carrying a §13 category, `retryable`, `detail`, and
  namespaced native annotations.
- **Pure functions (protocol package):** `sealTask/sealSubmission/sealDelivery(document) →
  bytes` (JCS + I-JSON enforcement), `documentDigest(bytes)`, family validators,
  `foldObservations(events) → derivedState` (implementing §10.4 exactly),
  `deriveAttemptUri(bindingName, correlationTuple)` (§9.2 UUIDv5), digest/descriptor helpers.

## 23. Package and repository structure

Monorepo-first, extraction-ready by construction (published packages, no out-of-package file
reads, no Jinn-deployment constants in generic layers — the discipline the Autopilot
extraction gate enforces). The stack sits **beside** `packages/evidence/`, never inside it.

```text
packages/task-execution/
  protocol/            @jinn-network/task-execution-protocol
                       Pure: types, JSON Schemas, sealing + digest functions,
                       observation fold, validators, deterministic attempt-URI
                       derivation. No I/O. No Jinn deps. Evidence references
                       are structural {family, digest} fields — no dependency
                       on evidence packages.
  backend/             @jinn-network/task-execution-backend
                       The contract: interfaces, error classes, capability
                       types. Depends on protocol only.
  testing/             @jinn-network/task-execution-testing
                       Conformance kit: golden + adversarial fixtures, the
                       backend sanity suite, an in-memory fake backend.
                       Depends on protocol + backend.
  backend-local/       @jinn-network/task-execution-backend-local
                       Local binding + reference implementation. Depends on
                       protocol + backend, and on evidence/execution-recorder
                       for capture (binding layer only).
```

The **marketplace binding does not live here.** It goes in the marketplace application tree
(client/ or a marketplace package), consuming the generic contract — it drags chain contracts,
Mech, IPFS, and Safe machinery that the generic stack must stay free of.

**Dependency rules (acyclic, enforced by architecture guard tests in the pattern the evidence
consolidation established):** `protocol` depends on nothing; `backend` → `protocol`;
`testing` → both; bindings → both, plus evidence packages only at the binding layer. Evidence
packages never depend on task-execution packages; the two protocol packages never import each
other — the seam is digest and URI references. Carrier profiles (HTTP service, queue mappings)
are future packages, not v1.

## 24. Conformance and fixture strategy

Four layers; the first two ship with the stack:

1. **Protocol conformance** (`testing/`): schema validation of all five families; sealing and
   digest rules — including the producer-side check (sealer output is valid JCS under the
   I-JSON profile) and the consumer-side check (verification never re-canonicalizes);
   reference and cardinality rules; extension preservation; observation ordering and fold
   correctness; Delivery binding; cancellation and terminal-state rules. Fixture families:
   **golden** (a complete local-and-marketplace scenario pair over one Task digest) and
   **adversarial**, which must include at minimum: malformed documents; digest mismatches;
   illegal and unsanctioned terminal transitions; replayed and out-of-order observations;
   `sequence` ordering at the fixed-width boundary; contradictory terminal observations;
   derived-`expired` vs late genuine terminal; `lost`-then-corrected terminal; forged
   cross-Attempt `supersedes`; cross-requester and same-key/different-bytes idempotency;
   dispatch-context grafting into a re-sealed crate (must be caught by the `dispatch-binding`
   check, not by structure alone); capability-grant misuse (leaked-Task resubmission);
   extension-override attempts; oversized inline content and payload-bound violations.
2. **Backend contract conformance**: a csi-sanity-style suite runnable against any
   implementation — byte-exact idempotent submit (same-key/same-bytes,
   same-key/different-bytes), honest observe, recover-after-restart with all three
   reconciliation outcomes, cancel races including cancel-after-terminal, unsupported
   requirement/parameter rejection, failure-category mapping, result retrieval on terminal
   attempts, concurrent Attempts within declared bounds. Proven first against the in-memory
   fake, then the local binding.
3. **Binding integration**: local round trip; marketplace round trip; at least one fake
   third-party backend passing the kit; exact artifact and evidence references verified end to
   end; cancellation races; backend interruption; delayed evaluation. Known scope limits,
   stated: confidential-input grant resolution and evidence capture are exercisable only at
   this layer (the kit's fake backend cannot prove them), and §19.10's third-party claim is
   demonstrated by the fake third-party backend until a real external implementation exists.
4. **Application acceptance**: application-specific and outside protocol conformance, by
   design.

## 25. Migration impact

This design mandates no flag day; both current systems adopt binding-by-binding. Declared
impact:

**Marketplace** (mapping, not contract changes):

- `task.v1` splits into the sealed Task (work statement) and Submission-derived posting data
  (window, claim policy, creator/signature); the passthrough-field wart (runtime fields riding
  into signed documents) ends because dispatch data has a home;
- `solverType` completes its deprecation into task profile URIs;
- the envelope's digest/signature duality converges: sha256 identity + DSSE signature at the
  protocol level, with CID locators and keccak anchors remaining binding-internal;
- the evaluator-authored evaluation task document is replaced by the creator-sealed
  `evaluation` descriptor plus evaluation-profile Tasks (the instance may still be sealed by
  the evaluating deployment; the specification-digest equality check preserves the
  commitment);
- the unenforced `claimPolicy` fields move to the Submission (`attempts`,
  `evaluationRequirements`), read by the layer that actually honors or rejects them.

**Autopilot**:

- `SessionExecutionBackend` migrates verb-for-verb: `start` → `submit` (sealed capsule content
  becomes a task profile); the liveness-only `recover` splits into honest `observe`/`recover`;
  the missing result path becomes `deliveries`/`fetchDelivery`;
- `effort` gains the core vocabulary key (§7.2) and stops dropping at the marketplace
  boundary;
- the session capsule's `receiptAuthors` (closed-fleet adoption allowlist) is not
  requester-neutral Task content: it moves to Submission `profileParameters` or pure
  application configuration, pending the open-fleet authorization object (§28);
- the attempt manifest's backend-tagged execution block maps onto Attempt correlation
  annotations; adoption receipts and lifecycle phases are untouched application state.

## 26. Recommended delivery sequence

Design/implementation sequencing to be planned later; the dependency-forced order is:

1. **Protocol package**: schemas, sealing, fold, validators, attempt-URI derivation, golden +
   adversarial fixtures.
2. **Backend contract + conformance kit**, proven against the in-memory fake backend.
3. **Local binding**, born under the kit.
4. **Evidence-capture integration** in the local binding (Execution Recorder wiring; receipt
   fields into Deliveries; dispatch-context artifact into captured inputs).
5. **Marketplace binding** in the marketplace tree (mapping table of §16.2).
6. **Autopilot adapter** (§25).
7. **Evaluation and verification integration**: evaluation-profile Tasks; the
   `evaluationSpecification`-digest crosswalk check; the `dispatch-binding` verification
   check; verification-backed attempt↔evidence binding.

Each stage is independently testable before the next exists; the kit precedes all real
bindings so bindings are conformant from birth.

## 27. Explicit non-goals

The Task Execution Protocol does not define: Evidence Protocol record definitions; execution
tracing; repository or artifact-storage implementation; discovery or search; evaluation
methods; trust or reputation; wallet, token, payment, reward, or staking semantics;
marketplace advertisement or settlement; GitHub mutation authority; Autopilot lifecycle rules;
scheduling or prioritization; task mining; benchmark construction; skill derivation; model
training; a general workflow language; container orchestration; a message broker; a hosted
execution service; a universal sandbox; or application-specific acceptance policy.

## 28. Non-blocking follow-ups

- **Package naming**: `task-execution-*` scope names are working titles; settle at
  implementation planning.
- **Media-type registration**: register the `vnd.jinn.task-execution.*` vendor-tree types with
  IANA (or document them as unregistered vendor types).
- **Evidence-profile minor addition**: extend the Evidence Protocol's `identifier`
  PropertyValue pattern (defined for Agents) to Task and Execution entities, and register the
  TEP scheme `propertyID` IRIs used by the crosswalk stamps (§18).
- **Carrier profiles**: an HTTP service shape for the backend contract (and any queue/on-chain
  observation transports) as separate future packages.
- **Open-fleet adoption authorization**: the launcher-signed authorization object anticipated
  by the marketplace-session design (§14 there) should be specified as an in-toto Statement
  over the correlation tuple — it slots into §21.2's "assertions about records" without core
  changes.
- **Streaming delivery** as a declared backend capability (v1 uses `partial` Deliveries).
- **Identity mapping profile**: canonical ERC-8004/wallet ↔ IRI mapping, layered above both
  protocols (both explicitly defer it).
- **Observation retention guidance** for backends (the protocol is silent on storage by
  design; operators will want a recommended floor).

## Appendix A. Sources used for the design audit

**This branch (`claude/task-execution-protocol-design-d04746`):**
`docs/superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md` (read in full);
`docs/superpowers/specs/fixtures/autopilot-issue-1697/` and
`fixtures/golden-execution-evidence-v1/`;
`docs/superpowers/specs/2026-07-23-autopilot-v2-marketplace-session-backend-design.md` (read in
full); `docs/superpowers/specs/2026-07-23-autopilot-oss-maintainer-product-design.md`;
`docs/superpowers/specs/2026-07-19-active-active-autopilot-lifecycle-design.md`;
`docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md`;
`docs/superpowers/specs/2026-07-17-autopilot-canonical-implement-issue-runtime-adapters-design.md`;
`docs/superpowers/specs/2026-07-21-autopilot-cursor-runtime-adapter-design.md`;
`docs/2026-07-23-jinn-mono-architecture-map.md`;
`spec/2026-07-20-autopilot-marketplace-execution.md` (superseded for lifecycle integration);
`spec/2026-06-30-tokenless-olas-native.md`; `spec/2026-05-05-solvernet-creation-and-launch.md`
§14; `spec/2026-06-04-task-structure-model.md`; `spec/2026-07-08-task-creator-v0.md`.

**origin/next @ 918e683d4 (production behavior, via `git show`):**
`packages/autopilot/src/lifecycle/{session-execution-backend,marketplace-session-backend,implementation-executor,review-executor,attempt-workspace,active-config,active-runtime-production,types,lifecycle}.ts`;
`packages/autopilot/src/dispatcher/{coordinator-session,wall-clock}.ts`;
`client/src/types/{task-document,task,task-run,envelope,window}.ts`;
`client/src/adapters/{adapter.ts,local/adapter.ts,mech/{adapter,types,digest,verdict-code}.ts}`;
`client/src/tasks/{signing,posting-service,sources,submit-request}.ts`;
`client/src/daemon/{daemon,creator,delivery-watcher}.ts`;
`client/src/harnesses/types.ts`,
`client/src/harnesses/engine/{state,engine,delivery,envelope-assembly,recovery}.ts`;
`contracts/src/tasks/TaskCoordinator.sol`; `contracts/src/staking/JinnRouterV3.sol`;
`packages/core/src/{execution-envelope,envelope,manifest}.ts`;
`packages/sdk/src/{harness,task-submit}.ts`, `packages/sdk/solvernets/manifest-schema.ts`.

**In-flight PR branches (via `git show`, worktrees untouched):**
`origin/codex/execution-recorder-pr1-contracts` and `-pr4-distribution`
(`packages/execution-recorder/`, `packages/evidence-protocol/`, `packages/evidence-repository/`,
`docs/superpowers/specs/2026-07-24-jinn-execution-recorder-design.md`);
`origin/codex/evidence-consolidation-pr5-layout-ci` (intended `packages/evidence/` layout).

**Standards (primary sources, fetched 2026-07-27):**
A2A specification v1.0.1 and `a2a.proto` (a2a-protocol.org; github.com/a2aproject/A2A);
MCP core 2025-06-18 progress utility and the Tasks extension (modelcontextprotocol.io;
github.com/modelcontextprotocol/ext-tasks); GA4GH TES v1.1 and WES v1.1.0 OpenAPI
(github.com/ga4gh); CloudEvents v1.0 spec, JSON format, sequence and distributed-tracing
extensions (github.com/cloudevents/spec); Kubernetes Job v1 API; AWS Batch job states; Google
Cloud Batch jobs API; CWL v1.2; JSON Schema 2020-12; W3C JSON-LD 1.1 (assessed, declined);
RFC 8785; RFC 9562; OCI image-spec descriptor; IPFS CID spec (specs.ipfs.tech); in-toto
Statement v1 and ResourceDescriptor v1; DSSE v1 `protocol.md`; OpenTelemetry Trace API; W3C
Trace Context; the IETF Idempotency-Key draft; Temporal retry-policy documentation (prior art
only).

**Backlog issues bearing on this design (open at audit time):**
#1650 (self-contained Tasks and EvaluationSpecs); the #2038 benchmarking train
(#2039–#2054, notably #2041 attested effective execution, #2044 authoritative lifecycle
evidence, #2047 generic capsule adapter); #1979 (execution terminology); #1236 (every claimed
task resolves to a legible verdict); #1430 (attested tier unreachable); #2169 (nested
`executionRequest` leak); #1643 (retry plumbing); #605 (paired settlement tracker).
