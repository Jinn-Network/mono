# Evidence Contribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@jinn-network/evidence-contribution`, the host-neutral durable workflow that prepares one exact Evidence record, binds authorization to its disclosure and destinations, publishes through the existing substrate, and reports recoverable per-destination outcomes.

**Architecture:** Implement one independently publishable TypeScript library under `packages/evidence/contribution`. The package composes Protocol, Repository, Derivation, and Publication through injected ports; keeps Evidence payloads in private Repositories; keeps only safe operational records in a compare-and-swap store; and exposes pure, retry-safe commands rather than a daemon or product adapter.

**Tech Stack:** Node.js 22, TypeScript 5.9.3, ESM/ES2022, Yarn 4.13.0, Vitest 4.1.8, `canonicalize` 3.0.0, and the `@jinn-network/evidence-*` 0.1.0 package contracts.

**Design:** `../specs/2026-07-26-evidence-contribution-design.md`

## Global Constraints

- Execute in an isolated worktree created with `superpowers:using-git-worktrees`; never implement in an active substrate worktree.
- Start from a dependency-complete Evidence base containing Derivation distribution commit `df87ae6ba62c` (or a descendant) and hardened Publication commit `44b67cdff3c6` (or a descendant).
- The base must already expose `@jinn-network/evidence-protocol`, `@jinn-network/evidence-repository`, `@jinn-network/evidence-derivation`, and `@jinn-network/evidence-publication`; if not, stop and reconcile the substrate outside this plan.
- Use exactly one primary `EvidenceRecordReference` per request. Related Evaluation and Verification records use independent requests.
- Do not add a service, daemon, queue, ledger, wallet, blockchain, Discovery, plugin, marketplace, Autopilot, IPFS, OCI, or concrete Repository dependency.
- Do not implement plugin migration, legacy consent import, rollout, a concrete `ContributionStore`, a concrete withdrawal binding, or a process/RPC wrapper.
- Do not create a fourth Evidence record family, a second Evidence format, a Publication bundle, a Repository, an announcement frame, a Derivation algorithm, or a Publication journal.
- Execution Evidence may be returned unchanged or derived through `EvidenceDeriver`; signed Evaluation and Verification envelopes are unchanged or withheld.
- One-time authorization binds an exact prepared manifest. Standing authorization is explicit, scoped, inspectable, revocable, and rechecked before each destination begins.
- `review-required` and `withheld` never produce Publication input.
- Publication runs once per destination. Destination outcomes are independent and non-atomic.
- A destination is `published` only after a completed `PublicationReceipt`, including announcement placement.
- Deactivation prevents not-started operations, lets already-started Publication reconcile, and never claims deletion.
- Store no Evidence payloads, credentials, secret detector configuration, private findings, paths, opaque sink state, or private snippets in Contribution state, errors, events, or receipts.
- Use Node 22, Yarn 4.13.0, strict TypeScript, Apache-2.0 package licensing, and SPDX headers on source files.
- Follow TDD: prove every new behavior fails before implementing it, then run the focused test and the package suite.
- Strip expected-revision fields before calling Repository, Derivation, Publication, authority, review, or withdrawal ports; only the `signal` crosses those boundaries.
- Make one focused commit after each task; do not stage unrelated worktree changes.

## Execution Prerequisite

Run every shell block with the repository root as its working directory. A `cd` applies only within that one block; do not carry its working directory into the next step.

Before Task 1, run:

```bash
test -f packages/evidence/protocol/package.json
test -f packages/evidence/repository/package.json
test -f packages/evidence/derivation/package.json
test -f packages/evidence/publication/package.json
(cd packages/evidence/derivation && yarn install --immutable && yarn typecheck && yarn test)
(cd packages/evidence/publication && yarn install --immutable && yarn typecheck && yarn test)
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
```

Expected: every command exits zero. If Publication is present but absent from the package inventory or CI graph, finish its upstream distribution work before starting Contribution; do not absorb that repair into this package.

## Final File Map

```text
packages/evidence/contribution/
├── .gitignore                         generated build/install exclusions
├── .yarnrc.yml                        package-local Yarn configuration
├── README.md                          public boundary, examples, and non-goals
├── package.json                       package metadata, exports, scripts, dependencies
├── yarn.lock                          immutable package dependency lock
├── tsconfig.json                      strict ES2022 source and test checking
├── tsconfig.build.json                declaration-emitting production build
├── vitest.config.ts                   bounded test configuration
├── scripts/
│   └── pack-smoke.mjs                 packed root/testing consumer verification
└── src/
    ├── index.ts                       root public exports only
    ├── types.ts                       public request, manifest, authorization, outcome, receipt types
    ├── errors.ts                      stable safe error codes and error class
    ├── validation.ts                  inert snapshots, IRI/digest/time/count validation
    ├── canonical-json.ts              exact private operational serialization
    ├── identities.ts                  intent, manifest, decision, grant, and receipt fingerprints
    ├── request.ts                     request normalization, sealing, and duplicate identity
    ├── state.ts                       durable facets, transitions, aggregate read status, claims
    ├── store.ts                       typed CAS port and safe state update helpers
    ├── policy.ts                      source-bound disclosure-policy verification and routing
    ├── source.ts                      exact Repository loading and digest/conformance checks
    ├── manifest.ts                    prepared disclosure construction and parsing
    ├── prepare-execution.ts           Derivation composition and private staging
    ├── prepare-signed.ts              exact Evaluation/Verification preparation
    ├── prepare-reuse.ts               verified reuse of an earlier prepared disclosure
    ├── authorization.ts               exact decisions, standing grants, matching, revocation
    ├── publication.ts                 per-destination Publication invocation and recovery
    ├── deactivation.ts                no-new-starts and optional availability withdrawal
    ├── receipt.ts                     private operational receipt construction
    ├── read-model.ts                  safe application projection
    ├── commands.ts                    retry-safe application command surface
    ├── testing.ts                     public host-integration contract kit
    └── testing-fixtures.ts            private in-memory ports and synthetic fixtures
```

Co-locate `*.test.ts` files with the source they verify. Keep `testing-fixtures.ts` out of the root entrypoint and expose only the intentional contract driver types and `describeEvidenceContributionContract` from `/testing`.

## Design Coverage and Type Ownership

This plan implements the approved design as follows:

| Design area | Owning task(s) |
| --- | --- |
| Package and substrate boundary | 1, 11 |
| One-record source selection and three-family closure | 1, 4, 6, 10 |
| Source-bound policy and Derivation composition | 4, 5, 6 |
| Request, sealed intent, manifest, and independent schema versions | 1, 2, 3 |
| Exact and standing authorization | 7 |
| Preparation, destination, and aggregate state facets | 3, 8, 9 |
| Publication ownership, recovery, and idempotency | 2, 8, 10 |
| Failure classification and safe diagnostics | 1, 4–10 |
| Decline, deactivation, and storage lifecycle | 9 |
| Security, privacy, and resource bounds | 1, 2, 4–10 |
| Product-neutral commands and host contract kit | 3, 5–10 |
| Compatibility, packaging, and CI | 1, 2, 11 |
| Migration, rollout, concrete bindings, service wrapper, and UI copy | Explicitly deferred |

Type ownership is fixed before implementation:

- `types.ts` owns every public JSON-compatible record and its independent `schemaVersion`: proposal, sealed intent, manifest, exact authorization, grant, revocation, request state, safe audit event, destination outcome, read model, and receipt.
- `types.ts` owns `ContributionOperationOptions` with optional `signal`, `expectedRequestRevision`, and `expectedGrantRevision`; every mutating command checks a supplied expected revision before its first transition or effect.
- `types.ts` owns `ContributionResourceLimits`, `PreparationResult`, `PreviewReadyPreparation`, `ContributionReadModel`, `ContributionReceipt`, exact/standing authorization submissions and verified results, and `StandingAuthorizationGrantReadModel`.
- `types.ts` owns the closed `VerifiedDisclosurePolicyDecision` route union and all route members so intent hashing is type-complete from Task 2 onward. `policy.ts` owns authority-port validation and route resolution. `authorization.ts` owns authority ports and matching functions, not the durable schemas.
- `state.ts` owns `ContributionRequestState`, `StandingAuthorizationGrantState`, facet unions, `ContributionAuditEvent`, and transition validation.
- `commands.ts` owns dependency aggregates: `ContributionCommandBaseDependencies`, `ContributionPreparationDependencies`, `ContributionAuthorizationDependencies`, `ContributionGrantDependencies`, `ContributionPublicationDependencies`, and `ContributionCloseoutDependencies`. Each aggregate is the exact intersection of the ports used by its command; it must not expose a generic service locator.
- `testing.ts` owns `EvidenceContributionContractScenario`, the driver, observation, factory, and suite exports.

No task may introduce a public type with an unresolved owner. Each named contract must exist before the first focused typecheck that references it.

---

### Task 1: Package scaffold, dependency boundary, and public domain vocabulary

**Files:**
- Create: `packages/evidence/contribution/.gitignore`
- Create: `packages/evidence/contribution/.yarnrc.yml`
- Create: `packages/evidence/contribution/package.json`
- Create: `packages/evidence/contribution/tsconfig.json`
- Create: `packages/evidence/contribution/tsconfig.build.json`
- Create: `packages/evidence/contribution/vitest.config.ts`
- Create: `packages/evidence/contribution/src/types.ts`
- Create: `packages/evidence/contribution/src/errors.ts`
- Create: `packages/evidence/contribution/src/index.ts`
- Create: `packages/evidence/contribution/src/types.test.ts`
- Modify: `.github/scripts/evidence-package-inventory.test.mjs`
- Modify: `.github/scripts/evidence-source-boundaries.test.mjs`

**Interfaces:**
- Consumes: `EvidenceRecordReference`, `EvidenceArtifactReference`, `EvidenceRepository`, and `Sha256Digest` from `@jinn-network/evidence-repository`; `EvidenceDeriver` from `@jinn-network/evidence-derivation`; Publication contracts from `@jinn-network/evidence-publication`.
- Produces: the final shared type names and stable error-code vocabulary used by all later tasks.

- [ ] **Step 1: Add failing inventory and source-boundary assertions**

Add `contribution` to the explicit package inventory and approved graph:

```js
['contribution', '@jinn-network/evidence-contribution']
```

Its approved Jinn runtime dependencies are exactly:

```js
[
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-publication',
  '@jinn-network/evidence-repository',
]
```

Add a source-boundary test that rejects imports from Discovery, Local Runtime, recorder, issuer, concrete repository subpaths, plugin/application paths, `node:fs`, and ambient network APIs. Permit only the four Evidence packages above, `canonicalize`, `node:crypto` or Publication's hash helper, and inert Node utilities.

- [ ] **Step 2: Run the architecture tests and verify failure**

Run:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
```

Expected: FAIL because `packages/evidence/contribution/package.json` and its source boundary do not exist.

- [ ] **Step 3: Create the package manifest and compiler configuration**

Use this dependency and export shape:

```json
{
  "name": "@jinn-network/evidence-contribution",
  "version": "0.1.0",
  "description": "Host-neutral disclosure authorization and publication workflow for Jinn Evidence.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": { "node": ">=22" },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/evidence/contribution"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./testing": {
      "import": "./dist/testing.js",
      "types": "./dist/testing.d.ts"
    }
  },
  "files": ["dist/", "README.md"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/evidence-derivation": "0.1.0",
    "@jinn-network/evidence-protocol": "0.1.0",
    "@jinn-network/evidence-publication": "0.1.0",
    "@jinn-network/evidence-repository": "0.1.0",
    "canonicalize": "3.0.0"
  },
  "peerDependencies": { "vitest": "^4.1.8" },
  "peerDependenciesMeta": { "vitest": { "optional": true } },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/evidence-derivation": "portal:../derivation",
    "@jinn-network/evidence-protocol": "portal:../protocol",
    "@jinn-network/evidence-publication": "portal:../publication",
    "@jinn-network/evidence-repository": "portal:../repository",
    "vite": "6.4.3"
  }
}
```

Match neighboring Evidence packages for `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, and Vitest configuration.

- [ ] **Step 4: Freeze the public vocabulary with failing type tests**

In `types.test.ts`, assert that the family union accepts only the Repository's three families, a request has one source record, destinations are non-empty after parsing, and Task-like strings cannot enter the record-family slot:

```ts
import { describe, expect, expectTypeOf, test } from "vitest";
import type {
  ContributionDestination,
  CreateContributionRequestInput,
  DisclosurePolicyDecisionReference,
} from "./types.js";

describe("Contribution public vocabulary", () => {
  test("models one exact source and explicit destinations", () => {
    const policy: DisclosurePolicyDecisionReference = {
      authorityId: "https://authority.example/policy",
      decisionId: "decision-1",
      digest: `sha256:${"a".repeat(64)}`,
    };
    const input: CreateContributionRequestInput = {
      idempotencyKey: "plugin:attempt-1",
      source: {
        repositoryBindingId: "private-local",
        record: {
          family: "execution-evidence",
          digest: `sha256:${"b".repeat(64)}`,
        },
      },
      stagingRepositoryBindingId: "private-staging",
      policyDecision: policy,
      destinations: [{
        destination: "https://destinations.example/ipfs",
        medium: "https://media.example/ipfs",
        profile: "https://profiles.example/evidence/v1",
        configurationDigest: `sha256:${"c".repeat(64)}`,
        label: "Public IPFS",
        irreversible: true,
        deactivation: "unsupported",
      }],
      limits: {
        maxDestinations: 4,
        maxArtifacts: 128,
        maxArtifactBytes: 16_777_216,
        maxTotalArtifactBytes: 67_108_864,
        maxManifestBytes: 1_048_576,
        maxConcurrentDestinations: 2,
      },
      hostContext: { attemptId: "attempt-1" },
    };
    expect(input.source.record.family).toBe("execution-evidence");
    expectTypeOf<ContributionDestination["deactivation"]>()
      .toEqualTypeOf<"supported" | "unsupported">();
  });
});
```

- [ ] **Step 5: Implement `types.ts`, `errors.ts`, and root exports**

Define and export these exact top-level contracts:

```ts
export type ContributionRequestId = string;
export type ContributionGrantId = string;
export type ContributionDecisionId = string;
export type ContributionAggregateStatus =
  | "proposed"
  | "preparing"
  | "review-required"
  | "withheld"
  | "awaiting-authorization"
  | "publishing"
  | "attention-required"
  | "completed"
  | "declined"
  | "deactivated";

export interface EvidenceSourceSelection {
  readonly repositoryBindingId: string;
  readonly record: EvidenceRecordReference;
}

export interface DisclosurePolicyDecisionReference {
  readonly authorityId: string;
  readonly decisionId: string;
  readonly digest: Sha256Digest;
}

export interface ContributionDestination {
  readonly destination: string;
  readonly medium: string;
  readonly profile: string;
  readonly configurationDigest: Sha256Digest;
  readonly label: string;
  readonly irreversible: boolean;
  readonly deactivation: "supported" | "unsupported";
}

export interface CreateContributionRequestInput {
  readonly idempotencyKey?: string;
  readonly source: EvidenceSourceSelection;
  readonly stagingRepositoryBindingId: string;
  readonly policyDecision: DisclosurePolicyDecisionReference;
  readonly destinations: readonly ContributionDestination[];
  readonly limits: ContributionResourceLimits;
  readonly hostContext?: Readonly<Record<string, string>>;
  readonly supersedes?: ContributionRequestId;
}

export interface ContributionResourceLimits {
  readonly maxDestinations: number;
  readonly maxArtifacts: number;
  readonly maxArtifactBytes: number;
  readonly maxTotalArtifactBytes: number;
  readonly maxManifestBytes: number;
  readonly maxConcurrentDestinations: number;
}

export interface ContributionOperationOptions {
  readonly signal?: AbortSignal;
  readonly expectedRequestRevision?: number;
  readonly expectedGrantRevision?: number;
}
```

Define preparation routes, prepared output, authorization modes, per-destination facets, safe reason codes, safe audit events, read models, and receipt types in the same file. Give proposal, sealed intent, manifest, authorization, grant, revocation, state, event, and receipt records independent schema-version constants. Reuse Repository and Publication reference types instead of creating aliases.

Safe stored/returned reasons use only this closed vocabulary; upstream or port-specific messages map to it rather than being copied:

```ts
export const CONTRIBUTION_SAFE_REASON_CODES = [
  "POLICY_WITHHELD",
  "SENSITIVE_REVIEW_REQUIRED",
  "DESTINATION_DENIED",
  "GRANT_SCOPE_MISMATCH",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_REVOKED",
  "ACCESS_DENIED",
  "BINDING_LIMIT_EXCEEDED",
  "WITHDRAWAL_UNSUPPORTED",
  "OPERATOR_ATTENTION_REQUIRED",
] as const;

export type ContributionSafeReasonCode =
  (typeof CONTRIBUTION_SAFE_REASON_CODES)[number];
```

Versioned records may expose only a named, bounded, inert `extensions` bag. Readers preserve that bag byte-for-byte when rewriting a compatible record but never consult it for authority, routing, identity derivation, limits, or transitions. Unknown major schema versions fail closed.

Define the intent-bearing policy union now so Task 2 can hash it without a forward type:

```ts
export type VerifiedDisclosurePolicyDecision =
  | VerifiedDeriveExecutionDecision
  | VerifiedSignedUnchangedDecision
  | VerifiedReuseDecision
  | VerifiedWithholdDecision;
```

Every member contains the verified decision reference, exact source reference, issue/expiry times, and a family-compatible `kind`. The derive member additionally contains exact private policy and public implementation-descriptor Repository references, source artifact entity-ID/reference pairs, policy/implementation/configuration digests, `completedAt`, and safe commitment-risk facts. The signed member contains only its exact allowed companion artifacts. The reuse member contains the prior manifest reference/fingerprint, exact prepared record/artifacts, and policy/implementation identities. The withhold member contains content-free reason codes only.

Use this preparation result closure:

```ts
export interface PreparedUnavailableArtifact {
  readonly entityId: string;
  readonly reasonCode: string;
  readonly sourceCommitment?: Sha256Digest;
}

export interface PreparedDisclosureRisk {
  readonly irreversibility: "mutable-location" | "immutable-or-replicable";
  readonly sourceCommitmentCorrelation:
    | "none-declared"
    | "low"
    | "elevated"
    | "unknown";
}

export interface PreparedContributionDestination {
  readonly descriptor: ContributionDestination;
  readonly bundleKey: string;
  readonly payloadFingerprint: Sha256Digest;
}

export interface PreparedDisclosureManifest {
  readonly schemaVersion: 1;
  readonly requestId: ContributionRequestId;
  readonly intentFingerprint: Sha256Digest;
  readonly source: EvidenceRecordReference;
  readonly preparedRecord: EvidenceRecordReference;
  readonly artifacts: readonly EvidenceArtifactReference[];
  readonly preparation:
    | {
        readonly kind: "publishable-unchanged";
        readonly policyInput: EvidenceArtifactReference;
        readonly implementationDescriptor: EvidenceArtifactReference;
        readonly policyDigest: Sha256Digest;
        readonly implementationDigest: Sha256Digest;
        readonly configurationDigest?: Sha256Digest;
      }
    | {
        readonly kind: "derived";
        readonly derivationReceipt: EvidenceArtifactReference;
        readonly policyInput: EvidenceArtifactReference;
        readonly implementationDescriptor: EvidenceArtifactReference;
        readonly policyDigest: Sha256Digest;
        readonly implementationDigest: Sha256Digest;
        readonly configurationDigest?: Sha256Digest;
      }
    | { readonly kind: "signed-unchanged" }
    | {
        readonly kind: "verified-reuse";
        readonly priorPreviewFingerprint: Sha256Digest;
      };
  readonly policyDecision: DisclosurePolicyDecisionReference;
  readonly bindingImpact?: DerivationBindingImpact;
  readonly unavailableArtifacts: readonly PreparedUnavailableArtifact[];
  readonly risk: PreparedDisclosureRisk;
  readonly destinations: readonly PreparedContributionDestination[];
}

export interface PreparedDisclosure {
  readonly manifest: PreparedDisclosureManifest;
  readonly manifestBytes: Uint8Array;
  readonly previewFingerprint: Sha256Digest;
}

export interface PreviewReadyPreparation {
  readonly status: "preview-ready";
  readonly disclosure: PreparedDisclosure;
}

export type PreparationResult =
  | PreviewReadyPreparation
  | {
      readonly status: "review-required";
      readonly reviewReference: string;
    }
  | {
    readonly status: "withheld";
      readonly reasons: readonly {
        readonly code: ContributionSafeReasonCode;
      }[];
    };
```

`ContributionReadModel` is a safe immutable projection with request/revision/schema identities, aggregate and facet statuses, exact references/digests, manifest bytes plus preview fingerprint when present, authorization identities/modes, safe destination outcomes, warnings, and timestamps. `ContributionReceipt` is the independently versioned current/final audit projection detailed in Task 9; neither type contains Evidence payload bytes or opaque binding state.

Define `EvidenceContributionError` with this stable closed code union:

```ts
export const EVIDENCE_CONTRIBUTION_ERROR_CODES = [
  "INVALID_INPUT",
  "SOURCE_NOT_FOUND",
  "SOURCE_DIGEST_MISMATCH",
  "SOURCE_NONCONFORMING",
  "RESOURCE_LIMIT_EXCEEDED",
  "POLICY_INVALID",
  "POLICY_DENIED",
  "REVIEW_REQUIRED",
  "WITHHELD",
  "AUTHORIZATION_REQUIRED",
  "AUTHORIZATION_DENIED",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_REVOKED",
  "AUTHORIZATION_STALE",
  "DESTINATION_CONFLICT",
  "DESTINATION_UNSUPPORTED",
  "ACCESS_RETRYABLE",
  "STORE_CONFLICT",
  "STORE_CORRUPT",
  "WORK_CLAIM_HELD",
  "PUBLICATION_RETRYABLE",
  "PUBLICATION_TERMINAL",
  "DEACTIVATION_UNSUPPORTED",
  "DEACTIVATION_RETRYABLE",
  "PORT_PROTOCOL_VIOLATION",
  "OPERATION_ABORTED",
] as const;
```

Errors expose only `code`, a content-free message selected by core from a closed map, and an optional bounded safe cause chain containing Contribution error codes only. Never attach the original exception, its message/stack, or arbitrary context objects.

- [ ] **Step 6: Install, typecheck, and run focused tests**

Run:

```bash
cd packages/evidence/contribution
corepack yarn@4.13.0 install
yarn typecheck
yarn test src/types.test.ts
cd ../../..
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
```

Expected: PASS. Commit the generated `yarn.lock`.

- [ ] **Step 7: Commit**

```bash
git add packages/evidence/contribution .github/scripts/evidence-package-inventory.test.mjs .github/scripts/evidence-source-boundaries.test.mjs
git commit -m "feat(evidence-contribution): define package contracts"
```

---

### Task 2: Deterministic request, intent, and disclosure-manifest identities

**Files:**
- Create: `packages/evidence/contribution/src/canonical-json.ts`
- Create: `packages/evidence/contribution/src/canonical-json.test.ts`
- Create: `packages/evidence/contribution/src/validation.ts`
- Create: `packages/evidence/contribution/src/validation.test.ts`
- Create: `packages/evidence/contribution/src/identities.ts`
- Create: `packages/evidence/contribution/src/identities.test.ts`
- Create: `packages/evidence/contribution/src/request.ts`
- Create: `packages/evidence/contribution/src/request.test.ts`
- Create: `packages/evidence/contribution/src/manifest.ts`
- Create: `packages/evidence/contribution/src/manifest.test.ts`
- Modify: `packages/evidence/contribution/src/index.ts`

**Interfaces:**
- Consumes: Task 1 request, destination, policy-reference, and error types; Publication's `derivePublicationIdentities` and `hashExactBytes`.
- Produces: `normalizeCreateContributionRequestInput`, `createContributionProposalFingerprint`, `sealContributionIntent`, `createPreparedDisclosureManifest`, `parsePreparedDisclosureManifest`, `createContributionReceiptFingerprint`, and their exact fingerprints.

- [ ] **Step 1: Write failing canonicalization and defensive-snapshot tests**

Cover:

- identical logical objects with different key insertion order produce identical bytes;
- arrays remain ordered;
- destinations and artifacts normalize into deterministic sorted order;
- duplicate destination IRIs with different configuration digests are rejected;
- invalid digest, IRI, timestamp, proxy, accessor, sparse array, non-finite number, and mutable byte inputs are rejected;
- credentials are not accepted in destination descriptors;
- mutation after normalization does not change identities;
- unknown major schema versions fail closed; and
- permitted inert extensions round-trip without acquiring authority or changing the fingerprint of the already-sealed record.

Use this identity assertion:

```ts
const first = sealContributionIntent({
  request: inputA,
  disclosureIntent: verifiedRouteA,
});
const second = sealContributionIntent({
  request: inputB,
  disclosureIntent: verifiedRouteB,
});
expect(first.intentFingerprint).toBe(second.intentFingerprint);
expect(first.request).not.toBe(inputA);
expect(first.request.destinations).not.toBe(inputA.destinations);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd packages/evidence/contribution
yarn test src/canonical-json.test.ts src/validation.test.ts src/identities.test.ts src/request.test.ts src/manifest.test.ts
```

Expected: FAIL because the identity modules do not exist.

- [ ] **Step 3: Implement closed validation and canonical private serialization**

`canonicalJsonBytes` must:

1. recursively snapshot only inert JSON-compatible own data;
2. reject proxies, accessors, symbols, cycles, unsupported prototypes, and unbounded depth;
3. use `canonicalize` on the snapshot;
4. UTF-8 encode the exact canonical string; and
5. reject a result above a named manifest-byte limit supplied by the caller.

Export:

```ts
export function canonicalJsonBytes(
  value: unknown,
  maxBytes: number,
): Uint8Array;

export function parseContributionDigest(
  value: unknown,
  field: string,
): Sha256Digest;

export function parseAbsoluteIri(
  value: unknown,
  field: string,
): string;
```

- [ ] **Step 4: Implement request sealing and fingerprints**

Export:

```ts
export interface SealedContributionIntent {
  readonly request: CreateContributionRequestInput;
  readonly disclosureIntent: VerifiedDisclosurePolicyDecision;
  readonly intentBytes: Uint8Array;
  readonly intentFingerprint: Sha256Digest;
}

export function normalizeCreateContributionRequestInput(
  input: CreateContributionRequestInput,
): CreateContributionRequestInput;

export function createContributionProposalFingerprint(
  input: CreateContributionRequestInput,
): Sha256Digest;

export function sealContributionIntent(
  input: {
    readonly request: CreateContributionRequestInput;
    readonly disclosureIntent: VerifiedDisclosurePolicyDecision;
  },
): SealedContributionIntent;

export function createContributionReceiptFingerprint(
  receipt: ContributionReceipt,
): Sha256Digest;
```

The proposal fingerprint used only for duplicate-create detection covers source binding ID, exact record reference, staging binding ID, policy-decision reference, sorted destination descriptors, resource bounds, `supersedes`, and sorted host-context key/value pairs. The sealed intent fingerprint additionally covers the verified preparation disposition, exact policy and public implementation input references/digests, secret configuration digest, source-artifact selection, completion time, and reuse inputs. Neither fingerprint covers credentials.

- [ ] **Step 5: Implement exact prepared-manifest creation**

Define:

```ts
export interface CreatePreparedDisclosureManifestInput {
  readonly requestId: ContributionRequestId;
  readonly intentFingerprint: Sha256Digest;
  readonly source: EvidenceRecordReference;
  readonly preparedRecord: EvidenceRecordReference;
  readonly artifacts: readonly EvidenceArtifactReference[];
  readonly preparation:
    | {
        readonly kind: "publishable-unchanged";
        readonly policyInput: EvidenceArtifactReference;
        readonly implementationDescriptor: EvidenceArtifactReference;
        readonly policyDigest: Sha256Digest;
        readonly implementationDigest: Sha256Digest;
        readonly configurationDigest?: Sha256Digest;
      }
    | {
        readonly kind: "derived";
        readonly derivationReceipt: EvidenceArtifactReference;
        readonly policyInput: EvidenceArtifactReference;
        readonly implementationDescriptor: EvidenceArtifactReference;
        readonly policyDigest: Sha256Digest;
        readonly implementationDigest: Sha256Digest;
        readonly configurationDigest?: Sha256Digest;
      }
    | { readonly kind: "signed-unchanged" }
    | {
        readonly kind: "verified-reuse";
        readonly priorPreviewFingerprint: Sha256Digest;
      };
  readonly policyDecision: DisclosurePolicyDecisionReference;
  readonly destinations: readonly ContributionDestination[];
  readonly bindingImpact?: DerivationBindingImpact;
  readonly unavailableArtifacts: readonly PreparedUnavailableArtifact[];
  readonly risk: PreparedDisclosureRisk;
}

export function createPreparedDisclosureManifest(
  input: CreatePreparedDisclosureManifestInput,
): PreparedDisclosure;
```

For every destination, call Publication's `derivePublicationIdentities` using one prepared record, the sorted artifact set, and the exact destination IRI. Persist the returned `bundleKey` and `payloadFingerprint`; do not recreate Publication's identity algorithm.

- [ ] **Step 6: Run focused and package tests**

Run:

```bash
cd packages/evidence/contribution
yarn typecheck
yarn test src/canonical-json.test.ts src/validation.test.ts src/identities.test.ts src/request.test.ts src/manifest.test.ts
yarn test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/evidence/contribution/src
git commit -m "feat(evidence-contribution): bind exact disclosure identities"
```

---

### Task 3: Durable state facets, compare-and-swap store, and work claims

**Files:**
- Create: `packages/evidence/contribution/src/state.ts`
- Create: `packages/evidence/contribution/src/state.test.ts`
- Create: `packages/evidence/contribution/src/store.ts`
- Create: `packages/evidence/contribution/src/store.test.ts`
- Create: `packages/evidence/contribution/src/testing-fixtures.ts`
- Create: `packages/evidence/contribution/src/commands.ts`
- Create: `packages/evidence/contribution/src/commands.test.ts`
- Modify: `packages/evidence/contribution/src/index.ts`

**Interfaces:**
- Consumes: Task 2 sealed intent and identity functions.
- Produces: `ContributionStore`, versioned request/grant records, state transition functions, `createContributionRequest`, `inspectContribution`, and the in-memory store used by later tests.

- [ ] **Step 1: Write failing state and store contract tests**

Test:

- `proposed` can move to `preparing` or `declined`;
- `preview-ready` does not imply authorization;
- preparation cannot skip directly to `published`;
- authorization and publication are independent per destination;
- mixed outcomes derive `attention-required`;
- at least one completed Publication receipt is required for aggregate `completed`;
- deactivation remains orthogonal;
- CAS rejects stale revisions;
- create rejects duplicate request IDs;
- identical idempotency key and normalized proposal fingerprint returns the existing request;
- reused idempotency key with a different proposal fingerprint is `STORE_CONFLICT`;
- source, verified policy/implementation material, artifact-selection rules, resource limits, and destinations are immutable after intent sealing;
- a `supersedes` link creates a distinct request and imports no preparation or authorization;
- returned objects are defensive snapshots; and
- an expired claim may be replaced but a live claim is retained.

Use:

```ts
const store = new InMemoryContributionStore();
const created = await store.createRequest(initialState);
await expect(
  store.compareAndSwapRequest(created, {
    ...created.value,
    preparation: { status: "preparing" },
  }),
).resolves.toMatchObject({ revision: 2 });
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd packages/evidence/contribution
yarn test src/state.test.ts src/store.test.ts src/commands.test.ts
```

Expected: FAIL because state and store modules do not exist.

- [ ] **Step 3: Define the typed CAS store**

Export:

```ts
export interface VersionedContributionRequest {
  readonly revision: number;
  readonly value: ContributionRequestState;
}

export interface VersionedStandingGrant {
  readonly revision: number;
  readonly value: StandingAuthorizationGrantState;
}

export interface ContributionStore {
  loadRequest(
    requestId: ContributionRequestId,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest | null>;
  findRequestByIdempotencyKey(
    idempotencyKey: string,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest | null>;
  createRequest(
    state: ContributionRequestState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest>;
  compareAndSwapRequest(
    expected: VersionedContributionRequest,
    next: ContributionRequestState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedContributionRequest>;
  loadGrant(
    grantId: ContributionGrantId,
    options?: ContributionOperationOptions,
  ): Promise<VersionedStandingGrant | null>;
  createGrant(
    state: StandingAuthorizationGrantState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedStandingGrant>;
  compareAndSwapGrant(
    expected: VersionedStandingGrant,
    next: StandingAuthorizationGrantState,
    options?: ContributionOperationOptions,
  ): Promise<VersionedStandingGrant>;
}
```

Store methods accept and return inert snapshots. Unknown schema versions, impossible transitions, changed immutable fields, non-monotonic revisions, and rollback of immutable decision/event/receipt history map to `STORE_CORRUPT` or `STORE_CONFLICT`.

- [ ] **Step 4: Implement state facets and aggregate derivation**

Represent preparation, each destination's authorization/publication/deactivation, append-only versioned audit events, and this work claim:

```ts
export interface ContributionWorkClaim {
  readonly ownerId: string;
  readonly generation: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}
```

`ContributionRequestState` contains the immutable normalized proposal and proposal fingerprint, an optional immutable sealed intent and fingerprint created only after policy verification, the preparation facet, one facet set per destination, safe append-only audit events, append-only `{ receipt, receiptFingerprint }` revisions, work claim, timestamps, and schema version. It never contains record or artifact payload bytes. `StandingAuthorizationGrantState` contains the immutable verified grant plus append-only revocations, safe audit events, revision metadata, and schema version.

Export pure transition validators and:

```ts
export function deriveContributionAggregateStatus(
  state: ContributionRequestState,
): ContributionAggregateStatus;

export function acquireContributionWorkClaim(
  state: ContributionRequestState,
  ownerId: string,
  now: string,
  expiresAt: string,
): ContributionRequestState;

export function releaseContributionWorkClaim(
  state: ContributionRequestState,
  ownerId: string,
  generation: number,
): ContributionRequestState;
```

The claim is a contention optimization, not an authority boundary.

- [ ] **Step 5: Implement create and inspect commands**

Define shared command dependencies:

```ts
export interface ContributionClock {
  now(): string;
}

export interface ContributionIdentifierSource {
  nextRequestId(): ContributionRequestId;
  nextDecisionId(): ContributionDecisionId;
  nextGrantId(): ContributionGrantId;
  nextWorkerId(): string;
}

export interface ContributionCommandBaseDependencies {
  readonly store: ContributionStore;
  readonly clock: ContributionClock;
  readonly identifiers: ContributionIdentifierSource;
}
```

Implement:

```ts
export async function createContributionRequest(
  input: CreateContributionRequestInput,
  dependencies: ContributionCommandBaseDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;

export async function inspectContribution(
  requestId: ContributionRequestId,
  dependencies: Pick<ContributionCommandBaseDependencies, "store">,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;
```

On create, compute the normalized proposal fingerprint before the store call. On every mutating command, compare a supplied `expectedRequestRevision` or `expectedGrantRevision` with the loaded version before acquiring a claim or invoking an external port. A mismatch is `STORE_CONFLICT`; omission preserves retry-safe server-side CAS behavior.

- [ ] **Step 6: Implement and test `InMemoryContributionStore`**

Place it in `testing-fixtures.ts`, not the root entrypoint. It must clone input and output, enforce exact CAS revisions, and expose effect-free counters for contract tests.

- [ ] **Step 7: Run focused and package tests**

Run:

```bash
cd packages/evidence/contribution
yarn typecheck
yarn test src/state.test.ts src/store.test.ts src/commands.test.ts
yarn test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/evidence/contribution/src
git commit -m "feat(evidence-contribution): add durable workflow state"
```

---

### Task 4: Exact source resolution and disclosure-policy gate

**Files:**
- Create: `packages/evidence/contribution/src/source.ts`
- Create: `packages/evidence/contribution/src/source.test.ts`
- Create: `packages/evidence/contribution/src/policy.ts`
- Create: `packages/evidence/contribution/src/policy.test.ts`
- Modify: `packages/evidence/contribution/src/types.ts`
- Modify: `packages/evidence/contribution/src/commands.ts`
- Modify: `packages/evidence/contribution/src/index.ts`

**Interfaces:**
- Consumes: Task 1 source and policy references, Task 3 operation options.
- Produces: Repository, policy-authority, Derivation-resolver, and protected-review ports plus validated family-specific preparation routes.

- [ ] **Step 1: Write failing source and policy tests**

Cover:

- missing source record is `SOURCE_NOT_FOUND`;
- wrong bytes under a source reference are `SOURCE_DIGEST_MISMATCH`;
- exact Execution, Evaluation, and Verification records call the matching Protocol validator;
- nonconforming bytes are `SOURCE_NONCONFORMING` with no raw diagnostic snippets;
- a policy decision for another source is rejected;
- an expired or malformed policy decision is rejected;
- `derive-execution` is valid only for `execution-evidence`;
- `disclose-signed-unchanged` is valid only for Evaluation or Verification;
- `withhold` returns content-free reasons; and
- policy authority return objects are snapshotted and checked for proxies/accessors.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd packages/evidence/contribution
yarn test src/source.test.ts src/policy.test.ts
```

Expected: FAIL because source and policy modules do not exist.

- [ ] **Step 3: Define authority-bearing ports and verified routes**

Export:

```ts
export interface RepositoryResolver {
  resolve(
    bindingId: string,
    options?: ContributionOperationOptions,
  ): Promise<EvidenceRepository>;
}

export interface DisclosurePolicyAuthority {
  verify(
    reference: DisclosurePolicyDecisionReference,
    source: EvidenceRecordReference,
    options?: ContributionOperationOptions,
  ): Promise<VerifiedDisclosurePolicyDecision>;
}

export interface DerivationResolver {
  resolve(
    input: {
      readonly implementationDigest: Sha256Digest;
      readonly configurationDigest?: Sha256Digest;
    },
    options?: ContributionOperationOptions,
  ): Promise<EvidenceDeriver>;
}

export interface ReviewReferenceStore {
  retain(
    input: {
      readonly requestId: ContributionRequestId;
      readonly findings: readonly DerivationFinding[];
    },
    options?: ContributionOperationOptions,
  ): Promise<{ readonly reviewReference: string }>;
}
```

Validate the `VerifiedDisclosurePolicyDecision` closed union defined in Task 1:

```ts
type VerifiedDisclosurePolicyDecision =
  | VerifiedDeriveExecutionDecision
  | VerifiedSignedUnchangedDecision
  | VerifiedReuseDecision
  | VerifiedWithholdDecision;
```

`VerifiedDeriveExecutionDecision` contains exact private Repository references for policy bytes and public implementation descriptor bytes, exact source artifact entity IDs/references, implementation/configuration digests, and `completedAt`. `VerifiedSignedUnchangedDecision` contains an exact allowed companion artifact set. No route contains credentials or secret detector configuration.

- [ ] **Step 4: Implement exact source loading and Protocol dispatch**

Export:

```ts
export interface LoadedEvidenceSource {
  readonly reference: EvidenceRecordReference;
  readonly bytes: Uint8Array;
}

export async function loadAndValidateEvidenceSource(
  selection: EvidenceSourceSelection,
  repositories: RepositoryResolver,
  options?: ContributionOperationOptions,
): Promise<LoadedEvidenceSource>;
```

Call `validateExecutionEvidence`, `validateResultEvaluation`, or `validateExecutionVerification` by family. Verify the validator's `recordDigest` equals the requested digest. Return a private byte snapshot.

- [ ] **Step 5: Implement source-bound policy verification**

Export:

```ts
export async function resolveDisclosureRoute(
  reference: DisclosurePolicyDecisionReference,
  source: EvidenceRecordReference,
  authority: DisclosurePolicyAuthority,
  now: string,
  options?: ContributionOperationOptions,
): Promise<VerifiedDisclosurePolicyDecision>;
```

Recheck exact source family/digest, policy-decision digest, issue/expiry times, route-family compatibility, artifact references, and implementation/configuration identities after the authority returns.

- [ ] **Step 6: Run focused and package tests**

Run:

```bash
cd packages/evidence/contribution
yarn typecheck
yarn test src/source.test.ts src/policy.test.ts
yarn test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/evidence/contribution/src
git commit -m "feat(evidence-contribution): verify source disclosure policy"
```

---

### Task 5: Execution Evidence preparation through Derivation

**Files:**
- Create: `packages/evidence/contribution/src/prepare-execution.ts`
- Create: `packages/evidence/contribution/src/prepare-execution.test.ts`
- Modify: `packages/evidence/contribution/src/commands.ts`
- Modify: `packages/evidence/contribution/src/commands.test.ts`
- Modify: `packages/evidence/contribution/src/index.ts`

**Interfaces:**
- Consumes: Task 2 manifest builder, Task 3 store, Task 4 exact source and verified `derive-execution` route, existing `EvidenceDeriver`.
- Produces: Execution `publishable-unchanged`, `derived`, `review-required`, and `withheld` state transitions plus `prepareContribution`.

- [ ] **Step 1: Write failing Execution preparation tests**

Use `createSyntheticDerivationInput` and a real `EvidenceDeriver` from `@jinn-network/evidence-derivation/testing`. Prove:

- exact policy, implementation descriptor, and source artifacts load from private Repositories;
- source artifact entity IDs remain paired with the correct exact bytes;
- `publishable-unchanged` stages only returned safe bytes;
- `derived` stages the new record, every returned publishable artifact, and scrub receipt;
- staging receipts must match exact expected references and sizes;
- output Protocol conformance is checked again;
- binding impact and Derivation identities enter the manifest;
- `review-required` sends findings only to `ReviewReferenceStore` and leaves no publishable payload in Contribution state;
- `withheld` stores only content-free reasons;
- cancellation leaves the private source untouched; and
- no Publication resolver is called during preparation.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd packages/evidence/contribution
yarn test src/prepare-execution.test.ts src/commands.test.ts
```

Expected: FAIL because Execution preparation is not implemented.

- [ ] **Step 3: Implement exact private input loading**

Export:

```ts
export async function prepareExecutionDisclosure(
  input: {
    readonly requestId: ContributionRequestId;
    readonly intentFingerprint: Sha256Digest;
    readonly source: LoadedEvidenceSource;
    readonly route: VerifiedDeriveExecutionDecision;
    readonly destinations: readonly ContributionDestination[];
  },
  dependencies: {
    readonly repositories: RepositoryResolver;
    readonly derivations: DerivationResolver;
    readonly reviews: ReviewReferenceStore;
  },
  options?: ContributionOperationOptions,
): Promise<PreparationResult>;
```

Load every referenced artifact and policy input by digest, snapshot bytes, verify returned Repository receipts, and pass exact bytes to `EvidenceDeriver.derive`.

Before Derivation, persist the exact policy bytes and public implementation-descriptor bytes in the private non-announcing staging Repository and verify their receipts. Keep those references in the sealed intent/manifest for recovery; do not include them in Publication's publishable artifact list unless Derivation independently returns them as publishable artifacts. Secret configuration stays behind `DerivationResolver` and is represented only by its digest.

- [ ] **Step 4: Implement all four Derivation outcomes**

For publishable outcomes:

1. validate the returned record as conforming Execution Evidence;
2. verify every returned artifact digest;
3. stage record and artifacts in the request's non-announcing staging Repository;
4. build the exact manifest with Publication identities; and
5. return a `preview-ready` preparation result.

For review and withholding:

```ts
return outcome.status === "review-required"
  ? {
      status: "review-required",
      reviewReference: (
        await dependencies.reviews.retain({
          requestId: input.requestId,
          findings: outcome.findings,
        }, options)
      ).reviewReference,
    }
  : {
      status: "withheld",
      reasons: mapDerivationHoldReasons(outcome.reasons),
    };
```

`mapDerivationHoldReasons` converts known upstream categories to the closed `ContributionSafeReasonCode` vocabulary and maps every unknown code to `POLICY_WITHHELD`; it never copies an upstream string. Never serialize findings into Contribution state.

- [ ] **Step 5: Add the retry-safe `prepareContribution` command**

Implement:

```ts
export async function prepareContribution(
  requestId: ContributionRequestId,
  dependencies: ContributionPreparationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;
```

Define the aggregate in `commands.ts`:

```ts
export interface ContributionPreparationDependencies
  extends ContributionCommandBaseDependencies {
  readonly repositories: RepositoryResolver;
  readonly policies: DisclosurePolicyAuthority;
  readonly derivations: DerivationResolver;
  readonly reviews: ReviewReferenceStore;
}
```

It must:

1. claim the request with CAS;
2. load and validate the exact source;
3. verify the source-bound policy decision and obtain its exact route material;
4. seal the normalized proposal plus the verified route exactly once;
5. CAS the sealed intent before Derivation or staging I/O;
6. dispatch the Execution route;
7. CAS the immutable preparation result;
8. release the claim; and
9. return the safe read model.

If another worker already stored the same preparation, return it. If it stored different prepared identities under the same intent, fail `STORE_CORRUPT`.

- [ ] **Step 6: Run focused and package tests**

Run:

```bash
cd packages/evidence/contribution
yarn typecheck
yarn test src/prepare-execution.test.ts src/commands.test.ts
yarn test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/evidence/contribution/src
git commit -m "feat(evidence-contribution): prepare execution disclosures"
```

---

### Task 6: Signed-record preparation and verified reuse

**Files:**
- Create: `packages/evidence/contribution/src/prepare-signed.ts`
- Create: `packages/evidence/contribution/src/prepare-signed.test.ts`
- Create: `packages/evidence/contribution/src/prepare-reuse.ts`
- Create: `packages/evidence/contribution/src/prepare-reuse.test.ts`
- Modify: `packages/evidence/contribution/src/policy.ts`
- Modify: `packages/evidence/contribution/src/commands.ts`
- Modify: `packages/evidence/contribution/src/commands.test.ts`

**Interfaces:**
- Consumes: Task 4 signed policy routes, Task 5 `prepareContribution`, Task 2 manifest parser.
- Produces: exact Evaluation/Verification preparation and a closed `verified-reuse` route for already-public Evidence.

- [ ] **Step 1: Write failing signed-record tests**

Load the Protocol golden Result Evaluation and Execution Verification fixtures. Prove:

- envelope bytes remain byte-identical;
- a signed record never resolves or calls `EvidenceDeriver`;
- only policy-listed companion artifact bytes are staged;
- a companion artifact mismatch fails closed;
- a policy that requests transformation is rejected;
- a withheld signed record produces no staged record and no Publication input; and
- an Evaluation and Verification each remain an independent one-record request.

- [ ] **Step 2: Write failing reuse tests**

Prove:

- reuse requires exact prior manifest bytes and expected preview fingerprint;
- prior source and prepared record references must match the new policy decision;
- every reused record/artifact byte is reloaded and digest-verified;
- prior destination authorization is not imported;
- new destinations produce new Publication bundle and payload identities; and
- changed policy or implementation identity rejects reuse.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
cd packages/evidence/contribution
yarn test src/prepare-signed.test.ts src/prepare-reuse.test.ts src/commands.test.ts
```

Expected: FAIL because signed and reuse routes do not exist.

- [ ] **Step 4: Implement exact signed preparation**

Export:

```ts
export async function prepareSignedDisclosure(
  input: {
    readonly requestId: ContributionRequestId;
    readonly intentFingerprint: Sha256Digest;
    readonly source: LoadedEvidenceSource;
    readonly route: VerifiedSignedUnchangedDecision;
    readonly stagingRepositoryBindingId: string;
    readonly destinations: readonly ContributionDestination[];
  },
  repositories: RepositoryResolver,
  options?: ContributionOperationOptions,
): Promise<PreviewReadyPreparation>;
```

Accept only `result-evaluation` and `execution-verification`. Stage the exact source envelope and exact allowed companion artifacts. Mark preparation `signed-unchanged`.

- [ ] **Step 5: Implement verified reuse**

Use the Task 1 `VerifiedReuseDecision` member of the closed policy union. It contains prior private manifest bytes by Repository artifact reference, expected prior fingerprint, exact prepared record/artifact sources, and policy/implementation identities.

Export:

```ts
export async function prepareReusableDisclosure(
  input: {
    readonly requestId: ContributionRequestId;
    readonly intentFingerprint: Sha256Digest;
    readonly source: LoadedEvidenceSource;
    readonly route: VerifiedReuseDecision;
    readonly destinations: readonly ContributionDestination[];
  },
  repositories: RepositoryResolver,
  options?: ContributionOperationOptions,
): Promise<PreviewReadyPreparation>;
```

Parse the prior manifest, verify its fingerprint and source/derivation identities, revalidate bytes, and create a new manifest with preparation kind `verified-reuse` and only the new request's destinations.

- [ ] **Step 6: Complete family dispatch in `prepareContribution`**

Dispatch only:

```ts
switch (route.kind) {
  case "derive-execution":
    return prepareExecutionDisclosure(input, dependencies, options);
  case "disclose-signed-unchanged":
    return prepareSignedDisclosure(input, dependencies.repositories, options);
  case "reuse-prepared":
    return prepareReusableDisclosure(input, dependencies.repositories, options);
  case "withhold":
    return { status: "withheld", reasons: route.reasons };
}
```

TypeScript's `never` exhaustiveness check must fail compilation if a route is added without handling.

- [ ] **Step 7: Run focused and package tests**

Run:

```bash
cd packages/evidence/contribution
yarn typecheck
yarn test src/prepare-signed.test.ts src/prepare-reuse.test.ts src/commands.test.ts
yarn test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/evidence/contribution/src
git commit -m "feat(evidence-contribution): preserve signed and reused evidence"
```

---

### Task 7: Exact authorization and scoped standing grants

**Files:**
- Create: `packages/evidence/contribution/src/authorization.ts`
- Create: `packages/evidence/contribution/src/authorization.test.ts`
- Modify: `packages/evidence/contribution/src/store.ts`
- Modify: `packages/evidence/contribution/src/state.ts`
- Modify: `packages/evidence/contribution/src/commands.ts`
- Modify: `packages/evidence/contribution/src/commands.test.ts`
- Modify: `packages/evidence/contribution/src/index.ts`

**Interfaces:**
- Consumes: Task 2 preview fingerprint, Task 3 grant store, Task 4 policy identity.
- Produces: `AuthorizationAuthority`, exact authorization, grant creation/revocation, per-destination matching, and pre-effect revalidation.

- [ ] **Step 1: Write failing exact-authorization tests**

Cover:

- interactive and organization exact modes require a prepared manifest;
- interactive mode records that the host presented the exact fingerprint;
- organization mode never claims a human preview;
- source, policy, output, or destination change makes authorization stale;
- an exact decision may authorize a destination subset;
- unknown destination IDs are rejected;
- expiry blocks not-started Publication;
- retrying the same Publication identity reuses authorization; and
- authority proof bytes and credentials never enter state or receipt.

- [ ] **Step 2: Write failing standing-grant tests**

Cover:

- grant family, source/host scope, policy authority/profile, policy digest, implementation digest, destination configuration, resource bounds, and expiry;
- broad scope works only when explicitly represented;
- `review-required` and `withheld` never match;
- host-specific scope is checked by the authority port;
- revocation is append-only;
- revocation blocks not-started destinations;
- a grant version change invalidates an earlier match; and
- a request records the exact grant ID/version and match decision.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
cd packages/evidence/contribution
yarn test src/authorization.test.ts src/commands.test.ts
```

Expected: FAIL because authorization is not implemented.

- [ ] **Step 4: Define the authority port and submissions**

Export:

```ts
export interface AuthorizationAuthority {
  verifyExact(
    submission: ExactAuthorizationSubmission,
    manifest: PreparedDisclosureManifest,
    options?: ContributionOperationOptions,
  ): Promise<VerifiedExactAuthorization>;
  verifyStandingGrant(
    submission: StandingGrantSubmission,
    options?: ContributionOperationOptions,
  ): Promise<VerifiedStandingGrant>;
  verifyStandingGrantRevocation(
    submission: StandingGrantRevocationSubmission,
    grant: StandingAuthorizationGrantState,
    options?: ContributionOperationOptions,
  ): Promise<VerifiedStandingGrantRevocation>;
  evaluateHostScope(
    grant: StandingAuthorizationGrantState,
    context: Readonly<Record<string, string>>,
    options?: ContributionOperationOptions,
  ): Promise<{ readonly matches: boolean; readonly decisionDigest: Sha256Digest }>;
}
```

Core validation must not trust the port to enforce mandatory family, policy, implementation, destination, expiry, or revocation checks.

Define these durable submissions/results in `types.ts` before implementing the port:

```ts
export interface ExactAuthorizationSubmission {
  readonly mode: "interactive-exact" | "organization-exact";
  readonly authorityId: string;
  readonly actorId: string;
  readonly previewFingerprint: Sha256Digest;
  readonly allowedDestinationConfigurationDigests: readonly Sha256Digest[];
  readonly decidedAt: string;
  readonly expiresAt?: string;
  readonly proofDigest: Sha256Digest;
  readonly proofBytes: Uint8Array;
  readonly exactPreviewPresented: boolean;
}

export interface VerifiedExactAuthorization
  extends Omit<ExactAuthorizationSubmission, "proofBytes"> {
  readonly deniedDestinations: readonly {
    readonly configurationDigest: Sha256Digest;
    readonly reasonCode: ContributionSafeReasonCode;
  }[];
}

export type StandingGrantSourceScope =
  | {
      readonly kind: "exact-source";
      readonly source: EvidenceRecordReference;
    }
  | {
      readonly kind: "host-scope";
      readonly scopeDigest: Sha256Digest;
    };

export interface StandingGrantSubmission {
  readonly authorityId: string;
  readonly actorId: string;
  readonly sourceScope: StandingGrantSourceScope;
  readonly allowedFamilies: readonly EvidenceRecordReference["family"][];
  readonly policyAuthorityIds: readonly string[];
  readonly policyProfiles: readonly string[];
  readonly policyDigests: readonly Sha256Digest[];
  readonly implementationDigests: readonly Sha256Digest[];
  readonly derivationConfigurationDigests: readonly Sha256Digest[];
  readonly destinationConfigurationDigests: readonly Sha256Digest[];
  readonly limits: ContributionResourceLimits;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly proofDigest: Sha256Digest;
  readonly proofBytes: Uint8Array;
}

export interface VerifiedStandingGrant
  extends Omit<StandingGrantSubmission, "proofBytes"> {
}

export interface StandingGrantRevocationSubmission {
  readonly authorityId: string;
  readonly actorId: string;
  readonly grantId: ContributionGrantId;
  readonly expectedGrantVersion: number;
  readonly revokedAt: string;
  readonly reasonCode: ContributionSafeReasonCode;
  readonly proofDigest: Sha256Digest;
  readonly proofBytes: Uint8Array;
}

export interface VerifiedStandingGrantRevocation
  extends Omit<StandingGrantRevocationSubmission, "proofBytes"> {
}
```

`StandingAuthorizationGrantReadModel` exposes only grant/version/scope digests, allowed families and destination configurations, safe limits, expiry, revocation status, and safe timestamps.

`proofBytes` are transient authority input. Snapshot them for the authority call, verify `hashExactBytes(proofBytes) === proofDigest`, then discard them. Verified outputs deliberately omit the bytes; no state, event, receipt, read model, log, or returned error may retain them.

After verification, core assigns exact-decision, grant, and revocation decision IDs from `ContributionIdentifierSource`; a new grant starts at version 1 and each verified revocation advances it through CAS. The external authority cannot choose or roll back Contribution identities.

- [ ] **Step 5: Implement exact authorization**

Export:

```ts
export async function authorizeContribution(
  requestId: ContributionRequestId,
  submission: ExactAuthorizationSubmission,
  dependencies: ContributionAuthorizationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;
```

Verify the returned decision, snapshot it, compare its preview fingerprint, limit it to known destination configuration digests, append the decision, and update only those destinations.

- [ ] **Step 6: Implement standing-grant creation, matching, and revocation**

Export:

```ts
export async function createStandingAuthorizationGrant(
  submission: StandingGrantSubmission,
  dependencies: ContributionGrantDependencies,
  options?: ContributionOperationOptions,
): Promise<StandingAuthorizationGrantReadModel>;

export async function revokeStandingAuthorizationGrant(
  grantId: ContributionGrantId,
  submission: StandingGrantRevocationSubmission,
  dependencies: ContributionGrantDependencies,
  options?: ContributionOperationOptions,
): Promise<StandingAuthorizationGrantReadModel>;

export async function applyStandingAuthorization(
  requestId: ContributionRequestId,
  grantId: ContributionGrantId,
  dependencies: ContributionAuthorizationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;
```

Store a private match decision for each allowed destination. Re-evaluation immediately before Publication remains mandatory in Task 8.

Define:

```ts
export interface ContributionAuthorizationDependencies
  extends ContributionCommandBaseDependencies {
  readonly authorization: AuthorizationAuthority;
}

export interface ContributionGrantDependencies
  extends ContributionCommandBaseDependencies {
  readonly authorization: AuthorizationAuthority;
}
```

- [ ] **Step 7: Run focused and package tests**

Run:

```bash
cd packages/evidence/contribution
yarn typecheck
yarn test src/authorization.test.ts src/commands.test.ts
yarn test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/evidence/contribution/src
git commit -m "feat(evidence-contribution): bind exact authorization"
```

---

### Task 8: Per-destination Publication, recovery, and partial outcomes

**Files:**
- Create: `packages/evidence/contribution/src/publication.ts`
- Create: `packages/evidence/contribution/src/publication.test.ts`
- Modify: `packages/evidence/contribution/src/state.ts`
- Modify: `packages/evidence/contribution/src/commands.ts`
- Modify: `packages/evidence/contribution/src/commands.test.ts`
- Modify: `packages/evidence/contribution/src/index.ts`

**Interfaces:**
- Consumes: Task 2 expected Publication identities, Task 3 state/CAS claims, Task 7 current authorization, existing Publication `normalizePublishInput` and `publish`.
- Produces: `PublicationResolver`, `resumeContribution`, `retryContributionDestination`, durable partial outcomes, and exact Publication receipts.

- [ ] **Step 1: Write failing Publication tests**

Use `InMemoryEvidenceRepository`, `InMemoryAnnouncementSink`, and `InMemoryPublicationJournalStore`. Prove:

- no Publication call occurs without current authorization;
- standing authorization is rechecked before each destination's first operation checkpoint;
- staged record/artifact bytes are reloaded and digest-verified;
- normalized bundle key and payload fingerprint equal the manifest;
- artifacts, record, and announcement are owned by Publication, not Contribution;
- one destination receives one Publication operation;
- success at one destination does not mark another successful;
- retryable and terminal failures remain distinct;
- a failed first destination does not prevent a later authorized destination from running;
- a completed receipt is not published twice;
- a crash after Contribution's intent checkpoint resumes the same Publication bundle;
- two resumers cannot store conflicting destination outcomes; and
- Contribution holds no store lock during Publication I/O.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd packages/evidence/contribution
yarn test src/publication.test.ts src/commands.test.ts
```

Expected: FAIL because Publication orchestration does not exist.

- [ ] **Step 3: Define destination resolution**

Export:

```ts
export interface SafePublishedLocation {
  readonly profile: string;
  readonly value: string;
}

export interface ResolvedPublicationDestination {
  readonly descriptor: ContributionDestination;
  readonly dependencies: PublicationDependencies;
  readonly projectLocations?: (
    receipt: PublicationReceipt,
  ) => readonly SafePublishedLocation[];
  readonly withdrawal?: AvailabilityWithdrawal;
}

export interface PublicationResolver {
  resolve(
    destination: ContributionDestination,
    options?: ContributionOperationOptions,
  ): Promise<ResolvedPublicationDestination>;
}
```

`SafePublishedLocation` is an optional private receipt projection envelope. Its `profile` identifies binding-owned semantics; Contribution never interprets `value`. Validate both as bounded inert strings and scan them in the contract kit for authority-marker leakage.

Define:

```ts
export interface ContributionPublicationDependencies
  extends ContributionCommandBaseDependencies {
  readonly repositories: RepositoryResolver;
  readonly publications: PublicationResolver;
  readonly authorization: AuthorizationAuthority;
}
```

- [ ] **Step 4: Implement exact Publication input loading**

Export:

```ts
export async function loadAuthorizedPublishInput(
  state: ContributionRequestState,
  destination: ContributionDestination,
  repositories: RepositoryResolver,
  options?: ContributionOperationOptions,
): Promise<PublishInput>;
```

Load only the prepared record and manifest-listed artifacts from the staging Repository. Normalize through Publication, then compare `bundleKey` and `payloadFingerprint` with the manifest before returning input.

- [ ] **Step 5: Implement one destination operation**

Export:

```ts
export async function publishContributionDestination(
  requestId: ContributionRequestId,
  destination: string,
  dependencies: ContributionPublicationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;
```

The function:

1. claims the destination by CAS;
2. rechecks exact or standing authorization;
3. resolves and verifies the destination descriptor/configuration digest;
4. loads exact Publication input;
5. checkpoints `publishing` with bundle/payload identities;
6. releases the state update;
7. calls `publish`;
8. validates the completed receipt against expected identities;
9. safely projects optional locations; and
10. CASes `published` or a classified failure.

Upstream `EvidencePublicationError`, `EvidenceRepositoryError`, cancellation, and unknown failures map to stable safe Contribution codes without copying messages that may contain private data.

The `publishing` checkpoint and final destination outcome retain Publication's journal key (`bundleKey`) and exact completed receipt. They never copy Publication's internal artifact, record, announcement, or pending-placement checkpoints.

- [ ] **Step 6: Implement resume and retry commands**

Export:

```ts
export async function resumeContribution(
  requestId: ContributionRequestId,
  dependencies: ContributionPublicationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;

export async function retryContributionDestination(
  requestId: ContributionRequestId,
  destination: string,
  dependencies: ContributionPublicationDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;
```

Process eligible destinations in deterministic destination-IRI order. Continue after a classified destination failure. A retry accepts only `retryable-failure` or an interrupted `publishing` state and must use the same bundle/payload identities.

- [ ] **Step 7: Run focused and package tests**

Run:

```bash
cd packages/evidence/contribution
yarn typecheck
yarn test src/publication.test.ts src/commands.test.ts
yarn test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/evidence/contribution/src
git commit -m "feat(evidence-contribution): publish recoverable destinations"
```

---

### Task 9: Decline, deactivation, receipts, and safe read models

**Files:**
- Create: `packages/evidence/contribution/src/deactivation.ts`
- Create: `packages/evidence/contribution/src/deactivation.test.ts`
- Create: `packages/evidence/contribution/src/receipt.ts`
- Create: `packages/evidence/contribution/src/receipt.test.ts`
- Create: `packages/evidence/contribution/src/read-model.ts`
- Create: `packages/evidence/contribution/src/read-model.test.ts`
- Modify: `packages/evidence/contribution/src/commands.ts`
- Modify: `packages/evidence/contribution/src/commands.test.ts`
- Modify: `packages/evidence/contribution/src/index.ts`

**Interfaces:**
- Consumes: Task 3 state, Task 7 authorization decisions, Task 8 Publication receipts and optional withdrawal port.
- Produces: `declineContribution`, `deactivateContribution`, `deactivateContributionDestination`, final/current receipts, and safe product projections.

- [ ] **Step 1: Write failing decline and deactivation tests**

Prove:

- decline before preparation causes no Derivation, remote Repository, Publication, or announcement effect;
- decline after preview but before the first Publication effect leaves staged bytes private;
- all destinations explicitly denied before an external effect may close as `declined`;
- decline after Publication starts is rejected in favor of deactivation;
- deactivation checkpoints before a not-started destination can publish;
- already-started Publication reconciles to a stable receipt before withdrawal;
- supported withdrawal records `deactivated`;
- unsupported withdrawal records `unsupported` without claiming deletion;
- another source's availability is never retracted;
- local staging deletion is never attempted; and
- past immutable effects remain visible in the read model.

- [ ] **Step 2: Write failing receipt and leak tests**

Assert exact receipt fields for:

- declined before preview;
- withheld;
- review-required;
- one destination published;
- two destinations with one terminal failure;
- later successful retry;
- supported and unsupported deactivation.

Recursively scan state, read models, errors, and receipts for synthetic printable, hexadecimal, base64, base64url, and percent-encoded authority markers. Assert absence of Evidence bytes, credentials, private findings, local paths, and opaque sink state.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
cd packages/evidence/contribution
yarn test src/deactivation.test.ts src/receipt.test.ts src/read-model.test.ts src/commands.test.ts
```

Expected: FAIL because closeout behavior does not exist.

- [ ] **Step 4: Define optional withdrawal semantics**

Export:

```ts
export type AvailabilityWithdrawalResult =
  | {
      readonly status: "withdrawn";
      readonly externalId: string;
    }
  | {
      readonly status: "unsupported";
      readonly reasonCode: ContributionSafeReasonCode;
    }
  | {
      readonly status: "retryable-failure";
      readonly reasonCode: ContributionSafeReasonCode;
    };

export interface AvailabilityWithdrawal {
  deactivate(
    input: {
      readonly destination: ContributionDestination;
      readonly publicationReceipt: PublicationReceipt;
    },
    options?: ContributionOperationOptions,
  ): Promise<AvailabilityWithdrawalResult>;
}
```

This port may retract only the current destination binding's availability observation. It has no Repository delete method.

Define:

```ts
export interface ContributionCloseoutDependencies
  extends ContributionPublicationDependencies {}
```

Closeout uses the same resolved binding and already-checkpointed Publication identity for in-flight reconciliation. It never accepts an independent withdrawal resolver that could target a different destination.

- [ ] **Step 5: Implement decline and deactivation commands**

Export:

```ts
export async function declineContribution(
  requestId: ContributionRequestId,
  input: {
    readonly actorId: string;
    readonly reasonCode: ContributionSafeReasonCode;
  },
  dependencies: ContributionCloseoutDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;

export async function deactivateContributionDestination(
  requestId: ContributionRequestId,
  destination: string,
  dependencies: ContributionCloseoutDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;

export async function deactivateContribution(
  requestId: ContributionRequestId,
  dependencies: ContributionCloseoutDependencies,
  options?: ContributionOperationOptions,
): Promise<ContributionReadModel>;
```

For `publishing`, finish recovery through the same already-authorized Publication operation, then invoke withdrawal. Never construct a replacement Publication input.

- [ ] **Step 6: Implement receipts and read models**

Export:

```ts
export function createContributionReceipt(
  state: ContributionRequestState,
): ContributionReceipt;

export function createContributionReadModel(
  state: ContributionRequestState,
): ContributionReadModel;

export async function readContributionReceipt(
  requestId: ContributionRequestId,
  dependencies: Pick<ContributionCommandBaseDependencies, "store">,
  options?: ContributionOperationOptions,
): Promise<ContributionReceipt>;
```

The receipt includes source, prepared record/artifacts when present, policy decision, Derivation identity/receipt when present, authorization mode/identity when present, per-destination bundle/payload/placements/locations/outcomes, deactivation result, aggregate status, and `stagingRetention: "required-for-recovery" | "eligible-for-host-cleanup"`. It contains explicit boolean/enum facts that publication does not imply trust, admission, reward, corpus membership, search visibility, or deletion. Contribution reports retention eligibility only; it never deletes Repository content.

After any transition that changes an authorization, Publication, decline, review, withholding, or deactivation outcome, deterministically construct the current receipt, hash it with `createContributionReceiptFingerprint`, and append `{ receipt, receiptFingerprint }` in the same CAS update. Identical retries do not append duplicates. `readContributionReceipt` returns the latest durable revision and fails closed if recomputation disagrees with its fingerprint.

- [ ] **Step 7: Run focused and package tests**

Run:

```bash
cd packages/evidence/contribution
yarn typecheck
yarn test src/deactivation.test.ts src/receipt.test.ts src/read-model.test.ts src/commands.test.ts
yarn test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/evidence/contribution/src
git commit -m "feat(evidence-contribution): expose honest durable outcomes"
```

---

### Task 10: Portable host-integration contract kit and required scenario matrix

**Files:**
- Create: `packages/evidence/contribution/src/testing.ts`
- Create: `packages/evidence/contribution/src/testing.test.ts`
- Modify: `packages/evidence/contribution/src/testing-fixtures.ts`
- Modify: `packages/evidence/contribution/package.json`
- Modify: `packages/evidence/contribution/src/index.ts`

**Interfaces:**
- Consumes: all root commands and public types from Tasks 1–9.
- Produces: `describeEvidenceContributionContract`, driver/context types, deterministic in-memory ports, and the `/testing` entrypoint.

- [ ] **Step 1: Define the contract-driver interface**

Use:

```ts
export type EvidenceContributionContractScenario =
  | "private-execution-unchanged"
  | "private-execution-derived"
  | "review-required"
  | "review-exception-linked-request"
  | "withheld"
  | "declined-before-preparation"
  | "interactive-exact"
  | "organization-exact"
  | "standing-grant-revocation"
  | "prepared-reuse-new-location"
  | "independent-result-evaluation"
  | "independent-execution-verification"
  | "interrupted-announcement"
  | "mixed-destination-retry"
  | "cancellation-boundaries"
  | "deactivation-capabilities"
  | "duplicate-idempotency"
  | "stale-authorization"
  | "access-failure"
  | "opaque-host-context";

export interface EvidenceContributionContractObservation {
  readonly sourceRepository: EvidenceRepository;
  readonly stagingRepository: EvidenceRepository;
  readonly publicationEffectCount: (destination: string) => number;
  readonly withdrawalEffectCount: (destination: string) => number;
  readonly stateSnapshot: () => Promise<unknown>;
  readonly cleanup?: () => Promise<void> | void;
}

export interface EvidenceContributionContractDriver {
  readonly commands: {
    create: typeof createContributionRequest;
    prepare: typeof prepareContribution;
    authorize: typeof authorizeContribution;
    createGrant: typeof createStandingAuthorizationGrant;
    revokeGrant: typeof revokeStandingAuthorizationGrant;
    applyGrant: typeof applyStandingAuthorization;
    resume: typeof resumeContribution;
    retryDestination: typeof retryContributionDestination;
    decline: typeof declineContribution;
    deactivate: typeof deactivateContribution;
    deactivateDestination: typeof deactivateContributionDestination;
    inspect: typeof inspectContribution;
    readReceipt: typeof readContributionReceipt;
  };
  createObservation(
    scenario: EvidenceContributionContractScenario,
  ): Promise<EvidenceContributionContractObservation>;
}

export type EvidenceContributionContractDriverFactory = () =>
  | EvidenceContributionContractDriver
  | Promise<EvidenceContributionContractDriver>;

export function describeEvidenceContributionContract(
  factory: EvidenceContributionContractDriverFactory,
): void;
```

- [ ] **Step 2: Write the contract suite before the in-memory driver passes**

The suite must run:

1. private Execution Evidence returned unchanged;
2. private Execution Evidence derived with provenance and binding impact;
3. `review-required`;
4. a linked request after human policy exception;
5. withheld Evidence;
6. contribution declined before preparation;
7. interactive exact authorization;
8. organization exact authorization without a human-preview claim;
9. scoped standing authorization and revocation;
10. already-public prepared Evidence to a new location;
11. later independent Result Evaluation;
12. independent Execution Verification;
13. interruption before announcement and exact recovery;
14. two destinations with mixed success and retry;
15. cancellation before and after Publication starts;
16. supported and unsupported deactivation;
17. duplicate request idempotency;
18. stale authorization after source/policy/destination change;
19. missing credentials and denied access;
20. plugin, marketplace, and third-party host contexts remaining opaque.

Include a negative fixture proving Task, Result, Runtime, and trace entities cannot be primary record families.

Add a table-driven fault-injection matrix around every Contribution-owned durable boundary: source validation, verified-route persistence, sealed-intent persistence, Derivation completion, each staging receipt, manifest persistence, authorization/grant persistence, destination intent checkpoint, completed Publication receipt persistence, deactivation request, and withdrawal result. Re-run after each injected interruption and prove one stable intent, preview, decision/grant version, Publication bundle, announcement identity, and receipt. Exercise two concurrent resumers. Publication's own artifact/record/announcement checkpoint faults remain covered by its upstream contract suite and are invoked through the same journal in the Contribution driver.

Exercise limits before effects: destination count at create, artifact count and individual/total bytes during preparation, manifest bytes before persistence, and bounded deterministic destination concurrency during resume.

- [ ] **Step 3: Add authority-marker and ambient-effect probes**

Each driver closes over at least one printable and one non-UTF-8 synthetic authority marker. The contract kit derives raw, hex, base64, unpadded base64url, and percent-encoded forms, then recursively scans:

- request and grant state;
- manifests and read models;
- receipts;
- safe errors and bounded cause chains;
- projected locations; and
- public return objects.

The suite also asserts no Publication/withdrawal effects occur during create, prepare, preview, decline, or denied authorization.

- [ ] **Step 4: Run the suite and verify failure**

Run:

```bash
cd packages/evidence/contribution
yarn test src/testing.test.ts
```

Expected: FAIL until the in-memory driver satisfies every scenario.

- [ ] **Step 5: Complete deterministic in-memory fixtures**

Use:

- `InMemoryContributionStore`;
- `InMemoryEvidenceRepository`;
- the real synthetic Derivation fixture and deriver;
- `InMemoryAnnouncementSink`;
- `InMemoryPublicationJournalStore`;
- deterministic clock/identifier sources;
- strict policy and authorization authorities;
- protected review references that never echo findings; and
- supported/unsupported withdrawal doubles.

Run `describeEvidenceContributionContract(() => driver)` against the assembled driver.

- [ ] **Step 6: Protect the testing entrypoint boundary**

Root `index.ts` must not export `testing.ts` or `testing-fixtures.ts`. `package.json` exports `/testing` from `dist/testing.js`. Add a root-export test proving in-memory constructors and Vitest symbols are absent from the root package.

- [ ] **Step 7: Run focused and package tests**

Run:

```bash
cd packages/evidence/contribution
yarn typecheck
yarn test src/testing.test.ts
yarn test
```

Expected: PASS with every scenario executed.

- [ ] **Step 8: Commit**

```bash
git add packages/evidence/contribution
git commit -m "test(evidence-contribution): publish integration contract kit"
```

---

### Task 11: Distribution, CI DAG, README, and final verification

**Files:**
- Create: `packages/evidence/contribution/README.md`
- Create: `packages/evidence/contribution/scripts/pack-smoke.mjs`
- Modify: `.github/scripts/evidence-packed-types.test.mjs`
- Modify: `.github/scripts/evidence-package-inventory.test.mjs`
- Modify: `.github/scripts/evidence-source-boundaries.test.mjs`
- Modify: `.github/workflows/evidence-ci.yml`
- Modify: `packages/evidence/contribution/package.json`
- Modify: `packages/evidence/contribution/yarn.lock`

**Interfaces:**
- Consumes: complete package and `/testing` entrypoint from Tasks 1–10.
- Produces: packed-consumer guarantees, Evidence CI integration, and public package documentation.

- [ ] **Step 1: Write failing packed-consumer and CI assertions**

Update the packed-type script to require:

```text
@jinn-network/evidence-contribution
@jinn-network/evidence-contribution/testing
```

Add workflow assertions or direct YAML edits proving:

- a `contribution` job depends on `foundation`, `derivation`, and `publication`;
- it restores Protocol, Repository, Derivation, and Publication distributions;
- it runs immutable install, typecheck, test, build, and pack smoke;
- it uploads `evidence-contribution-dist`; and
- the final `verify` job requires Contribution.

Run:

```bash
node .github/scripts/evidence-packed-types.test.mjs
```

Expected: FAIL because the package is not built and the packed consumer does not include it.

- [ ] **Step 2: Implement `pack-smoke.mjs`**

Follow neighboring package scripts. The smoke test must:

1. pack Protocol, Repository, Derivation, Publication, and Contribution;
2. inspect the Contribution archive for `README.md`, root JS/types, testing JS/types, and `package.json`;
3. reject source, tests, maps, fixtures, private findings, and local paths in the archive;
4. install a root consumer without Vitest and execute imports for public commands;
5. assert no filesystem constructor, concrete store, service, plugin, marketplace, wallet, or chain symbol exists at root;
6. install a testing consumer with Vitest;
7. compile imports for `describeEvidenceContributionContract` and its driver types; and
8. delete its temporary directory in `finally`.

- [ ] **Step 3: Write the public README**

Document:

- the one-record request boundary and three record families;
- the distinction between preparation, authorization, Publication, and admission;
- minimal interactive exact and standing-grant examples;
- resume-on-invocation;
- per-destination mixed outcomes;
- signed records unchanged or withheld;
- deactivation versus deletion;
- injected ports and credential isolation;
- `/testing` contract usage; and
- explicit non-goals.

Use `Attempt` as the Jinn user-facing noun. Do not describe a standalone Task submission as Evidence Contribution.

- [ ] **Step 4: Add Contribution to Evidence CI and packed architecture checks**

Update the package inventory count/graph, packed package list, code entrypoints, source-boundary allowlist, artifact placement loop, and final verification dependency. Do not weaken an existing guard to make Contribution pass.

- [ ] **Step 5: Run package verification**

Run:

```bash
cd packages/evidence/contribution
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

Expected: PASS.

- [ ] **Step 6: Run repository architecture verification**

Run:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
node .github/scripts/evidence-packed-types.test.mjs
```

Expected: PASS, with the packed-types script reporting both Contribution entrypoints.

- [ ] **Step 7: Re-run every direct dependency gate**

Run:

```bash
(cd packages/evidence/protocol && yarn typecheck && yarn test && yarn build)
(cd packages/evidence/repository && yarn typecheck && yarn test && yarn build)
(cd packages/evidence/derivation && yarn typecheck && yarn test && yarn build)
(cd packages/evidence/publication && yarn typecheck && yarn test && yarn build)
(cd packages/evidence/contribution && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 8: Audit scope and public boundary**

Run:

```bash
git status --short
git diff --stat
rg -n "jinn-plugin|Autopilot|marketplace|wallet|blockchain|IPFS|OCI|node:fs|node:https|fetch\\(" packages/evidence/contribution/src
rg -n "T[B]D|T[O]DO|FIX[M]E|placeholde[r]" packages/evidence/contribution packages/evidence/contribution/README.md
```

Expected:

- only Contribution package, Evidence architecture guards, packed-type checks, and Evidence CI files are changed;
- product/binding searches return no production dependency imports;
- the red-flag scan returns no matches; and
- no migration or concrete adapter code exists.

- [ ] **Step 9: Commit**

```bash
git add packages/evidence/contribution .github/scripts/evidence-package-inventory.test.mjs .github/scripts/evidence-source-boundaries.test.mjs .github/scripts/evidence-packed-types.test.mjs .github/workflows/evidence-ci.yml
git commit -m "feat(evidence-contribution): distribute durable workflow"
```

## Completion Gate

Implementation is complete only when:

- all eleven task commits are present and independently reviewable;
- the package and repository verification commands in Task 11 pass from a clean isolated worktree;
- every required contract scenario passes;
- exact preview, authorization, and Publication identities remain equal through retry and recovery;
- raw private bytes and authority markers are absent from operational records and public outputs;
- no plugin migration, service, concrete store, concrete withdrawal binding, or product-specific adapter was added; and
- the implementation remains a consumer of Derivation and Publication rather than reproducing them.
