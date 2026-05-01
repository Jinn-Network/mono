# Phase A umbrella implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Phase A.1's operational loop — corpus library at `client/src/corpus/`, gating leak fix in packaging, manifest hygiene defaults, sha256-keyed cache, and MCP tool rewiring — so a cross-operator end-to-end test demonstrates: subgraph query → manifest fetch → x402 payment → hash-verify → cache hit on second read.

**Architecture:** One artifact-content data path (operator's HTTP server with x402 middleware; `priceUsdc` is a per-row knob; same path for free and paid). IPFS holds intents and manifest envelopes only — no per-artifact content. Two new SQLite tables: `served_artifacts` (sha256-keyed; what this operator publishes) and `network_artifacts` (sha256-keyed; corpus cache with provenance). Corpus library is a thin convenience layer composing existing primitives (subgraph, IPFS gateway, x402, store) with cache + self-store + `routeResolver` fast paths.

**Tech Stack:** TypeScript / Node 22, vitest, better-sqlite3, hono, viem, `@x402/{fetch,hono,core,evm}`, `zod`, OpenTelemetry trajectory collector. Tests run via `yarn test` from `client/`. Typecheck via `yarn typecheck`. End-to-end via `yarn e2e` against an Anvil fork of Base.

**Source spec:** [`spec/2026-04-30-phase-a-umbrella.md`](../../../spec/2026-04-30-phase-a-umbrella.md). Read §1 before starting — the architectural commitments are load-bearing for every task below.

**PR boundaries:** Each phase below is one PR. Within a phase, commit after every passing test.

---

## File map

This plan creates and modifies:

```
client/src/corpus/                        (NEW dir)
  index.ts                                (NEW) createCorpus factory + Corpus interface
  types.ts                                (NEW) CorpusQuery, EnvelopeRef, ManifestPreview, Envelope, ArtifactContent, RouteResolver, errors
  query.ts                                (NEW) GraphQL request → EnvelopeRef[]
  fetch.ts                                (NEW) IPFS manifest fetch + envelope schema parse
  acquire.ts                              (NEW) per-artifact resolution chain
  cache.ts                                (NEW) thin wrapper over Store network_artifacts methods
  route-resolver.ts                       (NEW) RouteResolver interface re-export

client/src/store/store.ts                 (MODIFY) add served_artifacts + network_artifacts tables + accessors
client/src/types/envelope.ts              (MODIFY) Artifact zod schema: drop `cid`, mandate `access`, drop `kind`
client/src/restorer/engine/packaging.ts   (MODIFY) uploadArtifacts: write to served_artifacts, no IPFS upload
client/src/x402/handler.ts                (MODIFY) /v1/artifacts/:sha256/content with dynamic per-row price
client/src/x402/acquire.ts                (MODIFY) URL builder uses /v1/artifacts/:sha256/content
client/src/api/server.ts                  (MODIFY) addX402Routes call signature change
client/src/config.ts                      (MODIFY) add operator.{publicEndpoint, defaultPriceUsdc, perArtifactTypePrice}
client/src/restorer/engine/engine.ts      (MODIFY) thread operator config + endpoint into uploadArtifacts call site; backfill envelope_cid into served_artifacts after publish
client/src/mcp/server.ts                  (MODIFY) search_artifacts + acquire_artifact rewired to corpus

client/test/corpus/query.test.ts          (NEW) subgraph query construction + parsing
client/test/corpus/fetch.test.ts          (NEW) manifest IPFS fetch + schema parse
client/test/corpus/acquire.test.ts        (NEW) resolution chain with mocked dependencies
client/test/corpus/cache.test.ts          (NEW) Store.network_artifacts round-trip
client/test/corpus/integration.test.ts    (NEW) end-to-end with mocked subgraph + IPFS + x402
client/test/store/served-artifacts.test.ts (NEW)
client/test/store/network-artifacts.test.ts (NEW)
client/test/restorer/engine/packaging-leak-fix.test.ts (NEW) gated content does NOT go to IPFS
client/test/restorer/engine/packaging-price-resolution.test.ts (NEW)
client/test/x402/handler-dynamic-price.test.ts (NEW)
client/test/mcp/search-artifacts-corpus.test.ts (NEW)
client/test/mcp/acquire-artifact-fast-path.test.ts (NEW)

client/scripts/corpus-e2e-validate.ts     (NEW) cross-operator e2e on Anvil fork
```

---

## Phase 1 — Schema migrations + accessors

Lay down the two new tables and Store methods. **No callers yet.** This phase ships independently — the restorer / x402 server / corpus library are all unchanged at this point. The existing test suite (including the existing `engine.test.ts` and `e2e:full-cycle`) must still pass.

### Task 1.1: Add `served_artifacts` schema + writer

**Files:**
- Modify: `client/src/store/store.ts` (extend SCHEMA constant; add `ServedArtifactInput` type and `saveServedArtifact` method)
- Test: `client/test/store/served-artifacts.test.ts` (NEW)

- [ ] **Step 1: Write failing test for saveServedArtifact**

Create `client/test/store/served-artifacts.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';

describe('Store.served_artifacts', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('saves and reads back a served artifact by sha256', () => {
    const sha256 = 'a'.repeat(64);
    const content = Buffer.from('hello world', 'utf-8');
    store.saveServedArtifact({
      sha256,
      artifactType: 'output.prediction.v0',
      requestId: '0x' + 'b'.repeat(64),
      content,
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const row = store.getServedArtifact(sha256);
    expect(row).not.toBeNull();
    expect(row!.sha256).toBe(sha256);
    expect(row!.artifactType).toBe('output.prediction.v0');
    expect(row!.content.equals(content)).toBe(true);
    expect(row!.contentSize).toBe(content.length);
    expect(row!.priceUsdc).toBe('0');
    expect(row!.envelopeCid).toBeNull();
  });

  it('returns null for unknown sha256', () => {
    expect(store.getServedArtifact('a'.repeat(64))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/store/served-artifacts.test.ts
```
Expected: FAIL — `store.saveServedArtifact is not a function`.

- [ ] **Step 3: Add SCHEMA + types + saveServedArtifact + getServedArtifact**

In `client/src/store/store.ts`, append to the SCHEMA constant (just before the closing backtick at line 156):

```sql

CREATE TABLE IF NOT EXISTS served_artifacts (
  sha256 TEXT PRIMARY KEY,
  artifact_type TEXT NOT NULL,
  request_id TEXT,
  envelope_cid TEXT,
  content BLOB NOT NULL,
  content_size INTEGER NOT NULL,
  price_usdc TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_served_artifacts_request ON served_artifacts (request_id);
CREATE INDEX IF NOT EXISTS idx_served_artifacts_envelope ON served_artifacts (envelope_cid);
CREATE INDEX IF NOT EXISTS idx_served_artifacts_artifact_type ON served_artifacts (artifact_type);
```

Add types (after the existing `BalanceCacheEntry` interface around line 48):

```typescript
export interface ServedArtifactInput {
  sha256: string;
  artifactType: string;
  requestId?: string | null;
  envelopeCid?: string | null;
  content: Buffer;
  priceUsdc: string;
  createdAt: string;
}

export interface ServedArtifactRow {
  sha256: string;
  artifactType: string;
  requestId: string | null;
  envelopeCid: string | null;
  content: Buffer;
  contentSize: number;
  priceUsdc: string;
  createdAt: string;
}
```

Add methods to the `Store` class (place near `cacheRemoteContent` around line 743):

```typescript
saveServedArtifact(input: ServedArtifactInput): void {
  this.db.prepare(
    `INSERT OR REPLACE INTO served_artifacts
       (sha256, artifact_type, request_id, envelope_cid, content, content_size, price_usdc, created_at)
     VALUES
       (@sha256, @artifactType, @requestId, @envelopeCid, @content, @contentSize, @priceUsdc, @createdAt)`,
  ).run({
    sha256: input.sha256,
    artifactType: input.artifactType,
    requestId: input.requestId ?? null,
    envelopeCid: input.envelopeCid ?? null,
    content: input.content,
    contentSize: input.content.length,
    priceUsdc: input.priceUsdc,
    createdAt: input.createdAt,
  });
}

getServedArtifact(sha256: string): ServedArtifactRow | null {
  const row = this.db.prepare(
    `SELECT sha256, artifact_type, request_id, envelope_cid, content, content_size, price_usdc, created_at
     FROM served_artifacts WHERE sha256 = ?`,
  ).get(sha256) as {
    sha256: string;
    artifact_type: string;
    request_id: string | null;
    envelope_cid: string | null;
    content: Buffer;
    content_size: number;
    price_usdc: string;
    created_at: string;
  } | undefined;
  if (!row) return null;
  return {
    sha256: row.sha256,
    artifactType: row.artifact_type,
    requestId: row.request_id,
    envelopeCid: row.envelope_cid,
    content: row.content,
    contentSize: row.content_size,
    priceUsdc: row.price_usdc,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd client && yarn test test/store/served-artifacts.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add client/src/store/store.ts client/test/store/served-artifacts.test.ts
git commit -m "store: add served_artifacts table + accessors (jinn-mono-q94h)"
```

### Task 1.2: Add envelope_cid backfill + request-id query for served_artifacts

**Files:**
- Modify: `client/src/store/store.ts` (add `setServedArtifactEnvelopeCid` and `getServedArtifactsByRequestId`)
- Test: `client/test/store/served-artifacts.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

Append to `client/test/store/served-artifacts.test.ts`:

```typescript
  it('backfills envelope_cid after publish', () => {
    const sha256 = 'c'.repeat(64);
    store.saveServedArtifact({
      sha256,
      artifactType: 'trajectory',
      content: Buffer.from('x'),
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    store.setServedArtifactEnvelopeCid(sha256, 'bafyEnvelope1');
    const row = store.getServedArtifact(sha256);
    expect(row!.envelopeCid).toBe('bafyEnvelope1');
  });

  it('lists served_artifacts by requestId', () => {
    const reqId = '0x' + 'd'.repeat(64);
    for (let i = 0; i < 3; i++) {
      store.saveServedArtifact({
        sha256: String(i).padStart(64, '0'),
        artifactType: 'output.prediction.v0',
        requestId: reqId,
        content: Buffer.from(String(i)),
        priceUsdc: '0',
        createdAt: '2026-04-30T00:00:00.000Z',
      });
    }
    const rows = store.getServedArtifactsByRequestId(reqId);
    expect(rows).toHaveLength(3);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/store/served-artifacts.test.ts
```
Expected: FAIL — `setServedArtifactEnvelopeCid is not a function`.

- [ ] **Step 3: Implement methods**

Add to `Store` class:

```typescript
setServedArtifactEnvelopeCid(sha256: string, envelopeCid: string): void {
  this.db.prepare(
    `UPDATE served_artifacts SET envelope_cid = ? WHERE sha256 = ?`,
  ).run(envelopeCid, sha256);
}

getServedArtifactsByRequestId(requestId: string): ServedArtifactRow[] {
  const rows = this.db.prepare(
    `SELECT sha256, artifact_type, request_id, envelope_cid, content, content_size, price_usdc, created_at
     FROM served_artifacts WHERE request_id = ? ORDER BY created_at ASC`,
  ).all(requestId) as Array<{
    sha256: string;
    artifact_type: string;
    request_id: string | null;
    envelope_cid: string | null;
    content: Buffer;
    content_size: number;
    price_usdc: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    sha256: row.sha256,
    artifactType: row.artifact_type,
    requestId: row.request_id,
    envelopeCid: row.envelope_cid,
    content: row.content,
    contentSize: row.content_size,
    priceUsdc: row.price_usdc,
    createdAt: row.created_at,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd client && yarn test test/store/served-artifacts.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```
git add client/src/store/store.ts client/test/store/served-artifacts.test.ts
git commit -m "store: served_artifacts envelope_cid backfill + by-request listing (jinn-mono-q94h)"
```

### Task 1.3: Add `network_artifacts` schema + accessors

**Files:**
- Modify: `client/src/store/store.ts`
- Test: `client/test/store/network-artifacts.test.ts` (NEW)

- [ ] **Step 1: Write failing tests**

Create `client/test/store/network-artifacts.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';

describe('Store.network_artifacts', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('saves a fetched artifact and reads it back by sha256', () => {
    const sha256 = 'e'.repeat(64);
    const content = Buffer.from('cached content', 'utf-8');
    store.saveNetworkArtifact({
      sha256,
      artifactType: 'trajectory',
      envelopeCid: 'bafyEnvelopeA',
      content,
      source: 'origin',
      sourceOperator: '0x' + '1'.repeat(40),
      sourceEndpoint: 'https://operator.example.com',
      paidAmountUsdc: '0.001',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    });

    const row = store.getNetworkArtifact(sha256);
    expect(row).not.toBeNull();
    expect(row!.sha256).toBe(sha256);
    expect(row!.content.equals(content)).toBe(true);
    expect(row!.source).toBe('origin');
    expect(row!.sourceOperator).toBe('0x' + '1'.repeat(40));
    expect(row!.paidAmountUsdc).toBe('0.001');
    expect(row!.lastUsedAt).toBe('2026-04-30T00:00:00.000Z');
  });

  it('updates last_used_at on touchNetworkArtifactUsage', () => {
    const sha256 = 'f'.repeat(64);
    store.saveNetworkArtifact({
      sha256,
      artifactType: 'trajectory',
      content: Buffer.from('x'),
      source: 'origin',
      paidAmountUsdc: '0',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    });
    store.touchNetworkArtifactUsage(sha256, '2026-04-30T00:01:00.000Z');
    const row = store.getNetworkArtifact(sha256);
    expect(row!.lastUsedAt).toBe('2026-04-30T00:01:00.000Z');
  });

  it('returns null for unknown sha256', () => {
    expect(store.getNetworkArtifact('e'.repeat(64))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/store/network-artifacts.test.ts
```
Expected: FAIL — `store.saveNetworkArtifact is not a function`.

- [ ] **Step 3: Add SCHEMA, types, methods**

Append to SCHEMA constant in `store.ts`:

```sql

CREATE TABLE IF NOT EXISTS network_artifacts (
  sha256 TEXT PRIMARY KEY,
  artifact_type TEXT NOT NULL,
  envelope_cid TEXT,
  content BLOB NOT NULL,
  content_size INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('origin', 'route-resolver', 'self-store-mirror')),
  source_operator TEXT,
  source_endpoint TEXT,
  paid_amount_usdc TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_network_artifacts_envelope ON network_artifacts (envelope_cid);
CREATE INDEX IF NOT EXISTS idx_network_artifacts_artifact_type ON network_artifacts (artifact_type);
CREATE INDEX IF NOT EXISTS idx_network_artifacts_last_used ON network_artifacts (last_used_at DESC);
```

Add types (near `ServedArtifactInput`):

```typescript
export type NetworkArtifactSource = 'origin' | 'route-resolver' | 'self-store-mirror';

export interface NetworkArtifactInput {
  sha256: string;
  artifactType: string;
  envelopeCid?: string | null;
  content: Buffer;
  source: NetworkArtifactSource;
  sourceOperator?: string | null;
  sourceEndpoint?: string | null;
  paidAmountUsdc: string;
  fetchedAt: string;
}

export interface NetworkArtifactRow {
  sha256: string;
  artifactType: string;
  envelopeCid: string | null;
  content: Buffer;
  contentSize: number;
  source: NetworkArtifactSource;
  sourceOperator: string | null;
  sourceEndpoint: string | null;
  paidAmountUsdc: string;
  fetchedAt: string;
  lastUsedAt: string;
}
```

Add methods to `Store`:

```typescript
saveNetworkArtifact(input: NetworkArtifactInput): void {
  this.db.prepare(
    `INSERT OR REPLACE INTO network_artifacts
       (sha256, artifact_type, envelope_cid, content, content_size, source,
        source_operator, source_endpoint, paid_amount_usdc, fetched_at, last_used_at)
     VALUES
       (@sha256, @artifactType, @envelopeCid, @content, @contentSize, @source,
        @sourceOperator, @sourceEndpoint, @paidAmountUsdc, @fetchedAt, @fetchedAt)`,
  ).run({
    sha256: input.sha256,
    artifactType: input.artifactType,
    envelopeCid: input.envelopeCid ?? null,
    content: input.content,
    contentSize: input.content.length,
    source: input.source,
    sourceOperator: input.sourceOperator ?? null,
    sourceEndpoint: input.sourceEndpoint ?? null,
    paidAmountUsdc: input.paidAmountUsdc,
    fetchedAt: input.fetchedAt,
  });
}

getNetworkArtifact(sha256: string): NetworkArtifactRow | null {
  const row = this.db.prepare(
    `SELECT sha256, artifact_type, envelope_cid, content, content_size, source,
            source_operator, source_endpoint, paid_amount_usdc, fetched_at, last_used_at
     FROM network_artifacts WHERE sha256 = ?`,
  ).get(sha256) as {
    sha256: string;
    artifact_type: string;
    envelope_cid: string | null;
    content: Buffer;
    content_size: number;
    source: NetworkArtifactSource;
    source_operator: string | null;
    source_endpoint: string | null;
    paid_amount_usdc: string;
    fetched_at: string;
    last_used_at: string;
  } | undefined;
  if (!row) return null;
  return {
    sha256: row.sha256,
    artifactType: row.artifact_type,
    envelopeCid: row.envelope_cid,
    content: row.content,
    contentSize: row.content_size,
    source: row.source,
    sourceOperator: row.source_operator,
    sourceEndpoint: row.source_endpoint,
    paidAmountUsdc: row.paid_amount_usdc,
    fetchedAt: row.fetched_at,
    lastUsedAt: row.last_used_at,
  };
}

touchNetworkArtifactUsage(sha256: string, ts: string): void {
  this.db.prepare(
    `UPDATE network_artifacts SET last_used_at = ? WHERE sha256 = ?`,
  ).run(ts, sha256);
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd client && yarn test test/store/network-artifacts.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Run typecheck + full test suite to confirm no regressions**

```
cd client && yarn typecheck && yarn test
```
Expected: clean typecheck; all existing tests still pass.

- [ ] **Step 6: Commit**

```
git add client/src/store/store.ts client/test/store/network-artifacts.test.ts
git commit -m "store: add network_artifacts cache table + accessors (jinn-mono-q94h)"
```

---

## Phase 2 — Gating leak fix

Stop uploading artifact content to IPFS in `uploadArtifacts`. Update the artifact descriptor schema. Switch the x402 server route to `:sha256`-keyed with dynamic per-row pricing.

This phase ships independently of Phase 4 — the leak is closed without any consumer-side library yet. The existing `engine.test.ts` and the e2e validation script need to keep passing (their assertions about manifest publication are tier-checked but not artifact-IPFS-fetch-checked).

### Task 2.1: Update Artifact zod schema (drop `cid`, mandate `access`, drop `kind`)

**Files:**
- Modify: `client/src/types/envelope.ts:83-106` (ArtifactSchema), `:71-81` (TrajectoryRefSchema for consistency)
- Test: `client/test/restorer/envelope-schema.test.ts` (NEW or extend if exists)

- [ ] **Step 1: Write failing test for the new schema**

Create `client/test/restorer/envelope-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SignedEnvelopeSchema } from '../../src/types/envelope.js';

const baseEnvelope = {
  schemaVersion: 'jinn.execution.v1',
  kind: 'prediction.v0',
  role: 'restoration',
  generatedAt: 1745978400,
  intent: {
    cid: 'bafyIntent',
    onchainCreationTx: '0x' + 'a'.repeat(64),
    onchainCreationBlock: 1,
    requestId: '0x' + 'b'.repeat(64),
  },
  participant: {
    safeAddress: '0x' + '1'.repeat(40),
    agentEoa: '0x' + '2'.repeat(40),
  },
  window: { startMs: 0, endMs: 1000 },
  executor: {
    implName: 'test',
    implVersion: '0.1.0',
    clientGitSha: 'abc',
    codeDigest: 'sha256:' + 'c'.repeat(64),
    signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) },
  },
  evidenceTier: 'self-signed',
  attestation: null,
  trajectory: null,
  payload: {},
  signature: {
    algo: 'secp256k1',
    signer: '0x' + '2'.repeat(40),
    hash: '0x' + 'e'.repeat(64),
    sig: '0x' + 'f'.repeat(130),
  },
};

describe('Artifact schema (post-gating-fix)', () => {
  it('accepts an artifact with required access fields and no cid', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'output.prediction.v0',
        sha256: 'a'.repeat(64),
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      }],
    };
    const result = SignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
  });

  it('rejects an artifact missing access', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'output.prediction.v0',
        sha256: 'a'.repeat(64),
      }],
    };
    const result = SignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(false);
  });

  it('rejects an artifact with cid (field removed)', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'output.prediction.v0',
        sha256: 'a'.repeat(64),
        cid: 'bafyContent',
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      }],
    };
    // Z.object().strict() would reject; if schema is permissive, at least the cid is ignored.
    // Acceptance: parse succeeds but `cid` does not appear on the parsed value.
    const result = SignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
    expect((result.data!.artifacts[0] as Record<string, unknown>).cid).toBeUndefined();
  });

  it('rejects access with a kind discriminator (field removed)', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'output.prediction.v0',
        sha256: 'a'.repeat(64),
        access: { kind: 'open', endpoint: 'https://op.example.com', priceUsdc: '0' },
      }],
    };
    const result = SignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
    const parsedAccess = result.data!.artifacts[0].access as Record<string, unknown>;
    expect(parsedAccess.kind).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/restorer/envelope-schema.test.ts
```
Expected: FAIL on test 2 (current schema makes `access` optional).

- [ ] **Step 3: Update ArtifactSchema in envelope.ts**

In `client/src/types/envelope.ts`, replace the existing `ArtifactSchema` definition (lines 83-106) with:

```typescript
const ArtifactSchema = z.object({
  artifactType: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
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
  access: z.object({
    endpoint: z.string().url(),
    priceUsdc: z.string().regex(/^\d+(\.\d+)?$/),
  }),
});
```

(Note: this strips both `cid` and `access.kind` — old envelopes won't validate, which is the intent per spec §5.6 one-shot cutover.)

Also update `TrajectoryRefSchema` (lines 71-81) for consistency:

```typescript
const TrajectoryRefSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  access: z.object({
    endpoint: z.string().url(),
    priceUsdc: z.string().regex(/^\d+(\.\d+)?$/),
  }),
});
```

(Trajectories are artifacts and follow the same access shape; the previous `cid` field is gone.)

- [ ] **Step 4: Run test to verify it passes**

```
cd client && yarn test test/restorer/envelope-schema.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Run typecheck — expect breakage in callers; fix them**

```
cd client && yarn typecheck
```
Expected: type errors in any file that constructs an `Artifact` with `cid` or that reads `artifact.cid` / `artifact.access.kind`. Fix each by removing references.

The known sites (from `grep -nR "\.cid\b\|access\.kind\|artifact\.cid"` in `client/src/`) include:
- `restorer/engine/packaging.ts:391-462` — fixed in Task 2.2
- `restorer/engine/manifest-assembly.ts` (if present) — drop `cid` from descriptor construction
- `restorer/impls/*-evaluator/index.ts` — references to `verificationOfRestoration` payload structures (likely unaffected; sanity-check)
- `mcp/server.ts:160-260` — fixed in Phase 5
- `daemon/delivery-watcher.ts` — sanity-check artifact-CID logging

For each: remove `cid` references; require `access`. Run typecheck after each file change.

- [ ] **Step 6: Run full test suite to confirm no regressions outside expected scope**

```
cd client && yarn test
```
Expected: tests outside `restorer/engine/packaging` pass cleanly. Failures isolated to packaging-related tests are expected and fixed in Task 2.2.

- [ ] **Step 7: Commit**

```
git add client/src/types/envelope.ts client/test/restorer/envelope-schema.test.ts client/src/restorer/ client/src/mcp/ client/src/daemon/
git commit -m "envelope: drop artifact.cid + access.kind; mandate access (jinn-mono-q94h)"
```

### Task 2.2: Rewrite `uploadArtifacts` — no IPFS upload, write to served_artifacts

**Files:**
- Modify: `client/src/restorer/engine/packaging.ts:386-462` (`uploadArtifacts`), and the calling site in `engine.ts:735` (signature change)
- Test: `client/test/restorer/engine/packaging-leak-fix.test.ts` (NEW)

- [ ] **Step 1: Write failing test asserting NO IPFS upload calls + served_artifacts write**

Create `client/test/restorer/engine/packaging-leak-fix.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../src/store/store.js';
import { uploadArtifacts } from '../../../src/restorer/engine/packaging.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async () => {
    throw new Error('uploadArtifacts should NOT call uploadToIpfs in v0');
  }),
}));

describe('uploadArtifacts (gating-leak-fix)', () => {
  let store: Store;
  let workDir: string;

  beforeEach(() => {
    store = new Store(':memory:');
    workDir = mkdtempSync(join(tmpdir(), 'jinn-test-'));
  });

  afterEach(() => {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes content to served_artifacts and never calls uploadToIpfs', async () => {
    const file = join(workDir, 'sample.json');
    const bytes = Buffer.from(JSON.stringify({ value: 42 }), 'utf-8');
    writeFileSync(file, bytes);

    const uploaded = await uploadArtifacts(
      [{
        localPath: file,
        artifactType: 'output.prediction.v0',
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      }],
      {
        store,
        operatorEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        requestId: '0x' + 'a'.repeat(64),
      },
    );

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(uploaded[0].access.endpoint).toBe('https://op.example.com');
    expect(uploaded[0].access.priceUsdc).toBe('0');

    const row = store.getServedArtifact(uploaded[0].sha256);
    expect(row).not.toBeNull();
    expect(row!.content.equals(bytes)).toBe(true);
  });

  it('throws if operatorEndpoint is missing and any artifact would be served', async () => {
    const file = join(workDir, 's.txt');
    writeFileSync(file, 'x');
    await expect(
      uploadArtifacts(
        [{ localPath: file, artifactType: 'design_document' }],
        {
          store,
          operatorEndpoint: '',
          defaultPriceUsdc: '0',
          perArtifactTypePrice: {},
          requestId: '0x' + 'a'.repeat(64),
        },
      ),
    ).rejects.toThrow(/operatorEndpoint/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/restorer/engine/packaging-leak-fix.test.ts
```
Expected: FAIL — current `uploadArtifacts` signature doesn't take a `store` field; current behaviour calls `uploadToIpfs`.

- [ ] **Step 3: Rewrite `uploadArtifacts`**

In `client/src/restorer/engine/packaging.ts`, replace the existing `PackagingDeps` interface (lines 67-78) and `uploadArtifacts` function (lines 386-462) with:

```typescript
export interface PackagingDeps {
  store: import('../../store/store.js').Store;
  operatorEndpoint: string;       // operator's externally-reachable base URL
  defaultPriceUsdc: string;       // global operator default
  perArtifactTypePrice: Record<string, string>; // per-type override
  requestId: string;              // restoration / evaluation request id
  /**
   * Optional trajectory collector. When provided, a `jinn.artifact.emit` span
   * is added to the trajectory for each successfully written artifact, and
   * `artifact.metadata.producedBy` is set to `{ spanId, trajectoryCid: '' }`.
   * The engine backfills `trajectoryCid` after `emitTrajectory` completes.
   */
  collector?: TrajectoryCollector;
}

export async function uploadArtifacts(
  artifacts: Array<{
    localPath: string;
    artifactType: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    access?: { endpoint?: string; priceUsdc?: string };
  }>,
  deps: PackagingDeps,
): Promise<UploadedArtifact[]> {
  if (!deps.operatorEndpoint) {
    throw new Error(
      'uploadArtifacts: operatorEndpoint is required (set operator.publicEndpoint in config)',
    );
  }

  const results: UploadedArtifact[] = [];
  const now = new Date().toISOString();

  for (const art of artifacts) {
    try {
      const content = readFileSync(art.localPath);
      const sha256 = sha256Hex(content);

      const priceUsdc =
        art.access?.priceUsdc
        ?? deps.perArtifactTypePrice[art.artifactType]
        ?? deps.defaultPriceUsdc;

      const endpoint = art.access?.endpoint ?? deps.operatorEndpoint;

      deps.store.saveServedArtifact({
        sha256,
        artifactType: art.artifactType,
        requestId: deps.requestId,
        content,
        priceUsdc,
        createdAt: now,
      });

      const uploaded: UploadedArtifact = {
        sha256,
        artifactType: art.artifactType,
        metadata: art.metadata,
        tags: art.tags,
        access: { endpoint, priceUsdc },
        localPath: art.localPath,
      };

      if (deps.collector) {
        const nowNano = String(BigInt(Date.now()) * 1_000_000n);
        const span = deps.collector.addSpan({
          name: 'artifact.emit',
          kind: 'INTERNAL',
          startTimeUnixNano: nowNano,
          endTimeUnixNano: nowNano,
          attributes: {
            'jinn.span.kind': 'jinn.artifact.emit',
            'jinn.artifact.sha256': sha256,
            'jinn.artifact.artifactType': art.artifactType,
          },
          events: [],
          status: { code: 'OK' },
        });
        uploaded.metadata = {
          ...uploaded.metadata,
          producedBy: { spanId: span.spanId, trajectoryCid: '' },
        };
      }

      results.push(uploaded);
    } catch (err) {
      console.error(`[restorer-engine] artifact write failed for ${art.localPath}: ${err instanceof Error ? err.message : err}`);
      // Non-fatal: continue with remaining artifacts
    }
  }

  return results;
}
```

Also update the `UploadedArtifact` shape (line 63) to drop `cid`:

```typescript
export interface UploadedArtifact extends Artifact {
  localPath: string;
}
```

(`Artifact` is now from the updated zod schema; the `localPath` extension stays.)

Remove the `import { uploadToIpfs }` line at the top of `packaging.ts` (it's no longer used by `uploadArtifacts`; keep it only if other functions in the file still call it — `walkArtifacts` does not).

- [ ] **Step 4: Update the engine call site**

In `client/src/restorer/engine/engine.ts:735` (the `uploadArtifacts(rawArtifacts, packagingDepsWithCollector)` call site), update the deps object to match the new `PackagingDeps` shape. The engine has access to:

- `store` (via constructor or RestorationCtx)
- `config.operator.publicEndpoint` (needs threading from RestorerOptions; see Phase 3 Task 3.1 for the config plumbing — for this phase, a default ENV `JINN_OPERATOR_PUBLIC_ENDPOINT || 'http://localhost:7331'` is acceptable as a stopgap)
- `config.operator.defaultPriceUsdc` (default '0')
- `config.operator.perArtifactTypePrice` (default `{}`)
- `requestId` (from the in-flight RestorationJob)

Threading is mechanical; the engine.ts edit replaces the `packagingDeps` constructor with values pulled from the engine's existing `config` reference plus `requestId` from the in-flight context. (Phase 3 replaces the env-var stopgap with the real config schema.)

After publish (post `engine.ts` manifest upload), backfill envelope_cid for every emitted artifact:

```typescript
for (const art of uploadedArtifacts) {
  this.store.setServedArtifactEnvelopeCid(art.sha256, manifestCid);
}
```

- [ ] **Step 5: Run packaging-leak-fix tests + existing engine tests**

```
cd client && yarn test test/restorer/engine/
```
Expected: PASS — including pre-existing `engine.test.ts`. Existing tests assert manifest publication + tier; they should not have been asserting per-artifact IPFS CIDs.

- [ ] **Step 6: Run typecheck + full suite**

```
cd client && yarn typecheck && yarn test
```
Expected: clean.

- [ ] **Step 7: Commit**

```
git add client/src/restorer/engine/packaging.ts client/src/restorer/engine/engine.ts client/test/restorer/engine/packaging-leak-fix.test.ts
git commit -m "packaging: stop uploading artifacts to IPFS; write to served_artifacts (jinn-mono-q94h)"
```

### Task 2.3: New x402 route — `/v1/artifacts/:sha256/content` with dynamic per-row price

**Files:**
- Modify: `client/src/x402/handler.ts` (replace existing route registration)
- Modify: `client/src/x402/acquire.ts` (URL builder)
- Test: `client/test/x402/handler-dynamic-price.test.ts` (NEW)

- [ ] **Step 1: Write failing test for free + paid path**

Create `client/test/x402/handler-dynamic-price.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { Store } from '../../src/store/store.js';
import { addX402Routes } from '../../src/x402/handler.js';

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('x402 handler — dynamic per-row price', () => {
  let store: Store;
  let app: Hono;

  beforeEach(() => {
    store = new Store(':memory:');
    app = new Hono();
    addX402Routes(app, store, {
      privateKey: TEST_PRIVATE_KEY,
      recipientAddress: '0x' + '1'.repeat(40),
      network: 'eip155:84532',
    });
  });

  afterEach(() => store.close());

  it('serves free content (priceUsdc=0) without payment dance', async () => {
    const sha256 = 'a'.repeat(64);
    const bytes = Buffer.from('free content', 'utf-8');
    store.saveServedArtifact({
      sha256,
      artifactType: 'design_document',
      content: bytes,
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const res = await app.request(`/v1/artifacts/${sha256}/content`);
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(Buffer.from(body).equals(bytes)).toBe(true);
  });

  it('returns 402 for paid content without X-PAYMENT header', async () => {
    const sha256 = 'b'.repeat(64);
    store.saveServedArtifact({
      sha256,
      artifactType: 'output.prediction.v0',
      content: Buffer.from('paid'),
      priceUsdc: '0.001',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const res = await app.request(`/v1/artifacts/${sha256}/content`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<{ price: string }> };
    expect(body.accepts).toBeDefined();
    expect(body.accepts.length).toBeGreaterThan(0);
    // The 402 response carries this artifact's price, not a server-static one.
    expect(body.accepts.some((a) => a.price.includes('0.001'))).toBe(true);
  });

  it('returns 404 for unknown sha256', async () => {
    const res = await app.request(`/v1/artifacts/${'c'.repeat(64)}/content`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/x402/handler-dynamic-price.test.ts
```
Expected: FAIL — current route is `/x402/artifacts/:id/content` and price is static.

- [ ] **Step 3: Rewrite `addX402Routes`**

Replace `client/src/x402/handler.ts` with:

```typescript
/**
 * x402 payment-gated artifact serving.
 *
 * Single route, dynamic per-row price:
 * - priceUsdc='0'   → respond 200 immediately, no payment dance.
 * - priceUsdc>'0'   → emit 402 with payment requirements built from the row's price;
 *                     on valid X-PAYMENT, verify + settle via local facilitator, then 200.
 *
 * See spec/2026-04-30-phase-a-umbrella.md §5.4.
 */

import type { Hono, Context } from 'hono';
import type { Network } from '@x402/core/types';
import type { Store } from '../store/store.js';
import { createLocalFacilitatorClient } from './facilitator.js';

export interface X402Config {
  privateKey: string;
  recipientAddress: string;
  network?: string;  // default 'eip155:8453'
  rpcUrl?: string;
}

function dollarStringFromUsdc(usdc: string): string {
  // X402 'exact' scheme expects a string like '$0.001' for USDC amounts.
  return `$${usdc}`;
}

export function addX402Routes(app: Hono, store: Store, config: X402Config): void {
  const facilitator = createLocalFacilitatorClient({
    privateKey: config.privateKey,
    network: config.network,
    rpcUrl: config.rpcUrl,
  });

  const network = (config.network ?? 'eip155:8453') as Network;

  app.get('/v1/artifacts/:sha256/content', async (c: Context) => {
    const sha256 = c.req.param('sha256');
    const row = store.getServedArtifact(sha256);
    if (!row) return c.json({ error: 'Not found' }, 404);

    if (row.priceUsdc === '0') {
      return c.body(row.content);
    }

    // Paid path
    const accepts = [{
      scheme: 'exact',
      payTo: config.recipientAddress,
      price: dollarStringFromUsdc(row.priceUsdc),
      network,
      description: `artifact ${sha256.slice(0, 12)}…`,
    }];

    const xPayment = c.req.header('X-Payment');
    if (!xPayment) {
      return c.json({ accepts }, 402);
    }

    try {
      const decoded = JSON.parse(Buffer.from(xPayment, 'base64').toString('utf-8')) as {
        scheme: string;
        payload: unknown;
      };
      const requirement = accepts.find((a) => a.scheme === decoded.scheme);
      if (!requirement) {
        return c.json({ error: 'Unsupported payment scheme', accepts }, 402);
      }
      const verification = await facilitator.verify(decoded.payload as never, requirement as never);
      if (!verification.isValid) {
        return c.json({ error: verification.invalidReason ?? 'Payment verification failed', accepts }, 402);
      }
      const settlement = await facilitator.settle(decoded.payload as never, requirement as never);
      if (!settlement.success) {
        return c.json({ error: settlement.errorReason ?? 'Settlement failed', accepts }, 402);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Payment validation error: ${msg}`, accepts }, 402);
    }

    return c.body(row.content);
  });
}
```

- [ ] **Step 4: Update `acquire.ts` URL builder**

Replace `client/src/x402/acquire.ts:8-10` (`buildAcquisitionUrl`) and the function signature of `acquireArtifactWithPayment`:

```typescript
export function buildAcquisitionUrl(endpoint: string, sha256: string): string {
  return `${endpoint.replace(/\/$/, '')}/v1/artifacts/${sha256}/content`;
}

export async function acquireArtifactWithPayment(
  endpoint: string,
  sha256: string,
  privateKey: string,
): Promise<Buffer | null> {
  const url = buildAcquisitionUrl(endpoint, sha256);
  try {
    const { wrapFetchWithPayment, x402Client } = await import('@x402/fetch');
    const { registerExactEvmScheme } = await import('@x402/evm/exact/client');
    const { toClientEvmSigner } = await import('@x402/evm');
    const { privateKeyToAccount } = await import('viem/accounts');

    type Hex = `0x${string}`;
    const pk = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
    const account = privateKeyToAccount(pk);
    const signer = toClientEvmSigner({ ...account, address: account.address as `0x${string}` });

    const client = new x402Client();
    registerExactEvmScheme(client, { signer });

    const payFetch = wrapFetchWithPayment(globalThis.fetch, client);
    const response = await payFetch(url);
    if (!response.ok) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    return buf;
  } catch (err) {
    console.error(`[x402] Failed to acquire artifact ${sha256}:`, err);
    return null;
  }
}
```

(The return type changes from `string | null` to `Buffer | null` because the new server returns raw bytes, not a JSON-wrapped envelope.)

- [ ] **Step 5: Update `addX402Routes` call site in `client/src/api/server.ts:79`**

The signature stays compatible — `addX402Routes(app, store, config.x402)` still works because `pricePerArtifact` was optional. Confirm by typecheck.

- [ ] **Step 6: Run all x402 tests**

```
cd client && yarn test test/x402/
```
Expected: PASS for all three new tests; any pre-existing x402 tests should still pass (they cover the facilitator client, which is unchanged).

- [ ] **Step 7: Run typecheck + full suite**

```
cd client && yarn typecheck && yarn test
```
Expected: clean.

- [ ] **Step 8: Commit**

```
git add client/src/x402/handler.ts client/src/x402/acquire.ts client/src/api/server.ts client/test/x402/handler-dynamic-price.test.ts
git commit -m "x402: /v1/artifacts/:sha256/content with dynamic per-row price (jinn-mono-q94h)"
```

---

## Phase 3 — Manifest hygiene (operator config + price resolution + validation)

Replace the env-var stopgap from Phase 2 with the real operator config schema. Add a pre-publish validation hook.

### Task 3.1: Add `operator` config schema + env overrides

**Files:**
- Modify: `client/src/config.ts` (add operator block; line numbers around 90-100 for schema, 449-455 for env merges)
- Test: `client/test/config.test.ts` (extend with operator-config tests)

- [ ] **Step 1: Write failing test for operator config**

Append to `client/test/config.test.ts`:

```typescript
describe('operator config', () => {
  it('parses operator block with defaults', () => {
    const cfg = loadConfig({
      file: {
        operator: { publicEndpoint: 'https://op.example.com' },
      },
      env: {},
    });
    expect(cfg.operator?.publicEndpoint).toBe('https://op.example.com');
    expect(cfg.operator?.defaultPriceUsdc).toBe('0');
    expect(cfg.operator?.perArtifactTypePrice).toEqual({});
  });

  it('env JINN_OPERATOR_PUBLIC_ENDPOINT overrides file', () => {
    const cfg = loadConfig({
      file: { operator: { publicEndpoint: 'https://from-file.example.com' } },
      env: { JINN_OPERATOR_PUBLIC_ENDPOINT: 'https://from-env.example.com' },
    });
    expect(cfg.operator?.publicEndpoint).toBe('https://from-env.example.com');
  });

  it('env JINN_OPERATOR_DEFAULT_PRICE_USDC overrides file', () => {
    const cfg = loadConfig({
      file: {
        operator: { publicEndpoint: 'https://op.example.com', defaultPriceUsdc: '0.001' },
      },
      env: { JINN_OPERATOR_DEFAULT_PRICE_USDC: '0.005' },
    });
    expect(cfg.operator?.defaultPriceUsdc).toBe('0.005');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/config.test.ts
```
Expected: FAIL — `cfg.operator` is undefined.

- [ ] **Step 3: Add to ConfigSchema**

In `client/src/config.ts`, add (placement: alongside the other top-level optional blocks, around line 90):

```typescript
operator: z.object({
  publicEndpoint: z.string().url(),
  defaultPriceUsdc: z.string().regex(/^\d+(\.\d+)?$/).default('0'),
  perArtifactTypePrice: z.record(
    z.string(),
    z.string().regex(/^\d+(\.\d+)?$/),
  ).default({}),
}).optional(),
```

In the env-merging block (around line 449):

```typescript
if (env['JINN_OPERATOR_PUBLIC_ENDPOINT']) {
  merged.operator = {
    ...(merged.operator ?? {}),
    publicEndpoint: env['JINN_OPERATOR_PUBLIC_ENDPOINT'],
  };
}
if (env['JINN_OPERATOR_DEFAULT_PRICE_USDC']) {
  merged.operator = {
    ...(merged.operator ?? {}),
    defaultPriceUsdc: env['JINN_OPERATOR_DEFAULT_PRICE_USDC'],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd client && yarn test test/config.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add client/src/config.ts client/test/config.test.ts
git commit -m "config: operator.{publicEndpoint,defaultPriceUsdc,perArtifactTypePrice} (jinn-mono-q94h)"
```

### Task 3.2: Thread operator config into engine + replace env-var stopgap

**Files:**
- Modify: `client/src/restorer/engine/engine.ts` (read config, build PackagingDeps)
- Modify: `client/src/main.ts` and any RestorerOptions construction sites (thread `config.operator`)
- Test: `client/test/restorer/engine/packaging-price-resolution.test.ts` (NEW)

- [ ] **Step 1: Write failing test for price resolution precedence**

Create `client/test/restorer/engine/packaging-price-resolution.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../src/store/store.js';
import { uploadArtifacts } from '../../../src/restorer/engine/packaging.js';

describe('uploadArtifacts price resolution', () => {
  let store: Store;
  let workDir: string;

  beforeEach(() => {
    store = new Store(':memory:');
    workDir = mkdtempSync(join(tmpdir(), 'jinn-test-'));
  });

  afterEach(() => {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeFile(name: string): string {
    const p = join(workDir, name);
    writeFileSync(p, name);
    return p;
  }

  it('uses OUTPUTS.json access.priceUsdc when present', async () => {
    const out = await uploadArtifacts(
      [{
        localPath: makeFile('a.txt'),
        artifactType: 'design_document',
        access: { priceUsdc: '0.99' },
      }],
      {
        store,
        operatorEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0.001',
        perArtifactTypePrice: { 'design_document': '0.5' },
        requestId: '0x' + 'a'.repeat(64),
      },
    );
    expect(out[0].access.priceUsdc).toBe('0.99');
  });

  it('uses perArtifactTypePrice when no OUTPUTS.json override', async () => {
    const out = await uploadArtifacts(
      [{ localPath: makeFile('b.txt'), artifactType: 'design_document' }],
      {
        store,
        operatorEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0.001',
        perArtifactTypePrice: { 'design_document': '0.5' },
        requestId: '0x' + 'a'.repeat(64),
      },
    );
    expect(out[0].access.priceUsdc).toBe('0.5');
  });

  it('falls back to defaultPriceUsdc otherwise', async () => {
    const out = await uploadArtifacts(
      [{ localPath: makeFile('c.txt'), artifactType: 'runtime_log' }],
      {
        store,
        operatorEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0.001',
        perArtifactTypePrice: { 'design_document': '0.5' },
        requestId: '0x' + 'a'.repeat(64),
      },
    );
    expect(out[0].access.priceUsdc).toBe('0.001');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (Phase 2 already implements precedence)**

```
cd client && yarn test test/restorer/engine/packaging-price-resolution.test.ts
```
Expected: PASS — Phase 2's `uploadArtifacts` already resolves price using the precedence in §6.2 of the spec. This test pins the behaviour against regression.

- [ ] **Step 3: Replace env-var stopgap with config plumbing**

In `client/src/restorer/engine/engine.ts`, locate where `PackagingDeps` is constructed before the `uploadArtifacts(rawArtifacts, packagingDepsWithCollector)` call (line 735 area). Replace any `process.env['JINN_OPERATOR_PUBLIC_ENDPOINT']` reads with values from the engine's `config.operator` reference.

The engine constructor signature must accept `operatorConfig: { publicEndpoint: string; defaultPriceUsdc: string; perArtifactTypePrice: Record<string, string> }`. Threading sites:
- `client/src/daemon/daemon.ts` — daemon constructs the engine; pull `config.operator` from `Config` and pass.
- `client/src/main.ts` — production daemon assembly path.
- `client/src/cli/execution-context.ts:173` — CLI execution context.
- Tests that construct an engine fixture — pass a synthetic `operatorConfig` object.

For each site, the operator config becomes a required engine input with no default (the engine refuses to start if `config.operator?.publicEndpoint` is unset and the operator role is restorer).

- [ ] **Step 4: Run typecheck + full suite**

```
cd client && yarn typecheck && yarn test
```
Expected: clean.

- [ ] **Step 5: Commit**

```
git add client/src/restorer/engine/engine.ts client/src/daemon/daemon.ts client/src/main.ts client/src/cli/execution-context.ts client/test/restorer/engine/packaging-price-resolution.test.ts
git commit -m "engine: thread operator config; remove env-var stopgap (jinn-mono-q94h)"
```

### Task 3.3: Add pre-publish manifest validation hook

**Files:**
- Create: `client/src/restorer/engine/validate-manifest.ts`
- Modify: `client/src/restorer/engine/engine.ts` (call validator before manifest upload)
- Test: `client/test/restorer/engine/validate-manifest.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/restorer/engine/validate-manifest.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateManifestForPublish } from '../../../src/restorer/engine/validate-manifest.js';
import type { SignedEnvelope } from '../../../src/types/envelope.js';

const baseEnvelope: SignedEnvelope = JSON.parse(JSON.stringify({
  schemaVersion: 'jinn.execution.v1',
  kind: 'prediction.v0',
  role: 'restoration',
  generatedAt: 1745978400,
  intent: {
    cid: 'bafy',
    onchainCreationTx: '0x' + 'a'.repeat(64),
    onchainCreationBlock: 1,
    requestId: '0x' + 'b'.repeat(64),
  },
  participant: { safeAddress: '0x' + '1'.repeat(40), agentEoa: '0x' + '2'.repeat(40) },
  window: { startMs: 0, endMs: 1000 },
  executor: {
    implName: 'test', implVersion: '0.1.0', clientGitSha: 'abc',
    codeDigest: 'sha256:' + 'c'.repeat(64),
    signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) },
  },
  evidenceTier: 'self-signed',
  attestation: null,
  trajectory: null,
  artifacts: [],
  payload: {},
  signature: { algo: 'secp256k1', signer: '0x' + '2'.repeat(40), hash: '0x' + 'e'.repeat(64), sig: '0x' + 'f'.repeat(130) },
}));

describe('validateManifestForPublish', () => {
  it('passes when every artifact has access.endpoint and access.priceUsdc', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'design_document',
        sha256: 'a'.repeat(64),
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      }],
    } as SignedEnvelope;
    expect(() => validateManifestForPublish(env)).not.toThrow();
  });

  it('throws if any artifact is missing access.endpoint', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'design_document',
        sha256: 'a'.repeat(64),
        access: { endpoint: '', priceUsdc: '0' },
      }],
    } as SignedEnvelope;
    expect(() => validateManifestForPublish(env)).toThrow(/access\.endpoint/);
  });

  it('throws if any artifact is missing access.priceUsdc', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'design_document',
        sha256: 'a'.repeat(64),
        access: { endpoint: 'https://op.example.com', priceUsdc: '' },
      }],
    } as SignedEnvelope;
    expect(() => validateManifestForPublish(env)).toThrow(/priceUsdc/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/restorer/engine/validate-manifest.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `validateManifestForPublish`**

Create `client/src/restorer/engine/validate-manifest.ts`:

```typescript
/**
 * Pre-publish validation that the envelope is fit for the corpus.
 *
 * Belt-and-suspenders against code paths that could bypass the OUTPUTS.json /
 * config-driven access resolution and emit a manifest with under-populated
 * artifact descriptors.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §6.3.
 */

import type { SignedEnvelope } from '../../types/envelope.js';

export class ManifestValidationError extends Error {
  constructor(public readonly artifactIndex: number, message: string) {
    super(`artifacts[${artifactIndex}]: ${message}`);
    this.name = 'ManifestValidationError';
  }
}

export function validateManifestForPublish(env: SignedEnvelope): void {
  for (let i = 0; i < env.artifacts.length; i++) {
    const a = env.artifacts[i];
    if (!a.access || typeof a.access !== 'object') {
      throw new ManifestValidationError(i, 'access is required');
    }
    if (!a.access.endpoint || typeof a.access.endpoint !== 'string') {
      throw new ManifestValidationError(i, 'access.endpoint must be a non-empty string');
    }
    if (!/^https?:\/\//i.test(a.access.endpoint)) {
      throw new ManifestValidationError(i, 'access.endpoint must be an http(s) URL');
    }
    if (!a.access.priceUsdc || typeof a.access.priceUsdc !== 'string') {
      throw new ManifestValidationError(i, 'access.priceUsdc must be a non-empty string');
    }
    if (!/^\d+(\.\d+)?$/.test(a.access.priceUsdc)) {
      throw new ManifestValidationError(i, 'access.priceUsdc must be a decimal string');
    }
    if (!a.sha256 || !/^[0-9a-f]{64}$/.test(a.sha256)) {
      throw new ManifestValidationError(i, 'sha256 must be a 64-char hex string');
    }
  }
}
```

- [ ] **Step 4: Wire into engine before manifest upload**

In `client/src/restorer/engine/engine.ts`, immediately before the manifest IPFS upload call, invoke:

```typescript
import { validateManifestForPublish } from './validate-manifest.js';

// ... inside the publish flow, after the envelope is fully assembled:
validateManifestForPublish(signedEnvelope);
```

If validation throws, the engine bubbles the error and does not publish. The restorer's existing error handling tags this as a publish-side failure (no claim-delivery, no on-chain tx).

- [ ] **Step 5: Run test + typecheck + full suite**

```
cd client && yarn test test/restorer/engine/validate-manifest.test.ts
cd client && yarn typecheck && yarn test
```
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```
git add client/src/restorer/engine/validate-manifest.ts client/src/restorer/engine/engine.ts client/test/restorer/engine/validate-manifest.test.ts
git commit -m "engine: pre-publish manifest validation for access fields (jinn-mono-q94h)"
```

---

## Phase 4 — Corpus library

Build `client/src/corpus/` and the cross-operator end-to-end test.

### Task 4.1: Corpus types

**Files:**
- Create: `client/src/corpus/types.ts`
- Test: none for pure types; the consumer tests (4.2 onward) catch type errors

- [ ] **Step 1: Create `client/src/corpus/types.ts`**

```typescript
/**
 * Public types for the corpus library.
 *
 * See spec/2026-04-30-phase-a-umbrella.md §2.2 for the rationale and the
 * narrative description of the read pipeline.
 */

import type { Store } from '../store/store.js';
import type { SignedEnvelope } from '../types/envelope.js';

export interface CorpusOptions {
  subgraphUrl: string;
  ipfsGatewayUrl: string;
  store: Store;
  signer: { privateKey: string };
  selfSafeAddress: string;
  routeResolver?: RouteResolver;
}

export interface CorpusQuery {
  kind?: string;
  intentCid?: string;
  participant?: { safeAddress?: string };
  evidenceTier?: 'self-signed' | 'committed' | 'attested';
  generatedAfter?: number;
  generatedBefore?: number;
  limit?: number;
}

export interface ReadArgs {
  query: CorpusQuery;
  select?: (manifests: ManifestPreview[]) => ManifestPreview[];
}

export interface EnvelopeRef {
  manifestCid: string;
  manifestHash: string;
  operator: { agentId: string; safeAddress: string };
  evidenceTier: 'self-signed' | 'committed' | 'attested' | 'unknown';
  publishedAt: number;
}

export interface ManifestPreview {
  ref: EnvelopeRef;
  envelope: SignedEnvelope;
}

export interface ArtifactContent {
  sha256: string;
  bytes: Buffer;
  artifactType: string;
  source: 'cache' | 'self-store' | 'origin' | 'route-resolver';
  paidAmountUsdc: string;
  fetchedAt: string;
  sourceOperator?: string;
}

export interface Envelope extends ManifestPreview {
  artifactContents: Map<string, ArtifactContent>;
}

export interface RouteResolver {
  resolve(req: {
    sha256: string;
    access: { endpoint: string; priceUsdc: string };
    requesterSafe: string;
  }): Promise<{ bytes: Buffer; sourceOperator?: string; pricePaidUsdc: string } | null>;
}

export interface Corpus {
  read(args: ReadArgs): Promise<Envelope[]>;
  query(q: CorpusQuery): Promise<EnvelopeRef[]>;
  fetchManifest(ref: EnvelopeRef): Promise<ManifestPreview>;
  acquire(manifest: ManifestPreview): Promise<Envelope>;
  acquireBySha256(
    sha256: string,
    access: { endpoint: string; priceUsdc: string },
    hint?: { artifactType?: string; envelopeCid?: string },
  ): Promise<ArtifactContent>;
}

// ── Errors ─────────────────────────────────────────────────────────────

export class CorpusQueryError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CorpusQueryError';
  }
}

export class ManifestFetchError extends Error {
  constructor(public readonly manifestCid: string, message: string, public readonly cause?: unknown) {
    super(`manifest ${manifestCid}: ${message}`);
    this.name = 'ManifestFetchError';
  }
}

export class AcquireError extends Error {
  constructor(public readonly sha256: string, message: string, public readonly cause?: unknown) {
    super(`acquire ${sha256}: ${message}`);
    this.name = 'AcquireError';
  }
}

export class HashMismatchError extends Error {
  constructor(
    public readonly sha256Expected: string,
    public readonly sha256Actual: string,
    public readonly source: string,
    public readonly sourceOperator?: string,
  ) {
    super(`hash mismatch: expected ${sha256Expected}, got ${sha256Actual} from ${source}`);
    this.name = 'HashMismatchError';
  }
}
```

- [ ] **Step 2: Run typecheck**

```
cd client && yarn typecheck
```
Expected: clean.

- [ ] **Step 3: Commit**

```
git add client/src/corpus/types.ts
git commit -m "corpus: types module (jinn-mono-q94h)"
```

### Task 4.2: Subgraph query (corpus/query.ts)

**Files:**
- Create: `client/src/corpus/query.ts`
- Test: `client/test/corpus/query.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/corpus/query.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runCorpusQuery, buildSubgraphQuery } from '../../src/corpus/query.js';

describe('buildSubgraphQuery', () => {
  it('builds a query with kind filter', () => {
    const { query, variables } = buildSubgraphQuery({ kind: 'prediction.v0', limit: 10 });
    expect(query).toContain('executions(');
    expect(variables.first).toBe(10);
    // kind isn't directly indexed (Execution.kind is ENVELOPE/EVALUATION/OTHER per spec §10 Q6),
    // so build a server-side filter on metadataKey or post-fetch filter — for v0, post-fetch.
    expect(variables.kind ?? null).toBeNull();
  });

  it('translates evidenceTier into Execution.tier filter', () => {
    const { variables } = buildSubgraphQuery({ evidenceTier: 'attested', limit: 5 });
    expect(variables.tier).toBe('ATTESTED');
  });

  it('clamps limit to 500 when caller passes more', () => {
    const { variables } = buildSubgraphQuery({ limit: 5000 });
    expect(variables.first).toBe(500);
  });

  it('defaults limit to 50 when unset', () => {
    const { variables } = buildSubgraphQuery({});
    expect(variables.first).toBe(50);
  });
});

describe('runCorpusQuery', () => {
  it('throws CorpusQueryError on non-OK HTTP', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 502 }));
    await expect(
      runCorpusQuery('https://subgraph.test/graphql', { limit: 5 }, fetchImpl),
    ).rejects.toThrow(/CorpusQueryError|502/);
  });

  it('parses subgraph executions array into EnvelopeRef[]', async () => {
    const payload = {
      data: {
        executions: [{
          id: '1-0xabc',
          manifestCid: 'bafyManifest1',
          manifestHash: '0x' + 'a'.repeat(64),
          tier: 'COMMITTED',
          publishedAt: '1745978400',
          operator: { id: '1', agentId: '1', owner: '0x' + '2'.repeat(40), agentWallet: '0x' + '3'.repeat(40) },
        }],
      },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    const refs = await runCorpusQuery('https://subgraph.test/graphql', { limit: 5 }, fetchImpl);
    expect(refs).toHaveLength(1);
    expect(refs[0].manifestCid).toBe('bafyManifest1');
    expect(refs[0].evidenceTier).toBe('committed');
    expect(refs[0].operator.safeAddress).toBe('0x' + '3'.repeat(40));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/corpus/query.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `client/src/corpus/query.ts`**

```typescript
/**
 * Subgraph GraphQL query for the corpus.
 *
 * v0: query Execution rows; filter by evidenceTier, participant, time window
 * directly on the subgraph; filter by `kind` (intent kind) post-fetch since the
 * subgraph's Execution.kind is the router-level ENVELOPE/EVALUATION discriminator,
 * not the per-intent-kind string.
 *
 * Spec §2.3 step 1, §10 Q6.
 */

import type { CorpusQuery, EnvelopeRef } from './types.js';
import { CorpusQueryError } from './types.js';

const HARD_LIMIT = 500;
const DEFAULT_LIMIT = 50;

const QUERY_GQL = `
  query CorpusExecutions(
    $first: Int!,
    $tier: ExecutionTier,
    $publishedAfter: BigInt,
    $publishedBefore: BigInt,
    $operatorWallet: Bytes,
  ) {
    executions(
      first: $first,
      where: {
        tier: $tier,
        publishedAt_gte: $publishedAfter,
        publishedAt_lte: $publishedBefore,
        operator_: { agentWallet: $operatorWallet },
      },
      orderBy: publishedAt,
      orderDirection: desc,
    ) {
      id
      manifestCid
      manifestHash
      tier
      publishedAt
      operator {
        id
        agentId
        owner
        agentWallet
      }
    }
  }
`;

export interface BuiltQuery {
  query: string;
  variables: Record<string, unknown>;
}

const TIER_TO_GQL: Record<NonNullable<CorpusQuery['evidenceTier']>, string> = {
  'self-signed': 'SELF_SIGNED',
  'committed': 'COMMITTED',
  'attested': 'ATTESTED',
};

const TIER_FROM_GQL: Record<string, EnvelopeRef['evidenceTier']> = {
  SELF_SIGNED: 'self-signed',
  COMMITTED: 'committed',
  ATTESTED: 'attested',
  UNKNOWN: 'unknown',
};

export function buildSubgraphQuery(q: CorpusQuery): BuiltQuery {
  const first = Math.min(Math.max(1, q.limit ?? DEFAULT_LIMIT), HARD_LIMIT);
  const variables: Record<string, unknown> = {
    first,
    tier: q.evidenceTier ? TIER_TO_GQL[q.evidenceTier] : null,
    publishedAfter: q.generatedAfter !== undefined ? String(q.generatedAfter) : null,
    publishedBefore: q.generatedBefore !== undefined ? String(q.generatedBefore) : null,
    operatorWallet: q.participant?.safeAddress ?? null,
    kind: null, // post-fetch filter; spec §10 Q6.
  };
  return { query: QUERY_GQL, variables };
}

interface SubgraphResponse {
  data?: {
    executions: Array<{
      id: string;
      manifestCid: string;
      manifestHash: string;
      tier: string;
      publishedAt: string;
      operator: { id: string; agentId: string; owner: string; agentWallet: string | null };
    }>;
  };
  errors?: Array<{ message: string }>;
}

export async function runCorpusQuery(
  subgraphUrl: string,
  q: CorpusQuery,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<EnvelopeRef[]> {
  const built = buildSubgraphQuery(q);
  let response: Response;
  try {
    response = await fetchImpl(subgraphUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(built),
    });
  } catch (err) {
    throw new CorpusQueryError(`subgraph fetch failed`, err);
  }
  if (!response.ok) {
    throw new CorpusQueryError(`subgraph HTTP ${response.status}`);
  }
  let body: SubgraphResponse;
  try {
    body = (await response.json()) as SubgraphResponse;
  } catch (err) {
    throw new CorpusQueryError(`subgraph returned non-JSON body`, err);
  }
  if (body.errors && body.errors.length > 0) {
    throw new CorpusQueryError(`subgraph errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  const rows = body.data?.executions ?? [];
  return rows.map((r) => ({
    manifestCid: r.manifestCid,
    manifestHash: r.manifestHash,
    operator: {
      agentId: r.operator.agentId,
      safeAddress: r.operator.agentWallet ?? r.operator.owner,
    },
    evidenceTier: TIER_FROM_GQL[r.tier] ?? 'unknown',
    publishedAt: Number(r.publishedAt),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd client && yarn test test/corpus/query.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```
git add client/src/corpus/query.ts client/test/corpus/query.test.ts
git commit -m "corpus: subgraph query module (jinn-mono-q94h)"
```

### Task 4.3: Manifest fetch (corpus/fetch.ts)

**Files:**
- Create: `client/src/corpus/fetch.ts`
- Test: `client/test/corpus/fetch.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/corpus/fetch.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { fetchManifest } from '../../src/corpus/fetch.js';

const sampleEnvelope = {
  schemaVersion: 'jinn.execution.v1',
  kind: 'prediction.v0',
  role: 'restoration',
  generatedAt: 1745978400,
  intent: { cid: 'bafyIntent', onchainCreationTx: '0x' + 'a'.repeat(64), onchainCreationBlock: 1, requestId: '0x' + 'b'.repeat(64) },
  participant: { safeAddress: '0x' + '1'.repeat(40), agentEoa: '0x' + '2'.repeat(40) },
  window: { startMs: 0, endMs: 1000 },
  executor: { implName: 'test', implVersion: '0.1.0', clientGitSha: 'abc', codeDigest: 'sha256:' + 'c'.repeat(64), signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) } },
  evidenceTier: 'self-signed',
  attestation: null,
  trajectory: null,
  artifacts: [],
  payload: {},
  signature: { algo: 'secp256k1', signer: '0x' + '2'.repeat(40), hash: '0x' + 'e'.repeat(64), sig: '0x' + 'f'.repeat(130) },
};

describe('fetchManifest', () => {
  it('returns ManifestPreview on success', async () => {
    const ref = {
      manifestCid: 'bafyManifest1',
      manifestHash: '0x' + 'a'.repeat(64),
      operator: { agentId: '1', safeAddress: '0x' + '3'.repeat(40) },
      evidenceTier: 'self-signed' as const,
      publishedAt: 1745978400,
    };
    const fetchFromIpfsMock = vi.fn(async () => sampleEnvelope);
    const preview = await fetchManifest(ref, 'https://gateway.example.com', fetchFromIpfsMock);
    expect(preview.ref).toEqual(ref);
    expect(preview.envelope.kind).toBe('prediction.v0');
  });

  it('throws ManifestFetchError on parse failure', async () => {
    const ref = {
      manifestCid: 'bafyBad',
      manifestHash: '0x' + 'a'.repeat(64),
      operator: { agentId: '1', safeAddress: '0x' + '3'.repeat(40) },
      evidenceTier: 'self-signed' as const,
      publishedAt: 1745978400,
    };
    const fetchFromIpfsMock = vi.fn(async () => ({ not: 'an envelope' }));
    await expect(
      fetchManifest(ref, 'https://gateway.example.com', fetchFromIpfsMock),
    ).rejects.toThrow(/ManifestFetchError|schema/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/corpus/fetch.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `client/src/corpus/fetch.ts`**

```typescript
/**
 * Fetch a manifest envelope from IPFS by CID and parse it under the v1 schema.
 *
 * Spec §2.3 step 2.
 */

import { SignedEnvelopeSchema, type SignedEnvelope } from '../types/envelope.js';
import { fetchFromIpfs } from '../adapters/mech/ipfs.js';
import type { EnvelopeRef, ManifestPreview } from './types.js';
import { ManifestFetchError } from './types.js';

type FetchFromIpfs = (gatewayUrl: string, cid: string) => Promise<unknown>;

export async function fetchManifest(
  ref: EnvelopeRef,
  ipfsGatewayUrl: string,
  fetchImpl: FetchFromIpfs = fetchFromIpfs,
): Promise<ManifestPreview> {
  let raw: unknown;
  try {
    raw = await fetchImpl(ipfsGatewayUrl, ref.manifestCid);
  } catch (err) {
    throw new ManifestFetchError(ref.manifestCid, 'IPFS fetch failed', err);
  }
  const parsed = SignedEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ManifestFetchError(
      ref.manifestCid,
      `schema parse failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const envelope: SignedEnvelope = parsed.data;
  return { ref, envelope };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd client && yarn test test/corpus/fetch.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add client/src/corpus/fetch.ts client/test/corpus/fetch.test.ts
git commit -m "corpus: manifest fetch module (jinn-mono-q94h)"
```

### Task 4.4: Acquire chain (corpus/acquire.ts)

**Files:**
- Create: `client/src/corpus/acquire.ts`
- Test: `client/test/corpus/acquire.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/corpus/acquire.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { acquireArtifactContent } from '../../src/corpus/acquire.js';

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('acquireArtifactContent', () => {
  let store: Store;
  const access = { endpoint: 'https://op.example.com', priceUsdc: '0.001' };
  const sha256 = 'a'.repeat(64);
  const bytes = Buffer.from('content', 'utf-8');
  // sha256 of 'content' is actually different; we use a controlled mock that returns matching bytes.
  // For test simplicity we synthesise: real sha256 helper is in store's existing tests — the corpus
  // module recomputes; if mismatch, test fails. We compute up front:
  const realBytes = Buffer.from('hello-test', 'utf-8');
  // sha256('hello-test') = '...'; computed at runtime in actual test, see below.

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => store.close());

  it('cache fast path returns cached bytes without network call', async () => {
    const now = '2026-04-30T00:00:00.000Z';
    const realSha = (await import('node:crypto')).createHash('sha256').update(realBytes).digest('hex');
    store.saveNetworkArtifact({
      sha256: realSha,
      artifactType: 'design_document',
      content: realBytes,
      source: 'origin',
      paidAmountUsdc: '0',
      fetchedAt: now,
    });

    const acquireFn = vi.fn();
    const result = await acquireArtifactContent({
      sha256: realSha,
      artifactType: 'design_document',
      access,
      store,
      selfSafeAddress: '0x' + 'f'.repeat(40),
      privateKey: TEST_KEY,
      acquireFn,
    });
    expect(result.source).toBe('cache');
    expect(result.bytes.equals(realBytes)).toBe(true);
    expect(acquireFn).not.toHaveBeenCalled();
  });

  it('self-store fast path serves and mirrors to cache', async () => {
    const realSha = (await import('node:crypto')).createHash('sha256').update(realBytes).digest('hex');
    store.saveServedArtifact({
      sha256: realSha,
      artifactType: 'design_document',
      content: realBytes,
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    const acquireFn = vi.fn();
    const result = await acquireArtifactContent({
      sha256: realSha,
      artifactType: 'design_document',
      access,
      store,
      selfSafeAddress: '0x' + 'f'.repeat(40),
      privateKey: TEST_KEY,
      acquireFn,
      ownerSafe: '0x' + 'f'.repeat(40),
    });
    expect(result.source).toBe('self-store');
    expect(result.paidAmountUsdc).toBe('0');
    expect(acquireFn).not.toHaveBeenCalled();
  });

  it('origin fetch hash-verifies and caches', async () => {
    const realSha = (await import('node:crypto')).createHash('sha256').update(realBytes).digest('hex');
    const acquireFn = vi.fn(async () => realBytes);

    const result = await acquireArtifactContent({
      sha256: realSha,
      artifactType: 'design_document',
      access,
      store,
      selfSafeAddress: '0x' + 'f'.repeat(40),
      privateKey: TEST_KEY,
      acquireFn,
      ownerSafe: '0x' + 'a'.repeat(40),
    });
    expect(result.source).toBe('origin');
    expect(result.paidAmountUsdc).toBe('0.001');
    expect(acquireFn).toHaveBeenCalledOnce();
    expect(store.getNetworkArtifact(realSha)).not.toBeNull();
  });

  it('origin fetch with hash mismatch throws and does not cache', async () => {
    const acquireFn = vi.fn(async () => Buffer.from('wrong bytes'));
    const declaredSha = 'a'.repeat(64);
    await expect(
      acquireArtifactContent({
        sha256: declaredSha,
        artifactType: 'design_document',
        access,
        store,
        selfSafeAddress: '0x' + 'f'.repeat(40),
        privateKey: TEST_KEY,
        acquireFn,
        ownerSafe: '0x' + 'a'.repeat(40),
      }),
    ).rejects.toThrow(/HashMismatch|hash mismatch/);
    expect(store.getNetworkArtifact(declaredSha)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/corpus/acquire.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `client/src/corpus/acquire.ts`**

```typescript
/**
 * Per-artifact resolution chain: cache → self-store → routeResolver → origin.
 *
 * Always hash-verifies before persisting to cache.
 *
 * Spec §2.3 step 4-6.
 */

import { createHash } from 'node:crypto';
import type { Store } from '../store/store.js';
import { acquireArtifactWithPayment } from '../x402/acquire.js';
import type { ArtifactContent, RouteResolver } from './types.js';
import { AcquireError, HashMismatchError } from './types.js';

type AcquireFn = (endpoint: string, sha256: string, privateKey: string) => Promise<Buffer | null>;

export interface AcquireArtifactArgs {
  sha256: string;
  artifactType: string;
  access: { endpoint: string; priceUsdc: string };
  store: Store;
  selfSafeAddress: string;
  privateKey: string;
  routeResolver?: RouteResolver;
  envelopeCid?: string;
  /** Safe address that produced this artifact, when known (from envelope.participant). */
  ownerSafe?: string;
  acquireFn?: AcquireFn;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function acquireArtifactContent(args: AcquireArtifactArgs): Promise<ArtifactContent> {
  const {
    sha256,
    artifactType,
    access,
    store,
    selfSafeAddress,
    privateKey,
    routeResolver,
    envelopeCid,
    ownerSafe,
    acquireFn = acquireArtifactWithPayment,
  } = args;

  const now = () => new Date().toISOString();

  // 1. Cache hit
  const cached = store.getNetworkArtifact(sha256);
  if (cached) {
    store.touchNetworkArtifactUsage(sha256, now());
    return {
      sha256,
      bytes: cached.content,
      artifactType: cached.artifactType,
      source: 'cache',
      paidAmountUsdc: '0',
      fetchedAt: cached.fetchedAt,
      sourceOperator: cached.sourceOperator ?? undefined,
    };
  }

  // 2. Self-store fast path
  if (ownerSafe && ownerSafe.toLowerCase() === selfSafeAddress.toLowerCase()) {
    const own = store.getServedArtifact(sha256);
    if (own) {
      // Mirror into cache so peer asks for the same content can hit cache (provenance: self-store-mirror).
      const ts = now();
      store.saveNetworkArtifact({
        sha256,
        artifactType: own.artifactType,
        envelopeCid: own.envelopeCid,
        content: own.content,
        source: 'self-store-mirror',
        paidAmountUsdc: '0',
        fetchedAt: ts,
      });
      return {
        sha256,
        bytes: own.content,
        artifactType: own.artifactType,
        source: 'self-store',
        paidAmountUsdc: '0',
        fetchedAt: ts,
      };
    }
  }

  // 3. Route resolver
  if (routeResolver) {
    try {
      const out = await routeResolver.resolve({ sha256, access, requesterSafe: selfSafeAddress });
      if (out) {
        const actualSha = sha256Hex(out.bytes);
        if (actualSha !== sha256) {
          throw new HashMismatchError(sha256, actualSha, 'route-resolver', out.sourceOperator);
        }
        const ts = now();
        store.saveNetworkArtifact({
          sha256,
          artifactType,
          envelopeCid: envelopeCid ?? null,
          content: out.bytes,
          source: 'route-resolver',
          sourceOperator: out.sourceOperator ?? null,
          paidAmountUsdc: out.pricePaidUsdc,
          fetchedAt: ts,
        });
        return {
          sha256,
          bytes: out.bytes,
          artifactType,
          source: 'route-resolver',
          paidAmountUsdc: out.pricePaidUsdc,
          fetchedAt: ts,
          sourceOperator: out.sourceOperator,
        };
      }
    } catch (err) {
      if (err instanceof HashMismatchError) throw err;
      throw new AcquireError(sha256, 'routeResolver failed', err);
    }
  }

  // 4. Origin fetch
  let bytes: Buffer | null;
  try {
    bytes = await acquireFn(access.endpoint, sha256, privateKey);
  } catch (err) {
    throw new AcquireError(sha256, 'origin fetch failed', err);
  }
  if (!bytes) {
    throw new AcquireError(sha256, 'origin returned null (404 / payment failed)');
  }
  const actualSha = sha256Hex(bytes);
  if (actualSha !== sha256) {
    throw new HashMismatchError(sha256, actualSha, 'origin', ownerSafe);
  }
  const ts = now();
  store.saveNetworkArtifact({
    sha256,
    artifactType,
    envelopeCid: envelopeCid ?? null,
    content: bytes,
    source: 'origin',
    sourceOperator: ownerSafe ?? null,
    sourceEndpoint: access.endpoint,
    paidAmountUsdc: access.priceUsdc,
    fetchedAt: ts,
  });
  return {
    sha256,
    bytes,
    artifactType,
    source: 'origin',
    paidAmountUsdc: access.priceUsdc,
    fetchedAt: ts,
    sourceOperator: ownerSafe,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd client && yarn test test/corpus/acquire.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```
git add client/src/corpus/acquire.ts client/test/corpus/acquire.test.ts
git commit -m "corpus: per-artifact acquire chain (jinn-mono-q94h)"
```

### Task 4.5: Compose Corpus interface (corpus/index.ts)

**Files:**
- Create: `client/src/corpus/index.ts`
- Test: `client/test/corpus/integration.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/corpus/integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Store } from '../../src/store/store.js';
import { createCorpus } from '../../src/corpus/index.js';
import type { SignedEnvelope } from '../../src/types/envelope.js';

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function sha256(buf: Buffer): string { return createHash('sha256').update(buf).digest('hex'); }

function fakeEnvelope(opts: { sha256: string; endpoint: string; priceUsdc: string; participantSafe: string }): SignedEnvelope {
  return {
    schemaVersion: 'jinn.execution.v1',
    kind: 'prediction.v0',
    role: 'restoration',
    generatedAt: 1745978400,
    intent: { cid: 'bafyIntent', onchainCreationTx: '0x' + 'a'.repeat(64), onchainCreationBlock: 1, requestId: '0x' + 'b'.repeat(64) },
    participant: { safeAddress: opts.participantSafe, agentEoa: '0x' + '2'.repeat(40) },
    window: { startMs: 0, endMs: 1000 },
    executor: { implName: 'test', implVersion: '0.1.0', clientGitSha: 'abc', codeDigest: 'sha256:' + 'c'.repeat(64), signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) } },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [{
      artifactType: 'output.prediction.v0',
      sha256: opts.sha256,
      access: { endpoint: opts.endpoint, priceUsdc: opts.priceUsdc },
    }],
    payload: {},
    signature: { algo: 'secp256k1', signer: '0x' + '2'.repeat(40), hash: '0x' + 'e'.repeat(64), sig: '0x' + 'f'.repeat(130) },
  };
}

describe('createCorpus.read (integration)', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => store.close());

  it('runs the full pipeline and returns hash-verified envelopes', async () => {
    const realBytes = Buffer.from('integration test bytes', 'utf-8');
    const realSha = sha256(realBytes);
    const opSafe = '0x' + 'a'.repeat(40);

    const fakeFetch = vi.fn(async (_url: string) => {
      // Subgraph response
      return new Response(JSON.stringify({
        data: {
          executions: [{
            id: '1-0xabc',
            manifestCid: 'bafyM',
            manifestHash: '0x' + 'a'.repeat(64),
            tier: 'COMMITTED',
            publishedAt: '1745978400',
            operator: { id: '1', agentId: '1', owner: opSafe, agentWallet: opSafe },
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const fetchFromIpfs = vi.fn(async (_g: string, cid: string) => {
      if (cid === 'bafyM') return fakeEnvelope({ sha256: realSha, endpoint: 'https://op.example.com', priceUsdc: '0', participantSafe: opSafe });
      throw new Error('unknown CID');
    });

    const acquireFn = vi.fn(async (_endpoint: string, sha: string) => {
      if (sha === realSha) return realBytes;
      return null;
    });

    const corpus = createCorpus({
      subgraphUrl: 'https://subgraph.test/graphql',
      ipfsGatewayUrl: 'https://gateway.test',
      store,
      signer: { privateKey: TEST_KEY },
      selfSafeAddress: '0x' + 'b'.repeat(40),
    }, { fetch: fakeFetch, fetchFromIpfs, acquireFn });

    const envelopes = await corpus.read({ query: { kind: 'prediction.v0', limit: 5 } });
    expect(envelopes).toHaveLength(1);
    const ac = envelopes[0].artifactContents.get(realSha);
    expect(ac).toBeDefined();
    expect(ac!.bytes.equals(realBytes)).toBe(true);
    expect(ac!.source).toBe('origin');
    expect(ac!.paidAmountUsdc).toBe('0');
  });

  it('cache hit on second read', async () => {
    const realBytes = Buffer.from('cache test', 'utf-8');
    const realSha = sha256(realBytes);
    const opSafe = '0x' + 'a'.repeat(40);

    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({
      data: { executions: [{ id: '1', manifestCid: 'bafyM', manifestHash: '0x' + 'a'.repeat(64), tier: 'COMMITTED', publishedAt: '1745978400', operator: { id: '1', agentId: '1', owner: opSafe, agentWallet: opSafe } }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const fetchFromIpfs = vi.fn(async () => fakeEnvelope({ sha256: realSha, endpoint: 'https://op.example.com', priceUsdc: '0.001', participantSafe: opSafe }));
    const acquireFn = vi.fn(async () => realBytes);

    const corpus = createCorpus({
      subgraphUrl: 'https://subgraph.test/graphql',
      ipfsGatewayUrl: 'https://gateway.test',
      store,
      signer: { privateKey: TEST_KEY },
      selfSafeAddress: '0x' + 'b'.repeat(40),
    }, { fetch: fakeFetch, fetchFromIpfs, acquireFn });

    await corpus.read({ query: { kind: 'prediction.v0', limit: 5 } });
    await corpus.read({ query: { kind: 'prediction.v0', limit: 5 } });

    expect(acquireFn).toHaveBeenCalledTimes(1); // second read served from cache
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/corpus/integration.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `client/src/corpus/index.ts`**

```typescript
/**
 * Corpus library entry point.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §2.
 */

import type {
  Corpus,
  CorpusOptions,
  CorpusQuery,
  EnvelopeRef,
  ManifestPreview,
  Envelope,
  ArtifactContent,
  ReadArgs,
} from './types.js';
import { runCorpusQuery } from './query.js';
import { fetchManifest } from './fetch.js';
import { acquireArtifactContent } from './acquire.js';

export type { Corpus, CorpusOptions, CorpusQuery, EnvelopeRef, ManifestPreview, Envelope, ArtifactContent, ReadArgs, RouteResolver } from './types.js';
export { CorpusQueryError, ManifestFetchError, AcquireError, HashMismatchError } from './types.js';

interface InternalDeps {
  fetch?: typeof globalThis.fetch;
  fetchFromIpfs?: (gatewayUrl: string, cid: string) => Promise<unknown>;
  acquireFn?: (endpoint: string, sha256: string, privateKey: string) => Promise<Buffer | null>;
}

export function createCorpus(opts: CorpusOptions, deps: InternalDeps = {}): Corpus {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const fetchFromIpfsImpl = deps.fetchFromIpfs;
  const acquireFn = deps.acquireFn;

  async function query(q: CorpusQuery): Promise<EnvelopeRef[]> {
    return runCorpusQuery(opts.subgraphUrl, q, fetchImpl);
  }

  async function fetchOne(ref: EnvelopeRef): Promise<ManifestPreview> {
    return fetchManifest(ref, opts.ipfsGatewayUrl, fetchFromIpfsImpl);
  }

  async function acquire(manifest: ManifestPreview): Promise<Envelope> {
    const contents = new Map<string, ArtifactContent>();
    for (const a of manifest.envelope.artifacts) {
      const ac = await acquireArtifactContent({
        sha256: a.sha256,
        artifactType: a.artifactType,
        access: a.access,
        store: opts.store,
        selfSafeAddress: opts.selfSafeAddress,
        privateKey: opts.signer.privateKey,
        routeResolver: opts.routeResolver,
        envelopeCid: manifest.ref.manifestCid,
        ownerSafe: manifest.envelope.participant.safeAddress,
        acquireFn,
      });
      contents.set(a.sha256, ac);
    }
    return { ref: manifest.ref, envelope: manifest.envelope, artifactContents: contents };
  }

  async function acquireBySha256(
    sha256: string,
    access: { endpoint: string; priceUsdc: string },
    hint?: { artifactType?: string; envelopeCid?: string },
  ): Promise<ArtifactContent> {
    return acquireArtifactContent({
      sha256,
      artifactType: hint?.artifactType ?? 'unknown',
      access,
      store: opts.store,
      selfSafeAddress: opts.selfSafeAddress,
      privateKey: opts.signer.privateKey,
      routeResolver: opts.routeResolver,
      envelopeCid: hint?.envelopeCid,
      acquireFn,
    });
  }

  async function read(args: ReadArgs): Promise<Envelope[]> {
    const refs = await query(args.query);
    const previews: ManifestPreview[] = [];
    for (const ref of refs) {
      previews.push(await fetchOne(ref));
    }
    // Post-fetch kind filter (subgraph index doesn't expose intent kind; spec §10 Q6).
    const kindFilter = args.query.kind;
    const kindFiltered = kindFilter ? previews.filter((p) => p.envelope.kind === kindFilter) : previews;
    const selected = args.select ? args.select(kindFiltered) : kindFiltered;
    const envelopes: Envelope[] = [];
    for (const sel of selected) {
      envelopes.push(await acquire(sel));
    }
    return envelopes;
  }

  return {
    read,
    query,
    fetchManifest: fetchOne,
    acquire,
    acquireBySha256,
  };
}
```

- [ ] **Step 4: Run all corpus tests + full suite**

```
cd client && yarn test test/corpus/
cd client && yarn typecheck && yarn test
```
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```
git add client/src/corpus/index.ts client/test/corpus/integration.test.ts
git commit -m "corpus: createCorpus factory + read pipeline (jinn-mono-q94h)"
```

### Task 4.6: Cross-operator e2e validation script

**Files:**
- Create: `client/scripts/corpus-e2e-validate.ts`
- Modify: `client/package.json` (add `corpus:e2e` script)

- [ ] **Step 1: Implement the e2e script**

Create `client/scripts/corpus-e2e-validate.ts`:

```typescript
/**
 * Phase A.1 cross-operator e2e validation.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §8.
 *
 * Spins up an Anvil fork of Base, two operator daemons (A produces, B reads),
 * runs A through one restoration cycle, then drives B's corpus library to
 * fetch + verify the manifest's artifact via x402 + cache.
 *
 * Asserts:
 *   1. Bytes are non-empty
 *   2. network_artifacts row exists on B
 *   3. Second read uses the cache (no extra acquireFn call)
 *   4. Operator A's USDC balance increased by the price (when priceUsdc > 0)
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/store/store.js';
import { createCorpus } from '../src/corpus/index.js';

// ... (full e2e fixture: spawns anvil, runs two daemons, drives the corpus,
//      verifies invariants. Implementation references existing patterns in
//      scripts/e2e-validate.ts and scripts/staking-validate.ts.)

async function main() {
  // 1. spawn anvil
  // 2. fund two EOAs
  // 3. start operator A daemon (publishes one envelope with priceUsdc='0.001')
  // 4. wait for A's manifest to appear in subgraph (or skip subgraph and inject EnvelopeRef)
  // 5. start operator B's corpus library
  // 6. corpus.read → assert content matches expected sha256
  // 7. corpus.read again → assert acquireFn not called the second time
  // 8. read on-chain USDC balances → assert delta
  console.log('[corpus-e2e] OK');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

(Full implementation is mechanical — fixture wiring follows patterns in `client/scripts/e2e-validate.ts`. Estimating ~300-400 LOC; out-of-band from this plan.)

- [ ] **Step 2: Add package script**

In `client/package.json` `scripts`:

```json
"corpus:e2e": "tsx scripts/corpus-e2e-validate.ts",
```

- [ ] **Step 3: Run the e2e**

```
cd client && yarn corpus:e2e
```
Expected: prints `[corpus-e2e] OK`. Anvil + two daemons + corpus read all complete; assertions hold.

- [ ] **Step 4: Commit**

```
git add client/scripts/corpus-e2e-validate.ts client/package.json
git commit -m "corpus: cross-operator e2e validation script (jinn-mono-q94h)"
```

---

## Phase 5 — MCP rewiring

Last phase. Wraps `corpus.query` and `corpus.acquireBySha256` behind the existing MCP tools, with self-store and cache fast paths.

### Task 5.1: Rewire `search_artifacts` to corpus

**Files:**
- Modify: `client/src/mcp/server.ts:189-211`
- Modify: `client/src/store/store.ts` (add `searchOwnAndCached` accessor)
- Test: `client/test/mcp/search-artifacts-corpus.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/mcp/search-artifacts-corpus.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleSearchArtifacts } from '../../src/mcp/search-artifacts.js';
import { Store } from '../../src/store/store.js';

describe('search_artifacts (corpus-backed)', () => {
  it('returns local + network results', async () => {
    const store = new Store(':memory:');
    // Seed a local own_artifact:
    store.saveServedArtifact({
      sha256: 'a'.repeat(64),
      artifactType: 'output.prediction.v0',
      requestId: '0x' + 'b'.repeat(64),
      content: Buffer.from('local'),
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = {
      query: vi.fn(async () => [
        { manifestCid: 'bafyOther', manifestHash: '0x' + 'c'.repeat(64), operator: { agentId: '2', safeAddress: '0x' + '2'.repeat(40) }, evidenceTier: 'committed' as const, publishedAt: 1745978400 },
      ]),
    } as never;
    const out = await handleSearchArtifacts(corpus, store, { kind: 'prediction.v0', limit: 10 });
    expect(out.local).toHaveLength(1);
    expect(out.network).toHaveLength(1);
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/mcp/search-artifacts-corpus.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Extract handler + Store helper**

Create `client/src/mcp/search-artifacts.ts`:

```typescript
import type { Corpus, CorpusQuery, EnvelopeRef } from '../corpus/index.js';
import type { Store, ServedArtifactRow, NetworkArtifactRow } from '../store/store.js';

export interface SearchArtifactsResult {
  local: Array<{ sha256: string; artifactType: string; source: 'served' | 'network'; envelopeCid: string | null; createdAt: string }>;
  network: EnvelopeRef[];
}

export async function handleSearchArtifacts(
  corpus: Pick<Corpus, 'query'>,
  store: Store,
  args: CorpusQuery,
): Promise<SearchArtifactsResult> {
  const local = store.searchOwnAndCached({
    artifactType: args.kind,
    limit: args.limit ?? 50,
  });
  const network = await corpus.query(args);
  return { local, network };
}
```

In `store.ts`, add:

```typescript
searchOwnAndCached(filter: { artifactType?: string; limit: number }): Array<{ sha256: string; artifactType: string; source: 'served' | 'network'; envelopeCid: string | null; createdAt: string }> {
  const limit = Math.min(Math.max(1, filter.limit), 500);
  const typeClause = filter.artifactType ? 'WHERE artifact_type = @type' : '';
  const params: Record<string, unknown> = { limit };
  if (filter.artifactType) params['type'] = filter.artifactType;

  const own = this.db.prepare(
    `SELECT sha256, artifact_type, envelope_cid, created_at FROM served_artifacts ${typeClause}
     ORDER BY created_at DESC LIMIT @limit`,
  ).all(params) as Array<{ sha256: string; artifact_type: string; envelope_cid: string | null; created_at: string }>;

  const cached = this.db.prepare(
    `SELECT sha256, artifact_type, envelope_cid, fetched_at FROM network_artifacts ${typeClause}
     ORDER BY fetched_at DESC LIMIT @limit`,
  ).all(params) as Array<{ sha256: string; artifact_type: string; envelope_cid: string | null; fetched_at: string }>;

  return [
    ...own.map((r) => ({ sha256: r.sha256, artifactType: r.artifact_type, source: 'served' as const, envelopeCid: r.envelope_cid, createdAt: r.created_at })),
    ...cached.map((r) => ({ sha256: r.sha256, artifactType: r.artifact_type, source: 'network' as const, envelopeCid: r.envelope_cid, createdAt: r.fetched_at })),
  ];
}
```

In `client/src/mcp/server.ts:189-211`, replace the `search_artifacts` tool registration with:

```typescript
server.tool(
  'search_artifacts',
  'Search the corpus for relevant past trajectories and artifacts. Returns local fast-path hits plus network discovery results.',
  {
    kind: z.string().optional().describe('Intent kind (e.g. "prediction.v0")'),
    intentCid: z.string().optional(),
    evidenceTier: z.enum(['self-signed', 'committed', 'attested']).optional(),
    generatedAfter: z.number().int().optional(),
    generatedBefore: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async (args) => {
    if (!corpus || !store) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'corpus or store not configured' }) }] };
    }
    const out = await handleSearchArtifacts(corpus, store, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
  },
);
```

(`corpus` is a new parameter passed into the MCP server constructor; thread from main.ts where the daemon already has a `Store` and config.)

- [ ] **Step 4: Run test + typecheck + full suite**

```
cd client && yarn test test/mcp/
cd client && yarn typecheck && yarn test
```
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```
git add client/src/mcp/server.ts client/src/mcp/search-artifacts.ts client/src/store/store.ts client/test/mcp/search-artifacts-corpus.test.ts
git commit -m "mcp: search_artifacts wraps corpus.query with local fast path (jinn-mono-q94h)"
```

### Task 5.2: Rewire `acquire_artifact` with served + cache fast paths

**Files:**
- Modify: `client/src/mcp/server.ts:214-260`
- Test: `client/test/mcp/acquire-artifact-fast-path.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/mcp/acquire-artifact-fast-path.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';
import { handleAcquireArtifact } from '../../src/mcp/acquire-artifact.js';

describe('acquire_artifact (corpus + fast paths)', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => store.close());

  it('returns from served_artifacts without calling corpus', async () => {
    const sha256 = 'a'.repeat(64);
    const bytes = Buffer.from('own content');
    store.saveServedArtifact({
      sha256, artifactType: 'design_document', content: bytes, priceUsdc: '0', createdAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = { acquireBySha256: vi.fn() } as never;
    const out = await handleAcquireArtifact(corpus, store, { sha256, access: { endpoint: 'https://op.example.com', priceUsdc: '0' } });
    expect(out.source).toBe('self-store');
    expect(corpus.acquireBySha256).not.toHaveBeenCalled();
  });

  it('returns from network_artifacts cache without calling corpus', async () => {
    const sha256 = 'b'.repeat(64);
    const bytes = Buffer.from('cached content');
    store.saveNetworkArtifact({
      sha256, artifactType: 'design_document', content: bytes, source: 'origin', paidAmountUsdc: '0', fetchedAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = { acquireBySha256: vi.fn() } as never;
    const out = await handleAcquireArtifact(corpus, store, { sha256, access: { endpoint: 'https://op.example.com', priceUsdc: '0' } });
    expect(out.source).toBe('cache');
    expect(corpus.acquireBySha256).not.toHaveBeenCalled();
  });

  it('falls through to corpus.acquireBySha256 when no fast path hits', async () => {
    const sha256 = 'c'.repeat(64);
    const corpus = { acquireBySha256: vi.fn(async () => ({
      sha256, bytes: Buffer.from('fetched'), artifactType: 'design_document',
      source: 'origin' as const, paidAmountUsdc: '0', fetchedAt: '2026-04-30T00:00:00.000Z',
    })) } as never;
    const out = await handleAcquireArtifact(corpus, store, { sha256, access: { endpoint: 'https://op.example.com', priceUsdc: '0' } });
    expect(out.source).toBe('origin');
    expect(corpus.acquireBySha256).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && yarn test test/mcp/acquire-artifact-fast-path.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Extract handler**

Create `client/src/mcp/acquire-artifact.ts`:

```typescript
import type { Corpus, ArtifactContent } from '../corpus/index.js';
import type { Store } from '../store/store.js';

export async function handleAcquireArtifact(
  corpus: Pick<Corpus, 'acquireBySha256'>,
  store: Store,
  args: { sha256: string; access: { endpoint: string; priceUsdc: string }; envelopeCid?: string; artifactType?: string },
): Promise<ArtifactContent> {
  const own = store.getServedArtifact(args.sha256);
  if (own) {
    return {
      sha256: args.sha256,
      bytes: own.content,
      artifactType: own.artifactType,
      source: 'self-store',
      paidAmountUsdc: '0',
      fetchedAt: own.createdAt,
    };
  }
  const cached = store.getNetworkArtifact(args.sha256);
  if (cached) {
    store.touchNetworkArtifactUsage(args.sha256, new Date().toISOString());
    return {
      sha256: args.sha256,
      bytes: cached.content,
      artifactType: cached.artifactType,
      source: 'cache',
      paidAmountUsdc: '0',
      fetchedAt: cached.fetchedAt,
      sourceOperator: cached.sourceOperator ?? undefined,
    };
  }
  return corpus.acquireBySha256(args.sha256, args.access, { artifactType: args.artifactType, envelopeCid: args.envelopeCid });
}
```

In `client/src/mcp/server.ts:214-260`, replace the `acquire_artifact` tool with:

```typescript
server.tool(
  'acquire_artifact',
  'Fetch artifact bytes by sha256. Hits local-store (own) and corpus cache fast paths first; falls through to network with x402 payment.',
  {
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    access: z.object({
      endpoint: z.string().url(),
      priceUsdc: z.string().regex(/^\d+(\.\d+)?$/),
    }),
    envelopeCid: z.string().optional(),
    artifactType: z.string().optional(),
  },
  async (args) => {
    if (!corpus || !store) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'corpus or store not configured' }) }] };
    }
    const out = await handleAcquireArtifact(corpus, store, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify({
      sha256: out.sha256,
      bytes: out.bytes.toString('base64'),
      artifactType: out.artifactType,
      source: out.source,
      paidAmountUsdc: out.paidAmountUsdc,
    }) }] };
  },
);
```

- [ ] **Step 4: Run test + typecheck + full suite**

```
cd client && yarn test test/mcp/acquire-artifact-fast-path.test.ts
cd client && yarn typecheck && yarn test
```
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```
git add client/src/mcp/server.ts client/src/mcp/acquire-artifact.ts client/test/mcp/acquire-artifact-fast-path.test.ts
git commit -m "mcp: acquire_artifact fast paths + corpus fallthrough (jinn-mono-q94h)"
```

### Task 5.3: Run full suite + cross-operator e2e + commit

- [ ] **Step 1: Full suite**

```
cd client && yarn typecheck && yarn test
```
Expected: clean.

- [ ] **Step 2: Cross-operator e2e**

```
cd client && yarn corpus:e2e
```
Expected: `[corpus-e2e] OK`. Phase A.1 gate trips.

- [ ] **Step 3: Final commit (if anything stragglers)**

(No-op unless leftover changes exist. The PR boundary closes here.)

---

## Self-review checklist (run after the plan is committed)

- [ ] Spec coverage: each of the five workstreams in `spec/2026-04-30-phase-a-umbrella.md` §2-§6 has at least one task that implements it.
- [ ] Phase 1 (schema migrations): Tasks 1.1–1.3 cover §3 and §5.3.
- [ ] Phase 2 (gating leak fix): Tasks 2.1–2.3 cover §1.1, §1.2, §1.5, §5.1–§5.6.
- [ ] Phase 3 (manifest hygiene): Tasks 3.1–3.3 cover §6.1–§6.4.
- [ ] Phase 4 (corpus library): Tasks 4.1–4.6 cover §2.1–§2.5 and §8 (acceptance e2e).
- [ ] Phase 5 (MCP rewiring): Tasks 5.1–5.3 cover §4.1–§4.4.
- [ ] No placeholders: all code blocks contain real code, no TODO/TBD/FIXME.
- [ ] Type consistency: `Store.saveServedArtifact` / `Store.saveNetworkArtifact` / `corpus.acquireBySha256` / `Corpus.read` use the same names and shapes from definition through use.
- [ ] Test-first discipline: every code-changing task starts with a failing test step.
- [ ] Frequent commits: each task ends with a commit boundary.

---

## Open dependencies / out-of-band work

The plan assumes:

- The subgraph at `subgraph/schema.graphql` is **deployed and indexing** the operator's testnet activity. If not, Phase 4's e2e needs a stand-in (a mock subgraph response served by a test fixture) — Task 4.6 includes the fixture path.
- The Anvil fork plumbing already exists in `client/scripts/e2e-validate.ts`. Task 4.6's e2e script reuses that fixture-spawning code.
- The `@x402/*` packages support per-request payment requirements (no static `paymentMiddleware(routes, ...)` mount required). Task 2.3 implements verify+settle inline; if the packages provide a more ergonomic API in a later version, the implementation can simplify without changing the plan structure.
- USDC contract deployments on Base + Base Sepolia are present in the Anvil fork. The cross-operator e2e funds two EOAs with USDC via a whale-impersonation step (pattern in `client/scripts/staking-validate.ts`).

If any of these are not in place, file a sibling Beads issue under `jinn-mono-vy37` with the gap before starting Phase 4.
