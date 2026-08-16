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
import { loadHeldOutSlate } from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import {
  EVAL_SEMANTICS_VERSION,
  writeVettedPoolArtifactPublication,
  createVettedPoolArtifactRef,
  parseVettedPoolArtifact,
  hashVettedPoolArtifact,
} from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import type { LaunchedSolverNetRecord } from '../../src/solvernets/store.js';
import type { Task } from '../../src/types/task.js';

vi.mock('../../src/solver-types/_swe-rebench-v2-pool-recovery.js', async (importOriginal) => {
  return await importOriginal();
});

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

describe('makeSweRebenchV2GeneratorForLaunchedRecord — held-out slate exclusion (#817 AC#2)', () => {
  it('never posts a slate instance_id while a non-slate id is eligible', async () => {
    // A genuine reserved id from the shipped v1 slate — production SOLVER_TYPE /
    // SLATE_VERSION resolve to this same slate inside the generator.
    const slate = loadHeldOutSlate('swe-rebench-v2.v1', 'v1');
    const slateId = [...slate.instanceIds][0]!;
    const eligibleId = 'not-in__slate-1';

    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-817-'));
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'pool-cache.json'),
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-pool-cache.v1',
        savedAt: new Date().toISOString(),
        tasks: [
          {
            instance_id: slateId, language: 'python',
            hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2024_12',
            base_commit: '0000000000000000000000000000000000000000',
          },
          {
            instance_id: eligibleId, language: 'python',
            hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2024_12',
            base_commit: '0000000000000000000000000000000000000000',
          },
        ],
      }),
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('HF unreachable in test sandbox'));

    const gen = makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef: { current: launchedRecord({ status: 'launched', manifestCid: 'bafy817' }) },
      configRef: { current: { N_target_successes: 5, posting_window_ms: 300_000, admissionMode: 'python-floor' as const } },
      staticConfig: { stateDir },
    });

    const result = await gen();

    const postedIds = (result as Task[] | null)?.map((t) => (t.spec as { instance_id: string }).instance_id) ?? [];
    expect(postedIds).not.toContain(slateId);
    expect(postedIds).toContain(eligibleId);

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
  // Both the generator and getSweRebenchV2StateStore(stateDir) share one
  // explicit stateDir so they see the same ledger file (the equivalence that
  // makes Blocker 1's reload load-bearing). Env idiom retired in #1000.
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

  function liveGenerator(stateDir: string) {
    return makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef: { current: launchedRecord({ status: 'launched', manifestCid: 'bafy802live' }) },
      configRef: { current: { N_target_successes: 5, posting_window_ms: 300_000, admissionMode: 'python-floor' as const } },
      staticConfig: { stateDir },
    });
  }

  it('one instance does NOT re-post a live instance after the creator hook records its last_task_id (Blocker 1)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-live-'));
    const fetchSpy = mockHfFetchSingleInstance();
    try {
      const g = liveGenerator(stateDir);

      // Tick 1: instance is unposted (no last_task_id) → posted. Indexer still
      // empty (brand-new task not yet seen).
      const first = await g();
      expect((first as Task[])[0].spec).toMatchObject({ instance_id: 'org__repo-1' });

      // Simulate the CreatorLoop hook via the SAME accessor daemon code uses —
      // a SEPARATE store instance writing last_task_id to the shared file.
      await getSweRebenchV2StateStore(stateDir).recordLastTaskId('org__repo-1', '777');
      // Tick 2 on the SAME generator. Blocker 1's bug: the generator's first-load
      // cache still has last_task_id=undefined → unposted → re-post storm. With
      // the tick-start reload it observes '777' → live → no re-post.
      const second = await g();
      expect(second).toBeNull();
      expect(g.getState().lastPollSummary).toMatchObject({ live: 1, posted: 0, repostable: 0 });
      expect(g.getState().totalPosted).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('one instance does NOT re-post when the indexer has not yet reflected the just-posted task (lag, Blocker 3)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-lag-'));
    const fetchSpy = mockHfFetchSingleInstance();
    try {
      const g = liveGenerator(stateDir);

      await g(); // posts org__repo-1
      await getSweRebenchV2StateStore(stateDir).recordLastTaskId('org__repo-1', '888');
      const second = await g();
      expect(second).toBeNull();
      expect(g.getState().lastPollSummary).toMatchObject({ live: 1, posted: 0, repostable: 0 });
      expect(g.getState().totalPosted).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('one instance goes inert (no per-tick storm) in onchain/empty-claim-map mode (Blocker 2)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-onchain-'));
    const fetchSpy = mockHfFetchSingleInstance();
    try {
      // onchain floor returns an empty success map on EVERY tick.
      const g = liveGenerator(stateDir);

      const first = await g();
      expect((first as Task[])[0].spec).toMatchObject({ instance_id: 'org__repo-1' });
      await getSweRebenchV2StateStore(stateDir).recordLastTaskId('org__repo-1', '999');

      // Subsequent ticks: empty map + known last_task_id → live → no re-post.
      // (Pre-fix this storms a fresh post every tick.)
      const second = await g();
      const third = await g();
      expect(second).toBeNull();
      expect(third).toBeNull();
      expect(g.getState().lastPollSummary).toMatchObject({ live: 1, posted: 0, repostable: 0 });
      expect(g.getState().totalPosted).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('classifyPoolTask window-expiry repost trigger (#826 deadlock fix, #850)', () => {
  const pool = [
    { instance_id: 'a', language: 'python' },
    { instance_id: 'b', language: 'go' },
  ];
  const WINDOW = config.posting_window_ms;

  it('reposts an unexhausted posting once its claim window has elapsed', () => {
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: 1000, last_task_id: '10' }],
    ]);
    // consumed 1 < maxClaims 5 — never exhausted — but window has passed.
    const claimCounts = new Map([['10', { consumed: 1, maxClaims: 5 }]]);
    const now = 1000 + WINDOW + 1;
    expect(summarizePoolState({ pool: [pool[0]], counters, claimCounts, config, now }))
      .toMatchObject({ live: 0, repostable: 1 });
    const batch = selectNextPostingCandidates({ pool: [pool[0]], counters, claimCounts, config, now });
    expect(batch.map((t) => t.instance_id)).toContain('a');
  });

  it('keeps an unexhausted posting live while still inside its window (no premature repost)', () => {
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: 1000, last_task_id: '10' }],
    ]);
    const claimCounts = new Map([['10', { consumed: 1, maxClaims: 5 }]]);
    const now = 1000 + WINDOW - 1;
    expect(summarizePoolState({ pool: [pool[0]], counters, claimCounts, config, now }))
      .toMatchObject({ live: 1, repostable: 0 });
  });

  it('reposts an expired posting even when the indexer claim entry is missing', () => {
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: 1000, last_task_id: '10' }],
    ]);
    const now = 1000 + WINDOW + 1; // no claimCounts at all
    const batch = selectNextPostingCandidates({ pool: [pool[0]], counters, config, now });
    expect(batch.map((t) => t.instance_id)).toContain('a');
  });

  it('keeps a fresh post with no claim entry live inside its window (no double-post, #802 #3)', () => {
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: 1000, last_task_id: '10' }],
    ]);
    const now = 1000 + 5; // just posted, indexer lagging
    expect(summarizePoolState({ pool: [pool[0]], counters, config, now }))
      .toMatchObject({ live: 1, repostable: 0 });
  });
});

// ── #957 review: fresh-volume pool recovery must RETRY transient failures and
// latch only on TERMINAL outcomes. Proven at the generator-tick level: a no-task
// (transient) result does NOT permanently disable recovery — a later tick (after
// the throttle interval) retries — while a local-pool-present (terminal) result
// settles immediately and no further recovery attempt is made.
describe('makeSweRebenchV2GeneratorForLaunchedRecord — fresh-volume pool recovery latch (#957 review)', () => {
  async function seedPoolCache(stateDir: string): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    // Non-empty pool cache as a backstop so the tick always gets past the
    // `pool.length === 0` guard and reaches the recovery hook.
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

  // Mock the HF datasets-server so the pool LOAD SUCCEEDS on the first attempt
  // (one /splits + one /rows call, both 2xx). This avoids the ~15 s 429-backoff
  // schedule the loader pays when HF rejects — keeping these multi-tick tests
  // fast and, crucially, independent of the process-wide HF request limiter that
  // serialises requests across all tests in the file.
  function mockHfSuccess(): import('vitest').MockInstance {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/splits')
        ? { splits: [{ split: '2024_12' }] }
        : { rows: [{ row: { instance_id: 'org__repo-1', language: 'python', base_commit: '0'.repeat(40) } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }

  function recoveryGen(stateDir: string) {
    return makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef: { current: launchedRecord({ status: 'launched', manifestCid: 'bafy957recovery' }) },
      // admissionMode 'required' is the only mode that triggers the recovery hook.
      configRef: { current: { N_target_successes: 5, posting_window_ms: 300_000, admissionMode: 'required' as const } },
      staticConfig: { stateDir },
    });
  }

  // NOTE on the clock: we spy Date.now to drive ONLY the recovery throttle
  // window. We anchor the fake clock at the REAL current time (not a hardcoded
  // past date) so the process-wide HfRequestLimiter — which computes
  // `Date.now() - lastStartedAt` against its real-clock last-request stamp —
  // never sees a negative elapsed (which would make it sleep for ~forever).
  it('TRANSIENT no-task does NOT permanently latch: throttled within the interval, retried after it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-957-transient-'));
    await seedPoolCache(stateDir);
    const fetchSpy = mockHfSuccess();
    // Recovery returns no-task (transient) — a fresh SolverNet whose first task
    // hasn't been posted yet. fetchFromIpfs is never reached on this path.
    const recoveryMod = await import('../../src/solver-types/_swe-rebench-v2-pool-recovery.js');
    const recoverSpy = vi.spyOn(recoveryMod, 'recoverVettedPoolFromNetwork');
    const gen = recoveryGen(stateDir);

    const base = Date.now();
    let clock = base;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      clock = base;
      await gen();
      expect(recoverSpy).toHaveBeenCalledTimes(1); // first attempt

      // A second tick within the 5-min throttle window must NOT re-hit recovery.
      clock = base + 60_000; // +1 min
      await gen();
      expect(recoverSpy).toHaveBeenCalledTimes(1); // still 1 — throttled, NOT latched

      // After the throttle interval elapses, recovery is RETRIED (not latched).
      clock = base + 6 * 60_000 + 30_000; // +6.5 min from first
      await gen();
      expect(recoverSpy).toHaveBeenCalledTimes(2); // retried — proves no permanent latch
    } finally {
      recoverSpy.mockRestore();
      nowSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  }, 120_000);

  // The TERMINAL branch (recovered / local-pool-present / hash-mismatch → latch
  // permanently, never retry) is exhaustively covered by the pure-function unit
  // test `isTerminalRecoveryOutcome (#957 latch decision)` in
  // swe-rebench-v2-pool-recovery.test.ts. Here we additionally show the
  // tick-level wiring of the terminal short-circuit: when a validated-pool.json
  // is already present the hook settles WITHOUT querying the indexer. (A single
  // tick suffices — once a validated pool exists the tick proceeds into the
  // expensive publication path, so we don't loop it; persistence of the latch
  // is proven by the shared settled-flag wiring exercised in the TRANSIENT test
  // above plus the decision-logic unit test.)
  it('TERMINAL local-pool-present: a present validated-pool short-circuits recovery, no indexer call', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-957-terminal-'));
    await seedPoolCache(stateDir);
    // A validated-pool.json already on disk → terminal: nothing to recover.
    await writeFile(
      join(stateDir, 'validated-pool.json'),
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-validated-pool.v1',
        entries: {},
      }),
    );
    const fetchSpy = mockHfSuccess();
    const recoveryMod = await import('../../src/solver-types/_swe-rebench-v2-pool-recovery.js');
    const recoverSpy = vi.spyOn(recoveryMod, 'recoverVettedPoolFromNetwork');
    const gen = recoveryGen(stateDir);

    try {
      await gen();
      expect(recoverSpy).not.toHaveBeenCalled(); // local pool present → never queried recovery
    } finally {
      recoverSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  }, 120_000);
});

describe('makeSweRebenchV2GeneratorForLaunchedRecord — vetted-pool staleness (#796)', () => {
  const MANIFEST_CID = 'bafymanifest796test';

  async function seedPublication(stateDir: string, version: string): Promise<void> {
    const artifact = parseVettedPoolArtifact({
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: version,
      generatedAt: '2026-05-25T00:00:00Z',
      entries: [
        { instance_id: 'a__1', scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-25T00:00:00Z' },
      ],
    });
    const ref = createVettedPoolArtifactRef({
      manifestCid: MANIFEST_CID,
      artifactCid: 'bafkrei-test',
      artifactHash: hashVettedPoolArtifact(artifact),
      evalSemanticsVersion: version,
      publishedAt: '2026-05-25T00:00:00Z',
    });
    await writeVettedPoolArtifactPublication({ stateDir, ref, artifact });
  }

  async function buildAndTick(stateDir: string) {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => { throw new Error('HF unreachable in test sandbox'); });
    try {
      const gen = makeSweRebenchV2GeneratorForLaunchedRecord({
        recordRef: { current: launchedRecord({ status: 'launched', manifestCid: MANIFEST_CID }) },
        configRef: {
          current: {
            N_target_successes: 5,
            posting_window_ms: 300_000,
            admissionMode: 'python-floor' as const,
          },
        },
        staticConfig: { stateDir },
      });
      await gen();
      return gen.getState();
    } finally {
      fetchSpy.mockRestore();
    }
  }

  it('reports poolPublicationStale=true for a publication under an older eval-semantics version', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-796-stale-'));
    await mkdir(stateDir, { recursive: true });
    await seedPublication(stateDir, '3');
    const state = await buildAndTick(stateDir);
    expect(state.poolPublicationStale).toBe(true);
  });

  it('leaves poolPublicationStale absent for a current-version publication', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-796-current-'));
    await mkdir(stateDir, { recursive: true });
    await seedPublication(stateDir, EVAL_SEMANTICS_VERSION);
    const state = await buildAndTick(stateDir);
    expect(state.poolPublicationStale).toBeUndefined();
  });

  it('leaves poolPublicationStale absent when there is no publication (stale ≠ no-publication)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-796-none-'));
    await mkdir(stateDir, { recursive: true });
    const state = await buildAndTick(stateDir);
    expect(state.poolPublicationStale).toBeUndefined();
  });
});
