import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSweRebenchV2GeneratorForLaunchedRecord } from '../../src/solver-types/swe-rebench-v2.js';
import type { AdmissionMode } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { ValidatedPoolStore, EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import type { LaunchedSolverNetRecord } from '../../src/solvernets/store.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';

const DEFAULT_MOCK_ROWS = [
  {
    row: {
      instance_id: 'org__repo-1',
      repo: 'org/repo',
      base_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      language: 'python',
      problem_statement: 'fix first bug',
    },
  },
  {
    row: {
      instance_id: 'org__repo-2',
      repo: 'org/repo',
      base_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      language: 'python',
      problem_statement: 'fix second bug',
    },
  },
];

vi.mock('node:https', () => ({
  request(_url: unknown, _opts: unknown, cb: (res: EventEmitter) => void) {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const res = new EventEmitter();
      cb(res);
      const body = JSON.stringify({ rows: DEFAULT_MOCK_ROWS });
      res.emit('data', body);
      res.emit('end');
    };
    return req;
  },
}));

const FIXED_NOW_ISO = '2026-05-08T10:12:45.000Z';

function launchedRecord(overrides: Partial<LaunchedSolverNetRecord> = {}): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: '5474_swe-rebench-v2-v1_edb172d3',
    manifestCid: 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi',
    manifestHash: `0x${'aa'.repeat(32)}` as `0x${string}`,
    launcherAgentId: '5474',
    launcherSafeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
    launchedAt: FIXED_NOW_ISO,
    status: 'launched',
    statusUpdatedAt: FIXED_NOW_ISO,
    generatorEnabled: true,
    registry: {
      metadataTxHash: `0x${'bb'.repeat(32)}` as `0x${string}`,
      metadataBlockNumber: 1,
    },
    ...overrides,
  };
}

function poolTask(id: string, overrides: Partial<PoolTask> = {}): PoolTask {
  return {
    instance_id: id,
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: '2026_02',
    repo: 'org/repo',
    base_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    language: 'python',
    problem_statement: `fix bug in ${id}`,
    ...overrides,
  };
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'jinn-swe-gen-cooldown-'));
}

interface MakeTestGeneratorOpts {
  stateDir: string;
  admissionMode?: AdmissionMode;
  poolTasks?: PoolTask[];
  N_max_postings_per_task?: number;
  cooldown_ms?: number;
}

function makeTestGenerator(opts: MakeTestGeneratorOpts) {
  const { stateDir, admissionMode, N_max_postings_per_task = 3, cooldown_ms = 0 } = opts;
  const recordRef = { current: launchedRecord() };
  const configRef = {
    current: {
      N_target_successes: 1,
      N_max_postings_per_task,
      cooldown_ms,
      ...(admissionMode !== undefined ? { admissionMode } : {}),
    },
  };
  return makeSweRebenchV2GeneratorForLaunchedRecord({
    recordRef,
    configRef,
    staticConfig: { stateDir },
  });
}

describe('makeSweRebenchV2GeneratorForLaunchedRecord cooldown', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'jinn-swe-gen-cooldown-'));
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ splits: [{ split: '2026_02' }] }),
    } as Response);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('does not drain multiple candidates within one global cooldown window', async () => {
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    const recordRef = { current: launchedRecord() };
    const configRef = {
      current: {
        N_target_successes: 1,
        N_max_postings_per_task: 1,
        cooldown_ms: 86_400_000,
        admissionMode: 'python-floor' as AdmissionMode,
      },
    };
    const gen = makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: { stateDir },
    });

    const first = await gen();
    const second = await gen();

    expect(first).toMatchObject({
      solverType: 'swe-rebench-v2.v1',
      spec: expect.objectContaining({ instance_id: 'org__repo-1' }),
    });
    expect(second).toBeNull();
    expect(gen.getState()).toMatchObject({
      totalPosted: 1,
      lastPollSummary: { posted: 0 },
    });
  });

  it('applies launched-record claim policy overrides to newly posted tasks', async () => {
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    const recordRef = { current: launchedRecord() };
    const configRef = {
      current: {
        N_target_successes: 1,
        N_max_postings_per_task: 1,
        cooldown_ms: 86_400_000,
        admissionMode: 'python-floor' as AdmissionMode,
        claimPolicy: {
          maxClaims: 10,
          maxClaimsPerOperator: 2,
          claimLeaseTtlSeconds: 1_800,
        },
      },
    };
    const gen = makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: { stateDir },
    });

    const task = await gen();

    expect(task).toMatchObject({
      solverType: 'swe-rebench-v2.v1',
      claimPolicy: {
        mode: 'parallel',
        maxClaims: 10,
        maxClaimsPerOperator: 2,
        claimLeaseTtlSeconds: 1_800,
      },
    });
  });
});

describe('swe-rebench-v2 generator — admissionMode: required', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tmpDir();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-14T10:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ splits: [{ split: '2026_02' }] }),
    } as Response);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('posts nothing when validated-pool.json is absent in required mode', async () => {
    const gen = makeTestGenerator({ stateDir, admissionMode: 'required' });
    const task = await gen();
    expect(task).toBeNull();
  });

  it('posts nothing when validated-pool.json has no scorable entries in required mode', async () => {
    const store = new ValidatedPoolStore({ stateDir });
    await store.record('a__1', { scorable: false, reason: 'unscorable', checkedAt: '2026-05-14T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    const gen = makeTestGenerator({ stateDir, admissionMode: 'required' });
    const task = await gen();
    expect(task).toBeNull();
  });

  it('posts only admitted scorable instances in required mode', async () => {
    const store = new ValidatedPoolStore({ stateDir });
    await store.record('org__repo-1', { scorable: true, reason: 'ok', checkedAt: '2026-05-14T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    const gen = makeTestGenerator({ stateDir, admissionMode: 'required' });
    const task = await gen();
    expect(task?.spec).toMatchObject({ instance_id: 'org__repo-1' });
  });

  it('falls back to python-floor when admissionMode is python-floor and no validation data exists', async () => {
    const gen = makeTestGenerator({
      stateDir,
      admissionMode: 'python-floor',
    });
    const task = await gen();
    expect(task?.spec).toMatchObject({ instance_id: 'org__repo-1' });
  });
});
