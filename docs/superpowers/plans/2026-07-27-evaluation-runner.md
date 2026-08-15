# Evaluation Runner Implementation Plan

> **SUPERSEDED 2026-07-28 — `@jinn-network/evaluation-runner` will not be built.**
> The host-orchestration half of the underlying design is superseded by
> [`docs/superpowers/specs/2026-07-27-local-execution-backend-design.md`](../specs/2026-07-27-local-execution-backend-design.md)
> (§10.4, §17). The surviving evaluator-adapter core (design §10 / §11) plus the
> Attestation Issuer composition (design §17) is implemented as the **evaluation harness**
> work item in
> [`docs/superpowers/plans/2026-07-28-local-execution-backend.md`](./2026-07-28-local-execution-backend.md).
> This plan is retained unmodified below for the record.
>
> **Status:** Superseded — this plan does not execute. (It carried no explicit Status
> field before this note; this block is its status of record.)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-shaped, method-neutral `@jinn-network/evaluation-runner` library that turns one exact evaluation request into at most one checkpointed, signed, and repository-committed Result Evaluation without owning scheduling, evaluator infrastructure, trust, or publication.

**Architecture:** The host owns durable jobs, leases, evaluator registrations, retrieval, signing capabilities, and transport. The Runner validates and resolves one request, invokes the registered adapter once when recovery permits, checkpoints the normalized outcome and exact prepared DSSE bytes, stores explicitly selected evidence, delegates canonical claim creation to Attestation Issuer, commits through Evidence Repository, and returns a thin operational receipt. JSON Schema 2020-12 and CloudEvents 1.0 define portable operational contracts; no Evidence Protocol change is required.

**Tech Stack:** TypeScript 5.9, Node.js 22, Yarn 4.13, Vitest 4.1, JSON Schema 2020-12, CloudEvents 1.0, W3C Trace Context fields, `@jinn-network/evidence-protocol`, `@jinn-network/evidence-repository`, and `@jinn-network/attestation-issuer`.

## Global Constraints

- Implement against the recorded Evidence integration head `f65880c4e244e32334f0fed98bf00ff9b307e87d` on `integration/evidence-v1`, or a descendant containing that exact commit. Do not implement from an older detached workspace commit or from a mid-stack substrate branch.
- Start implementation in a fresh isolated worktree using `superpowers:using-git-worktrees`; do not modify an active evidence-stack worktree.
- Treat [the approved design](../specs/2026-07-26-evaluation-runner-design.md) as authoritative. If implementation appears to require a protocol or substrate ownership change, stop and raise a separate design decision.
- V1 issues Result Evaluation only. Do not add Execution Verification, a queue, a service transport, evaluator modes, evaluator infrastructure, publication policy, trust policy, or marketplace behavior.
- Do not modify `packages/evidence/protocol` claim schemas or add an evidence family.
- Use Attestation Issuer as the sole Result Evaluation constructor and signer. The Runner must not construct DSSE or in-toto claims itself.
- Use only injected `EvidenceRepository`, `EvaluationMaterialResolver`, `EvaluationAttemptCheckpointStore`, evaluator registrations, and signers. Production source must not import concrete repository bindings, Discovery, Local Runtime, Publication, Contribution, marketplace code, model SDKs, container APIs, wallet code, or ambient network APIs.
- Keep tests adjacent to production modules. Keep Vitest imports reachable only through `/testing` and test files.
- Use safe snapshots of untrusted objects, dense arrays, JSON values, and byte arrays before asynchronous work.
- Use exact lowercase `sha256:<64 hex>` descriptors. Never resolve by URI alone, search for “latest,” substitute content, or accept mutable resolver output.
- Treat `pass`, `fail`, and `inconclusive` as completed evaluations. Operational failures must never be translated into a verdict.
- Require a host lease or equivalent serialization before calling `run` for one active attempt. Checkpoint compare-and-set detects stale writes but does not make an unprotected nonrepeatable evaluator invocation safe.
- After each task, run the focused tests, `yarn typecheck`, and `git diff --check` before committing.
- Use American English in code, schemas, fixtures, documentation, and errors.

---

## Implementation Base and Dependency Direction

Before Task 1:

```bash
git merge-base --is-ancestor f65880c4e244e32334f0fed98bf00ff9b307e87d HEAD
git status --short
```

Expected: the ancestry command exits `0`, and the isolated worktree contains no unrelated edits.

The dependency direction must remain:

```text
Evidence Protocol ----\
Evidence Repository ---+--> Evaluation Runner
Attestation Issuer ----/

host application --> resolver, checkpoint store, registrations, repository,
                     lifecycle sink, identity continuity authority

Evaluation Runner -X-> concrete repositories, Discovery, Local Runtime,
                     Publication, Contribution, marketplaces, providers
```

## Planned File Map

```text
packages/evidence/evaluation-runner/
├── .yarnrc.yml
├── README.md
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── yarn.lock
├── fixtures/
│   └── runner-contract-v1/
│       ├── README.md
│       ├── completed-receipt.json
│       ├── evaluation-request.json
│       ├── failure.json
│       ├── human-request.json
│       ├── lifecycle-event.json
│       ├── model-request.json
│       ├── private-request.json
│       └── standard-task-satisfaction-specification.json
├── schemas/
│   ├── evaluation-attempt-checkpoint.v1.schema.json
│   ├── evaluation-failure.v1.schema.json
│   ├── evaluation-lifecycle-event.v1.schema.json
│   ├── evaluation-receipt.v1.schema.json
│   ├── evaluation-request.v1.schema.json
│   └── index.json
├── scripts/
│   ├── pack-smoke.mjs
│   └── sync-schemas.mjs
└── src/
    ├── artifacts.test.ts
    ├── artifacts.ts
    ├── checkpoints.test.ts
    ├── checkpoints.ts
    ├── deterministic-json.test.ts
    ├── deterministic-json.ts
    ├── errors.test.ts
    ├── errors.ts
    ├── fixtures.test.ts
    ├── identity.test.ts
    ├── identity.ts
    ├── index.ts
    ├── lifecycle.test.ts
    ├── lifecycle.ts
    ├── material.test.ts
    ├── material.ts
    ├── outcome.test.ts
    ├── outcome.ts
    ├── registrations.test.ts
    ├── registrations.ts
    ├── relationships.test.ts
    ├── relationships.ts
    ├── request.test.ts
    ├── request.ts
    ├── runner.integration.test.ts
    ├── runner.recovery.test.ts
    ├── runner.relationships.test.ts
    ├── runner.test.ts
    ├── runner.ts
    ├── schema-definitions.ts
    ├── schemas.test.ts
    ├── schemas.ts
    ├── standard-specification.test.ts
    ├── standard-specification.ts
    ├── testing.ts
    ├── testing/
    │   ├── evaluator-contract.ts
    │   ├── fixtures.ts
    │   ├── in-memory-checkpoints.ts
    │   └── in-memory-resolver.ts
    └── types.ts
```

Repository-level files changed:

```text
.github/scripts/evidence-package-inventory.test.mjs
.github/scripts/evidence-packed-types.test.mjs
.github/scripts/evidence-source-boundaries.test.mjs
.github/workflows/evidence-ci.yml
docs/superpowers/specs/2026-07-26-evaluation-runner-design.md
```

The design document is added to version control unchanged except for link corrections discovered by documentation checks.

## Public Contract Target

The root entrypoint must expose these signatures:

```ts
import type {
  AttestationAgentReference,
  AttestationResourceReference,
  DsseSigner,
  EvaluationMeasurement,
  JsonValue,
} from "@jinn-network/attestation-issuer";
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
  EvidenceRepository,
  RepositoryWriteReceipt,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

export type EvaluationVerdict = "pass" | "fail" | "inconclusive";
export type EvaluationInterruptionBehavior =
  | "repeatable"
  | "recoverable"
  | "nonrepeatable";
export type EvaluationResourceDescriptor = AttestationResourceReference;

export interface EvaluationRequestV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly task: EvaluationResourceDescriptor;
  readonly results: readonly [
    EvaluationResourceDescriptor,
    ...EvaluationResourceDescriptor[],
  ];
  readonly specification?: EvaluationResourceDescriptor;
  readonly evaluatorRegistrationId: string;
  readonly context: readonly EvaluationResourceDescriptor[];
  readonly deadline?: string;
  readonly supersedes?: readonly EvaluationResourceDescriptor[];
  readonly disputes?: readonly EvaluationResourceDescriptor[];
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface ResolvedEvaluationMaterial {
  readonly descriptor: EvaluationResourceDescriptor;
  readonly bytes: Uint8Array;
}

export interface EvaluationMaterialResolver {
  resolve(
    descriptors: readonly EvaluationResourceDescriptor[],
    options: {
      readonly deadline?: string;
      readonly signal: AbortSignal;
    },
  ): Promise<readonly ResolvedEvaluationMaterial[]>;
}

export type DetailedEvaluationOutcome =
  | {
      readonly kind: "json";
      readonly name: string;
      readonly value: JsonValue;
    }
  | {
      readonly kind: "artifact";
      readonly descriptor: EvaluationResourceDescriptor;
    };

export type EvaluationClaimEvidence =
  | {
      readonly kind: "new";
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly mediaType?: string;
      readonly annotations?: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly kind: "existing";
      readonly descriptor: EvaluationResourceDescriptor;
    };

export interface CompletedEvaluation {
  readonly detailedOutcome: DetailedEvaluationOutcome;
  readonly verdict: EvaluationVerdict;
  readonly evaluatedAt: string;
  readonly measurements?: readonly EvaluationMeasurement[];
  readonly explanation?: string;
  readonly limitations?: readonly string[];
  readonly claimEvidence?: readonly EvaluationClaimEvidence[];
  readonly evaluatorExecution?: EvaluationResourceDescriptor;
  readonly authenticatedEvaluatorContext?: JsonValue;
}

export interface EvaluationAdapterInput {
  readonly delivery: "initial" | "recovery";
  readonly attemptId: string;
  readonly task: ResolvedEvaluationMaterial;
  readonly results: readonly [
    ResolvedEvaluationMaterial,
    ...ResolvedEvaluationMaterial[],
  ];
  readonly specification: ResolvedEvaluationMaterial;
  readonly evaluationMethod: ResolvedEvaluationMaterial;
  readonly context: readonly ResolvedEvaluationMaterial[];
  readonly extensions: Readonly<Record<string, JsonValue>>;
  readonly deadline?: string;
  readonly signal: AbortSignal;
}

export interface EvaluationAdapter {
  evaluate(input: EvaluationAdapterInput): Promise<CompletedEvaluation>;
}

export type EvaluatorIdentitySource =
  | {
      readonly kind: "static";
      readonly evaluator: AttestationAgentReference;
    }
  | {
      readonly kind: "dynamic";
      resolve(input: {
        readonly attemptId: string;
        readonly authenticatedContext?: JsonValue;
        readonly signal: AbortSignal;
      }): Promise<AttestationAgentReference>;
    };

export interface EvaluatorRegistration {
  readonly registrationId: string;
  readonly adapter: EvaluationAdapter;
  readonly evaluationMethod: EvaluationResourceDescriptor;
  readonly specificationCompatibility: (input: {
    readonly specification: ResolvedEvaluationMaterial;
    readonly evaluationMethod: ResolvedEvaluationMaterial;
    readonly signal: AbortSignal;
  }) => boolean | Promise<boolean>;
  readonly evaluatorIdentity: EvaluatorIdentitySource;
  readonly signer: DsseSigner;
  readonly validateOutcome: (input: {
    readonly specification: ResolvedEvaluationMaterial;
    readonly outcome: CompletedEvaluation;
    readonly signal: AbortSignal;
  }) => void | Promise<void>;
  readonly interruptionBehavior: EvaluationInterruptionBehavior;
}
```

The completed API also exports `EvaluationAttemptCheckpointStore`,
`EvaluationIdentityContinuityAuthority`, `EvaluationFailureV1`,
`EvaluationReceiptV1`, lifecycle-event types, `EvaluationRunner`,
`createEvaluationRunner`, and the named standard specification described below.

## Task 1: Lock the Package Boundary and Scaffold the Package

**Files:**

- Modify: `.github/scripts/evidence-package-inventory.test.mjs`
- Modify: `.github/scripts/evidence-source-boundaries.test.mjs`
- Create: `packages/evidence/evaluation-runner/.yarnrc.yml`
- Create: `packages/evidence/evaluation-runner/package.json`
- Create: `packages/evidence/evaluation-runner/tsconfig.json`
- Create: `packages/evidence/evaluation-runner/tsconfig.build.json`
- Create: `packages/evidence/evaluation-runner/src/index.ts`
- Create: `packages/evidence/evaluation-runner/src/schemas.ts`
- Create: `packages/evidence/evaluation-runner/src/testing.ts`
- Generate: `packages/evidence/evaluation-runner/yarn.lock`

**Interfaces:**

- Consumes: package names and portal-resolution rules in the evidence inventory guard.
- Produces: the package identity `@jinn-network/evaluation-runner` and the root, `/schemas`, `/testing`, raw schema, and fixture export boundaries.

- [ ] Update `EVIDENCE_PACKAGES` to contain eleven manifests and add:

```js
['evaluation-runner', '@jinn-network/evaluation-runner'],
```

- [ ] Extend the manifest-discovery predicate with:

```js
|| name === '@jinn-network/evaluation-runner'
```

This ensures an unexpected second Runner manifest is detected rather than omitted from the actual
inventory.

- [ ] Add this approved Jinn dependency graph entry:

```js
['evaluation-runner', {
  dependencies: [
    '@jinn-network/attestation-issuer',
    '@jinn-network/evidence-protocol',
    '@jinn-network/evidence-repository',
  ],
  devDependencies: [],
  optionalDependencies: [],
  peerDependencies: [],
}],
```

- [ ] Change the inventory assertion name and count from ten to eleven, then run the guard before creating the package:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
```

Expected: failure identifying the missing `evaluation-runner/package.json`.

- [ ] Add `evaluation-runner` to `evidenceDirectories` and define a Runner boundary that forbids concrete repository bindings, Discovery, Local Runtime, Publication, Contribution, application packages, provider SDKs, Node network/filesystem modules, and ambient network APIs.

- [ ] Add `@jinn-network/evaluation-runner` to the IPFS and Derivation forbidden-package lists so lower-level packages cannot depend upward on orchestration.

- [ ] Add a canary fixture proving that the boundary detects both a forbidden package import and `fetch`.

- [ ] Add manifest assertions for exactly these code exports and static exports:

```json
{
  ".": {
    "import": "./dist/index.js",
    "types": "./dist/index.d.ts"
  },
  "./schemas": {
    "import": "./dist/schemas.js",
    "types": "./dist/schemas.d.ts"
  },
  "./testing": {
    "import": "./dist/testing.js",
    "types": "./dist/testing.d.ts"
  },
  "./schemas/*": "./schemas/*",
  "./fixtures/*": "./fixtures/*"
}
```

- [ ] Assert the exact dependency inventory: three Jinn runtime dependencies; `@types/node`, Ajv, Ajv Formats, TypeScript, and Vitest as development dependencies; Vitest as the only optional peer; and no optional dependencies.

- [ ] Add a root-region assertion that `src/index.ts` cannot import `vitest`, `src/testing.ts`, or `src/testing/**`.

- [ ] Add this initial manifest:

```json
{
  "name": "@jinn-network/evaluation-runner",
  "version": "0.1.0",
  "description": "Method-neutral orchestration of checkpointed Jinn Result Evaluations.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/evidence/evaluation-runner"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./schemas": {
      "import": "./dist/schemas.js",
      "types": "./dist/schemas.d.ts"
    },
    "./testing": {
      "import": "./dist/testing.js",
      "types": "./dist/testing.d.ts"
    },
    "./schemas/*": "./schemas/*",
    "./fixtures/*": "./fixtures/*"
  },
  "files": [
    "dist/",
    "fixtures/",
    "schemas/",
    "README.md"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "check:schemas": "yarn build && node scripts/sync-schemas.mjs --check",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build && node scripts/sync-schemas.mjs --check"
  },
  "dependencies": {
    "@jinn-network/attestation-issuer": "0.1.0",
    "@jinn-network/evidence-protocol": "0.1.0",
    "@jinn-network/evidence-repository": "0.1.0"
  },
  "peerDependencies": {
    "vitest": "^4.1.8"
  },
  "peerDependenciesMeta": {
    "vitest": {
      "optional": true
    }
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/attestation-issuer": "portal:../attestation-issuer",
    "@jinn-network/evidence-protocol": "portal:../protocol",
    "@jinn-network/evidence-repository": "portal:../repository"
  }
}
```

- [ ] Make the peer-dependency inventory assertion cover both packages with `/testing` entrypoints:

```js
for (const directory of ['derivation', 'evaluation-runner']) {
  const manifest = readPackage(directory);
  assert.deepEqual(manifest.peerDependencies, { vitest: '^4.1.8' });
  assert.deepEqual(manifest.peerDependenciesMeta, {
    vitest: { optional: true },
  });
}
```

- [ ] Set `.yarnrc.yml` exactly:

```yaml
nodeLinker: node-modules
```

- [ ] Copy the strict ES2022/Bundler TypeScript settings from Attestation Issuer and create temporary empty entrypoints containing only the SPDX header and `export {};`.

- [ ] Generate the lockfile and run the architecture guards:

```bash
cd packages/evidence/evaluation-runner
corepack yarn@4.13.0 install
cd ../../..
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
```

Expected: both guards pass.

- [ ] Commit:

```bash
git add .github/scripts/evidence-package-inventory.test.mjs \
  .github/scripts/evidence-source-boundaries.test.mjs \
  packages/evidence/evaluation-runner
git commit -m "feat(evidence): scaffold evaluation runner boundary"
```

## Task 2: Define Portable Types, Failures, Receipts, Events, and Checkpoints

**Files:**

- Create: `packages/evidence/evaluation-runner/src/types.ts`
- Create: `packages/evidence/evaluation-runner/src/schema-definitions.ts`
- Create: `packages/evidence/evaluation-runner/src/schemas.test.ts`
- Modify: `packages/evidence/evaluation-runner/src/schemas.ts`
- Create: `packages/evidence/evaluation-runner/scripts/sync-schemas.mjs`
- Create: `packages/evidence/evaluation-runner/schemas/evaluation-request.v1.schema.json`
- Create: `packages/evidence/evaluation-runner/schemas/evaluation-lifecycle-event.v1.schema.json`
- Create: `packages/evidence/evaluation-runner/schemas/evaluation-failure.v1.schema.json`
- Create: `packages/evidence/evaluation-runner/schemas/evaluation-receipt.v1.schema.json`
- Create: `packages/evidence/evaluation-runner/schemas/evaluation-attempt-checkpoint.v1.schema.json`
- Create: `packages/evidence/evaluation-runner/schemas/index.json`

**Interfaces:**

- Consumes: `AttestationResourceReference`, `AttestationAgentReference`,
  `DsseSigner`, `EvaluationMeasurement`, `JsonValue`, repository reference and receipt types.
- Produces: all public request, adapter, registration, checkpoint, failure, lifecycle, receipt, and Runner configuration types.

- [ ] Write schema tests first using Ajv 2020 and Ajv Formats in strict mode. Cover one valid example and rejection of unknown root properties, bad versions, empty results, malformed digests, relative deadlines, unsupported enums, and a receipt that duplicates `verdict`.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/schemas.test.ts
```

Expected: failure because the schema constants do not exist.

- [ ] Add the public request, resolved-material, adapter, completed-outcome, identity-source, registration, interruption, and evidence types shown in “Public Contract Target.”

- [ ] Add these exact failure enums:

```ts
export const EVALUATION_FAILURE_PHASES = [
  "request",
  "resolution",
  "evaluation",
  "checkpoint",
  "evidence-storage",
  "attestation-preparation",
  "attestation-commit",
] as const;

export const EVALUATION_CANONICAL_CODES = [
  "INVALID_ARGUMENT",
  "FAILED_PRECONDITION",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "RESOURCE_EXHAUSTED",
  "ABORTED",
  "UNAVAILABLE",
  "INTERNAL",
  "DATA_LOSS",
] as const;

export const EVALUATION_FAILURE_REASONS = [
  "invalid-request",
  "attempt-request-mismatch",
  "unknown-evaluator-registration",
  "unsupported-specification",
  "subject-not-found",
  "subject-digest-mismatch",
  "relationship-invalid",
  "invalid-evaluator-output",
  "provider-unavailable",
  "evaluator-identity-unavailable",
  "deadline-exceeded",
  "operation-canceled",
  "checkpoint-conflict",
  "outcome-checkpoint-failed",
  "prepared-checkpoint-failed",
  "receipt-checkpoint-failed",
  "evidence-storage-failed",
  "signing-failed",
  "claim-conformance-failed",
  "repository-commit-failed",
  "completion-state-unknown",
  "internal-error",
] as const;

export const EVALUATION_RECOVERY_ADVICE = [
  "retry-step",
  "resume-attempt",
  "new-attempt-required",
  "operator-action-required",
  "do-not-retry",
] as const;
```

- [ ] Add the thin failure and receipt types:

```ts
export interface EvaluationFailureV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly phase: EvaluationFailurePhase;
  readonly canonicalCode: EvaluationCanonicalCode;
  readonly reason: EvaluationFailureReason;
  readonly safeDetail: string;
  readonly occurredAt: string;
  readonly recoveryAdvice: EvaluationRecoveryAdvice;
}

export interface EvaluationReceiptV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly completedAt: string;
  readonly resultEvaluation: {
    readonly recordDigest: Sha256Digest;
    readonly repositoryReference: EvidenceRecordReference;
    readonly repositoryStatus: "created" | "existing";
  };
  readonly claimEvidenceReceipts: readonly RepositoryWriteReceipt<
    EvidenceArtifactReference
  >[];
}
```

- [ ] Add CloudEvents 1.0 types with event names:

```ts
export const EVALUATION_LIFECYCLE_EVENT_TYPES = [
  "network.jinn.evaluation.attempt.started.v1",
  "network.jinn.evaluation.attempt.progress.v1",
  "network.jinn.evaluation.attempt.completed.v1",
  "network.jinn.evaluation.attempt.failed.v1",
  "network.jinn.evaluation.attempt.canceled.v1",
] as const;

export const EVALUATION_PROGRESS_PHASES = [
  "resolving",
  "evaluating",
  "checkpointing",
  "storing-evidence",
  "issuing",
] as const;
```

Each event has `specversion: "1.0"`, a unique `id`, configured absolute `source`,
`subject: attemptId`, RFC 3339 `time`, `datacontenttype: "application/json"`,
typed `data`, and optional `traceparent` and `tracestate` extension attributes.

- [ ] Define portable base64 checkpoints as a cumulative discriminated union:

```ts
export interface CheckpointedBytesV1 {
  readonly encoding: "base64";
  readonly value: string;
  readonly digest: Sha256Digest;
}

export type CheckpointedEvaluationEvidenceV1 =
  | {
      readonly kind: "new";
      readonly role: "detailed-outcome" | "claim-evidence";
      readonly descriptor: EvaluationResourceDescriptor;
      readonly content: CheckpointedBytesV1;
    }
  | {
      readonly kind: "existing";
      readonly role:
        | "detailed-outcome"
        | "claim-evidence"
        | "evaluator-execution";
      readonly descriptor: EvaluationResourceDescriptor;
    };

export interface CompletedOutcomeCheckpointV1 {
  readonly schemaVersion: 1;
  readonly stage: "completed-outcome";
  readonly attemptId: string;
  readonly requestDigest: Sha256Digest;
  readonly revisionCreatedAt: string;
  readonly specification: EvaluationResourceDescriptor;
  readonly evaluationMethod: EvaluationResourceDescriptor;
  readonly evaluator: AttestationAgentReference;
  readonly evaluatedAt: string;
  readonly verdict: EvaluationVerdict;
  readonly measurements: readonly EvaluationMeasurement[];
  readonly explanation?: string;
  readonly limitations: readonly string[];
  readonly evidence: readonly CheckpointedEvaluationEvidenceV1[];
}

export interface PreparedAttestationCheckpointV1 {
  readonly schemaVersion: 1;
  readonly stage: "prepared-attestation";
  readonly attemptId: string;
  readonly requestDigest: Sha256Digest;
  readonly revisionCreatedAt: string;
  readonly outcome: CompletedOutcomeCheckpointV1;
  readonly preparedEnvelope: CheckpointedBytesV1;
  readonly claimEvidenceReceipts: readonly RepositoryWriteReceipt<
    EvidenceArtifactReference
  >[];
}

export interface ReceiptCheckpointV1 {
  readonly schemaVersion: 1;
  readonly stage: "receipt";
  readonly attemptId: string;
  readonly requestDigest: Sha256Digest;
  readonly revisionCreatedAt: string;
  readonly receipt: EvaluationReceiptV1;
}
```

- [ ] Define `VersionedEvaluationAttemptCheckpoint` and the store port:

```ts
export interface VersionedEvaluationAttemptCheckpoint {
  readonly revision: string;
  readonly checkpoint: EvaluationAttemptCheckpointV1;
}

export interface EvaluationAttemptCheckpointStore {
  load(
    attemptId: string,
    options: { readonly signal: AbortSignal },
  ): Promise<VersionedEvaluationAttemptCheckpoint | null>;

  saveCompletedOutcome(
    checkpoint: CompletedOutcomeCheckpointV1,
    options: {
      readonly expectedRevision: string | null;
      readonly signal: AbortSignal;
    },
  ): Promise<VersionedEvaluationAttemptCheckpoint>;

  savePreparedAttestation(
    checkpoint: PreparedAttestationCheckpointV1,
    options: {
      readonly expectedRevision: string;
      readonly signal: AbortSignal;
    },
  ): Promise<VersionedEvaluationAttemptCheckpoint>;

  saveReceipt(
    checkpoint: ReceiptCheckpointV1,
    options: {
      readonly expectedRevision: string;
      readonly signal: AbortSignal;
    },
  ): Promise<VersionedEvaluationAttemptCheckpoint>;
}
```

- [ ] Define the Runner configuration. Require explicit claim-evidence limits and lifecycle source; make the sink optional but best-effort:

```ts
export interface EvaluationRunnerConfiguration {
  readonly materialResolver: EvaluationMaterialResolver;
  readonly checkpointStore: EvaluationAttemptCheckpointStore;
  readonly evidenceRepository: EvidenceRepository;
  readonly evaluatorRegistrations: readonly EvaluatorRegistration[];
  readonly defaultSpecification?: EvaluationResourceDescriptor;
  readonly identityContinuityAuthority?: EvaluationIdentityContinuityAuthority;
  readonly claimEvidenceLimits: {
    readonly maxNewArtifacts: number;
    readonly maxArtifactBytes: number;
    readonly maxTotalArtifactBytes: number;
  };
  readonly lifecycle: {
    readonly source: string;
    readonly sink?: EvaluationLifecycleEventSink;
    readonly createEventId?: () => string;
    readonly now?: () => string;
  };
}
```

- [ ] Define the schemas once as `as const` TypeScript values in `schema-definitions.ts`. Set `$schema` to `https://json-schema.org/draft/2020-12/schema`, set stable `$id` values under `https://schemas.jinn.network/evaluation-runner/v1/`, use `unevaluatedProperties: false` at contract roots, and reference a shared resource descriptor definition.

- [ ] Export the constants from `/schemas`. Write `sync-schemas.mjs` to deterministic-JSON encode the exported schemas into `schemas/*.json`, generate `schemas/index.json`, and compare exact bytes in `--check` mode.

- [ ] Generate and test:

```bash
cd packages/evidence/evaluation-runner
yarn build
node scripts/sync-schemas.mjs
yarn test src/schemas.test.ts
yarn check:schemas
yarn typecheck
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner
git commit -m "feat(evaluation): define runner contracts and schemas"
```

## Task 3: Validate Requests, Registrations, Defaults, and the Standard Specification

**Files:**

- Create: `packages/evidence/evaluation-runner/src/request.test.ts`
- Create: `packages/evidence/evaluation-runner/src/request.ts`
- Create: `packages/evidence/evaluation-runner/src/registrations.test.ts`
- Create: `packages/evidence/evaluation-runner/src/registrations.ts`
- Create: `packages/evidence/evaluation-runner/src/standard-specification.test.ts`
- Create: `packages/evidence/evaluation-runner/src/standard-specification.ts`
- Modify: `packages/evidence/evaluation-runner/src/index.ts`

**Interfaces:**

- Consumes: untrusted `EvaluationRequestV1`, configured registrations, and optional configured default descriptor.
- Produces: `normalizeEvaluationRequest`, `createEvaluatorRegistrationMap`,
  `resolveEvaluationSpecificationDescriptor`, and
  `STANDARD_TASK_SATISFACTION_SPECIFICATION_V1`.

- [ ] Write request tests for safe plain-object snapshots, dense arrays, nonempty IDs, exact lowercase SHA-256, unique Task/Result names, nonempty Results, context default prohibition, absolute RFC 3339 deadline, reserved extension fields, and no bare URI descriptor.

- [ ] Add default-resolution tests proving:

  - request descriptor wins over application default;
  - an explicitly configured default is selected when the request omits one;
  - omission without a configured default is `FAILED_PRECONDITION`;
  - the package standard is never selected automatically.

- [ ] Add registration-map tests for duplicate and empty IDs, invalid method descriptors, invalid interruption values, and an unknown requested registration.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/request.test.ts src/registrations.test.ts \
  src/standard-specification.test.ts
```

Expected: failure because normalization and the named specification do not exist.

- [ ] Implement safe snapshot utilities in `request.ts`. Validate before any checkpoint lookup or injected callback. Preserve namespaced `extensions` as cloned JSON, reject keys without a colon, and pass the frozen operational values to the registered adapter. They remain absent from the signed claim.

- [ ] Compute the effective request digest from a deterministic JSON encoding of the normalized request after the exact specification default has been filled. Exclude no request fields. This digest detects reuse of an attempt ID with different input.

- [ ] Implement registration lookup as a frozen `ReadonlyMap<string, EvaluatorRegistration>` and never place `registrationId` in portable evidence.

- [ ] Define the package-provided specification document exactly:

```ts
export const STANDARD_TASK_SATISFACTION_SPECIFICATION_DOCUMENT_V1 = {
  schemaVersion: 1,
  id: "https://schemas.jinn.network/evaluation/specifications/task-satisfaction/v1",
  title: "Jinn Task Satisfaction Evaluation",
  outcomeSchema: {
    type: "object",
    required: ["conclusion"],
    properties: {
      conclusion: {
        enum: ["satisfied", "not-satisfied", "insufficient-evidence"],
      },
      rationale: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  },
  verdictMapping: {
    satisfied: "pass",
    "not-satisfied": "fail",
    "insufficient-evidence": "inconclusive",
  },
} as const;
```

- [ ] Encode the document using the Runner deterministic JSON format and export:

```ts
export const STANDARD_TASK_SATISFACTION_SPECIFICATION_V1: {
  readonly descriptor: EvaluationResourceDescriptor;
  readonly bytes: Uint8Array;
  readonly document: typeof STANDARD_TASK_SATISFACTION_SPECIFICATION_DOCUMENT_V1;
};
```

Use name `jinn-task-satisfaction-specification-v1.json`, media type
`application/json`, and compute its descriptor digest from the exact exported bytes.

- [ ] Export `validateStandardTaskSatisfactionOutcome`. It accepts only the three conclusions and requires that the adapter-returned verdict matches the declared mapping. It does not evaluate Task content.

- [ ] Prove explicit activation by configuring the descriptor as `defaultSpecification` and seeding its bytes into the test resolver. Also prove that importing the constant alone changes no Runner behavior.

- [ ] Export the public types and helpers from the root without exporting internal snapshot functions.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/request.test.ts src/registrations.test.ts \
  src/standard-specification.test.ts
yarn typecheck
git diff --check
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner/src
git commit -m "feat(evaluation): validate requests and registrations"
```

## Task 4: Resolve and Verify Exact Immutable Material

**Files:**

- Create: `packages/evidence/evaluation-runner/src/material.test.ts`
- Create: `packages/evidence/evaluation-runner/src/material.ts`
- Create: `packages/evidence/evaluation-runner/src/testing/in-memory-resolver.ts`
- Modify: `packages/evidence/evaluation-runner/src/testing.ts`

**Interfaces:**

- Consumes: exact descriptors, the injected `EvaluationMaterialResolver`, deadline, and cancellation signal.
- Produces: `resolveExactMaterial` and `InMemoryEvaluationMaterialResolver`.

- [ ] Write hostile resolver tests for missing results, extra results, reordering, changed descriptors, incorrect digest bytes, a mutable returned byte array, cancellation, and a resolver throwing not-found versus unavailable errors. Also prove a descriptor intentionally named in two roles is fulfilled exactly in both roles rather than substituted.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/material.test.ts
```

Expected: failure because exact-material verification does not exist.

- [ ] Define resolver-owned typed errors so a host can distinguish missing, inaccessible, and corrupt content without exposing provider detail:

```ts
export class EvaluationMaterialResolutionError extends Error {
  constructor(
    readonly kind: "not-found" | "permission-denied" | "unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EvaluationMaterialResolutionError";
  }
}
```

- [ ] Implement `resolveExactMaterial` so it:

  - snapshots descriptors before calling the resolver;
  - requests one ordered list;
  - requires a same-length dense response in the same order;
  - compares every returned descriptor field to the requested descriptor;
  - computes `recordDigest(bytes)` and compares it to the requested digest;
  - clones every returned byte array after verification;
  - freezes descriptors and result containers;
  - passes the absolute deadline and the combined abort signal;
  - never reads a descriptor URI itself.

- [ ] Implement the in-memory test resolver as an exact `digest -> bytes` map. It must clone on seed and resolve, permit explicit injected failures, record calls, and never fall back by name or URI.

- [ ] Add a mutation regression: mutate both the resolver's source bytes and returned bytes after resolution and prove the adapter-facing bytes remain unchanged.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/material.test.ts
yarn typecheck
node --test ../../../.github/scripts/evidence-source-boundaries.test.mjs
```

Expected: all commands pass and the source guard confirms no ambient retrieval.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner/src
git commit -m "feat(evaluation): resolve exact immutable material"
```

## Task 5: Make Outcomes and Prepared Bytes Durably Resumable

**Files:**

- Create: `packages/evidence/evaluation-runner/src/deterministic-json.test.ts`
- Create: `packages/evidence/evaluation-runner/src/deterministic-json.ts`
- Create: `packages/evidence/evaluation-runner/src/checkpoints.test.ts`
- Create: `packages/evidence/evaluation-runner/src/checkpoints.ts`
- Create: `packages/evidence/evaluation-runner/src/testing/in-memory-checkpoints.ts`
- Modify: `packages/evidence/evaluation-runner/src/testing.ts`

**Interfaces:**

- Consumes: JSON values, byte arrays, portable checkpoint values, and expected checkpoint revisions.
- Produces: deterministic JSON bytes, safe byte/base64 conversion, checkpoint validation, `EvaluationCheckpointConflictError`, and an in-memory CAS checkpoint store.

- [ ] Write deterministic JSON tests matching Attestation Issuer's observable encoding rules: lexicographically sorted object keys, two-space indentation, LF line ending, finite numbers only, safe plain objects, dense standard arrays, no accessors, no symbols, no cycles, and defensive byte copies.

- [ ] Write checkpoint tests for:

  - `null -> completed-outcome -> prepared-attestation -> receipt`;
  - a stale `expectedRevision`;
  - a skipped stage;
  - attempt ID or request digest changing between stages;
  - invalid base64 or byte digest;
  - returned checkpoint mutation;
  - concurrent saves where exactly one compare-and-set succeeds.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/deterministic-json.test.ts src/checkpoints.test.ts
```

Expected: failure because the checkpoint and deterministic encoding modules do not exist.

- [ ] Implement the same documented deterministic JSON representation used for findings and request digests:

```ts
export function cloneJsonValue(value: unknown): JsonValue;
export function deterministicJsonBytes(value: unknown): Uint8Array;
export function cloneBytes(value: Uint8Array): Uint8Array;
export function encodeCheckpointedBytes(bytes: Uint8Array): CheckpointedBytesV1;
export function decodeCheckpointedBytes(value: CheckpointedBytesV1): Uint8Array;
```

Do not import Attestation Issuer private modules. Confirm compatibility through output tests rather than a cross-package private import.

- [ ] Add the standard conflict error for store implementations:

```ts
export class EvaluationCheckpointConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationCheckpointConflictError";
  }
}
```

- [ ] Validate every loaded and saved checkpoint at the Runner boundary. Require canonical base64 round trips and verify each `CheckpointedBytesV1.digest` against decoded bytes.

- [ ] Implement `InMemoryEvaluationAttemptCheckpointStore` with monotonically increasing opaque revisions (`"1"`, `"2"`, `"3"`), exact expected-revision checks, defensive snapshots, and explicit fault injection for each save method.

- [ ] Add `assertCheckpointMatchesRequest`:

```ts
export function assertCheckpointMatchesRequest(
  checkpoint: EvaluationAttemptCheckpointV1,
  attemptId: string,
  requestDigest: Sha256Digest,
): void;
```

It maps a mismatch to reason `attempt-request-mismatch`; it never returns an earlier receipt for different input.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/deterministic-json.test.ts src/checkpoints.test.ts
yarn typecheck
git diff --check
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner/src
git commit -m "feat(evaluation): add resumable attempt checkpoints"
```

## Task 6: Validate Corrections, Disputes, and Evaluator Identity

**Files:**

- Create: `packages/evidence/evaluation-runner/src/relationships.test.ts`
- Create: `packages/evidence/evaluation-runner/src/relationships.ts`
- Create: `packages/evidence/evaluation-runner/src/identity.test.ts`
- Create: `packages/evidence/evaluation-runner/src/identity.ts`

**Interfaces:**

- Consumes: resolved prior-claim bytes, the current exact Task and Results, static or dynamic registration identity, and an optional injected identity continuity authority.
- Produces: `validateRelationshipTargets`, `resolveEvaluatorIdentity`, and `assertSupersessionIdentityContinuity`.

- [ ] Write relationship tests for a conforming prior Result Evaluation, invalid DSSE, wrong evidence family, wrong Task digest, wrong Result digest, reordered Results, missing or extra Results, duplicate relationship descriptors, and a dispute from a different evaluator. Reordered but otherwise identical Results must be accepted as the same subject set.

- [ ] Write identity tests for static identity, dynamic authenticated context, missing dynamic context, relative IRI, thrown identity provider error, exact supersession identity match, injected continuity approval, injected continuity rejection, and proving that disputes do not require identity continuity.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/relationships.test.ts src/identity.test.ts
```

Expected: failure because relationship and identity validators do not exist.

- [ ] Parse prior bytes only with the public protocol validator:

```ts
import { validateResultEvaluation } from "@jinn-network/evidence-protocol";
```

Do not call signature verification. Protocol conformance and exact subject binding are the only checks at this layer.

- [ ] Compare prior subjects by the semantic bindings in the claim:

  - locate `predicate.taskSubject` in `statement.subject`;
  - locate every `predicate.resultSubjects` name;
  - reject missing, duplicate, or unbound subject names;
  - require the Task descriptor to equal the current Task;
  - require the Result descriptor set to equal the current Result set with the same cardinality.

Result order remains exact for adapter input and the new claim, but it does not change the identity
of the subject set for supersession or dispute.

- [ ] Return this validated relationship value:

```ts
export interface ValidatedEvaluationRelationship {
  readonly descriptor: EvaluationResourceDescriptor;
  readonly evaluator: AttestationAgentReference;
  readonly task: EvaluationResourceDescriptor;
  readonly results: readonly [
    EvaluationResourceDescriptor,
    ...EvaluationResourceDescriptor[],
  ];
}
```

- [ ] Define the continuity authority:

```ts
export interface EvaluationIdentityContinuityAuthority {
  isSameEvaluator(input: {
    readonly previous: AttestationAgentReference;
    readonly current: AttestationAgentReference;
    readonly signal: AbortSignal;
  }): boolean | Promise<boolean>;
}
```

- [ ] Validate evaluator identities as safe Agent references with an absolute IRI. Ignore no fields and permit only JSON-valued extensions.

- [ ] For supersession, accept exact IRI equality first. If identities differ, require the injected authority to return `true`. Without an authority, or on `false`, reject with `FAILED_PRECONDITION` and `relationship-invalid`.

- [ ] For dispute, retain the exact relationship descriptor but do not apply identity continuity.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/relationships.test.ts src/identity.test.ts
yarn typecheck
git diff --check
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner/src
git commit -m "feat(evaluation): validate evaluation relationships"
```

## Task 7: Normalize Evaluator Output and Store Only Explicit Evidence

**Files:**

- Create: `packages/evidence/evaluation-runner/src/outcome.test.ts`
- Create: `packages/evidence/evaluation-runner/src/outcome.ts`
- Create: `packages/evidence/evaluation-runner/src/artifacts.test.ts`
- Create: `packages/evidence/evaluation-runner/src/artifacts.ts`

**Interfaces:**

- Consumes: untrusted `CompletedEvaluation`, the registration outcome validator, exact resolved existing artifacts, repository, and host-configured limits.
- Produces: `normalizeCompletedEvaluation`, `checkpointCompletedEvaluation`,
  `resolveExistingOutcomeEvidence`, and `storeNewOutcomeEvidence`.

- [ ] Write output tests for each verdict, invalid verdict, invalid timestamp, non-scalar measurement, empty explanation, invalid limitations, unsafe JSON, mutable byte arrays, output attempting to supply subjects/method/specification/repository/signer fields, and a validator rejection.

- [ ] Write artifact tests for:

  - deterministic JSON findings;
  - exact existing findings;
  - explicit new and existing claim evidence;
  - optional evaluator Execution descriptor;
  - bare URI rejection;
  - unsafe names containing `/`, `\\`, control characters, `"."`, or `".."`;
  - per-artifact, total-byte, and artifact-count limits;
  - digest mismatch for existing evidence;
  - repository write failure;
  - storage before any claim preparation callback;
  - malformed evaluator Execution Evidence;
  - no storage of logs, provider response, authenticated context, or other unselected output.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/outcome.test.ts src/artifacts.test.ts
```

Expected: failure because output normalization and artifact storage do not exist.

- [ ] Snapshot and structurally validate `CompletedEvaluation` before calling the registration's outcome validator. Allow only these root fields:

```ts
const COMPLETED_EVALUATION_FIELDS = new Set([
  "detailedOutcome",
  "verdict",
  "evaluatedAt",
  "measurements",
  "explanation",
  "limitations",
  "claimEvidence",
  "evaluatorExecution",
  "authenticatedEvaluatorContext",
]);
```

Reject any authority-bearing or unknown root field as `invalid-evaluator-output`.

- [ ] Require the registration validator to return `void`. Treat a non-`undefined` return as invalid output so the validator cannot replace normalized data.

- [ ] Convert every JSON detailed outcome into exact deterministic bytes with:

```ts
{
  kind: "new",
  role: "detailed-outcome",
  descriptor: {
    name: normalizedOutcome.detailedOutcome.name,
    digest: recordDigest(findingsBytes),
    mediaType: "application/json",
  },
  content: encodeCheckpointedBytes(findingsBytes),
}
```

- [ ] For an artifact detailed outcome, resolve and digest-verify the exact descriptor and checkpoint it as `kind: "existing"`, `role: "detailed-outcome"`.

- [ ] Treat new claim evidence as untrusted bytes. Clone before the first `await`, compute its descriptor, and checkpoint the exact base64 bytes. Existing claim evidence is resolved and digest-verified, then checkpointed by exact descriptor.

- [ ] Resolve the optional evaluator Execution descriptor, verify its digest, and require public `validateExecutionEvidence` conformance before checkpointing it as `role: "evaluator-execution"`. This validates format only; it is not Execution Verification.

- [ ] Preserve evidence order:

  1. detailed outcome;
  2. adapter-selected `claimEvidence` in adapter order;
  3. optional evaluator Execution.

Reject duplicate descriptor names within that evidence list to avoid ambiguous claim references.

- [ ] Before writing, enforce:

```ts
newArtifactCount <= maxNewArtifacts
eachByteLength <= maxArtifactBytes
sumOfNewByteLengths <= maxTotalArtifactBytes
eachByteLength <= repository.capabilities.maxObjectBytes
```

Apply the repository limit only when it is declared.

- [ ] Store only `kind: "new"` evidence through `putArtifact`. Verify every returned reference digest and receipt size against the checkpointed bytes. Return the signed-claim descriptors and only the write receipts for newly stored artifacts. Re-putting exact bytes during recovery is permitted and should produce `existing`.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/outcome.test.ts src/artifacts.test.ts
yarn typecheck
git diff --check
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner/src
git commit -m "feat(evaluation): preserve outcome evidence"
```

## Task 8: Standardize Failures, Deadlines, Cancellation, and Lifecycle Events

**Files:**

- Create: `packages/evidence/evaluation-runner/src/errors.test.ts`
- Create: `packages/evidence/evaluation-runner/src/errors.ts`
- Create: `packages/evidence/evaluation-runner/src/lifecycle.test.ts`
- Create: `packages/evidence/evaluation-runner/src/lifecycle.ts`

**Interfaces:**

- Consumes: internal and injected errors, request deadline, caller signal, configured clock/event ID/source/sink, and optional Trace Context.
- Produces: `EvaluationRunnerError`, `EvaluationAdapterOperationError`,
  `createOperationContext`, `createEvaluationFailure`, and
  `EvaluationLifecycleEmitter`.

- [ ] Write failure mapping tests for every phase and these important causes:

  - invalid request;
  - unknown registration;
  - unsupported specification;
  - material not found, forbidden, unavailable, or digest mismatch;
  - invalid evaluator output;
  - explicitly signaled provider unavailability;
  - stale checkpoint;
  - storage failure;
  - Attestation Issuer `SIGNING_FAILED`;
  - Attestation Issuer `PROTOCOL_CONFORMANCE_FAILED`;
  - repository commit failure;
  - deadline and caller cancellation;
  - an unknown thrown value.

- [ ] Prove serialized failures exclude stack traces, causes, provider bodies, content, credentials, and submitted Task/Result bytes.

- [ ] Write lifecycle tests for exact CloudEvents 1.0 envelopes, all five event names, all five progress phases, optional Trace Context, duplicate event acceptance, failed/canceled distinction, and a sink that throws.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/errors.test.ts src/lifecycle.test.ts
```

Expected: failure because failure mapping and lifecycle emission do not exist.

- [ ] Define adapter-owned operational signaling:

```ts
export class EvaluationAdapterOperationError extends Error {
  constructor(
    readonly canonicalCode:
      | "DEADLINE_EXCEEDED"
      | "CANCELLED"
      | "RESOURCE_EXHAUSTED"
      | "UNAVAILABLE"
      | "INTERNAL",
    readonly safeDetail: string,
    readonly recoveryAdvice: EvaluationRecoveryAdvice,
    options?: ErrorOptions,
  ) {
    super(safeDetail, options);
    this.name = "EvaluationAdapterOperationError";
  }
}
```

An arbitrary adapter throw maps to `INTERNAL`, `provider-unavailable` only when the adapter explicitly uses `UNAVAILABLE`, and neither case becomes `inconclusive`.

- [ ] Define the public rejection:

```ts
export class EvaluationRunnerError extends Error {
  constructor(
    readonly failure: EvaluationFailureV1,
    options?: ErrorOptions,
  ) {
    super(failure.safeDetail, options);
    this.name = "EvaluationRunnerError";
  }
}
```

- [ ] Map Attestation Issuer errors exactly:

```text
SIGNING_FAILED                  -> signing-failed / UNAVAILABLE
INVALID_SIGNER_OUTPUT           -> signing-failed / INTERNAL
PROTOCOL_CONFORMANCE_FAILED     -> claim-conformance-failed / INTERNAL
INVALID_ISSUANCE_INPUT          -> claim-conformance-failed / INTERNAL
PREPARED_ATTESTATION_INVALID    -> claim-conformance-failed / DATA_LOSS
OPERATION_ABORTED               -> operation-canceled or deadline-exceeded
INTERNAL_FAILURE                -> internal-error / INTERNAL
```

- [ ] Combine the caller signal and absolute deadline into one `AbortSignal`. Reject a deadline already in the past before resolution. Preserve whether the source was caller cancellation or deadline so the canonical code is correct.

- [ ] Build events with a configured ID factory or `crypto.randomUUID`, and a configured clock or `new Date().toISOString()`. Validate the configured source as an absolute URI.

- [ ] Make lifecycle delivery best-effort: await the sink, catch its rejection, and report it only through an optional configuration callback:

```ts
readonly onLifecycleDeliveryError?: (
  error: unknown,
  event: EvaluationLifecycleEventV1,
) => void;
```

Lifecycle delivery failure must not alter evaluator invocation, claim issuance, the receipt, or a primary failure.

- [ ] Ensure events carry only attempt ID, progress phase/detail, final receipt, or safe failure. Trace Context never enters `PrepareResultEvaluationInput`.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/errors.test.ts src/lifecycle.test.ts
yarn typecheck
git diff --check
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner/src
git commit -m "feat(evaluation): standardize runner operations"
```

## Task 9: Compose the Happy-Path Evaluation Runner

**Files:**

- Create: `packages/evidence/evaluation-runner/src/runner.test.ts`
- Create: `packages/evidence/evaluation-runner/src/runner.ts`
- Modify: `packages/evidence/evaluation-runner/src/index.ts`

**Interfaces:**

- Consumes: every port and primitive implemented in Tasks 2–8, plus public Attestation Issuer `prepareResultEvaluation`, `parsePreparedAttestation`, and `commitPreparedAttestation`.
- Produces:

```ts
export interface EvaluationRunOptions {
  readonly delivery: "initial" | "recovery";
  readonly signal?: AbortSignal;
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface EvaluationRunner {
  run(
    request: EvaluationRequestV1,
    options: EvaluationRunOptions,
  ): Promise<EvaluationReceiptV1>;
}

export function createEvaluationRunner(
  configuration: EvaluationRunnerConfiguration,
): EvaluationRunner;
```

- [ ] Write one end-to-end test for each completed verdict using:

  - `InMemoryEvaluationMaterialResolver`;
  - `InMemoryEvaluationAttemptCheckpointStore`;
  - `InMemoryEvidenceRepository`;
  - a deterministic test signer;
  - a static evaluator registration;
  - an explicitly configured standard specification.

Assert exact Task, ordered Results, specification, method, evaluator, outcome evidence, verdict, receipt, event order, and all three checkpoint transitions.

- [ ] Add a joint multi-Result test proving one request creates one claim covering every ordered Result. Add a separate test proving independent requests create independent attempt IDs and records.

- [ ] Add a signer-separation test: use an evaluator Agent IRI and a different DSSE `keyid`, prove both exact values survive in their own protocol locations, and prove the receipt claims no identity binding.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/runner.test.ts
```

Expected: failure because `createEvaluationRunner` does not exist.

- [ ] Validate and freeze configuration at construction:

  - reject duplicate registrations;
  - require positive safe-integer limits;
  - validate an optional default descriptor;
  - validate lifecycle source;
  - copy registration and configuration arrays;
  - retain capabilities, never credential bytes.

- [ ] Implement the no-checkpoint path in this exact order:

```text
normalize request and resolve explicit default
compute effective request digest
load checkpoint
emit started
emit progress(resolving)
resolve Task, Results, specification, method, context, relationships
check specification compatibility
emit progress(evaluating)
invoke adapter
normalize and validate output
resolve evaluator identity
validate supersession continuity
resolve existing outcome evidence
emit progress(checkpointing)
save completed-outcome checkpoint
emit progress(storing-evidence)
store new evidence and collect descriptors/receipts
emit progress(issuing)
prepare Result Evaluation with Attestation Issuer
save exact prepared-attestation checkpoint
commit the same prepared bytes with Attestation Issuer
create and save receipt checkpoint
emit completed
return receipt
```

- [ ] Build `PrepareResultEvaluationInput` only from Runner-controlled bindings:

```ts
const issuerInput: PrepareResultEvaluationInput = {
  task: request.task,
  results: request.results,
  evaluator: outcome.evaluator,
  evaluatedAt: outcome.evaluatedAt,
  verdict: outcome.verdict,
  evaluationSpecification: outcome.specification,
  evaluationMethod: outcome.evaluationMethod,
  measurements: outcome.measurements,
  evidence: storedEvidence.descriptors,
  explanation: outcome.explanation,
  limitations: outcome.limitations,
  supersedes: request.supersedes,
  disputes: request.disputes,
};
```

Do not forward request `extensions` into the signed predicate in v1; they are operational inputs only.

- [ ] Checkpoint `prepared.envelopeBytes` exactly before commit. Reconstruct a prepared value on later paths only with public `parsePreparedAttestation`; do not re-sign.

- [ ] Verify Attestation Issuer commit receipt family, record digest, reference, size, and status before constructing `EvaluationReceiptV1`.

- [ ] Use `completedAt` from the configured clock after the repository commit. Do not copy verdict, subjects, identity, specification, method, or trust statements into the receipt.

- [ ] Catch the outer operation exactly once. Emit `canceled` only for explicit caller cancellation, emit `failed` for deadline expiry and other failures, then reject with `EvaluationRunnerError`. Never emit both.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/runner.test.ts
yarn typecheck
yarn build
git diff --check
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner/src
git commit -m "feat(evaluation): compose result evaluation runner"
```

## Task 10: Enforce Recovery, Interruption, and Commit-Race Semantics

**Files:**

- Create: `packages/evidence/evaluation-runner/src/runner.recovery.test.ts`
- Modify: `packages/evidence/evaluation-runner/src/runner.ts`
- Modify: `packages/evidence/evaluation-runner/src/checkpoints.ts`
- Modify: `packages/evidence/evaluation-runner/src/errors.ts`

**Interfaces:**

- Consumes: `EvaluationRunOptions.delivery`, the loaded checkpoint stage, registration interruption behavior, exact checkpointed bytes, and content-addressed repository behavior.
- Produces: stage-specific resume paths that never repeat evaluator work after outcome checkpointing and never re-sign after prepared-attestation checkpointing.

- [ ] Write a recovery matrix before changing the Runner:

| Loaded checkpoint | Delivery | Interruption behavior | Adapter call | Signer call | Repository commit |
|---|---|---|---:|---:|---:|
| receipt | either | any | 0 | 0 | 0 |
| prepared-attestation | either | any | 0 | 0 | 1 |
| completed-outcome | either | any | 0 | 1 | 1 |
| none | initial | any | 1 | 1 | 1 |
| none | recovery | repeatable | 1 | 1 | 1 |
| none | recovery | recoverable | 1 | 1 | 1 |
| none | recovery | nonrepeatable | 0 | 0 | 0 |

The recoverable adapter receives `delivery: "recovery"` and the same `attemptId`; its registered provider logic retrieves the prior provider result.

- [ ] Add tests for every row and assert exact call counts.

- [ ] Add interruption tests immediately:

  - before completed-outcome save;
  - after completed-outcome save;
  - before prepared-attestation save;
  - after prepared-attestation save;
  - after repository commit but before receipt save;
  - after receipt save but before return.

- [ ] Add “save then lose response” fault tests for all three checkpoint saves. On the next invocation, `load` must reveal the durable stage and prevent repeated earlier work.

- [ ] Add idempotent commit tests for both repository statuses: the first commit returns `created`; a retry of the same prepared bytes returns `existing` with the same record digest.

- [ ] Add cancellation tests during resolution, evaluation, checkpointing, evidence storage, signing, and repository commit.

- [ ] Add the commit race test: when repository commit returns successfully and cancellation is observed immediately afterward, the Runner must finish receipt checkpointing and return completed. The immutable record is authoritative.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/runner.recovery.test.ts
```

Expected: the new resume and recovery tests fail.

- [ ] Make `delivery` mandatory so the host explicitly identifies first delivery versus recovery. When no checkpoint exists:

  - `initial` invokes every registration once;
  - `recovery + repeatable` invokes again with the same attempt ID;
  - `recovery + recoverable` invokes the adapter with recovery delivery;
  - `recovery + nonrepeatable` fails with `completion-state-unknown`,
    `FAILED_PRECONDITION`, and `new-attempt-required`.

- [ ] If a completed-outcome checkpoint exists, decode and revalidate it, re-resolve every existing evidence descriptor, store or re-store new evidence, prepare once in that invocation, and save the resulting exact envelope. Do not call the evaluator or outcome validator again.

- [ ] If a prepared-attestation checkpoint exists:

  - decode exact envelope bytes;
  - verify its stored digest;
  - call public `parsePreparedAttestation`;
  - require family `result-evaluation`;
  - commit that exact parsed value;
  - do not call the evaluator, outcome validator, identity resolver, evidence writer, or signer.

- [ ] If a receipt checkpoint exists, validate and return its exact receipt without calling any injected capability except lifecycle delivery.

- [ ] Never internally retry the evaluator, signer, checkpoint store, or repository in one invocation. Retry authority remains with the host.

- [ ] Document the narrow signing uncertainty explicitly in code comments and README: if a process is lost after a signer side effect but before the prepared checkpoint becomes durable, the host must not blindly resubmit that same attempt. It closes the attempt as `completion-state-unknown` unless its durable workflow or signing service can prove and recover the exact prepared bytes.

- [ ] After a successful repository response, use a non-aborted finalization signal for the receipt checkpoint. A receipt-checkpoint failure reports `receipt-checkpoint-failed` with `operator-action-required`; recovery from the prepared checkpoint must reconcile the committed record.

- [ ] Add a regression proving a failed or canceled operation has no `EvaluationReceiptV1`, while a successful commit race has no canceled event.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/runner.recovery.test.ts src/runner.test.ts
yarn typecheck
git diff --check
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner/src
git commit -m "feat(evaluation): enforce runner recovery semantics"
```

## Task 11: Integrate Supersession, Dispute, and Dynamic Identity Flows

**Files:**

- Create: `packages/evidence/evaluation-runner/src/runner.relationships.test.ts`
- Modify: `packages/evidence/evaluation-runner/src/runner.ts`
- Modify: `packages/evidence/evaluation-runner/src/relationships.ts`
- Modify: `packages/evidence/evaluation-runner/src/identity.ts`

**Interfaces:**

- Consumes: request `supersedes` and `disputes`, resolved conforming prior evaluations, authenticated adapter context, and optional continuity authority.
- Produces: Result Evaluations with exact append-only relationship descriptors and correctly controlled evaluator identity.

- [ ] Write end-to-end tests for:

  - a static evaluator superseding its own prior claim;
  - dynamic authenticated human identity superseding its own prior claim;
  - changed evaluator IRI accepted by an injected continuity authority;
  - changed evaluator IRI rejected without authority;
  - a different evaluator disputing a prior claim;
  - a prior claim with the wrong exact Task;
  - a prior claim with missing, extra, or digest-mismatched Results;
  - a malformed or unavailable relationship target;
  - a request trying to inject evaluator identity in `extensions`;
  - an adapter returning an arbitrary evaluator IRI outside authenticated context.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/runner.relationships.test.ts
```

Expected: relationship integration tests fail.

- [ ] Resolve all relationship descriptors in the initial resolution phase. Validate protocol conformance and exact subjects before evaluator work to avoid spending evaluator resources on an invalid request.

- [ ] Resolve static identity before evaluator work. Resolve dynamic identity only after a structurally valid adapter output provides registration-owned authenticated context.

- [ ] Apply supersession continuity after dynamic identity resolution but before the completed-outcome checkpoint. This ensures the checkpoint contains the final trusted evaluator IRI.

- [ ] Pass the original exact `supersedes` and `disputes` descriptors to Attestation Issuer. Do not replace them with repository lookup references or mutable parsed claims.

- [ ] Prove the earlier record remains retrievable and unchanged after both supersession and dispute. The Runner must not hide, mutate, delete, rank, or select a winner.

- [ ] Prove relationship conformance does not call `verifyDsseSignatures` and does not make trust claims in either receipt or events.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/runner.relationships.test.ts \
  src/relationships.test.ts src/identity.test.ts
yarn typecheck
git diff --check
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner/src
git commit -m "feat(evaluation): integrate corrections and disputes"
```

## Task 12: Publish Reusable Testing Contracts and Integration Fixtures

**Files:**

- Create: `packages/evidence/evaluation-runner/src/testing/evaluator-contract.ts`
- Create: `packages/evidence/evaluation-runner/src/testing/fixtures.ts`
- Create: `packages/evidence/evaluation-runner/src/runner.integration.test.ts`
- Modify: `packages/evidence/evaluation-runner/src/testing.ts`
- Create: `packages/evidence/evaluation-runner/fixtures/runner-contract-v1/README.md`
- Create: `packages/evidence/evaluation-runner/fixtures/runner-contract-v1/evaluation-request.json`
- Create: `packages/evidence/evaluation-runner/fixtures/runner-contract-v1/completed-receipt.json`
- Create: `packages/evidence/evaluation-runner/fixtures/runner-contract-v1/failure.json`
- Create: `packages/evidence/evaluation-runner/fixtures/runner-contract-v1/lifecycle-event.json`
- Create: `packages/evidence/evaluation-runner/fixtures/runner-contract-v1/standard-task-satisfaction-specification.json`
- Create: `packages/evidence/evaluation-runner/fixtures/runner-contract-v1/model-request.json`
- Create: `packages/evidence/evaluation-runner/fixtures/runner-contract-v1/human-request.json`
- Create: `packages/evidence/evaluation-runner/fixtures/runner-contract-v1/private-request.json`
- Create: `packages/evidence/evaluation-runner/src/fixtures.test.ts`

**Interfaces:**

- Consumes: third-party evaluator registrations or host Runner factories.
- Produces: `describeEvaluatorRegistrationContract`,
  `describeEvaluationRunnerHostContract`, in-memory ports, deterministic fixtures, and portable JSON examples.

- [ ] Define the evaluator contract factory:

```ts
export interface EvaluatorRegistrationContractContext {
  readonly registration: EvaluatorRegistration;
  readonly supportedInput: EvaluationAdapterInput;
  readonly unsupportedSpecification: ResolvedEvaluationMaterial;
  readonly expectedVerdict: EvaluationVerdict;
  readonly cleanup?: () => Promise<void> | void;
}

export type EvaluatorRegistrationContractFactory = (
  testName: string,
) =>
  | EvaluatorRegistrationContractContext
  | Promise<EvaluatorRegistrationContractContext>;

export function describeEvaluatorRegistrationContract(
  name: string,
  createContext: EvaluatorRegistrationContractFactory,
): void;
```

- [ ] Make the contract kit verify compatibility before work, exact immutable inputs, deadline/signal propagation, declared interruption behavior, valid outcome structure, byte stability, trusted dynamic identity path, and inability to override authority-bearing bindings.

- [ ] Define the host contract factory:

```ts
export interface EvaluationRunnerHostContractContext {
  readonly runner: EvaluationRunner;
  readonly request: EvaluationRequestV1;
  readonly repository: EvidenceRepository;
  readonly checkpoints: EvaluationAttemptCheckpointStore;
  readonly inspectAdapterCalls: () => number;
  readonly inspectSignerCalls: () => number;
  readonly cleanup?: () => Promise<void> | void;
}

export type EvaluationRunnerHostContractFactory = (
  testName: string,
) =>
  | EvaluationRunnerHostContractContext
  | Promise<EvaluationRunnerHostContractContext>;

export function describeEvaluationRunnerHostContract(
  name: string,
  createContext: EvaluationRunnerHostContractFactory,
): void;
```

- [ ] Make the host kit verify one committed claim, exact subjects, three durable stages, receipt recovery, idempotent commit, no repeated evaluator after outcome checkpoint, and no repeated signer after prepared checkpoint.

- [ ] Write integration tests with test-only adapters representing:

  - deterministic test evaluation;
  - normalized model response;
  - authenticated human review;
  - delayed recoverable provider;
  - private evaluation with no publication call;
  - marketplace host metadata remaining outside evidence;
  - benchmark host metadata remaining outside evidence;
  - plugin/local host composition;
  - third-party registration;
  - interrupted issuance.

These are compatibility scenarios, not a Runner `evaluationType` enum.

- [ ] Add hostile fixtures for prompt-injection text, malformed model output, mutable material, oversized findings, unsafe names, provider crash, repeated lifecycle events, and stale checkpoint writes.

- [ ] Generate portable JSON fixtures from normalized values and pin exact expected digests. Validate request, failure, receipt, event, and checkpoint examples with the exported JSON Schemas.

- [ ] Prove the private fixture produces only repository writes and a receipt. It must contain no publication candidate, exposure classification, contribution, marketplace acceptance, or public URL field.

- [ ] Prove optional evaluator Execution is just one exact existing evidence descriptor and that wall time, tokens, and cost are absent from Result Evaluation unless the selected specification explicitly defines them as conclusion measurements.

- [ ] Run:

```bash
cd packages/evidence/evaluation-runner
yarn test src/fixtures.test.ts src/runner.integration.test.ts
yarn typecheck
git diff --check
```

Expected: all commands pass.

- [ ] Commit:

```bash
git add packages/evidence/evaluation-runner/src \
  packages/evidence/evaluation-runner/fixtures
git commit -m "test(evaluation): publish runner contract kit"
```

## Task 13: Complete Documentation, Packing, and Evidence CI

**Files:**

- Create: `packages/evidence/evaluation-runner/README.md`
- Create: `packages/evidence/evaluation-runner/scripts/pack-smoke.mjs`
- Modify: `.github/scripts/evidence-packed-types.test.mjs`
- Modify: `.github/workflows/evidence-ci.yml`
- Add unchanged: `docs/superpowers/specs/2026-07-26-evaluation-runner-design.md`

**Interfaces:**

- Consumes: packed Protocol, Repository, Attestation Issuer, and Runner archives.
- Produces: documented public usage, verified package shape, compiled consumer entrypoints, and an ordered CI stage.

- [ ] Write the README with:

  - the Runner/host/adapter/provider/issuer ownership table;
  - one static deterministic registration example;
  - one dynamic human identity example;
  - explicit standard-specification activation and resolver seeding;
  - initial versus recovery invocation;
  - production lease and checkpoint requirements;
  - failure versus verdict explanation;
  - private evidence explanation;
  - optional evaluator Execution capture;
  - correction/dispute behavior;
  - trust and signature-verification non-goals;
  - the signing/checkpoint uncertainty warning from Task 10.

- [ ] Add this minimal usage shape without provider-specific code:

```ts
const runner = createEvaluationRunner({
  materialResolver,
  checkpointStore,
  evidenceRepository,
  evaluatorRegistrations: [registration],
  defaultSpecification:
    STANDARD_TASK_SATISFACTION_SPECIFICATION_V1.descriptor,
  claimEvidenceLimits: {
    maxNewArtifacts: 16,
    maxArtifactBytes: 10 * 1024 * 1024,
    maxTotalArtifactBytes: 40 * 1024 * 1024,
  },
  lifecycle: {
    source: "https://worker.example/evaluation-runner",
    sink: lifecycleSink,
  },
});

const receipt = await runner.run(request, { delivery: "initial" });
```

- [ ] Write `pack-smoke.mjs` to:

  - pack Protocol, Repository, Attestation Issuer, and Runner;
  - assert root, `/schemas`, and `/testing` JS and declaration files exist;
  - assert every raw schema and contract fixture exists;
  - reject leaked `*.test.*` and `*.spec.*`;
  - install all four archives into a temporary consumer;
  - import all three Runner code entrypoints;
  - validate a fixture through an exported schema;
  - run both testing-contract exports;
  - assert only the three approved Jinn runtime dependencies;
  - assert Vitest is an optional peer.

- [ ] Run the smoke script before CI wiring:

```bash
cd packages/evidence/evaluation-runner
yarn build
yarn check:schemas
yarn pack:smoke
```

Expected: all commands pass.

- [ ] Add the Runner to the packed package list and add these code entrypoints:

```js
'@jinn-network/evaluation-runner',
'@jinn-network/evaluation-runner/schemas',
'@jinn-network/evaluation-runner/testing',
```

Change the packed-consumer completion message from ten to eleven evidence packages.

- [ ] Add the design document to Evidence CI path filters.

- [ ] Do not put the Runner into the existing `components` matrix because it depends on the Attestation Issuer distribution produced there. Add a dedicated job:

```yaml
  evaluation-runner:
    name: Evaluation Runner
    needs: [foundation, components]
    runs-on: ubuntu-latest
```

The job restores Protocol, Repository, and Attestation Issuer distributions, installs their packed-smoke toolchains, then runs:

```bash
cd packages/evidence/evaluation-runner
yarn install --immutable
yarn check:schemas
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

Upload `packages/evidence/evaluation-runner/dist` as
`evidence-evaluation-runner-dist`.

- [ ] Add `evaluation-runner` to the `verify.needs` list, result assertion, downloaded distribution placement loop, and packed type compilation.

- [ ] Run repository guards and the package suite:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
cd packages/evidence/evaluation-runner
yarn check:schemas
yarn typecheck
yarn test
yarn build
yarn pack:smoke
cd ../../..
node .github/scripts/evidence-packed-types.test.mjs
```

Expected: every command passes.

- [ ] Commit:

```bash
git add .github/scripts/evidence-packed-types.test.mjs \
  .github/workflows/evidence-ci.yml \
  docs/superpowers/specs/2026-07-26-evaluation-runner-design.md \
  packages/evidence/evaluation-runner
git commit -m "docs(evaluation): ship runner package contract"
```

## Task 14: Perform Spec Coverage, Boundary, and Final Verification

**Files:**

- Review: `packages/evidence/evaluation-runner/**`
- Review: `.github/scripts/evidence-package-inventory.test.mjs`
- Review: `.github/scripts/evidence-source-boundaries.test.mjs`
- Review: `.github/scripts/evidence-packed-types.test.mjs`
- Review: `.github/workflows/evidence-ci.yml`
- Review: `docs/superpowers/specs/2026-07-26-evaluation-runner-design.md`

**Interfaces:**

- Consumes: the completed implementation and approved design.
- Produces: a verified, review-ready branch with no placeholder behavior or untested ownership escape.

- [ ] Use `superpowers:verification-before-completion` before making any completion claim.

- [ ] Build a design coverage table in the review notes and verify every section:

| Design concern | Required evidence |
|---|---|
| Result Evaluation only | no Execution Verification API or issuer call |
| method-neutral | no mode/category enum; compatibility scenarios only |
| exact inputs | digest, order, immutability, and substitution tests |
| explicit specification | request/default precedence and no silent standard |
| registration authority | method, identity, signer, validator fixed by host |
| checkpoint recovery | outcome, prepared bytes, receipt, CAS, call-count tests |
| failure taxonomy | all phases, codes, reasons, safe serialization |
| lifecycle | CloudEvents envelopes and authoritative receipt behavior |
| rich findings | deterministic exact artifact |
| selected evidence only | storage allowlist and hostile-output tests |
| corrections/disputes | conforming exact subjects and identity continuity |
| trust separation | no signature-verification or trust gate |
| privacy/publication | no publication labels, calls, or implications |
| evaluator Execution | optional exact supporting descriptor only |

- [ ] Scan for placeholders and accidental authority:

```bash
rg -n '\b(TODO|TBD|FIXME|XXX)\b|not implemented|NotImplementedError|NOT_IMPLEMENTED' \
  packages/evidence/evaluation-runner
rg -n 'evaluationType|evaluationMode|publish|contribution|marketplace|wallet|verifyDsseSignatures|fetch|WebSocket|EventSource|XMLHttpRequest' \
  packages/evidence/evaluation-runner/src
```

Expected: no placeholder hits. Any architectural word hit must be confined to a negative test or explanatory documentation and reviewed manually.

- [ ] Check all imports and dependency declarations:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
```

Expected: both pass.

- [ ] Run the complete package verification from a clean install:

```bash
cd packages/evidence/evaluation-runner
corepack yarn@4.13.0 install --immutable
yarn check:schemas
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

Expected: every command exits `0`.

- [ ] Run packed cross-package type verification:

```bash
cd ../../..
node .github/scripts/evidence-packed-types.test.mjs
```

Expected: the consumer compiles all public entrypoints across eleven evidence packages.

- [ ] Check diff quality and test leakage:

```bash
git diff f65880c4e244e32334f0fed98bf00ff9b307e87d...HEAD --check
git diff --stat f65880c4e244e32334f0fed98bf00ff9b307e87d...HEAD
git status --short
```

Expected: no whitespace errors, only planned files, and a clean worktree.

- [ ] Review the public declarations in the packed tarball. Confirm no internal helpers, test-only types, concrete bindings, provider details, or credentials are exported.

- [ ] Request code review with `superpowers:requesting-code-review`, address only verified findings, and rerun the complete verification suite after any change.

- [ ] Commit review-driven corrections only if needed:

```bash
git add packages/evidence/evaluation-runner .github docs/superpowers/specs
git commit -m "fix(evaluation): address runner review findings"
```

- [ ] Record the final test commands and exact passing output in the handoff. Do not claim deployment, publication, marketplace acceptance, or protocol change.
