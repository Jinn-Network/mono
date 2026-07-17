/**
 * Task 7: engine-side mineable-trace producer.
 *
 * pack() records a MineableTraceRecord (Task 6's MineableTraceStore) for
 * swe-rebench-v2-style restoration tasks whose spec carries repo identity
 * (repo + baseCommit) and whose impl produced a solution patch. Per mono#1714
 * the daemon always constructs the mineableStore (local retention is
 * unconditional); each record is stamped with the single `share` consent as
 * `publishMinedTasksConsent`, which governs whether the mint may be published.
 *
 * Spec: spec/2026-07-08-task-creator-v0.md §10.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import { MineableTraceStore } from '../../../src/solver-types/_swe-rebench-v2-mineable-store.js';
import type { Solution } from '../../../src/harnesses/types.js';

// ── Mocks (same boundary as engine-packaging.test.ts) ──────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const BASE_COMMIT = 'a'.repeat(40);

function mkTmp(): string {
  const dir = join(tmpdir(), `eng-mineable-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeInput(requestId: string, eligibility?: Record<string, unknown>): PersistedTaskRunInput {
  const now = Date.now() - 1000;
  return {
    requestId,
    taskCid: 'bafyintent123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    solverType: 'swe-rebench-v2.v1',
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    task: {
      id: requestId,
      description: 'test',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      spec: {
        schemaVersion: 'swe-rebench-v2.v1',
        instance_id: 'org__widget-1',
        repo: 'org/widget',
        base_commit: BASE_COMMIT,
        language: 'python',
        problem_statement: 'fix the bug',
        interface: '',
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: '2026_07',
        deadline_unix: 9_999_999_999,
        round_month: '2026-07',
      },
      ...(eligibility !== undefined ? { eligibility } : {}),
    },
  };
}

function baseOpts(store: Store, tmp: string): TaskEngineOptions {
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

class TestEngine extends TaskEngine {
  get testPersistence(): TaskRunPersistence {
    return this.persistence;
  }
}

/** Drives a task through PACKAGING with a swe-rebench-v2 solution patch. */
async function runToPackaging(
  engine: TestEngine,
  requestId: string,
  tmp: string,
  patch: string,
  eligibility?: Record<string, unknown>,
): Promise<void> {
  const workingDir = join(tmp, 'restorations', requestId);
  mkdirSync(join(workingDir, 'sessions'), { recursive: true });
  mkdirSync(join(workingDir, 'env'), { recursive: true });

  await engine.observe(makeInput(requestId, eligibility));
  const p = engine.testPersistence;
  const solution: Solution = {
    venueRef: { name: 'swe-rebench-v2' },
    gating: {},
    solutionPayload: { schemaVersion: 'swe-rebench-v2-solution.v1', patch },
    artifacts: [],
  };

  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  p.transition(requestId, TaskRunState.PRE_SNAPSHOT, {
    workingDir,
    implStateDir: join(tmp, 'impls', 'test'),
    preSnapshotCapturedAt: Date.now(),
  });
  p.transition(requestId, TaskRunState.RUNNING);
  p.transition(requestId, TaskRunState.POST_SNAPSHOT, {
    postSnapshotCapturedAt: Date.now(),
    solutionOutputsJson: JSON.stringify(solution),
  });
  p.transition(requestId, TaskRunState.PACKAGING);

  await engine.process(requestId);
  const intent = p.getByRequestId(requestId);
  expect(intent!.state).toBe(TaskRunState.DELIVERING);
}

describe('Engine mineable-trace producer (Task 7, D2 tier-1)', () => {
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

  it('consent on: appends exactly one record with the solver patch as acceptedDiff', async () => {
    const mineableDir = join(tmp, 'mineable');
    const mineableStore = new MineableTraceStore({ stateDir: mineableDir });
    const engine = new TestEngine({
      ...baseOpts(store, tmp),
      mineableStore,
      mineablePublishConsent: true,
    });

    const patch = 'diff --git a/x b/x\n+1\n';
    await runToPackaging(engine, 'req-mineable-1', tmp, patch);

    const records = await mineableStore.listUnmined();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.acceptedDiff).toBe(patch);
    expect(record.repo).toBe('org/widget');
    expect(record.baseCommit).toBe(BASE_COMMIT);
    expect(record.sourceInstanceId).toBe('org__widget-1');
    expect(record.kind).toBe('solvernet-execution');
    expect(record.publishMinedTasksConsent).toBe(true);
    // The engine has no retry-loop plumbing at the pack() hook point today —
    // an honest gap against the §10 contract's field 4, not fabricated data.
    expect(record.intermediateFailureDiffs).toEqual([]);
  });

  it('default config: mineableStore absent — nothing appended, store file never created', async () => {
    const mineableDir = join(tmp, 'mineable-unused');
    const engine = new TestEngine(baseOpts(store, tmp));

    const patch = 'diff --git a/x b/x\n+1\n';
    await runToPackaging(engine, 'req-mineable-2', tmp, patch);

    expect(existsSync(join(mineableDir, 'mineable-traces.json'))).toBe(false);
  });

  it('synthetic task: consent on — nothing appended (no second-generation echoes, spec §7)', async () => {
    const mineableDir = join(tmp, 'mineable-synthetic');
    const mineableStore = new MineableTraceStore({ stateDir: mineableDir });
    const engine = new TestEngine({
      ...baseOpts(store, tmp),
      mineableStore,
      mineablePublishConsent: true,
    });

    const patch = 'diff --git a/x b/x\n+1\n';
    await runToPackaging(engine, 'req-mineable-synthetic', tmp, patch, {
      syntheticProvenance: {
        synthetic: true,
        minterSafe: '0xminter',
        sourceSolverSafe: '0xsource',
      },
    });

    const records = await mineableStore.listUnmined();
    expect(records).toHaveLength(0);
  });
});
