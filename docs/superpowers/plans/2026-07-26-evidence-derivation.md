# Evidence Derivation Implementation Plan

> **Implementation foundation:** Read
> `../prompts/2026-07-26-evidence-substrate-implementation-foundation.md` first. It is the single
> source of truth for the base branch, package locations, shared-file ownership, and PR order.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-07-26

**Goal:** Ship `@jinn-network/evidence-derivation` as a structure-aware, side-effect-free pipeline
that turns exact private Execution Evidence bytes into unchanged publishable bytes, a conforming
public derivative with a scrub receipt, a review hold, or a withholding decision.

**Architecture:** A functional core validates the source through `evidence-protocol`, extracts only
safe scan surfaces, runs an explicit detector set, applies one exact content-bound policy, and
constructs a new PROV-linked record without substituting historical roles. The package performs no
I/O. Repository loading, publication, review, and signing remain in composition roots.

**Tech Stack:** TypeScript 5.9, Node.js 22 ESM, Yarn 4.13.0, Vitest 4,
`@jinn-network/evidence-protocol`, `@secretlint/core`,
`@secretlint/secretlint-rule-preset-recommend`, `@noble/hashes`, `canonicalize`, and Zod 4.

**Stack position:** PRs 3 and 4 in the operational stack. Tasks 1–6 form PR 3; Tasks 7–8 form
PR 4.

## Global Constraints

- **Precondition:** branch from the exact repository-capabilities PR head recorded by the
  integration coordinator. Implement against the consolidated `packages/evidence/` tree.
- **Spec is law:** `docs/superpowers/specs/2026-07-26-evidence-derivation-design.md`. Stop and
  escalate rather than contradicting it.
- **No protocol amendment.** Do not add a record family, profile term, or derivation semantic to
  `evidence-protocol`.
- **No cutover.** Do not modify or repoint `packages/core`, `client`, `packages/layer`, Autopilot,
  the plugin, or `EpisodeV1`.
- **No ML runtime.** This plan defines the detector port but does not add GLiNER, Transformers.js,
  Hugging Face, model downloads, model caches, or native inference dependencies.
- **No I/O.** The functional core, built-in detectors, and every conforming injected detector
  perform no repository, network, durable filesystem, clock, randomness, or other ambient I/O.
  The package has no `node:fs`, repository binding, network, wallet, viem, SQLite, publication,
  discovery, recorder, issuer, or application dependency.
- **Injected detectors are trusted.** A detector receives private transformable plaintext, retains
  no surface text after `detect` settles, and must be trusted by the application. The JavaScript
  port and conformance kit do not provide a sandbox or isolation from dishonest detector code.
- **No hidden derivation defaults.** Every derivation receives exact canonical policy bytes,
  caller-supplied `completedAt`, and exact scrubber implementation-descriptor bytes.
- **No configuration side channel.** Public policy, detector, implementation, and receipt
  artifacts contain only deliberately public recipe values and digests of private detector or
  runtime configuration. They never contain injected identities, private allowlists, paths,
  hostnames, device identifiers, environment values, commitment nonces, or review data. A private
  configuration digest is a nonce-hardened commitment, never a bare hash of low-entropy values.
- **Signed bytes are immutable.** A signed surface is retained byte-for-byte or withheld.
- **Historical roles are immutable.** A derived entity must never occupy `object`, `result`,
  `instrument`, or the primary `subjectOf` relation.
- **Expected safety holds are values.** `review-required` and `withheld` are not thrown errors and
  return no publishable bytes.
- **American English** in names, comments, and documentation.
- Each package keeps its own lockfile and Yarn config. Yarn is exactly `4.13.0`; Node is `>=22`.
- Work shape is `feat`. Each PR targets its immediate predecessor as defined by the implementation
  foundation.
- Commit prefix is `feat(evidence-derivation):`.
- Use Apache-2.0, SPDX headers, and DCO sign-off on every commit.
- npm package: `@jinn-network/evidence-derivation@0.1.0`.
- Directory: `packages/evidence/derivation`.

## File map

```text
packages/evidence/derivation/
├── package.json
├── .yarnrc.yml
├── tsconfig.json
├── tsconfig.build.json
├── README.md
├── scripts/
│   └── pack-smoke.mjs
└── src/
    ├── index.ts
    ├── testing.ts
    ├── types.ts
    ├── errors.ts
    ├── bytes.ts
    ├── policy.ts
    ├── source.ts
    ├── surfaces.ts
    ├── technical-values.ts
    ├── disposition.ts
    ├── metadata-transform.ts
    ├── artifact-transform.ts
    ├── receipt.ts
    ├── public-graph.ts
    ├── derive.ts
    ├── fixtures.ts
    ├── detectors/
    │   ├── index.ts
    │   ├── plain-patterns.ts
    │   ├── git-identity.ts
    │   ├── known-identity.ts
    │   ├── secrets.ts
    │   ├── reject-classes.ts
    │   ├── instruments.ts
    │   ├── ip-address.ts
    │   └── data/
    │       ├── bip39-english.ts
    │       └── gitleaks-rules.ts
    ├── codecs/
    │   ├── text.ts
    │   ├── json.ts
    │   └── jsonl.ts
    ├── policy.test.ts
    ├── source.test.ts
    ├── surfaces.test.ts
    ├── technical-values.test.ts
    ├── detectors.test.ts
    ├── disposition.test.ts
    ├── metadata-transform.test.ts
    ├── artifact-transform.test.ts
    ├── receipt.test.ts
    ├── public-graph.test.ts
    ├── derive.test.ts
    ├── determinism.test.ts
    ├── contract.test.ts
    └── security.test.ts
```

The integration coordinator also modifies:

- `.github/scripts/evidence-package-inventory.test.mjs`;
- `.github/scripts/evidence-source-boundaries.test.mjs`;
- `.github/scripts/evidence-packed-types.test.mjs`; and
- `.github/workflows/evidence-ci.yml`.

---

## PR 3 — Derivation contracts and engine

Branch from the exact repository-capabilities PR head. Complete Tasks 1–6, run all package tests,
and open a draft PR against that prerequisite branch.

### Task 1: Scaffold the package and exact public contracts

**Files:**

- Create: package scaffolding, `src/types.ts`, `src/errors.ts`, `src/bytes.ts`, `src/policy.ts`,
  `src/fixtures.ts`, `src/policy.test.ts`, and `src/index.ts`
- Coordinator work is deferred to the PR 3 integration closeout after the package-local commits

**Interfaces:**

- Produces:
  - `EvidenceDeriver`, `DerivationDetector`, `DerivationDetectorDescriptor`
  - `DeriveExecutionEvidenceInput`, `EvidenceDerivationOutcome`
  - `DerivationPolicy`, `DerivationFinding`, `DerivationSurface`
  - `parseDerivationPolicy(bytes)`
  - `EvidenceDerivationError`
- Consumes:
  - `ExecutionEvidenceDocument`, `JsonValue`-compatible values, and record hashing from
    `@jinn-network/evidence-protocol`
  - no repository contract; the exact byte-port reference/digest value types are package-local

- [ ] **Step 1: Scaffold the package**

Use `packages/evidence/execution-recorder` as the package scaffold. Publication does not exist yet
at this stack position. `package.json` essentials:

```json
{
  "name": "@jinn-network/evidence-derivation",
  "version": "0.1.0",
  "description": "Structure-aware public derivation pipeline for Jinn Execution Evidence.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": { "node": ">=22" },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/evidence/derivation"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/evidence-protocol": "0.1.0",
    "@noble/hashes": "^2.2.0",
    "@secretlint/core": "^13.0.2",
    "@secretlint/secretlint-rule-preset-recommend": "^13.0.2",
    "canonicalize": "3.0.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/evidence-protocol": "portal:../protocol"
  }
}
```

- [ ] **Step 2: Write failing canonical policy tests**

Create `src/policy.test.ts` covering:

```ts
import { describe, expect, test } from "vitest";
import {
  parseDerivationPolicy,
} from "./index.js";
import { canonicalJsonBytes, sha256Digest } from "./bytes.js";
import { baselinePolicyValue } from "./fixtures.js";

describe("derivation policy", () => {
  test("accepts exact RFC 8785 policy bytes", () => {
    const bytes = canonicalJsonBytes(baselinePolicyValue());
    const parsed = parseDerivationPolicy(bytes);
    expect(parsed.value.schemaVersion).toBe(
      "jinn.evidence-derivation-policy.v1",
    );
    expect(parsed.digest).toBe(sha256Digest(bytes));
  });

  test("rejects semantically equal non-canonical bytes", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(baselinePolicyValue(), null, 2),
    );
    expect(() => parseDerivationPolicy(bytes)).toThrowError(
      expect.objectContaining({ code: "POLICY_INVALID" }),
    );
  });

  test("rejects duplicate detector ids", () => {
    const value = baselinePolicyValue();
    value.requiredDetectors.push(value.requiredDetectors[0]!);
    expect(() => parseDerivationPolicy(canonicalJsonBytes(value))).toThrow(
      /detector ids must be unique/,
    );
  });

  test("rejects a disposition without a stub for redact", () => {
    const value = baselinePolicyValue();
    delete value.stubs.email;
    expect(() => parseDerivationPolicy(canonicalJsonBytes(value))).toThrow(
      /redact class email requires a stub/,
    );
  });
});
```

- [ ] **Step 3: Define exact public types**

`src/types.ts` must define, without importing Vitest:

```ts
export type ConfidenceBand =
  | "VERY_LOW"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "VERY_HIGH";

export type DerivationDisposition =
  | "retain"
  | "redact"
  | "withhold-artifact"
  | "withhold-record"
  | "review";

export type ProtectedValueClass =
  | "jsonld-keyword"
  | "relationship-reference"
  | "digest-reference"
  | "historical-role-identity"
  | "execution-iri"
  | "agent-iri"
  | "profile-media-schema-identifier"
  | "protocol-scalar"
  | "signed-material"
  | "content-identifier"
  | "version-model-identifier"
  | "derivation-commitment"
  | "policy-protected-property";

export type ProtectedValueDisposition = "retain" | "withhold-record";

export type DerivationSha256Digest = `sha256:${string}`;

export interface DerivationRecordReference {
  readonly family: "execution-evidence";
  readonly digest: DerivationSha256Digest;
}

export interface DerivationArtifactReference {
  readonly digest: DerivationSha256Digest;
}

export type DerivationRole =
  | "task"
  | "result"
  | "runtime-specification"
  | "runtime-component"
  | "native-trace"
  | "input"
  | "evidence"
  | "other";

export type ArtifactCodec =
  | "text"
  | "json"
  | "jsonl"
  | "signed"
  | "binary";

export interface DerivationDetectorDescriptor {
  readonly id: string;
  readonly version: string;
  readonly implementationDigest: `sha256:${string}`;
  readonly reproducibility: "byte-stable" | "best-effort";
  readonly configurationDigest?: `sha256:${string}`;
}

export interface DerivationSurface {
  readonly surfaceId: string;
  readonly sourceEntityId: string;
  readonly role: DerivationRole;
  readonly mediaType: string;
  readonly codec: "text" | "json" | "jsonl";
  readonly location: string;
  readonly text: string;
}

export interface DerivationFinding {
  readonly class: string;
  readonly confidence: ConfidenceBand;
  readonly surfaceId: string;
  /** Zero-based inclusive UTF-16 code-unit index into the exact surface text. */
  readonly start: number;
  /** Zero-based exclusive UTF-16 code-unit index into the exact surface text. */
  readonly end: number;
  readonly evidence: readonly string[];
  readonly detector: DerivationDetectorDescriptor;
}

export interface DerivationDetector {
  readonly descriptor: DerivationDetectorDescriptor;
  detect(
    surface: DerivationSurface,
    options?: DerivationOperationOptions,
  ): Promise<readonly DerivationFinding[]>;
}
```

Also define:

- exact input from design §5.1;
- `PublishableArtifact` with `entityId`, `digest`, `bytes`, and
  `kind: "retained" | "derived" | "policy" | "implementation" | "receipt"`;
- `DerivationBindingImpact` with:

```ts
{
  executionVerification:
    | "existing-verification-applicable"
    | "not-transferred-to-derived-record";
  resultEvaluation:
    | "preserved-for-exact-subjects"
    | "not-transferable-to-derived-subject";
  taskDerived: boolean;
  resultDerived: boolean;
}
```

- the four outcome variants from design §5.2;
- `CreateEvidenceDeriverOptions`, `EvidenceDeriver`, and operation options.

No outcome except `publishable-unchanged` and `derived` may contain `record`, `artifacts`, or other
publishable bytes.

- [ ] **Step 4: Implement bytes, policy parsing, and errors**

`src/bytes.ts`:

- fatal UTF-8 decoding;
- RFC 8785 `canonicalJsonBytes`;
- `sha256Digest`;
- constant-time byte equality where comparisons defend exact identity;
- defensive-copy helpers.

`src/errors.ts` exports the exact stable codes from design §14 and
`EvidenceDerivationError`.

`src/policy.ts` uses Zod to validate:

- schema/name/version;
- reproducibility requirement;
- unique required detector descriptors;
- transformable metadata property/path selectors using explicit object-key segments and `*` only
  for array-index segments;
- exact policy-protected property/path selectors, which never implicitly protect an entire
  arbitrary subtree;
- the complete closed `protectedValueDispositions` table, with exactly `retain` or
  `withhold-record` for every `ProtectedValueClass`;
- ordered artifact rules with media type, roles, and codec;
- default artifact disposition;
- class/band disposition rows;
- `unmatchedFindingDisposition: "review" | "withhold-record"` as the content-bound fail-closed
  outcome when an extensible detector class/band has no row;
- redact stubs;
- required private-configuration digests, including the known-identity detector descriptor;
- only technical allowlist values explicitly safe to publish, plus the digest of any private
  allowlist configuration;
- `resultTransform: "derive-unassessed" | "withhold-record"`.

After schema validation, compare the input bytes to `canonicalJsonBytes(parsedValue)`. Any
difference is `POLICY_INVALID`.

`baselinePolicyValue()` contains no private value. Its known-identity requirement has only a
configuration digest computed from a synthetic, test-only injected pack and private test nonce.
Add negative tests that the public policy schema rejects private configuration fields and that
serialized policy bytes do not contain any synthetic identity, private allowlist, or nonce
fixture.

Task 1 creates `src/fixtures.ts` with this policy fixture and its synthetic private inputs. The
root package must not export the fixture.
The root package must also not export `canonicalJsonBytes` or `sha256Digest`; package-local tests
import those generic helpers relatively from `src/bytes.ts`.

- [ ] **Step 5: Run the first gates**

```bash
cd packages/evidence/derivation
yarn install --immutable
yarn test src/policy.test.ts
yarn typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/evidence/derivation
git commit -s -m "feat(evidence-derivation): scaffold exact policy and port contracts"
```

The package subagent never edits or commits a coordinator-owned shared file.

---

### Task 2: Validate source bytes and extract structure-aware scan surfaces

**Files:**

- Create: `src/source.ts`, `src/surfaces.ts`, `src/technical-values.ts`
- Create: `src/source.test.ts`, `src/surfaces.test.ts`, `src/technical-values.test.ts`
- Modify: `src/fixtures.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Produces:
  - `validateDerivationSource(input): ValidatedDerivationSource`
  - `extractDerivationSurfaces(source, policy): SurfaceExtraction`
  - `evaluateProtectedValueDispositions(extraction, policy): ProtectedValueDecision`
  - `classifyTechnicalValue(value, context): TechnicalValueClass | null`
- Consumes:
  - `validateExecutionEvidence`, `recordDigest`, and `checkArtifactIntegrity`
  - parsed policy from Task 1

- [ ] **Step 1: Create a complete synthetic source fixture**

Extend `src/fixtures.ts` to build a minimal conforming Execution Evidence source with:

- one Task;
- one input;
- one Runtime Specification plus one component;
- one Result;
- one native trace;
- duration;
- producer/capture provenance;
- exact artifact bytes and declared SHA-256 values.

Keep fixture helpers package-internal in PR 3. Task 7 exports only the synthetic contract fixtures
through `./testing`; they never enter the root package.

The trace fixture must include:

- an absolute home path;
- a credential-shaped value;
- a SHA-256;
- `0x` plus a 64-hex transaction digest;
- a CIDv1 string;
- a DSSE-shaped base64 payload/signature pair;
- a package version; and
- a declared model id.

- [ ] **Step 2: Write failing source-validation tests**

Cover:

```ts
test("accepts a conforming source and exact artifact bytes");
test("rejects source reference digest mismatch");
test("rejects non-execution record family before parsing");
test("rejects a nonconforming source with protocol diagnostics attached");
test("rejects supplied artifact bytes that mismatch the graph sha256");
test("rejects duplicate source artifact entity ids");
test("permits graph artifacts whose bytes were not supplied");
test("defensively copies source and artifact bytes");
```

Expected error codes must match Task 1.

- [ ] **Step 3: Implement `validateDerivationSource`**

Algorithm:

1. snapshot the input with property-descriptor checks matching the issuer's defensive boundary;
2. require family `execution-evidence`;
3. compare `recordDigest(bytes)` to the declared reference;
4. call `validateExecutionEvidence`;
5. build a graph index by `@id`;
6. derive exact protocol roles from the one Execution's `object`, `result`, `instrument`, and
   `subjectOf`;
7. match each supplied artifact entity to its graph SHA-256 and exact bytes;
8. return frozen graph/role/byte maps with defensive copies.

Do not accept a caller-supplied role; derive it from the graph.

- [ ] **Step 4: Write failing surface tests**

Assert:

- relationship values, ids, types, contexts, SHA-256 values, Agent IRIs, profile ids, and
  historical-role identities never become surfaces;
- only policy-listed `name`, `description`, `error`, and selected `PropertyValue.value` literals
  become metadata surfaces;
- a recursive own-property walk accounts for every property name and scalar leaf as protected or
  transformable;
- a nested unknown extension key or string that has no exact policy selector produces
  `unclassified-metadata`, no detector call, and no publishable output;
- an explicitly admitted nested extension string becomes a surface, while an unlisted sibling
  remains fail-closed;
- text artifacts become one text surface;
- JSON and JSONL are parsed before literals become surfaces;
- signed codec values produce no transformable surfaces;
- binary/unknown values produce no transformable surfaces;
- malformed declared JSON/JSONL produces `STRUCTURED_ARTIFACT_INVALID`;
- absent artifact bytes produce no surface and remain unavailable;
- every protected location receives exactly one fixed `ProtectedValueClass`;
- a complete table of `retain` decisions allows detection to continue;
- an `agent-iri: "withhold-record"` decision produces only
  `{ code: "protected-value-withheld", protectedClass: "agent-iri" }`, exposes no value or graph
  location, and invokes no detector; and
- missing/unknown protected classes or unsupported dispositions are `POLICY_INVALID`.

- [ ] **Step 5: Implement structural surface extraction**

Use deterministic surface ids:

```text
metadata:<entity-id>:<json-pointer>
artifact:<entity-id>:<codec-location>
```

`location` is an internal application coordinate, never receipt content.

The non-configurable protected set must include:

```ts
[
  "@context",
  "@id",
  "@type",
  "sha256",
  "about",
  "agent",
  "conformsTo",
  "creator",
  "environment",
  "hasPart",
  "instrument",
  "license",
  "mentions",
  "object",
  "prov:wasDerivedFrom",
  "prov:wasGeneratedBy",
  "provider",
  "resourceUsage",
  "result",
  "softwareRequirements",
  "subjectOf",
]
```

The policy may add protection but may not remove these entries.

Classify the protected set into the exact closed `ProtectedValueClass` vocabulary from Task 1
using package-owned protocol semantics and the union's listed order as deterministic precedence.
Evaluate the policy's
complete `protectedValueDispositions` table immediately after extraction and before any detector.
The channel accepts no regex, plaintext, callback, detector result, or transform/review
disposition.

Walk every validated metadata object and array recursively using own property descriptors.
Known protocol/JSON-LD keys and scalar leaves must map to a fixed protected class or an admitted
transformable surface. Unknown extension paths use the policy's closed selector grammar: object
keys are always explicit and `*` may replace only an array index. A policy-added protected selector
classifies only its exact scalar leaves as `policy-protected-property`. If any key or scalar remains
unclassified, return a record hold with only `{ code: "unclassified-metadata" }`; do not include
the entity id, path, key, or value and do not invoke detectors.

- [ ] **Step 6: Implement and test technical-value classification**

`classifyTechnicalValue` recognizes only complete, structurally supported values:

- `sha256:<64 lowercase hex>` and bare graph `sha256` values;
- in-toto subject digests;
- DSSE payload/signature fields;
- PEM public keys;
- CIDv1;
- `0x` plus 64 hex transaction/content digests;
- semantic/package versions in version fields; and
- model ids in declared model fields.

Explicit credential patterns are not technical allowlist hits. A value such as `sk-...` in a
model field remains a credential finding.

- [ ] **Step 7: Run tests and commit**

```bash
cd packages/evidence/derivation
yarn test src/source.test.ts src/surfaces.test.ts src/technical-values.test.ts
yarn typecheck
git add src
git commit -s -m "feat(evidence-derivation): classify protocol structure before scanning"
```

---

### Task 3: Add the detector port, deterministic inventory, and disposition engine

**Files:**

- Create: `src/detectors/**`, including pinned data
- Create: `src/detectors.test.ts`, `src/disposition.ts`, `src/disposition.test.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Produces:
  - `createBuiltinDerivationDetectors(options): readonly DerivationDetector[]`
  - `normalizeDetectorFindings(surface, findings)`
  - `applyDerivationDispositions(surface, findings, policy)`
- Consumes:
  - classified surfaces and technical-value classifier from Task 2

- [ ] **Step 1: Write failing detector tests**

Port the incumbent's synthetic cases using semantic classes:

| Fixture | Expected class |
| --- | --- |
| email | `email` |
| `/home/example-user` | `absolute-path` |
| AWS/GCP/GitHub/Slack/npm/Stripe/OpenAI/Anthropic token shapes | `credential` |
| URL userinfo/query token | `url-credential` |
| context-gated bare 64-hex key | `funds-controlling-secret` |
| 12/24 BIP-39 words | `funds-controlling-secret` |
| three-line env dump | `environment-dump` |
| Git author/config carrier | `git-identity` |
| injected exact identity | `known-identity` |
| `0x` plus 40 hex | `wallet-address` |
| Luhn card / mod-97 IBAN | `payment-instrument` |
| public/private IP | `ip-address` |
| hostname carrier | `machine-identity` |

Corruption cases must include UUIDs, Git SHAs, transaction hashes, env references, loopback IPs,
CIDv1, public keys, package versions, model ids, URLs, Markdown links, non-Latin prose, and
SWE-rebench ids.

- [ ] **Step 2: Adapt the deterministic detectors**

Carry forward these incumbent mechanisms:

- plain patterns;
- Git identity carriers;
- injected known identities, with no ambient env/home/hostname reads;
- Secretlint preset;
- pinned Gitleaks subset with source/license note;
- entropy fallback after `classifyTechnicalValue`;
- context-gated private keys;
- BIP-39 runs;
- env blocks;
- Luhn and IBAN checks;
- IP range classification.

Every descriptor must use an explicit id/version and an implementation digest over its controlled
rule/configuration descriptor. Do not hash TypeScript source at runtime. Store a canonical
descriptor value beside each implementation and hash that.

`createBuiltinDerivationDetectors(options)` receives each private configuration as an exact
envelope: schema version, values, and a caller-supplied private commitment nonce of at least 128
random bits. It hashes the canonical envelope into `configurationDigest`, discards no caller
distinction that would change detector behavior, generates no randomness, and never copies the
values or nonce into the descriptor. The descriptor has no arbitrary public-configuration field;
package-owned `id`, `version`, and `implementationDigest` identify public recipe behavior. Add
tests that a missing/short nonce is rejected, an exact policy/descriptor configuration-digest
mismatch is rejected, different nonces produce different commitments, and no known identity,
private allowlist value, nonce, path, or hostname survives descriptor serialization.

For an optional detector binding, `implementationDigest` commits the binding's package-owned
canonical public recipe bytes. A future ML binding puts its model id, immutable revision or
weights digest, runtime/adapter versions, labels, threshold, and public provider class in those
recipe bytes, not as new fields on the closed `DerivationDetectorDescriptor`.

- [ ] **Step 3: Write failing detector-contract validation tests**

Cover:

```ts
test("rejects a finding for a different surface");
test("rejects negative, reversed, or out-of-range spans");
test("rejects a span boundary that splits an astral character");
test("normalizes an exact span after an astral character using UTF-16 indices");
test("rejects matched plaintext embedded in evidence codes");
test("deduplicates identical findings");
test("sorts findings by surface, start, end, class, detector");
test("rejects a runtime descriptor that differs from the policy requirement");
test("allows a policy-permitted best-effort descriptor");
test("withholds when policy requires byte-stable and detector is best-effort");
test("applies the exact unmatched-finding disposition for an unknown class/band");
```

- [ ] **Step 4: Write failing disposition tests**

Assert:

- right-to-left replacement preserves earlier offsets;
- overlapping redactions are deterministically resolved by confidence, then class, then detector
  id;
- `retain` changes no bytes;
- `review` returns private findings and no transformed bytes;
- `withhold-artifact` returns no artifact bytes;
- `withhold-record` dominates every other disposition;
- unmatched classes never implicitly retain and use only the policy's `review` or
  `withhold-record` choice;
- redaction stubs come only from exact policy bytes;
- disposition counts omit `retain`;
- output counts sort by class then disposition.

- [ ] **Step 5: Implement normalization and disposition**

`normalizeDetectorFindings` validates and freezes every finding before policy lookup. It must never
read matched source text into the finding object.

`applyDerivationDispositions` returns:

```ts
type SurfaceDispositionResult =
  | { status: "retained"; text: string; counts: DispositionCounts }
  | { status: "redacted"; text: string; counts: DispositionCounts }
  | { status: "withhold-artifact"; counts: DispositionCounts }
  | { status: "review-required"; findings: readonly DerivationFinding[] }
  | { status: "withhold-record"; reasons: readonly DerivationHoldReason[] };
```

No method in this task writes files, reads ambient state, or throws a publish-specific error.

- [ ] **Step 6: Run tests and commit**

```bash
cd packages/evidence/derivation
yarn test src/detectors.test.ts src/disposition.test.ts
yarn typecheck
git add src
git commit -s -m "feat(evidence-derivation): add deterministic detectors and dispositions"
```

---

### Task 4: Transform metadata and artifacts with structure-preserving codecs

**Files:**

- Create: `src/codecs/text.ts`, `src/codecs/json.ts`, `src/codecs/jsonl.ts`
- Create: `src/metadata-transform.ts`, `src/metadata-transform.test.ts`
- Create: `src/artifact-transform.ts`, `src/artifact-transform.test.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Produces:
  - `transformSourceMetadata(source, extraction, dispositionResults)`
  - `MetadataTransformationSet`
  - `transformSourceArtifacts(source, extraction, detectorResults, policy)`
  - `ArtifactTransformationSet`
- Consumes:
  - validated source, surfaces, normalized findings, and disposition results

- [ ] **Step 1: Write failing codec tests**

Text:

- preserves UTF-8 exactly when retained;
- applies redactions with exact offsets;
- replaces the intended substring when an astral character precedes or participates in a match,
  without splitting a surrogate pair;
- rejects invalid UTF-8 instead of replacement decoding.

JSON:

- transforms only admitted string values;
- preserves astral characters surrounding a transformed string span and removes the exact intended
  UTF-16-indexed match;
- keeps protected keys/values byte-semantically unchanged;
- canonicalizes transformed JSON;
- yields byte-identical source bytes when no transformation occurs;
- rejects duplicate keys if the parser cannot preserve unambiguous meaning.

JSONL:

- validates each non-empty line independently;
- reports the exact line in `STRUCTURED_ARTIFACT_INVALID`;
- transforms admitted literals and joins with one newline;
- applies UTF-16-indexed spans after astral characters on the intended line only;
- returns exact source bytes on a no-op.

Signed/binary:

- signed values are retained exact or withheld;
- no detector receives signed payload/signature text;
- binary values require explicit retain policy or are withheld.

- [ ] **Step 2: Write failing metadata-transformation tests**

Cover each admitted metadata surface independently:

- `name`;
- `description`;
- `error`;
- selected `PropertyValue.value`; and
- one explicitly admitted extension literal.

Assert exact JSON-pointer replacement on a defensive graph clone, source immutability, no
key/type/array/order/sibling change, and byte-semantic preservation of entity ids, relationship
references, digests, and every protected value. A retained surface keeps its exact string and a
redacted surface receives only its policy stub. `review` and `withhold-record` short-circuit before
transformation. A metadata `withhold-artifact` disposition is promoted to `withhold-record`.
Return the transformed graph, a `changed` flag, and metadata-only counts without raw matched
values.

- [ ] **Step 3: Write failing artifact transformation-set tests**

Assert:

- changed bytes receive a new digest;
- unchanged bytes keep the source entity id and digest;
- unavailable bytes remain digest-only;
- `withhold-artifact` omits bytes but preserves the source commitment;
- derived ids equal
  `derived/<source-sha256-hex>/<derived-sha256-hex>`;
- two sources yielding identical derived bytes have distinct entity ids;
- Task/Result transformations set `taskDerived` / `resultDerived`;
- `resultTransform: "withhold-record"` returns a record hold;
- `resultTransform: "derive-unassessed"` returns an explicit broken evaluation binding;
- no derived artifact is assigned a historical role.

- [ ] **Step 4: Implement codecs and metadata transformation**

Each codec receives its already-extracted surfaces and disposition results. It must not re-run
detectors or independently choose policy.

If all surfaces retain, return a defensive copy of the exact source bytes; do not reserialize a
clean JSON artifact merely because it was parsed.

`transformSourceMetadata` applies only the exact pointer coordinates captured for `metadata:*`
surfaces. It never re-runs detectors or performs a lexical scan. Public-graph construction must
consume its transformed graph, while the source commitment continues to identify the original
exact metadata bytes.

- [ ] **Step 5: Implement artifact transformation**

Produce:

```ts
interface ArtifactTransformationSet {
  readonly retained: readonly PublishableArtifact[];
  readonly derived: readonly {
    readonly sourceEntityId: string;
    readonly sourceDigest: DerivationSha256Digest;
    readonly entityId: string;
    readonly digest: DerivationSha256Digest;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }[];
  readonly withheld: readonly {
    readonly entityId: string;
    readonly digest: DerivationSha256Digest;
    readonly reason: string;
  }[];
  readonly counts: readonly DispositionCount[];
  readonly bindingImpact: DerivationBindingImpact;
}
```

Sort every array deterministically by source entity id and digest.

- [ ] **Step 6: Run tests and commit**

```bash
cd packages/evidence/derivation
yarn test src/metadata-transform.test.ts src/artifact-transform.test.ts
yarn typecheck
git add src
git commit -s -m "feat(evidence-derivation): transform metadata and artifacts safely"
```

---

### Task 5: Build the scrub receipt and conforming public graph

**Files:**

- Create: `src/receipt.ts`, `src/receipt.test.ts`
- Create: `src/public-graph.ts`, `src/public-graph.test.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Produces:
  - `buildScrubReceipt(input): PreparedScrubReceipt`
  - `parseScrubReceipt(bytes): ParsedScrubReceipt`
  - `buildPublicExecutionEvidence(input): PreparedPublicDerivative`
- Consumes:
  - transformed metadata graph, artifact transformations, original source commitment, exact
    policy, scrubber descriptor, and completed time

- [ ] **Step 1: Write failing receipt tests**

Expected receipt shape:

```json
{
  "schemaVersion": "jinn.evidence-derivation.scrub-receipt.v1",
  "sourceRecord": {
    "family": "execution-evidence",
    "digest": "sha256:..."
  },
  "scrubber": {
    "agentId": "urn:...",
    "implementationDigest": "sha256:..."
  },
  "policy": {
    "digest": "sha256:..."
  },
  "privateConfigurationDigests": [
    {
      "detectorId": "known-identity",
      "digest": "sha256:..."
    }
  ],
  "completedAt": "2026-07-26T00:00:00Z",
  "mappings": [],
  "artifacts": {
    "retained": 0,
    "derived": 0,
    "withheld": 0
  },
  "dispositions": [],
  "reproducibility": "byte-stable",
  "bindingImpact": {
    "executionVerification": "not-transferred-to-derived-record",
    "resultEvaluation": "preserved-for-exact-subjects",
    "taskDerived": false,
    "resultDerived": false
  }
}
```

Assert:

- canonical bytes and digest are stable;
- mappings/counts are sorted;
- private detector-configuration digests are present and sorted;
- no raw finding text, snippets, offsets, injected identities, private allowlist values,
  commitment nonces, or private paths appear;
- no public metadata digest field is accepted;
- parser rejects unknown schema versions and non-canonical bytes.

- [ ] **Step 2: Write failing public-graph tests**

Starting from the synthetic source, assert the output:

- uses every transformed metadata literal and contains none of the original synthetic sensitive
  values;
- retains the same Execution `@id`;
- retains exact Task, Result, Runtime Specification, native-trace, and input digests;
- creates a digest-only private metadata entity;
- adds Root `prov:wasDerivedFrom` and `prov:wasGeneratedBy`;
- adds one completed scrub activity and one scrubber Agent;
- links exact policy as `instrument`;
- links implementation descriptor to the scrubber;
- adds one count entity per non-retain class/disposition;
- adds each derived entity with source and activity links;
- never places derived ids in `object`, `result`, `instrument`, or primary `subjectOf`;
- puts only returned publishable bytes in Root `hasPart`;
- includes conventional ids:
  - `provenance/derivation-policy.json`;
  - `provenance/scrubber-implementation.json`;
  - `provenance/scrub-receipt.json`;
- omits any private verification claim;
- has no circular `derivedMetadataDigest`; and
- passes `validateExecutionEvidence`.

- [ ] **Step 3: Implement the receipt**

Validate the scrubber implementation descriptor as canonical JSON under the closed
`jinn.evidence-derivation-implementation.v1` schema. It contains non-empty package `name` and
`version`, a controlled-build content digest, public runtime family/version, and the public
detector descriptors. Reject unknown keys and arbitrary build descriptions. Reject injected
identities, private allowlist values, paths, hostnames, device ids, environment values, and other
operator-specific material or commitment nonces; behavior-affecting private runtime configuration
is represented only by a nonce-hardened digest. Compute the descriptor digest over the exact
accepted bytes.

Receipt output must be canonical JSON. The public graph will declare the receipt digest.

- [ ] **Step 4: Implement deterministic public graph construction**

Clone `MetadataTransformationSet.graph`, not the caller's raw object or the untouched validated
source graph. The digest-only private source commitment still identifies the original exact
metadata bytes. Then:

1. replace Root publication/capture description with the public representation fields;
2. retain the historical Execution and exact role references;
3. remove withheld/unavailable entities from `hasPart` only;
4. add derived entities and provenance;
5. add source metadata commitment;
6. add policy, implementation, receipt, activity, Agent, and count entities;
7. sort `@graph` deterministically: metadata descriptor, Root, then entity id;
8. sort multi-value references where protocol order is not semantic;
9. serialize with recursively sorted keys, two-space indentation, and one trailing newline;
10. call `validateExecutionEvidence`;
11. compute the record reference only after final bytes exist.

If validation fails, throw `DERIVATIVE_NONCONFORMING` and attach protocol diagnostics. Never return
partial artifacts.

- [ ] **Step 5: Run tests and commit**

```bash
cd packages/evidence/derivation
yarn test src/receipt.test.ts src/public-graph.test.ts
yarn typecheck
git add src
git commit -s -m "feat(evidence-derivation): emit conforming public provenance and receipt"
```

---

### Task 6: Orchestrate outcomes, claims impact, cancellation, and determinism

**Files:**

- Create: `src/derive.ts`, `src/derive.test.ts`, `src/determinism.test.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Produces:
  - `createEvidenceDeriver(options): EvidenceDeriver`
- Consumes:
  - every prior task's validation, surface, detector, disposition, transform, receipt, and graph
    functions

- [ ] **Step 1: Write failing outcome tests**

Cover:

1. clean source → `publishable-unchanged`, exact source bytes, exact safe supplied artifacts, no
   scrub activity, and `executionVerification: "existing-verification-applicable"`;
2. redaction → `derived`, new record digest, receipt/policy/implementation artifacts;
3. unresolved review → `review-required`, private findings only, no publishable fields;
4. `agent-iri: "withhold-record"` in the protected-value table → `withheld` with only
   `protected-value-withheld` and `agent-iri`, no detector call and no publishable fields;
5. required detector absent → `withheld` with `required-detector-unavailable`;
6. required detector throws → `withheld` with `required-detector-failed`;
7. malformed structured artifact → typed exception before any output;
8. signed artifact requiring change → `withheld`;
9. Result derived under `derive-unassessed` → derived outcome with broken Result Evaluation
   transfer;
10. Result derived under `withhold-record` → withheld;
11. unchanged Task/Result → exact evaluation-subject applicability preserved;
12. every `derived` outcome reports
    `executionVerification: "not-transferred-to-derived-record"`;
13. neither Result Evaluation nor Execution Verification envelopes are rewritten or reserialized.
14. metadata-only redaction → `derived`, exact transformed literals in final bytes, no original
    sensitive literal, and unchanged artifact identities;
15. mixed metadata/artifact redaction → one conforming graph containing both transformation sets;
16. metadata `withhold-artifact` is promoted to `withheld`.
17. unclassified nested extension key/literal → `withheld` with only
    `unclassified-metadata`, no detector call, and no publishable fields.

Use `expect("record" in outcome).toBe(false)` and `expect("artifacts" in outcome).toBe(false)` for
both non-publishable variants.

- [ ] **Step 2: Write failing cancellation tests**

Inject detectors that stop on controlled promises. Cover:

- an already-aborted signal before source validation;
- cancellation while each detector position is awaiting its controlled promise;
- cancellation observed between two detector calls, before the next detector is invoked; and
- cancellation observed immediately after the final awaited detector returns, before synchronous
  transformation and serialization begin.

There is no separate injectable checkpoint inside the final synchronous transformation and
serialization section. The contract promises cooperative cancellation at observable asynchronous
boundaries, not preemption between synchronous instructions.

Expected: `EvidenceDerivationError` with `OPERATION_ABORTED`, no returned outcome, and no mutated
input.

- [ ] **Step 3: Write failing determinism tests**

Byte-stable:

```ts
const first = await deriver.derive(input);
const second = await deriver.derive(cloneInput(input));
expect(first).toEqual(second);
```

Changing each exact input independently must change the derivative or policy identity:

- source byte;
- policy byte;
- scrubber descriptor byte;
- `completedAt`;
- detector descriptor/configuration.

Best-effort:

- policy permitting best effort accepts a detector that returns two different valid finding sets;
- each derived output is conforming and content-addressed;
- receipt says `content-addressed`;
- the package does not assert equal digests.

Policy requiring byte stability plus a best-effort detector returns `withheld`.

- [ ] **Step 4: Implement `createEvidenceDeriver`**

Construction:

- defensively snapshot detector objects and unique descriptors;
- reject duplicate detector ids;
- do no I/O and no model initialization.

Derivation sequence must exactly follow design §14:

```text
copy/validate input
  -> validate source/artifacts
  -> parse policy/scrubber descriptor/completedAt
  -> satisfy detector requirements
  -> extract surfaces
  -> apply protected-value disposition table
  -> detect + normalize
  -> disposition
  -> review/withhold short circuit
  -> transform metadata/artifacts
  -> unchanged short circuit
  -> receipt
  -> public graph
  -> final conformance
  -> defensive output
```

Do not catch `OPERATION_ABORTED`. Convert only a required detector's operational failure into a
withholding reason. Contract-invalid detector output remains
`DETECTOR_CONTRACT_VIOLATION`.

- [ ] **Step 5: Run tests and commit**

```bash
cd packages/evidence/derivation
yarn test src/derive.test.ts src/determinism.test.ts
yarn typecheck
git add src
git commit -s -m "feat(evidence-derivation): orchestrate graded derivation outcomes"
```

### PR 3 coordinator closeout: root distribution and executable guards

After integrating Tasks 1–6, the coordinator—not the package subagent—updates all four shared
architecture/CI files so the public root package is independently guarded and green.

The inventory uses the current tuple shape:

```js
['derivation', '@jinn-network/evidence-derivation'],
```

and the approved dependency-graph entry:

```js
['derivation', {
  dependencies: ['@jinn-network/evidence-protocol'],
  devDependencies: [],
  optionalDependencies: [],
  peerDependencies: [],
}],
```

Rename the inventory assertion from eight to nine and update every exact directory/count
expectation. Add root source-boundary rules and synthetic forbidden-import canaries. Add a packed
TypeScript consumer for `@jinn-network/evidence-derivation` only; `/testing` does not exist yet.
Add a provisional `derivation-core` job to the existing Evidence CI DAG. It consumes the Protocol
distribution and runs immutable install, Tasks 1–6 tests, typecheck, build, and root pack smoke
while preserving `Evidence CI / verify`.

The coordinator runs the three shared guards, proves every new canary fails on a synthetic
forbidden import, and commits the shared-file changes separately with DCO sign-off.

---

## PR 4 — Derivation hardening and distribution

Branch from PR 3's exact reviewed head. Do not reopen the public contract except to fix a proven
defect found by the contract/security suites.

### Task 7: Ship both conformance kits and adversarial security coverage

**Files:**

- Create: `src/testing.ts`, `src/contract.test.ts`, `src/security.test.ts`
- Modify: `package.json`, `scripts/pack-smoke.mjs`

**Interfaces:**

- Produces:
  - `describeEvidenceDeriverContract(factory)`
  - `describeDerivationDetectorContract(factory, fixtures)`
- synthetic fixture factories
- Consumes:
  - Vitest as an optional peer dependency

Add the `./testing` export and `vitest` optional peer dependency at this PR boundary; neither was
advertised by PR 3 before its implementation existed.

- [ ] **Step 1: Implement `describeDerivationDetectorContract` test-first**

The suite accepts:

```ts
export interface DerivationDetectorContractContext {
  readonly detector: DerivationDetector;
  readonly ambientEffectCount: () => number;
  readonly retainedSurfaceCount: () => number;
  readonly cleanup?: () => void | Promise<void>;
}

export type DerivationDetectorContractFactory = () =>
  | DerivationDetectorContractContext
  | Promise<DerivationDetectorContractContext>;

export interface DerivationDetectorContractFixture {
  readonly surface: DerivationSurface;
  readonly expectedClasses?: readonly string[];
}
```

The suite asserts:

- safe descriptor snapshot;
- no input mutation;
- valid findings and offsets;
- no plaintext in evidence;
- stable normalized ordering;
- cancellation;
- zero ambient effects and zero retained surfaces after successful and cancelled calls;
- repeated equality when `byte-stable`;
- no equality claim when `best-effort`.

The contract kit calls both observers around every detector invocation and runs `cleanup` after
each case. Built-in-detector tests additionally install failing canaries for `fetch`, network
clients, durable filesystem operations, ambient clocks, and ambient randomness and use a unique
private marker in each surface. Run the kit against every built-in detector. A third-party
detector's own truthful observer harness provides conformance evidence but is not a sandbox or a
proof against malicious code. Every concrete detector must add detector-owned coverage asserting
the same zero-effect and zero-retention conditions after each operational rejection path it
implements.

- [ ] **Step 2: Implement `describeEvidenceDeriverContract` test-first**

The suite accepts a factory whose optional argument is a complete synthetic
detector set owned by the contract kit:

```ts
export type EvidenceDeriverContractFactory = (
  detectors?: readonly DerivationDetector[],
) => EvidenceDeriver | Promise<EvidenceDeriver>;
```

The suite calls the factory without an argument for the ordinary built-in
matrix. It also supplies closed, deterministic synthetic detector sets for
best-effort grading, injected rejection, and cancellation cases that cannot be
proved by a zero-argument factory. The factory must construct the deriver with
the supplied set unchanged when one is present. This is test-only dependency
injection through `/testing`; it does not add a production root dependency or
ambient effect.

The suite asserts every invariant in design §15 using only synthetic data. Run
it against `createEvidenceDeriver`.

- [ ] **Step 3: Add adversarial security tests**

Cover:

- getters/proxies and unsafe prototypes at every public boundary;
- sparse arrays and non-enumerable fields;
- prototype-pollution keys in policy/JSON artifacts;
- duplicate JSON keys;
- invalid UTF-8;
- huge/out-of-range detector offsets;
- overlapping detector output;
- source graph entity-id collision with every added conventional id;
- a source already carrying derivation entities;
- a derived artifact digest collision;
- signed DSSE payload/signature mutation attempts;
- technical values adjacent to credential-shaped substrings;
- findings whose evidence tries to copy matched source text;
- policy, detector-descriptor, implementation-descriptor, and receipt leakage scans against every
  secret, known-identity, private-allowlist, commitment-nonce, path, hostname, and device fixture
  value; and
- final derived record-byte scans against every synthetic sensitive `name`, `description`,
  `error`, selected `PropertyValue.value`, and admitted extension literal;
- nested unknown-extension keys and literals cannot appear in final bytes without exact policy
  selectors, including inside arrays and multi-level objects;
- protected-value hold reasons leak neither the protected value nor its graph location; and
- mutation of returned byte arrays followed by a repeated derivation.

- [ ] **Step 4: Extend pack smoke**

Pack into a temporary consumer and assert:

```js
const root = await import("@jinn-network/evidence-derivation");
const testing = await import("@jinn-network/evidence-derivation/testing");

assert.equal(typeof root.createEvidenceDeriver, "function");
assert.equal(typeof root.parseDerivationPolicy, "function");
assert.equal(typeof root.parseScrubReceipt, "function");
assert.equal(typeof testing.describeEvidenceDeriverContract, "function");
assert.equal(typeof testing.describeDerivationDetectorContract, "function");
assert.equal("canonicalJsonBytes" in root, false);
assert.equal("sha256Digest" in root, false);
```

Also scan the tarball file list to ensure tests, source maps containing fixture text, local-corpus
data, and ML packages are absent.

- [ ] **Step 5: Run the full package gate and commit**

```bash
cd packages/evidence/derivation
yarn test
yarn typecheck
yarn build
yarn pack:smoke
git add .
git commit -s -m "feat(evidence-derivation): ship contract kits and security coverage"
```

---

### Task 8: Finish PR 4 with distribution, CI, and boundary gates

**Files:**

- Modify: `packages/evidence/derivation/README.md`
- Coordinator modifies the four shared architecture/CI files named in the implementation
  foundation

**Interfaces:**

- Produces: CI coverage and consumer documentation
- Consumes: completed package

- [ ] **Step 1: Extend the consolidated architecture guards**

Through the integration coordinator:

- keep the exact package inventory at nine; the package and dependency graph already landed in
  PR 3;
- extend the existing root boundary and canaries to the new `/testing` region;
- extend the packed TypeScript consumer from root-only to root plus `/testing`; and
- prove each canary fails when supplied one synthetic forbidden import.

- [ ] **Step 2: Add derivation to the Evidence CI DAG**

Through the integration coordinator, promote the provisional `derivation-core` coverage to the
final Derivation component job that consumes the Foundation `dist/` artifact for Protocol and runs
the complete contract/security/package suite. Preserve the existing jobs and the final
`Evidence CI / verify` aggregate gate. Do not replace the workflow with a package loop or create a
separate derivation workflow.

- [ ] **Step 3: Write the README**

The README must contain:

- one-paragraph purpose;
- the four outcomes;
- exact no-I/O flow;
- a short example using explicit `policyBytes`, `completedAt`, and implementation descriptor;
- why signed envelopes are not accepted;
- why Result Evaluation may not transfer;
- deterministic vs best-effort guarantee;
- `./testing` kit usage;
- explicit statement that ML, review, repositories, publication, and cutover do not ship here;
- links to the design and protocol §6.8/§10.

Do not document the future ML binding as available.

- [ ] **Step 4: Run package and structure gates**

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
node --test .github/scripts/evidence-packed-types.test.mjs

cd packages/evidence/derivation
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
cd ../../..
```

Expected: PASS.

- [ ] **Step 5: Run boundary scans**

```bash
rg -n \
  '@huggingface/transformers|@lmoe/gliner-onnx|better-sqlite3|node:fs|viem|EpisodeV1|packages/core|@jinn-network/(evidence-repository|publication|evidence-discovery|execution-recorder|attestation-issuer)' \
  packages/evidence/derivation/src packages/evidence/derivation/package.json
```

Expected: no hits. README may name refused packages; restrict the scan to `src` and
`package.json`.

```bash
rg -n '\\b(Finding|ScrubResult|AnnouncementBatch|batch)\\b' \
  packages/evidence/derivation/src --glob '!*.test.ts'
```

Expected: no bare legacy/colliding public names. `DerivationFinding` is allowed by the exact-word
boundary.

- [ ] **Step 6: Verify the package diff is surgical**

```bash
git status --short
git diff --stat
git diff -- packages/core client packages/layer
```

Expected: the last command is empty. Only the new package and the coordinator-owned architecture
and Evidence CI files are in scope.

- [ ] **Step 7: Commit**

```bash
git add packages/evidence/derivation .github
git commit -s -m "ci(evidence-derivation): integrate the evidence DAG"
```

---

## Follow-ups outside this plan

1. **`@jinn-network/evidence-derivation-ml`.** GLiNER-only binding with
   `@lmoe/gliner-onnx`, a package-owned canonical public model/runtime recipe committed by the
   closed descriptor's `implementationDigest`, best-effort grade, and detector contract suite.
2. **Producer composition.** Load private source bytes, invoke derivation, apply application
   admission, then publish exact output.
3. **Public claim composition.** Issue a new Execution Verification over public metadata and select
   only exact-subject Result Evaluations.
4. **Human review application.** Persist private findings, collect decisions, write a new exact
   policy/allowlist artifact, and rerun derivation.
5. **Detector-quality tool.** Move local-corpus loading and benchmark execution into a separate
   non-runtime tool using direct `DerivationFinding` output.
6. **Legacy migration.** Port core/client/layer users one at a time, keep compatibility gates, then
   delete redundant legacy scrub code.
7. **`packages/core` disposition.** Survey what remains after evidence-adapter and scrub migration.

## Spec coverage checklist

| Design requirement | Task |
| --- | --- |
| Refusal boundary and no I/O | Global constraints, Tasks 1 and 8 |
| Exact byte port and four outcomes | Tasks 1 and 6 |
| Detector port and contract kit | Tasks 3 and 7 |
| Exact canonical policy | Task 1 |
| Deterministic built-in safety floor | Tasks 3 and 6 |
| Structure before entropy | Task 2 |
| Text/JSON/JSONL/signed/binary codecs | Task 4 |
| No role substitution | Tasks 4 and 5 |
| New Root, source commitment, activity, policy, counts, and mappings | Task 5 |
| Receipt without circular metadata digest | Task 5 |
| Verification remains applicable to unchanged bytes and never transfers to derived metadata | Tasks 5 and 6 |
| Exact Result Evaluation transfer behavior | Tasks 4 and 6 |
| Byte-stable and best-effort grades | Tasks 3 and 6 |
| ML excluded from base | Global constraints and Task 8 scans |
| Review queue/application split | Outcome tests in Task 6 |
| Conformance kits and security coverage | Task 7 |
| No legacy cutover | Global constraints and Task 8 diff check |

## Plan self-review

**Spec coverage:** Every settled design decision maps to a task above. The optional ML binding is
not necessary for the deterministic base to pass its own contract and is explicitly a follow-up.

**Type consistency:** `DerivationDetectorDescriptor`, `DerivationSurface`, `DerivationFinding`,
`DerivationBindingImpact`, and the four outcome variants are defined in Task 1 and consumed under
the same names. Artifact transformation and public-graph tasks use the same package-local
`DerivationSha256Digest` and `PublishableArtifact` types.

**Boundary consistency:** The plan touches no live caller. The package depends only on Protocol
semantics plus detection libraries. I/O, repositories, ML, review persistence, issuer,
publication, and discovery remain outside.

**Determinism consistency:** Every ambient value is explicit. No task introduces an implicit clock,
environment read, random id, model cache, or repository lookup. A no-op preserves exact bytes;
changed structured artifacts serialize deterministically.

**No placeholders:** Every task names exact files, interfaces, failing tests, implementation
behavior, verification commands, and a commit message.
