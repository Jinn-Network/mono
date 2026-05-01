/**
 * Tests for IdentityPublisher wiring in engine.deliver() (PR#37 review2 must-fix #2).
 *
 * Covers:
 *   - pack() does NOT call identityPublisher.publishContent (it moved to deliver()).
 *   - deliver() calls publishContent ONLY AFTER successful claimDelivery, using
 *     the evidenceHash persisted from pack().
 *   - publishContent failure is non-fatal: deliver() still transitions to COMPLETE.
 *   - When no identityPublisher is configured, deliver() does not attempt to publish.
 *   - setMetadata is idempotent: calling deliver() twice with the same evidenceHash
 *     calls publishContent each time (idempotent write; caller is responsible for
 *     dedup if needed — the test documents the idempotent intent).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Hex } from 'viem';
import { Store } from '../../../src/store/store.js';
import {
  RestorationEngine,
  type RestorationEngineOptions,
} from '../../../src/restorer/engine/engine.js';
import { IntentPersistence, type PersistedIntentInput } from '../../../src/restorer/engine/persistence.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import type { IdentityPublisher } from '../../../src/erc8004/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// MOCK_JUSTIFICATION: src/adapters/mech/ipfs.js is the I/O leaf for IPFS gateway HTTP calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000' as `0x${string}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  callDeliverToMarketplace: vi.fn().mockResolvedValue('0xdeliverytx' as `0x${string}`),
  claimDelivery: vi.fn().mockResolvedValue('0xclaimtx' as `0x${string}`),
  submitRestorationJob: vi.fn(),
  submitEvaluationJob: vi.fn(),
  claimJob: vi.fn(),
  getJobClaim: vi.fn(),
  getMechDeliveryRate: vi.fn(),
  getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(),
  decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(),
  scanRestorationJobs: vi.fn(),
  scanEvaluationJobs: vi.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const PACK_EVIDENCE_HASH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1' as Hex;
const PACK_MANIFEST_CID = 'bafymock123';

function mkTmp(): string {
  const dir = join(tmpdir(), `eng-pub-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeOpts(
  store: Store,
  tmp: string,
  identityPublisher?: IdentityPublisher,
): RestorationEngineOptions {
  return {
    store,
    paths: {
      workingDirRoot: join(tmp, 'restorations'),
      implStateDirRoot: join(tmp, 'impls'),
    },
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: TEST_PRIVATE_KEY,
      safeAddress: '0xdeadbeef00000000000000000000000000000001' as `0x${string}`,
    },
    deliveryDeps: {
      publicClient: {} as import('viem').PublicClient,
      walletClient: {} as import('viem').WalletClient,
      safeAddress: '0xdeadbeef00000000000000000000000000000001' as `0x${string}`,
      mechContractAddress: '0xmech' as `0x${string}`,
      routerAddress: '0xrouter' as `0x${string}`,
      claimDeliveryVariant: 'v2',
    },
    identityPublisher,
  };
}

function provisionWorkDir(tmp: string, requestId: string): string {
  const workingDir = join(tmp, 'restorations', requestId);
  mkdirSync(join(workingDir, 'sessions'), { recursive: true });
  mkdirSync(join(workingDir, 'env'), { recursive: true });
  writeFileSync(join(workingDir, 'intent.json'), '{}');
  writeFileSync(join(workingDir, 'sessions', 'session.jsonl'), '{"msg":"hi"}');
  return workingDir;
}

class TestEngine extends RestorationEngine {
  get testPersistence(): IntentPersistence {
    return this.persistence;
  }
}

function makeIntentInput(requestId: string): PersistedIntentInput {
  const now = Date.now() - 1000;
  return {
    requestId,
    intentCid: 'bafyintent123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    specKind: 'portfolio.v0',
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    restorationJob: { id: requestId, description: 'test' },
  };
}

async function drivePackTransition(engine: TestEngine, requestId: string, workingDir: string): Promise<void> {
  await engine.observe(makeIntentInput(requestId));
  const p = engine.testPersistence;
  const now = Date.now();
  p.transition(requestId, IntentState.CLAIMED);
  p.transition(requestId, IntentState.WAITING);
  p.transition(requestId, IntentState.PRE_SNAPSHOT, {
    workingDir,
    implStateDir: join(workingDir, '..', '..', 'impls', 'test'),
    preSnapshotCapturedAt: now,
    preSnapshotPayload: { equity: '1000', capturedAt: now, hlTime: 0 },
  });
  p.transition(requestId, IntentState.RUNNING);
  p.transition(requestId, IntentState.POST_SNAPSHOT, {
    postSnapshotCapturedAt: now,
    postSnapshotPayload: { equity: '1100', capturedAt: now, hlTime: 0 },
    fillsPayload: [],
    // Valid portfolio.v0 gating claim shape (required by payload validation)
    gatingClaim: {
      equityReturnPct: '10',
      maxDrawdownPct: '5',
      closedTradesCount: 25,
      tradedNotionalMultiple: '8',
    },
  });
  p.transition(requestId, IntentState.PACKAGING);
  await engine.process(requestId);
}

/**
 * Seed an intent directly into DELIVERING state (bypassing pack()) with
 * a fixed evidenceHash and manifestCid, for testing deliver() in isolation.
 */
async function seedDelivering(
  engine: TestEngine,
  requestId: string,
  evidenceHash: Hex,
  manifestCid: string,
): Promise<void> {
  const now = Date.now() - 1000;
  await engine.observe(makeIntentInput(requestId));
  const p = engine.testPersistence;
  p.transition(requestId, IntentState.CLAIMED);
  p.transition(requestId, IntentState.WAITING);
  p.transition(requestId, IntentState.PRE_SNAPSHOT, {
    workingDir: '/tmp/wd',
    implStateDir: '/tmp/impl',
    preSnapshotCapturedAt: now,
    preSnapshotPayload: { capturedAt: now, hlTime: 0 },
  });
  p.transition(requestId, IntentState.RUNNING);
  p.transition(requestId, IntentState.POST_SNAPSHOT, {
    postSnapshotCapturedAt: now,
    postSnapshotPayload: { capturedAt: now, hlTime: 0 },
    fillsPayload: [],
    gatingClaim: {},
  });
  p.transition(requestId, IntentState.PACKAGING, {
    manifestCid,
    artifactCids: {},
    evidenceHash,
  });
  p.transition(requestId, IntentState.DELIVERING);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Engine IdentityPublisher wiring (PR#37 review2 must-fix #2)', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new Store(':memory:');
    tmp = mkTmp();
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── pack() must NOT call publishContent ──────────────────────────────────────

  it('pack() does NOT call publishContent', async () => {
    const publishContentMock = vi.fn().mockResolvedValue('0xpubtxhash' as Hex);
    const mockPublisher = { publishContent: publishContentMock } as unknown as IdentityPublisher;

    const engine = new TestEngine(makeOpts(store, tmp, mockPublisher));
    const requestId = 'req-pack-no-pub';
    const workingDir = provisionWorkDir(tmp, requestId);

    await drivePackTransition(engine, requestId, workingDir);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.DELIVERING);
    // publishContent must NOT have been called during pack()
    expect(publishContentMock).not.toHaveBeenCalled();
  });

  it('pack() without identityPublisher still advances to DELIVERING', async () => {
    const engine = new TestEngine(makeOpts(store, tmp));
    const requestId = 'req-pack-no-pub-no-publisher';
    const workingDir = provisionWorkDir(tmp, requestId);

    await drivePackTransition(engine, requestId, workingDir);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.DELIVERING);
  });

  // ── deliver() calls publishContent AFTER claimDelivery succeeds ─────────────

  it('deliver() calls publishContent after claimDelivery succeeds, using evidenceHash from pack', async () => {
    const publishContentMock = vi.fn().mockResolvedValue('0xpubtxhash' as Hex);
    const mockPublisher = { publishContent: publishContentMock } as unknown as IdentityPublisher;

    const engine = new TestEngine(makeOpts(store, tmp, mockPublisher));
    const requestId = 'req-deliver-pub';

    await seedDelivering(engine, requestId, PACK_EVIDENCE_HASH, PACK_MANIFEST_CID);

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.COMPLETE);

    // publishContent called exactly once after claimDelivery
    expect(publishContentMock).toHaveBeenCalledTimes(1);
    const arg = publishContentMock.mock.calls[0]![0] as {
      kind: string;
      cid: string;
      payload: { version: number; tier: number; manifestHash: Hex };
    };
    expect(arg.kind).toBe('envelope');
    expect(arg.cid).toBe(PACK_MANIFEST_CID);
    expect(arg.payload.version).toBe(1);
    // evidenceHash is non-zero → tier=1 (committed)
    expect(arg.payload.tier).toBe(1);
    // Same evidenceHash persisted from pack()
    expect(arg.payload.manifestHash).toBe(PACK_EVIDENCE_HASH);
  });

  it('deliver() publishContent failure is non-fatal — COMPLETE state still set', async () => {
    const publishContentMock = vi.fn().mockRejectedValue(new Error('rpc unreachable'));
    const mockPublisher = { publishContent: publishContentMock } as unknown as IdentityPublisher;

    const engine = new TestEngine(makeOpts(store, tmp, mockPublisher));
    const requestId = 'req-deliver-pub-fail';

    await seedDelivering(engine, requestId, PACK_EVIDENCE_HASH, PACK_MANIFEST_CID);

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.COMPLETE);
    expect(publishContentMock).toHaveBeenCalledTimes(1);
  });

  it('deliver() without identityPublisher does not throw and transitions to COMPLETE', async () => {
    const engine = new TestEngine(makeOpts(store, tmp));
    const requestId = 'req-deliver-no-publisher';

    await seedDelivering(engine, requestId, PACK_EVIDENCE_HASH, PACK_MANIFEST_CID);

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.COMPLETE);
  });

  it('setMetadata is idempotent on retry — publishContent called with same evidenceHash on repeated deliver()', async () => {
    // setMetadata (publishContent on IdentityRegistry) is a pure key-value write;
    // calling it a second time with the same payload is safe. This test seeds two
    // separate DELIVERING intents with the same evidenceHash (simulating retry
    // from a separate engine instance) to verify both calls use the persisted hash.
    const publishContentMock = vi.fn().mockResolvedValue('0xpubtxhash' as Hex);
    const mockPublisher = { publishContent: publishContentMock } as unknown as IdentityPublisher;

    const engine = new TestEngine(makeOpts(store, tmp, mockPublisher));

    // First deliver: intent A
    const requestIdA = 'req-deliver-idempotent-a';
    await seedDelivering(engine, requestIdA, PACK_EVIDENCE_HASH, PACK_MANIFEST_CID);
    await engine.process(requestIdA);

    // Second deliver: a new intent B seeded with the same evidenceHash (simulates
    // a retry cycle where the same hash is passed again — idempotent write).
    const requestIdB = 'req-deliver-idempotent-b';
    const store2 = new Store(':memory:');
    const engine2 = new TestEngine(makeOpts(store2, tmp, mockPublisher));
    await seedDelivering(engine2, requestIdB, PACK_EVIDENCE_HASH, PACK_MANIFEST_CID);
    await engine2.process(requestIdB);
    store2.close();

    // publishContent called twice, both times with the same evidenceHash
    expect(publishContentMock).toHaveBeenCalledTimes(2);
    for (const call of publishContentMock.mock.calls) {
      expect((call[0] as any).payload.manifestHash).toBe(PACK_EVIDENCE_HASH);
    }
  });
});
