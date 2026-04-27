# Envelope V1 — Plan E: ERC-8004 Three-Registry Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the client's ERC-8004 integration from Identity-Registry-only + two entity kinds (`adw:AgentCard`, `adw:Artifact`) to the full three-registry separation from scope §3.3: Identity Registry gains `adw:Intent`, `adw:ExecutionEnvelope`, and `adw:SourceBundle` entity kinds (and `adw:Artifact` gets a `parentEnvelopeCid` back-reference); the Validation Registry gets a first-ever client — challenger-verification request/response flow; and the Reputation Registry gets a read-only surface that aggregates operator signals via the subgraph. Wire the new registrations into the existing Jinn loop (intent posting, envelope delivery, operator setup) and extend the subgraph client with typed queries for the new entity kinds plus a knowledge-tree query rooted at an intent.

**Architecture:** `client/src/discovery/registry.ts` grows four new methods — `registerIntent`, `registerEnvelope`, `registerSourceBundle`, `registerArtifactWithParent` — each producing the `(agentURI, metadata[])` tuple required by the Identity Registry `register(...)` function. A new module `client/src/validation/registry.ts` wraps the Validation Registry contract (new ABI fragment — `createValidationRequest` / `createValidationResponse`). A new module `client/src/reputation/index.ts` exposes read-only aggregation helpers that delegate to `client/src/discovery/subgraph.ts` queries — there are no Reputation Registry writes; reputation is emergent from Validation Registry events per scope §3.3. `subgraph.ts` gains typed query helpers (`queryIntents`, `queryEnvelopes`, `querySourceBundles`, `queryKnowledgeTree`). Wiring: `client/src/intents/posting-service.ts` calls `registry.registerIntent(...)` after IPFS upload; `client/src/restorer/engine/engine.ts` calls `registry.registerEnvelope(...)` + `registry.registerArtifactWithParent(...)` after the envelope CID is known; a new CLI verb `jinn register-source-bundle` handles the one-off operator setup for `adw:SourceBundle`.

**Tech Stack:** TypeScript, Vitest, viem, Zod (metadata schemas), existing `canonicalJson` (JCS), existing `Registry8004` class wrapping the Identity Registry contract.

**Non-goals for this slice:**
- No subgraph GraphQL schema / deployment — Plan G owns that. This plan writes *query helpers* that assume the subgraph schema exists with the expected shape.
- No content-level trajectory indexing — scope §3.3 "Trajectory content indexing" is an explicit non-goal (V1 indexes metadata only).
- No on-chain quote verifier contract — scope §3.3 "Attestation verification (V2)" row defers on-chain verification to V3+.
- No protocol fee / gating enforcement on top of `adw:ExecutionEnvelope` registrations — D8 (deferred gating epic) owns monetization.
- No Reputation Registry writes — scope §3.3 "Reputation is emergent, not hand-written." This plan ships only read helpers.
- No automatic challenger bot — the Validation Registry client provides the primitive; a self-service challenger workflow is future work.

**Before you start:** Plans A (JCS), B (intent.v1 schema), and C (generic envelope) must be merged. This plan depends on:

- `SignedIntentV1` type (Plan B) — `registerIntent` metadata includes `kind`, `creator`, `createdAt`, `requestId` which come directly from a `SignedIntentV1` + its request-id.
- `SignedEnvelope` type (Plan C) — `registerEnvelope` metadata includes `kind`, `role`, `evidenceTier`, `intent.cid`, `participant`, `generatedAt`.
- `envelope-assembly.ts` returning `{ envelope, envelopeCid, envelopeHash }` (Plan C) — engine calls the registry after this helper returns.
- `Artifact` shape with `artifactType` (Plan C) — `registerArtifactWithParent` consumes artifacts in their new shape.

**Reference:**
- `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` §3.1 (K4 source bundle as first-class entity, K8 ERC-8004 three-registry separation), §3.3 (three-registry table row, envelope registration row, trajectory content indexing non-goal, attestation verification V2 row), §4.9 (deliverable: ERC-8004 registration + subgraph schema).
- ERC-8004 IdentityRegistry ABI — already wired in `client/src/discovery/registry.ts`. We extend it with new entity kinds (new `documentType` values), not new contract calls.
- ERC-8004 ValidationRegistry ABI — two functions: `createValidationRequest(string entityUri, string requestUri)` returns `uint256 requestId`; `createValidationResponse(uint256 requestId, string responseUri)`. Both emit events that the subgraph indexes. (If the deployed ERC-8004 Validation Registry exposes slightly different function names / signatures, adjust the ABI fragment — the envelope over the call pattern is stable.)

---

## File structure

New files:
- `client/src/discovery/metadata-schemas.ts` — Zod schemas for each metadata tuple (`IntentMetadataSchema`, `EnvelopeMetadataSchema`, `SourceBundleMetadataSchema`, `ArtifactMetadataSchema`). Used both for producing the tuple on the write side and validating the tuple on the subgraph read side.
- `client/src/validation/registry.ts` — `ValidationRegistry8004` class: `submitValidationRequest`, `submitValidationResponse`.
- `client/src/validation/types.ts` — Zod schemas for validation request/response payloads (`AttestationVerifyRequestSchema`, `AttestationVerifyResponseSchema`).
- `client/src/reputation/index.ts` — `getOperatorReputation(safeAddress, deps)` delegating to `queryOperatorValidations` in subgraph.
- `client/src/cli/commands/register-source-bundle.ts` — new CLI verb.
- `client/test/discovery/registry.test.ts` — unit tests for each new `register*` method. (May already exist for the two old methods; extend it.)
- `client/test/discovery/metadata-schemas.test.ts` — unit tests for each metadata schema.
- `client/test/discovery/subgraph.test.ts` — extend existing tests with new query helpers.
- `client/test/validation/registry.test.ts` — tests for the Validation Registry client.
- `client/test/reputation/index.test.ts` — tests for the read-only aggregation surface.
- `client/test/cli/register-source-bundle.test.ts` — tests for the new CLI.

Modified files:
- `client/src/discovery/registry.ts` — add new methods, wire metadata schemas.
- `client/src/discovery/subgraph.ts` — add `queryIntents`, `queryEnvelopes`, `querySourceBundles`, `queryKnowledgeTree`, `queryOperatorValidations`.
- `client/src/discovery/index.ts` — re-export new types + helpers.
- `client/src/intents/posting-service.ts` — post-IPFS-upload hook calls `registry.registerIntent(...)`.
- `client/src/restorer/engine/engine.ts` — post-assembly hook calls `registry.registerEnvelope(...)` + `registry.registerArtifactWithParent(...)` per artifact.
- `client/src/config.ts` — new optional config fields `validationRegistryAddress`, `reputationEnabled` (read-only flag).
- `client/src/cli/index.ts` (or wherever verbs are dispatched) — register the new `register-source-bundle` verb.

---

## Task 1: Define metadata schemas for each entity kind

**Files:**
- Create: `client/src/discovery/metadata-schemas.ts`
- Create: `client/test/discovery/metadata-schemas.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/discovery/metadata-schemas.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  IntentMetadataSchema,
  EnvelopeMetadataSchema,
  SourceBundleMetadataSchema,
  ArtifactMetadataSchema,
  metadataToTuple,
  tupleToMetadata,
} from '../../src/discovery/metadata-schemas.js';

describe('IntentMetadataSchema', () => {
  const valid = {
    documentType: 'adw:Intent' as const,
    kind: 'portfolio.v0',
    creator: '0x1111111111111111111111111111111111111111',
    createdAt: 1700000000000,
    requestId: '0x' + 'ab'.repeat(32),
  };

  it('accepts a well-formed intent metadata', () => {
    expect(() => IntentMetadataSchema.parse(valid)).not.toThrow();
  });

  it('rejects wrong documentType', () => {
    expect(() =>
      IntentMetadataSchema.parse({ ...valid, documentType: 'adw:AgentCard' }),
    ).toThrow();
  });

  it('rejects missing kind', () => {
    const { kind: _k, ...bad } = valid;
    expect(() => IntentMetadataSchema.parse(bad)).toThrow();
  });
});

describe('EnvelopeMetadataSchema', () => {
  const valid = {
    documentType: 'adw:ExecutionEnvelope' as const,
    kind: 'portfolio.v0',
    role: 'restoration' as const,
    evidenceTier: 'self-signed' as const,
    intentCid: 'bafy-intent',
    participant: '0x1111111111111111111111111111111111111111',
    generatedAt: 1700000000000,
  };

  it('accepts a well-formed envelope metadata', () => {
    expect(() => EnvelopeMetadataSchema.parse(valid)).not.toThrow();
  });

  it('accepts optional parentEnvelopeCid for verdict envelopes', () => {
    const verdict = { ...valid, role: 'verdict' as const, parentEnvelopeCid: 'bafy-restore' };
    expect(() => EnvelopeMetadataSchema.parse(verdict)).not.toThrow();
  });

  it('accepts optional measurement for attested tier', () => {
    const attested = {
      ...valid,
      evidenceTier: 'attested' as const,
      measurement: '0x' + 'cc'.repeat(48),
    };
    expect(() => EnvelopeMetadataSchema.parse(attested)).not.toThrow();
  });

  it('rejects invalid role', () => {
    expect(() =>
      EnvelopeMetadataSchema.parse({ ...valid, role: 'witness' }),
    ).toThrow();
  });
});

describe('SourceBundleMetadataSchema', () => {
  const valid = {
    documentType: 'adw:SourceBundle' as const,
    measurement: '0x' + 'dd'.repeat(48),
    buildRecipeKind: 'dockerfile' as const,
    publishedBy: '0x1111111111111111111111111111111111111111',
    humanUrl: 'https://github.com/jinn/client-1.0.0',
  };

  it('accepts a well-formed source bundle metadata', () => {
    expect(() => SourceBundleMetadataSchema.parse(valid)).not.toThrow();
  });

  it('accepts with humanUrl omitted', () => {
    const { humanUrl: _h, ...noUrl } = valid;
    expect(() => SourceBundleMetadataSchema.parse(noUrl)).not.toThrow();
  });

  it('rejects invalid buildRecipeKind', () => {
    expect(() =>
      SourceBundleMetadataSchema.parse({ ...valid, buildRecipeKind: 'makefile' }),
    ).toThrow();
  });
});

describe('ArtifactMetadataSchema (extended with parentEnvelopeCid)', () => {
  const valid = {
    documentType: 'adw:Artifact' as const,
    artifactId: 'bafy-art',
    title: 'trajectory',
    tags: ['portfolio.v0'],
    outcome: 'PASS',
    endpoint: 'ipfs://bafy-art',
    parentEnvelopeCid: 'bafy-env',
  };

  it('accepts with parentEnvelopeCid', () => {
    expect(() => ArtifactMetadataSchema.parse(valid)).not.toThrow();
  });

  it('accepts without parentEnvelopeCid (back-compat for legacy artifacts)', () => {
    const { parentEnvelopeCid: _p, ...legacy } = valid;
    expect(() => ArtifactMetadataSchema.parse(legacy)).not.toThrow();
  });
});

describe('metadataToTuple / tupleToMetadata round-trip', () => {
  it('round-trips an intent metadata object through tuple form', () => {
    const original = {
      documentType: 'adw:Intent' as const,
      kind: 'portfolio.v0',
      creator: '0x1111111111111111111111111111111111111111',
      createdAt: 1700000000000,
      requestId: '0x' + 'ab'.repeat(32),
    };
    const tuple = metadataToTuple(original);
    const roundTripped = tupleToMetadata(tuple, IntentMetadataSchema);
    expect(roundTripped).toEqual(original);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd client
yarn vitest run test/discovery/metadata-schemas.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Write `client/src/discovery/metadata-schemas.ts`**

```typescript
/**
 * ERC-8004 Identity Registry metadata schemas.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.1 (K4 source bundle), §3.3 (three-registry separation, envelope registration row).
 *
 * Each entity kind registered on the Identity Registry (via `register(agentURI,
 * metadata[])`) emits a set of (metadataKey, metadataValue) tuples. These
 * schemas describe the structured object form before encoding to tuples. Used
 * both on the write side (producing the tuples for the on-chain call) and the
 * read side (parsing the tuples returned by the subgraph into typed objects).
 *
 * Encoding: metadataValue is hex-encoded UTF-8 bytes of the JSON-stringified
 * primitive value. Numbers and strings are stringified. Hex values stay
 * hex-encoded (no double-encoding).
 */

import { z } from 'zod';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

// ── Intent metadata ─────────────────────────────────────────────────────────

export const IntentMetadataSchema = z.object({
  documentType: z.literal('adw:Intent'),
  kind: z.string().min(1),
  creator: HexStringSchema, // safe address
  createdAt: z.number().int(),
  requestId: HexStringSchema,
});
export type IntentMetadata = z.infer<typeof IntentMetadataSchema>;

// ── Envelope metadata ───────────────────────────────────────────────────────

export const EnvelopeMetadataSchema = z.object({
  documentType: z.literal('adw:ExecutionEnvelope'),
  kind: z.string().min(1),
  role: z.enum(['restoration', 'verdict']),
  evidenceTier: z.enum(['self-signed', 'committed', 'consensus', 'attested', 'proved']),
  intentCid: z.string().min(1),
  parentEnvelopeCid: z.string().optional(), // only verdict envelopes set this
  measurement: HexStringSchema.optional(), // only attested tier sets this
  participant: HexStringSchema, // safe address of operator
  generatedAt: z.number().int(),
});
export type EnvelopeMetadata = z.infer<typeof EnvelopeMetadataSchema>;

// ── Source bundle metadata ──────────────────────────────────────────────────

export const SourceBundleMetadataSchema = z.object({
  documentType: z.literal('adw:SourceBundle'),
  measurement: HexStringSchema,
  buildRecipeKind: z.enum(['dockerfile', 'nix', 'bazel']),
  publishedBy: HexStringSchema,
  humanUrl: z.string().optional(),
});
export type SourceBundleMetadata = z.infer<typeof SourceBundleMetadataSchema>;

// ── Artifact metadata (extended) ────────────────────────────────────────────

export const ArtifactMetadataSchema = z.object({
  documentType: z.literal('adw:Artifact'),
  artifactId: z.string().min(1),
  title: z.string(),
  tags: z.array(z.string()).or(z.string()), // tags may round-trip as JSON string
  outcome: z.string(),
  endpoint: z.string(),
  parentEnvelopeCid: z.string().optional(), // added in Plan E
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

// ── Tuple <-> object conversion ─────────────────────────────────────────────

export interface MetadataTuple {
  metadataKey: string;
  metadataValue: `0x${string}`;
}

function encodeValue(value: unknown): `0x${string}` {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return ('0x' + Buffer.from(s, 'utf8').toString('hex')) as `0x${string}`;
}

function decodeValue(hex: `0x${string}`): string {
  return Buffer.from(hex.slice(2), 'hex').toString('utf8');
}

/**
 * Convert a structured metadata object to the on-chain tuple array expected by
 * the Identity Registry's `register(uri, metadata[])`.
 */
export function metadataToTuple(metadata: Record<string, unknown>): MetadataTuple[] {
  return Object.entries(metadata)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({ metadataKey: k, metadataValue: encodeValue(v) }));
}

/**
 * Parse a subgraph-returned metadata tuple array into a typed object matching
 * the supplied schema. Values that look like JSON (parse successfully) are
 * parsed; otherwise the raw string is used.
 */
export function tupleToMetadata<T extends z.ZodType>(
  tuples: Array<{ key: string; value: string }>,
  schema: T,
): z.infer<T> {
  const obj: Record<string, unknown> = {};
  for (const { key, value } of tuples) {
    // Attempt JSON.parse so that tags (array) round-trips; fall back to raw.
    try {
      obj[key] = JSON.parse(value);
    } catch {
      obj[key] = value;
    }
    // Numeric fields: coerce if the schema expects a number.
    if (key === 'createdAt' || key === 'generatedAt') {
      const n = Number(value);
      if (Number.isFinite(n)) obj[key] = n;
    }
  }
  return schema.parse(obj) as z.infer<T>;
}
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/discovery/metadata-schemas.test.ts
```

Expected: all pass.

- [ ] **Step 5: Typecheck**

```bash
cd client
yarn typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/discovery/metadata-schemas.ts \
        client/test/discovery/metadata-schemas.test.ts
git commit -m "feat(discovery): ERC-8004 metadata schemas for Plan E entity kinds

Zod schemas + tuple-encoding helpers for adw:Intent, adw:ExecutionEnvelope,
adw:SourceBundle, and the extended adw:Artifact (with parentEnvelopeCid).
Same schemas used on the write side (producing the on-chain tuples) and
the subgraph read side. Scope v0.9 §3.1 K4, §3.3."
```

---

## Task 2: Extend `Registry8004` with `registerIntent`

**Files:**
- Modify: `client/src/discovery/registry.ts`
- Create: `client/test/discovery/registry.test.ts` (if missing) or extend existing

- [ ] **Step 1: Write the failing test**

In `client/test/discovery/registry.test.ts`, add:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Registry8004 } from '../../src/discovery/registry.js';

describe('Registry8004.registerIntent', () => {
  it('builds the correct (agentURI, metadata[]) call and returns the tx block number', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtxhash');
    const waitMock = vi.fn().mockResolvedValue({ blockNumber: 42n });

    // Construct a test instance with mocked clients.
    const registry = new Registry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    // Inject mocks via a test hook (add a protected method for test harness).
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    const blockNumber = await registry.registerIntent({
      intentCid: 'bafy-intent',
      kind: 'portfolio.v0',
      creator: '0x1111111111111111111111111111111111111111',
      createdAt: 1700000000000,
      requestId: '0x' + 'ab'.repeat(32),
    });

    expect(blockNumber).toBe(42n);
    expect(writeMock).toHaveBeenCalledTimes(1);
    const args = writeMock.mock.calls[0]![0];
    expect(args.functionName).toBe('register');
    expect(args.args[0]).toBe('intent:bafy-intent');

    // Metadata tuple keys include documentType + kind + creator + createdAt + requestId
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).toContain('documentType');
    expect(keys).toContain('kind');
    expect(keys).toContain('creator');
    expect(keys).toContain('createdAt');
    expect(keys).toContain('requestId');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client
yarn vitest run test/discovery/registry.test.ts
```

Expected: FAIL (method `registerIntent` does not exist).

- [ ] **Step 3: Implement `registerIntent` in `registry.ts`**

Append a new method inside the `Registry8004` class:

```typescript
import {
  IntentMetadataSchema,
  metadataToTuple,
  type IntentMetadata,
} from './metadata-schemas.js';

// ... existing class ...

  /**
   * Register a published `intent.v1` CID on the Identity Registry.
   *
   * Scope §3.3: adds `adw:Intent` as an entity kind. Every published intent
   * gets registered so knowledge-tree queries can root at `intentCid`.
   *
   * `agentURI` = `intent:<cid>` — distinct from `artifact:<id>` to let subgraph
   * queries filter on URI prefix without reading metadata.
   */
  async registerIntent(params: {
    intentCid: string;
    kind: string;
    creator: string;       // safe address
    createdAt: number;     // unix ms
    requestId: string;     // 0x-prefixed bytes32
  }): Promise<bigint> {
    const metadata: IntentMetadata = {
      documentType: 'adw:Intent',
      kind: params.kind,
      creator: params.creator,
      createdAt: params.createdAt,
      requestId: params.requestId,
    };
    // Validate before encoding — catches bad input before a gas-costing tx.
    IntentMetadataSchema.parse(metadata);
    return this._register(`intent:${params.intentCid}`, metadataToTuple(metadata));
  }
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/discovery/registry.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/discovery/registry.ts client/test/discovery/registry.test.ts
git commit -m "feat(discovery): Registry8004.registerIntent

Add adw:Intent as a first-class entity kind on the ERC-8004 Identity
Registry. agentURI = intent:<cid>. Metadata mirrors the IntentMetadataSchema
from Plan E Task 1. Scope v0.9 §3.3."
```

---

## Task 3: Extend `Registry8004` with `registerEnvelope`

**Files:**
- Modify: `client/src/discovery/registry.ts`
- Modify: `client/test/discovery/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/discovery/registry.test.ts`:

```typescript
describe('Registry8004.registerEnvelope', () => {
  it('builds correct args for a restoration envelope', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtx');
    const waitMock = vi.fn().mockResolvedValue({ blockNumber: 100n });
    const registry = new Registry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    await registry.registerEnvelope({
      envelopeCid: 'bafy-env',
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'self-signed',
      intentCid: 'bafy-intent',
      participant: '0x2222222222222222222222222222222222222222',
      generatedAt: 1700000000000,
    });

    const args = writeMock.mock.calls[0]![0];
    expect(args.args[0]).toBe('envelope:bafy-env');
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).toContain('role');
    expect(keys).toContain('evidenceTier');
    expect(keys).not.toContain('parentEnvelopeCid'); // restoration has no parent
  });

  it('includes parentEnvelopeCid for verdict envelopes', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtx');
    const waitMock = vi.fn().mockResolvedValue({ blockNumber: 101n });
    const registry = new Registry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    await registry.registerEnvelope({
      envelopeCid: 'bafy-verdict',
      kind: 'portfolio.v0',
      role: 'verdict',
      evidenceTier: 'self-signed',
      intentCid: 'bafy-intent',
      parentEnvelopeCid: 'bafy-restore',
      participant: '0x3333333333333333333333333333333333333333',
      generatedAt: 1700000000500,
    });

    const args = writeMock.mock.calls[0]![0];
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).toContain('parentEnvelopeCid');
  });

  it('includes measurement for attested tier envelopes', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtx');
    const waitMock = vi.fn().mockResolvedValue({ blockNumber: 102n });
    const registry = new Registry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    await registry.registerEnvelope({
      envelopeCid: 'bafy-env',
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'attested',
      intentCid: 'bafy-intent',
      measurement: '0x' + 'cc'.repeat(48),
      participant: '0x3333333333333333333333333333333333333333',
      generatedAt: 1700000000000,
    });

    const args = writeMock.mock.calls[0]![0];
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).toContain('measurement');
  });
});
```

- [ ] **Step 2: Implement `registerEnvelope` in `registry.ts`**

```typescript
import {
  EnvelopeMetadataSchema,
  type EnvelopeMetadata,
} from './metadata-schemas.js';

  /**
   * Register a published `jinn.execution.v1` envelope CID on the Identity
   * Registry.
   *
   * Scope §3.3: adds `adw:ExecutionEnvelope` as an entity kind. Every
   * published envelope gets registered. Gas cost ~5–10k at Phase 1b scale;
   * acceptable per scope §3.3 envelope-registration row.
   *
   * `agentURI` = `envelope:<cid>`.
   */
  async registerEnvelope(params: {
    envelopeCid: string;
    kind: string;
    role: 'restoration' | 'verdict';
    evidenceTier: EnvelopeMetadata['evidenceTier'];
    intentCid: string;
    parentEnvelopeCid?: string;
    measurement?: string;
    participant: string;
    generatedAt: number;
  }): Promise<bigint> {
    const metadata: EnvelopeMetadata = {
      documentType: 'adw:ExecutionEnvelope',
      kind: params.kind,
      role: params.role,
      evidenceTier: params.evidenceTier,
      intentCid: params.intentCid,
      ...(params.parentEnvelopeCid ? { parentEnvelopeCid: params.parentEnvelopeCid } : {}),
      ...(params.measurement ? { measurement: params.measurement as `0x${string}` } : {}),
      participant: params.participant,
      generatedAt: params.generatedAt,
    };
    EnvelopeMetadataSchema.parse(metadata);
    return this._register(`envelope:${params.envelopeCid}`, metadataToTuple(metadata));
  }
```

- [ ] **Step 3: Run tests + commit**

```bash
cd client
yarn vitest run test/discovery/registry.test.ts
git add client/src/discovery/registry.ts client/test/discovery/registry.test.ts
git commit -m "feat(discovery): Registry8004.registerEnvelope

Register adw:ExecutionEnvelope entities with (kind, role, evidenceTier,
intentCid, parentEnvelopeCid?, measurement?, participant, generatedAt).
Scope v0.9 §3.3 envelope-registration row."
```

---

## Task 4: Extend `Registry8004` with `registerSourceBundle`

**Files:**
- Modify: `client/src/discovery/registry.ts`
- Modify: `client/test/discovery/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('Registry8004.registerSourceBundle', () => {
  it('registers an adw:SourceBundle under source:<cid>', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtx');
    const waitMock = vi.fn().mockResolvedValue({ blockNumber: 200n });
    const registry = new Registry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    const block = await registry.registerSourceBundle({
      bundleCid: 'bafy-src',
      measurement: '0x' + 'dd'.repeat(48),
      buildRecipeKind: 'dockerfile',
      publishedBy: '0x4444444444444444444444444444444444444444',
      humanUrl: 'https://github.com/jinn/client-1.0.0',
    });

    expect(block).toBe(200n);
    const args = writeMock.mock.calls[0]![0];
    expect(args.args[0]).toBe('source:bafy-src');
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'documentType',
        'measurement',
        'buildRecipeKind',
        'publishedBy',
        'humanUrl',
      ]),
    );
  });

  it('omits humanUrl when not provided', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtx');
    const waitMock = vi.fn().mockResolvedValue({ blockNumber: 201n });
    const registry = new Registry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    await registry.registerSourceBundle({
      bundleCid: 'bafy-src',
      measurement: '0x' + 'dd'.repeat(48),
      buildRecipeKind: 'nix',
      publishedBy: '0x4444444444444444444444444444444444444444',
    });

    const args = writeMock.mock.calls[0]![0];
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).not.toContain('humanUrl');
  });
});
```

- [ ] **Step 2: Implement `registerSourceBundle`**

```typescript
import {
  SourceBundleMetadataSchema,
  type SourceBundleMetadata,
} from './metadata-schemas.js';

  /**
   * Register an `adw:SourceBundle` — the IPFS-pinned source-code bundle that
   * an operator builds their executor from. Called once per release, not per
   * envelope. Referenced by every envelope via `executor.source.bundleCid`.
   *
   * Scope §3.1 K4: "Source bundle is a first-class ERC-8004 entity —
   * registered once per release, referenced by every envelope from that
   * build. Enables 'show me envelopes running bundle X' lineage queries."
   *
   * `agentURI` = `source:<cid>`.
   */
  async registerSourceBundle(params: {
    bundleCid: string;
    measurement: string;
    buildRecipeKind: SourceBundleMetadata['buildRecipeKind'];
    publishedBy: string; // safe address
    humanUrl?: string;
  }): Promise<bigint> {
    const metadata: SourceBundleMetadata = {
      documentType: 'adw:SourceBundle',
      measurement: params.measurement as `0x${string}`,
      buildRecipeKind: params.buildRecipeKind,
      publishedBy: params.publishedBy,
      ...(params.humanUrl ? { humanUrl: params.humanUrl } : {}),
    };
    SourceBundleMetadataSchema.parse(metadata);
    return this._register(`source:${params.bundleCid}`, metadataToTuple(metadata));
  }
```

- [ ] **Step 3: Run tests + commit**

```bash
cd client
yarn vitest run test/discovery/registry.test.ts
git add client/src/discovery/registry.ts client/test/discovery/registry.test.ts
git commit -m "feat(discovery): Registry8004.registerSourceBundle

Register adw:SourceBundle entities for per-release source-bundle lineage.
Scope v0.9 §3.1 K4."
```

---

## Task 5: Extend `registerArtifact` with `parentEnvelopeCid`

**Files:**
- Modify: `client/src/discovery/registry.ts`
- Modify: `client/test/discovery/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('Registry8004.registerArtifactWithParent', () => {
  it('includes parentEnvelopeCid in metadata', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtx');
    const waitMock = vi.fn().mockResolvedValue({ blockNumber: 300n });
    const registry = new Registry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    await registry.registerArtifactWithParent({
      id: 'bafy-art',
      title: 'trajectory',
      tags: ['portfolio.v0'],
      outcome: 'PASS',
      endpoint: 'ipfs://bafy-art',
      parentEnvelopeCid: 'bafy-env',
    });

    const args = writeMock.mock.calls[0]![0];
    const kv = (args.args[1] as Array<{ metadataKey: string; metadataValue: string }>)
      .reduce((acc, { metadataKey, metadataValue }) => {
        acc[metadataKey] = metadataValue;
        return acc;
      }, {} as Record<string, string>);
    // decode hex -> utf8 for parentEnvelopeCid check
    expect(kv['parentEnvelopeCid']).toBeDefined();
  });
});
```

- [ ] **Step 2: Add `registerArtifactWithParent` method**

Keep the existing `registerArtifact(artifact)` as-is (for back-compat with any thin callers); add a new method that takes the parent envelope CID:

```typescript
  /**
   * Register an `adw:Artifact` with an explicit `parentEnvelopeCid` back-pointer
   * to the envelope that produced it. New in Plan E per scope §3.3. Existing
   * `registerArtifact` method remains for callers that don't yet know the
   * parent envelope CID at registration time (legacy path).
   */
  async registerArtifactWithParent(artifact: {
    id: string;
    title: string;
    tags: string[];
    outcome: string;
    endpoint: string;
    parentEnvelopeCid: string;
  }): Promise<bigint> {
    const metadata = {
      documentType: 'adw:Artifact' as const,
      artifactId: artifact.id,
      title: artifact.title,
      tags: artifact.tags,
      outcome: artifact.outcome,
      endpoint: artifact.endpoint,
      parentEnvelopeCid: artifact.parentEnvelopeCid,
    };
    return this._register(`artifact:${artifact.id}`, metadataToTuple(metadata));
  }
```

- [ ] **Step 3: Run tests + commit**

```bash
cd client
yarn vitest run test/discovery/registry.test.ts
git add client/src/discovery/registry.ts client/test/discovery/registry.test.ts
git commit -m "feat(discovery): Registry8004.registerArtifactWithParent

New method adds parentEnvelopeCid back-pointer per scope §3.3. Existing
registerArtifact kept for legacy callers that don't have the parent CID
at registration time."
```

---

## Task 6: Validation Registry client — ABI + payload schemas

**Files:**
- Create: `client/src/validation/types.ts`
- Create: `client/test/validation/types.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/test/validation/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  AttestationVerifyRequestSchema,
  AttestationVerifyResponseSchema,
} from '../../src/validation/types.js';

describe('AttestationVerifyRequestSchema', () => {
  const valid = {
    requestType: 'attestation-verify' as const,
    envelopeCid: 'bafy-env',
    envelopeHash: '0x' + 'ab'.repeat(32),
    challenger: '0x1111111111111111111111111111111111111111',
    sdkVersion: '1.0.0',
    createdAt: 1700000000000,
  };

  it('accepts a well-formed request', () => {
    expect(() => AttestationVerifyRequestSchema.parse(valid)).not.toThrow();
  });

  it('rejects wrong requestType', () => {
    expect(() =>
      AttestationVerifyRequestSchema.parse({ ...valid, requestType: 'other' }),
    ).toThrow();
  });
});

describe('AttestationVerifyResponseSchema', () => {
  const valid = {
    requestType: 'attestation-verify' as const,
    envelopeCid: 'bafy-env',
    verdict: 'valid' as const,
    checks: [{ name: 'quote', passed: true }],
    responder: '0x2222222222222222222222222222222222222222',
    respondedAt: 1700000000500,
  };

  it('accepts a valid verdict', () => {
    expect(() => AttestationVerifyResponseSchema.parse(valid)).not.toThrow();
  });

  it('accepts an invalid verdict with check detail', () => {
    const invalid = {
      ...valid,
      verdict: 'invalid' as const,
      checks: [{ name: 'measurement', passed: false, detail: 'mismatch' }],
    };
    expect(() => AttestationVerifyResponseSchema.parse(invalid)).not.toThrow();
  });

  it('rejects unknown verdict value', () => {
    expect(() =>
      AttestationVerifyResponseSchema.parse({ ...valid, verdict: 'maybe' }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Write `client/src/validation/types.ts`**

```typescript
/**
 * Validation Registry request/response payload schemas.
 *
 * Scope: §3.3 row "Attestation verification (V2) — Hybrid. On-chain record
 * of challenger verifications via ERC-8004 Validation Registry —
 * validationRequest from a challenger, validationResponse with their
 * off-chain-computed verdict."
 *
 * V1 ships the Validation Registry client (this module + client/src/validation/registry.ts)
 * so it's available for challenger workflows once the verification SDK lands
 * in Plan F / V2. V1 payload schema covers the attestation-verify case; future
 * request types (e.g. 'reproducible-build-verify', 'trajectory-conformance')
 * extend the union.
 */

import { z } from 'zod';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const AttestationVerifyRequestSchema = z.object({
  requestType: z.literal('attestation-verify'),
  envelopeCid: z.string().min(1),
  envelopeHash: HexStringSchema,
  challenger: HexStringSchema, // safe address
  sdkVersion: z.string().min(1),
  createdAt: z.number().int(),
});
export type AttestationVerifyRequest = z.infer<typeof AttestationVerifyRequestSchema>;

const VerifyCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});

export const AttestationVerifyResponseSchema = z.object({
  requestType: z.literal('attestation-verify'),
  envelopeCid: z.string().min(1),
  verdict: z.enum(['valid', 'invalid']),
  checks: z.array(VerifyCheckSchema),
  responder: HexStringSchema,
  respondedAt: z.number().int(),
});
export type AttestationVerifyResponse = z.infer<typeof AttestationVerifyResponseSchema>;
```

- [ ] **Step 3: Run tests + commit**

```bash
cd client
yarn vitest run test/validation/types.test.ts
git add client/src/validation/types.ts client/test/validation/types.test.ts
git commit -m "feat(validation): attestation-verify payload schemas

Request + response Zod schemas for the ERC-8004 Validation Registry
challenger-verification flow. Scope v0.9 §3.3 attestation-verification row."
```

---

## Task 7: Validation Registry client — contract calls

**Files:**
- Create: `client/src/validation/registry.ts`
- Create: `client/test/validation/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ValidationRegistry8004 } from '../../src/validation/registry.js';

describe('ValidationRegistry8004.submitValidationRequest', () => {
  it('encodes entityUri + requestUri into the contract call', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtx');
    const waitMock = vi.fn().mockResolvedValue({
      blockNumber: 500n,
      logs: [
        {
          topics: [
            // event signature hash (ValidationRequestCreated)
            '0x' + 'aa'.repeat(32),
            // indexed requestId
            '0x' + '11'.repeat(32),
          ],
        },
      ],
    });
    const registry = new ValidationRegistry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    const result = await registry.submitValidationRequest({
      envelopeCid: 'bafy-env',
      requestType: 'attestation-verify',
      requestUri: 'ipfs://bafy-request',
    });

    expect(result.txHash).toBe('0xtx');
    expect(writeMock).toHaveBeenCalledTimes(1);
    const args = writeMock.mock.calls[0]![0];
    expect(args.functionName).toBe('createValidationRequest');
    expect(args.args[0]).toBe('envelope:bafy-env');
    expect(args.args[1]).toBe('ipfs://bafy-request');
  });
});

describe('ValidationRegistry8004.submitValidationResponse', () => {
  it('calls createValidationResponse with requestId + responseUri', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtx');
    const waitMock = vi.fn().mockResolvedValue({ blockNumber: 501n });
    const registry = new ValidationRegistry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    await registry.submitValidationResponse({
      requestId: 123n,
      responseUri: 'ipfs://bafy-response',
    });

    const args = writeMock.mock.calls[0]![0];
    expect(args.functionName).toBe('createValidationResponse');
    expect(args.args[0]).toBe(123n);
    expect(args.args[1]).toBe('ipfs://bafy-response');
  });
});
```

- [ ] **Step 2: Write `client/src/validation/registry.ts`**

```typescript
/**
 * ERC-8004 Validation Registry client.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.3 — "Validation Registry hosts challenger verifications — a
 * validationRequest ('re-verify this envelope's attestation + reproducible
 * build') and validationResponse with the verdict."
 *
 * Split from the Identity Registry because the Validation Registry is a
 * *distinct* on-chain contract in ERC-8004. Same (agentURI, uri) shape for
 * calls; different contract address.
 *
 * V1 ships the client; actual challenger workflows (who calls this, when,
 * with what SDK output) are Plan F / V2.
 */

import { createPublicClient, createWalletClient, http, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface ValidationRegistryConfig {
  chainId: string;                // CAIP-2
  contractAddress: string;
  privateKey: string;
  rpcUrl?: string;
}

// Minimal Validation Registry ABI fragment — adjust against the deployed
// contract if signatures differ. ERC-8004 spec as of this writing:
//   createValidationRequest(string entityUri, string requestUri) returns (uint256)
//   createValidationResponse(uint256 requestId, string responseUri)
const VALIDATION_REGISTRY_ABI = [
  {
    name: 'createValidationRequest',
    type: 'function',
    inputs: [
      { name: 'entityUri', type: 'string' },
      { name: 'requestUri', type: 'string' },
    ],
    outputs: [{ name: 'requestId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    name: 'createValidationResponse',
    type: 'function',
    inputs: [
      { name: 'requestId', type: 'uint256' },
      { name: 'responseUri', type: 'string' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const DEFAULT_RPC_URLS: Record<string, string> = {
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:84532': 'https://sepolia.base.org',
};

function getChainId(caip2: string): number {
  const parts = caip2.split(':');
  if (parts.length !== 2 || parts[0] !== 'eip155') {
    throw new Error(`Unsupported CAIP-2 format: ${caip2}`);
  }
  return parseInt(parts[1]!, 10);
}

export class ValidationRegistry8004 {
  private readonly walletClient: ReturnType<typeof createWalletClient>;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly chain: Chain;
  private readonly contractAddress: Hex;

  constructor(config: ValidationRegistryConfig) {
    const rpcUrl = config.rpcUrl ?? DEFAULT_RPC_URLS[config.chainId];
    if (!rpcUrl) throw new Error(`No RPC URL for chain ${config.chainId}`);

    const chainId = getChainId(config.chainId);
    this.chain = {
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    } as Chain;

    const pk = (config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`) as Hex;
    this.account = privateKeyToAccount(pk);
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(rpcUrl) });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(rpcUrl),
    });
    this.contractAddress = config.contractAddress as Hex;
  }

  /**
   * Open a validation request for the given envelope.
   *
   * `requestType = 'attestation-verify'` is the V1 shape; the underlying
   * contract doesn't know about the distinction — it treats requestUri as
   * opaque. The consumer of the emitted event decodes `requestUri` (an IPFS
   * URI pointing to an `AttestationVerifyRequest` JSON blob).
   */
  async submitValidationRequest(params: {
    envelopeCid: string;
    requestType: 'attestation-verify';
    requestUri: string;
  }): Promise<{ txHash: Hex; blockNumber: bigint }> {
    const entityUri = `envelope:${params.envelopeCid}`;
    const txHash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: 'createValidationRequest',
      args: [entityUri, params.requestUri],
      account: this.account,
      chain: this.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, blockNumber: BigInt(receipt.blockNumber) };
  }

  /**
   * Post a validation response. `requestId` is the `uint256` ID returned by
   * the prior `createValidationRequest` call (read from the emitted event).
   * `responseUri` points to an IPFS-pinned `AttestationVerifyResponse` blob.
   */
  async submitValidationResponse(params: {
    requestId: bigint;
    responseUri: string;
  }): Promise<{ txHash: Hex; blockNumber: bigint }> {
    const txHash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: 'createValidationResponse',
      args: [params.requestId, params.responseUri],
      account: this.account,
      chain: this.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, blockNumber: BigInt(receipt.blockNumber) };
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
cd client
yarn vitest run test/validation/registry.test.ts
git add client/src/validation client/test/validation
git commit -m "feat(validation): ERC-8004 Validation Registry client

ValidationRegistry8004 with submitValidationRequest +
submitValidationResponse. Envelope-scoped entityUri format
(envelope:<cid>) mirrors the Identity Registry convention.
Scope v0.9 §3.3."
```

---

## Task 8: Subgraph extensions — typed queries for new entity kinds

**Files:**
- Modify: `client/src/discovery/subgraph.ts`
- Modify: `client/test/discovery/subgraph.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend `test/discovery/subgraph.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  queryIntents,
  queryEnvelopes,
  querySourceBundles,
  queryKnowledgeTree,
} from '../../src/discovery/subgraph.js';

describe('queryIntents', () => {
  it('builds a filter query for kind + creator', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { agents: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await queryIntents({ url: 'https://subgraph.test' }, {
      kind: 'portfolio.v0',
      creator: '0x1111111111111111111111111111111111111111',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('adw:Intent');
    expect(body.variables.kind).toBe('portfolio.v0');
    expect(body.variables.creator.toLowerCase()).toBe(
      '0x1111111111111111111111111111111111111111',
    );
  });
});

describe('queryEnvelopes', () => {
  it('filters by kind + role + evidenceTier + intentCid', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { agents: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await queryEnvelopes({ url: 'https://subgraph.test' }, {
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'self-signed',
      intentCid: 'bafy-intent',
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('adw:ExecutionEnvelope');
    expect(body.variables).toMatchObject({
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'self-signed',
      intentCid: 'bafy-intent',
    });
  });
});

describe('querySourceBundles', () => {
  it('filters by measurement + publishedBy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { agents: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await querySourceBundles({ url: 'https://subgraph.test' }, {
      measurement: '0x' + 'dd'.repeat(48),
      publishedBy: '0x4444444444444444444444444444444444444444',
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('adw:SourceBundle');
    expect(body.variables.measurement).toBe('0x' + 'dd'.repeat(48));
  });
});

describe('queryKnowledgeTree', () => {
  it('returns the aggregated tree for an intent CID', async () => {
    const envelopes = [
      {
        id: '1',
        agentURI: 'envelope:bafy-rest',
        owner: '0xAAA',
        metadata: [
          { key: 'documentType', value: 'adw:ExecutionEnvelope' },
          { key: 'kind', value: 'portfolio.v0' },
          { key: 'role', value: 'restoration' },
          { key: 'evidenceTier', value: 'self-signed' },
          { key: 'intentCid', value: 'bafy-intent' },
          { key: 'participant', value: '0xAAA' },
          { key: 'generatedAt', value: '1700000000000' },
        ],
      },
      {
        id: '2',
        agentURI: 'envelope:bafy-verdict',
        owner: '0xBBB',
        metadata: [
          { key: 'documentType', value: 'adw:ExecutionEnvelope' },
          { key: 'kind', value: 'portfolio.v0' },
          { key: 'role', value: 'verdict' },
          { key: 'evidenceTier', value: 'self-signed' },
          { key: 'intentCid', value: 'bafy-intent' },
          { key: 'parentEnvelopeCid', value: 'bafy-rest' },
          { key: 'participant', value: '0xBBB' },
          { key: 'generatedAt', value: '1700000000500' },
        ],
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { agents: envelopes } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const tree = await queryKnowledgeTree(
      { url: 'https://subgraph.test' },
      'bafy-intent',
    );
    expect(tree.intentCid).toBe('bafy-intent');
    expect(tree.restorations).toHaveLength(1);
    expect(tree.restorations[0]!.envelopeCid).toBe('bafy-rest');
    expect(tree.restorations[0]!.verdicts).toHaveLength(1);
    expect(tree.restorations[0]!.verdicts[0]!.envelopeCid).toBe('bafy-verdict');
  });
});
```

- [ ] **Step 2: Write the query helpers in `subgraph.ts`**

Append to `client/src/discovery/subgraph.ts`:

```typescript
// ── Typed queries — added in Plan E ─────────────────────────────────────────

export async function queryIntents(
  config: SubgraphConfig,
  filters?: {
    kind?: string;
    creator?: string;
    startTs?: number;
    endTs?: number;
    limit?: number;
  },
): Promise<SubgraphResult[]> {
  const query = `query GetIntents($first: Int, $skip: Int, $kind: String, $creator: String) {
    agents(
      first: $first, skip: $skip,
      where: {
        metadata_: { metadataKey: "documentType", metadataValue_contains: "adw:Intent" }
        ${filters?.kind ? ', kindFilter: $kind' : ''}
        ${filters?.creator ? ', owner: $creator' : ''}
      }
    ) {
      id agentURI owner
      metadata { key: metadataKey value: metadataValue }
    }
  }`;
  const data = await graphqlRequest<{ agents: SubgraphResult[] }>(config.url, query, {
    first: filters?.limit ?? 100,
    skip: 0,
    ...(filters?.kind ? { kind: filters.kind } : {}),
    ...(filters?.creator ? { creator: filters.creator.toLowerCase() } : {}),
  });
  let results = data.agents;
  if (filters?.startTs || filters?.endTs) {
    results = results.filter((r) => {
      const v = getMetadataValue(r, 'createdAt');
      if (!v) return true;
      const n = Number(v);
      if (filters.startTs && n < filters.startTs) return false;
      if (filters.endTs && n > filters.endTs) return false;
      return true;
    });
  }
  return results;
}

export async function queryEnvelopes(
  config: SubgraphConfig,
  filters?: {
    kind?: string;
    role?: 'restoration' | 'verdict';
    evidenceTier?: string;
    intentCid?: string;
    participant?: string;
    limit?: number;
  },
): Promise<SubgraphResult[]> {
  const query = `query GetEnvelopes(
    $first: Int, $skip: Int,
    $kind: String, $role: String, $evidenceTier: String,
    $intentCid: String, $participant: String
  ) {
    agents(
      first: $first, skip: $skip,
      where: { metadata_: { metadataKey: "documentType", metadataValue_contains: "adw:ExecutionEnvelope" } }
    ) {
      id agentURI owner
      metadata { key: metadataKey value: metadataValue }
    }
  }`;
  const data = await graphqlRequest<{ agents: SubgraphResult[] }>(config.url, query, {
    first: filters?.limit ?? 500,
    skip: 0,
    kind: filters?.kind,
    role: filters?.role,
    evidenceTier: filters?.evidenceTier,
    intentCid: filters?.intentCid,
    participant: filters?.participant,
  });
  // Client-side post-filter until subgraph schema (Plan G) exposes structured
  // fields directly. Plan G collapses this into on-subgraph filters.
  return data.agents.filter((r) => {
    const checks: Array<[string | undefined, string]> = [
      [filters?.kind, 'kind'],
      [filters?.role, 'role'],
      [filters?.evidenceTier, 'evidenceTier'],
      [filters?.intentCid, 'intentCid'],
    ];
    for (const [expected, key] of checks) {
      if (expected && getMetadataValue(r, key) !== expected) return false;
    }
    if (filters?.participant) {
      const got = getMetadataValue(r, 'participant');
      if (got?.toLowerCase() !== filters.participant.toLowerCase()) return false;
    }
    return true;
  });
}

export async function querySourceBundles(
  config: SubgraphConfig,
  filters?: {
    measurement?: string;
    publishedBy?: string;
    limit?: number;
  },
): Promise<SubgraphResult[]> {
  const query = `query GetSourceBundles($first: Int, $skip: Int) {
    agents(
      first: $first, skip: $skip,
      where: { metadata_: { metadataKey: "documentType", metadataValue_contains: "adw:SourceBundle" } }
    ) {
      id agentURI owner
      metadata { key: metadataKey value: metadataValue }
    }
  }`;
  const data = await graphqlRequest<{ agents: SubgraphResult[] }>(config.url, query, {
    first: filters?.limit ?? 100,
    skip: 0,
  });
  return data.agents.filter((r) => {
    if (filters?.measurement && getMetadataValue(r, 'measurement') !== filters.measurement) return false;
    if (filters?.publishedBy) {
      const got = getMetadataValue(r, 'publishedBy');
      if (got?.toLowerCase() !== filters.publishedBy.toLowerCase()) return false;
    }
    return true;
  });
}

// ── Knowledge-tree synthetic query ──────────────────────────────────────────

export interface KnowledgeTreeVerdict {
  envelopeCid: string;
  participant?: string;
  evidenceTier?: string;
  generatedAt?: number;
}

export interface KnowledgeTreeRestoration {
  envelopeCid: string;
  participant?: string;
  evidenceTier?: string;
  generatedAt?: number;
  verdicts: KnowledgeTreeVerdict[];
}

export interface KnowledgeTree {
  intentCid: string;
  restorations: KnowledgeTreeRestoration[];
}

/**
 * Fetch the knowledge tree rooted at an intent CID.
 *
 * Scope §3.3: "synthetic KnowledgeTree rooted at an intent, joining all
 * envelopes by intent.cid (restorations) or payload.restorationEnvelope.cid
 * (verdicts)."
 *
 * V1 implementation: fetches all envelopes for the intent via `queryEnvelopes`
 * and joins in-memory. Plan G materializes this into a first-class subgraph
 * entity so the join happens server-side.
 */
export async function queryKnowledgeTree(
  config: SubgraphConfig,
  intentCid: string,
): Promise<KnowledgeTree> {
  const all = await queryEnvelopes(config, { intentCid });
  const restorations = new Map<string, KnowledgeTreeRestoration>();
  const pendingVerdicts: Array<{ verdict: KnowledgeTreeVerdict; parent?: string }> = [];

  for (const entry of all) {
    const cid = entry.agentURI.replace(/^envelope:/, '');
    const role = getMetadataValue(entry, 'role');
    const participant = getMetadataValue(entry, 'participant');
    const evidenceTier = getMetadataValue(entry, 'evidenceTier');
    const generatedAtStr = getMetadataValue(entry, 'generatedAt');
    const generatedAt = generatedAtStr ? Number(generatedAtStr) : undefined;
    const parent = getMetadataValue(entry, 'parentEnvelopeCid');

    if (role === 'restoration') {
      restorations.set(cid, {
        envelopeCid: cid,
        participant,
        evidenceTier,
        generatedAt,
        verdicts: [],
      });
    } else if (role === 'verdict') {
      pendingVerdicts.push({
        verdict: { envelopeCid: cid, participant, evidenceTier, generatedAt },
        parent,
      });
    }
  }

  for (const { verdict, parent } of pendingVerdicts) {
    if (parent && restorations.has(parent)) {
      restorations.get(parent)!.verdicts.push(verdict);
    }
  }

  return { intentCid, restorations: Array.from(restorations.values()) };
}
```

- [ ] **Step 3: Run tests + commit**

```bash
cd client
yarn vitest run test/discovery/subgraph.test.ts
git add client/src/discovery/subgraph.ts client/test/discovery/subgraph.test.ts
git commit -m "feat(discovery): subgraph queries for Plan E entity kinds

queryIntents, queryEnvelopes, querySourceBundles, queryKnowledgeTree.
V1 uses client-side post-filtering because the subgraph schema
(Plan G) isn't deployed yet; Plan G collapses into server-side filters."
```

---

## Task 9: Reputation Registry — read-only aggregation helper

**Files:**
- Create: `client/src/reputation/index.ts`
- Create: `client/test/reputation/index.test.ts`
- Modify: `client/src/discovery/subgraph.ts` — add `queryOperatorValidations`

- [ ] **Step 1: Write the failing test**

Create `client/test/reputation/index.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { getOperatorReputation } from '../../src/reputation/index.js';

describe('getOperatorReputation', () => {
  it('aggregates validation responses for the operator safe address', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          agents: [
            {
              id: '1',
              agentURI: 'envelope:bafy-1',
              owner: '0x1111111111111111111111111111111111111111',
              metadata: [
                { key: 'participant', value: '0x1111111111111111111111111111111111111111' },
                { key: 'role', value: 'restoration' },
                { key: 'evidenceTier', value: 'attested' },
              ],
            },
            {
              id: '2',
              agentURI: 'envelope:bafy-2',
              owner: '0x1111111111111111111111111111111111111111',
              metadata: [
                { key: 'participant', value: '0x1111111111111111111111111111111111111111' },
                { key: 'role', value: 'restoration' },
                { key: 'evidenceTier', value: 'self-signed' },
              ],
            },
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const reputation = await getOperatorReputation(
      '0x1111111111111111111111111111111111111111',
      { subgraphUrl: 'https://subgraph.test' },
    );

    expect(reputation.attestedPercent).toBeCloseTo(50, 1);
    expect(reputation.successfulVerifications).toBeDefined();
    expect(reputation.failedVerifications).toBeDefined();
    expect(reputation.lastSignalBlock).toBeDefined();
  });

  it('returns a zero-signal shape for an unknown operator', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { agents: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const reputation = await getOperatorReputation(
      '0x9999999999999999999999999999999999999999',
      { subgraphUrl: 'https://subgraph.test' },
    );

    expect(reputation.successfulVerifications).toBe(0);
    expect(reputation.failedVerifications).toBe(0);
    expect(reputation.attestedPercent).toBe(0);
  });
});
```

- [ ] **Step 2: Add `queryOperatorValidations` to `subgraph.ts`**

```typescript
export interface OperatorValidationRow {
  envelopeCid: string;
  verdict: 'valid' | 'invalid';
  blockNumber: number;
}

/**
 * Query Validation Registry responses filed against envelopes produced by
 * the given operator Safe address. V1 implementation relies on the Plan G
 * subgraph exposing a joined view; until then this returns an empty list
 * (see "Follow-ups" below). The function shape is the stable contract.
 */
export async function queryOperatorValidations(
  _config: SubgraphConfig,
  _safeAddress: string,
): Promise<OperatorValidationRow[]> {
  // Plan G deploys the subgraph join; this stub returns [] so the reputation
  // caller still produces a shape. Tests override with vi.stubGlobal('fetch').
  return [];
}
```

- [ ] **Step 3: Write `client/src/reputation/index.ts`**

```typescript
/**
 * Read-only aggregation helpers over ERC-8004 signals.
 *
 * Scope: §3.3 "Reputation Registry aggregates operator-level signals
 * (including emergent attestation-track-record: '% of envelopes from Safe X
 * that have been challenger-verified as attested'). Reputation is emergent,
 * not hand-written."
 *
 * V1 ships no Reputation Registry writes. This module provides the read
 * surface: it projects on-chain events (validation responses) + envelope
 * metadata into per-operator metrics.
 */

import { queryEnvelopes, queryOperatorValidations } from '../discovery/subgraph.js';

export interface OperatorReputation {
  safeAddress: string;
  successfulVerifications: number;
  failedVerifications: number;
  attestedPercent: number;     // 0–100; % of envelopes with tier='attested'
  lastSignalBlock: number;     // latest block with a reputation-affecting event
}

export interface ReputationDeps {
  subgraphUrl: string;
}

export async function getOperatorReputation(
  safeAddress: string,
  deps: ReputationDeps,
): Promise<OperatorReputation> {
  const config = { url: deps.subgraphUrl };

  const [envelopes, validations] = await Promise.all([
    queryEnvelopes(config, { participant: safeAddress, limit: 1000 }),
    queryOperatorValidations(config, safeAddress),
  ]);

  const total = envelopes.length;
  const attestedCount = envelopes.filter((e) =>
    e.metadata.some((m) => m.key === 'evidenceTier' && m.value === 'attested'),
  ).length;
  const attestedPercent = total === 0 ? 0 : (attestedCount / total) * 100;

  const successfulVerifications = validations.filter((v) => v.verdict === 'valid').length;
  const failedVerifications = validations.filter((v) => v.verdict === 'invalid').length;
  const lastSignalBlock = validations.reduce((max, v) => Math.max(max, v.blockNumber), 0);

  return {
    safeAddress,
    successfulVerifications,
    failedVerifications,
    attestedPercent,
    lastSignalBlock,
  };
}
```

- [ ] **Step 4: Run tests + commit**

```bash
cd client
yarn vitest run test/reputation/index.test.ts
git add client/src/reputation client/src/discovery/subgraph.ts client/test/reputation
git commit -m "feat(reputation): read-only operator reputation surface

getOperatorReputation aggregates envelope attested-tier % + validation
responses into per-operator metrics. No writes. Scope v0.9 §3.3 —
reputation is emergent from Validation Registry events, not hand-written."
```

---

## Task 10: Wire intent posting → `registerIntent`

**Files:**
- Modify: `client/src/intents/posting-service.ts`
- Modify: `client/test/intents/posting-service.test.ts` (or equivalent)

- [ ] **Step 1: Read the current posting service to identify the post-IPFS hook**

Per Plan B, after intent submission the IntentPostingService has already uploaded a `SignedIntentV1` to IPFS and obtained a CID. Verify (grep) where that CID is currently discarded or stored, and where `registerIntent` should fire.

- [ ] **Step 2: Add a `registry?: Registry8004` dependency**

In `posting-service.ts`:

```typescript
import type { Registry8004 } from '../discovery/registry.js';

export class IntentPostingService {
  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly store: Store,
    private readonly registry?: Registry8004, // new; optional
  ) {}
```

- [ ] **Step 3: Register the intent after posting**

After the `this.adapter.postDesiredState(...)` call returns `requestId` and the IPFS CID is known (adapter records it on the `IntentPostRecord` or returns it — check the Plan B wiring), fire:

```typescript
if (this.registry && candidate.desiredState.intent?.cid && candidate.desiredState.spec?.kind) {
  try {
    await this.registry.registerIntent({
      intentCid: candidate.desiredState.intent.cid,
      kind: candidate.desiredState.spec.kind,
      creator: creatorSafeAddress === GLOBAL_CREATOR_SCOPE ? opts.creatorSafeAddress ?? '' : creatorSafeAddress,
      createdAt: nowMs,
      requestId: requestId as `0x${string}`,
    });
  } catch (err) {
    // Registration is best-effort; a failure here should not prevent the
    // intent from being posted. Log + emit but don't throw.
    console.warn(`[posting-service] registerIntent failed: ${err instanceof Error ? err.message : err}`);
    emitEvent(this.store, {
      kind: 'intent_registry_failed',
      requestId,
      specKind: candidate.desiredState.spec?.kind,
      outcome: 'warn',
      detail: err instanceof Error ? err.message : String(err),
    }, 'creator');
  }
}
```

- [ ] **Step 4: Note on IntentCid plumbing**

If `candidate.desiredState.intent?.cid` is not set at this point (because the CID is minted inside `adapter.postDesiredState`), refactor the flow so the CID is captured on the return path. Alternative: `adapter.postDesiredState` returns `{ requestId, intentCid }` (extend its return type). Pick the minimal change that doesn't leak abstraction.

- [ ] **Step 5: Extend tests**

In the posting-service tests, inject a mock `Registry8004` (just `{ registerIntent: vi.fn().mockResolvedValue(1n) }` shape) and assert:
1. `registerIntent` is called with the right args after a successful post.
2. If `registerIntent` throws, the post still succeeds (warnings are logged, no re-throw).

- [ ] **Step 6: Run tests + commit**

```bash
cd client
yarn test
git add client/src/intents/posting-service.ts client/test/intents
git commit -m "feat(intents): posting-service registers intent on ERC-8004

After successful IPFS upload + on-chain post, call registry.registerIntent
with (intentCid, kind, creator, createdAt, requestId). Best-effort: a
registration failure logs + emits but does not roll back the post."
```

---

## Task 11: Wire envelope delivery → `registerEnvelope` + `registerArtifactWithParent`

**Files:**
- Modify: `client/src/restorer/engine/engine.ts`
- Modify: `client/test/restorer/engine/engine.test.ts` or equivalent

- [ ] **Step 1: Extend `RestorationEngineOptions` with a `registry` dep**

In `engine.ts`:

```typescript
import type { Registry8004 } from '../../discovery/registry.js';

export interface RestorationEngineOptions {
  // ... existing fields ...
  /**
   * ERC-8004 Identity Registry client. When provided, the engine registers
   * the envelope (adw:ExecutionEnvelope) and each artifact (adw:Artifact with
   * parentEnvelopeCid) after successful pack().
   *
   * Optional — tests and development modes may skip registration.
   */
  registry?: Registry8004;
}
```

- [ ] **Step 2: After envelope assembly in `pack()`, register**

After the existing `registerArtifacts(uploadedArtifacts, manifestCid, this.packagingDeps)` line (which writes the artifact→manifest link in the local store), add a parallel on-chain registration block:

```typescript
// ERC-8004 Identity Registry registration (Plan E). Best-effort: failures
// emit a warning but do not fail the pack() transition — the envelope + on-chain
// claimDelivery evidenceHash remain the canonical substrate. Subgraph
// eventually-consistency handles ordering.
if (this.registry) {
  const envelopeRegistrationPromise = this.registry
    .registerEnvelope({
      envelopeCid: manifestCid, // Plan C renamed the variable in-engine but the
                                 // manifestCid local still holds the envelope CID
                                 // at this call site — rename to envelopeCid in a
                                 // follow-up mini-refactor.
      kind: intent.specKind ?? 'unknown',
      role: (intent.intentType ?? 'restoration') as 'restoration' | 'verdict',
      evidenceTier: 'self-signed',
      intentCid: intent.intentCid,
      parentEnvelopeCid: intent.intentType === 'evaluation' ? intent.parentEnvelopeCid ?? undefined : undefined,
      participant: safeAddress,
      generatedAt,
    })
    .catch((err: unknown) => {
      console.warn(
        `[restorer-engine] registerEnvelope failed for ${intent.requestId}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    });

  const artifactRegistrationPromises = uploadedArtifacts.map((art) =>
    this.registry!
      .registerArtifactWithParent({
        id: art.cid,
        title: art.artifactType ?? 'unknown',
        tags: [intent.specKind ?? 'unknown'],
        outcome: 'restored',
        endpoint: `ipfs://${art.cid}`,
        parentEnvelopeCid: manifestCid,
      })
      .catch((err: unknown) => {
        console.warn(
          `[restorer-engine] registerArtifactWithParent failed for ${art.cid}: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      }),
  );

  // Fire-and-resolve — we don't block the state transition on these,
  // but we do await them so uncaught-promise warnings don't fire.
  await Promise.all([envelopeRegistrationPromise, ...artifactRegistrationPromises]);
}
```

- [ ] **Step 3: Propagate `parentEnvelopeCid` for verdict envelopes**

Evaluator-path envelopes (role='verdict') must set `parentEnvelopeCid` to the restoration envelope CID being evaluated. This is already available inside the verdict-producing impl (Plan C). Plumb it through persistence → engine → registration. If the current schema doesn't persist the parent envelope CID for evaluation intents, add a `parentEnvelopeCid` column to `persistence.ts` (and its test) so it survives crash recovery.

- [ ] **Step 4: Tests**

In `engine.test.ts` (or a new `test/restorer/engine/engine-registry.test.ts`), add:
1. When `registry` is provided and pack succeeds → `registerEnvelope` called once, `registerArtifactWithParent` called N times (one per artifact).
2. When `registry.registerEnvelope` throws → pack() still completes (state advances to DELIVERING).
3. Verdict envelope path passes `parentEnvelopeCid` correctly.

- [ ] **Step 5: Run tests + commit**

```bash
cd client
yarn vitest run test/restorer/engine
git add client/src/restorer/engine client/test/restorer/engine
git commit -m "feat(engine): register envelope + artifacts on ERC-8004 after pack

After envelope assembly and on-chain claimDelivery, call
registry.registerEnvelope + registry.registerArtifactWithParent for each
artifact. Best-effort: registration failures log but do not fail the
pack() state transition. Scope v0.9 §3.3 envelope-registration row."
```

---

## Task 12: CLI verb — `jinn register-source-bundle`

**Files:**
- Create: `client/src/cli/commands/register-source-bundle.ts`
- Modify: `client/src/cli/index.ts` (or wherever verbs dispatch) to register the verb
- Create: `client/test/cli/register-source-bundle.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runRegisterSourceBundle } from '../../src/cli/commands/register-source-bundle.js';

describe('runRegisterSourceBundle', () => {
  it('calls Registry8004.registerSourceBundle with the parsed args', async () => {
    const registerMock = vi.fn().mockResolvedValue(42n);
    const mockRegistry = { registerSourceBundle: registerMock };

    const result = await runRegisterSourceBundle(
      {
        cid: 'bafy-src',
        measurement: '0x' + 'dd'.repeat(48),
        buildRecipeKind: 'dockerfile',
        publishedBy: '0x4444444444444444444444444444444444444444',
        humanUrl: 'https://github.com/jinn/client',
      },
      { registry: mockRegistry as any },
    );

    expect(registerMock).toHaveBeenCalledWith({
      bundleCid: 'bafy-src',
      measurement: '0x' + 'dd'.repeat(48),
      buildRecipeKind: 'dockerfile',
      publishedBy: '0x4444444444444444444444444444444444444444',
      humanUrl: 'https://github.com/jinn/client',
    });
    expect(result.registeredAtBlock).toBe(42n);
  });

  it('rejects invalid buildRecipeKind', async () => {
    const mockRegistry = { registerSourceBundle: vi.fn() };
    await expect(
      runRegisterSourceBundle(
        {
          cid: 'bafy-src',
          measurement: '0x' + 'dd'.repeat(48),
          buildRecipeKind: 'makefile' as any,
          publishedBy: '0x4444444444444444444444444444444444444444',
        },
        { registry: mockRegistry as any },
      ),
    ).rejects.toThrow(/buildRecipeKind/);
  });
});
```

- [ ] **Step 2: Write `client/src/cli/commands/register-source-bundle.ts`**

```typescript
/**
 * `jinn register-source-bundle` — one-off operator setup to register an
 * ERC-8004 adw:SourceBundle entity for a published release.
 *
 * Typically invoked after `yarn build` + an IPFS pin of the source tarball,
 * with measurement produced by the reproducible-build pipeline.
 *
 * Scope §3.1 K4: "Source bundle is a first-class ERC-8004 entity — registered
 * once per release, referenced by every envelope from that build."
 */

import { z } from 'zod';
import type { Registry8004 } from '../../discovery/registry.js';

const ArgsSchema = z.object({
  cid: z.string().min(1),
  measurement: z.string().regex(/^0x[0-9a-fA-F]+$/),
  buildRecipeKind: z.enum(['dockerfile', 'nix', 'bazel']),
  publishedBy: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  humanUrl: z.string().optional(),
});

export type RegisterSourceBundleArgs = z.infer<typeof ArgsSchema>;

export interface RegisterSourceBundleDeps {
  registry: Pick<Registry8004, 'registerSourceBundle'>;
}

export interface RegisterSourceBundleResult {
  registeredAtBlock: bigint;
  bundleCid: string;
}

export async function runRegisterSourceBundle(
  rawArgs: unknown,
  deps: RegisterSourceBundleDeps,
): Promise<RegisterSourceBundleResult> {
  const args = ArgsSchema.parse(rawArgs);
  const block = await deps.registry.registerSourceBundle({
    bundleCid: args.cid,
    measurement: args.measurement,
    buildRecipeKind: args.buildRecipeKind,
    publishedBy: args.publishedBy,
    ...(args.humanUrl ? { humanUrl: args.humanUrl } : {}),
  });
  return { registeredAtBlock: block, bundleCid: args.cid };
}
```

- [ ] **Step 3: Wire into the CLI dispatcher**

Open `client/src/cli/index.ts` (or wherever verbs are dispatched). Add a `register-source-bundle` verb:

```typescript
case 'register-source-bundle': {
  const args = parseRegisterSourceBundleArgs(argv); // minimal positional/flag parser
  const registry = await buildRegistryFromConfig(config);
  const result = await runRegisterSourceBundle(args, { registry });
  console.log(`Registered source bundle ${result.bundleCid} at block ${result.registeredAtBlock}`);
  break;
}
```

(If the CLI currently uses a library like commander/yargs, match its style rather than the raw switch above.)

- [ ] **Step 4: Run tests + commit**

```bash
cd client
yarn vitest run test/cli/register-source-bundle.test.ts
git add client/src/cli client/test/cli
git commit -m "feat(cli): jinn register-source-bundle

One-off operator setup to register adw:SourceBundle on ERC-8004 after
building + IPFS-pinning a release tarball. Scope v0.9 §3.1 K4."
```

---

## Task 13: Config + DI wiring for the new clients

**Files:**
- Modify: `client/src/config.ts`
- Modify: the main-entry file that constructs the posting service + engine (likely `client/src/main.ts` or `client/src/daemon/daemon.ts`)

- [ ] **Step 1: Add new config fields**

In `client/src/config.ts`:

```typescript
export interface JinnConfig {
  // ... existing fields ...

  /** ERC-8004 Identity Registry address on the configured chain. */
  identityRegistryAddress?: string;
  /** ERC-8004 Validation Registry address on the configured chain. */
  validationRegistryAddress?: string;
  /** Whether to enable the read-only reputation surface (query-time flag). */
  reputationEnabled?: boolean;
}
```

Both default to undefined; when unset, the corresponding client is skipped (engine + posting-service operate without registration, as they do today).

- [ ] **Step 2: Build the registry clients in the daemon entry point**

Where the daemon constructs dependencies, add:

```typescript
const registry = config.identityRegistryAddress
  ? new Registry8004({
      chainId: `eip155:${config.chainId}`,
      contractAddress: config.identityRegistryAddress,
      privateKey: agentEoaPrivateKey,
      rpcUrl: config.rpcUrl,
    })
  : undefined;

const validationRegistry = config.validationRegistryAddress
  ? new ValidationRegistry8004({
      chainId: `eip155:${config.chainId}`,
      contractAddress: config.validationRegistryAddress,
      privateKey: agentEoaPrivateKey,
      rpcUrl: config.rpcUrl,
    })
  : undefined;

const postingService = new IntentPostingService(adapter, store, registry);
const engine = new RestorationEngine({
  // ... existing opts ...
  registry,
});
```

- [ ] **Step 3: Update config tests**

Extend `client/test/config.test.ts` (or equivalent) with cases that:
1. `identityRegistryAddress` is parsed when set.
2. `validationRegistryAddress` is parsed when set.
3. Both undefined by default.

- [ ] **Step 4: Commit**

```bash
git add client/src/config.ts client/src/main.ts client/src/daemon client/test/config.test.ts
git commit -m "feat(config): wire Registry8004 + ValidationRegistry8004 DI

Optional config fields identityRegistryAddress + validationRegistryAddress
gate construction of the on-chain clients; when unset the daemon still runs
(envelope registration is a nice-to-have, not a hard requirement)."
```

---

## Task 14: End-to-end spot-check on Anvil

**Files:** None — verification only.

- [ ] **Step 1: Run the existing e2e**

```bash
cd client
yarn e2e
```

Expected: pass. The e2e script does not require a deployed 8004 registry by default — if `identityRegistryAddress` is unset in the e2e config, the registration codepaths are no-ops. Confirm that remains true after this plan.

- [ ] **Step 2: Add a minimal integration test**

Create `client/test/integration/registration-e2e.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Registry8004 } from '../../src/discovery/registry.js';
import { IntentPostingService } from '../../src/intents/posting-service.js';

describe('end-to-end: posting service registers intent', () => {
  it('produces one registerIntent call per successful post', async () => {
    // Stub Registry8004 with spyable methods
    const registerIntent = vi.fn().mockResolvedValue(1n);
    const mockRegistry = { registerIntent } as unknown as Registry8004;

    // Stub adapter + store minimally
    const adapter = { postDesiredState: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)) } as any;
    const store = {
      getIntentPostRecord: () => null,
      acquireIntentPostLock: () => true,
      releaseIntentPostLock: () => {},
      upsertIntentPostRecord: () => {},
      recordOwnActivity: () => {},
      getConfigValue: () => null,
    } as any;

    const svc = new IntentPostingService(adapter, store, mockRegistry);
    await svc.postCandidate({
      sourceKey: 'test',
      desiredState: {
        id: 'x',
        description: 'x',
        spec: { kind: 'portfolio.v0' },
        intent: { cid: 'bafy-test' } as any,
      } as any,
      postingPolicy: { kind: 'once_per_safe' },
    } as any);

    expect(registerIntent).toHaveBeenCalledTimes(1);
  });
});
```

Expected: pass.

- [ ] **Step 3: Typecheck + build**

```bash
cd client
yarn typecheck && yarn build
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add client/test/integration
git commit -m "test: e2e spot-check — posting service wires to Registry8004"
```

---

## Task 15: Re-export + index hygiene

**Files:**
- Modify: `client/src/discovery/index.ts`
- Modify: `client/src/index.ts` (top-level library exports)

- [ ] **Step 1: Export new types + classes**

From `client/src/discovery/index.ts`:

```typescript
export * from './registry.js';
export * from './subgraph.js';
export * from './metadata-schemas.js';
```

From `client/src/index.ts`:

```typescript
export * from './validation/registry.js';
export * from './validation/types.js';
export * from './reputation/index.js';
```

- [ ] **Step 2: Typecheck**

```bash
cd client
yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add client/src
git commit -m "chore(client): re-export Plan E modules from top-level index"
```

---

## Self-review before marking this plan done

- [ ] **Identity Registry coverage:** `registerIntent`, `registerEnvelope`, `registerSourceBundle`, `registerArtifactWithParent` all exist, all have unit tests, all validate their metadata via Zod before encoding.
- [ ] **Validation Registry:** `ValidationRegistry8004` client exists with `submitValidationRequest` + `submitValidationResponse`; payload schemas (`AttestationVerifyRequestSchema`, `AttestationVerifyResponseSchema`) live in `validation/types.ts`.
- [ ] **Reputation Registry:** `getOperatorReputation` returns `{safeAddress, successfulVerifications, failedVerifications, attestedPercent, lastSignalBlock}`; no writes anywhere.
- [ ] **Subgraph extensions:** `queryIntents`, `queryEnvelopes`, `querySourceBundles`, `queryKnowledgeTree`, `queryOperatorValidations` all added.
- [ ] **Engine wiring:** `RestorationEngine.pack()` calls `registry.registerEnvelope` + `registry.registerArtifactWithParent` after envelope assembly; failures log but do not abort.
- [ ] **Posting-service wiring:** `IntentPostingService.postCandidate()` calls `registry.registerIntent` after a successful post; failures log but do not abort.
- [ ] **CLI:** `jinn register-source-bundle` verb exists and validates args.
- [ ] **Config:** `identityRegistryAddress` + `validationRegistryAddress` optional config fields, daemon DI reads them.
- [ ] **Best-effort principle:** every new on-chain call path catches + logs its own errors; no Plan E write-path failure rolls back the underlying Jinn-loop state machine.
- [ ] **Tests green:** `yarn test` reports 0 failures.
- [ ] **Typecheck + build green:** `yarn typecheck && yarn build` reports 0 errors.
- [ ] **E2E green:** `yarn e2e` passes (registration no-ops when config flags unset).
- [ ] **No content-level trajectory indexing:** the plan only indexes envelope / artifact / intent / source-bundle *metadata*, per scope §3.3 non-goal.
- [ ] **No Reputation Registry writes:** verified by `grep -rn 'reputation' client/src` — only read paths exist.

---

## Follow-ups (out of scope for this plan — covered by later plans / future work)

- **Plan F — conformance suite.** Validates that operator envelopes register correctly on-chain and that subgraph queries return the expected shape. Adds a `jinn conformance check` verb that probes all Plan E entry points end-to-end.
- **Plan G — subgraph schema + deployment.** Materializes `Intent`, `ExecutionEnvelope`, `Artifact`, `SourceBundle`, and the synthetic `KnowledgeTree` as first-class GraphQL entities with proper indexes. Collapses the client-side post-filtering in `queryEnvelopes` / `querySourceBundles` into server-side `where:` clauses. Adds the Validation Registry event-indexing so `queryOperatorValidations` (stubbed here) returns real rows.
- **V2 — attestation verification SDK.** Connects the stubbed `verificationOfRestoration` produced by evaluator impls (Plan C) to a real TS SDK that checks attestation quotes. The SDK's verdict feeds the `AttestationVerifyResponse` payload posted via `ValidationRegistry8004.submitValidationResponse`.
- **V3 — on-chain quote verifier.** A DCAP + Phala Solidity verifier contract on Base that consumes the `attestation` envelope field directly — the envelope schema (Plan C) is already shaped for it.
- **D8 — gating epic.** Layers `x402` / access-control atop the already-registered envelopes without schema change (the optional `access` field on envelope + trajectory + artifact accommodates it).
- **Challenger-bot reference implementation.** A self-service challenger runbook + example script using `ValidationRegistry8004` + the V2 SDK. The Validation Registry client landed here is the protocol primitive; operator-facing challenger UX is a later concern.
- **Gas budget monitoring.** Scope §3.3 flags 5–10k gas per envelope registration; at Phase 2 scale this may need trimming. Track and revisit when mainnet volumes materialize.

---

*End of Plan E. On completion, Plans F (conformance) and G (subgraph schema) proceed in parallel; both depend on the registration surface landed here. V2 TEE work can also begin without re-opening any Plan E file — the Validation Registry client is already in place.*
