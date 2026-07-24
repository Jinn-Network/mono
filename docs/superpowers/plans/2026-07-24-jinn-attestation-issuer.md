# Jinn Attestation Issuer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@jinn-network/attestation-issuer@0.1.0`, a standalone library that prepares, signs, validates, parses, and commits Result Evaluation and Execution Verification attestations without performing evaluation, verification, identity, trust, or policy work.

**Architecture:** Two typed preparation functions construct the existing in-toto Statements, obtain ordered signatures through one injected DSSE signer, and return defensively copied prepared exact bytes. A separate commit function revalidates those bytes and writes them through the Evidence Repository contract, making the prepared envelope—not another signing attempt—the retry unit.

**Tech Stack:** TypeScript 5.9, ES2022 ESM, Node 22, Yarn 4.13.0, `@jinn-network/evidence-protocol@0.1.0`, `@jinn-network/evidence-repository@0.1.0`, Vitest 4.1, and Node standard-library cryptography for tests only.

## Global Constraints

- Implement only `@jinn-network/attestation-issuer@0.1.0` under `packages/attestation-issuer`.
- Use Apache-2.0 and SPDX headers on every TypeScript and JavaScript source file.
- Use Node `>=22`, TypeScript target/module `ES2022`, Yarn `4.13.0`, and a package-local lockfile.
- Runtime dependencies are exactly `@jinn-network/evidence-protocol@0.1.0` and `@jinn-network/evidence-repository@0.1.0`.
- Do not add a signer, wallet, blockchain, cryptography, plugin, recorder, marketplace, catalog, or concrete repository dependency.
- Do not change the Evidence Protocol, Evidence Repository, Execution Recorder, or their schemas.
- Expose two typed preparation operations; do not expose a generic arbitrary-attestation builder.
- Require digest-addressed subject and supporting-resource references; do not fetch or store referenced bytes.
- Keep preparation/signing separate from repository commitment.
- Never generate evaluation or verification times implicitly.
- Never infer a verdict, Agent identity, key-to-Agent binding, signature trust, admission, or policy conclusion.
- Preserve permitted JSON extension fields and reject reserved-field collisions before invoking the signer.
- Base64-encode DSSE payloads and signatures using padded standard RFC 4648 base64.
- Serialize recursively sorted object keys with two-space indentation and one trailing newline; do not claim RFC 8785 conformance.
- All repository failures propagate as their original `EvidenceRepositoryError`.
- Add DCO sign-off to every commit.
- Produce a publish-ready tarball and CI, but do not publish to npm or provision signing or repository infrastructure.

---

## File Structure

Create this package structure:

```text
packages/attestation-issuer/
├── .gitignore
├── .yarnrc.yml
├── README.md
├── package.json
├── yarn.lock
├── tsconfig.json
├── tsconfig.build.json
├── fixtures/
│   └── issuer-contract-v1/
│       ├── README.md
│       ├── expected-digests.json
│       ├── execution-verification.json
│       └── result-evaluation.json
├── scripts/
│   └── pack-smoke.mjs
└── src/
    ├── commit.test.ts
    ├── commit.ts
    ├── deterministic-json.test.ts
    ├── deterministic-json.ts
    ├── errors.ts
    ├── index.ts
    ├── input.test.ts
    ├── input.ts
    ├── prepare.test.ts
    ├── prepare.ts
    ├── prepared.test.ts
    ├── prepared.ts
    ├── statement.test.ts
    ├── statement.ts
    ├── testing.test.ts
    ├── testing.ts
    └── types.ts
```

Responsibilities:

- `types.ts`: all public inputs, signer types, prepared unions, receipts, operation options, and testing-independent JSON types.
- `errors.ts`: stable issuer error codes, `AttestationIssuerError`, cancellation checks, and internal error constructors.
- `deterministic-json.ts`: JSON-domain checking, defensive cloning, recursively sorted serialization, UTF-8 encoding, and padded standard base64.
- `input.ts`: digest/resource normalization, absolute IRI checks, extension collision checks, Statement input normalization, and protocol-schema preflight.
- `statement.ts`: pure typed construction of the two in-toto Statement families.
- `prepare.ts`: PAE creation, signer invocation, signature normalization, DSSE envelope creation, final protocol validation, and the two public preparation functions.
- `prepared.ts`: defensive prepared values and exact-envelope parsing.
- `commit.ts`: prepared-byte revalidation and repository commitment.
- `testing.ts`: the reusable Vitest integration contract.
- `index.ts`: explicit public exports only.
- `fixtures/issuer-contract-v1`: synthetic, deterministic, non-trust-bearing envelope vectors used by tests and packed consumers.
- `scripts/pack-smoke.mjs`: tarball shape, imports, fixture, dependency, validation, and undeclared-dependency checks.
- `.github/workflows/attestation-issuer-ci.yml`: dependency-first immutable CI.

Ship as a three-PR implementation stack above the approved design branch:

1. contracts and typed Statement builders;
2. signing, prepared values, and parsing;
3. repository commitment, reusable contract, fixtures, README, packed smoke, and CI.

## Frozen Public Interfaces

The package root must expose these exact families and signatures. `src/types.ts` defines the
types; `prepare.ts`, `prepared.ts`, and `commit.ts` define the functions:

```ts
import type {
  ExecutionVerificationEvidence,
  ResultEvaluationEvidence,
} from "@jinn-network/evidence-protocol";
import type {
  EvidenceRecordReference,
  EvidenceRepository,
  RepositoryWriteReceipt,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

export type JsonScalar = string | number | boolean | null;

export type JsonValue =
  | JsonScalar
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface AttestationIssuerOperationOptions {
  readonly signal?: AbortSignal;
}

export interface AttestationResourceReference {
  readonly name: string;
  readonly digest: Sha256Digest;
  readonly uri?: string;
  readonly mediaType?: string;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface AttestationAgentReference {
  readonly id: string;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface EvaluationMeasurement {
  readonly name: string;
  readonly value: JsonScalar;
  readonly unit?: string;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface VerificationCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "unknown";
  readonly explanation?: string;
  readonly evidence?: readonly AttestationResourceReference[];
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface PrepareResultEvaluationInput {
  readonly task: AttestationResourceReference;
  readonly results: readonly [
    AttestationResourceReference,
    ...AttestationResourceReference[],
  ];
  readonly evaluator: AttestationAgentReference;
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

export interface PrepareExecutionVerificationInput {
  readonly executionEvidenceDigest: Sha256Digest;
  readonly executionId: string;
  readonly verifier: AttestationAgentReference;
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

export interface PreparedAttestation<
  TFamily extends
    | "result-evaluation"
    | "execution-verification",
  TValue,
> {
  readonly family: TFamily;
  readonly recordDigest: Sha256Digest;
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly value: TValue;
}

export type PreparedResultEvaluation = PreparedAttestation<
  "result-evaluation",
  ResultEvaluationEvidence
>;

export type PreparedExecutionVerification = PreparedAttestation<
  "execution-verification",
  ExecutionVerificationEvidence
>;

export type AnyPreparedAttestation =
  | PreparedResultEvaluation
  | PreparedExecutionVerification;

export interface AttestationCommitReceipt<
  TFamily extends
    | "result-evaluation"
    | "execution-verification",
> {
  readonly family: TFamily;
  readonly recordDigest: Sha256Digest;
  readonly repositoryReceipt: RepositoryWriteReceipt<EvidenceRecordReference>;
}

export function prepareResultEvaluation(
  input: PrepareResultEvaluationInput,
  signer: DsseSigner,
  options?: AttestationIssuerOperationOptions,
): Promise<PreparedResultEvaluation>;

export function prepareExecutionVerification(
  input: PrepareExecutionVerificationInput,
  signer: DsseSigner,
  options?: AttestationIssuerOperationOptions,
): Promise<PreparedExecutionVerification>;

export function parsePreparedAttestation(
  envelopeBytes: Uint8Array,
): AnyPreparedAttestation;

export function commitPreparedAttestation<
  TPrepared extends AnyPreparedAttestation,
>(
  prepared: TPrepared,
  repository: EvidenceRepository,
  options?: AttestationIssuerOperationOptions,
): Promise<AttestationCommitReceipt<TPrepared["family"]>>;
```

`src/index.ts` exports the public types, error constants/class, preparation functions,
`parsePreparedAttestation`, and `commitPreparedAttestation`. Internal JSON, input, and Statement
helpers are not exported.

---

### Task 1: Standalone Package, Public Contracts, and Deterministic JSON

**Files:**
- Create: `packages/attestation-issuer/package.json`
- Create: `packages/attestation-issuer/.yarnrc.yml`
- Create: `packages/attestation-issuer/.gitignore`
- Create: `packages/attestation-issuer/yarn.lock`
- Create: `packages/attestation-issuer/tsconfig.json`
- Create: `packages/attestation-issuer/tsconfig.build.json`
- Create: `packages/attestation-issuer/src/index.ts`
- Create: `packages/attestation-issuer/src/types.ts`
- Create: `packages/attestation-issuer/src/errors.ts`
- Create: `packages/attestation-issuer/src/deterministic-json.ts`
- Create: `packages/attestation-issuer/src/deterministic-json.test.ts`

**Interfaces:**
- Consumes: protocol evidence types, repository references/receipts, Node `TextEncoder`, and Node `Buffer`.
- Produces: the frozen public types above; `AttestationIssuerError`; internal `cloneJsonValue`, `deterministicJsonBytes`, `cloneBytes`, and `standardBase64`.

- [ ] **Step 1: Scaffold the package manifest and TypeScript configuration**

Create `package.json` with:

```json
{
  "name": "@jinn-network/attestation-issuer",
  "version": "0.1.0",
  "description": "Producer-neutral issuance of Jinn evaluation and verification attestations.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/attestation-issuer"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist/"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/evidence-protocol": "0.1.0",
    "@jinn-network/evidence-repository": "0.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/evidence-protocol": "portal:../evidence-protocol",
    "@jinn-network/evidence-repository": "portal:../evidence-repository"
  }
}
```

Copy the ES2022 compiler options and Yarn configuration pattern from
`packages/execution-recorder`, changing only the package path. Add `dist/`, `.yarn/`,
`node_modules/`, and `*.tgz` to `.gitignore`. Run `yarn install` once to generate the lockfile.

- [ ] **Step 2: Write the deterministic JSON tests**

Create `src/deterministic-json.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  cloneBytes,
  cloneJsonValue,
  deterministicJsonBytes,
  standardBase64,
} from "./deterministic-json.js";

const decode = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes);

describe("deterministic JSON", () => {
  test("sorts object keys recursively while preserving array order", () => {
    const bytes = deterministicJsonBytes({
      z: 1,
      a: [{ y: true, x: false }, 2],
    });
    expect(decode(bytes)).toBe(
      '{\n  "a": [\n    {\n      "x": false,\n      "y": true\n    },\n    2\n  ],\n  "z": 1\n}\n',
    );
  });

  test.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    new Date("2026-07-24T00:00:00Z"),
  ])("rejects non-JSON input %#", (value) => {
    expect(() => cloneJsonValue(value)).toThrow(
      expect.objectContaining({ code: "INVALID_ISSUANCE_INPUT" }),
    );
  });

  test("copies bytes and emits padded standard base64", () => {
    const source = new Uint8Array([0, 127, 128, 255]);
    const copy = cloneBytes(source);
    source[0] = 99;
    expect(copy).toEqual(new Uint8Array([0, 127, 128, 255]));
    expect(standardBase64(copy)).toBe("AH+A/w==");
  });
});
```

- [ ] **Step 3: Run the focused test and verify the red state**

Run:

```bash
corepack yarn --cwd packages/attestation-issuer test src/deterministic-json.test.ts
```

Expected: FAIL because `deterministic-json.ts` does not exist.

- [ ] **Step 4: Implement public types and stable errors**

Create `types.ts` using the frozen interfaces in this plan. Create `errors.ts` with:

```ts
// SPDX-License-Identifier: Apache-2.0

export const ATTESTATION_ISSUER_ERROR_CODES = [
  "INVALID_ISSUANCE_INPUT",
  "SIGNING_FAILED",
  "INVALID_SIGNER_OUTPUT",
  "PROTOCOL_CONFORMANCE_FAILED",
  "PREPARED_ATTESTATION_INVALID",
  "UNSUPPORTED_ATTESTATION_FAMILY",
  "OPERATION_ABORTED",
  "INTERNAL_FAILURE",
] as const;

export type AttestationIssuerErrorCode =
  (typeof ATTESTATION_ISSUER_ERROR_CODES)[number];

export class AttestationIssuerError extends Error {
  override readonly name = "AttestationIssuerError";

  constructor(
    readonly code: AttestationIssuerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function assertIssuerOperationActive(
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    throw new AttestationIssuerError(
      "OPERATION_ABORTED",
      "The attestation issuer operation was aborted.",
      { cause: signal.reason },
    );
  }
}
```

- [ ] **Step 5: Implement deterministic JSON and defensive copies**

Implement a recursive walker that accepts only null, strings, booleans, finite numbers, arrays,
and plain objects with `Object.prototype` or null prototypes. Track visited containers in a
`WeakSet` and reject cycles as `INVALID_ISSUANCE_INPUT`. Sort object entries by key before
recursion, preserve array order, clone every container, and serialize with
`JSON.stringify(value, null, 2) + "\n"`.

Expose these internal signatures:

```ts
export function cloneBytes(bytes: Uint8Array): Uint8Array;
export function cloneJsonValue(value: unknown): JsonValue;
export function deterministicJsonBytes(value: unknown): Uint8Array;
export function standardBase64(bytes: Uint8Array): string;
```

- [ ] **Step 6: Run the focused tests, typecheck, and build**

Run:

```bash
corepack yarn --cwd packages/attestation-issuer test src/deterministic-json.test.ts
corepack yarn --cwd packages/attestation-issuer typecheck
corepack yarn --cwd packages/attestation-issuer build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the standalone contracts**

```bash
git add packages/attestation-issuer
git commit -s -m "feat(attestation-issuer): define issuance contracts"
```

---

### Task 2: Typed Input Normalization and Statement Builders

**Files:**
- Create: `packages/attestation-issuer/src/input.ts`
- Create: `packages/attestation-issuer/src/input.test.ts`
- Create: `packages/attestation-issuer/src/statement.ts`
- Create: `packages/attestation-issuer/src/statement.test.ts`

**Interfaces:**
- Consumes: Task/Result/Execution Evidence inputs from `types.ts`, deterministic JSON cloning, protocol predicate constants, protocol Statement schemas, and repository digest parsing.
- Produces: internal `normalizeResultEvaluationInput`, `normalizeExecutionVerificationInput`, `buildResultEvaluationStatement`, and `buildExecutionVerificationStatement`.

- [ ] **Step 1: Write failing tests for Result Evaluation construction**

Create `src/statement.test.ts` with a fixed digest:

```ts
const digest =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
```

Assert that:

```ts
const statement = buildResultEvaluationStatement({
  task: { name: "task.md", digest },
  results: [
    { name: "result.patch", digest },
  ],
  evaluator: { id: "https://example.test/agents/evaluator" },
  evaluatedAt: "2026-07-24T12:00:00Z",
  verdict: "pass",
});

expect(statement).toMatchObject({
  _type: "https://in-toto.io/Statement/v1",
  predicateType:
    "https://jinn.network/attestations/result-evaluation/v1",
  subject: [
    {
      name: "task.md",
      digest: { sha256: "a".repeat(64) },
    },
    {
      name: "result.patch",
      digest: { sha256: "a".repeat(64) },
    },
  ],
  predicate: {
    evaluator: { id: "https://example.test/agents/evaluator" },
    evaluatedAt: "2026-07-24T12:00:00Z",
    taskSubject: "task.md",
    resultSubjects: ["result.patch"],
    verdict: "pass",
  },
});
```

Also assert that two Results preserve caller order and that specification, method,
measurements, evidence, explanation, limitations, corrections, disputes, and permitted
extensions appear at their protocol-defined locations.

- [ ] **Step 2: Write failing tests for Execution Verification construction**

In the same file, assert:

```ts
const statement = buildExecutionVerificationStatement({
  executionEvidenceDigest: digest,
  executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  verifier: { id: "https://example.test/agents/verifier" },
  verifiedAt: "2026-07-24T12:01:00Z",
  verdict: "verified",
});

expect(statement).toMatchObject({
  _type: "https://in-toto.io/Statement/v1",
  predicateType:
    "https://jinn.network/attestations/execution-verification/v1",
  subject: [
    {
      name: "ro-crate-metadata.json",
      digest: { sha256: "a".repeat(64) },
    },
  ],
  predicate: {
    executionId:
      "urn:uuid:11111111-1111-4111-8111-111111111111",
    verifier: { id: "https://example.test/agents/verifier" },
    verifiedAt: "2026-07-24T12:01:00Z",
    verdict: "verified",
  },
});
```

Assert optional policy, method, checks, evidence, explanation, limitations, corrections,
disputes, and extensions.

- [ ] **Step 3: Write failing input-rejection tests**

Create `src/input.test.ts`. Table-drive these cases and require
`INVALID_ISSUANCE_INPUT`:

- uppercase, short, long, or non-hex SHA-256 text;
- empty Task, Result, resource, measurement, or check names;
- zero Results at runtime despite the tuple type;
- duplicate Task/Result names;
- relative evaluator, verifier, or Execution IDs;
- impossible or offset-free timestamps;
- empty explanations when present;
- non-JSON, cyclic, or unsafe-prototype extension values;
- reserved collisions in Statement, predicate, Agent, Resource, measurement, and check
  extensions; and
- invalid verdict or check status supplied through `unknown` test casts.

For every invalid preparation input, use a signer spy and assert it is never called in Task 3.
At this task, assert the normalization or builder throws before any signing API exists.

- [ ] **Step 4: Run the focused tests and verify the red state**

Run:

```bash
corepack yarn --cwd packages/attestation-issuer test src/input.test.ts src/statement.test.ts
```

Expected: FAIL because the normalization and Statement modules do not exist.

- [ ] **Step 5: Implement resource and extension normalization**

In `input.ts`:

- parse `sha256:<64 lowercase hex>` without accepting whitespace;
- map it to `{ sha256: hex }`;
- validate absolute IRIs with `new URL(value)` and a non-empty protocol;
- validate timestamps by constructing candidate Statements and calling the exported protocol
  Statement schemas before signing;
- merge extensions only after rejecting the reserved keys for their location;
- use own enumerable string keys only;
- clone every input object, array, annotation, extension, and string list;
- preserve caller array order; and
- return normalized objects disconnected from caller mutation.

Use these reserved sets:

```ts
const statementReserved = new Set([
  "_type",
  "subject",
  "predicateType",
  "predicate",
]);

const evaluationPredicateReserved = new Set([
  "evaluatedAt",
  "evaluator",
  "evaluationMethod",
  "evaluationSpecification",
  "taskSubject",
  "resultSubjects",
  "verdict",
  "measurements",
  "evidence",
  "explanation",
  "limitations",
  "supersedes",
  "disputes",
]);

const verificationPredicateReserved = new Set([
  "verifiedAt",
  "verifier",
  "verificationMethod",
  "verificationPolicy",
  "executionId",
  "verdict",
  "checks",
  "explanation",
  "limitations",
  "supersedes",
  "disputes",
]);
```

Define corresponding reserved sets for Resource Descriptors (`name`, `digest`, `uri`,
`mediaType`, `annotations`), Agents (`id`), measurements (`name`, `value`, `unit`,
`annotations`), and checks (`name`, `status`, `explanation`, `evidence`, `annotations`).

- [ ] **Step 6: Implement the pure Statement builders**

In `statement.ts`, construct Task-first evaluation subjects and the fixed verification subject.
Derive `taskSubject` and `resultSubjects`; never accept those fields from extensions. Use
`IN_TOTO_STATEMENT_TYPE`, `RESULT_EVALUATION_PREDICATE_TYPE`, and
`EXECUTION_VERIFICATION_PREDICATE_TYPE` from Evidence Protocol.

Call `ResultEvaluationStatementSchema.safeParse` or
`ExecutionVerificationStatementSchema.safeParse` before returning. Convert schema failures into
`AttestationIssuerError("INVALID_ISSUANCE_INPUT", ...)`, preserving a concise path and message.

- [ ] **Step 7: Run focused and package verification**

Run:

```bash
corepack yarn --cwd packages/attestation-issuer test src/input.test.ts src/statement.test.ts
corepack yarn --cwd packages/attestation-issuer typecheck
corepack yarn --cwd packages/attestation-issuer test
corepack yarn --cwd packages/attestation-issuer build
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit typed Statement construction**

```bash
git add packages/attestation-issuer/src
git commit -s -m "feat(attestation-issuer): build typed attestation statements"
```

Open the first implementation PR from this commit with base
`codex/attestation-issuer-design`. Keep it draft until the package tests, typecheck, and build
are green.

---

### Task 3: DSSE Signing, Prepared Values, and Exact-Byte Parsing

**Files:**
- Create: `packages/attestation-issuer/src/prepare.ts`
- Create: `packages/attestation-issuer/src/prepare.test.ts`
- Create: `packages/attestation-issuer/src/prepared.ts`
- Create: `packages/attestation-issuer/src/prepared.test.ts`
- Modify: `packages/attestation-issuer/src/index.ts`

**Interfaces:**
- Consumes: Statement builders, deterministic JSON/base64 helpers, `dssePreAuthEncoding`,
  `recordDigest`, the two protocol validators, signer types, and issuer cancellation/errors.
- Produces: `prepareResultEvaluation`, `prepareExecutionVerification`,
  `parsePreparedAttestation`, `PreparedResultEvaluation`,
  `PreparedExecutionVerification`, and `AnyPreparedAttestation`.

- [ ] **Step 1: Write the signer-observation tests**

Create `src/prepare.test.ts` with:

```ts
const calls: DsseSigningRequest[] = [];
const signer: DsseSigner = async (request) => {
  calls.push({
    ...request,
    payloadBytes: Uint8Array.from(request.payloadBytes),
    preAuthEncoding: Uint8Array.from(request.preAuthEncoding),
  });
  return [
    {
      keyid: "test-key",
      signature: new Uint8Array([1, 2, 3, 4]),
    },
  ];
};
```

Prepare one minimal Result Evaluation and assert:

- the signer is called once;
- `payloadType` equals `application/vnd.in-toto+json`;
- `preAuthEncoding` equals
  `dssePreAuthEncoding(request.payloadType, request.payloadBytes)`;
- the exact payload decodes to the expected Statement;
- the envelope uses padded standard base64;
- `validateResultEvaluation(envelopeBytes).conforms` is true;
- family is `result-evaluation`;
- `recordDigest` equals protocol `recordDigest(envelopeBytes)`; and
- mutating caller inputs, signer request arrays, or returned prepared arrays after resolution
  cannot alter retained prepared bytes.

Repeat for minimal Execution Verification and its validator/family.

- [ ] **Step 2: Write multi-signature, failure, and cancellation tests**

Assert:

- two returned signatures preserve order and optional `keyid`;
- an empty signature array, empty signature bytes, non-`Uint8Array` signature, or non-string
  runtime `keyid` fails with `INVALID_SIGNER_OUTPUT`;
- a thrown signer error becomes `SIGNING_FAILED` with the original cause;
- an already-aborted signal fails with `OPERATION_ABORTED` before signing;
- a signal aborted inside the signer fails after signing without returning a prepared value;
- invalid input from Task 2 never invokes the signer; and
- a Vitest mock of the family-specific protocol validator returning one stable diagnostic fails
  with `PROTOCOL_CONFORMANCE_FAILED` and includes that diagnostic code in the error message.

- [ ] **Step 3: Write prepared-envelope parsing tests**

Create `src/prepared.test.ts`. For each family:

1. prepare a valid envelope;
2. call `parsePreparedAttestation(prepared.envelopeBytes)`;
3. assert family, digest, payload, parsed value, and exact bytes equal the original;
4. mutate the parser input and first returned value; and
5. parse the original bytes again and assert no retained state changed.

Reject malformed UTF-8, malformed JSON, invalid base64, unknown predicate types, Execution
Evidence JSON, missing signatures, subject-binding failures, and byte tampering. Use
`PREPARED_ATTESTATION_INVALID` for malformed known-family envelopes and
`UNSUPPORTED_ATTESTATION_FAMILY` for a structurally readable unknown predicate type.

- [ ] **Step 4: Run the focused tests and verify the red state**

Run:

```bash
corepack yarn --cwd packages/attestation-issuer test src/prepare.test.ts src/prepared.test.ts
```

Expected: FAIL because the preparation and prepared modules do not exist.

- [ ] **Step 5: Implement DSSE preparation**

In `prepare.ts`:

1. assert the operation is active;
2. build the normalized Statement;
3. serialize exact payload bytes;
4. compute PAE with `dssePreAuthEncoding`;
5. pass defensive byte copies and the signal to the signer;
6. assert active again after signer resolution;
7. validate the non-empty ordered signer output;
8. immediately clone signature bytes;
9. build `{ payloadType, payload, signatures }`;
10. serialize exact envelope bytes;
11. invoke the family-specific protocol validator;
12. throw `PROTOCOL_CONFORMANCE_FAILED` with stable sorted diagnostic summaries when it does not
    conform; and
13. construct a defensive prepared value from the validator's successful `value`.

Do not call `verifyDsseSignatures`; signature mathematics and key resolution remain external.

- [ ] **Step 6: Implement exact prepared parsing**

In `prepared.ts`, use strict UTF-8/JSON/base64 decoding only to identify `predicateType`, then
delegate normative validation to `validateResultEvaluation` or
`validateExecutionVerification`. Never treat the preliminary parse as conformance.

Construct prepared values through one internal function:

```ts
export function createPreparedAttestation(
  family:
    | "result-evaluation"
    | "execution-verification",
  envelopeBytes: Uint8Array,
): AnyPreparedAttestation;
```

Keep this function internal to the package export map. Always compute the digest from the exact
input bytes and derive payload/value from the successful protocol report.

- [ ] **Step 7: Export only the intended preparation surface**

Update `src/index.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

export {
  ATTESTATION_ISSUER_ERROR_CODES,
  AttestationIssuerError,
} from "./errors.js";
export {
  prepareExecutionVerification,
  prepareResultEvaluation,
} from "./prepare.js";
export { parsePreparedAttestation } from "./prepared.js";
export type {
  AnyPreparedAttestation,
  AttestationAgentReference,
  AttestationCommitReceipt,
  AttestationIssuerOperationOptions,
  AttestationResourceReference,
  DsseProducedSignature,
  DsseSigner,
  DsseSigningRequest,
  EvaluationMeasurement,
  JsonScalar,
  JsonValue,
  PrepareExecutionVerificationInput,
  PreparedExecutionVerification,
  PreparedResultEvaluation,
  PrepareResultEvaluationInput,
  VerificationCheck,
} from "./types.js";
```

Do not export Statement builders, deterministic JSON, extension merging, or prepared constructors.

- [ ] **Step 8: Run package verification**

Run:

```bash
corepack yarn --cwd packages/attestation-issuer typecheck
corepack yarn --cwd packages/attestation-issuer test
corepack yarn --cwd packages/attestation-issuer build
```

Expected: all commands exit 0 and all emitted declarations import only declared dependencies.

- [ ] **Step 9: Commit signed preparation and parsing**

```bash
git add packages/attestation-issuer/src
git commit -s -m "feat(attestation-issuer): prepare signed attestations"
```

Open the second implementation PR with the first implementation branch as its base.

---

### Task 4: Prepared Attestation Repository Commitment

**Files:**
- Create: `packages/attestation-issuer/src/commit.ts`
- Create: `packages/attestation-issuer/src/commit.test.ts`
- Modify: `packages/attestation-issuer/src/index.ts`

**Interfaces:**
- Consumes: `AnyPreparedAttestation`, `parsePreparedAttestation`, `EvidenceRepository`, repository receipts/errors, and operation cancellation.
- Produces: `commitPreparedAttestation` and typed `AttestationCommitReceipt`.

- [ ] **Step 1: Write the successful and idempotent commit tests**

Create `src/commit.test.ts` using `InMemoryEvidenceRepository` from
`@jinn-network/evidence-repository/testing`. Prepare each family and assert:

```ts
const first = await commitPreparedAttestation(prepared, repository);
const second = await commitPreparedAttestation(prepared, repository);

expect(first).toMatchObject({
  family: prepared.family,
  recordDigest: prepared.recordDigest,
  repositoryReceipt: {
    reference: {
      family: prepared.family,
      digest: prepared.recordDigest,
    },
    size: prepared.envelopeBytes.byteLength,
    status: "created",
  },
});
expect(second.repositoryReceipt.status).toBe("existing");
expect(
  await repository.getRecord(first.repositoryReceipt.reference),
).toEqual(prepared.envelopeBytes);
```

Add a repository spy and assert `putArtifact`, `getArtifact`, and `getRecord` are never called.

- [ ] **Step 2: Write the revalidation and failure tests**

Construct untrusted structural objects by casting and assert no repository write for:

- a mutated envelope byte;
- wrong family;
- wrong record digest;
- wrong payload bytes;
- a parsed value from the other family;
- a missing or extra signature;
- a prepared envelope whose byte length no longer matches;
- an already-aborted signal; and
- a repository receipt with the wrong digest, family, size, or impossible status.

Require `PREPARED_ATTESTATION_INVALID` before the repository call for local prepared corruption
and `INTERNAL_FAILURE` for a repository implementation that returns a receipt contradicting the
contract.

- [ ] **Step 3: Write the retry-without-resigning test**

Use a signer spy and a repository wrapper that throws one
`EvidenceRepositoryError("IO_FAILURE", "injected")` from its first `putRecord`, then delegates to
the in-memory repository.

Assert:

1. preparation calls the signer once;
2. first commitment rejects with the exact injected repository error;
3. second commitment succeeds with the original prepared digest and bytes; and
4. the signer call count remains one.

- [ ] **Step 4: Run the focused test and verify the red state**

Run:

```bash
corepack yarn --cwd packages/attestation-issuer test src/commit.test.ts
```

Expected: FAIL because `commit.ts` does not exist.

- [ ] **Step 5: Implement commitment**

In `commit.ts`:

- assert cancellation before local work;
- reparse `prepared.envelopeBytes`;
- compare reparsed family, digest, payload bytes, and normalized parsed value to the untrusted
  prepared object;
- pass a defensive envelope copy and `{ signal }` to `repository.putRecord`;
- allow repository `EvidenceRepositoryError` to escape unchanged;
- verify receipt family/digest/size and status after the call; and
- return a frozen receipt with no signer, identity, trust, or publication fields.

Use byte-by-byte equality for envelope and payload arrays. Compare the `envelope` and `statement`
members of the two parsed values with deterministic JSON; do not pass either value's
`Uint8Array` payload through the JSON serializer.

- [ ] **Step 6: Export commitment**

Add:

```ts
export { commitPreparedAttestation } from "./commit.js";
```

to `src/index.ts`.

- [ ] **Step 7: Run package verification**

Run:

```bash
corepack yarn --cwd packages/attestation-issuer typecheck
corepack yarn --cwd packages/attestation-issuer test
corepack yarn --cwd packages/attestation-issuer build
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit repository commitment**

```bash
git add packages/attestation-issuer/src
git commit -s -m "feat(attestation-issuer): commit prepared attestations"
```

---

### Task 5: Contract Fixtures, Packed Distribution, Documentation, and CI

**Files:**
- Create: `packages/attestation-issuer/src/testing.ts`
- Create: `packages/attestation-issuer/src/testing.test.ts`
- Create: `packages/attestation-issuer/fixtures/issuer-contract-v1/README.md`
- Create: `packages/attestation-issuer/fixtures/issuer-contract-v1/expected-digests.json`
- Create: `packages/attestation-issuer/fixtures/issuer-contract-v1/result-evaluation.json`
- Create: `packages/attestation-issuer/fixtures/issuer-contract-v1/execution-verification.json`
- Create: `packages/attestation-issuer/scripts/pack-smoke.mjs`
- Create: `packages/attestation-issuer/README.md`
- Create: `.github/workflows/attestation-issuer-ci.yml`
- Modify: `packages/attestation-issuer/package.json`

**Interfaces:**
- Consumes: the complete root issuer API, Evidence Protocol validators/signature verification,
  Evidence Repository, Vitest, and deterministic synthetic fixture inputs.
- Produces: `@jinn-network/attestation-issuer/testing`,
  `describeAttestationIssuerIntegrationContract`, exported fixtures, a packed-install smoke test,
  and dependency-first CI.

- [ ] **Step 1: Define and test the integration contract driver**

Create this `testing.ts` surface:

```ts
export interface AttestationIssuerContractObservation<
  TPrepared extends AnyPreparedAttestation,
> {
  readonly prepared: TPrepared;
  readonly receipt: AttestationCommitReceipt<TPrepared["family"]>;
  readonly repository: EvidenceRepository;
  readonly signatureVerifier: DsseSignatureVerifier;
  readonly cleanup?: () => Promise<void> | void;
}

export interface AttestationIssuerContractDriver {
  issueResultEvaluation(
    input: PrepareResultEvaluationInput,
  ): Promise<
    AttestationIssuerContractObservation<PreparedResultEvaluation>
  >;

  issueExecutionVerification(
    input: PrepareExecutionVerificationInput,
  ): Promise<
    AttestationIssuerContractObservation<
      PreparedExecutionVerification
    >
  >;
}

export type AttestationIssuerContractDriverFactory = () =>
  | AttestationIssuerContractDriver
  | Promise<AttestationIssuerContractDriver>;

export function describeAttestationIssuerIntegrationContract(
  driverFactory: AttestationIssuerContractDriverFactory,
): void;
```

The contract supplies fixed minimal and fully populated inputs. For each observation it
independently:

- retrieves the receipt reference;
- requires byte equality with `prepared.envelopeBytes`;
- validates the retrieved record with the correct Evidence Protocol validator;
- verifies every signature with `verifyDsseSignatures` and the supplied callback;
- checks exact subjects, actor, timestamp, verdict, support, and extensions;
- checks receipt family, digest, and size; and
- calls cleanup in `finally`.

Create `testing.test.ts` with a literal driver using Node `crypto.sign`/`crypto.verify`, a fixed
test-only Ed25519 private key encoded in PKCS#8 DER fixture text, and
`InMemoryEvidenceRepository`. Run the exported contract against it.

- [ ] **Step 2: Run the contract test and verify the red state**

Run:

```bash
corepack yarn --cwd packages/attestation-issuer test src/testing.test.ts
```

Expected: FAIL because `testing.ts` does not exist.

- [ ] **Step 3: Implement the reusable contract and make it pass**

Implement the exact independent checks above. Do not import package-private Statement or JSON
helpers from `testing.ts`; the contract must behave like an external consumer.

Run:

```bash
corepack yarn --cwd packages/attestation-issuer test src/testing.test.ts
```

Expected: PASS.

- [ ] **Step 4: Check in deterministic golden envelopes**

Use a signer returning fixed bytes:

```ts
const fixtureSigner: DsseSigner = async () => [
  {
    keyid: "issuer-contract-fixture-key",
    signature: new Uint8Array([
      0, 1, 2, 3, 4, 5, 6, 7,
      8, 9, 10, 11, 12, 13, 14, 15,
    ]),
  },
];
```

Prepare one fully populated evaluation and verification using fixed `2026-07-24T12:00:00Z`
timestamps, stable HTTPS Agent IRIs, stable `urn:uuid:` Execution identity, and fixed SHA-256
descriptors. Write the exact envelope bytes into the two JSON fixture files and record their
protocol digests in `expected-digests.json`.

Add tests that:

- parse each fixture;
- compare the family and digest to `expected-digests.json`;
- validate through Evidence Protocol;
- regenerate from the same input and fake signer and require byte equality; and
- state in the fixture README that the fixed signature bytes demonstrate serialization only and
  are not cryptographic or trust evidence.

- [ ] **Step 5: Write the README**

Document:

- the evaluator/verifier decision boundary;
- the prepare/sign then commit lifecycle;
- reference-only subjects and support;
- signer callback usage without private-key arguments;
- prepared-byte retry;
- repository injection;
- the absence of evaluation, verification, trust, identity, catalog, public-publishing, and
  support-ingestion behavior;
- a minimal evaluation example;
- a minimal verification example;
- fixture and `./testing` usage; and
- Node 22/Yarn development commands.

- [ ] **Step 6: Implement the packed-install smoke test**

Follow `packages/execution-recorder/scripts/pack-smoke.mjs`. Pack the protocol, repository, and
issuer into a temporary directory; install them into a fresh npm consumer with scripts disabled;
then run Vitest against root and `./testing` imports.

At this step, modify `package.json` to add:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./testing": {
      "import": "./dist/testing.js",
      "types": "./dist/testing.d.ts"
    },
    "./fixtures/*": "./fixtures/*"
  },
  "files": [
    "dist/",
    "fixtures/",
    "README.md"
  ],
  "scripts": {
    "pack:smoke": "node scripts/pack-smoke.mjs"
  },
  "peerDependencies": {
    "vitest": "^4.1.8"
  },
  "peerDependenciesMeta": {
    "vitest": {
      "optional": true
    }
  }
}
```

Merge these keys into the existing manifest without removing the existing build, typecheck, test,
prepack, dependency, dev-dependency, resolution, engine, license, or publication fields.

Require the tarball to contain:

```text
package/README.md
package/dist/index.d.ts
package/dist/index.js
package/dist/testing.d.ts
package/dist/testing.js
package/fixtures/issuer-contract-v1/README.md
package/fixtures/issuer-contract-v1/expected-digests.json
package/fixtures/issuer-contract-v1/execution-verification.json
package/fixtures/issuer-contract-v1/result-evaluation.json
```

Reject any `*.test.*` or `*.spec.*` tarball member. Assert exact runtime dependencies, optional
Vitest peer metadata, both public preparation functions, prepared parsing, commitment, error
codes, the contract-kit export, fixture resolution, and fixture validation.

- [ ] **Step 7: Add dependency-first CI**

Create `.github/workflows/attestation-issuer-ci.yml` triggered by changes to:

```text
packages/evidence-protocol/**
packages/evidence-repository/**
packages/attestation-issuer/**
docs/superpowers/specs/2026-07-24-jinn-attestation-issuer-design.md
.github/workflows/attestation-issuer-ci.yml
```

On PRs and pushes to `next`, use Node 22 and Yarn 4.13.0, then run:

```bash
corepack yarn --cwd packages/evidence-protocol install --immutable
corepack yarn --cwd packages/evidence-protocol check:profile
corepack yarn --cwd packages/evidence-protocol typecheck
corepack yarn --cwd packages/evidence-protocol test
corepack yarn --cwd packages/evidence-protocol build

corepack yarn --cwd packages/evidence-repository install --immutable
corepack yarn --cwd packages/evidence-repository typecheck
corepack yarn --cwd packages/evidence-repository test
corepack yarn --cwd packages/evidence-repository build

corepack yarn --cwd packages/attestation-issuer install --immutable
corepack yarn --cwd packages/attestation-issuer typecheck
corepack yarn --cwd packages/attestation-issuer test
corepack yarn --cwd packages/attestation-issuer build
corepack yarn --cwd packages/attestation-issuer pack:smoke
```

- [ ] **Step 8: Run the final local acceptance suite**

Run from `packages/attestation-issuer`:

```bash
corepack yarn install --immutable
corepack yarn typecheck
corepack yarn test
corepack yarn build
corepack yarn pack:smoke
```

Then rerun foundation checks:

```bash
corepack yarn --cwd packages/evidence-protocol check:profile
corepack yarn --cwd packages/evidence-protocol typecheck
corepack yarn --cwd packages/evidence-protocol test
corepack yarn --cwd packages/evidence-repository typecheck
corepack yarn --cwd packages/evidence-repository test
```

Expected: every command exits 0.

- [ ] **Step 9: Commit the contract and distribution surface**

```bash
git add packages/attestation-issuer/src/testing.ts packages/attestation-issuer/src/testing.test.ts packages/attestation-issuer/fixtures packages/attestation-issuer/README.md
git commit -s -m "feat(attestation-issuer): add integration contracts and fixtures"
```

- [ ] **Step 10: Commit distribution verification**

```bash
git add .github/workflows/attestation-issuer-ci.yml packages/attestation-issuer/scripts/pack-smoke.mjs packages/attestation-issuer/package.json
git commit -s -m "ci(attestation-issuer): verify standalone package"
```

Open the third implementation PR with the signed-preparation branch as its base. Do not publish
the package or configure npm credentials.

---

## Final Review Gates

Before publishing the PR stack:

- [ ] Confirm the design commit is the exact parent of the first implementation branch.
- [ ] Confirm every commit from the design head to the final implementation head has a
  `Signed-off-by:` trailer.
- [ ] Confirm `git diff --check` passes on every PR range.
- [ ] Confirm each PR is independently typecheckable, testable, and buildable against its base.
- [ ] Confirm the final tree has no imports from Execution Recorder, plugin, Autopilot,
  marketplace, wallet, chain, signer SDK, catalog, filesystem repository, or OCI repository.
- [ ] Confirm invalid inputs never call the signer.
- [ ] Confirm preparation never calls any repository method.
- [ ] Confirm commitment never calls the signer or artifact methods.
- [ ] Confirm the two protocol validators accept the exact generated envelope bytes with zero
  diagnostics.
- [ ] Confirm signature verification is tested with a supplied callback but never interpreted as
  identity or trust.
- [ ] Confirm missing subject/support bytes do not block issuance.
- [ ] Confirm repository failure retries the same prepared bytes and digest without re-signing.
- [ ] Confirm packed root/testing imports, fixtures, dependency declarations, and archive shape.
- [ ] Run a fresh specification/boundary review.
- [ ] Run a fresh security, exact-byte, and retry-integrity review.
