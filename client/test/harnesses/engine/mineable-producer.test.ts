/** C7 regression: TaskEngine must not create contribution refs without Episodes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import { TaskEngine, type TaskEngineOptions } from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type { Solution } from '../../../src/harnesses/types.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue(`0x${'0'.repeat(64)}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  callDeliverToMarketplace: vi.fn().mockResolvedValue('0xdeliverytx'),
  claimDelivery: vi.fn().mockResolvedValue('0xclaimtx'),
  submitTask: vi.fn(), submitEvaluationJob: vi.fn(), claimJob: vi.fn(),
  getJobClaim: vi.fn(), getMechDeliveryRate: vi.fn(), getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(), decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(), scanTasks: vi.fn(), scanEvaluationJobs: vi.fn(),
}));

const PRIVATE_KEY = `0x${'1'.repeat(64)}` as `0x${string}`;

class TestEngine extends TaskEngine {
  get testPersistence(): TaskRunPersistence { return this.persistence; }
}

function options(store: Store, root: string): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: join(root, 'work'), implStateDirRoot: join(root, 'impl') },
    packagingDeps: { store, operatorEndpoint: 'https://operator.test', defaultPriceUsdc: '0', perArtifactTypePrice: {} },
    envelopeDeps: { ipfsRegistryUrl: 'https://ipfs.test', agentEoaPrivateKey: PRIVATE_KEY, safeAddress: `0x${'2'.repeat(40)}` },
    deliveryDeps: {
      publicClient: {} as never, walletClient: {} as never, safeAddress: `0x${'2'.repeat(40)}`,
      mechContractAddress: `0x${'3'.repeat(40)}`, routerAddress: `0x${'4'.repeat(40)}`,
      claimDeliveryVariant: 'v2',
    },
  };
}

async function pack(engine: TestEngine, root: string): Promise<void> {
  const requestId = 'request-without-episode';
  const now = Date.now() - 1_000;
  const input: PersistedTaskRunInput = {
    requestId, taskCid: 'bafy-task', onchainCreationTx: '0xtx', onchainCreationBlock: 1,
    solverType: 'swe-rebench-v2.v1', windowStartTs: now, windowEndTs: now + 60_000,
    task: {
      id: requestId, description: 'fix', solverType: 'swe-rebench-v2.v1', role: 'restoration',
      spec: { repo: 'org/widget', base_commit: 'a'.repeat(40), instance_id: 'instance-1' },
    },
  };
  const workingDir = join(root, 'work', requestId);
  mkdirSync(join(workingDir, 'sessions'), { recursive: true });
  mkdirSync(join(workingDir, 'env'), { recursive: true });
  await engine.observe(input);
  const persistence = engine.testPersistence;
  const solution: Solution = {
    venueRef: { name: 'swe-rebench-v2' }, gating: {},
    solutionPayload: {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/x b/x\n+fixed\n',
    },
    artifacts: [],
  };
  persistence.transition(requestId, TaskRunState.CLAIMED);
  persistence.transition(requestId, TaskRunState.WAITING);
  persistence.transition(requestId, TaskRunState.PRE_SNAPSHOT, {
    workingDir, implStateDir: join(root, 'impl'), preSnapshotCapturedAt: Date.now(),
  });
  persistence.transition(requestId, TaskRunState.RUNNING);
  persistence.transition(requestId, TaskRunState.POST_SNAPSHOT, {
    postSnapshotCapturedAt: Date.now(), solutionOutputsJson: JSON.stringify(solution),
  });
  persistence.transition(requestId, TaskRunState.PACKAGING);
  await engine.process(requestId);
}

describe('TaskEngine contribution boundary', () => {
  let store: Store;
  let root: string;

  beforeEach(() => {
    store = new Store(':memory:');
    root = join(tmpdir(), `engine-no-mineable-${Date.now()}-${Math.random()}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores a legacy mineableStore option instead of enqueueing a requestId-only record', async () => {
    const append = vi.fn();
    const legacyOptions = { ...options(store, root), mineableStore: { append } };
    const engine = new TestEngine(legacyOptions as TaskEngineOptions);

    await pack(engine, root);

    expect(append).not.toHaveBeenCalled();
  });
});
