# Jinn Execution Evidence Profile 1.0

**Profile URI:** `https://spec.jinn.network/profiles/execution-evidence/v1`

**Profile version:** `1.0.0`

**Status:** Normative

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are to be interpreted as described
by RFC 2119 and RFC 8174.

## 1. Scope

This profile defines three independent, append-only record families:

1. **Execution Evidence** records a Task, Executor, Runtime Specification, Execution, Results,
   native trace, runtime observations, and capture provenance.
2. **Result Evaluation Evidence** records a later judgement of an exact Task and exact Results.
3. **Execution Verification Evidence** records a later verification of an exact Execution
   Evidence serialization and its named Execution.

Execution Evidence uses a constrained, flattened RO-Crate 1.3 JSON-LD serialization. Evaluation
and verification use in-toto Statement v1 inside DSSE. Stores, access control, identity
resolution, trust, policy, marketplace settlement, retention, and derived skills are outside
this profile.

Conformance applies to the exact bytes supplied to a validator. Semantically equivalent JSON-LD
serializations outside the constrained form are not v1 inputs.

## 2. Common identity and artifact rules

Every Agent MUST use a stable absolute IRI. A wallet, key, account, organization, or service MAY
be linked with standard identity relationships, but consumers MUST NOT infer control or trust
from an identifier alone.

Task and Execution entities MAY carry `identifier` values. A typed identifier record MUST be a
`PropertyValue` whose `propertyID` is an absolute IRI naming the identifier scheme and whose
`value` uses that scheme's native representation. The stable Jinn scheme-IRI spellings are:

- `https://spec.jinn.network/schemes/did-pkh` for `did:pkh` identifiers;
- `https://spec.jinn.network/schemes/did-key` for `did:key` identifiers;
- `https://spec.jinn.network/schemes/caip-19` for CAIP-19 identifiers;
- `https://spec.jinn.network/schemes/github` for GitHub identifiers;
- `https://spec.jinn.network/schemes/task-digest` for a Task's lowercase
  `sha256:<64 lowercase hexadecimal digits>` digest; and
- `https://spec.jinn.network/schemes/task-profile-uri` for the absolute task-profile URI committed by
  the Task.

These identifiers corroborate cross-record identity. They do not replace the exact Task artifact,
the primary Execution IRI, or a protocol-side Task-to-Execution edge, and they convey no
authorization or trust.

Every available byte-bearing artifact MUST carry a lowercase SHA-256 digest of its exact bytes.
Unavailable private bytes MAY be represented by their prior name and SHA-256 commitment. An
unavailable hosted or opaque component MUST be described by a content-bound observation
descriptor; producers MUST NOT invent bytes or a digest for material they did not capture.

A multi-file artifact MUST enumerate content-bound members and MUST itself be bound by a
content-bound aggregate manifest. Record metadata is itself byte-bearing and is identified by the
SHA-256 digest of the exact metadata bytes.

Imported, converted, corrected, or scrubbed entities MUST retain provenance with
`prov:wasDerivedFrom` and `prov:wasGeneratedBy`. An entity with either relationship is derived
for the purposes of the exact-role restrictions below.

## 3. Execution Evidence serialization

The document MUST be a UTF-8 JSON object with `@context` and a flat `@graph` array. The context
MUST include:

- `https://w3id.org/ro/crate/1.3/context`;
- `https://w3id.org/ro/terms/workflow-run/context`;
- `prov` mapped to `http://www.w3.org/ns/prov#`; and
- `jinn` mapped to `https://spec.jinn.network/terms/`.

Every graph entity MUST have one unique string `@id` and one or more string `@type` values.
Relationships between graph entities MUST use reference objects containing `@id`; nested entity
definitions are not allowed.

### 3.1 Metadata Descriptor and Root Dataset

The graph MUST contain exactly one Metadata Descriptor:

- `@id` is `ro-crate-metadata.json`;
- `@type` includes `CreativeWork`;
- `about` references `./`; and
- `conformsTo` references RO-Crate 1.3.

The graph MUST contain exactly one Root Dataset:

- `@id` is `./`;
- `@type` includes `Dataset`;
- `conformsTo` includes this profile URI;
- `mentions` references exactly one primary Execution;
- `creator` references the Agent that assembled the evidence;
- `datePublished` records the capture completion time; and
- `name`, `description`, `license`, and `hasPart` are present.

The profile URI MUST also identify a contextual entity whose types include `CreativeWork` and
`Profile`.

### 3.2 Task

The primary Execution's `object` MUST reference exactly one Task. That Task MUST:

- have types `File`, `CreativeWork`, and `prov:Plan`;
- be byte-bound with SHA-256 and declare `encodingFormat`;
- state the intended work rather than a post-hoc summary; and
- not be a derived or scrubbed substitute.

Additional task context MAY be linked separately, but MUST NOT replace the exact Task.

### 3.3 Executor and Runtime Specification

The primary Execution's `agent` MUST reference exactly one primary Executor Agent. Its type MUST
be compatible with `prov:Agent`: `Person`, `Organization`, or `prov:SoftwareAgent`.

The primary Execution's `instrument` MUST reference exactly one Runtime Specification. It MUST:

- have type `SoftwareApplication`;
- be byte-bound with SHA-256;
- identify the effective executor configuration; and
- reference with `hasPart` at least one content-bound controlled component or one content-bound
  opaque-component observation descriptor.

Controlled components include runner code, system prompts, tool policy, workflow configuration,
locks, and harness configuration. Hosted models need not be bundled; the captured observation
descriptor MUST identify what was requested and observed. The Runtime Specification used in this
exact historical role MUST NOT be derived.

### 3.4 Execution lifecycle

The primary Execution MUST:

- have types `CreateAction` and `prov:Activity`;
- use a `urn:uuid:` identifier;
- reference the Task with `object`, Executor with `agent`, and Runtime Specification with
  `instrument`;
- record `startTime`, `endTime`, and one supported `actionStatus`;
- reference exactly one duration `PropertyValue` through `resourceUsage`; and
- reference exactly one exact native trace through `subjectOf`.

Supported statuses are `CompletedActionStatus`, `FailedActionStatus`, and
`jinn:AbandonedActionStatus`. A completed Execution MUST reference at least one Result with
`result`. Failed or abandoned Executions MAY have none.

The duration `PropertyValue` MUST have `name`, numeric `value`, and a unit. The duration MUST be
consistent with the timestamps within serialization precision.

### 3.5 Results and native trace

Every Result MUST be content-bound and reference the Execution with `prov:wasGeneratedBy`. A File
Result MUST declare `encodingFormat`; an aggregate Result MUST enumerate members and use a
content-bound manifest. A Result in the exact historical role MUST NOT be derived.

The entity selected by `Execution.subjectOf` is the primary native trace. It MUST:

- be a `File`, `Dataset`, or `Collection`;
- reference the Execution with `about`;
- declare a trace format with `conformsTo`;
- be content-bound; and
- not be derived.

Other trace projections MAY also reference the Execution with `about`, but are not the primary
native trace unless selected by `subjectOf`.

### 3.6 Capture and derivation provenance

The Root Dataset's `creator` and `datePublished` identify capture provenance. Every derivation
activity MUST identify its Agent and completion time.

A scrub transformation MUST record:

- its private source commitment;
- the scrubber Agent;
- the applied policy;
- completion time;
- source-to-derived mappings; and
- disposition counts.

Mappings use `prov:wasDerivedFrom` and `prov:wasGeneratedBy`. Count `PropertyValue` entities are
linked from the transformation through `jinn:dispositionCount`. The transformation MUST NOT
embed the derived metadata digest: doing so would make the metadata digest circular.

A public derivative MAY retain an unavailable exact private native-trace commitment and add a
separately identified scrubbed trace. It MUST retain the same Execution ID and unchanged exact
Task and Result commitments. Private verification claims MUST NOT be transferred to a derivative
unless they independently bind that derivative's exact metadata bytes.

## 4. Result Evaluation Evidence

The envelope MUST be a DSSE object with:

- `payloadType` equal to `application/vnd.in-toto+json`;
- a strict standard or URL-safe base64 payload; and
- at least one signature object whose `sig` is strict base64. `keyid` is optional.

The decoded payload MUST be valid UTF-8 JSON and an in-toto Statement v1. The Statement MUST:

- use `_type` `https://in-toto.io/Statement/v1`;
- use `predicateType` `https://spec.jinn.network/attestations/result-evaluation/v1`;
- have unique subject names and lowercase SHA-256 digests;
- contain the exact Task subject and every exact Result subject covered by the verdict; and
- bind those names through `predicate.taskSubject` and `predicate.resultSubjects`.

The predicate MUST contain `evaluatedAt`, `evaluator.id`, and `verdict`.
`evaluationMethod`, `evaluationSpecification`, measurements, evidence, explanation, limitations,
`supersedes`, and `disputes` are optional. Every supplied byte-bearing Resource Descriptor MUST
carry SHA-256.

## 5. Execution Verification Evidence

Execution Verification uses the same DSSE and in-toto requirements. Its Statement MUST:

- use `predicateType` `https://spec.jinn.network/attestations/execution-verification/v1`;
- have exactly one subject named `ro-crate-metadata.json` with its SHA-256 digest; and
- contain `predicate.executionId`, `verifiedAt`, `verifier.id`, and `verdict`.

`verificationMethod`, `verificationPolicy`, checks, evidence, explanation, limitations,
`supersedes`, and `disputes` are optional. Verification evaluates execution integrity or method,
not whether the Result satisfies the Task.

## 6. Signatures, identity, and trust

Structural validation MUST retain the exact decoded DSSE payload bytes. Signature verification
MUST use DSSE Pre-Authentication Encoding over those exact bytes. Signature failure does not
alter structural conformance.

The reference implementation accepts a caller-supplied cryptographic verifier. It does not
resolve keys, bind `keyid` to an actor, authenticate actor identifiers, or infer trust.

## 7. Extensions and conformance

Unknown JSON-LD and in-toto fields MUST be retained and ignored for v1 conformance unless they
violate a stated structural constraint. Producers MAY add extension properties and entities.
Extensions MUST NOT weaken, replace, or contradict required relationships.

A record conforms only when every **MUST** and **MUST NOT** rule for its record family succeeds.
Conformance says the record is structurally interpretable. It does not say that artifact bytes
are available, signatures are valid, actors are trusted, claims are true, or work is good.

The only Jinn graph vocabulary terms defined by v1 are:

- `jinn:AbandonedActionStatus`; and
- `jinn:dispositionCount`.

New record families or incompatible requirements require a new profile version.
