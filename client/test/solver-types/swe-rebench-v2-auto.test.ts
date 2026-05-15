import { describe, it, expect, vi } from 'vitest';
import { selectNextPostingCandidate, type GeneratorConfig } from '../../src/solver-types/swe-rebench-v2-auto.js';
import { makeSweRebenchV2GeneratorForLaunchedRecord } from '../../src/solver-types/swe-rebench-v2.js';
import type { LaunchedSolverNetRecord } from '../../src/solvernets/store.js';

const config: GeneratorConfig = {
  N_target_successes: 3,
  N_max_postings_per_task: 10,
  cooldown_ms: 24 * 60 * 60 * 1000,
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

  it('skips tasks within cooldown window', () => {
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
      pool, counters, config, now: 2 + config.cooldown_ms,
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
        cooldown_ms: 300_000,
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
      config: configRef.current,
    });
    fetchSpy.mockRestore();
  });
});
