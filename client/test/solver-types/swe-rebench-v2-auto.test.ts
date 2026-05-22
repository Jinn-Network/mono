import { describe, it, expect, vi } from 'vitest';
import {
  selectNextPostingCandidate,
  selectNextPostingCandidates,
  summarizePoolState,
  type GeneratorConfig,
} from '../../src/solver-types/swe-rebench-v2-auto.js';
import { makeSweRebenchV2GeneratorForLaunchedRecord } from '../../src/solver-types/swe-rebench-v2.js';
import type { LaunchedSolverNetRecord } from '../../src/solvernets/store.js';

const config: GeneratorConfig = {
  N_target_successes: 3,
  N_max_postings_per_task: 10,
  posting_window_ms: 7 * 24 * 60 * 60 * 1000,
  post_batch_size: 25,
  claimLeaseTtlSeconds: 60 * 60,
};

describe('selectNextPostingCandidate', () => {
  const pool = [
    { instance_id: 'a', language: 'python' },
    { instance_id: 'b', language: 'go' },
    { instance_id: 'c', language: 'python' },
  ];

  it('skips saturated tasks (successful_count >= N_target_successes)', () => {
    const counters = new Map([
      ['a', { posted: 5, successful: 3, last_posted_at: 0 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1000 });
    expect(next?.instance_id).toBe('b');
  });

  it('skips tasks with a live posting inside the posting window', () => {
    const now = 1_000_000;
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: now - 1000 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now });
    expect(next?.instance_id).toBe('b');
  });

  it('skips tasks at max-postings cap', () => {
    const counters = new Map([
      ['a', { posted: 10, successful: 0, last_posted_at: 0 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1_000_000_000 });
    expect(next?.instance_id).toBe('b');
  });

  it('selects expired unsaturated instances as repostable', () => {
    const now = 1_000_000_000;
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: now - config.posting_window_ms - 1 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now });
    expect(next?.instance_id).toBe('b');
    const batch = selectNextPostingCandidates({ pool, counters, config, now });
    expect(batch.map((task) => task.instance_id)).toContain('a');
    expect(summarizePoolState({ pool, counters, config, now })).toMatchObject({
      unposted: 2,
      repostable: 1,
      live: 0,
    });
  });

  it('does not select saturated or abandoned instances', () => {
    const counters = new Map([
      ['a', { posted: 2, successful: 3, last_posted_at: 0 }],
      ['b', { posted: 10, successful: 0, last_posted_at: 0 }],
      ['c', { posted: 1, successful: 0, last_posted_at: 1 }],
    ]);
    const batch = selectNextPostingCandidates({
      pool,
      counters,
      config: { ...config, posting_window_ms: 1 },
      now: 3,
    });
    expect(batch.map((task) => task.instance_id)).toEqual(['c']);
  });

  it('returns undefined when all tasks are saturated or capped', () => {
    const counters = new Map([
      ['a', { posted: 10, successful: 3, last_posted_at: 0 }],
      ['b', { posted: 10, successful: 0, last_posted_at: 0 }],
      ['c', { posted: 10, successful: 3, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1_000_000_000 });
    expect(next).toBeUndefined();
  });

  it('balances by language (round-robin) when multiple eligible', () => {
    const counters = new Map();
    counters.set('a', { posted: 1, successful: 0, last_posted_at: 1 });
    const next = selectNextPostingCandidate({
      pool, counters, config, now: 2 + config.posting_window_ms,
      lastPostedLanguage: 'python',
    });
    expect(next?.language).toBe('go');
  });
});

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

describe('makeSweRebenchV2GeneratorForLaunchedRecord', () => {
  it('short-circuits paused records before touching HuggingFace', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const recordRef = { current: launchedRecord({ status: 'paused' }) };
    const configRef = {
      current: {
        N_target_successes: 5,
        N_max_postings_per_task: 15,
        posting_window_ms: 300_000,
      },
    };
    const gen = makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: {},
    });

    const result = await gen();

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(gen.getState()).toMatchObject({
      kind: 'swe-rebench-v2',
      totalPosted: 0,
      config: expect.objectContaining(configRef.current),
    });
    fetchSpy.mockRestore();
  });
});
