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

function patchSolution(patch: string): Solution {
  return {
    venueRef: { name: 'swe-rebench-v2' },
    gating: { ok: true },
    solutionPayload: { schemaVersion: 'swe-rebench-v2-solution.v1', patch },
    artifacts: [],
  };
}

function makePatchImpl(patch: string): Harness {
  return {
    name: 'patch-stub',
    version: '0.0.1',
    supports: (s) => s.solverType === SOLVER_TYPE && s.role !== 'evaluation',
    async run(): Promise<Solution> {
      return patchSolution(patch);
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

function solutionJson(patch: string): string {
  return JSON.stringify({
    venueRef: { name: 'swe-rebench-v2' },
    gating: {},
    solutionPayload: {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch,
    },
    artifacts: [],
  });
}

function advanceToRunning(p: TaskRunPersistence, requestId: string): void {
  p.insertDiscovered(makeInput({ requestId }));
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  p.transition(requestId, TaskRunState.PRE_SNAPSHOT);
  p.transition(requestId, TaskRunState.RUNNING);
}

describe('intermediateFailureDiffs persistence (#1643)', () => {
  let store: Store;
  let p: TaskRunPersistence;

  beforeEach(() => {
    store = new Store(':memory:');
    p = new TaskRunPersistence(store.db);
  });

  afterEach(() => {
    store.close();
  });

  it('adds intermediate_failure_diffs_json via additive migration', () => {
    const columns = (store.db.pragma('table_info(task_runs)') as Array<{ name: string }>)
      .map((r) => r.name);
    expect(columns).toContain('intermediate_failure_diffs_json');
  });

  it('retains prior patch A when overwritten by different patch B (AC1)', () => {
    advanceToRunning(p, 'req-ifd-1');
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+A\n'), 'req-ifd-1');

    p.recordPriorPatchOnOverwrite('req-ifd-1', solutionJson('diff --git a/x b/x\n+B\n'));

    const row = p.getByRequestId('req-ifd-1')!;
    expect(JSON.parse(row.intermediateFailureDiffsJson!)).toEqual([
      'diff --git a/x b/x\n+A\n',
    ]);
  });

  it('does not append empty or identical prior patches (AC3)', () => {
    advanceToRunning(p, 'req-ifd-2');
    // empty prior patch
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson(''), 'req-ifd-2');
    p.recordPriorPatchOnOverwrite('req-ifd-2', solutionJson('diff --git a/x b/x\n+B\n'));
    expect(p.getByRequestId('req-ifd-2')!.intermediateFailureDiffsJson).toBeNull();

    // identical prior
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+B\n'), 'req-ifd-2');
    p.recordPriorPatchOnOverwrite('req-ifd-2', solutionJson('diff --git a/x b/x\n+B\n'));
    expect(p.getByRequestId('req-ifd-2')!.intermediateFailureDiffsJson).toBeNull();
  });

  it('retains prior patch when next has no patch (skipped overwrite)', () => {
    advanceToRunning(p, 'req-ifd-skip');
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+A\n'), 'req-ifd-skip');

    const skippedJson = JSON.stringify({
      venueRef: { name: 'legacy' },
      gating: { skipped: true, reason: 'no-quota' },
      artifacts: [],
    });
    p.recordPriorPatchOnOverwrite('req-ifd-skip', skippedJson);

    expect(JSON.parse(p.getByRequestId('req-ifd-skip')!.intermediateFailureDiffsJson!)).toEqual([
      'diff --git a/x b/x\n+A\n',
    ]);
  });

  it('never throws on malformed solution_outputs_json or intermediate list', () => {
    advanceToRunning(p, 'req-ifd-malformed');
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ?, intermediate_failure_diffs_json = ? WHERE request_id = ?',
    ).run('{not-json', '{also-bad', 'req-ifd-malformed');
    expect(() => {
      p.recordPriorPatchOnOverwrite('req-ifd-malformed', solutionJson('diff --git a/x b/x\n+B\n'));
    }).not.toThrow();
    expect(p.getByRequestId('req-ifd-malformed')!.intermediateFailureDiffsJson).toBe('{also-bad');

    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ?, intermediate_failure_diffs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+A\n'), '{also-bad', 'req-ifd-malformed');
    expect(() => {
      p.recordPriorPatchOnOverwrite('req-ifd-malformed', solutionJson('diff --git a/x b/x\n+B\n'));
    }).not.toThrow();
    expect(JSON.parse(p.getByRequestId('req-ifd-malformed')!.intermediateFailureDiffsJson!)).toEqual([
      'diff --git a/x b/x\n+A\n',
    ]);
  });

  it('survives SQLite round-trip and dedupes on second append (AC6, AC3)', () => {
    advanceToRunning(p, 'req-ifd-3');
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+A\n'), 'req-ifd-3');
    p.recordPriorPatchOnOverwrite('req-ifd-3', solutionJson('diff --git a/x b/x\n+B\n'));
    // Simulate overwrite landing, then a third different patch
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+B\n'), 'req-ifd-3');
    p.recordPriorPatchOnOverwrite('req-ifd-3', solutionJson('diff --git a/x b/x\n+C\n'));
    // Re-append identical A must not duplicate
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+A\n'), 'req-ifd-3');
    p.recordPriorPatchOnOverwrite('req-ifd-3', solutionJson('diff --git a/x b/x\n+D\n'));

    const parsed = JSON.parse(p.getByRequestId('req-ifd-3')!.intermediateFailureDiffsJson!);
    expect(parsed).toEqual([
      'diff --git a/x b/x\n+A\n',
      'diff --git a/x b/x\n+B\n',
    ]);
  });
});

describe('runImpl retains prior patches (#1643)', () => {
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

  it('first successful runImpl leaves intermediateFailureDiffs empty (AC2)', async () => {
    const engine = new TaskEngine(engineOpts(store, tmp, makePatchImpl('diff --git a/x b/x\n+ok\n')));
    const p = new TaskRunPersistence(store.db);
    const requestId = 'req-first';
    await engine.observe(makeInput({
      requestId,
      task: { id: requestId, description: 'fix', solverType: SOLVER_TYPE, role: 'restoration', spec: {} },
    }));
    p.transition(requestId, TaskRunState.CLAIMED);
    p.transition(requestId, TaskRunState.WAITING);
    await engine.process(requestId);
    const row = p.getByRequestId(requestId)!;
    expect(row.state).toBe(TaskRunState.POST_SNAPSHOT);
    expect(row.intermediateFailureDiffsJson).toBeNull();
  });

  it('retains prior patch A when runImpl overwrites with different patch B (AC1)', async () => {
    const engine = new TaskEngine(engineOpts(store, tmp, makePatchImpl('diff --git a/x b/x\n+B\n')));
    const p = new TaskRunPersistence(store.db);
    const requestId = 'req-overwrite';
    await engine.observe(makeInput({
      requestId,
      task: { id: requestId, description: 'fix', solverType: SOLVER_TYPE, role: 'restoration', spec: {} },
    }));
    p.transition(requestId, TaskRunState.CLAIMED);
    p.transition(requestId, TaskRunState.WAITING);
    p.transition(requestId, TaskRunState.PRE_SNAPSHOT, {
      workingDir: join(tmp, 'work', requestId),
      implStateDir: join(tmp, 'impl'),
      preSnapshotCapturedAt: Date.now(),
    });
    p.transition(requestId, TaskRunState.RUNNING);
    mkdirSync(join(tmp, 'work', requestId), { recursive: true });
    mkdirSync(join(tmp, 'impl'), { recursive: true });
    // Seed prior failed patch while still RUNNING (simulates overwrite target).
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+A\n'), requestId);

    await engine.process(requestId);

    const row = p.getByRequestId(requestId)!;
    expect(row.state).toBe(TaskRunState.POST_SNAPSHOT);
    expect(JSON.parse(row.intermediateFailureDiffsJson!)).toEqual([
      'diff --git a/x b/x\n+A\n',
    ]);
    expect(JSON.parse(row.solutionOutputsJson!).solutionPayload.patch).toBe(
      'diff --git a/x b/x\n+B\n',
    );
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
