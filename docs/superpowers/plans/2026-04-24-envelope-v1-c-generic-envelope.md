# Envelope V1 — Plan C: Generic `jinn.execution.v1` Envelope + One-Shot Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every per-kind manifest schema (`portfolio.v0.manifest.v1`, `portfolio.v0.eval.manifest.v1`, `prediction.v0.submission.v1`, `prediction.v0.verdict.v1`, `prediction.apy.v0.submission.v1`, `prediction.apy.v0.verdict.v1`) with a single generic `jinn.execution.v1` envelope carrying a role discriminator (`restoration` | `verdict`) and kind-typed `payload`. Rename `role` → `artifactType` on artifact entries. Refactor `manifest-assembly.ts` → `envelope-assembly.ts` producing the new shape. Update every restorer/evaluator impl to emit envelopes. Update the delivery watcher to consume them. One-shot cutover — no back-compat shims per scope §3.4.

**Architecture:** New generic schema at `client/src/types/envelope.ts`. Per-kind payloads move to `client/src/types/payloads/<kind>.ts` (e.g. `payloads/portfolio.ts` exporting `PortfolioV0RestorationPayload` and `PortfolioV0VerdictPayload`). The envelope's `role: 'restoration' | 'verdict'` + `kind: string` selects which payload type applies. `envelope.executor` carries `{implName, implVersion, clientGitSha, codeDigest, signingKey, source?}`. Verdict envelopes reference the restoration via `payload.restorationEnvelope: { cid, sha256 }` and attach `payload.verificationOfRestoration` per scope §3.3. `evidenceHash` posted to `JinnRouter.claimDelivery` = `keccak256(JCS(envelope minus signature))` per scope §4.2a.

**Tech Stack:** TypeScript, Vitest, Zod, viem, existing canonicalJson (JCS — Plan A required), existing signCanonical.

**Non-goals for this slice:**
- No TEE attestation field population (V2 — `attestation` stays nullable in V1 envelopes).
- No trajectory CID population (Plan D — `trajectory` stays nullable in V1 envelopes until Plan D lights it up).
- No 8004 envelope registration (Plan E).
- No conformance suite (Plan F).
- No subgraph schema (Plan G).

**Before you start:** Plans A (JCS) and B (intent.v1) must be merged. Plan C uses `canonicalJson` as the envelope signing input and relies on `RestorationJob.intent: SignedIntentV1` landing in Plan B.

**Reference:** `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` §3.1 (envelope shape D5 + K9 artifactType), §3.2 (executor provenance K3), §3.3 (evaluator verification row), §3.4 (one-shot migration), §4.1 (schema deliverable), §4.2a (evidenceHash mechanics).

---

## File structure

New files:
- `client/src/types/envelope.ts` — `JinnExecutionEnvelopeSchema`, `UnsignedEnvelope`, `SignedEnvelope`, `EvidenceTier`, executor/attestation/trajectory sub-schemas.
- `client/src/types/payloads/portfolio-v0.ts` — `PortfolioV0RestorationPayloadSchema`, `PortfolioV0VerdictPayloadSchema`.
- `client/src/types/payloads/prediction-v0.ts` — equivalent for `prediction.v0`.
- `client/src/types/payloads/prediction-apy-v0.ts` — equivalent for `prediction.apy.v0`.
- `client/src/types/payloads/index.ts` — re-exports + `KIND_PAYLOADS` registry mapping `(kind, role)` → payload schema.
- `client/src/restorer/engine/envelope-assembly.ts` — replaces `manifest-assembly.ts`. Exports `assembleAndSignEnvelope(params) → AssembledEnvelope`.
- `client/test/types/envelope.test.ts`
- `client/test/restorer/engine/envelope-assembly.test.ts`

Deleted files:
- `client/src/restorer/engine/manifest-assembly.ts` (content moves to envelope-assembly.ts)
- `client/test/restorer/engine/manifest-assembly.test.ts` (content moves to envelope-assembly.test.ts)

Modified files:
- `client/src/types/portfolio.ts` — strip manifest/verdict schemas, keep only `PortfolioV0Spec`, `PortfolioV0Eligibility`, `PortfolioV0Intent` (intent-spec bits). Re-export payload types from `payloads/portfolio-v0.ts`.
- `client/src/types/prediction.ts`, `prediction-apy.ts` — same pattern.
- `client/src/restorer/engine/packaging.ts` — rename `role` → `artifactType` throughout; field `artifactType` instead of `role` on `Artifact`, `OutputArtifact`, `UploadedArtifact`, `OutputsJsonSchema`.
- `client/src/restorer/impls/claude-mcp-hyperliquid/index.ts` — produce envelope via new assembly helper.
- `client/src/restorer/impls/portfolio-v0-evaluator/index.ts` — produce verdict envelope.
- `client/src/restorer/impls/claude-mcp-prediction/index.ts`, `prediction-v0-baseline/index.ts`, `prediction-v0-evaluator/index.ts` — same.
- `client/src/restorer/impls/claude-mcp-prediction-apy/index.ts`, `prediction-apy-v0-baseline/index.ts`, `prediction-apy-v0-evaluator/index.ts` — same.
- `client/src/daemon/delivery-watcher.ts` — parse received envelopes (not per-kind manifests).
- `client/src/restorer/engine/engine.ts`, `state.ts`, `persistence.ts`, `delivery.ts` — update internal references from manifest → envelope.
- Test fixtures under `client/test/` and `client/fixtures/` — regenerate against new schema.

---

## Task 1: Define generic envelope schema + executor sub-schema

**Files:**
- Create: `client/src/types/envelope.ts`
- Create: `client/test/types/envelope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/types/envelope.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  UnsignedEnvelopeSchema,
  SignedEnvelopeSchema,
  EvidenceTierSchema,
  type UnsignedEnvelope,
} from '../../src/types/envelope.js';

describe('EvidenceTierSchema', () => {
  it('accepts the five standard tiers', () => {
    for (const t of ['self-signed', 'committed', 'consensus', 'attested', 'proved']) {
      expect(() => EvidenceTierSchema.parse(t)).not.toThrow();
    }
  });
  it('rejects unknown tier', () => {
    expect(() => EvidenceTierSchema.parse('bronze')).toThrow();
  });
});

describe('UnsignedEnvelopeSchema', () => {
  const baseEnv: UnsignedEnvelope = {
    schemaVersion: 'jinn.execution.v1',
    kind: 'portfolio.v0',
    role: 'restoration',
    generatedAt: 1700000000000,
    intent: {
      cid: 'bafy...',
      onchainCreationTx: '0x' + 'ab'.repeat(32),
      onchainCreationBlock: 100,
      requestId: '0x' + 'cd'.repeat(32),
    },
    participant: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    window: { startTs: 1, endTs: 86400001 },
    executor: {
      implName: 'claude-mcp-hyperliquid',
      implVersion: '1.0.0',
      clientGitSha: 'abcdef1',
      codeDigest: 'sha256:' + 'ab'.repeat(32),
      signingKey: {
        kind: 'agent-eoa',
        pubkey: '0x2222222222222222222222222222222222222222',
      },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: { preSnapshot: {} as any, postSnapshot: {} as any, fills: [], gating: {} },
  };

  it('accepts a well-formed restoration envelope', () => {
    expect(() => UnsignedEnvelopeSchema.parse(baseEnv)).not.toThrow();
  });

  it('rejects wrong schemaVersion', () => {
    expect(() => UnsignedEnvelopeSchema.parse({ ...baseEnv, schemaVersion: 'jinn.execution.v2' })).toThrow();
  });

  it('rejects invalid role', () => {
    expect(() => UnsignedEnvelopeSchema.parse({ ...baseEnv, role: 'witness' })).toThrow();
  });

  it('requires executor.source when evidenceTier is attested', () => {
    const env = { ...baseEnv, evidenceTier: 'attested' as const };
    expect(() => UnsignedEnvelopeSchema.parse(env)).toThrow();
  });

  it('requires attestation when evidenceTier is attested', () => {
    const env = {
      ...baseEnv,
      evidenceTier: 'attested' as const,
      executor: {
        ...baseEnv.executor,
        signingKey: { kind: 'enclave-bound' as const, pubkey: baseEnv.executor.signingKey.pubkey },
        source: {
          bundleCid: 'bafy-src',
          sha256: 'ab'.repeat(32),
          buildRecipe: { kind: 'dockerfile' as const, path: 'Dockerfile' },
          measurement: '0x' + 'cc'.repeat(48),
        },
      },
      attestation: null,
    };
    expect(() => UnsignedEnvelopeSchema.parse(env)).toThrow();
  });

  it('artifact uses artifactType field (not role)', () => {
    const env = {
      ...baseEnv,
      artifacts: [
        {
          cid: 'bafy-art',
          artifactType: 'system_snapshot',
          sha256: 'cd'.repeat(32),
        },
      ],
    };
    expect(() => UnsignedEnvelopeSchema.parse(env)).not.toThrow();

    const envWithRole = {
      ...baseEnv,
      artifacts: [{ cid: 'bafy-art', role: 'system_snapshot' }],
    };
    expect(() => UnsignedEnvelopeSchema.parse(envWithRole)).toThrow();
  });
});

describe('SignedEnvelopeSchema', () => {
  const baseSigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    kind: 'portfolio.v0',
    role: 'restoration' as const,
    generatedAt: 1700000000000,
    intent: {
      cid: 'bafy',
      onchainCreationTx: '0x' + 'ab'.repeat(32),
      onchainCreationBlock: 1,
      requestId: '0x' + 'cd'.repeat(32),
    },
    participant: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    window: { startTs: 1, endTs: 86400001 },
    executor: {
      implName: 'x',
      implVersion: '1',
      clientGitSha: 'a',
      codeDigest: 'sha256:' + 'ab'.repeat(32),
      signingKey: { kind: 'agent-eoa' as const, pubkey: '0x22' },
    },
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: { preSnapshot: {}, postSnapshot: {}, fills: [], gating: {} },
    signature: {
      algo: 'secp256k1' as const,
      signer: '0x2222222222222222222222222222222222222222',
      hash: '0x' + 'ef'.repeat(32),
      sig: '0x' + '12'.repeat(65),
    },
  };

  it('accepts a signed envelope', () => {
    expect(() => SignedEnvelopeSchema.parse(baseSigned)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd client
yarn vitest run test/types/envelope.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Write `client/src/types/envelope.ts`**

```typescript
/**
 * jinn.execution.v1 — generic signed envelope.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.1 (D5 + K1 knowledge tree), §3.2 (K3 executor provenance), §3.4 migration.
 *
 * One envelope shape covers restoration manifests (role='restoration') and
 * verdict manifests (role='verdict'). Payload is typed per (kind, role) via
 * the registry in `./payloads/`.
 */

import { z } from 'zod';
import { WindowSchema } from './desired-state.js';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const EvidenceTierSchema = z.enum([
  'self-signed',
  'committed',
  'consensus',
  'attested',
  'proved',
]);
export type EvidenceTier = z.infer<typeof EvidenceTierSchema>;

export const RoleSchema = z.enum(['restoration', 'verdict']);
export type Role = z.infer<typeof RoleSchema>;

const IntentProvenanceSchema = z.object({
  cid: z.string().min(1),
  onchainCreationTx: HexStringSchema,
  onchainCreationBlock: z.number().int(),
  requestId: HexStringSchema,
});

const ParticipantSchema = z.object({
  safeAddress: HexStringSchema,
  agentEoa: HexStringSchema,
});

const SigningKeySchema = z.object({
  kind: z.enum(['agent-eoa', 'enclave-bound']),
  pubkey: HexStringSchema,
});

const SourceBundleSchema = z.object({
  bundleCid: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  humanUrl: z.string().optional(),
  buildRecipe: z.object({
    kind: z.enum(['dockerfile', 'nix', 'bazel']),
    path: z.string(),
  }),
  measurement: HexStringSchema,
});

const ExecutorSchema = z.object({
  implName: z.string().min(1),
  implVersion: z.string().min(1),
  clientGitSha: z.string().min(1),
  codeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  signingKey: SigningKeySchema,
  source: SourceBundleSchema.optional(),
});

const AttestationSchema = z.object({
  profile: z.string().min(1),
  quote: z.string(),               // base64 or hex — design spec pins
  reportData: HexStringSchema,     // 64 bytes: envelopeHash || execPubkey
  measurement: HexStringSchema,
});

const TrajectoryRefSchema = z.object({
  cid: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  access: z
    .object({
      kind: z.enum(['open', 'x402-gated']),
      endpoint: z.string().optional(),
      priceUsdc: z.string().optional(),
    })
    .optional(),
});

const ArtifactSchema = z.object({
  cid: z.string().min(1),
  artifactType: z.string().min(1),
  sha256: z.string().optional(),
  metadata: z
    .object({
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      producedBy: z
        .object({
          spanId: z.string(),
          trajectoryCid: z.string(),
        })
        .optional(),
    })
    .optional(),
  access: z
    .object({
      kind: z.enum(['open', 'x402-gated']),
      endpoint: z.string().optional(),
      priceUsdc: z.string().optional(),
    })
    .optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

const SignatureSchema = z.object({
  algo: z.literal('secp256k1'),
  signer: HexStringSchema,
  hash: HexStringSchema,
  sig: HexStringSchema,
});

const BaseEnvelopeFields = {
  schemaVersion: z.literal('jinn.execution.v1'),
  kind: z.string().min(1),
  role: RoleSchema,
  generatedAt: z.number().int(),
  intent: IntentProvenanceSchema,
  participant: ParticipantSchema,
  window: WindowSchema,
  executor: ExecutorSchema,
  evidenceTier: EvidenceTierSchema,
  attestation: AttestationSchema.nullable(),
  trajectory: TrajectoryRefSchema.nullable(),
  artifacts: z.array(ArtifactSchema),
  // Payload is intentionally loose at envelope-level; per-kind payloads
  // are validated separately via the KIND_PAYLOADS registry in
  // ./payloads/index.ts before downstream consumers operate on them.
  payload: z.record(z.unknown()),
};

export const UnsignedEnvelopeSchema = z
  .object(BaseEnvelopeFields)
  .refine(
    (e) => e.evidenceTier !== 'attested' || e.executor.source !== undefined,
    { message: 'attested tier requires executor.source', path: ['executor', 'source'] },
  )
  .refine(
    (e) => e.evidenceTier !== 'attested' || e.attestation !== null,
    { message: 'attested tier requires attestation', path: ['attestation'] },
  );

export type UnsignedEnvelope = z.infer<typeof UnsignedEnvelopeSchema>;

export const SignedEnvelopeSchema = z
  .object({ ...BaseEnvelopeFields, signature: SignatureSchema })
  .refine(
    (e) => e.evidenceTier !== 'attested' || e.executor.source !== undefined,
    { message: 'attested tier requires executor.source', path: ['executor', 'source'] },
  )
  .refine(
    (e) => e.evidenceTier !== 'attested' || e.attestation !== null,
    { message: 'attested tier requires attestation', path: ['attestation'] },
  );

export type SignedEnvelope = z.infer<typeof SignedEnvelopeSchema>;
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd client
yarn vitest run test/types/envelope.test.ts
```

Expected: all pass.

- [ ] **Step 5: Typecheck**

```bash
cd client
yarn typecheck
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/types/envelope.ts client/test/types/envelope.test.ts
git commit -m "feat(client): add jinn.execution.v1 envelope schema

Generic signed envelope with role discriminator (restoration|verdict),
executor provenance block, tier-gated attestation + source, and
artifactType (renamed from role) on artifact entries. Scope v0.9 §3.1
D5 + K9, §3.2 K3, §4.1, §4.2a."
```

---

## Task 2: Per-kind payloads — `portfolio.v0`

**Files:**
- Create: `client/src/types/payloads/portfolio-v0.ts`
- Create: `client/test/types/payloads/portfolio-v0.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/types/payloads/portfolio-v0.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  PortfolioV0RestorationPayloadSchema,
  PortfolioV0VerdictPayloadSchema,
} from '../../../src/types/payloads/portfolio-v0.js';

describe('PortfolioV0RestorationPayloadSchema', () => {
  const valid = {
    preSnapshot: { capturedAt: 1, hlTime: 1, payload: {} },
    postSnapshot: { capturedAt: 2, hlTime: 2, payload: {} },
    fills: [],
    gating: {
      equityReturnPct: '0.05',
      maxDrawdownPct: '0.01',
      closedTradesCount: 25,
      tradedNotionalMultiple: '5.1',
    },
  };
  it('accepts a restoration payload', () => {
    expect(() => PortfolioV0RestorationPayloadSchema.parse(valid)).not.toThrow();
  });
  it('rejects invalid gating', () => {
    expect(() =>
      PortfolioV0RestorationPayloadSchema.parse({ ...valid, gating: { bogus: 1 } }),
    ).toThrow();
  });
});

describe('PortfolioV0VerdictPayloadSchema', () => {
  const valid = {
    restorationEnvelope: {
      cid: 'bafy-rest',
      sha256: '0'.repeat(64),
    },
    verificationOfRestoration: {
      claimedTier: 'self-signed',
      sdkVersion: '1.0.0',
      timestamp: 1700000000000,
      checks: [{ name: 'signature', passed: true }],
      overall: 'valid',
    },
    verdict: 'PASS',
    score: '0.95',
    scoreBasis: 'equityReturnPct',
    scoreVersion: '1',
    rederived: {
      preSnapshot: { capturedAt: 1, payload: {} },
      postSnapshot: { capturedAt: 2, payload: {} },
      fills: [],
      gating: {},
    },
    claimed: {
      preSnapshot: { capturedAt: 1, payload: {} },
      postSnapshot: { capturedAt: 2, payload: {} },
      fillsHash: '0xff',
      fillsCount: 0,
      gating: {},
    },
    checks: [{ name: 'x', status: 'PASS' }],
  };
  it('accepts a verdict payload', () => {
    expect(() => PortfolioV0VerdictPayloadSchema.parse(valid)).not.toThrow();
  });
});
```

- [ ] **Step 2: Implement `client/src/types/payloads/portfolio-v0.ts`**

Port the relevant schemas from today's `client/src/types/portfolio.ts`. Copy the Snapshot, EvalSnapshot, Gating, Informational, Rationale, Check shapes verbatim. Add `verificationOfRestoration` per scope §3.3.

```typescript
import { z } from 'zod';

const SnapshotSchema = z.object({
  capturedAt: z.number().int(),
  hlTime: z.number().int(),
  payload: z.unknown(),
});

const EvalSnapshotSchema = z.object({
  capturedAt: z.number().int(),
  payload: z.unknown(),
});

const GatingSchema = z.object({
  equityReturnPct: z.string(),
  maxDrawdownPct: z.string(),
  closedTradesCount: z.number().int(),
  tradedNotionalMultiple: z.string(),
});

const InformationalSchema = z
  .object({
    sharpe: z.string().optional(),
    sortino: z.string().optional(),
    calmar: z.string().optional(),
    profitFactor: z.string().optional(),
    expectancy: z.string().optional(),
    winRate: z.string().optional(),
    holdTimeMs: z
      .object({ mean: z.number(), median: z.number(), p95: z.number() })
      .optional(),
    leverageHistogram: z.record(z.number()).optional(),
    longShortMix: z
      .object({ longCount: z.number().int(), shortCount: z.number().int() })
      .optional(),
  })
  .optional();

const RationaleEntrySchema = z.object({
  ts: z.number().int(),
  sessionId: z.string(),
  note: z.string(),
  relatedFillTids: z.array(z.number().int()).optional(),
});

export const PortfolioV0RestorationPayloadSchema = z.object({
  preSnapshot: SnapshotSchema,
  postSnapshot: SnapshotSchema,
  fills: z.array(z.unknown()),
  gating: GatingSchema,
  informational: InformationalSchema,
  rationale: z.array(RationaleEntrySchema).optional(),
});

export type PortfolioV0RestorationPayload = z.infer<typeof PortfolioV0RestorationPayloadSchema>;

const CheckSchema = z.object({
  name: z.string(),
  status: z.enum(['PASS', 'FAIL', 'SKIP']),
  detail: z.union([z.string(), z.record(z.unknown())]).optional(),
});

const VerificationCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});

const VerificationOfRestorationSchema = z.object({
  claimedTier: z.enum(['self-signed', 'committed', 'consensus', 'attested', 'proved']),
  sdkVersion: z.string(),
  timestamp: z.number().int(),
  checks: z.array(VerificationCheckSchema),
  overall: z.enum(['valid', 'invalid']),
});

export const PortfolioV0VerdictPayloadSchema = z.object({
  restorationEnvelope: z.object({
    cid: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  verificationOfRestoration: VerificationOfRestorationSchema,
  verdict: z.enum(['PASS', 'FAIL', 'REJECTED', 'INDETERMINATE']),
  score: z.string(),
  scoreBasis: z.string(),
  scoreVersion: z.string(),
  rederived: z.object({
    preSnapshot: EvalSnapshotSchema,
    postSnapshot: EvalSnapshotSchema,
    fills: z.array(z.unknown()),
    gating: z.record(z.unknown()),
  }),
  claimed: z.object({
    preSnapshot: EvalSnapshotSchema,
    postSnapshot: EvalSnapshotSchema,
    fillsHash: z.string(),
    fillsCount: z.number().int(),
    gating: z.record(z.unknown()),
  }),
  checks: z.array(CheckSchema),
});

export type PortfolioV0VerdictPayload = z.infer<typeof PortfolioV0VerdictPayloadSchema>;
```

- [ ] **Step 3: Run tests**

```bash
cd client
yarn vitest run test/types/payloads/portfolio-v0.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add client/src/types/payloads/portfolio-v0.ts client/test/types/payloads/portfolio-v0.test.ts
git commit -m "feat(client): portfolio.v0 restoration + verdict payloads

Extracted from today's portfolio.v0.manifest.v1 / eval.manifest.v1.
Verdict payload adds verificationOfRestoration per scope §3.3."
```

---

## Task 3: Per-kind payloads — `prediction.v0` and `prediction.apy.v0`

**Files:**
- Create: `client/src/types/payloads/prediction-v0.ts`
- Create: `client/src/types/payloads/prediction-apy-v0.ts`
- Create: parallel tests.

- [ ] **Step 1: Port per-kind schemas from `prediction.ts` and `prediction-apy.ts`**

Follow the same pattern as Task 2. Read today's `PredictionV0SubmissionSchema` / `PredictionV0VerdictSchema` (in `types/prediction.ts`) — extract the payload-level fields (everything except envelope-level scalars like `schemaVersion`, `generatedAt`, `intent`, `evaluator`, `window`, `signature`) into the new payload schemas. Same for prediction-apy.

Verdict payloads must include `restorationEnvelope` and `verificationOfRestoration` per scope §3.3.

- [ ] **Step 2: Write tests** (parallel structure to Task 2's tests).

- [ ] **Step 3: Run tests**

```bash
cd client
yarn vitest run test/types/payloads/
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add client/src/types/payloads/prediction-v0.ts \
        client/src/types/payloads/prediction-apy-v0.ts \
        client/test/types/payloads/prediction-v0.test.ts \
        client/test/types/payloads/prediction-apy-v0.test.ts
git commit -m "feat(client): prediction.v0 + prediction.apy.v0 payloads"
```

---

## Task 4: Payload registry + payload validation helper

**Files:**
- Create: `client/src/types/payloads/index.ts`
- Create: `client/test/types/payloads/index.test.ts`

- [ ] **Step 1: Write registry**

```typescript
import { z } from 'zod';
import {
  PortfolioV0RestorationPayloadSchema,
  PortfolioV0VerdictPayloadSchema,
} from './portfolio-v0.js';
import {
  PredictionV0RestorationPayloadSchema,
  PredictionV0VerdictPayloadSchema,
} from './prediction-v0.js';
import {
  PredictionApyV0RestorationPayloadSchema,
  PredictionApyV0VerdictPayloadSchema,
} from './prediction-apy-v0.js';
import type { Role } from '../envelope.js';

/**
 * Registry mapping (kind, role) → payload schema.
 * Update when adding a new kind.
 */
export const KIND_PAYLOADS: Record<string, Record<Role, z.ZodSchema>> = {
  'portfolio.v0': {
    restoration: PortfolioV0RestorationPayloadSchema,
    verdict: PortfolioV0VerdictPayloadSchema,
  },
  'prediction.v0': {
    restoration: PredictionV0RestorationPayloadSchema,
    verdict: PredictionV0VerdictPayloadSchema,
  },
  'prediction.apy.v0': {
    restoration: PredictionApyV0RestorationPayloadSchema,
    verdict: PredictionApyV0VerdictPayloadSchema,
  },
};

export function validatePayload(kind: string, role: Role, payload: unknown): void {
  const bucket = KIND_PAYLOADS[kind];
  if (!bucket) throw new Error(`Unknown kind: ${kind}`);
  const schema = bucket[role];
  if (!schema) throw new Error(`No payload schema for (${kind}, ${role})`);
  schema.parse(payload);
}

export * from './portfolio-v0.js';
export * from './prediction-v0.js';
export * from './prediction-apy-v0.js';
```

- [ ] **Step 2: Write tests** asserting registry lookups work for all kinds + roles + that `validatePayload` throws for unknown kinds/roles.

- [ ] **Step 3: Run tests + commit**

```bash
yarn vitest run test/types/payloads/
git add client/src/types/payloads/index.ts client/test/types/payloads/index.test.ts
git commit -m "feat(client): payload registry + validatePayload"
```

---

## Task 5: Rename `role` → `artifactType` in `packaging.ts`

**Files:**
- Modify: `client/src/restorer/engine/packaging.ts`
- Modify: `client/test/restorer/engine/packaging.test.ts`, `engine-packaging.test.ts`
- Modify: anywhere else that reads `artifact.role`

- [ ] **Step 1: Find all `role` references in packaging**

```bash
cd client
grep -rn "\.role\b\|role: " src/restorer/engine/packaging.ts src/types/portfolio.ts test/restorer/engine/
```

- [ ] **Step 2: Rename in `packaging.ts`**

In `client/src/restorer/engine/packaging.ts`:
- `OutputEntrySchema.role` → `OutputEntrySchema.artifactType`
- `role: string` parameter / field → `artifactType: string`
- Default role assignments (`role: 'session_transcript'`, `'design_document'`, etc.) → `artifactType: …`
- `localPath + role` signature → `localPath + artifactType` everywhere

- [ ] **Step 3: Update `OUTPUTS.json` schema caveat**

`OUTPUTS.json` is user-authored. Breaking change: the field is `artifactType`, not `role`. Add a migration detector:

```typescript
// In OutputsJsonSchema parse: if input has .role field, throw with a
// migration message.
const OutputEntrySchema = z.object({
  path: z.string(),
  artifactType: z.string(),
  // ... other fields
}).superRefine((val, ctx) => {
  if ('role' in val) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OUTPUTS.json field 'role' is renamed to 'artifactType' — update your outputs declaration",
    });
  }
});
```

- [ ] **Step 4: Update the `Artifact` / `OutputArtifact` / `UploadedArtifact` types**

These now live in `client/src/types/envelope.ts` (Artifact). Remove the old ones from `portfolio.ts`. Anywhere else importing them updates to the new path.

- [ ] **Step 5: Update tests + fixtures**

Any test fixture using `role: 'system_snapshot'` updates to `artifactType: 'system_snapshot'`. Same for `{ role: 'x402-gated', ... }` artifact-access objects — wait, those are on `access.kind` (separate from the artifact `role`); only the top-level artifact field renames.

- [ ] **Step 6: Run packaging tests**

```bash
cd client
yarn vitest run test/restorer/engine/packaging.test.ts test/restorer/engine/engine-packaging.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add client/src/restorer/engine/packaging.ts client/test/restorer/engine
git commit -m "refactor(engine): rename artifact.role → artifactType

Field rename for clarity (role implied function; the tag names what the
artifact IS). OUTPUTS.json migration: operators who authored OUTPUTS.json
before must rename 'role' to 'artifactType'; parser emits a clear error
message when the old field is present."
```

---

## Task 6: Refactor `manifest-assembly.ts` → `envelope-assembly.ts`

**Files:**
- Create: `client/src/restorer/engine/envelope-assembly.ts`
- Delete: `client/src/restorer/engine/manifest-assembly.ts`
- Create: `client/test/restorer/engine/envelope-assembly.test.ts`
- Delete: `client/test/restorer/engine/manifest-assembly.test.ts` (content ported to envelope-assembly.test.ts)

- [ ] **Step 1: Port the test file**

Copy `manifest-assembly.test.ts` → `envelope-assembly.test.ts`. Update imports and fixtures to use the envelope schema. Assert:
- `assembleAndSignEnvelope` returns `{ envelope: SignedEnvelope, envelopeCid: string, envelopeHash: Hex }`
- `envelopeHash === keccak256(JCS(envelope without signature))`
- `envelopeCid` is the CID of the signed envelope uploaded to IPFS
- For restoration role, payload validates against `PortfolioV0RestorationPayloadSchema`
- For verdict role, payload validates and carries `restorationEnvelope` + `verificationOfRestoration`
- `executor` fields (implName, implVersion, clientGitSha, codeDigest, signingKey) are populated from inputs
- `evidenceTier` defaults to `'self-signed'` when not overridden (V1 default)

- [ ] **Step 2: Write `envelope-assembly.ts`**

```typescript
/**
 * Envelope assembly + signing.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §4.2a mechanics:
 *   - envelopeHash = keccak256(JCS(envelope minus signature))
 *   - hash is what gets signed; also = evidenceHash on-chain.
 *   - Signed envelope (with signature field populated) is uploaded to IPFS.
 */

import type { Hex } from 'viem';
import { signCanonical } from './signing.js';
import { canonicalJson } from './canonical-json.js';
import { uploadToIpfs } from '../../adapters/mech/ipfs.js';
import type {
  Role,
  EvidenceTier,
  SignedEnvelope,
  Artifact,
} from '../../types/envelope.js';
import { validatePayload } from '../../types/payloads/index.js';

export interface EnvelopeInputs {
  kind: string;
  role: Role;
  intent: {
    cid: string;
    onchainCreationTx: string;
    onchainCreationBlock: number;
    requestId: string;
  };
  participant: { safeAddress: string; agentEoa: string };
  window: { startTs: number; endTs: number };
  executor: {
    implName: string;
    implVersion: string;
    clientGitSha: string;
    codeDigest: string;
    signingKey: { kind: 'agent-eoa' | 'enclave-bound'; pubkey: string };
    source?: {
      bundleCid: string;
      sha256: string;
      humanUrl?: string;
      buildRecipe: { kind: 'dockerfile' | 'nix' | 'bazel'; path: string };
      measurement: string;
    };
  };
  evidenceTier?: EvidenceTier; // defaults to 'self-signed'
  attestation?: SignedEnvelope['attestation']; // default null
  trajectory?: SignedEnvelope['trajectory'];   // default null
  artifacts: Artifact[];
  payload: Record<string, unknown>;
  generatedAt?: number;
}

export interface AssembledEnvelope {
  envelope: SignedEnvelope;
  envelopeCid: string;
  envelopeHash: Hex;
}

export interface EnvelopeAssemblyDeps {
  ipfsRegistryUrl: string;
  agentEoaPrivateKey: Hex;
}

export async function assembleAndSignEnvelope(
  inputs: EnvelopeInputs,
  deps: EnvelopeAssemblyDeps,
): Promise<AssembledEnvelope> {
  const evidenceTier = inputs.evidenceTier ?? 'self-signed';
  const attestation = inputs.attestation ?? null;
  const trajectory = inputs.trajectory ?? null;
  const generatedAt = inputs.generatedAt ?? Date.now();

  // Validate the payload against the registry before building the envelope.
  // Runtime check catches kind/role mismatches early.
  validatePayload(inputs.kind, inputs.role, inputs.payload);

  const unsigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    kind: inputs.kind,
    role: inputs.role,
    generatedAt,
    intent: inputs.intent,
    participant: inputs.participant,
    window: inputs.window,
    executor: inputs.executor,
    evidenceTier,
    attestation,
    trajectory,
    artifacts: inputs.artifacts,
    payload: inputs.payload,
  };

  const signed = await signCanonical(
    unsigned,
    deps.agentEoaPrivateKey,
    inputs.participant.agentEoa as `0x${string}`,
  );
  const envelopeHash = signed.hash as Hex;

  const signedEnvelope: SignedEnvelope = {
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: inputs.participant.agentEoa as `0x${string}`,
      hash: signed.hash,
      sig: signed.sig,
    },
  };

  const envelopeCid = await uploadToIpfs(deps.ipfsRegistryUrl, signedEnvelope);

  return { envelope: signedEnvelope, envelopeCid, envelopeHash };
}
```

- [ ] **Step 3: Run envelope-assembly tests**

```bash
cd client
yarn vitest run test/restorer/engine/envelope-assembly.test.ts
```

Expected: all pass.

- [ ] **Step 4: Delete the old manifest-assembly files**

```bash
rm client/src/restorer/engine/manifest-assembly.ts
rm client/test/restorer/engine/manifest-assembly.test.ts
```

- [ ] **Step 5: Update imports across the codebase**

```bash
cd client
grep -rln "manifest-assembly\|assembleAndSignManifest" src test 2>&1
```

For each file, replace `manifest-assembly` path imports with `envelope-assembly`, and replace calls to `assembleAndSignManifest(...)` with `assembleAndSignEnvelope(...)`. The argument shape changes significantly — this is not a drop-in rename. Each caller must:
- Move `kind` + `role` into the call
- Move `executor` details (impl name + version + git sha + codeDigest) into the call
- Put kind-specific fields (preSnapshot, fills, gating) into `payload`

The callers are: `client/src/restorer/engine/engine.ts` (primarily) and test fixtures.

- [ ] **Step 6: Adjust engine.ts**

`engine.ts` calls `assembleAndSignManifest` in its PACKAGING state. Update to call `assembleAndSignEnvelope` with:
- `kind` from `ctx.intent.kind` (populated by Plan B's intent hydration)
- `role: 'restoration'` (since this is the restorer engine; the evaluator path has its own)
- `executor` from the RestorerImpl's declared name/version plus build-time constants
- `payload` = kind-typed payload assembled from the impl's output

Provide `executor.clientGitSha` via a build-time constant injected at build (add `CLIENT_GIT_SHA` env var or a small `build-info.ts` generated at `yarn build`).

Provide `executor.codeDigest` via a build-time constant too (hash of the bundled JS; compute at build time and inject).

- [ ] **Step 7: Run full test suite**

```bash
cd client
yarn test
```

Expected: many tests fail (impl updates + fixtures). Don't fix yet — next tasks migrate them.

- [ ] **Step 8: Commit (intermediate — tests will be red)**

```bash
git add -A
git commit -m "refactor(engine): replace manifest-assembly with envelope-assembly

Produces jinn.execution.v1 SignedEnvelope via assembleAndSignEnvelope.
Validates kind/role-typed payload against KIND_PAYLOADS registry before
signing. envelopeHash = keccak256(JCS(envelope minus signature)) per
scope §4.2a — used as evidenceHash on-chain.

Tests red until impls migrate (next tasks)."
```

Yes, committing red tests is unusual. Do it here because the next tasks' scope is large; having a known-red baseline we flip to green makes review clearer.

---

## Task 7–12: Migrate impls to produce envelopes

**Pattern:** Each impl is a straightforward substitution of the old manifest-assembly call with the new envelope-assembly call. The RestorationOutput → envelope payload mapping is:
- `restoration` role payload = the old manifest's non-envelope fields (preSnapshot, postSnapshot, fills, gating, informational, rationale)
- `verdict` role payload = the old verdict manifest's non-envelope fields (verdict, score, rederived, claimed, checks) + new `restorationEnvelope: { cid, sha256 }` + new `verificationOfRestoration: { claimedTier, sdkVersion, timestamp, checks, overall }`

Migrate each impl in its own task + commit:

- [ ] **Task 7: `claude-mcp-hyperliquid` (restorer)** — `client/src/restorer/impls/claude-mcp-hyperliquid/index.ts`. Assembles the restoration envelope for `kind='portfolio.v0'`. Source: `implOutput.{preSnapshot, postSnapshot, fills, gating, informational, rationale}` → `payload`. Run `yarn vitest run test/restorer/impls/claude-mcp-hyperliquid/`. Commit `feat(portfolio): claude-mcp-hyperliquid emits jinn.execution.v1`.

- [ ] **Task 8: `portfolio-v0-evaluator`** — `client/src/restorer/impls/portfolio-v0-evaluator/index.ts`. Produces verdict envelope for kind='portfolio.v0'. Key additions vs old verdict manifest:
  - Call the SDK verification helper (stub for now; Plan D will connect the real SDK) to produce `verificationOfRestoration`
  - Include `payload.restorationEnvelope: { cid, sha256 }` referencing the restoration being evaluated
  - Evaluator refuses to score if `verificationOfRestoration.overall === 'invalid'` — emit `REJECTED` verdict citing the failing check
  - Stub SDK helper returns `{ claimedTier: envelope.evidenceTier, sdkVersion: '0.0.0-stub', timestamp: now, checks: [{ name: 'stub', passed: true }], overall: 'valid' }` until Plan D wires the real one.
  Run `yarn vitest run test/restorer/impls/portfolio-v0-evaluator/`. Commit `feat(portfolio): portfolio-v0-evaluator emits jinn.execution.v1 verdict`.

- [ ] **Task 9: `claude-mcp-prediction` + `prediction-v0-baseline` (restorers)** — Both migrate in the same task since they share the kind. Run tests. Commit `feat(prediction): prediction.v0 restorers emit jinn.execution.v1`.

- [ ] **Task 10: `prediction-v0-evaluator`** — Parallel to Task 8. Run tests. Commit.

- [ ] **Task 11: `claude-mcp-prediction-apy` + `prediction-apy-v0-baseline`** — Parallel to Task 9. Run tests. Commit.

- [ ] **Task 12: `prediction-apy-v0-evaluator`** — Parallel to Task 8. Run tests. Commit.

---

## Task 13: Update `delivery-watcher.ts` to consume envelopes

**Files:**
- Modify: `client/src/daemon/delivery-watcher.ts`
- Modify: tests.

- [ ] **Step 1: Read current delivery-watcher**

It fetches a delivered manifest CID from chain, pulls it off IPFS, validates shape, creates an evaluation job. Today it validates against per-kind manifest schemas.

- [ ] **Step 2: Replace manifest parsing with envelope parsing**

Use `SignedEnvelopeSchema.parse` + `validatePayload(env.kind, env.role, env.payload)`. Reject deliveries with invalid envelopes (log + skip; don't throw the daemon).

- [ ] **Step 3: Run delivery-watcher tests**

```bash
cd client
yarn vitest run test/daemon/delivery-watcher.test.ts
```

Expected: all pass after fixture updates.

- [ ] **Step 4: Commit**

```bash
git add client/src/daemon client/test/daemon
git commit -m "refactor(daemon): delivery-watcher parses jinn.execution.v1 envelopes"
```

---

## Task 14: Delete the old per-kind manifest schemas

**Files:**
- Modify: `client/src/types/portfolio.ts` — strip `RestorationManifestSchema`, `VerdictManifestSchema`, and their inferred types. Keep only `PortfolioV0Spec`, `PortfolioV0Eligibility`, `PortfolioV0Intent*` (intent-spec parts).
- Modify: `client/src/types/prediction.ts` — same.
- Modify: `client/src/types/prediction-apy.ts` — same.

- [ ] **Step 1: Strip the manifest/verdict schemas**

For each file, remove the manifest + verdict schema definitions and their type exports. Update `types/index.ts` to drop the corresponding re-exports.

- [ ] **Step 2: Run full test suite**

```bash
cd client
yarn test
```

Expected: all pass. Any remaining import errors reveal call sites that still expect the old types.

- [ ] **Step 3: Typecheck + build**

```bash
cd client
yarn typecheck && yarn build
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/types
git commit -m "chore(client): delete legacy per-kind manifest schemas

One-shot cutover per scope v0.9 §3.4. portfolio.v0.manifest.v1,
portfolio.v0.eval.manifest.v1, prediction.v0.submission.v1,
prediction.v0.verdict.v1, prediction.apy.v0.submission.v1, and
prediction.apy.v0.verdict.v1 are fully replaced by jinn.execution.v1
with role discriminator."
```

---

## Task 15: Regenerate / update test fixtures

**Files:**
- Various under `client/fixtures/` and `client/test/fixtures/`.

- [ ] **Step 1: Grep for fixture files still referencing old schema versions**

```bash
cd client
grep -rln "portfolio.v0.manifest.v1\|prediction.v0.submission.v1\|prediction.apy.v0" fixtures test/fixtures 2>&1
```

- [ ] **Step 2: For each fixture, update to envelope shape**

The mapping: `{ schemaVersion: 'portfolio.v0.manifest.v1', ...manifestFields }` → `{ schemaVersion: 'jinn.execution.v1', kind: 'portfolio.v0', role: 'restoration', executor: {...}, evidenceTier: 'self-signed', attestation: null, trajectory: null, artifacts: [], payload: {...manifestFields.specificToKind} }`. If a fixture test is purely structural, regenerate from the new helpers rather than hand-editing.

- [ ] **Step 3: Run full suite**

```bash
cd client
yarn test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add client/fixtures client/test/fixtures
git commit -m "test: regenerate fixtures for jinn.execution.v1"
```

---

## Task 16: Final verification

**Files:** None — verification only.

- [ ] **Step 1: Full test suite**

```bash
cd client
yarn test
```

Expected: 0 failures.

- [ ] **Step 2: Typecheck + build**

```bash
cd client
yarn typecheck && yarn build
```

Expected: 0 errors.

- [ ] **Step 3: E2E**

```bash
cd client
yarn e2e
```

Expected: pass. The e2e spawns Anvil, runs a full restoration + evaluation, and verifies staking rewards. If it passes, the envelope refactor round-trips through every layer of the Jinn loop.

- [ ] **Step 4: grep verification**

```bash
cd client
grep -rn "portfolio.v0.manifest.v1\|portfolio.v0.eval.manifest.v1\|prediction.v0.submission.v1\|prediction.v0.verdict.v1\|prediction.apy.v0.submission.v1\|prediction.apy.v0.verdict.v1" src test fixtures
```

Expected: empty. If anything remains, it's a straggler; delete it.

---

## Self-review before marking this plan done

- [ ] Every per-kind manifest is gone. Only `jinn.execution.v1` lives in types.
- [ ] `role` (on artifacts) is renamed to `artifactType` everywhere.
- [ ] `envelopeHash` logic matches §4.2a exactly.
- [ ] All restorer + evaluator impls produce envelopes.
- [ ] Delivery watcher consumes envelopes.
- [ ] Test fixtures regenerated.
- [ ] Full suite green.
- [ ] Typecheck + build green.
- [ ] E2E green.
- [ ] No residual references to old schema versions.

---

## Follow-ups (later plans)

- **Plan D** populates the now-nullable `trajectory` field when the OTel + hash-chain plumbing lands.
- **Plan E** registers each signed envelope on ERC-8004's Identity Registry as `adw:ExecutionEnvelope`.
- **Plan F** conformance suite validates everything this plan ships: envelope schema, artifact-type vocabulary, payload registry, evidenceHash determinism.
- **V2** populates `attestation` + `executor.source` when Phala TEE integration lands.

---

*End of Plan C. This is the meatiest V1 plan — after this lands, D/E/F/G can proceed in parallel.*
