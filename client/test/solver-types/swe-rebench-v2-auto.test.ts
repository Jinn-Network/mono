import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectNextPostingCandidate,
  selectNextPostingCandidates,
  summarizePoolState,
  type GeneratorConfig,
} from '../../src/solver-types/swe-rebench-v2-auto.js';
import { makeSweRebenchV2GeneratorForLaunchedRecord } from '../../src/solver-types/swe-rebench-v2.js';
import type { LaunchedSolverNetRecord } from '../../src/solvernets/store.js';
import type { DiscoveryAPI } from '../../src/discovery/types.js';

const config: GeneratorConfig = {
  N_target_successes: 5,
  N_max_postings_per_task: 10,
  posting_window_ms: 24 * 60 * 60 * 1000,
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
      ['a', { posted: 2, successful: 5, last_posted_at: 0 }],
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
      ['a', { posted: 10, successful: 5, last_posted_at: 0 }],
      ['b', { posted: 10, successful: 0, last_posted_at: 0 }],
      ['c', { posted: 10, successful: 5, last_posted_at: 0 }],
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

  it('does not select the same instance_id more than once when doing so would exceed N_max_postings_per_task', () => {
    const dupePool = [
      { instance_id: 'x', language: 'python' },
      { instance_id: 'x', language: 'python' },
    ];
    const counters = new Map([
      ['x', { posted: 9, successful: 0, last_posted_at: 0 }],
    ]);
    const batch = selectNextPostingCandidates({
      pool: dupePool,
      counters,
      config: { ...config, post_batch_size: 2 },
      now: 1_000_000_000,
    });
    expect(batch).toHaveLength(1);
  });

  it('returns empty slice when the only candidate is already at N_max_postings_per_task', () => {
    const dupePool = [{ instance_id: 'x', language: 'python' }];
    const counters = new Map([
      ['x', { posted: 10, successful: 0, last_posted_at: 0 }],
    ]);
    const batch = selectNextPostingCandidates({
      pool: dupePool,
      counters,
      config: { ...config, post_batch_size: 2 },
      now: 1_000_000_000,
    });
    expect(batch).toHaveLength(0);
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

describe('makeSweRebenchV2GeneratorForLaunchedRecord — network-truth success reconciliation (#669)', () => {
  it('classifies an instance as saturated when network successes ≥ N_target_successes, even if local successful=0', async () => {
    // Arrange — local state file says successful=0 for sympy__sympy-27510;
    // network truth (the stub DiscoveryAPI) reports passCount=21 for the same
    // instance, which is ≥ N_target_successes=5. The expected behaviour is
    // that the launcher does NOT post sympy__sympy-27510 — it is saturated
    // from network truth, even though the local counter is zero.
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-669-'));
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'generator-state.json'),
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-generator-state.v1',
        tasks: {
          'sympy__sympy-27510': { posted: 8, successful: 0, last_posted_at: 0 },
        },
      }),
    );

    // Inject a single-instance pool so the only candidate is the network-saturated one.
    // Pool cache file shape per `_swe-rebench-v2-pool-cache.ts`: { schemaVersion,
    // savedAt, tasks }. With a non-empty cache and HF unreachable in the test
    // sandbox, `loadPoolWithCacheFallback` serves from disk.
    await writeFile(
      join(stateDir, 'pool-cache.json'),
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-pool-cache.v1',
        savedAt: new Date().toISOString(),
        tasks: [{
          instance_id: 'sympy__sympy-27510',
          language: 'python',
          hf_dataset: 'nebius/SWE-rebench-leaderboard',
          hf_split: '2024_12',
          base_commit: '0000000000000000000000000000000000000000',
        }],
      }),
    );

    // Force the HF datasets-server load to fail so loadPoolWithCacheFallback
    // serves the single-instance pool we wrote to disk above. Without this the
    // generator pulls the live HF dataset and the test environment becomes
    // dependent on network state.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        throw new Error('HF unreachable in test sandbox');
      });

    // Stub DiscoveryAPI: only the new method is exercised by this test. Other
    // methods can throw — they are not called on this code path.
    const successCounts = new Map<string, number>([
      ['sympy__sympy-27510', 21],
    ]);
    const discoveryApi = {
      getInstanceSuccessCounts: vi.fn(async () => successCounts),
      // Stub out the rest with throws so any accidental call surfaces.
      findClaimableTasks: vi.fn(async () => { throw new Error('not used'); }),
      listLaunchedSolverNets: vi.fn(async () => { throw new Error('not used'); }),
      getLifecycleStatus: vi.fn(async () => { throw new Error('not used'); }),
      getSolverNetOperatorCount: vi.fn(async () => { throw new Error('not used'); }),
      queryEnvelopes: vi.fn(async () => { throw new Error('not used'); }),
      listPluginPublications: vi.fn(async () => { throw new Error('not used'); }),
      getPluginScores: vi.fn(async () => { throw new Error('not used'); }),
      listBuilderArtifacts: vi.fn(async () => { throw new Error('not used'); }),
    } satisfies DiscoveryAPI;

    const recordRef = {
      current: launchedRecord({
        status: 'launched',
        manifestCid: 'bafymanifest669test',
      }),
    };
    const configRef = {
      current: {
        N_target_successes: 5,
        N_max_postings_per_task: 10,
        posting_window_ms: 300_000,
        // Use 'python-floor' so the test doesn't have to publish a vetted pool.
        admissionMode: 'python-floor' as const,
      },
    };

    const gen = makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef,
      configRef,
      staticConfig: { stateDir, discoveryApi },
    });

    // Act — call the generator tick.
    const result = await gen();

    // Assert — no task posted, saturated == 1.
    expect(result).toBeNull();
    expect(discoveryApi.getInstanceSuccessCounts).toHaveBeenCalledWith({
      manifestCid: 'bafymanifest669test',
    });
    expect(gen.getState().lastPollSummary).toMatchObject({
      saturated: 1,
      posted: 0,
    });

    fetchSpy.mockRestore();
  });
});
