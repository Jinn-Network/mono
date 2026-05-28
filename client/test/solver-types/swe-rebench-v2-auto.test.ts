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
import {
  makeSweRebenchV2GeneratorForLaunchedRecord,
  getSweRebenchV2StateStore,
} from '../../src/solver-types/swe-rebench-v2.js';
import type { LaunchedSolverNetRecord } from '../../src/solvernets/store.js';
import type { DiscoveryAPI } from '../../src/discovery/types.js';
import type { Task } from '../../src/types/task.js';

const config: GeneratorConfig = {
  N_target_successes: 5,
  posting_window_ms: 24 * 60 * 60 * 1000,
  post_batch_size: 25,
  claimLeaseTtlSeconds: 60 * 60,
};

describe('classifyPoolTask (claim-budget model, #802)', () => {
  const pool = [
    { instance_id: 'a', language: 'python' },
    { instance_id: 'b', language: 'go' },
    { instance_id: 'c', language: 'python' },
  ];

  it('classifies successful >= N as saturated (unchanged)', () => {
    const counters = new Map([
      ['a', { posted: 5, successful: 5, last_posted_at: 0 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1000 });
    expect(next?.instance_id).toBe('b');
  });

  it('keeps a posting with slots remaining as live (does NOT repost)', () => {
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: 1, last_task_id: '10' }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const claimCounts = new Map([['10', { consumed: 2, maxClaims: 5 }]]);
    const next = selectNextPostingCandidate({ pool, counters, claimCounts, config, now: 1000 });
    // a is live (2 < 5), so b (unposted) is chosen.
    expect(next?.instance_id).toBe('b');
    expect(summarizePoolState({ pool, counters, claimCounts, config, now: 1000 }))
      .toMatchObject({ live: 1, unposted: 2, repostable: 0, saturated: 0 });
  });

  it('classifies an exhausted posting with successes < N as repostable', () => {
    const counters = new Map([
      ['a', { posted: 1, successful: 1, last_posted_at: 1, last_task_id: '10' }],
    ]);
    const claimCounts = new Map([['10', { consumed: 5, maxClaims: 5 }]]);
    const batch = selectNextPostingCandidates({ pool, counters, claimCounts, config, now: 1000 });
    expect(batch.map((t) => t.instance_id)).toContain('a');
    expect(summarizePoolState({ pool, counters, claimCounts, config, now: 1000 }))
      .toMatchObject({ repostable: 1 });
  });

  it('treats a posted instance with no claim snapshot as live (not-yet-indexed, NOT a repost)', () => {
    const counters = new Map([
      ['a', { posted: 3, successful: 0, last_posted_at: 1, last_task_id: '99' }],
    ]);
    // '99' absent from the snapshot: the indexer never deletes task rows, so the
    // only cause is indexing lag — assume not-yet-indexed and treat as live.
    // Re-posting here would double-post a just-posted task (#802 #3) and, in
    // onchain/empty-map mode, storm every tick (#802 #2).
    const claimCounts = new Map<string, { consumed: number; maxClaims: number }>();
    const batch = selectNextPostingCandidates({ pool, counters, claimCounts, config, now: 1000 });
    expect(batch.map((t) => t.instance_id)).not.toContain('a');
    expect(summarizePoolState({ pool, counters, claimCounts, config, now: 1000 }))
      .toMatchObject({ live: 1, repostable: 0 });
  });

  it('goes inert (no storm) when the claim map is empty for every posted instance (onchain mode)', () => {
    // mode='onchain' returns an empty-success claim map. Every posted instance
    // is absent → live → not re-posted. Only the unposted instance is selected.
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: 1, last_task_id: '50' }],
      ['b', { posted: 1, successful: 0, last_posted_at: 1, last_task_id: '51' }],
      ['c', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const claimCounts = new Map<string, { consumed: number; maxClaims: number }>();
    const batch = selectNextPostingCandidates({ pool, counters, claimCounts, config, now: 1000 });
    expect(batch.map((t) => t.instance_id)).toEqual(['c']);
    expect(summarizePoolState({ pool, counters, claimCounts, config, now: 1000 }))
      .toMatchObject({ live: 2, unposted: 1, repostable: 0, saturated: 0 });
  });

  it('retries a hard instance indefinitely — no abandon cap', () => {
    const counters = new Map([
      ['a', { posted: 9999, successful: 0, last_posted_at: 1, last_task_id: '10' }],
    ]);
    const claimCounts = new Map([['10', { consumed: 5, maxClaims: 5 }]]);
    // No abandon cap (#802): an exhausted hard instance reposts no matter how
    // many times it has been posted before.
    const batch = selectNextPostingCandidates({ pool, counters, claimCounts, config, now: 1000 });
    expect(batch.map((t) => t.instance_id)).toContain('a');
  });

  it('classifies an unposted instance as unposted', () => {
    const counters = new Map([['a', { posted: 0, successful: 0, last_posted_at: 0 }]]);
    const claimCounts = new Map();
    expect(summarizePoolState({ pool: [{ instance_id: 'a', language: 'python' }], counters, claimCounts, config, now: 1 }))
      .toMatchObject({ unposted: 1, live: 0, repostable: 0, saturated: 0 });
  });

  it('round-robins language among eligible candidates', () => {
    const counters = new Map();
    const next = selectNextPostingCandidate({
      pool, counters, claimCounts: new Map(), config, now: 1, lastPostedLanguage: 'python',
    });
    expect(next?.language).toBe('go');
  });

  it('returns empty when all instances are live or saturated', () => {
    const counters = new Map([
      ['a', { posted: 1, successful: 5, last_posted_at: 1, last_task_id: '10' }], // saturated
      ['b', { posted: 1, successful: 0, last_posted_at: 1, last_task_id: '11' }], // live
      ['c', { posted: 1, successful: 5, last_posted_at: 1, last_task_id: '12' }], // saturated
    ]);
    const claimCounts = new Map([
      ['10', { consumed: 5, maxClaims: 5 }],
      ['11', { consumed: 0, maxClaims: 5 }],
      ['12', { consumed: 5, maxClaims: 5 }],
    ]);
    expect(selectNextPostingCandidate({ pool, counters, claimCounts, config, now: 1 })).toBeUndefined();
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

    // Stub DiscoveryAPI: only getInstanceSuccessCounts is exercised on this
    // code path; the rest throw so any accidental call surfaces.
    const successCounts = new Map<string, number>([
      ['sympy__sympy-27510', 21],
    ]);
    const notUsed = vi.fn(async () => { throw new Error('not used'); });
    const discoveryApi = {
      getInstanceSuccessCounts: vi.fn(async () => successCounts),
      getInstanceClaimCounts: vi.fn(async () => new Map()),
      findClaimableTasks: notUsed,
      listLaunchedSolverNets: notUsed,
      getLifecycleStatus: notUsed,
      getSolverNetOperatorCount: notUsed,
      queryEnvelopes: notUsed,
      listPluginPublications: notUsed,
      getPluginScores: notUsed,
      listBuilderArtifacts: notUsed,
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

describe('makeSweRebenchV2GeneratorForLaunchedRecord — claim-exhaustion repost (#802)', () => {
  async function seed(stateDir: string, counters: Record<string, unknown>) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'generator-state.json'),
      JSON.stringify({ schemaVersion: 'swe-rebench-v2-generator-state.v1', tasks: counters }),
    );
    await writeFile(
      join(stateDir, 'pool-cache.json'),
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-pool-cache.v1',
        savedAt: new Date().toISOString(),
        tasks: [{
          instance_id: 'org__repo-1', language: 'python',
          hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2024_12',
          base_commit: '0000000000000000000000000000000000000000',
        }],
      }),
    );
  }

  function stubDiscovery(over: Partial<DiscoveryAPI>): DiscoveryAPI {
    const notUsed = vi.fn(async () => { throw new Error('not used'); });
    return {
      getInstanceSuccessCounts: vi.fn(async () => new Map<string, number>()),
      getInstanceClaimCounts: vi.fn(async () => new Map()),
      findClaimableTasks: notUsed, listLaunchedSolverNets: notUsed,
      getLifecycleStatus: notUsed, getSolverNetOperatorCount: notUsed,
      queryEnvelopes: notUsed, listPluginPublications: notUsed,
      getPluginScores: notUsed, listBuilderArtifacts: notUsed,
      ...over,
    } as DiscoveryAPI;
  }

  function gen(stateDir: string, discoveryApi: DiscoveryAPI) {
    return makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef: { current: launchedRecord({ status: 'launched', manifestCid: 'bafy802' }) },
      configRef: { current: { N_target_successes: 5, posting_window_ms: 300_000, admissionMode: 'python-floor' as const } },
      staticConfig: { stateDir, discoveryApi },
    });
  }

  it('reposts an exhausted instance whose successes < N', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-'));
    await seed(stateDir, { 'org__repo-1': { posted: 1, successful: 1, last_posted_at: 0, last_task_id: '10' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HF unreachable in test sandbox'));
    const discovery = stubDiscovery({
      getInstanceClaimCounts: vi.fn(async () => new Map([['10', { taskId: '10', consumed: 5, maxClaims: 5 }]])),
    });
    const g = gen(stateDir, discovery);

    const result = await g();

    expect(result).not.toBeNull();
    expect((result as Task[])[0].spec).toMatchObject({ instance_id: 'org__repo-1' });
    expect(g.getState().lastPollSummary).toMatchObject({ posted: 1 });
    fetchSpy.mockRestore();
  });

  it('does NOT repost an instance with claim slots remaining (live)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-'));
    await seed(stateDir, { 'org__repo-1': { posted: 1, successful: 0, last_posted_at: 0, last_task_id: '11' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HF unreachable in test sandbox'));
    const discovery = stubDiscovery({
      getInstanceClaimCounts: vi.fn(async () => new Map([['11', { taskId: '11', consumed: 2, maxClaims: 5 }]])),
    });
    const g = gen(stateDir, discovery);

    const result = await g();

    expect(result).toBeNull();
    expect(g.getState().lastPollSummary).toMatchObject({ live: 1, posted: 0 });
    fetchSpy.mockRestore();
  });

  it('aborts the tick when getInstanceClaimCounts throws (never under-counts)', async () => {
    const { DiscoveryUnavailableError } = await import('../../src/discovery/types.js');
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-'));
    await seed(stateDir, { 'org__repo-1': { posted: 1, successful: 1, last_posted_at: 0, last_task_id: '10' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HF unreachable in test sandbox'));
    const discovery = stubDiscovery({
      getInstanceClaimCounts: vi.fn(async () => { throw new DiscoveryUnavailableError('indexer down'); }),
    });
    const g = gen(stateDir, discovery);

    const result = await g();

    expect(result).toBeNull(); // aborted, nothing posted
    expect(g.getState().lastError?.message).toContain('claim-budget reconciliation failed');
    expect(g.getState().lastPollSummary).toMatchObject({ posted: 0 });
    fetchSpy.mockRestore();
  });
});

// Integration-style: drive ONE long-lived generator instance through the real
// post → record-last_task_id → next-tick cycle (#802). The seed-disk-then-fresh-
// construct tests above structurally cannot catch Blocker 1 (a fresh generator's
// first load happens to read the seeded last_task_id); these do, because the
// generator must observe a last_task_id written by a SEPARATE store instance
// (the CreatorLoop hook) on a SUBSEQUENT tick.
//
// HF is mocked to RESOLVE a single-instance pool (not reject) so each tick loads
// the pool fast without the retry backoff — multiple ticks per test would
// otherwise time out on the shared HF retry limiter.
describe('makeSweRebenchV2GeneratorForLaunchedRecord — live post→record→repost cycle (#802)', () => {
  // Mirror production: do NOT pass staticConfig.stateDir; both the generator and
  // getSweRebenchV2StateStore() resolve via JINN_SWE_REBENCH_V2_STATE_DIR so they
  // share one file (the equivalence that makes Blocker 1's reload load-bearing).
  const SINGLE_INSTANCE_ROWS = [
    {
      row: {
        instance_id: 'org__repo-1',
        repo: 'org/repo',
        base_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        language: 'python',
        problem_statement: 'fix the bug',
      },
    },
  ];

  function mockHfFetchSingleInstance() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/splits')) {
        return { ok: true, json: async () => ({ splits: [{ split: '2026_02' }] }) } as Response;
      }
      return { ok: true, json: async () => ({ rows: SINGLE_INSTANCE_ROWS }) } as Response;
    });
  }

  // A single generator instance whose indexer claim map is a mutable closure —
  // lets us change what the indexer reports BETWEEN ticks on the SAME generator,
  // which is what exercises Blocker 1 (the long-lived in-memory cache must pick
  // up the creator's out-of-band disk write at tick start).
  function liveGeneratorWithMutableClaims(claimsRef: {
    current: Map<string, { taskId: string; consumed: number; maxClaims: number }>;
  }) {
    const notUsed = vi.fn(async () => { throw new Error('not used'); });
    const discoveryApi = {
      getInstanceSuccessCounts: vi.fn(async () => new Map<string, number>()),
      getInstanceClaimCounts: vi.fn(async () => claimsRef.current),
      findClaimableTasks: notUsed, listLaunchedSolverNets: notUsed,
      getLifecycleStatus: notUsed, getSolverNetOperatorCount: notUsed,
      queryEnvelopes: notUsed, listPluginPublications: notUsed,
      getPluginScores: notUsed, listBuilderArtifacts: notUsed,
    } as DiscoveryAPI;
    return makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef: { current: launchedRecord({ status: 'launched', manifestCid: 'bafy802live' }) },
      configRef: { current: { N_target_successes: 5, posting_window_ms: 300_000, admissionMode: 'python-floor' as const } },
      // staticConfig deliberately omits stateDir — env var drives both the
      // generator's store and getSweRebenchV2StateStore() (production path).
      staticConfig: { discoveryApi },
    });
  }

  it('one instance does NOT re-post a live instance after the creator hook records its last_task_id (Blocker 1)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-live-'));
    process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] = stateDir;
    const fetchSpy = mockHfFetchSingleInstance();
    try {
      const claimsRef = { current: new Map<string, { taskId: string; consumed: number; maxClaims: number }>() };
      const g = liveGeneratorWithMutableClaims(claimsRef);

      // Tick 1: instance is unposted (no last_task_id) → posted. Indexer still
      // empty (brand-new task not yet seen).
      const first = await g();
      expect((first as Task[])[0].spec).toMatchObject({ instance_id: 'org__repo-1' });

      // Simulate the CreatorLoop hook via the SAME accessor daemon code uses —
      // a SEPARATE store instance writing last_task_id to the shared file.
      await getSweRebenchV2StateStore().recordLastTaskId('org__repo-1', '777');
      // Indexer now reflects the task with slots remaining (live).
      claimsRef.current = new Map([['777', { taskId: '777', consumed: 2, maxClaims: 5 }]]);

      // Tick 2 on the SAME generator. Blocker 1's bug: the generator's first-load
      // cache still has last_task_id=undefined → unposted → re-post storm. With
      // the tick-start reload it observes '777' → live → no re-post.
      const second = await g();
      expect(second).toBeNull();
      expect(g.getState().lastPollSummary).toMatchObject({ live: 1, posted: 0, repostable: 0 });
      expect(g.getState().totalPosted).toBe(1);
    } finally {
      delete process.env['JINN_SWE_REBENCH_V2_STATE_DIR'];
      fetchSpy.mockRestore();
    }
  });

  it('one instance does NOT re-post when the indexer has not yet reflected the just-posted task (lag, Blocker 3)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-lag-'));
    process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] = stateDir;
    const fetchSpy = mockHfFetchSingleInstance();
    try {
      const claimsRef = { current: new Map<string, { taskId: string; consumed: number; maxClaims: number }>() };
      const g = liveGeneratorWithMutableClaims(claimsRef);

      await g(); // posts org__repo-1
      await getSweRebenchV2StateStore().recordLastTaskId('org__repo-1', '888');
      // Indexer STILL missing '888' (lag): a known last_task_id absent from the
      // snapshot must classify `live` (not-yet-indexed), NOT repostable.

      const second = await g();
      expect(second).toBeNull();
      expect(g.getState().lastPollSummary).toMatchObject({ live: 1, posted: 0, repostable: 0 });
      expect(g.getState().totalPosted).toBe(1);
    } finally {
      delete process.env['JINN_SWE_REBENCH_V2_STATE_DIR'];
      fetchSpy.mockRestore();
    }
  });

  it('one instance goes inert (no per-tick storm) in onchain/empty-claim-map mode (Blocker 2)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-onchain-'));
    process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] = stateDir;
    const fetchSpy = mockHfFetchSingleInstance();
    try {
      // onchain floor returns an empty success map on EVERY tick.
      const claimsRef = { current: new Map<string, { taskId: string; consumed: number; maxClaims: number }>() };
      const g = liveGeneratorWithMutableClaims(claimsRef);

      const first = await g();
      expect((first as Task[])[0].spec).toMatchObject({ instance_id: 'org__repo-1' });
      await getSweRebenchV2StateStore().recordLastTaskId('org__repo-1', '999');

      // Subsequent ticks: empty map + known last_task_id → live → no re-post.
      // (Pre-fix this storms a fresh post every tick.)
      const second = await g();
      const third = await g();
      expect(second).toBeNull();
      expect(third).toBeNull();
      expect(g.getState().lastPollSummary).toMatchObject({ live: 1, posted: 0, repostable: 0 });
      expect(g.getState().totalPosted).toBe(1);
    } finally {
      delete process.env['JINN_SWE_REBENCH_V2_STATE_DIR'];
      fetchSpy.mockRestore();
    }
  });
});
