import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSweRebenchV2GeneratorForLaunchedRecord } from '../../src/solver-types/swe-rebench-v2.js';
import type { LaunchedSolverNetRecord } from '../../src/solvernets/store.js';

vi.mock('node:https', () => ({
  request(_url: unknown, _opts: unknown, cb: (res: EventEmitter) => void) {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const res = new EventEmitter();
      cb(res);
      const body = JSON.stringify({
        rows: [
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
        ],
      });
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
