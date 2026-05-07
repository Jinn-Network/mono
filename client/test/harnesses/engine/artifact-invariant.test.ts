/**
 * Cross-impl invariant: every COMPLETE cycle emits a SQLite artifact row.
 *
 * Background: deterministic impls (prediction-v0-baseline, prediction-v0-evaluator,
 * prediction-apy-v0-*, etc.) bypass MCP entirely. Before emitCycleArtifact was added
 * to deliver(), these impls silently produced no artifacts table row. The docker
 * acceptance gate, search API, and activity dashboard all read from that table;
 * they were green for legacy-claude traffic and dark for deterministic-impl traffic.
 *
 * This test suite enumerates all registered impls (via buildHarnesses in stub mode)
 * and asserts that, for each impl name, a cycle that reaches COMPLETE via deliver()
 * produces an artifacts row with the correct tag and outcome=SUCCESS.
 *
 * The test does NOT run the impls' run() methods — it manually advances persisted
 * state to DELIVERING (using the same mocking setup as engine-packaging.test.ts) and
 * calls process() to trigger deliver() → COMPLETE → emitCycleArtifact.
 *
 * Regression target: if emitCycleArtifact is removed from deliver(), or a new impl
 * class bypasses deliver() via a custom override that omits it, these tests fail.
 */

import { describe, it, expect, vi } from 'vitest';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import { buildHarnesses } from '../../../src/harnesses/impls/index.js';

// ── Mocks (same modules as engine-packaging.test.ts) ─────────────────────────

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
  submitTask: vi.fn(),
  submitEvaluationJob: vi.fn(),
  claimJob: vi.fn(),
  getJobClaim: vi.fn(),
  getMechDeliveryRate: vi.fn(),
  getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(),
  decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(),
  scanTasks: vi.fn(),
  scanEvaluationJobs: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const TEST_EVIDENCE_HASH = '0xaabbccdd00000000000000000000000000000000000000000000000000000000' as `0x${string}`;

const STUB_ENV = {
  stub: true as const,
  rpcUrl: 'http://stub',
  claudePath: 'claude',
  claudeModel: 'claude-haiku-4-5-20251001',
};

function roleForImpl(name: string): 'restoration' | 'evaluation' {
  return name.includes('evaluator') ? 'evaluation' : 'restoration';
}

function makeInput(
  requestId: string,
  role: 'restoration' | 'evaluation',
): PersistedTaskRunInput {
  const now = Date.now() - 1000;
  return {
    requestId,
    taskCid: 'bafyintent123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    solverType: 'test.v0',
    taskRole: role,
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    task: { id: requestId, description: 'invariant test', solverType: 'test.v0', role },
  };
}

function makeOpts(store: Store): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: TEST_PRIVATE_KEY,
      safeAddress: '0xsafe' as `0x${string}`,
    },
    deliveryDeps: {
      publicClient: {} as import('viem').PublicClient,
      walletClient: {} as import('viem').WalletClient,
      safeAddress: '0xsafe' as `0x${string}`,
      mechContractAddress: '0xmech' as `0x${string}`,
      routerAddress: '0xrouter' as `0x${string}`,
      claimDeliveryVariant: 'v2',
    },
  };
}

class InvariantTestEngine extends TaskEngine {
  get testPersistence(): TaskRunPersistence {
    return this.persistence;
  }
}

/**
 * Advance a task run from DISCOVERED to DELIVERING, setting implName and the
 * fields deliver() needs (manifestCid, evidenceHash).
 */
function advanceToDelivering(
  p: TaskRunPersistence,
  requestId: string,
  implName: string,
): void {
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  p.transition(requestId, TaskRunState.PRE_SNAPSHOT);
  p.transition(requestId, TaskRunState.RUNNING, { implName });
  p.transition(requestId, TaskRunState.POST_SNAPSHOT);
  p.transition(requestId, TaskRunState.PACKAGING);
  p.transition(requestId, TaskRunState.DELIVERING, {
    manifestCid: 'bafymanifest123',
    evidenceHash: TEST_EVIDENCE_HASH,
    implName,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Enumerate all registered impls in stub mode. legacy-claude is omitted here
// (it requires env.runner) — its artifact emission is covered by the existing
// e2e validate.ts test (which asserts the MCP submit_restoration_result path).
const REGISTERED_IMPLS = buildHarnesses(STUB_ENV);

describe('artifact-row invariant — every COMPLETE cycle emits a SQLite artifact row', () => {
  for (const impl of REGISTERED_IMPLS) {
    const role = roleForImpl(impl.name);
    const expectedTag = role === 'evaluation' ? 'evaluation-verdict' : 'restoration-result';

    it(`${impl.name} (${role}) → produces ${expectedTag} row with outcome=SUCCESS`, async () => {
      const store = new Store(':memory:');
      const engine = new InvariantTestEngine(makeOpts(store));

      try {
        const requestId = `req-${impl.name}`;

        await engine.observe(makeInput(requestId, role));
        advanceToDelivering(engine.testPersistence, requestId, impl.name);

        await engine.process(requestId);

        // Verify COMPLETE state
        const run = engine.testPersistence.getByRequestId(requestId)!;
        expect(run.state).toBe(TaskRunState.COMPLETE);

        // Core invariant: artifact row exists in the store
        const artifact = store.getArtifactByRequestId(requestId, expectedTag);
        expect(artifact, `no ${expectedTag} row for impl ${impl.name}`).not.toBeNull();
        expect(artifact!.outcome).toBe('SUCCESS');
        expect(artifact!.tags).toContain(expectedTag);
        expect(artifact!.tags).toContain('success');
      } finally {
        store.close();
      }
    });
  }
});
