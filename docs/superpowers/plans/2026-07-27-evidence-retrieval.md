# Evidence Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@jinn-network/evidence-retrieval`, a host-neutral, in-process application library that turns known references or provider-owned candidate queries into exact, digest-verified, Protocol-conforming Evidence results with explicit provenance, artifact state, bounded failures, and replay metadata.

**Architecture:** The package is a thin orchestration layer over the existing Evidence Protocol, Repository, and Discovery contracts. Candidate providers retain their own query types, stores, indexes, ranking, cursors, checkpoints, and combination logic; Retrieval preserves their ordering and provenance while owning canonical deduplication, bounded location fallback, exact-byte verification, family validation, optional artifact hydration, and typed outcomes. The Jinn Plugin remains a host and consumer; its legacy CID-oriented `CorpusPort` is not changed in this plan because a separate provider adapter must first emit canonical `EvidenceRecordReference` values.

**Tech Stack:** Node.js >=22, TypeScript 5.9.3 in strict ESM mode, Yarn 4.13.0, Vitest 4.1.8, `@jinn-network/evidence-protocol` 0.1.0, `@jinn-network/evidence-repository` 0.1.0, and the root contracts from `@jinn-network/evidence-discovery` 0.1.0.

## Global Constraints

- Start from the recorded Evidence integration head `f65880c4e244e32334f0fed98bf00ff9b307e87d` on `integration/evidence-v1`, or a descendant containing that exact commit. If that commit is absent or the package graph has changed incompatibly, stop and re-audit the contracts before editing.
- Create one package at `packages/evidence/retrieval` named `@jinn-network/evidence-retrieval`; publish only `.` and `./testing`.
- Production dependencies are exactly `@jinn-network/evidence-protocol`, `@jinn-network/evidence-repository`, and `@jinn-network/evidence-discovery`.
- The root package must not import a search engine, vector database, embedding runtime, concrete Catalog store, concrete Repository binding, plugin, marketplace, Autopilot, network client, filesystem API, or ambient network API.
- Retrieval is read-only. It must not write Protocol records, Repository objects, Catalog projections, indexes, announcements, checkpoints, saved queries, datasets, or caches.
- `retrieve(reference)` never invokes a candidate source. `query(candidateSource, sourceQuery)` passes the provider-owned query through without interpreting or translating it.
- There is no retrieval-method enum, universal query language, default rank fusion, generic relevance score, local/public mode, trust score, or corpus-membership authority.
- The host configures all candidate stores and repository bindings. A federated source invokes every configured child source and never discovers or contacts an unconfigured source.
- A candidate becomes a normal result only after exact bytes are re-fetched, bounded, SHA-256 matched to the canonical reference, and accepted by the existing family-specific Protocol validator.
- Provider scores, snippets, projections, locations, and extensions remain untrusted provenance; they never alter identity, conformance, trust, or acceptance.
- `resultLimit` counts validated results. `candidateBudget` counts candidate observations examined, including duplicates, unavailable records, nonconforming records, and acceptance rejections.
- Ranking and combined ordering belong to the candidate provider. Retrieval preserves provider order, deduplicates exact `{family,digest}` references, and retains every contributing observation.
- Local and public stores use identical retrieval and validation semantics. Local/public is provenance or topology, never relevance, trust, or validation policy.
- No artifact bytes are fetched by default. Requested artifacts are independently bounded and reported as `verified`, `not-requested`, `unavailable`, `access-denied`, `integrity-mismatch`, `too-large`, or `timed-out`.
- A corrupt or nonconforming record copy at one allowed location does not block bounded fallback to another allowed location.
- Expected source, record, acceptance, location, and artifact failures are typed values. Invalid construction and invalid operation input throw a typed `EvidenceRetrievalError`.
- Every operation has a default deadline and bounded candidates, metadata, locations, records, artifacts, concurrency, and diagnostics. Cancellation propagates into every injected port.
- Default telemetry contains classifications, counts, byte totals, identities, and durations only. It must not contain raw queries, snippets, projections, record bytes, artifact bytes, prompts, credentials, signed URLs, or private locators.
- Saved-query envelopes are versioned values, not persistence. Provider codecs own query encoding, decoding, validation, and migration. Cursors are not checkpoints, and timestamps do not freeze membership.
- Protocol relationships are preserved in validated records. Retrieval does not expand, adjudicate, rank, trust, or generate verdicts from them.
- `KnowledgeHit`, `CorpusRecord`, `KnowledgePacket`, prompt construction, and UI projection remain outside this package.
- Use TDD for every behavior: observe the named failure, implement the smallest coherent change, run the focused test, then run the package suite before committing.

---

## Execution Baseline

Use an isolated worktree created with `superpowers:using-git-worktrees`. Establish the reviewed base before Task 1:

```bash
git cat-file -e f65880c4e244e32334f0fed98bf00ff9b307e87d^{commit}
git merge-base --is-ancestor f65880c4e244e32334f0fed98bf00ff9b307e87d HEAD
git status --short
```

Expected: the commit check succeeds and the new worktree is clean. If the worktree contains unrelated changes, preserve them and choose another isolated worktree.

Before each commit, run the focused test named by the task. Before the final handoff, run:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
cd packages/evidence/retrieval
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
cd ../../..
node .github/scripts/evidence-packed-types.test.mjs
```

Expected: every command exits 0, and the packed-types script reports 21 public entrypoints across 11 Evidence packages.

## Scope Boundary

This plan produces a complete, independently usable Retrieval library, reusable contract tests, package documentation, architecture guards, and consumer-shaped integration scenarios.

It deliberately does not modify `packages/plugin`, `packages/layer`, or `CorpusPort`. Today that path searches legacy corpus entries whose `ref` values may be CIDs rather than `EvidenceRecordReference` objects. Treating a CID as a Retrieval record reference would create a second identity system and bypass the approved candidate contract. After a plugin candidate adapter exists that searches all host-configured stores and emits canonical references, write a separate plugin migration plan that replaces the `CorpusPort.search/get` orchestration while retaining plugin-owned ranking and `KnowledgePacket` construction.

## File Map

| File | Responsibility |
| --- | --- |
| `packages/evidence/retrieval/src/contracts.ts` | Public ports, value types, outcomes, limits, diagnostics, telemetry, saved-query, and snapshot types |
| `packages/evidence/retrieval/src/errors.ts` | Typed construction/input errors and safe expected-failure factories |
| `packages/evidence/retrieval/src/operation.ts` | Hard-limit merging, deadline/cancellation propagation, byte accounting, and bounded concurrency |
| `packages/evidence/retrieval/src/validation.ts` | Record-reference parsing, digest verification, and family-specific Protocol validation |
| `packages/evidence/retrieval/src/resolution.ts` | Locator invocation, host-policy selection, resolver use, bounded location fallback, and availability diagnostics |
| `packages/evidence/retrieval/src/declared-artifacts.ts` | Family-specific extraction of declared artifact identities and roles from validated records |
| `packages/evidence/retrieval/src/artifacts.ts` | Explicit selection, repository reads, integrity checks, limits, and artifact completeness |
| `packages/evidence/retrieval/src/candidates.ts` | Provider-page validation, canonical grouping, order preservation, metadata bounds, and cursor checks |
| `packages/evidence/retrieval/src/federation.ts` | Bounded fan-out to every configured child source with caller-supplied combined ordering |
| `packages/evidence/retrieval/src/saved-query.ts` | Deterministic saved-query envelopes, provider codec matching, digests, and snapshot receipts |
| `packages/evidence/retrieval/src/retrieval.ts` | `createEvidenceRetrieval`, known-reference orchestration, candidate over-fetch, acceptance, outcomes, and telemetry |
| `packages/evidence/retrieval/src/index.ts` | Root public exports only |
| `packages/evidence/retrieval/src/testing/fixtures.ts` | Synthetic repositories, locators, policies, providers, and Protocol fixture loading |
| `packages/evidence/retrieval/src/testing/candidate-source-contract.ts` | Reusable candidate-provider conformance harness |
| `packages/evidence/retrieval/src/testing/retrieval-contract.ts` | Reusable Retrieval scenario harness |
| `packages/evidence/retrieval/src/testing.ts` | `./testing` exports only |
| `packages/evidence/retrieval/src/test-support.ts` | Package-internal test builders and spies; excluded from the production build |
| `packages/evidence/retrieval/src/*.test.ts` | Focused unit and integration coverage beside each responsibility |
| `packages/evidence/retrieval/README.md` | Host/provider/consumer usage, security boundary, and non-goals |
| `packages/evidence/retrieval/specification.md` | Package-level normative behavior distilled from the approved design |
| `packages/evidence/retrieval/scripts/pack-smoke.mjs` | Installed-consumer smoke test for root and `./testing` entrypoints |
| `.github/scripts/evidence-package-inventory.test.mjs` | Eleven-package inventory and approved dependency graph |
| `.github/scripts/evidence-source-boundaries.test.mjs` | Retrieval dependency, I/O, concrete-binding, and consumer-boundary canaries |
| `.github/scripts/evidence-packed-types.test.mjs` | Packed TypeScript consumer for all 21 public Evidence entrypoints |
| `.github/workflows/evidence-ci.yml` | Dedicated Retrieval build/test/pack job and final distribution verification |

### Task 1: Register and Scaffold the Retrieval Package

**Files:**

- Modify: `.github/scripts/evidence-package-inventory.test.mjs`
- Create: `packages/evidence/retrieval/package.json`
- Create: `packages/evidence/retrieval/.yarnrc.yml`
- Create: `packages/evidence/retrieval/.gitignore`
- Create: `packages/evidence/retrieval/tsconfig.json`
- Create: `packages/evidence/retrieval/tsconfig.build.json`
- Create: `packages/evidence/retrieval/src/index.ts`
- Create: `packages/evidence/retrieval/src/testing.ts`
- Create: `packages/evidence/retrieval/README.md`
- Create: `packages/evidence/retrieval/specification.md`
- Create: `packages/evidence/retrieval/scripts/pack-smoke.mjs`
- Create: `packages/evidence/retrieval/yarn.lock` via Yarn

**Interfaces:**

- Consumes: the explicit Evidence package inventory and portal-resolution rules.
- Produces: package `@jinn-network/evidence-retrieval@0.1.0`, root export `.`, testing export `./testing`, and exact production dependency portals to Protocol, Repository, and Discovery.

- [ ] **Step 1: Make the package inventory test expect Retrieval**

Add the package tuple after Discovery:

```js
['retrieval', '@jinn-network/evidence-retrieval'],
```

Add this dependency-graph entry:

```js
['retrieval', {
  dependencies: [
    '@jinn-network/evidence-discovery',
    '@jinn-network/evidence-protocol',
    '@jinn-network/evidence-repository',
  ],
  devDependencies: [],
  optionalDependencies: [],
  peerDependencies: [],
}],
```

Rename the inventory test to `the evidence package inventory is explicit and has eleven manifests`, change its length assertion from `10` to `11`, and replace the final peer assertion with:

```js
test('testing entrypoints declare Vitest as an exact optional peer', () => {
  for (const directory of ['derivation', 'retrieval']) {
    const manifest = readPackage(directory);
    assert.deepEqual(manifest.peerDependencies, { vitest: '^4.1.8' });
    assert.deepEqual(manifest.peerDependenciesMeta, {
      vitest: { optional: true },
    });
  }
});
```

- [ ] **Step 2: Run the inventory test and observe the missing package**

Run:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
```

Expected: FAIL with `missing package manifest` for `packages/evidence/retrieval/package.json`.

- [ ] **Step 3: Create the package manifest and compiler configuration**

Create `packages/evidence/retrieval/package.json`:

```json
{
  "name": "@jinn-network/evidence-retrieval",
  "version": "0.1.0",
  "description": "Bounded exact-byte retrieval and validation for Jinn Evidence.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/evidence/retrieval"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./testing": {
      "import": "./dist/testing.js",
      "types": "./dist/testing.d.ts"
    }
  },
  "files": [
    "dist/",
    "README.md",
    "specification.md"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/evidence-discovery": "0.1.0",
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
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/evidence-discovery": "portal:../discovery",
    "@jinn-network/evidence-protocol": "portal:../protocol",
    "@jinn-network/evidence-repository": "portal:../repository"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022", "DOM"],
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

Create `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts", "src/test-support.ts"]
}
```

Create `.yarnrc.yml`:

```yaml
nodeLinker: node-modules
```

Create `.gitignore`:

```gitignore
.yarn/
dist/
node_modules/
*.tgz
```

Create both `src/index.ts` and `src/testing.ts` with `export {};`. Create `README.md` with the package name, a one-paragraph ownership boundary, and a link to `specification.md`. Create `specification.md` with the approved operations, invariants, typed failure classes, and explicit non-goals copied from `docs/superpowers/specs/2026-07-26-evidence-retrieval-design.md`.

Create a real initial `scripts/pack-smoke.mjs` that builds and packs the package and asserts the two distribution entrypoints exist:

```js
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evidence-retrieval-"));
const archive = join(temporaryRoot, "evidence-retrieval.tgz");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

try {
  await run("yarn", ["pack", "--out", archive], {
    cwd: new URL("..", import.meta.url),
  });
  await run("tar", [
    "-tzf",
    archive,
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/testing.js",
    "package/dist/testing.d.ts",
  ]);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
```

- [ ] **Step 4: Generate the lockfile and verify the package scaffold**

Run:

```bash
cd packages/evidence/retrieval
yarn install
yarn typecheck
yarn build
yarn pack:smoke
cd ../../..
node --test .github/scripts/evidence-package-inventory.test.mjs
```

Expected: all commands PASS. Confirm `yarn.lock` pins Yarn 4-compatible dependency state and does not introduce another Jinn production dependency.

- [ ] **Step 5: Commit the registered package**

```bash
git add .github/scripts/evidence-package-inventory.test.mjs packages/evidence/retrieval
git commit -m "feat(evidence): scaffold retrieval package"
```

### Task 2: Freeze the Public Contract and Typed Error Surface

**Files:**

- Create: `packages/evidence/retrieval/src/contracts.ts`
- Create: `packages/evidence/retrieval/src/errors.ts`
- Create: `packages/evidence/retrieval/src/contracts.test.ts`
- Modify: `packages/evidence/retrieval/src/index.ts`

**Interfaces:**

- Consumes: `ExecutionEvidenceDocument`, `ResultEvaluationEvidence`, `ExecutionVerificationEvidence`, and `ConformanceDiagnostic` from Protocol; record/artifact references and Repository from Repository; `EvidenceRepositoryResolver`, `JsonValue`, and `PublishedEvidenceLocation` from Discovery.
- Produces: every public type used by later tasks, `EVIDENCE_RETRIEVAL_FAILURE_CODES`, `EvidenceRetrievalError`, `createEvidenceRetrievalFailure`, and the `EvidenceRetrieval.retrieve(...)` and `EvidenceRetrieval.query(...)` interface signatures. Task 5 adds the concrete factory.

- [ ] **Step 1: Write compile-time and runtime contract tests**

Create `src/contracts.test.ts`:

```ts
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  EVIDENCE_RETRIEVAL_FAILURE_CODES,
  EvidenceRetrievalError,
  createEvidenceRetrievalFailure,
  type CandidateSource,
  type EvidenceRetrieval,
  type QueryEvidenceInput,
  type ValidatedRecord,
} from "./index.js";

interface KeywordQuery {
  readonly text: string;
}

describe("Evidence Retrieval public contract", () => {
  test("keeps a source query statically paired with its provider", () => {
    expectTypeOf<QueryEvidenceInput<KeywordQuery, { score: number }>>()
      .toHaveProperty("candidateSource")
      .toEqualTypeOf<CandidateSource<KeywordQuery, { score: number }>>();
    expectTypeOf<EvidenceRetrieval["retrieve"]>().toBeFunction();
    expectTypeOf<ValidatedRecord["family"]>().toEqualTypeOf<
      "execution-evidence" | "result-evaluation" | "execution-verification"
    >();
  });

  test("uses stable typed failures without carrying content", () => {
    const failure = createEvidenceRetrievalFailure({
      code: "NO_LOCATION",
      stage: "location",
      message: "No allowed location was observed.",
    });
    expect(EVIDENCE_RETRIEVAL_FAILURE_CODES).toContain(failure.code);
    expect(Object.keys(failure).sort()).toEqual([
      "code",
      "message",
      "retryable",
      "stage",
    ]);
  });

  test("throws one typed error for invalid construction or input", () => {
    const error = new EvidenceRetrievalError(
      "INVALID_INPUT",
      "resultLimit must be a positive integer.",
    );
    expect(error).toMatchObject({
      name: "EvidenceRetrievalError",
      code: "INVALID_INPUT",
    });
  });
});
```

- [ ] **Step 2: Run the contract test and observe missing exports**

Run:

```bash
cd packages/evidence/retrieval
yarn test src/contracts.test.ts
```

Expected: FAIL because `./index.js` does not export the contract types or error values.

- [ ] **Step 3: Add the complete public declarations**

Create `src/contracts.ts`. Keep these names and discriminants stable; later tasks implement their behavior:

```ts
import type {
  ConformanceDiagnostic,
  ExecutionEvidenceDocument,
  ExecutionVerificationEvidence,
  ResultEvaluationEvidence,
} from "@jinn-network/evidence-protocol";
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";
import type {
  EvidenceRepositoryResolver,
  JsonValue,
  PublishedEvidenceLocation,
} from "@jinn-network/evidence-discovery";

export type { EvidenceRecordReference, JsonValue, Sha256Digest };

export type ValidatedRecord =
  | {
      readonly family: "execution-evidence";
      readonly value: ExecutionEvidenceDocument;
    }
  | {
      readonly family: "result-evaluation";
      readonly value: ResultEvaluationEvidence;
    }
  | {
      readonly family: "execution-verification";
      readonly value: ExecutionVerificationEvidence;
    };

export interface CandidateSourceIdentity {
  readonly id: string;
  readonly version: string;
}

export interface CandidateCursor {
  readonly source: CandidateSourceIdentity;
  readonly value: JsonValue;
}

export interface CandidateCheckpoint {
  readonly source: CandidateSourceIdentity;
  readonly value: JsonValue;
  readonly replayable: boolean;
}

export interface RetrievalLocationHint {
  readonly sourceId: string;
  readonly repositoryId: string;
  readonly publishedLocation?: PublishedEvidenceLocation;
}

export interface RetrievalLocationObservation {
  readonly observationId: string;
  readonly sourceId: string;
  readonly status: "available" | "withdrawn";
  readonly repositoryId?: string;
  readonly publishedLocation?: PublishedEvidenceLocation;
}

export interface RetrievalLocationAttempt {
  readonly repositoryId: string;
  readonly observation: RetrievalLocationObservation;
}

export interface CandidateObservation<ProviderData = unknown> {
  readonly source: CandidateSourceIdentity;
  readonly ordinal: number;
  readonly providerData?: ProviderData;
  readonly locationHints: readonly RetrievalLocationHint[];
}

export interface EvidenceCandidate<ProviderData = unknown> {
  readonly reference: EvidenceRecordReference;
  readonly providerData?: ProviderData;
  readonly locationHints?: readonly RetrievalLocationHint[];
}

export interface CandidateSourceIssue {
  readonly code: string;
  readonly message: string;
}

export interface CandidateSourceDiagnostics {
  readonly issues: readonly CandidateSourceIssue[];
}

export interface CandidateSourceReport {
  readonly source: CandidateSourceIdentity;
  readonly status: "complete" | "partial" | "failed";
  readonly candidatesReturned: number;
  readonly checkpoint?: CandidateCheckpoint;
  readonly failure?: EvidenceRetrievalFailure;
}

export interface CandidatePage<ProviderData = unknown> {
  readonly source: CandidateSourceIdentity;
  readonly candidates: readonly EvidenceCandidate<ProviderData>[];
  readonly nextCursor?: CandidateCursor;
  readonly checkpoint?: CandidateCheckpoint;
  readonly sourceReports?: readonly CandidateSourceReport[];
  readonly diagnostics?: CandidateSourceDiagnostics;
}

export interface CandidateSourceOperationOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maximumCandidates: number;
  readonly cursor?: CandidateCursor;
  readonly checkpoint?: CandidateCheckpoint;
}

export interface CandidateSource<Query, ProviderData = unknown> {
  readonly identity: CandidateSourceIdentity;
  find(
    query: Query,
    options: CandidateSourceOperationOptions,
  ): Promise<CandidatePage<ProviderData>>;
}

export interface EvidenceRecordLocator {
  locate(
    reference: EvidenceRecordReference,
    hints: readonly RetrievalLocationHint[],
    options: RetrievalPortOperationOptions,
  ): Promise<readonly RetrievalLocationObservation[]>;
}

export interface EvidenceLocationPolicy {
  select(
    reference: EvidenceRecordReference,
    locations: readonly RetrievalLocationObservation[],
  ): readonly RetrievalLocationAttempt[];
}

export interface RetrievalPortOperationOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maximumLocations: number;
}

export type ArtifactSelector =
  | { readonly kind: "entity-id"; readonly entityId: string }
  | { readonly kind: "digest"; readonly digest: Sha256Digest }
  | { readonly kind: "role"; readonly role: string };

export interface ArtifactSelection {
  readonly selector: ArtifactSelector;
  readonly requirement: "required" | "optional";
}

export interface ArtifactHydrationRequest {
  readonly selections: readonly ArtifactSelection[];
}

export type ArtifactRetrievalStatus =
  | "verified"
  | "not-requested"
  | "unavailable"
  | "access-denied"
  | "integrity-mismatch"
  | "too-large"
  | "timed-out";

export interface DeclaredArtifact {
  readonly entityId: string;
  readonly reference: EvidenceArtifactReference;
  readonly roles: readonly string[];
}

export interface ArtifactRetrievalResult {
  readonly declaration: DeclaredArtifact;
  readonly requirement?: "required" | "optional";
  readonly status: ArtifactRetrievalStatus;
  readonly bytes?: Uint8Array;
  readonly actualDigest?: Sha256Digest;
}

export interface RetrievalWarning {
  readonly code: string;
  readonly message: string;
}

export const EVIDENCE_RETRIEVAL_FAILURE_CODES = [
  "NO_LOCATION",
  "ACCESS_DENIED",
  "WITHDRAWN_OR_UNAVAILABLE",
  "SOURCE_FAILED",
  "REPOSITORY_UNRESOLVED",
  "TIMED_OUT",
  "OPERATION_ABORTED",
  "CANDIDATE_BUDGET_EXCEEDED",
  "BYTE_BUDGET_EXCEEDED",
  "RECORD_TOO_LARGE",
  "ARTIFACT_TOO_LARGE",
  "RECORD_DIGEST_MISMATCH",
  "PROTOCOL_NONCONFORMING",
  "ACCEPTANCE_REJECTED",
  "REQUIRED_ARTIFACT_UNAVAILABLE",
  "ARTIFACT_INTEGRITY_MISMATCH",
  "PROVIDER_CONTRACT_VIOLATION",
] as const;

export type EvidenceRetrievalFailureCode =
  (typeof EVIDENCE_RETRIEVAL_FAILURE_CODES)[number];

export type EvidenceRetrievalFailureStage =
  | "source"
  | "candidate"
  | "location"
  | "record"
  | "validation"
  | "acceptance"
  | "artifact";

export interface EvidenceRetrievalFailure {
  readonly code: EvidenceRetrievalFailureCode;
  readonly stage: EvidenceRetrievalFailureStage;
  readonly message: string;
  readonly retryable: boolean;
  readonly reference?: EvidenceRecordReference;
  readonly source?: CandidateSourceIdentity;
  readonly repositoryId?: string;
  readonly conformanceDiagnostics?: readonly ConformanceDiagnostic[];
}

export interface ValidatedEvidenceResult<ProviderData = unknown> {
  readonly reference: EvidenceRecordReference;
  readonly canonicalBytes: Uint8Array;
  readonly validatedRecord: ValidatedRecord;
  readonly discoveryProvenance:
    readonly CandidateObservation<ProviderData>[];
  readonly availability: readonly RetrievalLocationObservation[];
  readonly selectedLocation?: RetrievalLocationObservation;
  readonly artifacts: readonly ArtifactRetrievalResult[];
  readonly completeness: "complete" | "artifact-incomplete";
  readonly warnings: readonly RetrievalWarning[];
}

export interface EvidenceAcceptanceDecisionAccepted {
  readonly status: "accepted";
}

export interface EvidenceAcceptanceDecisionRejected {
  readonly status: "rejected";
  readonly reasonCode: string;
}

export type EvidenceAcceptanceDecision =
  | EvidenceAcceptanceDecisionAccepted
  | EvidenceAcceptanceDecisionRejected;

export interface ValidatedEvidenceAcceptance {
  readonly id: string;
  readonly version: string;
  evaluate(
    evidence: ValidatedRecord,
  ): EvidenceAcceptanceDecision | Promise<EvidenceAcceptanceDecision>;
}

export interface RetrievalDiagnostics {
  readonly examinedCandidates: number;
  readonly uniqueReferences: number;
  readonly failures: readonly EvidenceRetrievalFailure[];
  readonly providerIssues: readonly CandidateSourceIssue[];
}

export interface RetrievalOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRecordBytes?: number;
  readonly maxTotalRecordBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly maxTotalArtifactBytes?: number;
  readonly maxProviderMetadataBytes?: number;
}

export interface RetrieveEvidenceInput {
  readonly reference: EvidenceRecordReference;
  readonly locationHints?: readonly RetrievalLocationHint[];
  readonly artifacts?: ArtifactHydrationRequest;
}

export type RetrieveEvidenceOutcome =
  | {
      readonly status: "validated";
      readonly result: ValidatedEvidenceResult;
    }
  | {
      readonly status: "failed";
      readonly failure: EvidenceRetrievalFailure;
    };

export interface SavedEvidenceQuery {
  readonly retrievalSchemaVersion: "1.0.0";
  readonly candidateSourceSet: CandidateSourceIdentity;
  readonly providerQuery: {
    readonly kind: string;
    readonly schemaVersion: string;
    readonly value: JsonValue;
  };
  readonly resultLimit: number;
  readonly candidateBudget: number;
  readonly acceptancePolicy?: {
    readonly id: string;
    readonly version: string;
    readonly configuration?: JsonValue;
  };
}

export interface QuerySnapshotReceipt {
  readonly savedQueryDigest: Sha256Digest;
  readonly sourceSet: CandidateSourceIdentity;
  readonly sources: readonly {
    readonly source: CandidateSourceIdentity;
    readonly checkpoint: CandidateCheckpoint;
  }[];
  readonly evaluatedAt: string;
  readonly reproducibility: "replayable" | "not-replayable";
}

export interface QueryEvidenceInput<Query, ProviderData = unknown> {
  readonly candidateSource: CandidateSource<Query, ProviderData>;
  readonly sourceQuery: Query;
  readonly resultLimit: number;
  readonly candidateBudget: number;
  readonly cursor?: CandidateCursor;
  readonly checkpoint?: CandidateCheckpoint;
  readonly acceptance?: ValidatedEvidenceAcceptance;
  readonly artifacts?: ArtifactHydrationRequest;
  readonly diagnostics?: "summary" | "detailed";
  readonly savedQuery?: SavedEvidenceQuery;
}

export interface QueryEvidenceOutcome<ProviderData = unknown> {
  readonly status: "complete" | "partial" | "failed";
  readonly results: readonly ValidatedEvidenceResult<ProviderData>[];
  readonly sourceReports: readonly CandidateSourceReport[];
  readonly nextCursor?: CandidateCursor;
  readonly snapshotReceipt?: QuerySnapshotReceipt;
  readonly diagnostics?: RetrievalDiagnostics;
}

export interface RetrievalHardLimits {
  readonly timeoutMs: number;
  readonly maxResultLimit: number;
  readonly maxCandidateBudget: number;
  readonly maxCandidatePageSize: number;
  readonly maxProviderMetadataBytes: number;
  readonly maxCursorBytes: number;
  readonly maxLocationObservations: number;
  readonly maxLocationAttempts: number;
  readonly maxRecordBytes: number;
  readonly maxTotalRecordBytes: number;
  readonly maxArtifactCount: number;
  readonly maxArtifactBytes: number;
  readonly maxTotalArtifactBytes: number;
  readonly maxRecordConcurrency: number;
  readonly maxArtifactConcurrency: number;
  readonly maxDiagnostics: number;
}

export interface RetrievalTelemetryEvent {
  readonly operationId: string;
  readonly operation: "retrieve" | "query";
  readonly stage:
    | "started"
    | "source"
    | "record"
    | "artifact"
    | "completed";
  readonly source?: CandidateSourceIdentity;
  readonly bindingProfile?: string;
  readonly durationMs?: number;
  readonly candidateCount?: number;
  readonly resultCount?: number;
  readonly failureCode?: EvidenceRetrievalFailureCode;
  readonly bytes?: number;
}

export interface RetrievalTelemetry {
  emit(event: RetrievalTelemetryEvent): void | Promise<void>;
}

export interface CreateEvidenceRetrievalOptions {
  readonly locator: EvidenceRecordLocator;
  readonly locationPolicy: EvidenceLocationPolicy;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly hardLimits?: Partial<RetrievalHardLimits>;
  readonly telemetry?: RetrievalTelemetry;
}

export interface EvidenceRetrieval {
  retrieve(
    input: RetrieveEvidenceInput,
    options?: RetrievalOperationOptions,
  ): Promise<RetrieveEvidenceOutcome>;
  query<Query, ProviderData = unknown>(
    input: QueryEvidenceInput<Query, ProviderData>,
    options?: RetrievalOperationOptions,
  ): Promise<QueryEvidenceOutcome<ProviderData>>;
}

export interface ProviderQueryCodec<Query> {
  readonly kind: string;
  readonly schemaVersion: string;
  encode(query: Query): JsonValue;
  decode(value: JsonValue): Query;
}
```

Create `src/errors.ts`:

```ts
import {
  EVIDENCE_RETRIEVAL_FAILURE_CODES,
  type EvidenceRetrievalFailure,
  type EvidenceRetrievalFailureCode,
} from "./contracts.js";

export type EvidenceRetrievalErrorCode =
  | "INVALID_INPUT"
  | "HOST_MISCONFIGURED";

export class EvidenceRetrievalError extends Error {
  readonly code: EvidenceRetrievalErrorCode;

  constructor(code: EvidenceRetrievalErrorCode, message: string) {
    super(message);
    this.name = "EvidenceRetrievalError";
    this.code = code;
  }
}

export function createEvidenceRetrievalFailure(
  input: Omit<EvidenceRetrievalFailure, "retryable"> & {
    readonly retryable?: boolean;
  },
): EvidenceRetrievalFailure {
  if (!EVIDENCE_RETRIEVAL_FAILURE_CODES.includes(input.code)) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `Unknown retrieval failure code: ${String(input.code)}`,
    );
  }
  return Object.freeze({ ...input, retryable: input.retryable ?? false });
}

export function isEvidenceRetrievalFailureCode(
  value: unknown,
): value is EvidenceRetrievalFailureCode {
  return typeof value === "string"
    && (EVIDENCE_RETRIEVAL_FAILURE_CODES as readonly string[]).includes(value);
}
```

Replace `src/index.ts` with:

```ts
export * from "./contracts.js";
export * from "./errors.js";
```

- [ ] **Step 4: Run contract tests and public typecheck**

Run:

```bash
yarn test src/contracts.test.ts
yarn typecheck
```

Expected: both PASS. The public contract must not export `KnowledgeHit`, `CorpusRecord`, `KnowledgePacket`, a search-method enum, or a mutable write port.

- [ ] **Step 5: Commit the public boundary**

```bash
git add packages/evidence/retrieval/src
git commit -m "feat(evidence): define retrieval contracts"
```

### Task 3: Enforce Deadlines, Cancellation, Limits, and Bounded Concurrency

**Files:**

- Create: `packages/evidence/retrieval/src/operation.ts`
- Create: `packages/evidence/retrieval/src/operation.test.ts`
- Modify: `packages/evidence/retrieval/src/contracts.ts`
- Modify: `packages/evidence/retrieval/src/index.ts`

**Interfaces:**

- Consumes: `RetrievalHardLimits`, `RetrievalOperationOptions`, `EvidenceRetrievalError`.
- Produces: public `DEFAULT_RETRIEVAL_HARD_LIMITS`; internal `createOperationContext(hardLimits, options)`, `validateQueryBounds`, `jsonByteLength`, `assertBoundedJson`, and `mapBounded`.

- [ ] **Step 1: Write failing tests for hard ceilings and abort propagation**

Create `src/operation.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_RETRIEVAL_HARD_LIMITS,
  assertBoundedJson,
  createOperationContext,
  mapBounded,
  validateQueryBounds,
} from "./operation.js";

describe("retrieval operation bounds", () => {
  test("clamps caller limits to host hard ceilings", () => {
    const context = createOperationContext(
      { ...DEFAULT_RETRIEVAL_HARD_LIMITS, maxRecordBytes: 10 },
      { timeoutMs: 60_000, maxRecordBytes: 100 },
    );
    expect(context.timeoutMs).toBe(DEFAULT_RETRIEVAL_HARD_LIMITS.timeoutMs);
    expect(context.maxRecordBytes).toBe(10);
    context.dispose();
  });

  test("rejects invalid query work before calling a provider", () => {
    expect(() => validateQueryBounds(0, 10, DEFAULT_RETRIEVAL_HARD_LIMITS))
      .toThrowError(/resultLimit/);
    expect(() => validateQueryBounds(2, 1, DEFAULT_RETRIEVAL_HARD_LIMITS))
      .toThrowError(/candidateBudget/);
  });

  test("aborts work at the deadline", async () => {
    vi.useFakeTimers();
    const context = createOperationContext(
      DEFAULT_RETRIEVAL_HARD_LIMITS,
      { timeoutMs: 25 },
    );
    const observed = new Promise<void>((resolve) => {
      context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await vi.advanceTimersByTimeAsync(25);
    await observed;
    expect(context.timedOut()).toBe(true);
    context.dispose();
    vi.useRealTimers();
  });

  test("never exceeds the requested concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const values = await mapBounded([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });
    expect(maximum).toBe(2);
    expect(values).toEqual([2, 4, 6, 8]);
  });

  test("bounds provider-owned JSON by encoded bytes", () => {
    expect(() => assertBoundedJson({ snippet: "1234" }, 4, "provider metadata"))
      .toThrowError(/provider metadata/);
  });

  test("accounts for record and artifact bytes across the whole operation", () => {
    const context = createOperationContext({
      ...DEFAULT_RETRIEVAL_HARD_LIMITS,
      maxTotalRecordBytes: 10,
      maxTotalArtifactBytes: 10,
    });
    expect(context.consumeRecordBytes(6)).toBe(true);
    expect(context.consumeRecordBytes(5)).toBe(false);
    expect(context.recordBytesConsumed()).toBe(6);
    expect(context.consumeArtifactBytes(10)).toBe(true);
    expect(context.consumeArtifactBytes(1)).toBe(false);
    context.dispose();
  });
});
```

- [ ] **Step 2: Run the operation test and observe missing helpers**

Run:

```bash
yarn test src/operation.test.ts
```

Expected: FAIL because `operation.ts` does not exist.

- [ ] **Step 3: Implement one operation context and shared bounds**

Add the public default in `contracts.ts`:

```ts
export const DEFAULT_RETRIEVAL_HARD_LIMITS: RetrievalHardLimits =
  Object.freeze({
    timeoutMs: 30_000,
    maxResultLimit: 50,
    maxCandidateBudget: 500,
    maxCandidatePageSize: 100,
    maxProviderMetadataBytes: 64 * 1024,
    maxCursorBytes: 16 * 1024,
    maxLocationObservations: 64,
    maxLocationAttempts: 8,
    maxRecordBytes: 16 * 1024 * 1024,
    maxTotalRecordBytes: 128 * 1024 * 1024,
    maxArtifactCount: 32,
    maxArtifactBytes: 64 * 1024 * 1024,
    maxTotalArtifactBytes: 128 * 1024 * 1024,
    maxRecordConcurrency: 8,
    maxArtifactConcurrency: 4,
    maxDiagnostics: 100,
  });
```

Create `src/operation.ts` around this shape:

```ts
import type { JsonValue } from "@jinn-network/evidence-discovery";

import {
  DEFAULT_RETRIEVAL_HARD_LIMITS,
  type RetrievalHardLimits,
  type RetrievalOperationOptions,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";

export interface OperationContext extends RetrievalHardLimits {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly deadline: number;
  remainingMs(): number;
  timedOut(): boolean;
  consumeRecordBytes(bytes: number): boolean;
  consumeArtifactBytes(bytes: number): boolean;
  recordBytesConsumed(): number;
  artifactBytesConsumed(): number;
  dispose(): void;
}

const encoder = new TextEncoder();

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `${name} must be a non-negative safe integer.`,
    );
  }
  return value;
}

export function resolveHardLimits(
  overrides: Partial<RetrievalHardLimits> = {},
): RetrievalHardLimits {
  const values = { ...DEFAULT_RETRIEVAL_HARD_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(values)) {
    positiveInteger(value, name);
  }
  return Object.freeze(values);
}

export function createOperationContext(
  hardLimits: RetrievalHardLimits,
  options: RetrievalOperationOptions = {},
): OperationContext {
  const timeoutMs = Math.min(
    hardLimits.timeoutMs,
    positiveInteger(options.timeoutMs ?? hardLimits.timeoutMs, "timeoutMs"),
  );
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (options.signal?.aborted) onCallerAbort();

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let deadlineElapsed = false;
  let recordBytes = 0;
  let artifactBytes = 0;
  const timer = setTimeout(() => {
    deadlineElapsed = true;
    controller.abort(new DOMException("Retrieval timed out.", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();

  const operationLimit = (
    requested: number | undefined,
    ceiling: number,
    name: string,
  ) => Math.min(positiveInteger(requested ?? ceiling, name), ceiling);
  const maxTotalRecordBytes = operationLimit(
    options.maxTotalRecordBytes,
    hardLimits.maxTotalRecordBytes,
    "maxTotalRecordBytes",
  );
  const maxTotalArtifactBytes = operationLimit(
    options.maxTotalArtifactBytes,
    hardLimits.maxTotalArtifactBytes,
    "maxTotalArtifactBytes",
  );

  return Object.freeze({
    ...hardLimits,
    timeoutMs,
    maxRecordBytes: operationLimit(
      options.maxRecordBytes,
      hardLimits.maxRecordBytes,
      "maxRecordBytes",
    ),
    maxTotalRecordBytes,
    maxArtifactBytes: operationLimit(
      options.maxArtifactBytes,
      hardLimits.maxArtifactBytes,
      "maxArtifactBytes",
    ),
    maxTotalArtifactBytes,
    maxProviderMetadataBytes: operationLimit(
      options.maxProviderMetadataBytes,
      hardLimits.maxProviderMetadataBytes,
      "maxProviderMetadataBytes",
    ),
    operationId: crypto.randomUUID(),
    signal: controller.signal,
    startedAt,
    deadline,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    timedOut: () => deadlineElapsed,
    consumeRecordBytes: (bytes) => {
      nonNegativeInteger(bytes, "record bytes");
      if (recordBytes + bytes > maxTotalRecordBytes) return false;
      recordBytes += bytes;
      return true;
    },
    consumeArtifactBytes: (bytes) => {
      nonNegativeInteger(bytes, "artifact bytes");
      if (artifactBytes + bytes > maxTotalArtifactBytes) return false;
      artifactBytes += bytes;
      return true;
    },
    recordBytesConsumed: () => recordBytes,
    artifactBytesConsumed: () => artifactBytes,
    dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    },
  });
}

export function validateQueryBounds(
  resultLimit: number,
  candidateBudget: number,
  limits: RetrievalHardLimits,
): void {
  positiveInteger(resultLimit, "resultLimit");
  positiveInteger(candidateBudget, "candidateBudget");
  if (resultLimit > limits.maxResultLimit) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `resultLimit exceeds host maximum ${limits.maxResultLimit}.`,
    );
  }
  if (candidateBudget > limits.maxCandidateBudget) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `candidateBudget exceeds host maximum ${limits.maxCandidateBudget}.`,
    );
  }
  if (candidateBudget < resultLimit) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "candidateBudget must be greater than or equal to resultLimit.",
    );
  }
}

export function jsonByteLength(value: JsonValue | unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

export function assertBoundedJson(
  value: JsonValue | unknown,
  maximumBytes: number,
  name: string,
): void {
  if (jsonByteLength(value) > maximumBytes) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `${name} exceeds ${maximumBytes} encoded bytes.`,
    );
  }
}

export async function mapBounded<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  map: (input: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> {
  positiveInteger(concurrency, "concurrency");
  const output = new Array<Output>(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const index = next++;
      output[index] = await map(inputs[index]!, index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, inputs.length) },
      () => worker(),
    ),
  );
  return output;
}
```

Export only `DEFAULT_RETRIEVAL_HARD_LIMITS` through `contracts.ts`/`index.ts`. Keep `OperationContext`, bound helpers, and concurrency helpers package-internal.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
yarn test src/operation.test.ts
yarn test
yarn typecheck
```

Expected: all PASS. The fake-timer test must restore real timers even if an assertion fails; use `afterEach(() => vi.useRealTimers())` if the first implementation reveals leakage.

- [ ] **Step 5: Commit bounded operation controls**

```bash
git add packages/evidence/retrieval/src/contracts.ts packages/evidence/retrieval/src/operation.ts packages/evidence/retrieval/src/operation.test.ts packages/evidence/retrieval/src/index.ts
git commit -m "feat(evidence): bound retrieval operations"
```

### Task 4: Verify Canonical Bytes and Dispatch Every Protocol Family

**Files:**

- Create: `packages/evidence/retrieval/src/validation.ts`
- Create: `packages/evidence/retrieval/src/validation.test.ts`
- Create: `packages/evidence/retrieval/src/test-support.ts`

**Interfaces:**

- Consumes: `recordDigest`, `validateExecutionEvidence`, `validateResultEvaluation`, and `validateExecutionVerification` from Protocol; `parseEvidenceRecordReference` from Repository; `EvidenceRetrievalFailure` and `ValidatedRecord`.
- Produces: internal `validateCanonicalRecord(reference, bytes, maxRecordBytes): CanonicalRecordValidation`.

- [ ] **Step 1: Write failing tests for all families, digest mismatch, size, and conformance**

Create `src/test-support.ts` with a test-only loader:

```ts
import { readFile } from "node:fs/promises";

import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";

const GOLDEN_FIXTURES = {
  "execution-evidence":
    "golden-execution-evidence-v1/execution/ro-crate-metadata.json",
  "result-evaluation":
    "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
  "execution-verification":
    "golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json",
} as const;

export async function loadProtocolFixture(
  family: EvidenceRecordReference["family"],
): Promise<Uint8Array> {
  const url = import.meta.resolve(
    `@jinn-network/evidence-protocol/fixtures/${GOLDEN_FIXTURES[family]}`,
  );
  return new Uint8Array(await readFile(new URL(url)));
}
```

Create `src/validation.test.ts`:

```ts
import { createRecordReference } from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import { loadProtocolFixture } from "./test-support.js";
import { validateCanonicalRecord } from "./validation.js";

const cases = [
  "execution-evidence",
  "result-evaluation",
  "execution-verification",
] as const;

describe("canonical record validation", () => {
  test.each(cases)("validates %s with its existing Protocol validator", async (
    family,
  ) => {
    const bytes = await loadProtocolFixture(family);
    const reference = createRecordReference(family, bytes);
    const result = validateCanonicalRecord(reference, bytes, bytes.byteLength);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedRecord.family).toBe(family);
      expect(result.canonicalBytes).toEqual(bytes);
      expect(result.canonicalBytes).not.toBe(bytes);
    }
  });

  test("rejects bytes that do not match the supplied reference", async () => {
    const bytes = await loadProtocolFixture("execution-evidence");
    const reference = createRecordReference(
      "execution-evidence",
      new TextEncoder().encode("different bytes"),
    );
    const result = validateCanonicalRecord(reference, bytes, bytes.byteLength);
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "RECORD_DIGEST_MISMATCH", stage: "record" },
    });
    expect(result).not.toHaveProperty("canonicalBytes");
  });

  test("rejects an oversized record before Protocol parsing", () => {
    const bytes = new TextEncoder().encode("{}");
    const reference = createRecordReference("execution-evidence", bytes);
    expect(validateCanonicalRecord(reference, bytes, 1)).toMatchObject({
      ok: false,
      failure: { code: "RECORD_TOO_LARGE" },
    });
  });

  test("reports Protocol diagnostics without returning unvalidated bytes", () => {
    const bytes = new TextEncoder().encode("{}");
    const reference = createRecordReference("execution-evidence", bytes);
    const result = validateCanonicalRecord(reference, bytes, bytes.byteLength);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "PROTOCOL_NONCONFORMING",
        stage: "validation",
      },
    });
    if (!result.ok) {
      expect(result.failure.conformanceDiagnostics?.length).toBeGreaterThan(0);
    }
    expect(result).not.toHaveProperty("canonicalBytes");
  });
});
```

- [ ] **Step 2: Run the validation test and observe the missing dispatcher**

Run:

```bash
yarn test src/validation.test.ts
```

Expected: FAIL because `validateCanonicalRecord` is missing.

- [ ] **Step 3: Implement exact-byte validation**

Create `src/validation.ts`:

```ts
import {
  recordDigest,
  validateExecutionEvidence,
  validateExecutionVerification,
  validateResultEvaluation,
  type ConformanceDiagnostic,
} from "@jinn-network/evidence-protocol";
import {
  parseEvidenceRecordReference,
  type EvidenceRecordReference,
} from "@jinn-network/evidence-repository";

import type {
  EvidenceRetrievalFailure,
  ValidatedRecord,
} from "./contracts.js";
import { createEvidenceRetrievalFailure } from "./errors.js";

export type CanonicalRecordValidation =
  | {
      readonly ok: true;
      readonly canonicalBytes: Uint8Array;
      readonly validatedRecord: ValidatedRecord;
    }
  | {
      readonly ok: false;
      readonly failure: EvidenceRetrievalFailure;
    };

function nonconforming(
  reference: EvidenceRecordReference,
  report: { readonly diagnostics: readonly ConformanceDiagnostic[] },
): CanonicalRecordValidation {
  return {
    ok: false,
    failure: createEvidenceRetrievalFailure({
      code: "PROTOCOL_NONCONFORMING",
      stage: "validation",
      message: "Record bytes do not conform to the declared Evidence family.",
      reference,
      conformanceDiagnostics: report.diagnostics,
    }),
  };
}

export function validateCanonicalRecord(
  untrustedReference: EvidenceRecordReference,
  bytes: Uint8Array,
  maxRecordBytes: number,
): CanonicalRecordValidation {
  const reference = parseEvidenceRecordReference(untrustedReference);
  if (bytes.byteLength > maxRecordBytes) {
    return {
      ok: false,
      failure: createEvidenceRetrievalFailure({
        code: "RECORD_TOO_LARGE",
        stage: "record",
        message: `Record exceeds the ${maxRecordBytes}-byte operation limit.`,
        reference,
      }),
    };
  }
  if (recordDigest(bytes) !== reference.digest) {
    return {
      ok: false,
      failure: createEvidenceRetrievalFailure({
        code: "RECORD_DIGEST_MISMATCH",
        stage: "record",
        message: "Record bytes do not match the canonical reference digest.",
        reference,
      }),
    };
  }

  if (reference.family === "execution-evidence") {
    const report = validateExecutionEvidence(bytes);
    return report.conforms && report.value
      ? {
          ok: true,
          canonicalBytes: Uint8Array.from(bytes),
          validatedRecord: { family: reference.family, value: report.value },
        }
      : nonconforming(reference, report);
  }
  if (reference.family === "result-evaluation") {
    const report = validateResultEvaluation(bytes);
    return report.conforms && report.value
      ? {
          ok: true,
          canonicalBytes: Uint8Array.from(bytes),
          validatedRecord: { family: reference.family, value: report.value },
        }
      : nonconforming(reference, report);
  }
  const report = validateExecutionVerification(bytes);
  return report.conforms && report.value
    ? {
        ok: true,
        canonicalBytes: Uint8Array.from(bytes),
        validatedRecord: { family: reference.family, value: report.value },
      }
    : nonconforming(reference, report);
}
```

- [ ] **Step 4: Verify validation and mutation isolation**

Run:

```bash
yarn test src/validation.test.ts
yarn typecheck
yarn test
```

Expected: all PASS. Add a mutation assertion if needed: changing the repository-returned `bytes` after validation must not change `canonicalBytes`.

- [ ] **Step 5: Commit exact-byte validation**

```bash
git add packages/evidence/retrieval/src/validation.ts packages/evidence/retrieval/src/validation.test.ts packages/evidence/retrieval/src/test-support.ts
git commit -m "feat(evidence): validate retrieved record bytes"
```

### Task 5: Resolve Locations and Build the Known-Reference Use Case

**Files:**

- Create: `packages/evidence/retrieval/src/resolution.ts`
- Create: `packages/evidence/retrieval/src/resolution.test.ts`
- Create: `packages/evidence/retrieval/src/known-reference.ts`
- Create: `packages/evidence/retrieval/src/known-reference.test.ts`
- Modify: `packages/evidence/retrieval/src/test-support.ts`
- Modify: `packages/evidence/retrieval/src/contracts.ts`

**Interfaces:**

- Consumes: `EvidenceRecordLocator.locate`, `EvidenceLocationPolicy.select`, `EvidenceRepositoryResolver.resolve`, `EvidenceRepository.getRecord`, `OperationContext`, and `validateCanonicalRecord`.
- Produces: internal `resolveValidatedRecord(input): Promise<RecordResolutionOutcome>` and `retrieveKnownReference(dependencies, input, options): Promise<RetrieveEvidenceOutcome>`. Task 10 composes this completed use case into the public facade alongside completed query orchestration.

- [ ] **Step 1: Write failing resolution and known-reference tests**

In `src/resolution.test.ts`, load the conforming execution fixture as in Task 4 and define explicit fake locations/repositories. Cover these cases:

```ts
test("continues from a corrupt copy to a valid allowed copy", async () => {
  const bytes = await loadProtocolFixture("execution-evidence");
  const reference = createRecordReference("execution-evidence", bytes);
  const corrupt = repositoryReturning(new TextEncoder().encode("corrupt"));
  const valid = repositoryReturning(bytes);
  const outcome = await resolveValidatedRecord({
    reference,
    hints: [],
    locator: locatorReturning([
      available("catalog", "corrupt"),
      available("catalog", "valid"),
    ]),
    locationPolicy: policyInObservedOrder(),
    repositoryResolver: resolverFrom({ corrupt, valid }),
    context: operationContext(),
  });
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.record.selectedLocation.repositoryId).toBe("valid");
    expect(outcome.record.failures).toContainEqual(
      expect.objectContaining({ code: "RECORD_DIGEST_MISMATCH" }),
    );
  }
});

test("does not resolve a location rejected by host policy", async () => {
  const resolver = vi.fn();
  const outcome = await resolveValidatedRecord({
    reference: arbitraryReference(),
    hints: [],
    locator: locatorReturning([available("candidate", "remote")]),
    locationPolicy: { select: () => [] },
    repositoryResolver: { resolve: resolver },
    context: operationContext(),
  });
  expect(outcome).toMatchObject({
    ok: false,
    failure: { code: "NO_LOCATION" },
  });
  expect(resolver).not.toHaveBeenCalled();
});
```

Add focused cases for:

- no observations;
- only withdrawn observations;
- unresolved repository identity;
- repository `null`;
- Repository `ACCESS_DENIED`, `CONTENT_TOO_LARGE`, and `OPERATION_ABORTED`;
- locator deadline/caller abort, over-limit observations, and an invalid policy attempt;
- location attempts truncated to `maxLocationAttempts`;
- Protocol-nonconforming first copy followed by valid copy;
- all locations exhausted, returning the most specific last failure while retaining every classified attempt.

Create `src/known-reference.test.ts`:

```ts
test("retrieves a known reference without invoking candidate search", async () => {
  const fixture = await createKnownReferenceFixture();
  const outcome = await retrieveKnownReference(
    fixture.dependencies,
    { reference: fixture.reference },
  );
  expect(outcome).toMatchObject({
    status: "validated",
    result: {
      reference: fixture.reference,
      discoveryProvenance: [],
      artifacts: [],
      completeness: "complete",
    },
  });
  expect(fixture.locator.locate).toHaveBeenCalledOnce();
  expect(fixture.repository.getRecord).toHaveBeenCalledWith(
    fixture.reference,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("returns a typed failure and never exposes invalid bytes", async () => {
  const fixture = await createKnownReferenceFixture({
    returnedRecordBytes: new TextEncoder().encode("wrong"),
  });
  const outcome = await retrieveKnownReference(
    fixture.dependencies,
    { reference: fixture.reference },
  );
  expect(outcome).toMatchObject({
    status: "failed",
    failure: { code: "RECORD_DIGEST_MISMATCH" },
  });
  expect(outcome).not.toHaveProperty("result");
});
```

Extend `src/test-support.ts` with the exact helpers used above:

```ts
import {
  createRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { vi } from "vitest";

import {
  DEFAULT_RETRIEVAL_HARD_LIMITS,
  type EvidenceLocationPolicy,
  type EvidenceRecordLocator,
  type RetrievalLocationObservation,
} from "./contracts.js";
import {
  createOperationContext,
  resolveHardLimits,
} from "./operation.js";

export function available(
  sourceId: string,
  repositoryId: string,
): RetrievalLocationObservation {
  return {
    observationId: `${sourceId}:${repositoryId}`,
    sourceId,
    status: "available",
    repositoryId,
  };
}

export function locatorReturning(
  observations: readonly RetrievalLocationObservation[],
) {
  return {
    locate: vi.fn(async () => observations),
  } satisfies EvidenceRecordLocator;
}

export function policyInObservedOrder(): EvidenceLocationPolicy {
  return {
    select: (_reference, observations) =>
      observations.flatMap((observation) =>
        observation.status === "available"
        && observation.repositoryId !== undefined
          ? [{ repositoryId: observation.repositoryId, observation }]
          : [],
      ),
  };
}

export function repositoryReturning(
  recordBytes: Uint8Array | null,
): EvidenceRepository & {
  readonly getRecord: ReturnType<typeof vi.fn>;
  readonly getArtifact: ReturnType<typeof vi.fn>;
} {
  const unsupported = async (): Promise<never> => {
    throw new Error("Test repository is read-only.");
  };
  return {
    capabilities: Object.freeze({}),
    putRecord: unsupported,
    putArtifact: unsupported,
    getRecord: vi.fn(async () =>
      recordBytes === null ? null : Uint8Array.from(recordBytes),
    ),
    getArtifact: vi.fn(async () => null),
  };
}

export function resolverFrom(
  repositories: Readonly<Record<string, EvidenceRepository>>,
) {
  return {
    resolve: vi.fn(async (repositoryId: string) =>
      repositories[repositoryId] ?? null,
    ),
  };
}

export function operationContext() {
  return createOperationContext(
    resolveHardLimits(DEFAULT_RETRIEVAL_HARD_LIMITS),
  );
}

export function arbitraryReference() {
  return createRecordReference(
    "execution-evidence",
    new TextEncoder().encode("arbitrary"),
  );
}

export async function createKnownReferenceFixture(options: {
  readonly returnedRecordBytes?: Uint8Array | null;
} = {}) {
  const bytes = await loadProtocolFixture("execution-evidence");
  const reference = createRecordReference("execution-evidence", bytes);
  const repository = repositoryReturning(
    options.returnedRecordBytes === undefined
      ? bytes
      : options.returnedRecordBytes,
  );
  const locator = locatorReturning([available("fixture", "memory")]);
  const repositoryResolver = resolverFrom({ memory: repository });
  return {
    bytes,
    reference,
    repository,
    locator,
    repositoryResolver,
    dependencies: {
      locator,
      locationPolicy: policyInObservedOrder(),
      repositoryResolver,
      hardLimits: resolveHardLimits(),
    },
  };
}
```

`resolution.test.ts` imports these helpers from `test-support.ts`; `createKnownReferenceFixture` is used only by tests and never exported from the package.

- [ ] **Step 2: Run the focused tests and observe missing orchestration**

Run:

```bash
yarn test src/resolution.test.ts src/known-reference.test.ts
```

Expected: FAIL because `resolution.ts`, `retrieveKnownReference`, and the test fixtures are missing.

- [ ] **Step 3: Implement bounded location resolution**

Create `src/resolution.ts` with internal result contracts that are not re-exported from the package root:

```ts
export interface ResolvedValidatedRecord {
  readonly reference: EvidenceRecordReference;
  readonly canonicalBytes: Uint8Array;
  readonly validatedRecord: ValidatedRecord;
  readonly availability: readonly RetrievalLocationObservation[];
  readonly selectedLocation: RetrievalLocationObservation;
  readonly repository: EvidenceRepository;
  readonly allowedLocationAttempts: readonly RetrievalLocationAttempt[];
  readonly warnings: readonly RetrievalWarning[];
  readonly failures: readonly EvidenceRetrievalFailure[];
}

export type RecordResolutionOutcome =
  | {
      readonly ok: true;
      readonly record: ResolvedValidatedRecord;
    }
  | {
      readonly ok: false;
      readonly failure: EvidenceRetrievalFailure;
      readonly availability: readonly RetrievalLocationObservation[];
      readonly failures: readonly EvidenceRetrievalFailure[];
    };

export interface ResolveValidatedRecordInput {
  readonly reference: EvidenceRecordReference;
  readonly hints: readonly RetrievalLocationHint[];
  readonly locator: EvidenceRecordLocator;
  readonly locationPolicy: EvidenceLocationPolicy;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly context: OperationContext;
}
```

Implement the loop in policy order:

```ts
const availability = await locator.locate(reference, hints, {
  signal: context.signal,
  timeoutMs: context.remainingMs(),
  maximumLocations: context.maxLocationObservations,
});
if (availability.length > context.maxLocationObservations) {
  throw new EvidenceRetrievalError(
    "HOST_MISCONFIGURED",
    "Record locator exceeded the maximum location observations.",
  );
}
const selected = locationPolicy.select(reference, availability);
if (selected.some(({ observation, repositoryId }) =>
  observation.status !== "available"
  || observation.repositoryId !== repositoryId
  || !availability.includes(observation),
)) {
  throw new EvidenceRetrievalError(
    "HOST_MISCONFIGURED",
    "Location policy returned an observation outside its bounded input.",
  );
}
const attempts = selected.slice(0, context.maxLocationAttempts);

for (const attempt of attempts) {
  try {
    const repository = await repositoryResolver.resolve(attempt.repositoryId, {
      signal: context.signal,
    });
    if (!repository) {
      failures.push(failureForUnresolved(reference, attempt.repositoryId));
      continue;
    }
    const bytes = await repository.getRecord(reference, {
      signal: context.signal,
    });
    if (!bytes) {
      failures.push(failureForUnavailable(reference, attempt.repositoryId));
      continue;
    }
    if (!context.consumeRecordBytes(bytes.byteLength)) {
      failures.push(createEvidenceRetrievalFailure({
        code: "BYTE_BUDGET_EXCEEDED",
        stage: "record",
        message: "The operation record-byte budget was exhausted.",
        reference,
        repositoryId: attempt.repositoryId,
      }));
      break;
    }
    const effectiveMaximum = Math.min(
      context.maxRecordBytes,
      repository.capabilities.maxObjectBytes ?? context.maxRecordBytes,
    );
    const validation = validateCanonicalRecord(
      reference,
      bytes,
      effectiveMaximum,
    );
    if (!validation.ok) {
      failures.push({
        ...validation.failure,
        repositoryId: attempt.repositoryId,
      });
      continue;
    }
    return {
      ok: true,
      record: {
        reference,
        canonicalBytes: validation.canonicalBytes,
        validatedRecord: validation.validatedRecord,
        availability,
        selectedLocation: attempt.observation,
        repository,
        allowedLocationAttempts: attempts,
        warnings: failures.map(failureToWarning),
        failures,
      },
    };
  } catch (error) {
    failures.push(classifyRepositoryError(error, reference, attempt.repositoryId, context));
    if (context.signal.aborted) break;
  }
}
```

Wrap `locator.locate` in a catch that converts deadline/caller abort and
availability failures into a failed `RecordResolutionOutcome`. Wrap
`locationPolicy.select` separately and throw
`EvidenceRetrievalError("HOST_MISCONFIGURED", ...)` if the trusted host policy
throws or returns an attempt that is not an exact member of the bounded
available observations. Never copy a locator or policy exception message.

The helpers must map Repository codes without copying adapter messages that may contain private locators:

| Repository error | Retrieval failure |
| --- | --- |
| `ACCESS_DENIED` | `ACCESS_DENIED`, retryable `false` |
| `CONTENT_TOO_LARGE` | `RECORD_TOO_LARGE`, retryable `false` |
| `OPERATION_ABORTED` with elapsed deadline | `TIMED_OUT`, retryable `true` |
| `OPERATION_ABORTED` from caller signal | `OPERATION_ABORTED`, retryable `false` |
| `DEPENDENCY_UNAVAILABLE` or `IO_FAILURE` | `WITHDRAWN_OR_UNAVAILABLE`, retryable `true` |
| `CONTENT_CORRUPT` | `RECORD_DIGEST_MISMATCH`, retryable `false` |
| unknown adapter error | `WITHDRAWN_OR_UNAVAILABLE`, retryable `true` |

If there are no attempts, return `NO_LOCATION` when no allowed available location exists and `WITHDRAWN_OR_UNAVAILABLE` when observations exist but all are withdrawn. When attempts are exhausted, return the last classified failure and preserve the full failure array.

- [ ] **Step 4: Implement the known-reference use case**

Create `src/known-reference.ts`:

```ts
import { parseEvidenceRecordReference } from "@jinn-network/evidence-repository";

import {
  type EvidenceLocationPolicy,
  type EvidenceRecordLocator,
  type RetrieveEvidenceInput,
  type RetrieveEvidenceOutcome,
  type RetrievalHardLimits,
  type RetrievalOperationOptions,
} from "./contracts.js";
import type { EvidenceRepositoryResolver } from "@jinn-network/evidence-discovery";
import { EvidenceRetrievalError } from "./errors.js";
import {
  createOperationContext,
  assertBoundedJson,
} from "./operation.js";
import { resolveValidatedRecord } from "./resolution.js";

export interface KnownReferenceDependencies {
  readonly locator: EvidenceRecordLocator;
  readonly locationPolicy: EvidenceLocationPolicy;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly hardLimits: RetrievalHardLimits;
}

export async function retrieveKnownReference(
  dependencies: KnownReferenceDependencies,
  input: RetrieveEvidenceInput,
  operationOptions?: RetrievalOperationOptions,
): Promise<RetrieveEvidenceOutcome> {
  let reference;
  try {
    reference = parseEvidenceRecordReference(input.reference);
  } catch {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "reference must be a canonical Evidence record reference.",
    );
  }
  const context = createOperationContext(
    dependencies.hardLimits,
    operationOptions,
  );
  try {
    const hints = input.locationHints ?? [];
    if (hints.length > context.maxLocationObservations) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        "locationHints exceeds the host observation limit.",
      );
    }
    assertBoundedJson(
      hints,
      context.maxProviderMetadataBytes,
      "locationHints",
    );
    const outcome = await resolveValidatedRecord({
      reference,
      hints,
      locator: dependencies.locator,
      locationPolicy: dependencies.locationPolicy,
      repositoryResolver: dependencies.repositoryResolver,
      context,
    });
    if (!outcome.ok) {
      return { status: "failed", failure: outcome.failure };
    }
    const record = outcome.record;
    return {
      status: "validated",
      result: {
        reference,
        canonicalBytes: record.canonicalBytes,
        validatedRecord: record.validatedRecord,
        discoveryProvenance: [],
        availability: record.availability,
        selectedLocation: record.selectedLocation,
        artifacts: [],
        completeness: "complete",
        warnings: record.warnings,
      },
    };
  } finally {
    context.dispose();
  }
}
```

- [ ] **Step 5: Run focused tests, full package tests, and commit**

Run:

```bash
yarn test src/resolution.test.ts src/known-reference.test.ts
yarn test
yarn typecheck
```

Expected: all PASS. Then commit:

```bash
git add packages/evidence/retrieval/src
git commit -m "feat(evidence): retrieve known evidence references"
```

### Task 6: Extract Declared Artifacts and Hydrate Only Explicit Selections

**Files:**

- Create: `packages/evidence/retrieval/src/declared-artifacts.ts`
- Create: `packages/evidence/retrieval/src/declared-artifacts.test.ts`
- Create: `packages/evidence/retrieval/src/artifacts.ts`
- Create: `packages/evidence/retrieval/src/artifacts.test.ts`
- Modify: `packages/evidence/retrieval/src/known-reference.ts`
- Modify: `packages/evidence/retrieval/src/known-reference.test.ts`
- Modify: `packages/evidence/retrieval/src/test-support.ts`

**Interfaces:**

- Consumes: `ValidatedRecord`, the selected and allowed record locations from `ResolvedValidatedRecord`, Repository `getArtifact`, Protocol `checkArtifactIntegrity` and `recordDigest`, explicit `ArtifactHydrationRequest`, and operation limits.
- Produces: internal `collectDeclaredArtifacts(record): readonly DeclaredArtifact[]` and `hydrateArtifacts(input): Promise<ArtifactHydrationOutcome>`; known-reference results now always describe declared artifacts and fetch only selected ones.

- [ ] **Step 1: Write failing declaration and hydration tests**

In `src/declared-artifacts.test.ts`, use the three golden Protocol fixtures and assert:

```ts
test("extracts execution artifact identities and relationship roles", async () => {
  const record = await validatedFixture("execution-evidence");
  const artifacts = collectDeclaredArtifacts(record);
  expect(artifacts).toContainEqual({
    entityId: "task/task.md",
    reference: {
      digest:
        "sha256:1f42fd35cecf09d1bdf953fe4c7a1c8d25fd0bcf415a6b39aa7b61f1e982ef93",
    },
    roles: expect.arrayContaining(["object"]),
  });
  expect(artifacts).toContainEqual(
    expect.objectContaining({
      entityId: "trace/trajectory.jsonl",
      roles: expect.arrayContaining(["subjectOf"]),
    }),
  );
});

test("extracts attestation subjects and supporting evidence", async () => {
  const evaluation = await validatedFixture("result-evaluation");
  const verification = await validatedFixture("execution-verification");
  const evaluationArtifacts = collectDeclaredArtifacts(evaluation);
  const verificationArtifacts = collectDeclaredArtifacts(verification);
  expect(evaluationArtifacts.some((artifact) =>
    artifact.roles.includes("subject"),
  ))
    .toBe(true);
  expect(evaluationArtifacts.some((artifact) =>
    artifact.roles.includes("supporting-evidence"),
  )).toBe(true);
  expect(verificationArtifacts.some((artifact) =>
    artifact.roles.includes("supporting-evidence"),
  )).toBe(true);
});
```

In `src/artifacts.test.ts`, provide fake repositories and cover:

```ts
test("does not read artifact bytes without a hydration request", async () => {
  const fixture = await artifactFixture();
  const result = await hydrateArtifacts({
    record: fixture.record,
    request: undefined,
    repositoryResolver: fixture.resolver,
    context: fixture.context,
  });
  expect(fixture.repositories.flatMap((repository) =>
    repository.getArtifact.mock.calls,
  )).toHaveLength(0);
  expect(result.results.every(({ status }) => status === "not-requested"))
    .toBe(true);
});

test("hydrates only matching selectors and verifies exact bytes", async () => {
  const fixture = await artifactFixture();
  const result = await hydrateArtifacts({
    record: fixture.record,
    request: {
      selections: [{
        selector: { kind: "role", role: "result" },
        requirement: "required",
      }],
    },
    repositoryResolver: fixture.resolver,
    context: fixture.context,
  });
  expect(result.results).toContainEqual(
    expect.objectContaining({
      requirement: "required",
      status: "verified",
      bytes: fixture.resultBytes,
    }),
  );
  expect(result.completeness).toBe("complete");
});
```

Add one focused assertion for every state:

- `unavailable` after all allowed repositories return `null`;
- `access-denied` after all copies deny access;
- `integrity-mismatch` when returned bytes have a different digest;
- `too-large` for repository capability or operation byte overflow;
- `timed-out` when the operation deadline aborts the read;
- `not-requested` for a declared artifact that matches no selection;
- `verified` exposes a defensive copy of complete bytes only.

Also assert:

- duplicate selectors produce one read;
- required wins when required and optional selectors match the same declaration;
- optional failure yields a warning but `complete`;
- required failure yields `artifact-incomplete` plus `REQUIRED_ARTIFACT_UNAVAILABLE`;
- `maxArtifactCount`, per-artifact bytes, and total-artifact bytes are all enforced;
- artifact failure never changes Protocol conformance of the containing record.

Extend `test-support.ts` so the helper names in these tests have exact behavior:

```ts
import { createArtifactReference } from "@jinn-network/evidence-repository";
import { validateCanonicalRecord } from "./validation.js";
import type { ResolvedValidatedRecord } from "./resolution.js";

export async function validatedFixture(
  family: EvidenceRecordReference["family"],
) {
  const bytes = await loadProtocolFixture(family);
  const reference = createRecordReference(family, bytes);
  const validation = validateCanonicalRecord(
    reference,
    bytes,
    bytes.byteLength,
  );
  if (!validation.ok) {
    throw new Error(`Golden ${family} fixture did not validate.`);
  }
  return validation.validatedRecord;
}

export async function loadProtocolArtifact(path: string): Promise<Uint8Array> {
  const url = import.meta.resolve(
    `@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/${path}`,
  );
  return new Uint8Array(await readFile(new URL(url)));
}

export async function artifactFixture() {
  const canonicalBytes = await loadProtocolFixture("execution-evidence");
  const reference = createRecordReference(
    "execution-evidence",
    canonicalBytes,
  );
  const validation = validateCanonicalRecord(
    reference,
    canonicalBytes,
    canonicalBytes.byteLength,
  );
  if (!validation.ok) throw new Error("Golden execution fixture did not validate.");
  const resultBytes = await loadProtocolArtifact(
    "execution/results/slug-normalization.patch",
  );
  const resultReference = createArtifactReference(resultBytes);
  const repository = repositoryReturning(canonicalBytes, {
    [resultReference.digest]: resultBytes,
  });
  const observation = available("fixture", "memory");
  const record: ResolvedValidatedRecord = {
    reference,
    canonicalBytes: validation.canonicalBytes,
    validatedRecord: validation.validatedRecord,
    availability: [observation],
    selectedLocation: observation,
    repository,
    allowedLocationAttempts: [{
      repositoryId: "memory",
      observation,
    }],
    warnings: [],
    failures: [],
  };
  return {
    record,
    resultBytes,
    repositories: [repository],
    resolver: resolverFrom({ memory: repository }),
    context: operationContext(),
  };
}
```

Change `repositoryReturning` from Task 5 to accept:

```ts
artifacts: Readonly<Record<string, Uint8Array>> = {}
```

and implement `getArtifact` as a spy that returns a defensive copy keyed by `reference.digest`.

- [ ] **Step 2: Run artifact tests and observe missing extraction/hydration**

Run:

```bash
yarn test src/declared-artifacts.test.ts src/artifacts.test.ts
```

Expected: FAIL because the declaration and hydration modules are missing.

- [ ] **Step 3: Implement family-specific declaration extraction**

Create `src/declared-artifacts.ts`. Do not recursively treat arbitrary extension objects as artifacts. Traverse only Protocol-defined locations:

```ts
import { parseSha256Digest } from "@jinn-network/evidence-repository";

import type {
  DeclaredArtifact,
  ValidatedRecord,
} from "./contracts.js";

type Descriptor = {
  readonly name: string;
  readonly digest: { readonly sha256: string };
};

function descriptorArtifact(
  descriptor: Descriptor,
  role: string,
): DeclaredArtifact {
  return {
    entityId: descriptor.name,
    reference: {
      digest: parseSha256Digest(`sha256:${descriptor.digest.sha256}`),
    },
    roles: [role],
  };
}

function executionArtifacts(
  document: Extract<ValidatedRecord, {
    family: "execution-evidence";
  }>["value"],
): readonly DeclaredArtifact[] {
  const entities = new Map(
    document["@graph"].map((entity) => [entity["@id"], entity]),
  );
  const roleByEntity = new Map<string, Set<string>>();
  for (const entity of document["@graph"]) {
    for (const property of [
      "object",
      "instrument",
      "result",
      "subjectOf",
      "environment",
      "hasPart",
    ] as const) {
      const raw = entity[property];
      const references = (Array.isArray(raw) ? raw : [raw])
        .filter((value): value is { readonly "@id": string } =>
          typeof value === "object"
          && value !== null
          && typeof (value as { readonly "@id"?: unknown })["@id"] === "string",
        );
      for (const reference of references) {
        if (!entities.has(reference["@id"])) continue;
        const roles = roleByEntity.get(reference["@id"]) ?? new Set<string>();
        roles.add(property);
        roleByEntity.set(reference["@id"], roles);
      }
    }
  }
  return document["@graph"].flatMap((entity) => {
    if (
      typeof entity.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entity.sha256)
    ) return [];
    return [{
      entityId: entity["@id"],
      reference: {
        digest: parseSha256Digest(`sha256:${entity.sha256}`),
      },
      roles: [...(roleByEntity.get(entity["@id"]) ?? [])].sort(),
    }];
  });
}
```

For `result-evaluation`, collect only:

- `statement.subject` as role `subject`;
- `predicate.evaluationMethod` as `evaluation-method`;
- `predicate.evaluationSpecification` as `evaluation-specification`;
- `predicate.evidence` as `supporting-evidence`;
- `predicate.supersedes` as `supersedes`;
- `predicate.disputes` as `disputes`.

For `execution-verification`, collect only:

- `statement.subject` as `subject`;
- `predicate.verificationMethod` as `verification-method`;
- `predicate.verificationPolicy` as `verification-policy`;
- every `predicate.checks[].evidence` as `supporting-evidence`;
- `predicate.supersedes` as `supersedes`;
- `predicate.disputes` as `disputes`.

Merge duplicate `{entityId,digest}` declarations by unioning and lexically sorting roles. Sort the final list by `entityId`, then digest. Dispatch with:

```ts
export function collectDeclaredArtifacts(
  record: ValidatedRecord,
): readonly DeclaredArtifact[] {
  if (record.family === "execution-evidence") {
    return mergeDeclarations(executionArtifacts(record.value));
  }
  if (record.family === "result-evaluation") {
    return mergeDeclarations(evaluationArtifacts(record.value));
  }
  return mergeDeclarations(verificationArtifacts(record.value));
}
```

- [ ] **Step 4: Implement selection, fallback, integrity, and completeness**

Create `src/artifacts.ts` with:

```ts
export interface HydrateArtifactsInput {
  readonly record: ResolvedValidatedRecord;
  readonly request?: ArtifactHydrationRequest;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly context: OperationContext;
}

export interface ArtifactHydrationOutcome {
  readonly results: readonly ArtifactRetrievalResult[];
  readonly completeness: "complete" | "artifact-incomplete";
  readonly warnings: readonly RetrievalWarning[];
  readonly failures: readonly EvidenceRetrievalFailure[];
}
```

Implement these exact phases:

1. Call `collectDeclaredArtifacts(record.validatedRecord)`.
2. With no request, return every declaration as `not-requested` and perform zero resolver/repository calls.
3. Match each selection by exact entity ID, canonical digest, or exact role string. Merge matches by declaration key, with `required` taking precedence.
4. Reject more than `context.maxArtifactCount` unique selected declarations with `EvidenceRetrievalError("INVALID_INPUT", ...)`.
5. Build repository attempts from the already selected record repository followed by the remaining unique `allowedLocationAttempts` repository IDs. Resolve through the injected resolver only.
6. For each selected declaration, try repositories in that order until verified or exhausted. Pass `context.signal`, stop at the deadline, enforce the repository capability and `maxArtifactBytes`, then call `context.consumeArtifactBytes(bytes.byteLength)` before integrity checking. If the shared operation budget is exhausted, expose no bytes, report `too-large`, and add `BYTE_BUDGET_EXCEEDED`.
7. For execution records, pass fetched bytes in a one-entry map to `checkArtifactIntegrity(record.validatedRecord.value, map)` and use the matching entity report. For attestation descriptors, compare `recordDigest(bytes)` to `declaration.reference.digest`.
8. Never expose mismatched, partial, oversized, or denied bytes.
9. Add `REQUIRED_ARTIFACT_UNAVAILABLE` for any required status other than `verified`; add `ARTIFACT_INTEGRITY_MISMATCH` specifically for digest mismatch.
10. Return all declarations in deterministic order, selected results with their requirement, and unselected declarations as `not-requested`.

Update `retrieveKnownReference` after record resolution:

```ts
const hydration = await hydrateArtifacts({
  record,
  request: input.artifacts,
  repositoryResolver: dependencies.repositoryResolver,
  context,
});

return {
  status: "validated",
  result: {
    reference,
    canonicalBytes: record.canonicalBytes,
    validatedRecord: record.validatedRecord,
    discoveryProvenance: [],
    availability: record.availability,
    selectedLocation: record.selectedLocation,
    artifacts: hydration.results,
    completeness: hydration.completeness,
    warnings: [...record.warnings, ...hydration.warnings],
  },
};
```

Change `known-reference.test.ts` to expect `not-requested` declarations rather than an empty artifact array, and retain the assertion that no `getArtifact` call occurs without a request.

- [ ] **Step 5: Run artifact and known-reference suites, then commit**

Run:

```bash
yarn test src/declared-artifacts.test.ts src/artifacts.test.ts src/known-reference.test.ts
yarn test
yarn typecheck
```

Expected: all PASS. Then commit:

```bash
git add packages/evidence/retrieval/src
git commit -m "feat(evidence): hydrate requested artifacts"
```

### Task 7: Validate Candidate Pages and Preserve Canonical Deduplication

**Files:**

- Create: `packages/evidence/retrieval/src/candidates.ts`
- Create: `packages/evidence/retrieval/src/candidates.test.ts`

**Interfaces:**

- Consumes: `CandidateSourceIdentity`, `CandidatePage`, `EvidenceCandidate`, Repository reference parsing, metadata/cursor byte bounds.
- Produces: internal `CandidateAccumulator<ProviderData>` with `append(page, requestedMaximum)`, ordered `groups`, total `examined`, provider issues, and validated continuation state.

- [ ] **Step 1: Write failing candidate contract tests**

Create `src/candidates.test.ts`:

```ts
import { createRecordReference } from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import {
  CandidateAccumulator,
  referenceKey,
} from "./candidates.js";
import { DEFAULT_RETRIEVAL_HARD_LIMITS } from "./contracts.js";

const source = { id: "keyword", version: "1.0.0" };
const first = createRecordReference(
  "execution-evidence",
  new Uint8Array([1]),
);
const second = createRecordReference(
  "result-evaluation",
  new Uint8Array([2]),
);

describe("candidate accumulation", () => {
  test("preserves first-seen order and every duplicate observation", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    accumulator.append({
      source,
      candidates: [
        { reference: first, providerData: { score: 0.9 } },
        { reference: second, providerData: { score: 0.8 } },
        { reference: first, providerData: { score: 0.7 } },
      ],
    }, 3);
    expect(accumulator.groups.map(({ reference }) => referenceKey(reference)))
      .toEqual([referenceKey(first), referenceKey(second)]);
    expect(accumulator.groups[0]?.observations).toHaveLength(2);
    expect(accumulator.groups[0]?.observations.map(({ ordinal }) => ordinal))
      .toEqual([0, 2]);
    expect(accumulator.examined).toBe(3);
  });

  test("rejects a malformed reference as a provider contract violation", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    expect(() => accumulator.append({
      source,
      candidates: [{
        reference: {
          family: "execution-evidence",
          digest: "sha256:not-canonical",
        },
      }],
    } as never, 1)).toThrowError(/canonical reference/);
  });

  test("rejects pages and cursors from another source identity", () => {
    const accumulator = new CandidateAccumulator(
      source,
      DEFAULT_RETRIEVAL_HARD_LIMITS,
    );
    expect(() => accumulator.append({
      source: { id: "other", version: "1.0.0" },
      candidates: [],
    }, 1)).toThrowError(/source identity/);
    expect(() => accumulator.append({
      source,
      candidates: [],
      nextCursor: {
        source: { id: "other", version: "1.0.0" },
        value: "cursor",
      },
    }, 1)).toThrowError(/cursor/);
  });

  test("bounds page length, metadata, cursor, and diagnostics", () => {
    const limits = {
      ...DEFAULT_RETRIEVAL_HARD_LIMITS,
      maxCandidatePageSize: 1,
      maxProviderMetadataBytes: 8,
      maxCursorBytes: 8,
    };
    expect(() => new CandidateAccumulator(source, limits).append({
      source,
      candidates: [
        { reference: first },
        { reference: second },
      ],
    }, 2)).toThrowError(/page/);
    expect(() => new CandidateAccumulator(source, limits).append({
      source,
      candidates: [{ reference: first, providerData: { long: "value" } }],
    }, 1)).toThrowError(/metadata/);
  });
});
```

Add cases for a repeated continuation cursor, a checkpoint from another source, an unsupported provider-data value that cannot be JSON encoded, and duplicate references whose families differ.

- [ ] **Step 2: Run candidate tests and observe the missing accumulator**

Run:

```bash
yarn test src/candidates.test.ts
```

Expected: FAIL because `CandidateAccumulator` and `referenceKey` are missing.

- [ ] **Step 3: Implement strict page validation and ordered grouping**

Create `src/candidates.ts`:

```ts
import {
  parseEvidenceRecordReference,
  type EvidenceRecordReference,
} from "@jinn-network/evidence-repository";

import type {
  CandidateObservation,
  CandidatePage,
  CandidateSourceIssue,
  CandidateSourceIdentity,
  EvidenceRetrievalFailure,
  JsonValue,
  RetrievalHardLimits,
  RetrievalLocationHint,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";
import { assertBoundedJson } from "./operation.js";

export interface CandidateGroup<ProviderData> {
  readonly reference: EvidenceRecordReference;
  readonly observations: readonly CandidateObservation<ProviderData>[];
  readonly locationHints: readonly RetrievalLocationHint[];
}

export function referenceKey(reference: EvidenceRecordReference): string {
  return `${reference.family}:${reference.digest}`;
}

function sameSource(
  left: CandidateSourceIdentity,
  right: CandidateSourceIdentity,
): boolean {
  return left.id === right.id && left.version === right.version;
}

export function assertCandidateSourceIdentity(
  identity: CandidateSourceIdentity,
): void {
  const component = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
  if (!component.test(identity.id) || !component.test(identity.version)) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "Candidate source identity must use bounded logical ID and version components.",
    );
  }
}

function safeProviderIssue(issue: CandidateSourceIssue): CandidateSourceIssue {
  return Object.freeze({
    code: /^[A-Z0-9_.-]{1,64}$/u.test(issue.code)
      ? issue.code
      : "PROVIDER_ISSUE",
    message: "Candidate source reported a classified issue.",
  });
}

export class CandidateAccumulator<ProviderData> {
  readonly #groups = new Map<string, {
    reference: EvidenceRecordReference;
    observations: CandidateObservation<ProviderData>[];
    locationHints: RetrievalLocationHint[];
  }>();
  readonly #seenCursors = new Set<string>();
  #examined = 0;
  #nextCursor: CandidatePage<ProviderData>["nextCursor"];
  #checkpoint: CandidatePage<ProviderData>["checkpoint"];
  #providerIssues: CandidateSourceIssue[] = [];

  constructor(
    readonly source: CandidateSourceIdentity,
    readonly limits: RetrievalHardLimits,
  ) {
    assertCandidateSourceIdentity(source);
  }

  append(page: CandidatePage<ProviderData>, requestedMaximum: number): void {
    if (!sameSource(page.source, this.source)) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        "Candidate page source identity does not match the configured source.",
      );
    }
    if (
      page.candidates.length > requestedMaximum
      || page.candidates.length > this.limits.maxCandidatePageSize
    ) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        "Candidate page exceeds the requested maximum.",
      );
    }
    for (const candidate of page.candidates) {
      let reference;
      try {
        reference = parseEvidenceRecordReference(candidate.reference);
      } catch {
        throw new EvidenceRetrievalError(
          "INVALID_INPUT",
          "Candidate provider returned a non-canonical reference.",
        );
      }
      if (candidate.providerData !== undefined) {
        assertBoundedJson(
          candidate.providerData,
          this.limits.maxProviderMetadataBytes,
          "provider metadata",
        );
      }
      const locationHints = [...(candidate.locationHints ?? [])];
      assertBoundedJson(
        locationHints,
        this.limits.maxProviderMetadataBytes,
        "candidate location hints",
      );
      const observation: CandidateObservation<ProviderData> = {
        source: page.source,
        ordinal: this.#examined++,
        ...(candidate.providerData === undefined
          ? {}
          : {
              providerData: structuredClone(
                candidate.providerData,
              ) as ProviderData,
            }),
        locationHints: structuredClone(locationHints),
      };
      const key = referenceKey(reference);
      const group = this.#groups.get(key) ?? {
        reference,
        observations: [],
        locationHints: [],
      };
      group.observations.push(observation);
      group.locationHints.push(...locationHints);
      this.#groups.set(key, group);
    }
    this.#nextCursor = validateCursor(
      page.nextCursor,
      this.source,
      this.limits.maxCursorBytes,
      this.#seenCursors,
    );
    this.#checkpoint = validateCheckpoint(
      page.checkpoint,
      this.source,
      this.limits.maxCursorBytes,
    );
    const safeIssues = (page.diagnostics?.issues ?? [])
      .map(safeProviderIssue)
      .slice(0, this.limits.maxDiagnostics);
    assertBoundedJson(
      safeIssues,
      this.limits.maxProviderMetadataBytes,
      "candidate diagnostics",
    );
    this.#providerIssues.push(...safeIssues);
    this.#providerIssues = this.#providerIssues.slice(
      0,
      this.limits.maxDiagnostics,
    );
  }

  get groups(): readonly CandidateGroup<ProviderData>[] {
    return [...this.#groups.values()].map((group) => ({
      ...group,
      observations: [...group.observations],
      locationHints: deduplicateLocationHints(group.locationHints).slice(
        0,
        this.limits.maxLocationObservations,
      ),
    }));
  }

  get examined(): number {
    return this.#examined;
  }

  get nextCursor(): CandidatePage<ProviderData>["nextCursor"] {
    return this.#nextCursor;
  }

  get checkpoint(): CandidatePage<ProviderData>["checkpoint"] {
    return this.#checkpoint;
  }

  get providerIssues() {
    return [...this.#providerIssues];
  }
}
```

Implement `validateCursor` and `validateCheckpoint` beside the class. They must:

- accept `undefined`;
- require the same `{id,version}`;
- bound the encoded `value`;
- reject a cursor value already returned during this operation so a provider cannot create an infinite page loop;
- never parse provider `value`;
- return a defensive frozen copy.

Add a test that mutates the provider's original metadata and location-hint
objects after `append`; accumulated provenance must remain unchanged.

Implement `deduplicateLocationHints` with a stable key over `sourceId`,
`repositoryId`, `bindingProfile`, and a local recursively key-sorted
serialization of the `JsonValue` locator. Keep the first observation in
provider order:

```ts
function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key]!)}`,
  ).join(",")}}`;
}
```

This caps only hints sent to the locator; every original hint remains in its
`CandidateObservation` provenance.

Do not classify malformed pages as successful empty pages. Let query orchestration convert the typed invalid-input exception into a `PROVIDER_CONTRACT_VIOLATION` source failure.

- [ ] **Step 4: Run candidate tests and package typecheck**

Run:

```bash
yarn test src/candidates.test.ts
yarn test
yarn typecheck
```

Expected: all PASS. Confirm a duplicate increments `examined` but creates no second group.

- [ ] **Step 5: Commit candidate normalization**

```bash
git add packages/evidence/retrieval/src/candidates.ts packages/evidence/retrieval/src/candidates.test.ts
git commit -m "feat(evidence): normalize retrieval candidates"
```

### Task 8: Add Host-Configured Federation Without a Merge Algorithm

**Files:**

- Create: `packages/evidence/retrieval/src/federation.ts`
- Create: `packages/evidence/retrieval/src/federation.test.ts`
- Modify: `packages/evidence/retrieval/src/contracts.ts`
- Modify: `packages/evidence/retrieval/src/index.ts`
- Modify: `packages/evidence/retrieval/src/test-support.ts`

**Interfaces:**

- Consumes: any number of `CandidateSource<Query, ChildData>` implementations with the same provider-owned query contract.
- Produces: public `FederatedCandidateContribution`, `FederatedCandidateGroup`, `FederatedOrdering`, `FederatedCandidateAllocation`, `FederatedProviderData`, and `createFederatedCandidateSource(options)`.

- [ ] **Step 1: Write failing federation behavior tests**

Create `src/federation.test.ts`:

```ts
test("queries every configured local and public child exactly once", async () => {
  const local = sourceFixture("local", [firstReference]);
  const publicSource = sourceFixture("public", [secondReference]);
  const source = createFederatedCandidateSource({
    identity: { id: "plugin-history", version: "1.0.0" },
    sources: [local.source, publicSource.source],
    allocate: equalAllocation,
    order: providerOrder,
  });
  const page = await source.find(
    { terms: ["retrieval"] },
    candidateOptions(4),
  );
  expect(local.find).toHaveBeenCalledOnce();
  expect(publicSource.find).toHaveBeenCalledOnce();
  expect(page.candidates.map(({ reference }) => reference))
    .toEqual([firstReference, secondReference]);
});

test("merges an exact duplicate and preserves both child observations", async () => {
  const local = sourceFixture("local", [firstReference]);
  const publicSource = sourceFixture("public", [firstReference]);
  const page = await federated(local.source, publicSource.source).find(
    { terms: ["same"] },
    candidateOptions(4),
  );
  expect(page.candidates).toHaveLength(1);
  expect(page.candidates[0]?.providerData.contributions.map(
    ({ source }) => source.id,
  )).toEqual(["local", "public"]);
});

test("reports one child failure while retaining another child's candidates", async () => {
  const local = sourceFixture("local", [firstReference]);
  const remote = failingSourceFixture("public");
  const page = await federated(local.source, remote.source).find(
    { terms: ["partial"] },
    candidateOptions(4),
  );
  expect(page.candidates).toHaveLength(1);
  expect(page.sourceReports).toContainEqual(
    expect.objectContaining({
      source: remote.source.identity,
      status: "failed",
    }),
  );
});
```

Also assert:

- an unconfigured spy source is never called;
- distinct derivative digests remain distinct;
- configured source order is not automatically used as relevance order—the injected `order` callback decides;
- location hints are preserved but do not affect ordering;
- the allocation callback must allocate at least one candidate to every child and a total no greater than `maximumCandidates`;
- fan-out concurrency never exceeds the configured maximum;
- the composite cursor round-trips each child cursor without exposing physical endpoints;
- a composite checkpoint is replayable only if every successful leaf checkpoint is replayable;
- all child failures produce an empty page with failed source reports, not a successful leaf report.

Extend `test-support.ts` with the exact generic fixtures used here:

```ts
export function candidateOptions(
  maximumCandidates: number,
): CandidateSourceOperationOptions {
  return {
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    maximumCandidates,
  };
}

export function sourceFixture(
  id: string,
  references: readonly EvidenceRecordReference[],
) {
  const identity = { id, version: "1.0.0" };
  const find = vi.fn(async (
    _query: unknown,
    operation: CandidateSourceOperationOptions,
  ) => ({
    source: identity,
    candidates: references
      .slice(0, operation.maximumCandidates)
      .map((reference) => ({ reference })),
  }));
  return {
    find,
    source: { identity, find } satisfies CandidateSource<unknown>,
  };
}

export function failingSourceFixture(id: string) {
  const identity = { id, version: "1.0.0" };
  const find = vi.fn(async (): Promise<never> => {
    throw new Error("Synthetic source failure.");
  });
  return {
    find,
    source: { identity, find } satisfies CandidateSource<unknown>,
  };
}

export const equalAllocation: FederatedCandidateAllocation<unknown> = (
  maximum,
  sources,
) => sources.map((_source, index) =>
  Math.floor(maximum / sources.length)
  + (index < maximum % sources.length ? 1 : 0),
);

export const providerOrder: FederatedOrdering<
  unknown,
  unknown,
  undefined
> = (groups) => groups.map(({ reference }) => ({ reference }));

export function federated(
  ...sources: readonly CandidateSource<unknown>[]
) {
  return createFederatedCandidateSource({
    identity: { id: "federated-fixture", version: "1.0.0" },
    sources,
    allocate: equalAllocation,
    order: providerOrder,
  });
}
```

Define the references in `federation.test.ts`:

```ts
const firstReference = createRecordReference(
  "execution-evidence",
  new Uint8Array([1]),
);
const secondReference = createRecordReference(
  "result-evaluation",
  new Uint8Array([2]),
);
```

`providerOrder` is a test provider policy, not a package default.

- [ ] **Step 2: Run federation tests and observe missing public scaffolding**

Run:

```bash
yarn test src/federation.test.ts
```

Expected: FAIL because the federation types and factory are missing.

- [ ] **Step 3: Add explicit provider-owned federation types**

Append to `contracts.ts`:

```ts
export interface FederatedCandidateContribution<ChildData> {
  readonly source: CandidateSourceIdentity;
  readonly ordinal: number;
  readonly providerData?: ChildData;
  readonly locationHints: readonly RetrievalLocationHint[];
}

export interface FederatedCandidateGroup<ChildData> {
  readonly reference: EvidenceRecordReference;
  readonly contributions:
    readonly FederatedCandidateContribution<ChildData>[];
}

export interface FederatedOrderedCandidate<CombinedData> {
  readonly reference: EvidenceRecordReference;
  readonly combinedData?: CombinedData;
}

export type FederatedOrdering<Query, ChildData, CombinedData> = (
  groups: readonly FederatedCandidateGroup<ChildData>[],
  query: Query,
) => readonly FederatedOrderedCandidate<CombinedData>[];

export type FederatedCandidateAllocation<Query> = (
  maximumCandidates: number,
  sources: readonly CandidateSourceIdentity[],
  query: Query,
) => readonly number[];

export interface FederatedProviderData<ChildData, CombinedData> {
  readonly contributions:
    readonly FederatedCandidateContribution<ChildData>[];
  readonly combinedData?: CombinedData;
}

export interface CreateFederatedCandidateSourceOptions<
  Query,
  ChildData,
  CombinedData,
> {
  readonly identity: CandidateSourceIdentity;
  readonly sources: readonly CandidateSource<Query, ChildData>[];
  readonly allocate: FederatedCandidateAllocation<Query>;
  readonly order: FederatedOrdering<Query, ChildData, CombinedData>;
  readonly maximumConcurrency?: number;
}
```

- [ ] **Step 4: Implement bounded fan-out and validated ordering**

Create `src/federation.ts` and export:

```ts
export function createFederatedCandidateSource<
  Query,
  ChildData = unknown,
  CombinedData = unknown,
>(
  options: CreateFederatedCandidateSourceOptions<
    Query,
    ChildData,
    CombinedData
  >,
): CandidateSource<
  Query,
  FederatedProviderData<ChildData, CombinedData>
> {
  if (options.sources.length === 0) {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "A federated candidate source requires at least one configured child.",
    );
  }
  const maximumConcurrency = options.maximumConcurrency ?? 4;
  if (
    !Number.isSafeInteger(maximumConcurrency)
    || maximumConcurrency <= 0
    || maximumConcurrency > 32
  ) {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "Federation concurrency must be an integer from 1 through 32.",
    );
  }
  assertCandidateSourceIdentity(options.identity);
  assertUniqueSourceIdentities(options.sources.map(({ identity }) => identity));
  return Object.freeze({
    identity: Object.freeze({ ...options.identity }),
    find: (query, operation) => findFederatedPage(
      { ...options, maximumConcurrency },
      query,
      operation,
    ),
  });
}
```

`assertUniqueSourceIdentities` calls Task 7's
`assertCandidateSourceIdentity` for every child, then rejects duplicate
`{id,version}` pairs.

`findFederatedPage` must:

1. Validate `allocate(maximumCandidates, childIdentities, query)` returns one positive safe integer per configured child and that the sum is no greater than `maximumCandidates`. Reject a request whose maximum is smaller than the number of configured stores.
2. Decode only the package-owned composite cursor/checkpoint envelope. Validate its composite identity and map opaque child `value` fields back to the exact child identity.
3. Call every configured child through `mapBounded`, passing its allocated maximum, child cursor/checkpoint, the shared abort signal, and remaining timeout.
4. Convert each thrown child error into a safe `SOURCE_FAILED` report without copying the raw adapter error text.
5. Validate each successful page's source identity and maximum. Expand each candidate into a group keyed by exact `{family,digest}`, retaining child identity, child ordinal, provider data, and location hints.
6. Pass all groups to the required `order` callback. Validate that every returned reference belongs to a group and occurs at most once. The callback may omit groups but cannot invent references.
7. Emit candidates in callback order with:

```ts
{
  reference: ordered.reference,
  providerData: {
    contributions: group.contributions,
    ...(ordered.combinedData === undefined
      ? {}
      : { combinedData: ordered.combinedData }),
  },
  locationHints: deduplicatedLocationHints(group.contributions),
}
```

8. Return child leaf reports, a composite cursor if any child has a next cursor, and a composite checkpoint whose `replayable` flag is true only when every successful leaf returned a replayable checkpoint.
9. Never label a child as local or public in a semantic field. Those words may appear in host-chosen source IDs or provider data only.

Export `createFederatedCandidateSource` and its public types from the root. Do not export the package-owned cursor envelope parser.

- [ ] **Step 5: Run federation and package tests, then commit**

Run:

```bash
yarn test src/federation.test.ts
yarn test
yarn typecheck
```

Expected: all PASS. Then commit:

```bash
git add packages/evidence/retrieval/src
git commit -m "feat(evidence): add candidate federation scaffolding"
```

### Task 9: Encode Saved Queries and Honest Snapshot Receipts

**Files:**

- Create: `packages/evidence/retrieval/src/saved-query.ts`
- Create: `packages/evidence/retrieval/src/saved-query.test.ts`
- Modify: `packages/evidence/retrieval/src/contracts.ts`
- Modify: `packages/evidence/retrieval/src/index.ts`

**Interfaces:**

- Consumes: provider-owned `ProviderQueryCodec<Query>`, exact source identity, logical limits, optional acceptance identity, and leaf `CandidateSourceReport` checkpoints.
- Produces: public `RETRIEVAL_SCHEMA_VERSION`, `createSavedEvidenceQuery`, `decodeSavedEvidenceQuery`, `savedEvidenceQueryDigest`, and `createQuerySnapshotReceipt`.

- [ ] **Step 1: Write failing saved-query and snapshot tests**

Create `src/saved-query.test.ts`:

```ts
const codec: ProviderQueryCodec<{ readonly text: string }> = {
  kind: "keyword-query",
  schemaVersion: "2.0.0",
  encode: ({ text }) => ({ text }),
  decode: (value) => ({ text: (value as { readonly text: string }).text }),
};
const source = { id: "plugin-history", version: "3.0.0" };

test("round-trips a provider query without storing provider objects", () => {
  const saved = createSavedEvidenceQuery({
    candidateSourceSet: source,
    sourceQuery: { text: "evidence" },
    codec,
    resultLimit: 10,
    candidateBudget: 40,
  });
  expect(saved).toEqual({
    retrievalSchemaVersion: "1.0.0",
    candidateSourceSet: source,
    providerQuery: {
      kind: "keyword-query",
      schemaVersion: "2.0.0",
      value: { text: "evidence" },
    },
    resultLimit: 10,
    candidateBudget: 40,
  });
  expect(decodeSavedEvidenceQuery(saved, { source, codec }))
    .toEqual({ text: "evidence" });
  expect(JSON.stringify(saved)).not.toContain("find");
});

test("rejects source and provider schema mismatches explicitly", () => {
  const saved = savedFixture();
  expect(() => decodeSavedEvidenceQuery(saved, {
    source: { id: source.id, version: "4.0.0" },
    codec,
  })).toThrowError(/source-set/);
  expect(() => decodeSavedEvidenceQuery(saved, {
    source,
    codec: { ...codec, schemaVersion: "3.0.0" },
  })).toThrowError(/provider query codec/);
});

test("digests semantically identical envelopes deterministically", () => {
  const left = savedFixture({ value: { a: 1, b: 2 } });
  const right = savedFixture({ value: { b: 2, a: 1 } });
  expect(savedEvidenceQueryDigest(left)).toBe(savedEvidenceQueryDigest(right));
});

test("does not call a non-replayable run a frozen snapshot", () => {
  const receipt = createQuerySnapshotReceipt(
    savedFixture(),
    [
      completeReport("local", replayableCheckpoint("local")),
      completeReport("public", undefined),
    ],
    "2026-07-27T12:00:00.000Z",
  );
  expect(receipt.reproducibility).toBe("not-replayable");
  expect(receipt.evaluatedAt).toBe("2026-07-27T12:00:00.000Z");
});
```

Define the local helpers directly above those tests:

```ts
function savedFixture(options: {
  readonly value?: JsonValue;
} = {}): SavedEvidenceQuery {
  return {
    retrievalSchemaVersion: "1.0.0",
    candidateSourceSet: source,
    providerQuery: {
      kind: codec.kind,
      schemaVersion: codec.schemaVersion,
      value: options.value ?? { text: "evidence" },
    },
    resultLimit: 10,
    candidateBudget: 40,
  };
}

function replayableCheckpoint(id: string): CandidateCheckpoint {
  const checkpointSource = { id, version: "1.0.0" };
  return {
    source: checkpointSource,
    value: { generation: 1 },
    replayable: true,
  };
}

function completeReport(
  id: string,
  checkpoint: CandidateCheckpoint | undefined,
): CandidateSourceReport {
  const reportSource = checkpoint?.source ?? { id, version: "1.0.0" };
  return {
    source: reportSource,
    status: "complete",
    candidatesReturned: 1,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}
```

Add tests that reject:

- retrieval schema version other than `1.0.0`;
- non-positive or unsafe limits;
- `candidateBudget < resultLimit`;
- codec `encode` output that is not `JsonValue`;
- reserved secret-bearing keys `credentials`, `password`, `secret`, `token`, `privateEndpoint`, `signedUrl`, and `privateKey`, case-insensitively at any depth;
- mismatched acceptance ID/version during replay;
- a timestamp-only receipt with no source checkpoints being labeled replayable;
- a cursor supplied where a checkpoint is required.

- [ ] **Step 2: Run saved-query tests and observe missing functions**

Run:

```bash
yarn test src/saved-query.test.ts
```

Expected: FAIL because the saved-query implementation is missing.

- [ ] **Step 3: Implement validated envelopes and deterministic digests**

Add to `contracts.ts`:

```ts
export interface CreateSavedEvidenceQueryInput<Query> {
  readonly candidateSourceSet: CandidateSourceIdentity;
  readonly sourceQuery: Query;
  readonly codec: ProviderQueryCodec<Query>;
  readonly resultLimit: number;
  readonly candidateBudget: number;
  readonly acceptancePolicy?: SavedEvidenceQuery["acceptancePolicy"];
}
```

Create `src/saved-query.ts`:

```ts
import { recordDigest } from "@jinn-network/evidence-protocol";

import type {
  CandidateSourceIdentity,
  CandidateSourceReport,
  CreateSavedEvidenceQueryInput,
  JsonValue,
  ProviderQueryCodec,
  QuerySnapshotReceipt,
  SavedEvidenceQuery,
  Sha256Digest,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";

export const RETRIEVAL_SCHEMA_VERSION = "1.0.0" as const;
const encoder = new TextEncoder();
const SECRET_KEYS = new Set([
  "credentials",
  "password",
  "secret",
  "token",
  "privateendpoint",
  "signedurl",
  "privatekey",
]);

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`,
  ).join(",")}}`;
}

function assertJsonValue(value: unknown, path = "$"): asserts value is JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase())) {
        throw new EvidenceRetrievalError(
          "INVALID_INPUT",
          `Saved provider query contains reserved key at ${path}.${key}.`,
        );
      }
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new EvidenceRetrievalError(
    "INVALID_INPUT",
    `Saved provider query is not JSON at ${path}.`,
  );
}

function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJson));
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, freezeJson(child)]),
  ));
}

export function createSavedEvidenceQuery<Query>(
  input: CreateSavedEvidenceQueryInput<Query>,
): SavedEvidenceQuery {
  assertCandidateSourceIdentity(input.candidateSourceSet);
  assertLogicalLimits(input.resultLimit, input.candidateBudget);
  const value: unknown = input.codec.encode(input.sourceQuery);
  assertJsonValue(value);
  if (input.acceptancePolicy?.configuration !== undefined) {
    assertJsonValue(input.acceptancePolicy.configuration);
  }
  const savedValue = freezeJson(structuredClone(value));
  return Object.freeze({
    retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
    candidateSourceSet: Object.freeze({ ...input.candidateSourceSet }),
    providerQuery: Object.freeze({
      kind: input.codec.kind,
      schemaVersion: input.codec.schemaVersion,
      value: savedValue,
    }),
    resultLimit: input.resultLimit,
    candidateBudget: input.candidateBudget,
    ...(input.acceptancePolicy === undefined
      ? {}
      : {
          acceptancePolicy: Object.freeze({
            ...input.acceptancePolicy,
            ...(input.acceptancePolicy.configuration === undefined
              ? {}
              : {
                  configuration: freezeJson(structuredClone(
                    input.acceptancePolicy.configuration,
                  )),
                }),
          }),
        }),
  });
}

export function savedEvidenceQueryDigest(
  query: SavedEvidenceQuery,
): Sha256Digest {
  validateSavedEnvelope(query);
  return recordDigest(encoder.encode(canonicalJson(query as unknown as JsonValue)));
}

export function decodeSavedEvidenceQuery<Query>(
  saved: SavedEvidenceQuery,
  expected: {
    readonly source: CandidateSourceIdentity;
    readonly codec: ProviderQueryCodec<Query>;
    readonly acceptance?: { readonly id: string; readonly version: string };
  },
): Query {
  validateSavedEnvelope(saved);
  assertExactSource(saved.candidateSourceSet, expected.source);
  if (
    saved.providerQuery.kind !== expected.codec.kind
    || saved.providerQuery.schemaVersion !== expected.codec.schemaVersion
  ) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "Saved query does not match the provider query codec.",
    );
  }
  assertAcceptanceMatch(saved.acceptancePolicy, expected.acceptance);
  try {
    return expected.codec.decode(saved.providerQuery.value);
  } catch {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "Provider query codec rejected the saved query value.",
    );
  }
}
```

Import Task 7's internal `assertCandidateSourceIdentity`. Implement
`validateSavedEnvelope`, `assertLogicalLimits`, `assertExactSource`, and
`assertAcceptanceMatch` with safe, content-free error text.
`validateSavedEnvelope` must validate the saved source identity and invoke
`assertJsonValue` on `providerQuery.value` and on
`acceptancePolicy.configuration` when present, so the same secret-key
prohibition applies to both persisted JSON regions. It must also require
provider kind/schema and acceptance ID/version strings to match the same
bounded logical-component pattern used for source identities.

- [ ] **Step 4: Build receipts only from real leaf checkpoints**

Implement:

```ts
export function createQuerySnapshotReceipt(
  saved: SavedEvidenceQuery,
  reports: readonly CandidateSourceReport[],
  evaluatedAt: string,
): QuerySnapshotReceipt {
  validateSavedEnvelope(saved);
  if (!Number.isFinite(Date.parse(evaluatedAt))) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "evaluatedAt must be an ISO-8601 timestamp.",
    );
  }
  const completed = reports.filter(({ status }) => status === "complete");
  const checkpointed = completed.flatMap(({ source, checkpoint }) =>
    checkpoint === undefined ? [] : [{ source, checkpoint }],
  );
  const reproducibility =
    completed.length > 0
    && checkpointed.length === completed.length
    && checkpointed.every(({ checkpoint }) => checkpoint.replayable)
      ? "replayable"
      : "not-replayable";
  return Object.freeze({
    savedQueryDigest: savedEvidenceQueryDigest(saved),
    sourceSet: Object.freeze({ ...saved.candidateSourceSet }),
    sources: checkpointed,
    evaluatedAt,
    reproducibility,
  });
}
```

Export only the public constants/functions from `index.ts`. This module performs no storage or provider lookup.

- [ ] **Step 5: Run saved-query and package tests, then commit**

Run:

```bash
yarn test src/saved-query.test.ts
yarn test
yarn typecheck
```

Expected: all PASS. Then commit:

```bash
git add packages/evidence/retrieval/src
git commit -m "feat(evidence): add saved query envelopes"
```

### Task 10: Orchestrate Query Over-Fetch and Publish the Complete Facade

**Files:**

- Create: `packages/evidence/retrieval/src/query.ts`
- Create: `packages/evidence/retrieval/src/query.test.ts`
- Create: `packages/evidence/retrieval/src/retrieval.ts`
- Create: `packages/evidence/retrieval/src/retrieval.test.ts`
- Modify: `packages/evidence/retrieval/src/known-reference.ts`
- Modify: `packages/evidence/retrieval/src/index.ts`
- Modify: `packages/evidence/retrieval/src/test-support.ts`

**Interfaces:**

- Consumes: completed known-reference, candidate, resolution, artifact, saved-query, operation, acceptance, and source-report behavior.
- Produces: internal `queryEvidence(dependencies, input, options)` and the public `createEvidenceRetrieval(options): EvidenceRetrieval`; both public operations now have their final semantics.

- [ ] **Step 1: Write failing query outcome and over-fetch tests**

Create `src/query.test.ts`. Use conforming fixture bytes behind synthetic locations and repositories so candidate hits still travel through the exact-byte path:

```ts
test("over-fetches through invalid candidates until resultLimit is filled", async () => {
  const fixture = await queryFixture({
    pages: [
      [unavailableReference, firstValidReference],
      [nonconformingReference, secondValidReference],
    ],
  });
  const outcome = await queryEvidence(
    fixture.dependencies,
    {
      candidateSource: fixture.source,
      sourceQuery: { text: "history" },
      resultLimit: 2,
      candidateBudget: 4,
      diagnostics: "detailed",
    },
  );
  expect(outcome.results.map(({ reference }) => reference)).toEqual([
    firstValidReference,
    secondValidReference,
  ]);
  expect(fixture.find).toHaveBeenCalledTimes(2);
  expect(outcome.status).toBe("partial");
  expect(outcome.diagnostics?.examinedCandidates).toBe(4);
});

test("preserves provider order instead of sorting scores", async () => {
  const fixture = await queryFixture({
    pages: [[
      candidate(secondValidReference, { score: 0.1 }),
      candidate(firstValidReference, { score: 999 }),
    ]],
  });
  const outcome = await runQuery(fixture, { resultLimit: 2, candidateBudget: 2 });
  expect(outcome.results.map(({ reference }) => reference)).toEqual([
    secondValidReference,
    firstValidReference,
  ]);
});

test("deduplicates an exact reference and retains all examined observations", async () => {
  const fixture = await queryFixture({
    pages: [[
      candidate(firstValidReference, { store: "local" }),
      candidate(firstValidReference, { store: "public" }),
    ]],
  });
  const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 2 });
  expect(outcome.results).toHaveLength(1);
  expect(outcome.results[0]?.discoveryProvenance).toHaveLength(2);
});

test("stops at candidateBudget and reports why the limit was not filled", async () => {
  const fixture = await queryFixture({
    pages: [
      [candidate(unavailableReference)],
      [candidate(firstValidReference)],
    ],
  });
  const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 1 });
  expect(outcome).toMatchObject({
    status: "partial",
    results: [],
    diagnostics: {
      failures: expect.arrayContaining([
        expect.objectContaining({ code: "CANDIDATE_BUDGET_EXCEEDED" }),
      ]),
    },
  });
  expect(fixture.find).toHaveBeenCalledOnce();
});
```

Add tests for:

- a successful empty source returns `complete` with `[]`;
- all leaf source reports failed returns `failed`;
- one failed and one successful federated leaf returns `partial` and keeps validated results;
- a record failure, acceptance rejection, or required artifact failure makes a meaningful response `partial`;
- an optional artifact failure is a warning but does not alone make the query partial;
- `resultLimit` is never exceeded;
- page requests use `min(remaining candidate budget, maxCandidatePageSize)`;
- cursor continuation is opaque, source-bound, and returned unchanged except by the provider;
- checkpoint is passed to every provider page;
- a provider returning the same cursor twice becomes `PROVIDER_CONTRACT_VIOLATION`, not an infinite loop;
- unknown provider data survives into `discoveryProvenance`;
- acceptance runs only after Protocol validation and receives no provider metadata;
- rejected evidence does not appear in `results`;
- caller abort and timeout propagate to provider, locator, resolver, record, and artifact calls;
- `savedQuery` source identity, result limit, candidate budget, and acceptance identity must match the live invocation;
- a snapshot receipt is emitted only from the actual reports for that run.

Create `src/retrieval.test.ts`:

```ts
test("constructs one facade whose two operations share host ports and limits", async () => {
  const fixture = await facadeFixture();
  const retrieval = createEvidenceRetrieval(fixture.options);
  await expect(retrieval.retrieve({ reference: fixture.reference }))
    .resolves.toMatchObject({ status: "validated" });
  await expect(retrieval.query({
    candidateSource: fixture.source,
    sourceQuery: { text: "fixture" },
    resultLimit: 1,
    candidateBudget: 1,
  })).resolves.toMatchObject({
    results: [expect.objectContaining({ reference: fixture.reference })],
  });
});

test("rejects missing ports and over-limit operation input before I/O", () => {
  expect(() => createEvidenceRetrieval({} as never))
    .toThrowError(/locator, locationPolicy, and repositoryResolver/);
});
```

At the top of `query.test.ts`, create the reference set once:

```ts
const {
  firstValidReference,
  secondValidReference,
  unavailableReference,
  nonconformingReference,
} = await createQueryReferenceSet();

const candidate = <ProviderData>(
  reference: EvidenceRecordReference,
  providerData?: ProviderData,
): EvidenceCandidate<ProviderData> => ({
  reference,
  ...(providerData === undefined ? {} : { providerData }),
});
```

Extend `test-support.ts` with a deterministic paged source and exact-byte backing map:

```ts
export async function createQueryReferenceSet() {
  const executionBytes = await loadProtocolFixture("execution-evidence");
  const evaluationBytes = await loadProtocolFixture("result-evaluation");
  const nonconformingBytes = new TextEncoder().encode("{}");
  return {
    firstValidReference: createRecordReference(
      "execution-evidence",
      executionBytes,
    ),
    secondValidReference: createRecordReference(
      "result-evaluation",
      evaluationBytes,
    ),
    unavailableReference: createRecordReference(
      "execution-evidence",
      new TextEncoder().encode("unavailable"),
    ),
    nonconformingReference: createRecordReference(
      "execution-evidence",
      nonconformingBytes,
    ),
    bytesByReference: new Map([
      [
        referenceKey(createRecordReference(
          "execution-evidence",
          executionBytes,
        )),
        executionBytes,
      ],
      [
        referenceKey(createRecordReference(
          "result-evaluation",
          evaluationBytes,
        )),
        evaluationBytes,
      ],
      [
        referenceKey(createRecordReference(
          "execution-evidence",
          nonconformingBytes,
        )),
        nonconformingBytes,
      ],
    ]),
  };
}

export interface QueryFixtureOptions<ProviderData = unknown> {
  readonly pages: readonly (
    readonly (
      | EvidenceRecordReference
      | EvidenceCandidate<ProviderData>
    )[]
  )[];
  readonly sourceReports?: readonly CandidateSourceReport[];
  readonly artifactByDigest?: Readonly<Record<string, Uint8Array>>;
}

export async function queryFixture<ProviderData = unknown>(
  options: QueryFixtureOptions<ProviderData>,
) {
  const references = await createQueryReferenceSet();
  const repository = repositoryReturning(null, options.artifactByDigest);
  repository.getRecord.mockImplementation(async (
    reference: EvidenceRecordReference,
  ) => {
    const bytes = references.bytesByReference.get(referenceKey(reference));
    return bytes === undefined ? null : Uint8Array.from(bytes);
  });
  const locator = {
    locate: vi.fn(async (reference: EvidenceRecordReference) => {
      return references.bytesByReference.has(referenceKey(reference))
        ? [available("fixture", "memory")]
        : [];
    }),
  };
  const repositoryResolver = resolverFrom({ memory: repository });
  const identity = { id: "paged-fixture", version: "1.0.0" };
  const find = vi.fn(async (
    _query: unknown,
    operation: CandidateSourceOperationOptions,
  ) => {
    const pageIndex = operation.cursor === undefined
      ? 0
      : Number(operation.cursor.value);
    const page = options.pages[pageIndex] ?? [];
    const candidates = page
      .slice(0, operation.maximumCandidates)
      .map((value) =>
        "reference" in value ? value : { reference: value },
      );
    const nextIndex = pageIndex + 1;
    return {
      source: identity,
      candidates,
      ...(nextIndex >= options.pages.length
        ? {}
        : {
            nextCursor: {
              source: identity,
              value: nextIndex,
            },
          }),
      ...(options.sourceReports === undefined
        ? {}
        : { sourceReports: options.sourceReports }),
    };
  });
  const source = { identity, find } satisfies CandidateSource<
    unknown,
    ProviderData
  >;
  const dependencies = {
    locator,
    locationPolicy: policyInObservedOrder(),
    repositoryResolver,
    hardLimits: resolveHardLimits(),
  };
  return {
    ...references,
    source,
    find,
    repository,
    locator,
    repositoryResolver,
    dependencies,
  };
}

export async function runQuery<ProviderData>(
  fixture: Awaited<ReturnType<typeof queryFixture<ProviderData>>>,
  limits: { readonly resultLimit: number; readonly candidateBudget: number },
) {
  return queryEvidence(
    fixture.dependencies,
    {
      candidateSource: fixture.source,
      sourceQuery: { kind: "fixture" },
      diagnostics: "detailed",
      ...limits,
    },
  );
}

export async function facadeFixture() {
  const fixture = await queryFixture({
    pages: [[(await createQueryReferenceSet()).firstValidReference]],
  });
  const options = {
    locator: fixture.locator,
    locationPolicy: policyInObservedOrder(),
    repositoryResolver: fixture.repositoryResolver,
  };
  return {
    ...fixture,
    options,
    retrieval: createEvidenceRetrieval(options),
    reference: fixture.firstValidReference,
  };
}
```

For scenario-specific tests—acceptance, artifacts, cancellation, source reports—extend this fixture through explicit option fields in the same file and assert each injected spy. Do not weaken the default exact-byte path.

- [ ] **Step 2: Run query and facade tests and observe missing orchestration**

Run:

```bash
yarn test src/query.test.ts src/retrieval.test.ts
```

Expected: FAIL because `queryEvidence` and `createEvidenceRetrieval` are missing.

- [ ] **Step 3: Implement one-candidate resolution with post-validation acceptance**

In `src/query.ts`, define:

```ts
export interface QueryDependencies {
  readonly locator: EvidenceRecordLocator;
  readonly locationPolicy: EvidenceLocationPolicy;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly hardLimits: RetrievalHardLimits;
}

interface CandidateResolution<ProviderData> {
  readonly result?: ValidatedEvidenceResult<ProviderData>;
  readonly failures: readonly EvidenceRetrievalFailure[];
  readonly warnings: readonly RetrievalWarning[];
}
```

Implement `resolveCandidateGroup` in this order:

```ts
const resolved = await resolveValidatedRecord({
  reference: group.reference,
  hints: group.locationHints,
  locator: dependencies.locator,
  locationPolicy: dependencies.locationPolicy,
  repositoryResolver: dependencies.repositoryResolver,
  context,
});
if (!resolved.ok) {
  return {
    failures: [...resolved.failures],
    warnings: [],
  };
}

if (input.acceptance) {
  const decision = await input.acceptance.evaluate(
    resolved.record.validatedRecord,
  );
  if (decision.status === "rejected") {
    return {
      failures: [createEvidenceRetrievalFailure({
        code: "ACCEPTANCE_REJECTED",
        stage: "acceptance",
        message: `Validated evidence was rejected by ${input.acceptance.id}@${input.acceptance.version}.`,
        reference: group.reference,
      })],
      warnings: resolved.record.warnings,
    };
  }
}

const hydration = await hydrateArtifacts({
  record: resolved.record,
  request: input.artifacts,
  repositoryResolver: dependencies.repositoryResolver,
  context,
});
return {
  result: {
    reference: group.reference,
    canonicalBytes: resolved.record.canonicalBytes,
    validatedRecord: resolved.record.validatedRecord,
    discoveryProvenance: group.observations,
    availability: resolved.record.availability,
    selectedLocation: resolved.record.selectedLocation,
    artifacts: hydration.results,
    completeness: hydration.completeness,
    warnings: [...resolved.record.warnings, ...hydration.warnings],
  },
  failures: [...resolved.record.failures, ...hydration.failures],
  warnings: hydration.warnings,
};
```

Catch acceptance exceptions and classify them as `ACCEPTANCE_REJECTED` with safe text. Never pass candidate provider data into the acceptance port.

- [ ] **Step 4: Implement bounded page consumption and final statuses**

Implement:

```ts
export async function queryEvidence<Query, ProviderData>(
  dependencies: QueryDependencies,
  input: QueryEvidenceInput<Query, ProviderData>,
  operationOptions?: RetrievalOperationOptions,
): Promise<QueryEvidenceOutcome<ProviderData>> {
  validateQueryBounds(
    input.resultLimit,
    input.candidateBudget,
    dependencies.hardLimits,
  );
  validateInitialContinuation(
    input.candidateSource.identity,
    input.cursor,
    input.checkpoint,
    dependencies.hardLimits,
  );
  validateLiveAcceptanceIdentity(input.acceptance);
  validateSavedInvocation(input);

  const context = createOperationContext(
    dependencies.hardLimits,
    operationOptions,
  );
  const accumulator = new CandidateAccumulator<ProviderData>(
    input.candidateSource.identity,
    dependencies.hardLimits,
  );
  const results: ValidatedEvidenceResult<ProviderData>[] = [];
  const resultByKey = new Map<string, ValidatedEvidenceResult<ProviderData>>();
  const attempted = new Set<string>();
  const failures: EvidenceRetrievalFailure[] = [];
  let providerIssues: CandidateSourceIssue[] = [];
  let cursor = input.cursor;
  let sourceReports: CandidateSourceReport[] = [];

  try {
    while (
      results.length < input.resultLimit
      && accumulator.examined < input.candidateBudget
    ) {
      const maximumCandidates = Math.min(
        input.candidateBudget - accumulator.examined,
        dependencies.hardLimits.maxCandidatePageSize,
      );
      let page;
      try {
        page = await input.candidateSource.find(input.sourceQuery, {
          signal: context.signal,
          timeoutMs: context.remainingMs(),
          maximumCandidates,
          ...(cursor === undefined ? {} : { cursor }),
          ...(input.checkpoint === undefined
            ? {}
            : { checkpoint: input.checkpoint }),
        });
        accumulator.append(page, maximumCandidates);
      } catch (error) {
        const sourceFailure = classifySourceError(
          error,
          input.candidateSource.identity,
          context,
        );
        failures.push(sourceFailure);
        sourceReports = mergeSourceReports(sourceReports, [{
          source: input.candidateSource.identity,
          status: "failed",
          candidatesReturned: 0,
          failure: sourceFailure,
        }]);
        break;
      }

      sourceReports = mergeSourceReports(
        sourceReports,
        normalizeSourceReports(
          page.sourceReports ?? [{
            source: page.source,
            status: "complete",
            candidatesReturned: page.candidates.length,
            ...(page.checkpoint === undefined
              ? {}
              : { checkpoint: page.checkpoint }),
          }],
          dependencies.hardLimits,
        ),
      );
      providerIssues = accumulator.providerIssues.slice(
        0,
        dependencies.hardLimits.maxDiagnostics,
      );

      for (const group of accumulator.groups) {
        const key = referenceKey(group.reference);
        const existing = resultByKey.get(key);
        if (existing) {
          const updated = {
            ...existing,
            discoveryProvenance: group.observations,
          };
          results[results.indexOf(existing)] = updated;
          resultByKey.set(key, updated);
        }
      }
      const pending = accumulator.groups.filter((group) => {
        const key = referenceKey(group.reference);
        if (attempted.has(key) || resultByKey.has(key)) return false;
        attempted.add(key);
        return true;
      });
      for (
        let offset = 0;
        offset < pending.length && results.length < input.resultLimit;
        offset += dependencies.hardLimits.maxRecordConcurrency
      ) {
        const batch = pending.slice(
          offset,
          offset + dependencies.hardLimits.maxRecordConcurrency,
        );
        const resolvedBatch = await mapBounded(
          batch,
          dependencies.hardLimits.maxRecordConcurrency,
          (group) => resolveCandidateGroup(
            dependencies,
            input,
            group,
            context,
          ),
        );
        for (const resolved of resolvedBatch) {
          failures.push(...resolved.failures);
          if (!resolved.result || results.length >= input.resultLimit) continue;
          results.push(resolved.result);
          resultByKey.set(
            referenceKey(resolved.result.reference),
            resolved.result,
          );
        }
      }

      cursor = accumulator.nextCursor;
      if (!cursor || page.candidates.length === 0) break;
    }

    if (
      results.length < input.resultLimit
      && accumulator.examined >= input.candidateBudget
      && cursor
    ) {
      failures.push(createEvidenceRetrievalFailure({
        code: "CANDIDATE_BUDGET_EXCEEDED",
        stage: "candidate",
        message: "Candidate budget was exhausted before the result limit was filled.",
      }));
    }

    const allSourcesFailed =
      sourceReports.length > 0
      && sourceReports.every(({ status }) => status === "failed");
    const status = allSourcesFailed && results.length === 0
      ? "failed"
      : failures.length > 0
        || sourceReports.some(({ status }) => status !== "complete")
        ? "partial"
        : "complete";
    const diagnostics = buildDiagnostics(
      input.diagnostics,
      accumulator,
      failures,
      providerIssues,
      dependencies.hardLimits.maxDiagnostics,
    );
    return {
      status,
      results,
      sourceReports,
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
      ...(input.savedQuery === undefined
        ? {}
        : {
            snapshotReceipt: createQuerySnapshotReceipt(
              input.savedQuery,
              sourceReports,
              new Date().toISOString(),
            ),
          }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    };
  } finally {
    context.dispose();
  }
}
```

Implement the named helpers with these constraints:

- `validateInitialContinuation` requires exact source identity and bounds opaque cursor/checkpoint JSON.
- `validateLiveAcceptanceIdentity` permits `undefined` or requires bounded logical ID/version components before either value can enter a failure or receipt.
- `validateSavedInvocation` requires saved source, limits, and acceptance identity/version to equal the live invocation; it does not inspect `sourceQuery`.
- `classifySourceError` emits `TIMED_OUT`, `OPERATION_ABORTED`, or `PROVIDER_CONTRACT_VIOLATION`/`SOURCE_FAILED` without copying the query or provider exception.
- `normalizeSourceReports` validates bounded logical source identities, status, non-negative candidate counts, and source-bound checkpoints; it replaces provider-supplied failure messages with the package's safe classified message for that failure code.
- `mergeSourceReports` sums `candidatesReturned`, keeps the latest checkpoint, and combines status for an exact leaf as follows: all complete is `complete`, all failed is `failed`, and any mixture is `partial`.
- `buildDiagnostics("summary", ...)` strips conformance diagnostics and truncates safe failures; `"detailed"` retains bounded conformance diagnostics; `undefined` returns no diagnostics.
- A source exception before any source report still produces one failed report, making the outcome `failed`.
- A successful empty page creates a complete source report, making the outcome `complete`.

The shown batching preserves provider order because `mapBounded` returns outputs by input index. It may finish the already-scheduled bounded batch after the limit is filled, but it must not expose more than `resultLimit` or schedule another batch.

- [ ] **Step 5: Compose the public factory, run all tests, and commit**

Create `src/retrieval.ts`:

```ts
import type {
  CreateEvidenceRetrievalOptions,
  EvidenceRetrieval,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";
import { retrieveKnownReference } from "./known-reference.js";
import { resolveHardLimits } from "./operation.js";
import { queryEvidence } from "./query.js";

export function createEvidenceRetrieval(
  options: CreateEvidenceRetrievalOptions,
): EvidenceRetrieval {
  if (!options.locator || !options.locationPolicy || !options.repositoryResolver) {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "locator, locationPolicy, and repositoryResolver are required.",
    );
  }
  const dependencies = Object.freeze({
    locator: options.locator,
    locationPolicy: options.locationPolicy,
    repositoryResolver: options.repositoryResolver,
    hardLimits: resolveHardLimits(options.hardLimits),
  });
  return Object.freeze({
    retrieve: (input, operationOptions) =>
      retrieveKnownReference(dependencies, input, operationOptions),
    query: (input, operationOptions) =>
      queryEvidence(dependencies, input, operationOptions),
  });
}
```

Export only `createEvidenceRetrieval` from `index.ts`; keep `queryEvidence`, `retrieveKnownReference`, and dependency bundles internal.

Run:

```bash
yarn test src/query.test.ts src/retrieval.test.ts
yarn test
yarn typecheck
```

Expected: all PASS. Then commit:

```bash
git add packages/evidence/retrieval/src
git commit -m "feat(evidence): orchestrate evidence queries"
```

### Task 11: Harden Diagnostics and Add Content-Minimizing Telemetry

**Files:**

- Create: `packages/evidence/retrieval/src/telemetry.ts`
- Create: `packages/evidence/retrieval/src/telemetry.test.ts`
- Create: `packages/evidence/retrieval/src/security.test.ts`
- Modify: `packages/evidence/retrieval/src/candidates.ts`
- Modify: `packages/evidence/retrieval/src/query.ts`
- Modify: `packages/evidence/retrieval/src/known-reference.ts`
- Modify: `packages/evidence/retrieval/src/retrieval.ts`
- Modify: `packages/evidence/retrieval/src/test-support.ts`

**Interfaces:**

- Consumes: optional host `RetrievalTelemetry`, operation IDs/timings, classified failures, counts, byte totals, source identity, and a credential-free binding profile.
- Produces: internal `createTelemetrySession(sink, context, operation)`, safe diagnostic normalization, and instrumented public operations that never expose content through telemetry.

- [ ] **Step 1: Write failing telemetry and hostile-input tests**

Create `src/telemetry.test.ts`:

```ts
test("telemetry contains counts and classifications but no content", async () => {
  const events: RetrievalTelemetryEvent[] = [];
  const privateQuery = "customer-secret-task";
  const maliciousSnippet = "<script>steal()</script>";
  const fixture = await facadeFixture({
    providerData: { snippet: maliciousSnippet },
    telemetry: { emit: (event) => events.push(event) },
  });
  await fixture.retrieval.query({
    candidateSource: fixture.source,
    sourceQuery: { text: privateQuery },
    resultLimit: 1,
    candidateBudget: 1,
  });
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(privateQuery);
  expect(serialized).not.toContain(maliciousSnippet);
  expect(serialized).not.toContain("Golden synthetic Execution Evidence");
  expect(events).toContainEqual(expect.objectContaining({
    operation: "query",
    stage: "completed",
    candidateCount: 1,
    resultCount: 1,
  }));
});

test("a failing telemetry sink never changes retrieval semantics", async () => {
  const fixture = await facadeFixture({
    telemetry: { emit: () => { throw new Error("sink unavailable"); } },
  });
  await expect(fixture.retrieval.retrieve({ reference: fixture.reference }))
    .resolves.toMatchObject({ status: "validated" });
});
```

Create `src/security.test.ts` and assert:

```ts
test("candidate location data cannot construct or bypass a binding", async () => {
  const { firstValidReference: reference } =
    await createQueryReferenceSet();
  const resolver = vi.fn().mockResolvedValue(null);
  const fixture = await queryFixture({
    pages: [[{
      reference,
      locationHints: [{
        sourceId: "attacker",
        repositoryId: "not-registered",
        publishedLocation: {
          bindingProfile: "https",
          locator: {
            url: "https://attacker.invalid/private?credential=secret",
          },
        },
      }],
    }]],
  });
  await queryEvidence(
    {
      ...fixture.dependencies,
      locator: {
        locate: vi.fn(async (_reference, hints) =>
          hints.map((hint) => ({
            observationId: `hint:${hint.repositoryId}`,
            sourceId: hint.sourceId,
            status: "available" as const,
            repositoryId: hint.repositoryId,
            publishedLocation: hint.publishedLocation,
          })),
        ),
      },
      repositoryResolver: { resolve: resolver },
      locationPolicy: {
      select: (_reference, observations) =>
        observations
          .filter(({ repositoryId }) => repositoryId === "registered")
          .map((observation) => ({
            repositoryId: "registered",
            observation,
          })),
      },
    },
    {
      candidateSource: fixture.source,
      sourceQuery: { kind: "attack" },
      resultLimit: 1,
      candidateBudget: 1,
    },
  );
  expect(resolver).not.toHaveBeenCalledWith(
    "https://attacker.invalid/private?credential=secret",
    expect.anything(),
  );
  expect(resolver).not.toHaveBeenCalledWith("not-registered", expect.anything());
});

test("provider issue text is bounded and never rendered as trusted content", async () => {
  const fixture = await queryFixture({
    pages: [[]],
    diagnostics: {
      issues: [{
        code: "REMOTE_WARNING",
        message: "secret ".repeat(10_000),
      }],
    },
  });
  const outcome = await runQuery(
    fixture,
    { resultLimit: 1, candidateBudget: 1 },
  );
  expect(JSON.stringify(outcome.diagnostics).length).toBeLessThan(32_000);
  expect(outcome.diagnostics?.providerIssues).toEqual([{
    code: "REMOTE_WARNING",
    message: "Candidate source reported a classified issue.",
  }]);
});
```

Also assert only the explicitly supplied `candidateSource` receives the query and provider data remains available in result provenance without appearing in telemetry or safe failure messages.

Extend the Task 10 test support in this task:

```ts
export interface FacadeFixtureOptions {
  readonly providerData?: unknown;
  readonly telemetry?: RetrievalTelemetry;
}

export async function facadeFixture(
  options: FacadeFixtureOptions = {},
) {
  const references = await createQueryReferenceSet();
  const fixture = await queryFixture({
    pages: [[{
      reference: references.firstValidReference,
      ...(options.providerData === undefined
        ? {}
        : { providerData: options.providerData }),
    }]],
  });
  const retrievalOptions = {
    locator: fixture.locator,
    locationPolicy: policyInObservedOrder(),
    repositoryResolver: fixture.repositoryResolver,
    ...(options.telemetry === undefined
      ? {}
      : { telemetry: options.telemetry }),
  };
  return {
    ...fixture,
    options: retrievalOptions,
    retrieval: createEvidenceRetrieval(retrievalOptions),
    reference: references.firstValidReference,
  };
}
```

Add optional `diagnostics?: CandidateSourceDiagnostics` to `QueryFixtureOptions` and copy it onto every synthetic page when supplied.

- [ ] **Step 2: Run hardening tests and observe missing telemetry**

Run:

```bash
yarn test src/telemetry.test.ts src/security.test.ts
```

Expected: FAIL because telemetry is not emitted and provider issue messages are not normalized.

- [ ] **Step 3: Implement an allowlisted telemetry session**

Create `src/telemetry.ts`:

```ts
import type {
  RetrievalTelemetry,
  RetrievalTelemetryEvent,
} from "./contracts.js";
import type { OperationContext } from "./operation.js";

export interface TelemetrySession {
  emit(
    event: Omit<RetrievalTelemetryEvent, "operationId" | "operation">,
  ): Promise<void>;
}

export function createTelemetrySession(
  sink: RetrievalTelemetry | undefined,
  context: OperationContext,
  operation: RetrievalTelemetryEvent["operation"],
): TelemetrySession {
  return Object.freeze({
    async emit(event) {
      if (!sink) return;
      const safe: RetrievalTelemetryEvent = Object.freeze({
        operationId: context.operationId,
        operation,
        stage: event.stage,
        ...(event.source === undefined ? {} : {
          source: Object.freeze({
            id: event.source.id,
            version: event.source.version,
          }),
        }),
        ...(event.bindingProfile === undefined
          ? {}
          : { bindingProfile: event.bindingProfile }),
        ...(event.durationMs === undefined
          ? {}
          : { durationMs: event.durationMs }),
        ...(event.candidateCount === undefined
          ? {}
          : { candidateCount: event.candidateCount }),
        ...(event.resultCount === undefined
          ? {}
          : { resultCount: event.resultCount }),
        ...(event.failureCode === undefined
          ? {}
          : { failureCode: event.failureCode }),
        ...(event.bytes === undefined ? {} : { bytes: event.bytes }),
      });
      try {
        void Promise.resolve(sink.emit(safe)).catch(() => {});
      } catch {
        // Observability is intentionally non-authoritative.
      }
    },
  });
}
```

This allowlist is intentionally closed: do not add reference digests, raw query values, provider data, location objects, or bytes.

- [ ] **Step 4: Verify diagnostic normalization and instrument operation stages**

Retain the Task 7 `safeProviderIssue` normalization:

```ts
function safeProviderIssue(issue: CandidateSourceIssue): CandidateSourceIssue {
  return Object.freeze({
    code: /^[A-Z0-9_.-]{1,64}$/u.test(issue.code)
      ? issue.code
      : "PROVIDER_ISSUE",
    message: "Candidate source reported a classified issue.",
  });
}
```

Keep it before the encoded-byte check and `maxDiagnostics` slice.

Add optional `telemetry?: RetrievalTelemetry` to both internal dependency bundles. In `createEvidenceRetrieval`, copy `options.telemetry` into those bundles. In `retrieveKnownReference` and `queryEvidence`, create a session from the existing operation context and emit:

- `started` immediately after context construction;
- `source` after each provider page or source failure, with identity, duration, candidate count, and failure code only;
- `record` after each record attempt finishes, with the selected location's binding profile when present, verified byte count, duration, and failure code only;
- `artifact` once per result, with total verified artifact bytes and failure classification only;
- `completed` in a `finally`-safe path, with total duration, examined candidate count, result count, and operation-level failure code.

Use `await telemetry.emit(...)`; its implementation absorbs sink failures. Add no telemetry calls inside Protocol or Repository packages.

For detailed diagnostics:

- cap failures and issues at `maxDiagnostics`;
- copy only known fields from typed failures;
- cap conformance diagnostics at `maxDiagnostics`;
- do not copy adapter exception messages;
- do not copy `providerData`, location locator objects, query values, canonical bytes, or artifact bytes.

- [ ] **Step 5: Run security, telemetry, and full suites, then commit**

Run:

```bash
yarn test src/telemetry.test.ts src/security.test.ts
yarn test
yarn typecheck
```

Expected: all PASS. Inspect failed-test output once to ensure Vitest snapshots do not capture private fixture content. Then commit:

```bash
git add packages/evidence/retrieval/src
git commit -m "feat(evidence): harden retrieval telemetry"
```

### Task 12: Publish Provider and Retrieval Conformance Kits

**Files:**

- Create: `packages/evidence/retrieval/src/testing/fixtures.ts`
- Create: `packages/evidence/retrieval/src/testing/candidate-source-contract.ts`
- Create: `packages/evidence/retrieval/src/testing/retrieval-contract.ts`
- Create: `packages/evidence/retrieval/src/testing/candidate-source-contract.test.ts`
- Create: `packages/evidence/retrieval/src/testing/retrieval-contract.test.ts`
- Create: `packages/evidence/retrieval/src/testing.test.ts`
- Modify: `packages/evidence/retrieval/src/testing.ts`

**Interfaces:**

- Consumes: public Retrieval contracts, Protocol package fixture exports, Repository testing utilities, and Vitest as an optional peer.
- Produces: public `StaticCandidateSource`, `loadGoldenEvidenceRecords`, `createSyntheticRetrievalFixture`, `describeCandidateSourceContract`, and `describeEvidenceRetrievalContract` from `@jinn-network/evidence-retrieval/testing`.

- [ ] **Step 1: Write failing self-tests for the testing entrypoint**

Create `src/testing.test.ts`:

```ts
import { expectTypeOf, test } from "vitest";

import {
  StaticCandidateSource,
  createSyntheticRetrievalFixture,
  describeCandidateSourceContract,
  describeEvidenceRetrievalContract,
  loadGoldenEvidenceRecords,
} from "./testing.js";

test("exports reusable fixtures and both contract kits", () => {
  expectTypeOf(StaticCandidateSource).toBeConstructibleWith(
    { id: "fixture", version: "1.0.0" },
    [],
  );
  expectTypeOf(createSyntheticRetrievalFixture).toBeFunction();
  expectTypeOf(describeCandidateSourceContract).toBeFunction();
  expectTypeOf(describeEvidenceRetrievalContract).toBeFunction();
  expectTypeOf(loadGoldenEvidenceRecords).toBeFunction();
});
```

Create self-invocations:

```ts
describeCandidateSourceContract("StaticCandidateSource", async () => {
  const fixture = await createCandidateContractFixture();
  return fixture;
});

describeEvidenceRetrievalContract("in-memory Retrieval", async () => {
  const fixture = await createSyntheticRetrievalFixture();
  return {
    retrieval: fixture.retrieval,
    records: fixture.records,
    source: fixture.source,
    sourceQuery: { kind: "all" as const },
    cleanup: fixture.cleanup,
  };
});
```

Define the candidate self-test factory in
`src/testing/candidate-source-contract.test.ts`:

```ts
async function createCandidateContractFixture() {
  const records = await loadGoldenEvidenceRecords();
  const expectedReferences = [...records.values()].map(
    ({ reference }) => reference,
  );
  type Query = {
    readonly kind: "all" | "failure" | "timeout";
  };
  const base = new StaticCandidateSource<Query>(
    { id: "static-contract", version: "1.0.0" },
    expectedReferences.map((reference) => ({ reference })),
  );
  const source: CandidateSource<Query> = {
    identity: base.identity,
    async find(query, options) {
      if (query.kind === "failure") {
        throw new Error("Synthetic backend failure.");
      }
      if (query.kind === "timeout") {
        await new Promise((resolve) =>
          setTimeout(resolve, options.timeoutMs),
        );
        throw new DOMException("Synthetic timeout.", "TimeoutError");
      }
      return base.find(query, options);
    },
  };
  const unconfiguredAccess = vi.fn();
  return {
    source,
    query: { kind: "all" as const },
    failureQuery: { kind: "failure" as const },
    timeoutQuery: { kind: "timeout" as const },
    expectedReferences,
    assertAccessBoundary: () => {
      expect(unconfiguredAccess).not.toHaveBeenCalled();
    },
  };
}
```

- [ ] **Step 2: Run testing-entrypoint tests and observe missing exports**

Run:

```bash
yarn test src/testing.test.ts src/testing/candidate-source-contract.test.ts src/testing/retrieval-contract.test.ts
```

Expected: FAIL because the testing utilities are missing.

- [ ] **Step 3: Implement literal fixtures and a provider-neutral static source**

Create `src/testing/fixtures.ts`. Load fixture bytes through Protocol's published fixture subpath, not a source-tree-relative path:

```ts
import { readFile } from "node:fs/promises";

import {
  createRecordReference,
  type EvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import {
  InMemoryEvidenceRepository,
} from "@jinn-network/evidence-repository/testing";

import {
  createEvidenceRetrieval,
  type CandidatePage,
  type CandidateSource,
  type CandidateSourceIdentity,
  type CandidateSourceOperationOptions,
  type EvidenceCandidate,
} from "../index.js";

const FIXTURE_PATHS = {
  "execution-evidence":
    "golden-execution-evidence-v1/execution/ro-crate-metadata.json",
  "result-evaluation":
    "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
  "execution-verification":
    "golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json",
} as const;

export async function loadGoldenEvidenceRecords(): Promise<
  ReadonlyMap<EvidenceRecordReference["family"], {
    readonly reference: EvidenceRecordReference;
    readonly bytes: Uint8Array;
  }>
> {
  const records = new Map();
  for (const [family, path] of Object.entries(FIXTURE_PATHS)) {
    const url = import.meta.resolve(
      `@jinn-network/evidence-protocol/fixtures/${path}`,
    );
    const bytes = new Uint8Array(await readFile(new URL(url)));
    records.set(family, {
      reference: createRecordReference(
        family as EvidenceRecordReference["family"],
        bytes,
      ),
      bytes,
    });
  }
  return records;
}

export class StaticCandidateSource<Query, ProviderData = unknown>
implements CandidateSource<Query, ProviderData> {
  constructor(
    readonly identity: CandidateSourceIdentity,
    readonly candidates: readonly EvidenceCandidate<ProviderData>[],
  ) {}

  async find(
    _query: Query,
    options: CandidateSourceOperationOptions,
  ): Promise<CandidatePage<ProviderData>> {
    if (options.signal.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    return {
      source: this.identity,
      candidates: this.candidates.slice(0, options.maximumCandidates),
    };
  }
}
```

`createSyntheticRetrievalFixture` must:

- load all three record families;
- write them byte-for-byte to `InMemoryEvidenceRepository`;
- load and write the execution fixture's declared result artifact so explicit role hydration has one verified path;
- expose a locator with one available `memory` location;
- expose a policy that selects only that observation;
- expose a resolver that returns the in-memory repository only for `memory`;
- construct Retrieval with small deterministic hard limits;
- construct one `StaticCandidateSource<{kind:"all"}>` in family order;
- return spies/counters for provider, locator, resolver, record, and artifact calls;
- return a no-op async `cleanup`.

Testing helpers may import `node:fs/promises`, Repository `/testing`, and Vitest. Root production modules must not import `src/testing.ts` or `src/testing/**`.

- [ ] **Step 4: Implement both reusable contract descriptions**

Define the candidate context:

```ts
export interface CandidateSourceContractContext<Query, ProviderData> {
  readonly source: CandidateSource<Query, ProviderData>;
  readonly query: Query;
  readonly expectedReferences: readonly EvidenceRecordReference[];
  readonly assertContinuation?: (
    first: CandidatePage<ProviderData>,
    second: CandidatePage<ProviderData>,
  ) => void | Promise<void>;
  readonly failureQuery: Query;
  readonly timeoutQuery: Query;
  readonly assertAccessBoundary: () => void | Promise<void>;
  readonly cleanup?: () => void | Promise<void>;
}

export type CandidateSourceContractFactory<Query, ProviderData> = (
  testName: string,
) =>
  | CandidateSourceContractContext<Query, ProviderData>
  | Promise<CandidateSourceContractContext<Query, ProviderData>>;
```

`describeCandidateSourceContract(name, createContext)` must register isolated Vitest tests that verify:

1. stable non-empty source ID and version;
2. every candidate has a parseable canonical reference;
3. result order equals the fixture's expected references;
4. `maximumCandidates: 1` returns at most one candidate;
5. an already-aborted signal rejects;
6. provider metadata JSON encodes within the fixture operation limit and does not change reference identity;
7. a returned cursor has the same source identity and resumes through the fixture's `assertContinuation`;
8. a replayable checkpoint returns the same ordered reference page when replayed;
9. absence or `replayable: false` is reported honestly;
10. `failureQuery` rejects rather than returning an empty success page.
11. `timeoutQuery` rejects within a 250 ms harness ceiling when invoked with `timeoutMs: 5`; the harness never assumes an adapter-specific retry strategy.
12. `assertAccessBoundary` passes after every provider invocation, proving the fixture observed no access outside its configured backend set.

Define the Retrieval context:

```ts
export interface EvidenceRetrievalContractContext<Query, ProviderData> {
  readonly retrieval: EvidenceRetrieval;
  readonly records: ReadonlyMap<
    EvidenceRecordReference["family"],
    {
      readonly reference: EvidenceRecordReference;
      readonly bytes: Uint8Array;
    }
  >;
  readonly source: CandidateSource<Query, ProviderData>;
  readonly sourceQuery: Query;
  readonly cleanup?: () => void | Promise<void>;
}
```

`describeEvidenceRetrievalContract(name, createContext)` must register isolated tests that verify:

1. known-reference retrieval for all three families;
2. canonical bytes equal fixture bytes but use a defensive buffer;
3. query returns all fixture references in source order;
4. no artifact read occurs without explicit selection;
5. malformed or mismatched bytes never appear as a successful result;
6. cancellation is observable;
7. `resultLimit` and `candidateBudget` are enforced;
8. source metadata remains provenance and never becomes canonical data.

Use `beforeEach`/`afterEach` and always run context cleanup, following the established Repository and Derivation testing-entrypoint style.

Replace `src/testing.ts` with:

```ts
export * from "./testing/candidate-source-contract.js";
export * from "./testing/fixtures.js";
export * from "./testing/retrieval-contract.js";
```

- [ ] **Step 5: Run the self-hosted contract kits, build, and commit**

Run:

```bash
yarn test src/testing.test.ts src/testing/candidate-source-contract.test.ts src/testing/retrieval-contract.test.ts
yarn test
yarn typecheck
yarn build
```

Expected: all PASS and `dist/testing.js` imports Vitest only through the optional testing entrypoint. Then commit:

```bash
git add packages/evidence/retrieval/src
git commit -m "test(evidence): publish retrieval contract kits"
```

### Task 13: Prove Consumer Boundaries and Finish the Packed Package

**Files:**

- Create: `packages/evidence/retrieval/src/consumer-scenarios.test.ts`
- Modify: `packages/evidence/retrieval/README.md`
- Modify: `packages/evidence/retrieval/specification.md`
- Modify: `packages/evidence/retrieval/scripts/pack-smoke.mjs`
- Modify: `packages/evidence/retrieval/package.json`

**Interfaces:**

- Consumes: the final public root and testing entrypoints.
- Produces: executable plugin/evaluator/miner/semantic/dataset scenarios, complete host/provider/consumer documentation, and an installed-consumer pack smoke test.

- [ ] **Step 1: Write failing end-to-end consumer scenarios**

Create `src/consumer-scenarios.test.ts` with five explicit scenarios:

```ts
test("plugin host searches configured local and public stores uniformly", async () => {
  const fixture = await consumerFixture();
  const source = createFederatedCandidateSource({
    identity: { id: "plugin-history", version: "1.0.0" },
    sources: [fixture.localSource, fixture.publicSource],
    allocate: allocateAcrossStores,
    order: preserveFixtureOrder,
  });
  const outcome = await fixture.retrieval.query({
    candidateSource: source,
    sourceQuery: { terms: ["matching", "history"] },
    resultLimit: 2,
    candidateBudget: 4,
  });
  expect(fixture.localFind).toHaveBeenCalledOnce();
  expect(fixture.publicFind).toHaveBeenCalledOnce();

  // This projection is deliberately consumer-owned.
  const packet = {
    evidence: outcome.results.map(({ reference, validatedRecord }) => ({
      reference,
      family: validatedRecord.family,
    })),
  };
  expect(packet.evidence).toHaveLength(2);
  expect(JSON.stringify(packet)).not.toContain("snippet");
});

test("an evaluator receives relationships but owns its verdict", async () => {
  const fixture = await consumerFixture();
  const outcome = await fixture.retrieval.query({
    candidateSource: fixture.relationshipSource,
    sourceQuery: { executionId: fixture.executionId },
    resultLimit: 3,
    candidateBudget: 3,
  });
  expect(outcome.results.map(({ validatedRecord }) => validatedRecord.family))
    .toEqual([
      "execution-evidence",
      "result-evaluation",
      "execution-verification",
    ]);
  const verdict = fixture.evaluate(outcome.results);
  expect(verdict).toEqual({ status: "consumer-decided" });
  expect(outcome).not.toHaveProperty("verdict");
});

test("a miner requests exact artifacts and publishes nothing through Retrieval", async () => {
  const fixture = await consumerFixture();
  const putRecord = vi.spyOn(fixture.repository, "putRecord");
  const outcome = await fixture.retrieval.retrieve({
    reference: fixture.executionReference,
    artifacts: {
      selections: [{
        selector: { kind: "role", role: "result" },
        requirement: "required",
      }],
    },
  });
  expect(outcome).toMatchObject({
    status: "validated",
    result: {
      artifacts: expect.arrayContaining([
        expect.objectContaining({ status: "verified" }),
      ]),
    },
  });
  expect(putRecord).not.toHaveBeenCalled();
});

test("equivalent semantic providers do not change Evidence identity", async () => {
  const first = await runSemanticProvider("vector-a");
  const replacement = await runSemanticProvider("vector-b");
  expect(first.results.map(({ reference }) => reference))
    .toEqual(replacement.results.map(({ reference }) => reference));
  expect(first.results.map(({ canonicalBytes }) => canonicalBytes))
    .toEqual(replacement.results.map(({ canonicalBytes }) => canonicalBytes));
});

test("a dataset consumer materializes references outside Retrieval", async () => {
  const fixture = await replayableConsumerFixture();
  const outcome = await fixture.retrieval.query(fixture.query);
  expect(outcome.snapshotReceipt?.reproducibility).toBe("replayable");
  const manifest = {
    snapshot: outcome.snapshotReceipt,
    records: outcome.results.map(({ reference }) => reference),
  };
  expect(manifest.records).toHaveLength(outcome.results.length);
  expect(fixture.retrieval).not.toHaveProperty("publishDataset");
});
```

Define the test-local consumer helpers in the same file:

```ts
const preserveFixtureOrder: FederatedOrdering<
  { readonly terms: readonly string[] },
  { readonly store: string },
  undefined
> = (groups) => groups.map(({ reference }) => ({ reference }));

const allocateAcrossStores: FederatedCandidateAllocation<unknown> = (
  maximum,
  sources,
) => sources.map((_source, index) =>
  Math.floor(maximum / sources.length)
  + (index < maximum % sources.length ? 1 : 0),
);

async function consumerFixture() {
  const fixture = await createSyntheticRetrievalFixture();
  const ordered = [...fixture.records.values()].map(
    ({ reference }) => reference,
  );
  const localDelegate = new StaticCandidateSource(
    { id: "local-store", version: "1.0.0" },
    ordered.slice(0, 2).map((reference) => ({
      reference,
      providerData: { store: "local" },
    })),
  );
  const publicDelegate = new StaticCandidateSource(
    { id: "public-store", version: "1.0.0" },
    ordered.slice(1).map((reference) => ({
      reference,
      providerData: { store: "public" },
    })),
  );
  const localFind = vi.fn((query, options) =>
    localDelegate.find(query, options),
  );
  const publicFind = vi.fn((query, options) =>
    publicDelegate.find(query, options),
  );
  const localSource = {
    identity: { id: "local-store", version: "1.0.0" },
    find: localFind,
  };
  const publicSource = {
    identity: { id: "public-store", version: "1.0.0" },
    find: publicFind,
  };
  return {
    ...fixture,
    localSource,
    publicSource,
    localFind,
    publicFind,
    relationshipSource: new StaticCandidateSource(
      { id: "relationships", version: "1.0.0" },
      ordered.map((reference) => ({ reference })),
    ),
    executionReference: fixture.records.get("execution-evidence")!.reference,
    executionId: "urn:uuid:22222222-2222-4222-8222-222222222222",
    evaluate: (_results: readonly ValidatedEvidenceResult[]) => ({
      status: "consumer-decided" as const,
    }),
  };
}

async function runSemanticProvider(id: string) {
  const fixture = await createSyntheticRetrievalFixture();
  const candidates = [...fixture.records.values()].map(({ reference }) => ({
    reference,
    providerData: { backend: id, similarity: 0.75 },
  }));
  const outcome = await fixture.retrieval.query({
    candidateSource: new StaticCandidateSource(
      { id, version: "1.0.0" },
      candidates,
    ),
    sourceQuery: { text: "same provider query contract" },
    resultLimit: candidates.length,
    candidateBudget: candidates.length,
  });
  await fixture.cleanup();
  return outcome;
}

async function replayableConsumerFixture() {
  const fixture = await createSyntheticRetrievalFixture();
  const sourceIdentity = { id: "dataset-source", version: "1.0.0" };
  const checkpoint: CandidateCheckpoint = {
    source: sourceIdentity,
    value: { generation: "fixture-1" },
    replayable: true,
  };
  const candidates = [...fixture.records.values()].map(
    ({ reference }) => ({ reference }),
  );
  const source: CandidateSource<{ readonly kind: "dataset" }> = {
    identity: sourceIdentity,
    async find(_query, options) {
      if (
        options.checkpoint !== undefined
        && (
          options.checkpoint.value as { readonly generation?: unknown }
        ).generation !== "fixture-1"
      ) {
        throw new Error("Unknown synthetic checkpoint.");
      }
      return {
        source: sourceIdentity,
        candidates: candidates.slice(0, options.maximumCandidates),
        checkpoint,
      };
    },
  };
  const savedQuery = createSavedEvidenceQuery({
    candidateSourceSet: sourceIdentity,
    sourceQuery: { kind: "dataset" as const },
    codec: {
      kind: "dataset-query",
      schemaVersion: "1.0.0",
      encode: (query) => query,
      decode: () => ({ kind: "dataset" as const }),
    },
    resultLimit: candidates.length,
    candidateBudget: candidates.length,
  });
  return {
    ...fixture,
    query: {
      candidateSource: source,
      sourceQuery: { kind: "dataset" as const },
      resultLimit: candidates.length,
      candidateBudget: candidates.length,
      checkpoint,
      savedQuery,
    },
  };
}
```

These helpers are test-local provider policy and dataset materialization code; none are exported by Retrieval.

These scenarios use test-local projections. They must not import `packages/plugin`, `packages/layer`, `KnowledgeHit`, `CorpusRecord`, or `KnowledgePacket`.

- [ ] **Step 2: Run consumer scenarios and close any missing public behavior**

Run:

```bash
yarn test src/consumer-scenarios.test.ts
```

Expected: PASS if Tasks 1–12 satisfy the approved flows. If a test fails, fix the owning module with a focused regression test before changing the scenario assertion. Do not add consumer-specific behavior to the root package.

- [ ] **Step 3: Write complete package documentation**

Replace the initial README with these exact sections:

1. `# @jinn-network/evidence-retrieval`
2. `## What this package owns`
3. `## What candidate providers own`
4. `## What hosts and consumers own`
5. `## Known-reference example`
6. `## Provider-owned query example`
7. `## Federating configured stores`
8. `## Artifact hydration`
9. `## Saved queries and checkpoints`
10. `## Failure and partial-result semantics`
11. `## Security and telemetry`
12. `## Plugin migration boundary`
13. `## Third-party hosts and optional transport`
14. `## Testing provider implementations`
15. `## Non-goals`

The provider example must demonstrate a custom query without a method enum:

```ts
interface HistoryQuery {
  readonly terms: readonly string[];
  readonly taskDigest?: `sha256:${string}`;
}

const historySource: CandidateSource<HistoryQuery, {
  readonly score: number;
  readonly snippet: string;
}> = {
  identity: { id: "host-history", version: "1.0.0" },
  async find(query, options) {
    const hits = await hostIndex.search(query, {
      signal: options.signal,
      limit: options.maximumCandidates,
      cursor: options.cursor?.value,
    });
    return {
      source: this.identity,
      candidates: hits.items.map((hit) => ({
        reference: hit.evidenceReference,
        providerData: { score: hit.score, snippet: hit.snippet },
      })),
      nextCursor: hits.next === undefined ? undefined : {
        source: this.identity,
        value: hits.next,
      },
    };
  },
};

const outcome = await retrieval.query({
  candidateSource: historySource,
  sourceQuery: { terms: ["bounded", "retrieval"] },
  resultLimit: 10,
  candidateBudget: 50,
});
```

Immediately explain that `hostIndex`, its query, its snippets, and its ranking are provider-owned; each hit is re-fetched and validated before it can enter `outcome.results`.

The plugin migration section must state:

- plugin is a host and consumer;
- host configures all local and public stores searched by the selected plugin source;
- Retrieval treats those stores uniformly;
- plugin retains ranking, context selection, prompt policy, and `KnowledgePacket`;
- legacy CID refs cannot be sent to Retrieval as record references;
- `CorpusPort` replacement requires a separate canonical-reference provider adapter.

The third-party section must show that any TypeScript host may inject its own
ports. It must state that a later HTTP/gRPC server is only a host wrapper over
the same semantics, uses registered provider/source-set IDs and runtime query
codecs, and owns authentication, tenancy, quotas, and network retry outside
this package.

Rewrite `specification.md` as a package-level normative contract. Use MUST/MUST NOT language for identity, provider ownership, exact-byte validation, limits, artifacts, outcomes, security, saved queries, testing, and non-goals. Link the approved architecture document and include no plugin-specific type in a normative interface.

- [ ] **Step 4: Expand pack smoke to an installed consumer**

Replace the initial archive-only smoke with the established Evidence-package pattern:

1. Pack Protocol, Repository, Discovery, and Retrieval into a temporary directory.
2. Assert the Retrieval archive contains:

```text
package/README.md
package/specification.md
package/dist/index.js
package/dist/index.d.ts
package/dist/testing.js
package/dist/testing.d.ts
```

3. Assert no `*.test.*` or `*.spec.*` file is present under `package/dist`.
4. Create a temporary npm consumer with file dependencies on all four archives plus TypeScript 5.9.3 and Vitest 4.1.8.
5. Compile:

```ts
import {
  createEvidenceRetrieval,
  createFederatedCandidateSource,
  createSavedEvidenceQuery,
  type CandidateSource,
  type EvidenceRetrieval,
} from "@jinn-network/evidence-retrieval";
import {
  StaticCandidateSource,
  createSyntheticRetrievalFixture,
  describeCandidateSourceContract,
} from "@jinn-network/evidence-retrieval/testing";

void createEvidenceRetrieval;
void createFederatedCandidateSource;
void createSavedEvidenceQuery;
void StaticCandidateSource;
void createSyntheticRetrievalFixture;
void describeCandidateSourceContract;
declare const retrieval: EvidenceRetrieval;
declare const source: CandidateSource<{ readonly text: string }>;
void retrieval;
void source;
```

6. Run a JavaScript smoke script that creates the synthetic fixture, performs one known-reference retrieval and one query, verifies both return validated results, and calls cleanup.
7. Read installed `README.md`, `specification.md`, and `package.json`.
8. Assert the installed package's Jinn production dependencies are exactly the three approved names.
9. Delete the temporary directory in `finally`.

Keep `"files"` limited to `dist/`, `README.md`, and `specification.md`; fixture bytes resolve from the Protocol dependency and need not be duplicated.

- [ ] **Step 5: Run consumer, documentation, and pack verification, then commit**

Run:

```bash
yarn test src/consumer-scenarios.test.ts
yarn test
yarn typecheck
yarn build
yarn pack:smoke
```

Expected: all PASS, including the installed root and `./testing` imports. Then commit:

```bash
git add packages/evidence/retrieval
git commit -m "docs(evidence): finish retrieval package"
```

### Task 14: Enforce Architecture, Packed Types, and Evidence CI

**Files:**

- Modify: `.github/scripts/evidence-source-boundaries.test.mjs`
- Modify: `.github/scripts/evidence-packed-types.test.mjs`
- Modify: `.github/workflows/evidence-ci.yml`
- Verify: `.github/scripts/evidence-package-inventory.test.mjs`

**Interfaces:**

- Consumes: the complete package, approved dependency graph, public entrypoints, and existing Evidence CI artifacts.
- Produces: permanent one-way dependency guards, a packed consumer for 21 entrypoints across 11 packages, a dedicated Retrieval CI job, and final all-stage verification.

- [ ] **Step 1: Add Retrieval boundary canaries and exact allowlists**

Add `retrieval` to `evidenceDirectories`. Define:

```js
const RETRIEVAL_ALLOWED_DEPENDENCIES = [
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository',
];
const RETRIEVAL_ALLOWED_DEV_DEPENDENCIES = [
  '@types/node',
  'typescript',
  'vitest',
];
const RETRIEVAL_ALLOWED_PEER_DEPENDENCIES = ['vitest'];
const RETRIEVAL_FORBIDDEN_PACKAGES = [
  '@huggingface/transformers',
  '@jinn-network/autopilot',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-discovery/indexer',
  '@jinn-network/evidence-discovery/journal',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-repository/fs',
  '@jinn-network/jinn-layer',
  '@jinn-network/marketplace',
  '@jinn-network/plugin',
  '@jinn-network/sdk',
  'better-sqlite3',
  'kubo-rpc-client',
  'node:dgram',
  'node:dns',
  'node:fs',
  'node:http',
  'node:http2',
  'node:https',
  'node:net',
  'node:tls',
  'viem',
];
```

Add a scanner canary that creates a temporary Retrieval-like source importing the plugin, concrete Catalog, Repository filesystem subpath, Discovery Journal, `node:fs`, and using global `fetch`; assert five forbidden imports and one ambient-network use are detected.

In the main boundary test:

1. Identify `src/testing.ts`, `src/testing/**`, `src/test-support.ts`, and every `*.test.*` as test-only.
2. Assert production files import none of `RETRIEVAL_FORBIDDEN_PACKAGES`, none of the corresponding local package roots, no Vitest, no test-only files, and no ambient network APIs.
3. Assert testing files still cannot import plugin, marketplace, concrete Catalog, concrete Repository bindings, Discovery Indexer/Journal, or ambient network APIs. Allow `node:fs/promises`, Repository `/testing`, and Vitest only there.
4. Assert exact exports:

```js
{
  '.': {
    import: './dist/index.js',
    types: './dist/index.d.ts',
  },
  './testing': {
    import: './dist/testing.js',
    types: './dist/testing.d.ts',
  },
}
```

5. Assert exact production, development, optional, and peer dependency lists and optional Vitest peer metadata.
6. Assert Protocol, Repository, and Discovery do not depend on or import Retrieval.
7. Assert Retrieval root never exports `testing.ts` or files under `src/testing`.

Run:

```bash
node --test .github/scripts/evidence-source-boundaries.test.mjs
```

Expected: PASS, including the new canary and the real package checks.

- [ ] **Step 2: Add Retrieval to the packed public-entrypoint consumer**

In `.github/scripts/evidence-packed-types.test.mjs`, add:

```js
['retrieval', '@jinn-network/evidence-retrieval'],
```

Add:

```js
'@jinn-network/evidence-retrieval',
'@jinn-network/evidence-retrieval/testing',
```

to `codeEntrypoints`. Change the final message to:

```js
`Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoints across all eleven evidence packages.`
```

Run after all package distributions are built:

```bash
node .github/scripts/evidence-packed-types.test.mjs
```

Expected: PASS and print `21 public code entrypoints across all eleven evidence packages`.

- [ ] **Step 3: Add a dedicated Retrieval CI job**

Add both architecture documents to the workflow path filter:

```yaml
- "docs/superpowers/specs/2026-07-26-evidence-retrieval-design.md"
- "docs/superpowers/plans/2026-07-27-evidence-retrieval.md"
```

Add this job after `components`:

```yaml
retrieval:
  name: Evidence Retrieval
  needs: [foundation, components]
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 22
    - name: Enable Yarn 4.13.0
      run: |
        corepack enable
        corepack prepare yarn@4.13.0 --activate
    - name: Restore Evidence Protocol distribution
      uses: actions/download-artifact@v4
      with:
        name: evidence-protocol-dist
        path: packages/evidence/protocol/dist
    - name: Restore Evidence Repository distribution
      uses: actions/download-artifact@v4
      with:
        name: evidence-repository-dist
        path: packages/evidence/repository/dist
    - name: Restore Evidence Discovery distribution
      uses: actions/download-artifact@v4
      with:
        name: evidence-discovery-dist
        path: packages/evidence/discovery/dist
    - name: Install packed-smoke dependency toolchains
      run: |
        (cd packages/evidence/protocol && yarn install --immutable)
        (cd packages/evidence/repository && yarn install --immutable)
        (cd packages/evidence/discovery && yarn install --immutable)
    - name: Verify Evidence Retrieval
      working-directory: packages/evidence/retrieval
      run: |
        yarn install --immutable
        yarn typecheck
        yarn test
        yarn build
        yarn pack:smoke
    - name: Upload Evidence Retrieval distribution
      uses: actions/upload-artifact@v4
      with:
        name: evidence-retrieval-dist
        path: packages/evidence/retrieval/dist
        if-no-files-found: error
        retention-days: 1
```

Update `verify`:

- add `retrieval` to `needs`;
- add `RETRIEVAL_RESULT: ${{ needs.retrieval.result }}`;
- include `"$RETRIEVAL_RESULT"` in the success loop;
- add `retrieval` to the package-distribution placement loop.

Do not add Retrieval as a dependency of `local-runtime`; consumers opt into the application library explicitly.

- [ ] **Step 4: Run the complete local Evidence gate**

Run:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
cd packages/evidence/retrieval
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
cd ../../..
node .github/scripts/evidence-packed-types.test.mjs
```

Expected: every command exits 0. Confirm:

- inventory reports 11 packages;
- Retrieval has exactly three Jinn production dependencies;
- root and `./testing` compile from packed archives;
- no concrete binding or consumer dependency crosses the boundary;
- all three record families, partial outcomes, federation, artifact states, saved-query checks, telemetry exclusions, and consumer scenarios are covered.

- [ ] **Step 5: Commit CI and architecture enforcement**

```bash
git add .github/scripts/evidence-source-boundaries.test.mjs .github/scripts/evidence-packed-types.test.mjs .github/workflows/evidence-ci.yml
git commit -m "ci(evidence): verify retrieval package"
```

## Implementation Acceptance Matrix

| Approved design area | Implemented and verified by |
| --- | --- |
| Host-neutral in-process application and one-package dependency boundary | Tasks 1, 2, 10, 14 |
| Known-reference retrieval without search | Tasks 4, 5, 6, 10 |
| Provider-owned query types and no method enumeration | Tasks 2, 7, 10, 13 |
| Provider-owned ordering and composite ranking | Tasks 7, 8, 10 |
| Host-configured local/public federation with uniform semantics | Tasks 8, 13 |
| Canonical-reference deduplication with all observations | Tasks 7, 8, 10 |
| Result limit, candidate budget, cursor, checkpoint, deadline, and concurrency bounds | Tasks 3, 7, 8, 9, 10 |
| Host location policy, registered resolver, bounded fallback | Task 5 |
| SHA-256 verification and all three existing family validators | Task 4 |
| Explicit artifact selection, integrity, and operational states | Task 6 |
| Post-validation consumer acceptance | Task 10 |
| Complete, partial, failed, typed failure, and bounded diagnostic behavior | Tasks 5, 6, 10, 11 |
| Saved-query envelope and honest reproducibility receipt | Tasks 9, 10, 13 |
| Content-minimizing telemetry and hostile metadata/location boundaries | Task 11 |
| Provider and Retrieval contract kits | Task 12 |
| Plugin/evaluator/miner/semantic/dataset ownership examples | Task 13 |
| Read-only behavior, no trust/admission/relationship verdict, no transport/cache/search infrastructure | Tasks 13, 14 |
| Published root/testing entrypoints and Evidence CI | Tasks 1, 12, 13, 14 |

## Final Review Gate

Before claiming implementation complete, use `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`.

- [ ] Run the full command sequence from **Execution Baseline** in a fresh shell and retain its exit output.
- [ ] Run `git diff --check`; expected: no whitespace errors.
- [ ] Run `git status --short`; expected: only intentional Retrieval, architecture-script, workflow, design, and plan files are present.
- [ ] Run:

```bash
rg -n \
  'KnowledgeHit|CorpusRecord|KnowledgePacket|method:.*structured|method:.*keyword|method:.*semantic|better-sqlite3|kubo-rpc-client|@jinn-network/plugin|@jinn-network/marketplace' \
  packages/evidence/retrieval/src \
  -g '!*.test.ts' \
  -g '!test-support.ts' \
  -g '!testing.ts' \
  -g '!testing/**'
```

Expected: no production-root match.

- [ ] Inspect the generated `dist/index.d.ts` and `dist/testing.d.ts`; expected: root contains no test fixture, Vitest, concrete binding, plugin, search engine, or consumer projection.
- [ ] Inspect the pack-smoke dependency assertion; expected: exactly Protocol, Repository, and Discovery.
- [ ] Inspect the final diff against the approved design section by section using the acceptance matrix above; expected: no design requirement lacks a test or documentation owner.
- [ ] Confirm no file under `packages/plugin`, `packages/layer`, Protocol, Repository, or Discovery was modified for convenience. Any required substrate change needs its own reviewed design rather than being hidden in Retrieval.
- [ ] Confirm the plugin migration is still explicit follow-up work and that no CID string is parsed or cast as an `EvidenceRecordReference`.

The implementation is ready for integration only when every final gate passes on the exact reviewed stack or on a freshly re-audited replacement stack.
