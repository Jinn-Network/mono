# Evidence Derivation Design

**Date:** 2026-07-26

**Status:** design closed; implementation pending; exact claim applicability clarified after
publication and repository review; the optional ML binding and every producer composition are
follow-ups

**Scope:** `packages/evidence/derivation` — a structure-aware, side-effect-free pipeline that
turns one conforming private Execution Evidence record and its available artifacts into either the
same publishable bytes, a new conforming public derivative plus a scrub receipt, a review hold, or
a withholding decision

**Out of scope:** protocol semantics; signer or key management; evaluation, verification, or trust
policy; repositories and publication transports; review-queue persistence or UI; the optional ML
runtime binding; legacy `EpisodeV1`, trajectory-envelope, capture, seed, distill, client, layer, or
Autopilot cutover; and the final disposition of `packages/core`

**Implementation entrypoint:** read
`../prompts/2026-07-26-evidence-substrate-implementation-foundation.md` first. It is authoritative
for the base branch, package paths, shared-file ownership, and PR order.

## 1. Decision

Jinn will add `@jinn-network/evidence-derivation` as a **Pipeline** package. It implements the
derivation semantics already fixed by the Execution Evidence Protocol while owning the
non-protocol safety machinery that the protocol deliberately refuses: structure-aware scan
surfaces, detector contracts, detection rules, disposition policy, deterministic rewriting,
withholding, review holds, and scrub-receipt construction.

The package's functional core and built-in detectors form a pure transform. They accept exact
source bytes and exact policy/configuration bytes, perform no repository, network, durable
filesystem, clock, randomness, or other ambient I/O, and return exact output bytes. The pipeline
never mutates the source, writes a repository, publishes a record, invokes a signer, or blocks on a
human. The same purity claim applies to the complete derivation operation only when every injected
detector conforms to the detector obligations in §6.1.

The base package includes the deterministic safety floor adapted from `packages/core/src/scrub/`.
GLiNER stays out of the base package and later ships as
`@jinn-network/evidence-derivation-ml`, an optional binding over the detector port. The retired
Transformers.js path does not move into the new stack.

This is plannable as one base package. The ML binding is independently useful and independently
testable, so it is a follow-up package rather than a second task hidden inside this extraction.

## 2. What this package refuses

| Concern | Owner and reason |
| --- | --- |
| Derivation semantics | `evidence-protocol`; this package implements §6.8 and §10 without reinterpreting them |
| Source capture and finalization | `execution-recorder`; derivation begins from a sealed record |
| Result correctness or process integrity | Evaluators and verifiers; scrubbing is not a claim |
| Signing or rewriting DSSE envelopes | `attestation-issuer` plus its injected `DsseSigner`; signed bytes are immutable |
| Signature verification, identity binding, and trust | Signature-verification and application policy |
| Repository reads and writes | Composition over `EvidenceRepository`; the transform itself is side-effect-free |
| Public placement and announcement | `publication`; it copies already-derived exact bytes unchanged |
| Public/private repository classification | The composition root; the repository contract has no visibility tier |
| Corpus admission, retrieval visibility, ranking, or “safe enough” product policy | Application policy above the substrate |
| Review queue, operator-local paths, CLI, and human workflow | The application that can actually ask a human |
| Model download, cache, warm-up, device selection, and inference runtime | Optional ML binding |
| Local-corpus loading and detector benchmark CLI | A separate development tool; not runtime substrate |
| Legacy trace hash-chain rebuilding and capture-span formats | Existing legacy path until a separate cutover |
| Migration from `EpisodeV1` or deletion of `packages/core/src/scrub/` | Later strangler-fig work |

The package must not become “the thing that handles secrets.” Its unit is a conforming Execution
Evidence record. A generic string scrubber, credential scanner service, DLP database, or operator
review product does not belong here.

## 3. Alternatives considered

### 3.1 Chosen: one structure-aware package plus an optional detector binding

The package owns record parsing, safe scan-surface extraction, deterministic built-in detectors,
disposition, public-record construction, and the receipt. A detector port permits heavyweight or
deployment-specific detectors without making them runtime dependencies.

This keeps the semantic invariant and the safety mechanism in the one place that can enforce both:
the code that sees the RO-Crate graph and knows which values are historical commitments.

### 3.2 Rejected: move all 35 scrub files unchanged

The incumbent directory mixes a generic attribute-bag pipeline, trajectory-specific emitters,
application filesystem state, model boot behavior, and a benchmark tool. Moving it intact would
preserve the flat boundary that caused the extraction.

It would also remain structure-blind at the record boundary. A detector that receives raw JSON
without knowing whether a token is a digest, signature, model identifier, or human-authored value
cannot satisfy protocol §10.

### 3.3 Rejected: a generic redaction package plus a thin evidence adapter

A generic `redaction-engine` would create a second package and a public contract whose only new-stack
consumer is derivation. Worse, it would encourage callers to run the generic engine over raw
evidence bytes before the evidence adapter can identify protected structure.

The useful abstraction is the detector seam inside a structure-aware derivation, not a
structure-blind scrubber below it.

### 3.4 Rejected: application-owned detectors with a minimal metadata assembler

This would make every producer rediscover the same credential, private-key, identity, path, IP,
and technical-token rules. It would leave no shared safety floor and no policy digest with stable
meaning. Detection policy is not protocol semantics, but it is reusable pipeline behavior and
belongs in this package.

### 3.5 Rejected: include GLiNER and Transformers.js in the base package

That would add two heavyweight model runtimes, model download behavior, native inference
dependencies, and weaker reproducibility to every deployment. It would also violate the binding
rule that one heavyweight adapter should bring one heavyweight dependency.

## 4. Layer, dependencies, and package shape

The package is a Pipeline by the layer architecture membership test:

- its input is one conforming record;
- its output is the same record or another conforming record;
- it introduces no evidence entity or relationship semantics; and
- changing its policy or detector behavior does not change the protocol version.

Dependencies point down:

```text
evidence-derivation (Pipeline)
  ├── evidence-protocol (Semantics)
  ├── @secretlint/core
  ├── @secretlint/secretlint-rule-preset-recommend
  └── canonicalize / @noble/hashes

evidence-derivation-ml (later Binding)
  ├── evidence-derivation (detector port)
  └── @lmoe/gliner-onnx (one heavyweight runtime)
```

The base package has no filesystem, SQLite, network, Hugging Face, GLiNER, Transformers.js,
wallet, viem, repository contract or binding, publication, discovery, recorder, issuer, or
application dependency. Its byte-port reference/digest value types are package-local and do not
create a storage dependency.

The package exports:

- `.` — the operation, value types, policy parser, built-in detector factory, errors, and receipt
  parser;
- `./testing` — the deriver and detector contract kits plus synthetic fixtures.

It does not export internal codecs, generic canonical-JSON/hash helpers, graph mutation helpers,
or the vendored rule packs as independent APIs.

## 5. The port

The public port is a value-in/value-out operation. It is deliberately not a repository-shaped
service:

```ts
export interface EvidenceDeriver {
  derive(
    input: DeriveExecutionEvidenceInput,
    options?: DerivationOperationOptions,
  ): Promise<EvidenceDerivationOutcome>;
}

export function createEvidenceDeriver(
  options: CreateEvidenceDeriverOptions,
): EvidenceDeriver;
```

`createEvidenceDeriver` receives the detector implementations available in this deployment. The
input policy names the exact detector descriptors it requires. Construction does not select
policy implicitly.

### 5.1 Exact input

```ts
export interface DeriveExecutionEvidenceInput {
  readonly sourceRecord: {
    readonly reference: {
      readonly family: "execution-evidence";
      readonly digest: `sha256:${string}`;
    };
    readonly bytes: Uint8Array;
  };

  /**
   * Exact bytes available to this derivation, keyed by the entity id used in
   * source metadata. Missing bytes stay unavailable and cannot be published.
   */
  readonly sourceArtifacts: readonly {
    readonly entityId: string;
    readonly bytes: Uint8Array;
  }[];

  /** Exact RFC 8785 policy artifact bytes; no hidden defaults. */
  readonly policyBytes: Uint8Array;

  /** Exact canonical, public-safe description of the scrubber build/runtime. */
  readonly scrubber: {
    readonly agentId: string;
    readonly implementationDescriptorBytes: Uint8Array;
  };

  /** Caller-supplied strict RFC 3339 time; the deriver never reads the clock. */
  readonly completedAt: string;
}
```

The deriver validates that:

1. the source reference digest matches `sourceRecord.bytes`;
2. the source bytes conform through `validateExecutionEvidence`;
3. every supplied artifact matches the SHA-256 declared for its entity;
4. policy bytes are canonical and valid under this package's policy schema;
5. the scrubber Agent is an absolute IRI and its descriptor is canonical, content-bound, and
   valid under the closed public implementation-descriptor schema; and
6. the supplied detector descriptors exactly satisfy the policy requirements.

The input is a closed byte set, not an artifact-reader callback. A composition root retrieves
source bytes through its existing `EvidenceRepository` and then invokes the transform. This avoids
adding another I/O port, makes retries independent of repository state, and gives determinism a
precise input boundary.

### 5.2 Exact output

```ts
export type EvidenceDerivationOutcome =
  | PublishableUnchangedOutcome
  | DerivedExecutionEvidenceOutcome
  | ReviewRequiredOutcome
  | WithheldOutcome;
```

| Status | Meaning | Publishable bytes returned |
| --- | --- | --- |
| `publishable-unchanged` | Every selected source byte is safe under this exact policy | The exact source record and safe source artifacts; no new record or protocol scrub activity |
| `derived` | At least one transform or withholding action occurred and a conforming public representation was built | New metadata bytes, retained safe artifacts, derived artifacts, policy, implementation descriptor, and receipt |
| `review-required` | At least one `review` disposition remains unresolved | None; private findings are returned to the application |
| `withheld` | The record cannot be represented safely or a required safety component failed | None; stable reason codes are returned |

Expected policy outcomes are values, not exceptions. Invalid inputs, corrupt bytes, detector
contract violations, cancellation, and internal construction defects throw typed errors.

All public byte arrays are defensive copies. The operation never mutates inputs.

## 6. The detector port and policy

### 6.1 Detector port

```ts
export interface DerivationDetector {
  readonly descriptor: DerivationDetectorDescriptor;

  detect(
    surface: DerivationSurface,
    options?: DerivationOperationOptions,
  ): Promise<readonly DerivationFinding[]>;
}

export interface DerivationDetectorDescriptor {
  readonly id: string;
  readonly version: string;
  readonly implementationDigest: `sha256:${string}`;
  readonly reproducibility: "byte-stable" | "best-effort";
  readonly configurationDigest?: `sha256:${string}`;
}
```

`configurationDigest` is a nonce-hardened commitment to the exact private detector configuration,
not a bare hash of low-entropy values. It is SHA-256 over a canonical envelope containing the
configuration schema version, a caller-supplied private nonce of at least 128 random bits, and the
exact configuration. The nonce is part of the detector's explicit private input, is never
published, and must be persisted by a caller that expects byte-stable replay. The package never
generates it. This prevents the public commitment from becoming a practical dictionary oracle
unless the nonce is reused or disclosed.

The descriptor has no arbitrary public-configuration object. Public recipe identity belongs in
the detector's package-owned `id`, `version`, and `implementationDigest`; private behavior-affecting
configuration is represented only by `configurationDigest`. This closed shape makes it impossible
to serialize injected identities, private allowlist values, commitment nonces, paths, hostnames,
environment values, device identifiers, or other operator-specific material through a descriptor.

A `DerivationSurface` is already classified by the package. It contains an opaque `surfaceId`,
the source entity and media type, the protocol role, the transformable text, and enough codec
location information to apply valid spans. It never contains raw `ro-crate-metadata.json` or a
protected structural value.

A `DerivationFinding` contains class, confidence band, valid character offsets, stable evidence
codes, and the detector descriptor. It contains no matched plaintext and no free-form snippet.
`start` and `end` are zero-based UTF-16 code-unit indices into the exact `DerivationSurface.text`;
`start` is inclusive and `end` is exclusive, matching JavaScript `String.prototype.slice`.
Both are integers, `0 <= start < end <= text.length`, and neither boundary may split an existing
high/low surrogate pair. Detectors, normalization, disposition, and text/JSON/JSONL codecs use
this one coordinate system without conversion.

An injected detector is a trusted private-data processor: `detect` receives transformable source
plaintext. A conforming detector performs no network, repository, durable filesystem, clock,
randomness, or other ambient I/O, and it retains no surface text after the returned promise
settles, whether it fulfills, rejects, or observes cancellation. Configuration and reproducibility
inputs are explicit.

JavaScript provides no sandbox around an injected detector. Applications must inject only code
they trust with the private source content. The detector contract kit supplies conformance
evidence through test-only effect and retained-surface observers, but those observers cannot
isolate malicious code or prove that a dishonest third-party harness reports its hidden behavior.

`derivation/testing` exports:

```ts
describeDerivationDetectorContract(factory, fixtures): void
```

The factory returns the detector plus required test-only `ambientEffectCount()` and
`retainedSurfaceCount()` observers. The generic suite checks that both counts remain zero after
successful and cancelled detection, along with input immutability, valid spans, stable descriptor
identity, duplicate/ordering normalization, absence of matched plaintext in findings, and the
claimed reproducibility grade. Each concrete detector's own tests must apply the same assertions
to every operational rejection path it implements. A detector declaring `byte-stable` must return
canonically identical findings on repeated calls.

### 6.2 Policy is an exact artifact

`policyBytes` must be canonical JSON with schema version
`jinn.evidence-derivation-policy.v1`. The policy includes:

- policy name and version;
- required detector descriptors and whether `best-effort` detectors are permitted;
- metadata properties that may be transformed and structural properties that are protected;
- a complete disposition table for the package's closed protected-value classes;
- media-type/role codec rules;
- finding-class and confidence-to-disposition mappings;
- an explicit unmatched-finding disposition limited to `review` or `withhold-record`, so an
  optional detector's new class can never inherit a runtime default;
- redaction stubs;
- digests of private detector configurations, including known-identity packs;
- public technical allowlist entries whose exact values are safe to disclose, plus a digest for
  any private allowlist configuration;
- behavior for unavailable, binary, unsupported, and signed content; and
- the explicit Result-transform behavior.

Disposition values are:

- `retain`;
- `redact`;
- `withhold-artifact`;
- `withhold-record`; and
- `review`.

There are no hidden runtime defaults inside `derive()`. The package may ship a deterministic
baseline policy artifact for callers to copy, but the exact bytes are always supplied and
content-bound. Changing a threshold, detector, label set, allowlist, stub, codec rule, or Result
behavior changes the policy digest.

Finding classes remain extensible at the detector port. If no class/confidence row matches a
contract-valid finding, `derive()` applies the policy artifact's exact
`unmatchedFindingDisposition`. It never implicitly retains or redacts an unmatched finding.

Private known-identity values, review decisions, private paths, private allowlist values, and
commitment nonces never appear in the attached policy. They configure a detector before
`createEvidenceDeriver`; that detector's public descriptor carries only the nonce-hardened digest
of the exact private configuration. The policy requires that descriptor and digest. The receipt
repeats the digest, never the values or nonce.

The scrubber implementation descriptor follows
`jinn.evidence-derivation-implementation.v1`, a closed canonical JSON schema. It contains only the
package name and version, a content digest for the controlled build, a public runtime family and
version, and the public detector descriptors. It has no arbitrary build-description field.
Private runtime flags, host/device facts, paths, caches, and environment values are represented
only by configuration digests when they affect the recipe.

Safety-policy versions are package behavior, not protocol versions.

### 6.3 Built-in detector inventory

The deterministic base adapts the incumbent's hard-won rules:

| Class | Detection |
| --- | --- |
| `credential` | Secretlint preset plus pinned Gitleaks subset and AWS/GCP credential identifiers |
| `high-entropy-secret` | Entropy fallback only after technical-token and structure classification |
| `url-credential` | URL userinfo and credential query parameters |
| `funds-controlling-secret` | Context-gated private keys and BIP-39 mnemonic runs |
| `environment-dump` | Runs of environment assignments |
| `email` | Email shape |
| `git-identity` | Git author/committer/trailer and `user.name` / `user.email` carriers |
| `known-identity` | Exact injected operator identity values; the public descriptor exposes only their configuration digest |
| `wallet-address` | `0x` plus 40 hexadecimal characters |
| `payment-instrument` | Luhn-valid card numbers and mod-97-valid IBANs |
| `ip-address` | Public/private/loopback/reserved range classification |
| `absolute-path` | Home-directory identity carriers |
| `machine-identity` | Hostname and machine-name carriers |

The policy uses semantic class names rather than carrying the incumbent `A1`–`E1` taxonomy into a
new public API.

The BIP-39 word list and pinned Gitleaks subset move with the detectors that consume them. Their
source, license, and pin remain documented.

## 7. Structure before entropy

The deriver validates and indexes the RO-Crate graph before any detector runs. It classifies
values into three groups. Classification is exhaustive: a recursive own-property walk must account
for every metadata property name and scalar leaf as protected or transformable. Unknown extension
entities and properties remain protocol-valid, but they are publishable only when exact
package-defined property/path selectors in the supplied policy classify every nested key and
scalar. Any unclassified key or scalar returns `withheld` with
`unclassified-metadata`, before detector invocation and without exposing its value or location.
No literal survives merely because a future extension is unknown to this package.

### 7.1 Protected structure

The following are never passed to generic or entropy detectors:

- JSON-LD `@context`, `@id`, `@type`, and relationship references;
- SHA-256 values and evidence-record references;
- exact Task, Result, Runtime Specification, native-trace, and other historical role identities;
- Execution and Agent IRIs;
- profile, media-type, and schema identifiers;
- DSSE payloads, signatures, subject digests, and public keys;
- IPFS CIDs and other declared immutable content identifiers;
- package versions and declared model identifiers; and
- the policy, receipt, and scrubber implementation commitments.

Protection means “do not classify by entropy,” not “always publish.” Structure classification
assigns each protected location exactly one package-owned semantic class:

```text
jsonld-keyword
relationship-reference
digest-reference
historical-role-identity
execution-iri
agent-iri
profile-media-schema-identifier
protocol-scalar
signed-material
content-identifier
version-model-identifier
derivation-commitment
policy-protected-property
```

The canonical policy contains `protectedValueDispositions`, a complete closed table mapping each
class to only `retain` or `withhold-record`. The list order above is the non-configurable
classifier precedence. A policy may add protected properties but may not unprotect the fixed set.
No regex, plaintext value, arbitrary callback, detector result, or `review`, `redact`, or
`withhold-artifact` disposition is valid in this channel.

The table is evaluated immediately after structure classification and before any detector call.
A `withhold-record` decision returns a stable `protected-value-withheld` reason naming only the
protected class—never the entity id, graph location, or raw value. For example, a stricter policy
may conservatively withhold the entire `agent-iri` class when those identities have not been
approved for public representation. Protected values are never conditionally classified by
lexical content.

### 7.2 Transformable metadata literals

Only policy-listed human-authored literals—such as `name`, `description`, `error`, selected
`PropertyValue.value` fields, and explicitly admitted extension property/path selectors—become
metadata scan surfaces. Selectors use a closed package grammar: explicit object-property segments,
with `*` permitted only for an array-index segment. They cannot wildcard an object key. A
policy-added protected selector classifies its exact scalar leaves as
`policy-protected-property`; it does not make an arbitrary subtree implicitly safe.

A safe rewrite changes the new representation's metadata bytes. It does not change historical
entity identities or exact artifact commitments. The protected-value disposition table, not a
generic detector hit, decides whether non-transformable structure causes withholding.

The package applies metadata dispositions through the exact JSON-pointer coordinates captured
during surface extraction. It clones the validated graph, changes string literal values only, and
preserves keys, types, array shape/order, entity ids, relationship references, digests, and every
protected value byte-semantically. A retained surface keeps its exact value; a redacted surface
receives only its policy stub. `review` and `withhold-record` short-circuit before transformation.
If a policy maps a metadata surface to `withhold-artifact`, the deriver promotes that result to
`withhold-record`, because metadata is not an independently omittable artifact.

Public-graph construction consumes this transformed clone while its private source commitment
continues to identify the original exact metadata bytes. A metadata-only change therefore produces
`derived`; `publishable-unchanged` is possible only when both metadata and artifacts are exact
no-ops.

### 7.3 Artifact codecs

Artifact handling is selected by both protocol role and declared media type:

| Codec decision | Behavior |
| --- | --- |
| `text` | Scan Unicode text and apply non-overlapping dispositions |
| `json` / `jsonl` | Parse first, protect structural keys/values, scan admitted literals, then serialize deterministically |
| `signed` | Retain exact bytes or withhold; never rewrite |
| `binary` / `unknown` | Retain only by explicit policy commitment; otherwise withhold |
| unavailable | Preserve the exact digest-only entity and publish no bytes |

Malformed or ambiguous content for a declared structured codec is invalid operation input. The
deriver throws `EvidenceDerivationError` with `STRUCTURED_ARTIFACT_INVALID` before returning any
outcome. It never scans malformed bytes as a fallback string. JSONL diagnostics may identify the
line number but never copy line content.

Technical-token classification also runs inside text artifacts before the entropy fallback.
Expected high-entropy technical values survive only when their shape and local structure support
that classification. Explicit secret patterns still win over the technical-token classifier.

## 8. Constructing the public derivative

### 8.1 No substitution

The source metadata graph is treated as immutable input. When an artifact changes:

1. the exact source entity remains in its historical role with its original identity and SHA-256;
2. its private bytes are omitted from the publishable artifact set;
3. the derived bytes receive a new entity id and digest;
4. the derived entity points to the source with `prov:wasDerivedFrom`;
5. the derived entity points to the scrub activity with `prov:wasGeneratedBy`; and
6. the derived entity does not appear in the Execution's `object`, `result`, `instrument`, or
   primary `subjectOf` relationship.

Derived artifact ids are deterministic and collision-resistant:

```text
derived/<source-sha256-hex>/<derived-sha256-hex>
```

Two source artifacts that happen to produce identical bytes remain separately attributable.

### 8.2 New Root Dataset and activity

The public metadata:

- starts from the structure-preserving transformed metadata graph, not the untouched source clone;
- retains the historical Execution `@id`;
- receives a new evidence-record digest;
- uses a new Root Dataset representation;
- links the Root Dataset to a digest-only private metadata entity with
  `prov:wasDerivedFrom`;
- links the Root Dataset and every derived entity to one scrub activity;
- identifies the scrubber Agent and content-bound implementation descriptor;
- references the exact policy artifact as the activity's `instrument`;
- includes one `PropertyValue` per class/disposition count;
- attaches the policy, implementation descriptor, receipt, retained safe artifacts, and derived
  artifacts through `hasPart`; and
- excludes every unavailable or withheld byte from `hasPart` while retaining its exact graph
  commitment.

The package validates the final exact metadata bytes through `validateExecutionEvidence` before it
can return `status: "derived"`.

### 8.3 Scrub receipt

The attached conventional path is:

```text
provenance/scrub-receipt.json
```

Its schema is `jinn.evidence-derivation.scrub-receipt.v1` and contains:

- source record family and digest;
- scrubber Agent, versioned implementation-descriptor digest, and completed time;
- exact policy digest;
- private detector-configuration digests without their values;
- source entity/digest to derived entity/digest mappings;
- retained, derived, and withheld artifact counts;
- per-class disposition counts with no matched values or snippets;
- the reproducibility grade;
- whether Task or Result bytes received public derivatives; and
- the evaluation and verification binding impact described in §9.

The receipt does **not** contain the public metadata digest. The receipt digest is embedded in the
public metadata, so embedding the metadata digest back into the receipt would be circular. The
operation's returned `derivative.reference` supplies the computed public record digest alongside
the receipt.

The receipt is an implementation artifact, not a fourth protocol record family. A consumer
retrieves and validates it as an artifact declared by the public Execution Evidence record.

## 9. Claims and ordering

### 9.1 Execution Verification is exact-record-bound

An Execution Verification binds exact `ro-crate-metadata.json` bytes. There are two distinct cases:

- `publishable-unchanged` returns the exact source metadata bytes and digest. An existing
  verification remains applicable to that unchanged record. Nothing is transferred or rewritten.
- `derived` creates new metadata bytes and a new digest. A verification of the private record does
  not verify that derivative, even when no historical role changed.

The public producer flow is:

```text
execution-recorder.finalize()
    -> private Execution Evidence
derive()
    -> exact public metadata bytes and digest
persist / place exact derivative bytes
prepareExecutionVerification(public digest, ...)
    -> DsseSigner
commitPreparedAttestation()
```

Derivation therefore happens before any signature intended to authenticate the public record.
The binding impact returned by the package distinguishes
`"existing-verification-applicable"` from `"not-transferred-to-derived-record"`; it must not report
all public outcomes as unverified.

### 9.2 Result Evaluation transfer is digest-exact

If exact Task and Result bytes are retained unchanged, an existing Result Evaluation remains
applicable to those exact subject digests. The claim is a separate record and is selected for
publication independently; derivation does not copy or edit it.

If a Task or Result receives a public derivative, an evaluation of the private bytes does not
transfer to the derivative. The derivative is not substituted into the Execution's historical
Task or Result role, so issuing a Result Evaluation that pretends the derived bytes were the
historical Result would also be wrong.

The package settles the hardest policy consequence as follows:

- it may return a conforming public derivative without a Result Evaluation;
- it marks `resultEvaluation: "not-transferable-to-derived-subject"` in the returned binding
  impact and receipt;
- it never republishes an evaluation as if it covered derived bytes; and
- a composition that requires publicly accessible evaluated Results must withhold that record.

That final admission rule is deliberately outside this package. The protocol permits the public
representation; a market may require more.

### 9.3 Signed envelopes are publish-or-withhold

V1 accepts only `family: "execution-evidence"`. A Result Evaluation or Execution Verification
envelope is either safe and published byte-for-byte, or unsafe and withheld by the owning
composition. It is never sent through this deriver, redacted, reserialized, or re-signed in place.

The `attestation-issuer` needs no change. Its source already:

- constructs exact statements from caller-supplied subject digests;
- invokes `DsseSigner` only during `prepare*`;
- retains the immutable prepared envelope as the retry unit; and
- commits exact prepared bytes without invoking the signer again.

The composition root changes sequencing, not the issuer API.

## 10. Determinism and content addressing

Determinism is graded rather than overclaimed.

### 10.1 Byte-stable base

The package guarantees byte-identical output when all of the following are byte-identical:

- source record and artifact bytes;
- canonical policy bytes;
- scrubber implementation descriptor bytes;
- caller-supplied `completedAt`;
- initialized detector implementations, their private configuration bytes, and private
  commitment nonces;
- detector descriptors and detector outputs; and
- every detector declares and satisfies `byte-stable`.

The package freezes no ambient values. It does not read the clock, environment, home directory,
hostname, model cache, or repository during derivation. Findings, mappings, graph entities, and
JSON keys have canonical order.

### 10.2 Best-effort external detectors

A detector such as ML inference may declare `best-effort`. The policy must explicitly permit that
grade. The detector binding owns a canonical public recipe descriptor containing the public model
id and immutable revision or weights digest, runtime and adapter versions, labels, threshold, and
public provider class. The closed `DerivationDetectorDescriptor.implementationDigest` is the
SHA-256 commitment to those canonical recipe bytes; the exact policy pins that closed descriptor.
The values do not become additional arbitrary fields on `DerivationDetectorDescriptor`. Private
provider, device, host, cache, and path configuration is represented only by
`configurationDigest`.

That pins the recipe, not the model's output. Two runs may produce different findings and
therefore different derivative digests. Both outputs remain valid, immutable derivatives of the
same source. Their content identities make the difference observable; neither package nor
protocol claims they are interchangeable.

The receipt says `reproducibility: "content-addressed"` when any best-effort detector participates.
A policy may instead require byte stability, in which case a best-effort detector causes
`withheld`.

### 10.3 Policy digest

The scrub activity's `instrument` points to the exact policy artifact, whose SHA-256 appears in the
graph and receipt. The digest covers detector descriptors, model pin, labels, thresholds,
public allowlists, private-configuration digests, structural rules, disposition table, stubs, and
reproducibility requirement.

For a detector binding, coverage of its model pin, labels, thresholds, runtime, adapter, and public
provider class is transitive through the pinned `implementationDigest` of its package-owned
canonical public recipe.

It does not falsely claim that the same policy digest guarantees the same ML outcome. Exact
derivative bytes and their record digest identify the outcome.

## 11. ML detector disposition

The base package exports only the detector port and deterministic detectors.

The later `@jinn-network/evidence-derivation-ml` package:

- adapts GLiNER ONNX only;
- depends on `@lmoe/gliner-onnx` as its one heavyweight runtime;
- exposes a `DerivationDetector`;
- stores a package-owned canonical public recipe containing model id, immutable revision or
  weights digest, runtime version, adapter version, labels, threshold, and public provider class;
- commits those recipe bytes through the closed descriptor's `implementationDigest` and declares
  `best-effort` through `reproducibility`;
- has no policy, repository, publication, or review behavior; and
- must pass `describeDerivationDetectorContract`.

The legacy `@huggingface/transformers` detector remains outside the new stack. Supporting it later
would require a separate binding, not a second heavyweight dependency in the GLiNER package.

A deployment without ML retains deterministic detection for credentials, high-entropy secret
shapes, private keys, mnemonic phrases, environment dumps, emails, Git identity carriers, known
identities, wallets, cards, IBANs, IP addresses, home paths, and machine identities. It loses the
model's additional recall over free prose: especially unstructured personal names, organizations,
locations, phone numbers, and ambiguous PII.

That loss is never silent. The exact policy lists its required detector set. A policy requiring
ML returns `withheld` when the binding is absent. A deterministic-only policy has different bytes
and a different digest.

## 12. Boundary through the incumbent, group by group

The extraction uses prior art selectively:

| Incumbent group | New-stack disposition | Reason |
| --- | --- | --- |
| `pipeline.ts`, `policy.ts`, `key-policy.ts` | Adapt into derivation internals | Detect-then-dispose, right-to-left spans, fail-closed dispositions, and policy hashing are reusable; the input changes from an attribute bag to classified record surfaces |
| `build.ts` | Replace with explicit `createEvidenceDeriver({ detectors })` plus exact policy input | Ambient presets and hidden defaults would defeat reproducibility |
| `layer2.ts` | Stays legacy | Distill/check mode is not public evidence derivation |
| Pattern detectors | Adapt into built-in derivation detectors | They are the deterministic safety floor and have no application authority |
| `known-identity-detector.ts` | Pure injected matching moves; env/home/hostname assembly stays application-side | The substrate may consume explicit values but must not inspect operator state or publish those values |
| `secretlint-stage.ts` | Detector logic moves; legacy stage wrapper does not | Secretlint is reusable detection, while `ScrubStage` is the old pipeline API |
| `gliner-detector.ts` | Later ML binding | Heavy model runtime and best-effort reproducibility |
| `transformers-detector.ts` | Does not move | Retired default; a future separate binding would need its own case |
| `ml-pii-stage.ts` | Replaced by the `DerivationDetector` port | The new port emits normalized findings directly |
| `pii-build.ts` | Application/ML binding concern | Download, warm-up, logs, and boot/publish failure altitude are deployment behavior |
| `apply-dispositions.ts` | Adapt into derivation internals | Stable ordering and non-overlap are reusable; outcome becomes a typed value rather than a publish exception |
| `finding.ts` | Adapt and rename types | `DerivationFinding` avoids a generic layer-wide name |
| `provenance.ts` | Replace with policy/receipt builders | The current redaction-manifest schema is trajectory-specific |
| `emit-scrub.ts` | Stays legacy | It imports legacy trajectory schema and rebuilds a legacy hash chain |
| `review-queue.ts` | Application | Filesystem path, random ids, snippets, CLI direction, and blocking human workflow are not substrate |
| `eval/fixtures.ts`, metrics | Synthetic cases inform package tests | Useful quality evidence, but not runtime exports |
| `eval/run-bench.ts`, `local-corpus.ts` | Separate development tool | Local paths and calibration runs are operator tooling |
| `eval/findings-from-scrub.ts` | Stays legacy | It approximates findings from old redaction output; the new engine has direct findings |
| `reject-publish-error.ts` | Stays legacy | New expected holds are `review-required` or `withheld`; exceptions are for invalid operation |
| BIP-39 and Gitleaks data | Move with their built-in detectors | Required runtime data with explicit source/license pins |

The implementation does not delete or repoint the live legacy path. The parallel package lands
first. Migrating core, client, layer, or Autopilot callers and then deleting duplicate legacy code
is a later strangler-fig sequence.

## 13. Cross-package composition

### 13.1 `execution-recorder`

No change. The recorder already:

- finalizes immutable metadata and artifacts;
- validates the exact metadata through the protocol;
- writes artifacts before the record;
- returns record and artifact references; and
- refuses mutation after finalization.

A composition retrieves those exact bytes from its private repository and supplies them to the
deriver. Derivation does not reopen the recorder workspace.

### 13.2 `attestation-issuer`

No change. As described in §9, the composition derives first and supplies final public subject
digests to the issuer. Existing private claims are separately eligible for publication only when
their exact subjects and their own envelope bytes remain safe.

### 13.3 `publication`

No dependency in either direction. Publication receives the returned public record and artifact
bytes and copies them unchanged into its remote repository—artifacts first, record second—before
announcing the record reference. It does not know whether a record is original or derived.

They meet only in a composition root:

```text
private repository
    -> load exact source bytes
    -> derivation
    -> policy/admission decision
    -> publication(remote repository, sink)
```

### 13.4 `evidence-repository`

Both source and derivative use family `execution-evidence` and have distinct record digests. They
may inhabit the same repository instance because identity is content-addressed, but a shared
instance does not create an access boundary.

Public producers should normally inject separate private and public repository instances. If one
physical store supplies access control, that is binding/application policy not represented in the
repository contract or protocol record.

The deriver itself receives bytes and never selects either repository.

### 13.5 `evidence-discovery`

No change. The public derivative is indexed as another record-scoped projection. It shares the
historical Execution IRI with the source and carries `wasDerivedFrom` edges. The Catalog does not
merge them or transfer claims.

### 13.6 `packages/core`

The new package removes one reason for future callers to depend on `core`, but this design does not
decide whether `core` survives. Its contribution store, legacy evidence adapter/index, corpus-read
surface, trajectory types, and application couplings require their own survey.

## 14. Errors and failure semantics

Stable exceptional error codes are:

- `INVALID_DERIVATION_INPUT`;
- `SOURCE_DIGEST_MISMATCH`;
- `SOURCE_NONCONFORMING`;
- `ARTIFACT_DIGEST_MISMATCH`;
- `POLICY_INVALID`;
- `SCRUBBER_DESCRIPTOR_INVALID`;
- `DETECTOR_REQUIREMENT_UNSATISFIED`;
- `DETECTOR_CONTRACT_VIOLATION`;
- `DETECTOR_FAILED`;
- `STRUCTURED_ARTIFACT_INVALID`;
- `DERIVATIVE_NONCONFORMING`;
- `OPERATION_ABORTED`; and
- `INTERNAL_FAILURE`.

Failure ordering is deliberate:

1. validate and defensively copy input;
2. validate source record and artifact integrity;
3. validate canonical policy and scrubber descriptor;
4. match detector requirements;
5. classify structure and apply the protected-value disposition table;
6. detect and dispose transformable surfaces;
7. return `review-required` or `withheld` before constructing publishable bytes;
8. transform metadata and artifacts, then build receipt, provenance, and the public graph;
9. validate final metadata; and
10. return defensive copies.

Detector/model unavailability is exceptional at the detector boundary but becomes `withheld` with
a stable reason when it is a required safety component. The caller receives no partially
publishable derivative.

Malformed JSON/JSONL, a finding outside its surface, overlapping invalid detector spans, a source
digest mismatch, or a nonconforming final graph never falls back to best effort.

## 15. Testing and conformance kits

`derivation/testing` exports:

```ts
describeEvidenceDeriverContract(factory): void
describeDerivationDetectorContract(factory, fixtures): void
```

The deriver contract kit uses synthetic, non-sensitive fixtures and asserts:

- source and artifact digest verification;
- source protocol conformance;
- input immutability and defensive output copies;
- byte-identical `publishable-unchanged`;
- same historical Execution id and a new record digest after derivation;
- exact Task, Result, Runtime Specification, native-trace, and other source commitments survive;
- no derived entity occupies `object`, `result`, `instrument`, or primary `subjectOf`;
- Root Dataset, source commitment, activity, Agent, implementation, policy, counts, mappings, and
  receipt are complete;
- withheld source bytes are not in `hasPart`;
- policy, detector, implementation, and receipt artifacts contain private-configuration digests
  but no injected identities, private allowlists, paths, hostnames, device ids, environment
  values, review data, detected plaintext, or public metadata digest;
- existing verification remains applicable to byte-identical unchanged metadata and does not
  transfer to newly derived metadata;
- unchanged Task/Result subject digests preserve evaluation applicability;
- derived Task/Result bytes report broken transfer;
- technical digests, DSSE material, public keys, CIDs, versions, and model ids survive entropy
  scanning;
- signed content is retained byte-for-byte or withheld;
- malformed structured content throws `STRUCTURED_ARTIFACT_INVALID` with no output;
- every protected-value class bypasses detectors, and a `withhold-record` table entry returns only
  the stable class reason before detector invocation;
- a recursive coverage walk withholds nested unknown-extension keys or literals unless an exact
  policy selector classifies them, and no unclassified literal appears in final bytes;
- metadata-only and mixed metadata/artifact derivations apply exact pointer replacements for
  `name`, `description`, `error`, selected `PropertyValue.value`, and admitted extension literals;
- final metadata bytes contain none of the original synthetic sensitive metadata literals;
- review and withholding return no publishable bytes;
- built-in byte-stable runs are byte-identical;
- best-effort detector runs are honestly graded and content-addressed;
- cancellation at each asynchronous boundary returns no output; and
- final bytes pass `validateExecutionEvidence` and artifact integrity checks.

The package's own suite additionally adapts the protocol golden public-derivation fixture and the
incumbent synthetic/corruption corpus. Detector-quality thresholds belong in repository tests or a
separate benchmark tool, not in the portable contract kit.

The contract kits are the public compatibility boundary for the optional ML binding and any
independent deriver implementation.

## 16. Prior art

The design composes established mechanisms:

- **parse, do not grep** — structured-data security analysis before lexical detection;
- **taint/source-to-sink tracking** — findings remain attributable to an exact source surface;
- **detect then decide** — DLP detectors emit findings and a separate policy applies
  dispositions;
- **fail closed** — unsupported or indeterminate safety states produce no publishable bytes;
- **content-addressed immutable derivation** — new bytes receive new identities and explicit PROV
  lineage;
- **functional core, imperative shell** — the byte transform has no I/O; repositories,
  publication, review, and signing compose outside it;
- **ports and adapters** — optional model inference implements the detector port;
- **reproducible-build inputs** — time, policy, implementation, and detector configuration are
  explicit, content-bound inputs;
- **graded guarantees** — deterministic built-ins and best-effort ML make different claims;
- **schema-versioned receipt** — the transformation emits a machine-readable audit artifact; and
- **strangler fig** — the new package lands beside the production scrub path before any caller
  migrates.

The incumbent contributes detect/dispose separation, right-to-left span replacement, pinned rule
data, technical carve-outs, fail-closed catastrophic classes, known-identity injection,
per-disposition counts, and detector-quality fixtures. The new boundary removes its ambient
operator state, legacy trajectory emitters, human queue, model boot behavior, and benchmark CLI.

## 17. Self-review findings

### 17.1 Artifact readers

| Produced value | Reader |
| --- | --- |
| Public Execution Evidence metadata | `evidence-discovery` Indexer and any protocol consumer |
| Retained and derived artifact bytes | Consumers through the repository named by publication/discovery |
| `provenance/scrub-receipt.json` | Auditors/consumers through `evidence-repository`; validated by derivation receipt parser |
| Policy and implementation descriptors | Auditors/consumers resolving the activity's content-bound inputs |
| `EvidenceDerivationOutcome.bindingImpact` | The producer composition root deciding which independent claims and records to publish |
| Private review findings | The application review surface; never publication or discovery |

No wire artifact is written for the package itself to read back privately.

### 17.2 Name audit

Repository and PR-stack source were checked for `EvidenceDeriver`, `EvidenceDerivation`,
`DerivationDetector`, `DerivationFinding`, `ScrubReceipt`, `PublicDerivative`, and
`DerivationPolicy`. No evidence-layer collision exists.

The design deliberately avoids:

- bare `Finding`, already generic in the incumbent;
- `ScrubResult`, already the legacy attribute-bag output;
- `batch`, reserved by discovery's `AnnouncementBatch`; and
- `publication`, which means copying unchanged records in the adjacent pipeline.

### 17.3 Layer audit

The component is a Pipeline because it transforms a record into another record and adds no
semantics. It depends only on Protocol semantics and detection libraries. The
optional GLiNER adapter is a separate Binding with one heavyweight dependency. Review, trust, and
admission remain Policy/application concerns above it.

### 17.4 Guarantee audit

The weakest binding cannot promise ML reproducibility, so the design promises byte stability only
for byte-stable detectors and explicit inputs. Best-effort detectors produce immutable,
content-addressed outcomes with pinned recipes, not reproducible outcomes.

Repository separation, future availability, exhaustive PII recall, publication authorization,
evaluation transfer, verification transfer, and trust are all explicitly not claimed.

### 17.5 Source audit

Cross-package claims were checked against source, not only designs:

- `execution-recorder` finalization writes artifacts before metadata, validates the candidate, and
  returns record/artifact references;
- `attestation-issuer/prepare.ts` constructs exact payload bytes and invokes `DsseSigner`;
- `attestation-issuer/commit.ts` revalidates and writes the same prepared bytes without signing;
- `evidence-repository` exposes exact-byte record/artifact put/get with content references;
- `evidence-protocol/execution.ts` enforces derivation provenance and rejects derived role
  substitution; and
- `evidence-discovery` indexes record-scoped projections without canonical merging.

The source audit changed three parts of the design: the portable receipt omits the circular public
metadata digest; execution-verification sequencing is explicitly derive-then-sign rather than
sign-then-rewrite; and public policy/receipt artifacts carry only private-configuration digests,
never known-identity values.

## 18. Settled decisions and open questions

Settled:

- one base package is sufficient;
- the package is a Pipeline;
- the operation is exact bytes in and exact bytes out with no I/O;
- the full deriver and detector ports both ship conformance kits;
- deterministic built-in detectors live in the base package;
- GLiNER lives in a later optional binding;
- Transformers.js does not move;
- structure classification precedes entropy detection;
- missing structured parsing fails closed;
- signed envelopes are never rewritten;
- derived entities never occupy historical roles;
- an existing Execution Verification remains applicable only to byte-identical
  `publishable-unchanged` metadata;
- private Execution Verification never transfers to newly derived metadata;
- a derivative whose Task or Result changes may be conforming and publishable without a Result
  Evaluation, but the broken binding is explicit;
- a composition requiring evaluated public Results withholds such a record;
- review queue persistence is application-owned;
- detector benchmark execution is a separate tool;
- existing live callers are not changed by the base-package implementation; and
- `packages/core` disposition remains a follow-up.

There are no open questions blocking a single-package implementation plan.
