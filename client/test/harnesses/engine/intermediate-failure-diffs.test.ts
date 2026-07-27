import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import {
  TaskRunPersistence,
  type PersistedTaskRunInput,
} from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import { TaskEngine, type TaskEngineOptions } from '../../../src/harnesses/engine/engine.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';
import {
  buildMineableRecord,
  intermediateFailureDiffsFromTaskRun,
} from '../../../src/solver-types/_swe-rebench-v2-mineable-store.js';

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
const SOLVER_TYPE = 'swe-rebench-v2.v1';

function patchSolution(
  patch: string,
  intermediateFailureDiffs?: string[],
): Solution {
  return {
    venueRef: { name: 'swe-rebench-v2' },
    gating: { ok: true },
    solutionPayload: { schemaVersion: 'swe-rebench-v2-solution.v1', patch },
    artifacts: [],
    ...(intermediateFailureDiffs !== undefined
      ? { intermediateFailureDiffs }
      : {}),
  };
}

/** Stub that simulates in-session failed attempt boundaries then a final patch. */
function makeEmittingImpl(opts: {
  patch: string;
  intermediateFailureDiffs?: string[];
}): Harness {
  return {
    name: 'ifd-emit-stub',
    version: '0.0.1',
    supports: (s) => s.solverType === SOLVER_TYPE && s.role !== 'evaluation',
    async run(): Promise<Solution> {
      return patchSolution(opts.patch, opts.intermediateFailureDiffs);
    },
  };
}

function engineOpts(store: Store, tmp: string, impl: Harness): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: join(tmp, 'work'), implStateDirRoot: join(tmp, 'impl') },
    implRegistry: { findFor: (s) => (impl.supports(s) ? impl : undefined) },
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: PRIVATE_KEY,
      safeAddress: `0x${'2'.repeat(40)}`,
    },
  };
}

function makeInput(overrides: Partial<PersistedTaskRunInput> = {}): PersistedTaskRunInput {
  return {
    requestId: 'req-ifd-1',
    taskCid: 'bafy-task',
    onchainCreationTx: '0xtx',
    onchainCreationBlock: 1,
    solverType: 'swe-rebench-v2.v1',
    windowStartTs: Date.now() - 1_000,
    windowEndTs: Date.now() + 60_000,
    task: {
      id: 'req-ifd-1',
      description: 'fix',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      spec: { repo: 'org/widget', base_commit: 'a'.repeat(40), instance_id: 'i-1' },
    },
    ...overrides,
  };
}

async function driveToPostSnapshot(
  store: Store,
  tmp: string,
  requestId: string,
  impl: Harness,
): Promise<ReturnType<TaskRunPersistence['getByRequestId']>> {
  const engine = new TaskEngine(engineOpts(store, tmp, impl));
  const p = new TaskRunPersistence(store.db);
  await engine.observe(makeInput({
    requestId,
    task: {
      id: requestId,
      description: 'fix',
      solverType: SOLVER_TYPE,
      role: 'restoration',
      spec: {},
    },
  }));
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  await engine.process(requestId);
  return p.getByRequestId(requestId);
}

describe('intermediateFailureDiffs column (#1643 redesign)', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('adds intermediate_failure_diffs_json via additive migration', () => {
    const columns = (store.db.pragma('table_info(task_runs)') as Array<{ name: string }>)
      .map((r) => r.name);
    expect(columns).toContain('intermediate_failure_diffs_json');
  });
});

describe('runImpl persists harness-emitted intermediateFailureDiffs (#1643)', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = join(tmpdir(), `ifd-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('AC2: first success with no failed-boundary evidence leaves column null', async () => {
    const row = await driveToPostSnapshot(
      store,
      tmp,
      'req-first',
      makeEmittingImpl({ patch: 'diff --git a/x b/x\n+ok\n' }),
    );
    expect(row!.state).toBe(TaskRunState.POST_SNAPSHOT);
    expect(row!.intermediateFailureDiffsJson).toBeNull();
  });

  it('AC1: harness-emitted failed diffs persist after normal RUNNING → POST_SNAPSHOT (no SQL seed)', async () => {
    const failedA = 'diff --git a/x b/x\n+A\n';
    const row = await driveToPostSnapshot(
      store,
      tmp,
      'req-emit',
      makeEmittingImpl({
        patch: 'diff --git a/x b/x\n+B\n',
        intermediateFailureDiffs: [failedA],
      }),
    );
    expect(row!.state).toBe(TaskRunState.POST_SNAPSHOT);
    expect(JSON.parse(row!.intermediateFailureDiffsJson!)).toEqual([failedA]);
    expect(JSON.parse(row!.solutionOutputsJson!).solutionPayload.patch).toBe(
      'diff --git a/x b/x\n+B\n',
    );
  });

  it('AC3: empty strings dropped; identical diffs deduped at persist', async () => {
    const failed = 'diff --git a/x b/x\n+A\n';
    const row = await driveToPostSnapshot(
      store,
      tmp,
      'req-dedupe',
      makeEmittingImpl({
        patch: 'diff --git a/x b/x\n+ok\n',
        intermediateFailureDiffs: ['', failed, failed, ''],
      }),
    );
    expect(JSON.parse(row!.intermediateFailureDiffsJson!)).toEqual([failed]);
  });

  it('AC2: empty array from harness leaves column null', async () => {
    const row = await driveToPostSnapshot(
      store,
      tmp,
      'req-empty-arr',
      makeEmittingImpl({
        patch: 'diff --git a/x b/x\n+ok\n',
        intermediateFailureDiffs: [],
      }),
    );
    expect(row!.intermediateFailureDiffsJson).toBeNull();
  });
});

describe('intermediateFailureDiffsFromTaskRun (#1643 AC4)', () => {
  it('returns [] for null / malformed / missing', () => {
    expect(intermediateFailureDiffsFromTaskRun({ intermediateFailureDiffsJson: null })).toEqual([]);
    expect(intermediateFailureDiffsFromTaskRun({ intermediateFailureDiffsJson: '{' })).toEqual([]);
    expect(intermediateFailureDiffsFromTaskRun({ intermediateFailureDiffsJson: '"nope"' })).toEqual([]);
  });

  it('parses the retained list for buildMineableRecord', () => {
    const diffs = intermediateFailureDiffsFromTaskRun({
      intermediateFailureDiffsJson: JSON.stringify(['diff --git a/x b/x\n+A\n']),
    });
    const record = buildMineableRecord({
      sourceId: 'ep-1',
      kind: 'solvernet-execution',
      repo: 'org/widget',
      baseCommit: 'a'.repeat(40),
      acceptedDiff: 'diff --git a/x b/x\n+B\n',
      intermediateFailureDiffs: diffs,
      publishMinedTasksConsent: false,
      now: () => '2026-07-22T00:00:00.000Z',
    });
    expect(record.intermediateFailureDiffs).toEqual(['diff --git a/x b/x\n+A\n']);
  });
});
