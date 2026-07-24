# Jinn Attestation Issuer Design

**Date:** 2026-07-24

**Status:** Approved design

**Scope:** A producer-neutral TypeScript library that constructs, signs, validates, and commits
Jinn Result Evaluation Evidence and Execution Verification Evidence.

## 1. Summary

Jinn has three settled evidence record families:

1. Execution Evidence records what ran and what happened.
2. Result Evaluation Evidence records an evaluator's conclusion about a Task and its Results.
3. Execution Verification Evidence records a verifier's conclusion about the process represented
   by an exact Execution Evidence record.

The Execution Recorder produces the first family because execution facts arrive throughout a
potentially long-running process. The other two families are different: they are one-shot,
signed claims made after an evaluator or verifier has reached a conclusion.

`@jinn-network/attestation-issuer` fills that producer boundary:

```text
Evaluator or verifier
    decides what is true
             |
             v
Attestation Issuer
    packages and signs the decision
             |
             v
Evidence Repository
```

The issuer does not evaluate Results or verify Executions. It accepts a decision, binds that
decision to exact digest-addressed subjects, constructs the existing in-toto Statement and DSSE
envelope, validates the exact envelope bytes with the Evidence Protocol, and commits those bytes
through an injected Evidence Repository.

The package adds no record family or application policy.

## 2. Placement and dependencies

```text
External decision producers
  Marketplace evaluator / benchmark / human reviewer
  Execution auditor / policy checker / TEE verifier
                         |
                         v
      @jinn-network/attestation-issuer
                 |                 |
                 v                 v
        Evidence Protocol   Evidence Repository contract
```

The package is independently publishable as
`@jinn-network/attestation-issuer@0.1.0`. It depends only on:

- `@jinn-network/evidence-protocol@0.1.0`;
- `@jinn-network/evidence-repository@0.1.0`; and
- the Node 22 standard library.

It does not depend on:

- the Execution Recorder;
- a filesystem, OCI, IPFS, or other concrete repository binding;
- the plugin, Autopilot, marketplace, evaluator, verifier, or benchmark code;
- a wallet, blockchain, key-management service, or cryptographic algorithm package;
- a catalog, index, corpus, publication service, or scrubber.

The dependency direction remains one-way. Evaluator and verifier integrations depend on the
issuer; the issuer never depends on them.

## 3. Why this is an issuer, not another recorder

Execution capture has an extended lifecycle:

```text
start -> capture -> finalize
           ^
         resume
```

Attestation issuance operates on a conclusion and already-identified subjects:

```text
prepare and sign -> immutable prepared attestation -> commit
```

The issuer therefore has no execution-length workspace, journal, mutable capture state, or
`start`/`resume` lifecycle. If the evaluation or verification process is itself substantial, that
process may independently use the Execution Recorder. Its signed conclusion remains a separate
Result Evaluation or Execution Verification record.

This preserves two different facts:

- Execution Evidence can show what the evaluator or verifier did.
- Attestation Evidence states what the evaluator or verifier concluded.

Neither substitutes for the other.

## 4. Ownership boundary

### 4.1 The issuer owns

- typed construction of Result Evaluation and Execution Verification in-toto Statements;
- exact binding of caller-supplied digest-addressed subjects;
- validation of Agent IRIs, timestamps, verdicts, descriptors, correction references, and
  reserved extension fields;
- deterministic Statement and DSSE-envelope serialization, given exact signer output;
- DSSE pre-authentication encoding through the Evidence Protocol utility;
- invocation of a caller-supplied signer;
- structural validation of the completed exact envelope bytes;
- creation and validation of an immutable prepared-attestation value;
- idempotent commitment of prepared bytes through the Evidence Repository contract; and
- a receipt binding the repository write to the prepared record digest.

### 4.2 The evaluator or verifier owns

- selecting the Task, Results, or Execution Evidence to inspect;
- obtaining enough subject material to perform its work;
- running tests, rubrics, audits, policy checks, hardware attestation checks, or human review;
- deciding the verdict;
- choosing the evaluator or verifier Agent IRI;
- supplying the evaluation or verification time;
- accurately describing specifications, methods, measurements, checks, explanations, evidence,
  and limitations;
- storing supporting artifacts before issuance when durable retrieval is desired;
- selecting a signer authorized under its own identity and key policy;
- deciding whether issuance or repository failure changes its surrounding workflow; and
- retaining prepared bytes when retry across a process boundary is required.

### 4.3 Explicitly outside the issuer

The issuer does not:

- execute an evaluator or verifier;
- infer, calculate, normalize, or override a verdict;
- retrieve or require subject bytes;
- capture or store supporting artifacts;
- generate, import, retain, rotate, or resolve signing keys;
- bind a signing key to the claimed evaluator or verifier Agent;
- verify its own signature unless an external consumer later supplies a verification callback;
- assign trust, reputation, eligibility, payment, or marketplace meaning;
- publish to a public repository automatically;
- register a record with a catalog;
- discover earlier claims;
- select corrections or disputes;
- scrub, redact, or derive claims; or
- define retention or deletion policy.

## 5. Public lifecycle

The primary API is deliberately two-step:

```ts
const prepared = await prepareResultEvaluation(input, signer, options);
// or: prepareExecutionVerification(input, signer, options)

const receipt = await commitPreparedAttestation(
  prepared,
  repository,
  options,
);
```

Preparation and commitment are separate because signing is not necessarily deterministic. If a
repository operation fails after signing, the caller retains the exact prepared envelope and
retries those same bytes rather than creating another signature and another record identity.

The package also exposes:

```ts
parsePreparedAttestation(envelopeBytes): PreparedAttestation;
```

This reconstructs and validates a prepared value from exact persisted envelope bytes. It permits
a producer to retain prepared bytes in its own durable workflow without introducing an
issuer-owned workspace format.

There is no convenience operation that silently re-signs after a failed repository write. A
future application may compose preparation and commitment, but the prepared attestation remains
the explicit retry unit.

## 6. Common resource references

All Task, Result, Execution Evidence, method, specification, policy, evidence, correction, and
dispute references are content-bound. The public input surface uses a normalized descriptor:

```ts
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface AttestationResourceReference {
  readonly name: string;
  readonly digest: `sha256:${string}`;
  readonly uri?: string;
  readonly mediaType?: string;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}
```

The issuer maps the textual digest into the in-toto Resource Descriptor
`{ digest: { sha256: "<hex>" } }` form. Names are non-empty. Digests use exactly 64 lowercase
hexadecimal characters. Unknown permitted descriptor fields survive serialization; extensions
cannot override `name`, `digest`, or other issuer-owned descriptor fields.

Subject references are sufficient for conformance and issuance. The issuer does not require that
the referenced bytes are available through the target repository. This permits:

- evaluation of private Results without publishing their bytes;
- later evaluation after artifacts have moved between repositories;
- correction or dispute of an older claim;
- verification of an exact record retained outside the destination repository; and
- claims whose supporting evidence is access-controlled.

Availability is distinct from identity. An evaluator or verifier remains responsible for having
inspected adequate material. Callers may separately retrieve and check available bytes through
the repository and protocol APIs, but the issuer neither requires nor interprets that check.

## 7. Result Evaluation input

```ts
export interface PrepareResultEvaluationInput {
  readonly task: AttestationResourceReference;
  readonly results: readonly [
    AttestationResourceReference,
    ...AttestationResourceReference[],
  ];
  readonly evaluator: {
    readonly id: string;
    readonly extensions?: Readonly<Record<string, JsonValue>>;
  };
  readonly evaluatedAt: string;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly evaluationSpecification?: AttestationResourceReference;
  readonly evaluationMethod?: AttestationResourceReference;
  readonly measurements?: readonly EvaluationMeasurement[];
  readonly evidence?: readonly AttestationResourceReference[];
  readonly explanation?: string;
  readonly limitations?: readonly string[];
  readonly supersedes?: readonly AttestationResourceReference[];
  readonly disputes?: readonly AttestationResourceReference[];
  readonly statementExtensions?: Readonly<Record<string, JsonValue>>;
  readonly predicateExtensions?: Readonly<Record<string, JsonValue>>;
}
```

The issuer constructs one in-toto subject for the Task and one for every Result covered by the
verdict. Subject names must be unique. `taskSubject` and `resultSubjects` are derived by the
issuer; callers cannot set them separately.

`evaluatedAt` is a strict RFC 3339 timestamp supplied by the caller. The issuer never reads the
clock implicitly. The evaluator ID must be an absolute IRI.

Evaluation specification, method, measurements, evidence, explanation, limitations,
`supersedes`, and `disputes` remain optional as defined by the Evidence Protocol. Their absence
does not prevent base conformance. An application or marketplace may impose a stricter admission
profile above this package.

The issuer never translates tests, task success flags, accepted diffs, scores, or human actions
into a verdict. The evaluator supplies the verdict explicitly.

## 8. Execution Verification input

```ts
export interface PrepareExecutionVerificationInput {
  readonly executionEvidenceDigest: `sha256:${string}`;
  readonly executionId: string;
  readonly verifier: {
    readonly id: string;
    readonly extensions?: Readonly<Record<string, JsonValue>>;
  };
  readonly verifiedAt: string;
  readonly verdict: "verified" | "rejected" | "inconclusive";
  readonly verificationPolicy?: AttestationResourceReference;
  readonly verificationMethod?: AttestationResourceReference;
  readonly checks?: readonly VerificationCheck[];
  readonly explanation?: string;
  readonly limitations?: readonly string[];
  readonly supersedes?: readonly AttestationResourceReference[];
  readonly disputes?: readonly AttestationResourceReference[];
  readonly statementExtensions?: Readonly<Record<string, JsonValue>>;
  readonly predicateExtensions?: Readonly<Record<string, JsonValue>>;
}
```

The issuer constructs exactly one in-toto subject:

```json
{
  "name": "ro-crate-metadata.json",
  "digest": {
    "sha256": "<execution-evidence-record-digest>"
  }
}
```

The `executionId` names the primary historical Execution inside that evidence record. It is an
absolute IRI and is not a content digest. The issuer binds the supplied value but does not fetch
the subject record to rediscover it; truthfulness remains the verifier's responsibility.

`verifiedAt` is caller-supplied strict RFC 3339. Policy, method, checks, explanation, limitations,
corrections, and disputes retain the optionality defined by the protocol.

Verification covers process properties such as trace integrity, allowed tools, identity,
environment integrity, originality, or policy compliance. It does not assert Result correctness.

## 9. Signing interface

The issuer accepts a caller-supplied signer:

```ts
export interface DsseSigningRequest {
  readonly payloadType: string;
  readonly payloadBytes: Uint8Array;
  readonly preAuthEncoding: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface DsseProducedSignature {
  readonly signature: Uint8Array;
  readonly keyid?: string;
}

export type DsseSigner = (
  request: DsseSigningRequest,
) => Promise<
  readonly [DsseProducedSignature, ...DsseProducedSignature[]]
>;
```

The issuer:

1. deterministically serializes the in-toto Statement;
2. computes DSSE pre-authentication encoding for the exact payload bytes;
3. supplies both forms to the signer;
4. preserves returned signature order;
5. encodes payload and signatures using canonical padded standard base64;
6. constructs the DSSE envelope; and
7. validates the exact envelope bytes through the corresponding Evidence Protocol validator.

The signer owns all cryptographic and key-management behavior. It may represent a local key,
hardware device, wallet bridge, KMS, remote signing service, or threshold-signing coordinator.
Private keys are never arguments or return values.

One attestation contains one claimed evaluator or verifier Agent. Multiple signatures may
authenticate that same claim under the signer's policy. Multiple independent evaluators or
verifiers issue separate records rather than placing several actor identities behind one
predicate.

`keyid` is optional and opaque. Neither it nor signature success binds the key to the claimed
Agent IRI. Identity binding and consumer trust remain separate layers.

## 10. Exact bytes and prepared attestations

The issuer serializes JSON using:

- recursively sorted object keys;
- a fixed Task-first subject order for Result Evaluation;
- caller order for Results, signatures, measurements, checks, evidence, corrections, disputes,
  and other arrays;
- two-space indentation; and
- one trailing newline.

It does not claim RFC 8785 conformance. Identical normalized inputs and identical ordered signer
output produce identical bytes. A different signature, signature order, whitespace, or extension
changes the envelope bytes and therefore the record digest.

The prepared result is immutable from the caller's perspective:

```ts
export interface PreparedAttestation<
  TFamily extends "result-evaluation" | "execution-verification",
  TValue,
> {
  readonly family: TFamily;
  readonly recordDigest: `sha256:${string}`;
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly value: TValue;
}
```

Implementations defensively copy byte arrays at public boundaries. `recordDigest` is computed
over the exact envelope bytes. The parsed value is the successful Evidence Protocol validation
result, not a second independently constructed representation.

`parsePreparedAttestation`:

- detects the predicate type from the decoded Statement;
- rejects Execution Evidence and unknown predicate types;
- invokes the corresponding protocol validator;
- recomputes the record digest; and
- returns defensive copies only after successful validation.

## 11. Supporting artifacts and corrections

The issuer accepts supporting artifacts by reference only. A producer that wants a test report,
rubric, policy, method descriptor, screenshot, or log to remain retrievable stores its exact bytes
before preparing the attestation:

```text
store supporting artifacts
          |
          v
prepare and sign claim containing their references
          |
          v
commit signed claim last
```

This ordering prevents a signed record from being committed before the producer has attempted to
make its intended support durable. It does not guarantee future availability; retention remains a
repository or custody policy.

`supersedes` and `disputes` are also exact Resource Descriptors. The issuer preserves the
caller's declared relationship but does not discover earlier claims or decide whether a
correction is authoritative. A correction, re-evaluation, dispute, or withdrawal is always
another immutable attestation; no earlier record is edited.

## 12. Repository commitment

```ts
export interface AttestationCommitReceipt<
  TFamily extends "result-evaluation" | "execution-verification",
> {
  readonly family: TFamily;
  readonly recordDigest: `sha256:${string}`;
  readonly repositoryReceipt: RepositoryWriteReceipt<EvidenceRecordReference>;
}
```

`commitPreparedAttestation`:

1. checks cancellation;
2. revalidates the prepared envelope bytes with the Evidence Protocol;
3. recomputes and compares the record digest;
4. checks that the validated predicate type matches the prepared family;
5. calls `repository.putRecord(family, envelopeBytes)`;
6. verifies that the repository receipt matches the prepared digest and exact byte size; and
7. returns the immutable commit receipt.

The repository write is content-addressed and idempotent. A retry of the same prepared bytes may
return `created` or `existing` without changing identity.

Repository failures propagate as their original `EvidenceRepositoryError`, including their code
and cause. The issuer neither wraps those failures nor invokes the signer during commitment.

## 13. Extensions and reserved fields

Protocol schemas remain open to unknown fields. The issuer preserves JSON-valued extensions at
the explicitly supported Statement, predicate, Agent, Resource Descriptor, measurement, and
check locations.

Extensions cannot override fields owned by the issuer, including:

- `_type`, `subject`, and `predicateType`;
- `payloadType`, `payload`, and `signatures`;
- evaluator, verifier, timestamp, verdict, and subject-binding fields;
- Task, Result, Execution Evidence, or Execution identities;
- Resource Descriptor names and digests; or
- correction and dispute relationships supplied through their typed inputs.

Non-JSON values, unsafe object prototypes, duplicate normalized keys, and reserved-key collisions
are rejected before signing. Unknown permitted fields survive preparation, validation, parsing,
and repository round trips.

## 14. Errors and cancellation

Stable issuer error codes are:

- `INVALID_ISSUANCE_INPUT`;
- `SIGNING_FAILED`;
- `INVALID_SIGNER_OUTPUT`;
- `PROTOCOL_CONFORMANCE_FAILED`;
- `PREPARED_ATTESTATION_INVALID`;
- `UNSUPPORTED_ATTESTATION_FAMILY`;
- `OPERATION_ABORTED`; and
- `INTERNAL_FAILURE`.

`AttestationIssuerError` retains the stable code and optional cause.

Failure ordering is deliberate:

- invalid inputs fail before the signer is invoked;
- an aborted preparation does not invoke or reinvoke later stages;
- signer errors are wrapped as `SIGNING_FAILED` without exposing private material;
- empty or non-byte signatures and non-string `keyid` values fail as `INVALID_SIGNER_OUTPUT`;
- a completed envelope that fails the normative validator produces
  `PROTOCOL_CONFORMANCE_FAILED`;
- malformed or tampered retained bytes fail parsing as `PREPARED_ATTESTATION_INVALID`;
- cancellation before repository commitment performs no write; and
- repository errors propagate unchanged.

The package makes no trust or quality warnings. It reports construction and commitment failures
only.

## 15. Consumer and producer examples

### 15.1 Marketplace evaluation

```text
Marketplace evaluator
  |- retrieves Task and Result material under marketplace policy
  |- runs tests or human review
  |- stores optional reports and method descriptors
  |- decides pass / fail / inconclusive
  `- prepares, signs, and commits Result Evaluation Evidence
```

Wallet identity, ERC-8004 registration, authorization, reputation, admission, and settlement are
marketplace layers. A marketplace profile may require more supporting fields than the base
protocol or issuer.

### 15.2 Execution verification

```text
Execution auditor
  |- retrieves the exact Execution Evidence record where permitted
  |- checks trace, environment, policy, identity, or attestation material
  |- stores optional reports and method descriptors
  |- decides verified / rejected / inconclusive
  `- prepares, signs, and commits Execution Verification Evidence
```

### 15.3 Human or plugin-originated evaluation

A plugin may expose a human action as an evaluation only when it can truthfully identify the
evaluator, evaluation time, exact Task and Results, and explicit verdict. The issuer does not
convert an ambiguous UI event such as “closed,” “accepted,” or “thumbs up” into protocol evidence.

## 16. Test contract

The package ships a reusable test kit for signer and integration adapters. Its acceptance suite
proves:

- minimal Result Evaluation and Execution Verification inputs produce conforming records;
- Task, Result, Execution Evidence, and Execution IDs bind exactly;
- Result Evaluation requires one Task and at least one Result with unique subject names;
- reference-only private or unavailable subjects remain valid;
- supporting evidence is never written by preparation;
- optional methods, policies, evidence, measurements, checks, corrections, disputes, and
  extensions survive exact serialization;
- invalid inputs never invoke the signer;
- caller time is preserved and no implicit clock is read;
- the signer receives exact payload and DSSE pre-authentication bytes;
- one or more signatures retain caller order and optional `keyid`;
- signer failure or invalid output writes nothing;
- prepared record digests match the exact DSSE envelope bytes;
- `parsePreparedAttestation` round-trips exact retained envelopes and rejects tampering;
- commitment revalidates bytes before writing;
- repository writes occur only after successful signing and validation;
- repository errors remain `EvidenceRepositoryError`;
- a failed commit can retry the same prepared bytes without signing again;
- repeated commit is idempotent;
- multiple evaluations or verifications may address the same subjects;
- separate evaluation and verification verdict axes cannot be conflated; and
- packed installation contains no undeclared Jinn, signer, wallet, or concrete repository
  dependency.

The fixtures include deterministic fake signer output. They demonstrate serialization and
binding, not trust in the fixture key or actor.

## 17. Alternatives considered

### Separate evaluation and verification recorder packages

Rejected. The two families share Statement construction, DSSE signing, exact-byte validation,
retry, and repository commitment. Separate packages would duplicate nearly all machinery and
incorrectly imply an execution-length recording lifecycle.

### Construction and signing inside Evidence Protocol

Rejected. The Evidence Protocol is an I/O-free reference implementation and validator. Signing
invokes an external capability and repository commitment performs I/O. Moving those operations
into the protocol would collapse a boundary already relied upon by other consumers.

### A generic arbitrary-attestation API

Rejected for the public v1 surface. The package supports exactly the two Jinn claim families and
derives their predicate types and subject-binding fields. A generic API would allow callers to
bypass those invariants while adding no required use case.

### Issuer-owned supporting-artifact ingestion

Rejected. It would turn a one-shot issuer into another multi-object recorder, require durable
recovery machinery, and duplicate the Evidence Repository's existing exact-byte artifact API.

### Mandatory subject retrieval

Rejected. Digest identity does not require availability in one repository. Mandatory retrieval
would prevent valid claims about private, moved, historical, or access-controlled evidence and
would turn storage placement into a protocol-level issuance rule.

## 18. Settled invariants and deferred work

The following are settled:

- evaluators and verifiers decide; the issuer packages their decisions;
- one shared package has two typed preparation operations;
- subjects and support are digest-addressed references;
- subject availability is not an issuance requirement;
- support is stored before issuance by the producer, not by the issuer;
- signing and repository commitment are separate;
- prepared exact envelope bytes are the retry unit;
- signing keys are injected and never equated with Agent identity;
- Result Evaluation and Execution Verification remain independent, append-only record families;
  and
- the Evidence Protocol and Repository remain unchanged.

Deferred to separate layers:

- evaluator and verifier implementations;
- key storage, wallet signing, identity binding, and trust resolution;
- public derivation and scrubbing;
- catalog registration and claim discovery;
- marketplace evidence profiles, admission, payment, and reputation;
- repository retention and deletion;
- plugin and Autopilot integration; and
- migration of legacy evaluations or verification-like fields.
