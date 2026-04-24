/**
 * Tests for ERC-8004 Identity Registry wiring in engine.ts (Plan E Task 11).
 *
 * Verifies that pack() calls registry.registerEnvelope and
 * registry.registerArtifactWithParent for each artifact, and that pack()
 * still completes (DELIVERING state) when registration fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import {
  RestorationEngine,
  type RestorationEngineOptions,
  type RestorerImplRegistry,
} from '../../../src/restorer/engine/engine.js';
import { IntentPersistence, type PersistedIntentInput } from '../../../src/restorer/engine/persistence.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import type { Registry8004 } from '../../../src/discovery/registry.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000' as `0x${string}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;

const noopRegistry: RestorerImplRegistry = {
  resolveImplName: () => null,
};

function mkTmp(): string {
  const dir = join(tmpdir(), `eng-reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeInput(requestId: string): PersistedIntentInput {
  const now = Date.now() - 1000;
  return {
    requestId,
    intentCid: 'bafyintent123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    specKind: 'portfolio.v0',
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    desiredState: { id: requestId, description: 'test' },
  };
}

function makeOpts(store: Store, tmp: string, erc8004Registry?: Registry8004): RestorationEngineOptions {
  return {
    store,
    registry: noopRegistry,
    paths: {
      workingDirRoot: join(tmp, 'restorations'),
      implStateDirRoot: join(tmp, 'impls'),
    },
    packagingDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      registerArtifact: vi.fn(),
    },
    manifestDeps: {
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
    erc8004Registry,
  };
}

/** Provision a minimal working directory so pack() has artifacts to walk. */
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Engine ERC-8004 registry wiring (Plan E Task 11)', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('calls registerEnvelope once and registerArtifactWithParent for each artifact when registry is provided', async () => {
    const registerEnvelopeMock = vi.fn().mockResolvedValue(1n);
    const registerArtifactWithParentMock = vi.fn().mockResolvedValue(2n);
    const mockRegistry = {
      registerEnvelope: registerEnvelopeMock,
      registerArtifactWithParent: registerArtifactWithParentMock,
    } as unknown as Registry8004;

    const engine = new TestEngine(makeOpts(store, tmp, mockRegistry));
    const requestId = 'req-reg-01';
    const workingDir = provisionWorkDir(tmp, requestId);

    await engine.observe(makeInput(requestId));
    const p = engine.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impls', 'test'),
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
    });
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
      fillsPayload: [],
      gatingClaim: {},
    });
    p.transition(requestId, IntentState.PACKAGING);

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.DELIVERING);

    // registerEnvelope should have been called once
    expect(registerEnvelopeMock).toHaveBeenCalledTimes(1);
    expect(registerEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envelopeCid: 'bafymock123',
        kind: 'portfolio.v0',
        role: 'restoration',
        evidenceTier: 'self-signed',
        intentCid: 'bafyintent123',
      }),
    );

    // registerArtifactWithParent should have been called for each artifact
    // (at least one call since we wrote session.jsonl)
    expect(registerArtifactWithParentMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of registerArtifactWithParentMock.mock.calls) {
      expect(call[0]).toMatchObject({
        parentEnvelopeCid: 'bafymock123',
      });
    }
  });

  it('pack() still advances to DELIVERING even when registerEnvelope throws', async () => {
    const registerEnvelopeMock = vi.fn().mockRejectedValue(new Error('registry unreachable'));
    const registerArtifactWithParentMock = vi.fn().mockResolvedValue(2n);
    const mockRegistry = {
      registerEnvelope: registerEnvelopeMock,
      registerArtifactWithParent: registerArtifactWithParentMock,
    } as unknown as Registry8004;

    const engine = new TestEngine(makeOpts(store, tmp, mockRegistry));
    const requestId = 'req-reg-02';
    const workingDir = provisionWorkDir(tmp, requestId);

    await engine.observe(makeInput(requestId));
    const p = engine.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impls', 'test'),
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
    });
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
      fillsPayload: [],
      gatingClaim: {},
    });
    p.transition(requestId, IntentState.PACKAGING);

    // Should not throw despite registry failure
    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.DELIVERING);
    expect(intent.manifestCid).toBe('bafymock123');
  });

  it('does NOT call registerEnvelope when erc8004Registry is absent', async () => {
    // Engine without erc8004Registry
    const engine = new TestEngine(makeOpts(store, tmp));
    const requestId = 'req-reg-03';
    const workingDir = provisionWorkDir(tmp, requestId);

    await engine.observe(makeInput(requestId));
    const p = engine.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impls', 'test'),
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
    });
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
      fillsPayload: [],
      gatingClaim: {},
    });
    p.transition(requestId, IntentState.PACKAGING);

    await engine.process(requestId);
    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.DELIVERING);
    // No registry calls — simply verify no errors and state advances
  });
});
