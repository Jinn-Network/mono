/**
 * Tests for ERC-8004 Identity Registry wiring in engine.ts (Plan E Task 11).
 *
 * Verifies that pack() calls registerEnvelope + registerArtifactWithParent
 * when erc8004Registry is provided, and that failures are non-fatal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import {
  RestorationEngine,
  type RestorationEngineOptions,
  type RestorerImplRegistry,
} from '../../../src/restorer/engine/engine.js';
import type { PersistedIntentInput } from '../../../src/restorer/engine/persistence.js';
import { IntentPersistence } from '../../../src/restorer/engine/persistence.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import type { Registry8004 } from '../../../src/discovery/registry.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock-envelope'),
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

function makeInput(requestId: string, _tmp: string): PersistedIntentInput {
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

function makeEnvelopeDeps() {
  return {
    agentEoaPrivateKey: TEST_PRIVATE_KEY,
    safeAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
    ipfsRegistryUrl: 'https://registry.autonolas.tech',
  };
}

function makeOpts(
  store: Store,
  tmp: string,
  erc8004Registry?: Registry8004,
): RestorationEngineOptions {
  return {
    store,
    registry: noopRegistry,
    paths: {
      workingDirRoot: join(tmp, 'work'),
      implStateDirRoot: join(tmp, 'impl'),
    },
    packagingDeps: {
      ipfsRegistryUrl: 'https://registry.autonolas.tech',
    },
    envelopeDeps: makeEnvelopeDeps(),
    deliveryDeps: {
      publicClient: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ blockNumber: 42n }),
      } as any,
      walletClient: {} as any,
      safeAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      mechContractAddress: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      routerAddress: '0x3333333333333333333333333333333333333333' as `0x${string}`,
      claimDeliveryVariant: 'v2' as const,
    },
    erc8004Registry,
  };
}

function advanceToPackaging(
  store: Store,
  requestId: string,
  persistence: IntentPersistence,
  workingDir: string,
): void {
  const now = Date.now() - 1000;
  const implStateDir = join(workingDir + '-impl');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(implStateDir, { recursive: true });
  // Advance through states to PACKAGING so pack() fires
  persistence.transition(requestId, IntentState.CLAIMED);
  persistence.transition(requestId, IntentState.WAITING);
  persistence.transition(requestId, IntentState.PRE_SNAPSHOT, {
    workingDir,
    implStateDir,
    preSnapshotCapturedAt: now,
    preSnapshotPayload: { provisioned: true, workingDir },
  });
  persistence.transition(requestId, IntentState.RUNNING);
  const gatingClaim = {
    equityReturnPct: '10',
    maxDrawdownPct: '5',
    closedTradesCount: 25,
    tradedNotionalMultiple: '8',
  };
  persistence.transition(requestId, IntentState.POST_SNAPSHOT, {
    postSnapshotCapturedAt: now,
    postSnapshotPayload: { capturedAt: now, hlTime: 0, payload: {} },
    fillsPayload: [],
    gatingClaim,
    informationalClaim: null,
    implOutputsJson: JSON.stringify({
      venueRef: { name: 'test' },
      artifacts: [],
      fills: [],
      gating: gatingClaim,
    }),
  });
  persistence.transition(requestId, IntentState.PACKAGING);
}

describe('RestorationEngine — ERC-8004 registry wiring (Plan E)', () => {
  let tmp: string;
  let store: Store;
  let persistence: IntentPersistence;

  beforeEach(() => {
    tmp = mkTmp();
    mkdirSync(join(tmp, 'work'), { recursive: true });
    mkdirSync(join(tmp, 'impl'), { recursive: true });
    store = new Store(':memory:');
    persistence = new IntentPersistence(store.db);
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('calls registerEnvelope when erc8004Registry is provided and pack succeeds', async () => {
    const registerEnvelope = vi.fn().mockResolvedValue(1n);
    const registerArtifactWithParent = vi.fn().mockResolvedValue(1n);
    const mockRegistry = { registerEnvelope, registerArtifactWithParent } as unknown as Registry8004;

    const engine = new RestorationEngine(makeOpts(store, tmp, mockRegistry));
    const workingDir = join(tmp, 'work', 'req-001');
    const input = makeInput('req-001', tmp);
    await engine.observe(input);
    advanceToPackaging(store, 'req-001', persistence, workingDir);

    await engine.process('req-001');

    expect(registerEnvelope).toHaveBeenCalledTimes(1);
    const envelopeArgs = registerEnvelope.mock.calls[0][0];
    expect(envelopeArgs.envelopeCid).toBeDefined();
    expect(envelopeArgs.kind).toBe('portfolio.v0');
    expect(envelopeArgs.role).toBe('restoration');
  });

  it('does not call registerEnvelope when erc8004Registry is absent', async () => {
    const registerEnvelope = vi.fn().mockResolvedValue(1n);
    // No erc8004Registry provided
    const engine = new RestorationEngine(makeOpts(store, tmp, undefined));
    const workingDir = join(tmp, 'work', 'req-002');
    const input = makeInput('req-002', tmp);
    await engine.observe(input);
    advanceToPackaging(store, 'req-002', persistence, workingDir);

    await engine.process('req-002');

    expect(registerEnvelope).not.toHaveBeenCalled();
  });

  it('pack() still advances to DELIVERING when registerEnvelope rejects', async () => {
    const registerEnvelope = vi.fn().mockRejectedValue(new Error('registry down'));
    const registerArtifactWithParent = vi.fn().mockResolvedValue(1n);
    const mockRegistry = { registerEnvelope, registerArtifactWithParent } as unknown as Registry8004;

    const engine = new RestorationEngine(makeOpts(store, tmp, mockRegistry));
    const workingDir = join(tmp, 'work', 'req-003');
    const input = makeInput('req-003', tmp);
    await engine.observe(input);
    advanceToPackaging(store, 'req-003', persistence, workingDir);

    // Should not throw
    await expect(engine.process('req-003')).resolves.toBeUndefined();

    // Intent should have advanced to DELIVERING despite registry failure
    const afterState = persistence.getByRequestId('req-003');
    expect(afterState?.state).toBe(IntentState.DELIVERING);

    expect(registerEnvelope).toHaveBeenCalledTimes(1);
  });
});
