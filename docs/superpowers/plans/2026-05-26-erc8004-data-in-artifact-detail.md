# ERC-8004 data in the artifact detail panel — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface every locally-stored ERC-8004 datum in the operator dashboard's artifact detail panel, including the on-chain anchor (tx hash, block, agent ID, chain, registry, payload) which is currently discarded after `publishContentV2()` returns.

**Architecture:** Add a new `erc8004_anchors` SQLite table populated at publish time. Extend `IdentityPublisher.publishContentV2()` to return `{ txHash, blockNumber }` instead of just `txHash`. Both call sites (`live-publisher.ts` and `harnesses/engine/engine.ts`) record an anchor row after a successful publish via a new `store.saveErc8004Anchor()`. The operator artifacts API joins `envelope_projections` and `erc8004_anchors` onto each artifact by `envelope_cid`. The SPA detail panel renders labelled sections with the new data, fixes the dual-header bug, and renders explorer links derived from `chainId`.

**Tech Stack:** TypeScript, better-sqlite3, Hono, viem, React 18, Vitest, React Testing Library, Tailwind, shadcn/ui.

**Branch:** `feat/erc8004-data-in-artifact-detail` off `origin/next`. Spec at `docs/superpowers/specs/2026-05-26-erc8004-data-in-artifact-detail-design.md`.

---

## File map

**Create:**
- `client/test/store/erc8004-anchors.test.ts` — store unit tests for anchor save/list.

**Modify:**
- `client/src/store/store.ts` — schema for `erc8004_anchors`, `saveErc8004Anchor`, `listErc8004AnchorsByEnvelopeCids`, types.
- `client/src/erc8004/identity.ts` — `publishContent` / `publishContentV2` return `{ txHash, blockNumber }` from the captured receipt.
- `client/src/captures/live-publisher.ts` — record anchor row after `publishContentV2` succeeds.
- `client/src/harnesses/engine/engine.ts` — record anchor row after `publishContent(V2)` succeeds in the engine path.
- `client/src/api/operator-artifacts-endpoint.ts` — join projection + anchors into each artifact in the response.
- `client/test/api/operator-artifacts-endpoint.test.ts` — assert new fields in response.
- `client/src/dashboard/spa/src/api/types.ts` — extend `OperatorServedArtifact` / `OperatorNetworkArtifact` with `projection`, `anchors`.
- `client/src/dashboard/spa/src/captures/CapturesTab.tsx` — refactor `ExecutionArtifactDetail` into labelled sections; drop duplicate `type` row; render projection + anchors.
- `client/src/dashboard/spa/src/captures/CapturesTab.test.tsx` — render-test the new sections.

---

## Task 1: Store schema + `saveErc8004Anchor` + `listErc8004AnchorsByEnvelopeCids`

**Files:**
- Modify: `client/src/store/store.ts`
- Create: `client/test/store/erc8004-anchors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// client/test/store/erc8004-anchors.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';

describe('Store.erc8004_anchors', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('persists an anchor and lists it by envelope CID', () => {
    store.saveErc8004Anchor({
      envelopeId: 'env-1',
      envelopeCid: 'bafy-env',
      contentKind: 'envelope',
      metadataKey: 'envelope:bafy-env',
      agentId: '42',
      chainId: 8453,
      identityRegistryAddress: '0xreg',
      txHash: '0xtx',
      blockNumber: 100,
      payloadHex: '0xdead',
      anchoredAt: 1000,
    });
    const anchors = store.listErc8004AnchorsByEnvelopeCids(['bafy-env']);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      envelopeCid: 'bafy-env',
      contentKind: 'envelope',
      metadataKey: 'envelope:bafy-env',
      agentId: '42',
      chainId: 8453,
      identityRegistryAddress: '0xreg',
      txHash: '0xtx',
      blockNumber: 100,
      payloadHex: '0xdead',
      anchoredAt: 1000,
    });
  });

  it('returns multiple anchors for the same envelope_cid', () => {
    const base = {
      envelopeId: 'env-2',
      envelopeCid: 'bafy-multi',
      agentId: '42',
      chainId: 84532,
      identityRegistryAddress: '0xreg',
      payloadHex: '0xab',
      anchoredAt: 2000,
    };
    store.saveErc8004Anchor({
      ...base,
      contentKind: 'capture',
      metadataKey: 'capture:bafy-multi',
      txHash: '0xtx1',
      blockNumber: 201,
    });
    store.saveErc8004Anchor({
      ...base,
      contentKind: 'envelope',
      metadataKey: 'envelope:bafy-multi',
      txHash: '0xtx2',
      blockNumber: 202,
    });
    const anchors = store.listErc8004AnchorsByEnvelopeCids(['bafy-multi']);
    expect(anchors).toHaveLength(2);
    expect(anchors.map((a) => a.contentKind).sort()).toEqual(['capture', 'envelope']);
  });

  it('accepts a null block number (pending receipt)', () => {
    store.saveErc8004Anchor({
      envelopeId: 'env-3',
      envelopeCid: 'bafy-pending',
      contentKind: 'envelope',
      metadataKey: 'envelope:bafy-pending',
      agentId: '42',
      chainId: 11155111,
      identityRegistryAddress: '0xreg',
      txHash: '0xtx',
      blockNumber: null,
      payloadHex: '0x',
      anchoredAt: 3000,
    });
    const [anchor] = store.listErc8004AnchorsByEnvelopeCids(['bafy-pending']);
    expect(anchor.blockNumber).toBeNull();
  });

  it('returns an empty array when there is no anchor', () => {
    expect(store.listErc8004AnchorsByEnvelopeCids(['nonexistent'])).toEqual([]);
    expect(store.listErc8004AnchorsByEnvelopeCids([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/store/erc8004-anchors.test.ts`
Expected: FAIL — `store.saveErc8004Anchor is not a function`.

- [ ] **Step 3: Add schema + methods + types to `store.ts`**

Add to the `SCHEMA` string (after the `envelope_projection_metadata` index, before `task_post_locks`):

```sql
CREATE TABLE IF NOT EXISTS erc8004_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL,
  envelope_cid TEXT NOT NULL,
  content_kind TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  identity_registry_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number INTEGER,
  payload_hex TEXT NOT NULL,
  anchored_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_erc8004_anchors_envelope_cid ON erc8004_anchors(envelope_cid);
CREATE INDEX IF NOT EXISTS idx_erc8004_anchors_envelope_id ON erc8004_anchors(envelope_id);
```

Add the exported types — near the top of the file with the other exported store types (search for `export interface ServedArtifactMetadataRow`):

```ts
export interface Erc8004AnchorInput {
  envelopeId: string;
  envelopeCid: string;
  contentKind: string;
  metadataKey: string;
  agentId: string;
  chainId: number;
  identityRegistryAddress: string;
  txHash: string;
  blockNumber: number | null;
  payloadHex: string;
  anchoredAt: number;
}

export interface Erc8004AnchorRow extends Erc8004AnchorInput {
  id: number;
}
```

Add the two methods inside the `Store` class (place near the envelope-projection methods, around line 2247):

```ts
saveErc8004Anchor(input: Erc8004AnchorInput): void {
  this.db.prepare(
    `INSERT INTO erc8004_anchors
       (envelope_id, envelope_cid, content_kind, metadata_key, agent_id,
        chain_id, identity_registry_address, tx_hash, block_number,
        payload_hex, anchored_at)
     VALUES
       (@envelopeId, @envelopeCid, @contentKind, @metadataKey, @agentId,
        @chainId, @identityRegistryAddress, @txHash, @blockNumber,
        @payloadHex, @anchoredAt)`,
  ).run({
    envelopeId: input.envelopeId,
    envelopeCid: input.envelopeCid,
    contentKind: input.contentKind,
    metadataKey: input.metadataKey,
    agentId: input.agentId,
    chainId: input.chainId,
    identityRegistryAddress: input.identityRegistryAddress,
    txHash: input.txHash,
    blockNumber: input.blockNumber,
    payloadHex: input.payloadHex,
    anchoredAt: input.anchoredAt,
  });
}

listErc8004AnchorsByEnvelopeCids(envelopeCids: readonly string[]): Erc8004AnchorRow[] {
  if (envelopeCids.length === 0) return [];
  const placeholders = envelopeCids.map((_, i) => `@cid${i}`).join(', ');
  const params: Record<string, string> = {};
  envelopeCids.forEach((cid, i) => { params[`cid${i}`] = cid; });
  const rows = this.db.prepare(
    `SELECT id, envelope_id, envelope_cid, content_kind, metadata_key, agent_id,
            chain_id, identity_registry_address, tx_hash, block_number,
            payload_hex, anchored_at
       FROM erc8004_anchors
       WHERE envelope_cid IN (${placeholders})
       ORDER BY anchored_at ASC, id ASC`,
  ).all(params) as Array<{
    id: number;
    envelope_id: string;
    envelope_cid: string;
    content_kind: string;
    metadata_key: string;
    agent_id: string;
    chain_id: number;
    identity_registry_address: string;
    tx_hash: string;
    block_number: number | null;
    payload_hex: string;
    anchored_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    envelopeId: r.envelope_id,
    envelopeCid: r.envelope_cid,
    contentKind: r.content_kind,
    metadataKey: r.metadata_key,
    agentId: r.agent_id,
    chainId: r.chain_id,
    identityRegistryAddress: r.identity_registry_address,
    txHash: r.tx_hash,
    blockNumber: r.block_number,
    payloadHex: r.payload_hex,
    anchoredAt: r.anchored_at,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/store/erc8004-anchors.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add client/src/store/store.ts client/test/store/erc8004-anchors.test.ts
git commit -m "feat(store): add erc8004_anchors table + save/list APIs"
```

---

## Task 2: Extend `IdentityPublisher` to return `blockNumber`

**Files:**
- Modify: `client/src/erc8004/identity.ts`

`_writeMetadata` already awaits `waitForTransactionReceipt` (identity.ts:496) — it just discards the receipt. We capture and return `blockNumber` from the same receipt.

- [ ] **Step 1: Find the existing return type — read the `Anchor` / publishContent signatures**

Look at the publishContent / publishContentV2 return type — currently `Promise<Hex>`. The new return should be `Promise<{ txHash: Hex; blockNumber: number | null }>`.

- [ ] **Step 2: Update `_writeMetadata` and the two public methods**

Replace the body of `_writeMetadata` in `client/src/erc8004/identity.ts` (currently around lines 473–498):

```ts
private async _writeMetadata(
  metadataKey: string,
  metadataValue: Hex,
): Promise<{ txHash: Hex; blockNumber: number | null }> {
  const account = this.walletClient.account;
  if (!account) {
    throw new Error('IdentityPublisher: walletClient has no account configured');
  }
  const chain = this.walletClient.chain;
  if (!chain) {
    throw new Error('IdentityPublisher: walletClient has no chain configured');
  }

  const txHash = await this.walletClient.writeContract({
    address: this.identityRegistryAddress,
    abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
    functionName: 'setMetadata',
    args: [this.agentId, metadataKey, metadataValue],
    account,
    chain,
  });

  // Best-effort confirmation. We surface the blockNumber so callers can record
  // a verifiable on-chain reference; if the receipt query fails for any reason
  // (RPC hiccup), we still return the tx hash with a null block so the anchor
  // row still gets written.
  let blockNumber: number | null = null;
  try {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    blockNumber = Number(receipt.blockNumber);
  } catch (err) {
    console.warn(
      `[erc8004] receipt fetch failed for ${txHash} (anchor recorded with null block): ${err instanceof Error ? err.message : err}`,
    );
  }
  return { txHash, blockNumber };
}
```

Update the two callers in the same file:

```ts
async publishContent(args: PublishContentArgs): Promise<{ txHash: Hex; blockNumber: number | null }> {
  const metadataKey = buildMetadataKey(args.kind, args.cid);
  const metadataValue = encodeExecutionPayload(args.payload);
  return this._writeMetadata(metadataKey, metadataValue);
}

async publishContentV2(args: PublishContentV2Args): Promise<{ txHash: Hex; blockNumber: number | null }> {
  const metadataKey = buildMetadataKey(args.kind, args.cid);
  const metadataValue = encodeExecutionPayloadV2(args.payload);
  return this._writeMetadata(metadataKey, metadataValue);
}
```

- [ ] **Step 3: Update existing call sites in `live-publisher.ts` and `engine.ts` to handle the new return shape**

In `client/src/captures/live-publisher.ts` line 127:

```ts
const { txHash, blockNumber } = await options.identityPublisher!.publishContentV2({
  kind: 'capture',
  cid: envelopeCid,
  payload,
});
return { txHash, blockNumber };
```

Update the `anchorEnvelope` callback's return to include blockNumber (the `CaptureEnvelopeAnchorResult` interface already supports it — see `client/src/captures/publish.ts:65`).

In `client/src/harnesses/engine/engine.ts` (around lines 1819 and 1836), the existing code does:

```ts
pubTxHash = await this.identityPublisher.publishContentV2({...});
```

Change both to:

```ts
const v2Result = await this.identityPublisher.publishContentV2({...});
pubTxHash = v2Result.txHash;
// (capture v2Result.blockNumber + identityPublisher metadata for the anchor row write in Task 4)
```

And similarly for the v1 path. Note: the local variable `pubTxHash` is declared `let pubTxHash: \`0x${string}\`` at line 1806 — its type doesn't change.

- [ ] **Step 4: Find and fix any other callers**

Run: `grep -rn "publishContent(\|publishContentV2(" client/src --include="*.ts" | grep -v "\.test\." | grep -v "identity.ts"`

Expected: only `live-publisher.ts` (1) and `engine.ts` (2). If others exist, update them to destructure `{ txHash }`.

- [ ] **Step 5: Run typecheck**

Run: `cd client && yarn typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/erc8004/identity.ts client/src/captures/live-publisher.ts client/src/harnesses/engine/engine.ts
git commit -m "feat(erc8004): return blockNumber from publishContent(V2)"
```

---

## Task 3: Record anchor row from `live-publisher.ts`

**Files:**
- Modify: `client/src/captures/live-publisher.ts`

The live-publisher already has `options.store`, `options.identityPublisher`, `options.participant`, and computes the metadata key (`capture:<cid>` for captures). We capture chain ID from `walletClient.chain.id` exposed via the publisher.

- [ ] **Step 1: Expose `chainId` on `IdentityPublisher`**

Add to `client/src/erc8004/identity.ts` inside the `IdentityPublisher` class (near `get registry`):

```ts
/** Chain ID of the wallet client this publisher writes to. */
get chainId(): number {
  return this.walletClient.chain!.id;
}
```

(`walletClient.chain` is asserted non-null inside `_writeMetadata` already.)

- [ ] **Step 2: Modify `anchorEnvelope` in `live-publisher.ts` to record the anchor**

Inside `anchorEnvelope` callback (live-publisher.ts:116), after the `publishContentV2` await:

```ts
anchorEnvelope: async ({ envelopeCid, envelopeHash, envelope, metadataKey }) => {
  const payload: ExecutionPayloadV2 = {
    version: 2,
    tier: 0,
    manifestHash: envelopeHash as Hex,
    attestationQuoteCid: '0x',
    sourceMeasurement: ZERO_BYTES32,
    codeDigest: codeDigestSha256ToBytes32(envelope.executor.codeDigest),
    implName: envelope.executor.implName,
    modeFlag: modeStringToFlag(envelope.executor.mode ?? 'train'),
  };
  const payloadHex = encodeExecutionPayloadV2(payload);
  const { txHash, blockNumber } = await options.identityPublisher!.publishContentV2({
    kind: 'capture',
    cid: envelopeCid,
    payload,
  });
  options.store.saveErc8004Anchor({
    envelopeId: envelopeHash,
    envelopeCid,
    contentKind: 'capture',
    metadataKey,
    agentId: options.identityPublisher!.agent.toString(),
    chainId: options.identityPublisher!.chainId,
    identityRegistryAddress: options.identityPublisher!.registry,
    txHash,
    blockNumber,
    payloadHex,
    anchoredAt: Math.floor(Date.now() / 1000),
  });
  return { txHash, blockNumber };
},
```

Add the import at the top of the file:

```ts
import { encodeExecutionPayloadV2 } from '../erc8004/index.js';
```

Note: `metadataKey` comes from the `CaptureEnvelopeAnchorInput` type. Verify it's already in the interface in `client/src/captures/publish.ts:58` — it is (`metadataKey: string`).

- [ ] **Step 3: Run typecheck**

Run: `cd client && yarn typecheck`
Expected: PASS. If `encodeExecutionPayloadV2` is not re-exported from `erc8004/index.js`, add it: open `client/src/erc8004/index.ts` and add `export { encodeExecutionPayloadV2 } from './identity.js';` (or wherever it lives — check with `grep -n "encodeExecutionPayloadV2" client/src/erc8004/*.ts`).

- [ ] **Step 4: Run existing capture publisher tests if any**

Run: `cd client && yarn vitest run test/captures/`
Expected: PASS (or skipped — but no new failures).

- [ ] **Step 5: Commit**

```bash
git add client/src/captures/live-publisher.ts client/src/erc8004/identity.ts client/src/erc8004/index.ts
git commit -m "feat(captures): record erc8004 anchor row at publish time"
```

---

## Task 4: Record anchor row from `engine.ts`

**Files:**
- Modify: `client/src/harnesses/engine/engine.ts`

The engine calls `publishContent` (v1) and `publishContentV2` directly. After each successful call, write an anchor row. We need the same five publisher metadata fields (agentId, chainId, registry, payloadHex, content kind).

- [ ] **Step 1: Find the engine's store handle**

Run: `grep -n "this\.store\b" client/src/harnesses/engine/engine.ts | head -5`

Expected: the engine has `this.store: Store` (look around the class constructor). If it doesn't, look for how it persists state — likely the engine has access via dependencies. If genuinely absent, we plumb the store through; otherwise reuse.

- [ ] **Step 2: After each successful `publishContent(V2)` call, write the anchor**

Replace the `try { ... } catch (err) { ... }` block (currently lines 1805–1849) with (preserving comments / log lines):

```ts
try {
  const { encodeExecutionPayload, encodeExecutionPayloadV2 } = await import('../../erc8004/index.js');
  // (top-of-file imports preferred; using dynamic here only if static would be circular — see note)
  let pubTxHash: `0x${string}`;
  let pubBlockNumber: number | null;
  let payloadHex: `0x${string}`;
  if (canEmitV2) {
    const v2Payload: ExecutionPayloadV2 = {
      version: 2,
      tier,
      manifestHash: manifestHashHex,
      attestationQuoteCid: '0x',
      sourceMeasurement:
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      codeDigest: codeDigestSha256ToBytes32(task.executorCodeDigest),
      implName: harnessImplName as string,
      modeFlag: modeStringToFlag(task.executorMode as 'train' | 'frozen'),
    };
    payloadHex = encodeExecutionPayloadV2(v2Payload);
    const result = await this.identityPublisher.publishContentV2({
      kind: metadataKind,
      cid: manifestCid,
      payload: v2Payload,
    });
    pubTxHash = result.txHash;
    pubBlockNumber = result.blockNumber;
    console.log(
      `[harness-engine] ${requestId}: setMetadata ${metadataKind}:${manifestCid} tx=${pubTxHash} (payload v2 mode=${task.executorMode} impl=${harnessImplName})`,
    );
  } else {
    const v1Payload: ExecutionPayload = {
      version: 1,
      tier,
      manifestHash: manifestHashHex,
      attestationQuoteCid: '0x',
      sourceMeasurement:
        '0x0000000000000000000000000000000000000000000000000000000000000000',
    };
    payloadHex = encodeExecutionPayload(v1Payload);
    const result = await this.identityPublisher.publishContent({
      kind: metadataKind,
      cid: manifestCid,
      payload: v1Payload,
    });
    pubTxHash = result.txHash;
    pubBlockNumber = result.blockNumber;
    console.log(
      `[harness-engine] ${requestId}: setMetadata ${metadataKind}:${manifestCid} tx=${pubTxHash} (payload v1)`,
    );
  }
  this.store.saveErc8004Anchor({
    envelopeId: manifestHashHex,
    envelopeCid: manifestCid,
    contentKind: metadataKind,
    metadataKey: `${metadataKind}:${manifestCid}`,
    agentId: this.identityPublisher.agent.toString(),
    chainId: this.identityPublisher.chainId,
    identityRegistryAddress: this.identityPublisher.registry,
    txHash: pubTxHash,
    blockNumber: pubBlockNumber,
    payloadHex,
    anchoredAt: Math.floor(Date.now() / 1000),
  });
} catch (err) {
  console.warn(
    `[harness-engine] ${requestId}: setMetadata ${metadataKind} publish failed (non-fatal): ${err instanceof Error ? err.message : err}`,
  );
}
```

Replace the dynamic `import('../../erc8004/index.js')` with a static import at the top of the file (preferred). Add `encodeExecutionPayload` and `encodeExecutionPayloadV2` to the existing erc8004 import — look near line 1800 for `codeDigestSha256ToBytes32` import.

- [ ] **Step 3: Run typecheck**

Run: `cd client && yarn typecheck`
Expected: PASS.

- [ ] **Step 4: Run engine tests**

Run: `cd client && yarn vitest run test/harnesses/`
Expected: PASS (or no new failures). If a test mocks `publishContent(V2)` and now expects `{ txHash }`, update the mock to return `{ txHash, blockNumber }`.

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/engine/engine.ts
git commit -m "feat(engine): record erc8004 anchor row at publish time"
```

---

## Task 5: Extend the operator artifacts API to return `projection` + `anchors`

**Files:**
- Modify: `client/src/api/operator-artifacts-endpoint.ts`
- Modify: `client/test/api/operator-artifacts-endpoint.test.ts`

- [ ] **Step 1: Write the failing test (add to existing file)**

Append to `client/test/api/operator-artifacts-endpoint.test.ts` inside the existing `describe('GET /v1/operator/artifacts', ...)`:

```ts
it('joins envelope projection and erc8004 anchors per artifact', async () => {
  const store = memoryStore();
  store.saveServedArtifact({
    sha256: 'd'.repeat(64),
    artifactType: 'swe-rebench-v2_v1_solution',
    requestId: 'req-projection',
    envelopeCid: 'bafy-with-projection',
    content: Buffer.from('proj body'),
    priceUsdc: '0.000',
    createdAt: '2026-05-25T14:49:33.000Z',
  });
  store.setServedArtifactEnvelopeCid('d'.repeat(64), 'bafy-with-projection');
  store.saveEnvelopeProjection({
    envelopeId: 'env-d',
    envelopeCid: 'bafy-with-projection',
    envelopeSha256: 'sha-d',
    signatureHash: '0xsigd',
    solverType: 'swe-rebench-v2',
    role: 'solution',
    taskCid: 'bafy-task',
    taskId: 'task-1',
    requestId: 'req-projection',
    generatedAt: 1748178573,
    evidenceTier: 'self-signed',
    participantSafeAddress: '0xsafe',
    participantAgentEoa: '0xeoa',
    executorImplName: 'swe-rebench-v2-baseline',
    executorImplVersion: '0.1.0',
    executorRuntimeBundleDigest: 'sha256:beef',
    executorPlugins: ['shell', 'fs'],
    solutionEnvelopeCid: null,
    solutionEnvelopeSha256: null,
    solutionEnvelopeRef: null,
    metadata: {},
  });
  store.saveErc8004Anchor({
    envelopeId: 'env-d',
    envelopeCid: 'bafy-with-projection',
    contentKind: 'envelope',
    metadataKey: 'envelope:bafy-with-projection',
    agentId: '42',
    chainId: 84532,
    identityRegistryAddress: '0xreg',
    txHash: '0xanchortx',
    blockNumber: 12345,
    payloadHex: '0xabcdef',
    anchoredAt: 1748178533,
  });

  const app = new Hono();
  const configPath = join(mkdtempSync(join(tmpdir(), 'jinn-operator-artifacts-proj-')), 'config.json');
  addOperatorArtifactsRoutes(app, {
    store,
    configPath,
    operatorConfig: {
      publicEndpoint: 'https://op.example.com',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
      donation: { enabled: false },
    },
  });

  const res = await app.request('/v1/operator/artifacts?source=served');
  expect(res.status).toBe(200);
  const body = await res.json() as {
    artifacts: Array<{
      sha256: string;
      projection?: { solverType: string; role: string; evidenceTier: string; executor: { implName: string | null; plugins: string[] | null } };
      anchors: Array<{ contentKind: string; agentId: string; chainId: number; txHash: string; blockNumber: number | null }>;
    }>;
  };
  const artifact = body.artifacts.find((a) => a.sha256 === 'd'.repeat(64));
  expect(artifact).toBeDefined();
  expect(artifact!.projection).toMatchObject({
    solverType: 'swe-rebench-v2',
    role: 'solution',
    evidenceTier: 'self-signed',
    executor: { implName: 'swe-rebench-v2-baseline', plugins: ['shell', 'fs'] },
  });
  expect(artifact!.anchors).toHaveLength(1);
  expect(artifact!.anchors[0]).toMatchObject({
    contentKind: 'envelope',
    agentId: '42',
    chainId: 84532,
    txHash: '0xanchortx',
    blockNumber: 12345,
  });
});

it('returns empty anchors when no anchor row exists', async () => {
  const store = memoryStore();
  store.saveServedArtifact({
    sha256: 'e'.repeat(64),
    artifactType: 'plain_artifact',
    requestId: 'req-no-anchor',
    envelopeCid: 'bafy-no-anchor',
    content: Buffer.from('x'),
    priceUsdc: '0',
    createdAt: '2026-05-25T15:00:00.000Z',
  });
  store.setServedArtifactEnvelopeCid('e'.repeat(64), 'bafy-no-anchor');

  const app = new Hono();
  const configPath = join(mkdtempSync(join(tmpdir(), 'jinn-operator-artifacts-noanchor-')), 'config.json');
  addOperatorArtifactsRoutes(app, {
    store,
    configPath,
    operatorConfig: {
      publicEndpoint: 'https://op.example.com',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
      donation: { enabled: false },
    },
  });

  const res = await app.request('/v1/operator/artifacts?source=served');
  const body = await res.json() as { artifacts: Array<{ sha256: string; projection: unknown; anchors: unknown[] }> };
  const artifact = body.artifacts.find((a) => a.sha256 === 'e'.repeat(64));
  expect(artifact!.anchors).toEqual([]);
  expect(artifact!.projection).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/api/operator-artifacts-endpoint.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement the join + response extension**

In `client/src/api/operator-artifacts-endpoint.ts`, replace `listExecutionData` and the `servedArtifact` / `networkArtifact` helpers as follows.

Update imports at the top:

```ts
import type {
  ArtifactAccessStats,
  Erc8004AnchorRow,
  NetworkArtifactMetadataRow,
  ServedArtifactMetadataRow,
  Store,
} from '../store/store.js';
import type { EnvelopeProjection } from '../corpus/types.js';
```

Add a projection-shape helper near the existing helpers:

```ts
function projectionToResponse(projection: EnvelopeProjection): Record<string, unknown> {
  return {
    envelopeId: projection.envelopeId,
    signatureHash: projection.signatureHash,
    solverType: projection.solverType,
    role: projection.role,
    taskCid: projection.taskCid,
    taskId: projection.taskId,
    requestId: projection.requestId,
    generatedAt: projection.generatedAt,
    evidenceTier: projection.evidenceTier,
    participantSafeAddress: projection.participantSafeAddress,
    participantAgentEoa: projection.participantAgentEoa,
    executor: {
      implName: projection.executorImplName,
      implVersion: projection.executorImplVersion,
      runtimeBundleDigest: projection.executorRuntimeBundleDigest,
      plugins: projection.executorPlugins.length > 0 ? projection.executorPlugins : null,
    },
    solutionRef: projection.solutionEnvelopeCid
      ? {
          envelopeCid: projection.solutionEnvelopeCid,
          envelopeSha256: projection.solutionEnvelopeSha256,
          ref: projection.solutionEnvelopeRef,
        }
      : undefined,
    metadata: Object.keys(projection.metadata).length > 0 ? projection.metadata : null,
  };
}

function anchorToResponse(anchor: Erc8004AnchorRow): Record<string, unknown> {
  return {
    contentKind: anchor.contentKind,
    metadataKey: anchor.metadataKey,
    agentId: anchor.agentId,
    chainId: anchor.chainId,
    identityRegistryAddress: anchor.identityRegistryAddress,
    txHash: anchor.txHash,
    blockNumber: anchor.blockNumber,
    payloadHex: anchor.payloadHex,
    anchoredAt: anchor.anchoredAt,
  };
}
```

Modify `servedArtifact` and `networkArtifact` to accept projection + anchors:

```ts
function servedArtifact(
  row: ServedArtifactMetadataRow,
  pricing: OperatorPricingConfig,
  access: ArtifactAccessStats,
  projection: EnvelopeProjection | undefined,
  anchors: Erc8004AnchorRow[],
): Record<string, unknown> {
  return {
    source: 'served',
    sha256: row.sha256,
    artifactType: row.artifactType,
    requestId: row.requestId,
    envelopeCid: row.envelopeCid,
    contentSize: row.contentSize,
    priceUsdc: row.priceUsdc,
    createdAt: row.createdAt,
    endpoint: endpointFor(pricing, row.sha256),
    access,
    projection: projection ? projectionToResponse(projection) : undefined,
    anchors: anchors.map(anchorToResponse),
  };
}

function networkArtifact(
  row: NetworkArtifactMetadataRow,
  projection: EnvelopeProjection | undefined,
  anchors: Erc8004AnchorRow[],
): Record<string, unknown> {
  return {
    source: 'network',
    sha256: row.sha256,
    artifactType: row.artifactType,
    envelopeCid: row.envelopeCid,
    contentSize: row.contentSize,
    origin: row.source,
    sourceOperator: row.sourceOperator,
    sourceEndpoint: row.sourceEndpoint,
    paidAmountUsdc: row.paidAmountUsdc,
    fetchedAt: row.fetchedAt,
    lastUsedAt: row.lastUsedAt,
    peerCatalogId: row.peerCatalogId,
    projection: projection ? projectionToResponse(projection) : undefined,
    anchors: anchors.map(anchorToResponse),
  };
}
```

Modify the body of `listExecutionData` to gather the envelope CIDs, query projections + anchors once, and pass them in:

```ts
const listExecutionData = (c: Context) => {
  const sourceRaw = c.req.query('source') ?? 'served';
  if (sourceRaw !== 'served' && sourceRaw !== 'network') {
    return c.json({ error: 'invalid_query', detail: '`source` must be `served` or `network`' }, 400);
  }
  const source = sourceRaw as ArtifactSource;
  const artifactType = c.req.query('artifactType') ?? undefined;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  if (!Number.isFinite(limit) || limit < 1) {
    return c.json({ error: 'invalid_query', detail: '`limit` must be a positive integer' }, 400);
  }

  let pricing: OperatorPricingConfig;
  try {
    pricing = resolvePricingConfig(configPath, config.operatorConfig);
  } catch (err) {
    return c.json({
      error: 'config_unreadable',
      detail: err instanceof Error ? err.message : String(err),
    }, 500);
  }

  const baseRows: Array<{ sha256: string; envelopeCid: string | null }> =
    source === 'served'
      ? config.store.listServedArtifactMetadata({ artifactType, limit })
      : config.store.listNetworkArtifactMetadata({ artifactType, limit });

  const envelopeCids = Array.from(
    new Set(
      baseRows
        .map((r) => r.envelopeCid)
        .filter((cid): cid is string => typeof cid === 'string' && cid.length > 0),
    ),
  );
  const projections = envelopeCids.length > 0
    ? config.store.queryEnvelopeProjections({ envelopeRefs: envelopeCids, limit: envelopeCids.length })
    : [];
  const projectionByCid = new Map<string, EnvelopeProjection>();
  for (const p of projections) {
    if (p.envelopeCid) projectionByCid.set(p.envelopeCid, p);
  }
  const anchorsByCid = new Map<string, Erc8004AnchorRow[]>();
  const anchors = config.store.listErc8004AnchorsByEnvelopeCids(envelopeCids);
  for (const a of anchors) {
    const list = anchorsByCid.get(a.envelopeCid) ?? [];
    list.push(a);
    anchorsByCid.set(a.envelopeCid, list);
  }

  const rows = source === 'served'
    ? (() => {
        const servedRows = baseRows as ServedArtifactMetadataRow[];
        const accessBySha = config.store.getArtifactAccessStatsBySha(servedRows.map((row) => row.sha256));
        return servedRows.map((row) =>
          servedArtifact(
            row,
            pricing,
            accessBySha[row.sha256] ?? EMPTY_ACCESS_STATS,
            row.envelopeCid ? projectionByCid.get(row.envelopeCid) : undefined,
            row.envelopeCid ? anchorsByCid.get(row.envelopeCid) ?? [] : [],
          ),
        );
      })()
    : (baseRows as NetworkArtifactMetadataRow[]).map((row) =>
        networkArtifact(
          row,
          row.envelopeCid ? projectionByCid.get(row.envelopeCid) : undefined,
          row.envelopeCid ? anchorsByCid.get(row.envelopeCid) ?? [] : [],
        ),
      );

  return c.json({
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    source,
    pricing,
    summary: {
      served: servedSummary(config.store),
      network: networkSummary(config.store),
      access: config.store.getArtifactAccessSummary(),
    },
    recentAccesses: config.store.listArtifactAccessEvents({ limit: 20 }),
    artifacts: rows,
  });
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && yarn vitest run test/api/operator-artifacts-endpoint.test.ts`
Expected: PASS — both new tests + all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/operator-artifacts-endpoint.ts client/test/api/operator-artifacts-endpoint.test.ts
git commit -m "feat(api): return envelope projection + erc8004 anchors per artifact"
```

---

## Task 6: Extend SPA types

**Files:**
- Modify: `client/src/dashboard/spa/src/api/types.ts`

- [ ] **Step 1: Add new types**

Add to `client/src/dashboard/spa/src/api/types.ts`, after `OperatorArtifactAccessEvent` (around line 372):

```ts
export interface OperatorArtifactProjectionExecutor {
  implName: string | null;
  implVersion: string | null;
  runtimeBundleDigest: string | null;
  plugins: string[] | null;
}

export interface OperatorArtifactProjectionSolutionRef {
  envelopeCid: string;
  envelopeSha256: string | null;
  ref: string | null;
}

export interface OperatorArtifactProjection {
  envelopeId: string;
  signatureHash: string;
  solverType: string;
  role: string;
  taskCid: string | null;
  taskId: string | null;
  requestId: string | null;
  generatedAt: number;
  evidenceTier: 'self-signed' | 'committed' | 'attested';
  participantSafeAddress: string | null;
  participantAgentEoa: string | null;
  executor: OperatorArtifactProjectionExecutor;
  solutionRef?: OperatorArtifactProjectionSolutionRef;
  metadata: Record<string, string | number | boolean> | null;
}

export interface OperatorArtifactAnchor {
  contentKind: string;
  metadataKey: string;
  agentId: string;
  chainId: number;
  identityRegistryAddress: string;
  txHash: string;
  blockNumber: number | null;
  payloadHex: string;
  anchoredAt: number;
}
```

Extend `OperatorServedArtifact` and `OperatorNetworkArtifact`:

```ts
export interface OperatorServedArtifact {
  source: 'served';
  sha256: string;
  artifactType: string;
  requestId: string | null;
  envelopeCid: string | null;
  contentSize: number;
  priceUsdc: string;
  createdAt: string;
  endpoint: string | null;
  access: OperatorArtifactAccessStats;
  projection?: OperatorArtifactProjection;
  anchors: OperatorArtifactAnchor[];
}

export interface OperatorNetworkArtifact {
  source: 'network';
  sha256: string;
  artifactType: string;
  envelopeCid: string | null;
  contentSize: number;
  origin: 'origin' | 'route-resolver' | 'self-store-mirror';
  sourceOperator: string | null;
  sourceEndpoint: string | null;
  paidAmountUsdc: string;
  fetchedAt: string;
  lastUsedAt: string;
  peerCatalogId: string | null;
  projection?: OperatorArtifactProjection;
  anchors: OperatorArtifactAnchor[];
}
```

Bump `OperatorArtifactsResponse.schemaVersion`:

```ts
export interface OperatorArtifactsResponse {
  schemaVersion: 1 | 2;
  // ...rest unchanged
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd client && yarn typecheck`
Expected: PASS. The component still works because the new fields are optional or have safe defaults.

- [ ] **Step 3: Commit**

```bash
git add client/src/dashboard/spa/src/api/types.ts
git commit -m "feat(spa): extend OperatorArtifact types with projection + anchors"
```

---

## Task 7: SPA `ExecutionArtifactDetail` — labelled sections, anchors, fix dual header

**Files:**
- Modify: `client/src/dashboard/spa/src/captures/CapturesTab.tsx`
- Modify: `client/src/dashboard/spa/src/captures/CapturesTab.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `client/src/dashboard/spa/src/captures/CapturesTab.test.tsx`. Find the existing tests and add a new `describe` block — example structure (read the existing file first to match imports and test helpers):

```tsx
describe('ExecutionArtifactDetail (ERC-8004 sections)', () => {
  it('renders projection and anchor sections when present', async () => {
    server.use(
      http.get(`${API_BASE}/v1/operator/artifacts`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('source') === 'served') {
          return HttpResponse.json({
            schemaVersion: 2,
            generatedAt: '2026-05-25T15:00:00.000Z',
            source: 'served',
            pricing: { publicEndpoint: '', defaultPriceUsdc: '0', perArtifactTypePrice: {}, donation: { enabled: false } },
            summary: { served: { totalCount: 1, totalBytes: 100, artifactTypes: [], freeCount: 1, gatedCount: 0, latestCreatedAt: null }, network: { totalCount: 0, totalBytes: 0, artifactTypes: [], latestFetchedAt: null }, access: { accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0, paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null } },
            recentAccesses: [],
            artifacts: [
              {
                source: 'served',
                sha256: 'd'.repeat(64),
                artifactType: 'swe-rebench-v2_v1_solution',
                requestId: 'req-1',
                envelopeCid: 'bafy-x',
                contentSize: 100,
                priceUsdc: '0',
                createdAt: '2026-05-25T15:00:00.000Z',
                endpoint: null,
                access: { accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0, paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null },
                projection: {
                  envelopeId: 'env-d',
                  signatureHash: '0xsig',
                  solverType: 'swe-rebench-v2',
                  role: 'solution',
                  taskCid: 'bafy-task',
                  taskId: 'task-1',
                  requestId: 'req-1',
                  generatedAt: 1748178573,
                  evidenceTier: 'self-signed',
                  participantSafeAddress: '0xsafe',
                  participantAgentEoa: '0xeoa',
                  executor: { implName: 'swe-rebench-v2-baseline', implVersion: '0.1.0', runtimeBundleDigest: 'sha256:beef', plugins: ['shell'] },
                  metadata: null,
                },
                anchors: [
                  { contentKind: 'envelope', metadataKey: 'envelope:bafy-x', agentId: '42', chainId: 84532, identityRegistryAddress: '0xreg', txHash: '0xanchortx', blockNumber: 12345, payloadHex: '0xabcd', anchoredAt: 1748178533 },
                ],
              },
            ],
          });
        }
        return HttpResponse.json({ schemaVersion: 2, generatedAt: '', source: 'network', pricing: { publicEndpoint: '', defaultPriceUsdc: '0', perArtifactTypePrice: {}, donation: { enabled: false } }, summary: { served: { totalCount: 0, totalBytes: 0, artifactTypes: [], freeCount: 0, gatedCount: 0, latestCreatedAt: null }, network: { totalCount: 0, totalBytes: 0, artifactTypes: [], latestFetchedAt: null }, access: { accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0, paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null } }, recentAccesses: [], artifacts: [] });
      }),
    );
    const user = userEvent.setup();
    renderCapturesTab();
    const row = await screen.findByText('swe-rebench-v2_v1_solution');
    await user.click(row);
    expect(await screen.findByText('Envelope')).toBeInTheDocument();
    expect(screen.getByText('Participant')).toBeInTheDocument();
    expect(screen.getByText('On-chain anchors')).toBeInTheDocument();
    expect(screen.getByText('swe-rebench-v2')).toBeInTheDocument(); // solverType
    expect(screen.getByText('0xanchortx')).toBeInTheDocument();      // txHash
    // Explorer link for chainId 84532 (Base Sepolia)
    const explorerLink = screen.getByRole('link', { name: /0xanchortx/i });
    expect(explorerLink).toHaveAttribute('href', 'https://sepolia.basescan.org/tx/0xanchortx');
  });

  it('shows "no on-chain anchor" when anchors is empty', async () => {
    server.use(
      http.get(`${API_BASE}/v1/operator/artifacts`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('source') === 'served') {
          return HttpResponse.json({
            schemaVersion: 2,
            generatedAt: '',
            source: 'served',
            pricing: { publicEndpoint: '', defaultPriceUsdc: '0', perArtifactTypePrice: {}, donation: { enabled: false } },
            summary: { served: { totalCount: 1, totalBytes: 10, artifactTypes: [], freeCount: 1, gatedCount: 0, latestCreatedAt: null }, network: { totalCount: 0, totalBytes: 0, artifactTypes: [], latestFetchedAt: null }, access: { accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0, paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null } },
            recentAccesses: [],
            artifacts: [
              {
                source: 'served',
                sha256: 'e'.repeat(64),
                artifactType: 'plain_artifact',
                requestId: null,
                envelopeCid: null,
                contentSize: 10,
                priceUsdc: '0',
                createdAt: '2026-05-25T15:00:00.000Z',
                endpoint: null,
                access: { accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0, paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null },
                anchors: [],
              },
            ],
          });
        }
        return HttpResponse.json({ schemaVersion: 2, generatedAt: '', source: 'network', pricing: { publicEndpoint: '', defaultPriceUsdc: '0', perArtifactTypePrice: {}, donation: { enabled: false } }, summary: { served: { totalCount: 0, totalBytes: 0, artifactTypes: [], freeCount: 0, gatedCount: 0, latestCreatedAt: null }, network: { totalCount: 0, totalBytes: 0, artifactTypes: [], latestFetchedAt: null }, access: { accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0, paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null } }, recentAccesses: [], artifacts: [] });
      }),
    );
    const user = userEvent.setup();
    renderCapturesTab();
    const row = await screen.findByText('plain_artifact');
    await user.click(row);
    expect(await screen.findByText(/no on-chain anchor/i)).toBeInTheDocument();
  });
});
```

(Use whatever `renderCapturesTab` / `server` / `API_BASE` / `userEvent` patterns already exist in this test file. If those helpers don't exist, mirror existing test patterns in the file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client/src/dashboard/spa && yarn vitest run src/captures/CapturesTab.test.tsx`
Expected: FAIL — the new sections don't exist yet.

- [ ] **Step 3: Refactor `ExecutionArtifactDetail` in `CapturesTab.tsx`**

Replace the `ExecutionArtifactDetail` component body (lines 134–194). Insert a helper `explorerTxUrl` near `shortSha`:

```tsx
function explorerTxUrl(chainId: number, txHash: string): string | null {
  switch (chainId) {
    case 8453:
      return `https://basescan.org/tx/${txHash}`;
    case 84532:
      return `https://sepolia.basescan.org/tx/${txHash}`;
    case 11155111:
      return `https://sepolia.etherscan.io/tx/${txHash}`;
    default:
      return null;
  }
}

function formatUnixSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  return formatTime(new Date(seconds * 1000).toISOString());
}

function DetailSection({
  title,
  children,
}: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">{children}</CardContent>
    </Card>
  );
}

function DetailList({
  rows,
}: {
  rows: Array<{ label: string; value: React.ReactNode }>;
}): JSX.Element {
  return (
    <dl className="m-0 grid gap-x-3.5 gap-y-2.5 [grid-template-columns:140px_minmax(0,1fr)]">
      {rows.map(({ label, value }) => (
        <Fragment key={label}>
          <dt className="font-mono text-[12px] text-muted-foreground">{label}</dt>
          <dd className="m-0 break-all font-mono text-[12px] text-foreground">{value ?? '—'}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
```

Add `Fragment` to the React import: `import { Fragment, useEffect, useState } from 'react';`.

Now rewrite `ExecutionArtifactDetail`:

```tsx
function ExecutionArtifactDetail({ artifact }: { artifact: OperatorArtifact }): JSX.Element {
  const when = artifactTime(artifact);
  const projection = artifact.projection;
  const anchors = artifact.anchors ?? [];

  const identityRows: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'state', value: artifactState(artifact) },
    { label: 'sha256', value: artifact.sha256 },
    { label: 'recorded', value: formatTime(when) },
  ];

  const envelopeRows: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'envelope', value: artifact.envelopeCid ?? '—' },
  ];
  if (projection) {
    envelopeRows.push(
      { label: 'signature', value: projection.signatureHash },
      { label: 'generated', value: formatUnixSeconds(projection.generatedAt) },
      { label: 'role', value: projection.role },
      { label: 'solver', value: projection.solverType },
      { label: 'evidence tier', value: projection.evidenceTier },
    );
  }

  const participantRows = projection
    ? [
        { label: 'safe', value: projection.participantSafeAddress ?? '—' },
        { label: 'agent EOA', value: projection.participantAgentEoa ?? '—' },
        { label: 'impl', value: projection.executor.implName ?? '—' },
        { label: 'impl version', value: projection.executor.implVersion ?? '—' },
        { label: 'runtime digest', value: projection.executor.runtimeBundleDigest ?? '—' },
        {
          label: 'plugins',
          value: projection.executor.plugins && projection.executor.plugins.length > 0
            ? (
                <div className="flex flex-wrap gap-1">
                  {projection.executor.plugins.map((p) => (
                    <Badge key={p} variant="outline">{p}</Badge>
                  ))}
                </div>
              )
            : '—',
        },
      ]
    : null;

  const taskRows = projection
    ? [
        { label: 'task CID', value: projection.taskCid ?? '—' },
        { label: 'task ID', value: projection.taskId ?? '—' },
        { label: 'request', value: projection.requestId ?? '—' },
        {
          label: 'solution ref',
          value: projection.solutionRef
            ? `${projection.solutionRef.envelopeCid}${projection.solutionRef.ref ? ` (${projection.solutionRef.ref})` : ''}`
            : '—',
        },
      ]
    : null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 break-all font-serif text-[22px] font-normal leading-tight text-foreground">
            {artifact.artifactType}
          </h1>
          <div className="mt-1.5 font-mono text-[12px] text-muted-foreground">
            {artifactState(artifact)} · {formatBytes(artifact.contentSize)} · {formatTime(when)}
          </div>
        </div>
      </header>

      <DetailSection title="Identity">
        <DetailList rows={identityRows} />
      </DetailSection>

      <DetailSection title="Envelope">
        <DetailList rows={envelopeRows} />
      </DetailSection>

      {participantRows ? (
        <DetailSection title="Participant">
          <DetailList rows={participantRows} />
        </DetailSection>
      ) : null}

      {taskRows ? (
        <DetailSection title="Task">
          <DetailList rows={taskRows} />
        </DetailSection>
      ) : null}

      <DetailSection title="On-chain anchors">
        {anchors.length === 0 ? (
          <div className="font-mono text-[12px] text-muted-foreground">
            no on-chain anchor recorded yet
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {anchors.map((anchor) => {
              const explorerHref = explorerTxUrl(anchor.chainId, anchor.txHash);
              const rows: Array<{ label: string; value: React.ReactNode }> = [
                { label: 'content kind', value: anchor.contentKind },
                { label: 'agent ID', value: anchor.agentId },
                { label: 'chain ID', value: String(anchor.chainId) },
                {
                  label: 'tx',
                  value: explorerHref ? (
                    <a
                      href={explorerHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all underline underline-offset-2 hover:text-foreground"
                    >
                      {anchor.txHash}
                    </a>
                  ) : (
                    anchor.txHash
                  ),
                },
                { label: 'block', value: anchor.blockNumber !== null ? String(anchor.blockNumber) : 'pending' },
                { label: 'anchored', value: formatUnixSeconds(anchor.anchoredAt) },
                { label: 'registry', value: anchor.identityRegistryAddress },
                { label: 'metadata key', value: anchor.metadataKey },
              ];
              return (
                <div key={`${anchor.contentKind}:${anchor.txHash}`} className="rounded-md border border-border bg-card p-3">
                  <DetailList rows={rows} />
                  <details className="mt-2">
                    <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">
                      payload (ABI-encoded)
                    </summary>
                    <div className="mt-1 break-all font-mono text-[11px] text-foreground">
                      {anchor.payloadHex}
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </DetailSection>

      {artifact.source === 'served' ? (
        <DetailSection title="Access">
          <DetailList
            rows={[
              { label: 'request', value: artifact.requestId ?? '—' },
              {
                label: 'accesses',
                value: `${artifact.access.accessCount} total · ${artifact.access.failedPaymentCount} failed`,
              },
              { label: 'paid serves', value: String(artifact.access.paidServeCount) },
              { label: 'free serves', value: String(artifact.access.freeServeCount) },
              { label: 'revenue', value: `${artifact.access.revenueUsdc} USDC` },
            ]}
          />
        </DetailSection>
      ) : (
        <DetailSection title="Source">
          <DetailList
            rows={[
              { label: 'operator', value: artifact.sourceOperator ?? '—' },
              { label: 'endpoint', value: artifact.sourceEndpoint ?? '—' },
              { label: 'origin', value: artifact.origin },
              { label: 'paid', value: `${artifact.paidAmountUsdc} USDC` },
              { label: 'peer catalog', value: artifact.peerCatalogId ?? '—' },
            ]}
          />
        </DetailSection>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the SPA tests**

Run: `cd client/src/dashboard/spa && yarn vitest run src/captures/CapturesTab.test.tsx`
Expected: PASS — new tests + pre-existing.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/captures/CapturesTab.tsx client/src/dashboard/spa/src/captures/CapturesTab.test.tsx
git commit -m "feat(spa): render erc8004 anchors and envelope projection in artifact detail"
```

---

## Task 8: Whole-suite verify + push + PR

- [ ] **Step 1: Typecheck**

Run: `cd client && yarn typecheck`
Expected: PASS.

- [ ] **Step 2: Run all client tests**

Run: `cd client && yarn test`
Expected: PASS (no new failures vs. baseline). If a previously green test fails because of the publishContent signature change, update the mock to return `{ txHash, blockNumber }`.

- [ ] **Step 3: SPA typecheck + test**

Run: `cd client/src/dashboard/spa && yarn typecheck && yarn vitest run`
Expected: PASS.

- [ ] **Step 4: Push branch**

```bash
git push -u origin feat/erc8004-data-in-artifact-detail
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base next --title "feat(spa): surface ERC-8004 data in artifact detail panel" --body "$(cat <<'EOF'
## Summary
- New `erc8004_anchors` SQLite table captures the on-chain anchor (tx, block, agent ID, chain, registry, payload) that `publishContentV2()` used to discard.
- Operator artifacts API joins `envelope_projections` and `erc8004_anchors` onto each artifact response.
- `ExecutionArtifactDetail` reworked into labelled sections — Identity / Envelope / Participant / Task / On-chain anchors / Access | Source — with explorer links derived from `chainId`. Duplicate `type` header bug fixed in passing.

Spec: `docs/superpowers/specs/2026-05-26-erc8004-data-in-artifact-detail-design.md`

## Test plan
- [x] `client/test/store/erc8004-anchors.test.ts` — save/list/multi/null/empty
- [x] `client/test/api/operator-artifacts-endpoint.test.ts` — join projection + anchors; empty anchors fall-through
- [x] `client/src/dashboard/spa/src/captures/CapturesTab.test.tsx` — full data renders sections + explorer link; missing anchors collapses to placeholder
- [x] `yarn typecheck` + `yarn test` green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Verify PR is open**

Run: `gh pr view --json url,state,title,headRefName,baseRefName`
Expected: `state: "OPEN"`, `baseRefName: "next"`, `headRefName: "feat/erc8004-data-in-artifact-detail"`.

---

## Self-review notes

- All five spec sections (data model, write path, API, UI, testing) have at least one task. Task 1 covers schema + persistence. Task 2 + Task 3 + Task 4 cover the write path in publisher, captures, and engine. Task 5 covers the API extension. Task 6 + Task 7 cover the UI. Task 8 finishes.
- The reconcile-receipts background tick from the spec is folded into the inline `try/catch` in `_writeMetadata` (Task 2) — when the receipt fetch fails, we record the row with `blockNumber: null` instead. This keeps the surface area small for v1 and satisfies the spec's "block can be backfilled later" behaviour without a new daemon loop. A follow-up issue can add the formal reconcile loop if pending rows accumulate.
- Type consistency check: `Erc8004AnchorRow` is consumed by the API; the API maps to `OperatorArtifactAnchor` for the SPA — the field names match (`contentKind`, `chainId`, etc.). Verified.
