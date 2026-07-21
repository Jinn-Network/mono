import { describe, it, expect } from 'vitest';
import {
  runMergePrepCycle,
  MAX_PREP_ATTEMPTS,
  MERGE_PREP_REAP_MS,
  type PrepAttempt,
  type MergePrepCycleDeps,
} from '../../src/dispatcher/merge-prep-loop.js';
import type { DispatcherConfig, InFlightMergePrep } from '../../src/dispatcher/types.js';
import type { StuckPr } from '../../src/dispatcher/merge-sweep.js';

const CFG: DispatcherConfig = {
  runtime: 'claude', concurrencyCap: 3, openPrBackpressure: 30, wallClockMs: 1,
  authorAllowlist: [], reviewCap: 3, engineReviewLabel: 'engine:review',
  reviewBotLogin: 'jinn-review', implGhToken: '', reviewGhToken: '',
  mergePrepEnabled: true, mergePrepCap: 1,
  hermesModel: 'gpt-5.6-sol', hermesProvider: 'openai-codex', hermesPythonPath: '/opt/hermes/python',
  marketplaceBridgeEnabled: false, marketplaceIndexerUrl: '', marketplaceIpfsGatewayUrl: 'https://gateway.autonolas.tech', executionMode: 'local',
};

function stuck(n: number, over: Partial<StuckPr> = {}): StuckPr {
  return { number: n, title: `t${n}`, reason: 'conflicting', headRefName: `feat/${n}`, headRefOid: `oid${n}`, escalated: false, ...over };
}

/** Build deps with recording spies; override any piece. */
function deps(over: Partial<MergePrepCycleDeps> & { stuck: StuckPr[] }): {
  deps: MergePrepCycleDeps;
  dispatched: number[]; escalated: Array<[number, string]>; reaped: number[];
} {
  const dispatched: number[] = [];
  const escalated: Array<[number, string]> = [];
  const reaped: number[] = [];
  const base: MergePrepCycleDeps = {
    cfg: CFG,
    attemptedPrep: new Map<number, PrepAttempt>(),
    reviewInFlight: new Set<number>(),
    deriveInFlight: async () => ({ inFlight: [] as InFlightMergePrep[] }),
    dispatch: async (s) => { dispatched.push(s.number); return { prNumber: s.number, branch: s.headRefName, worktreePath: `/merge-${s.number}`, pid: 1, startedAt: 0 }; },
    escalate: async (s, why) => { escalated.push([s.number, why]); },
    isCodeOwned: async () => false,
    removeWorktree: async (w) => { reaped.push(w.prNumber); },
    now: () => 1_000_000,
    ...over,
  };
  return { deps: base, dispatched, escalated, reaped };
}

describe('runMergePrepCycle', () => {
  it('dispatches a fresh stuck PR under cap and records the attempt', async () => {
    const attemptedPrep = new Map<number, PrepAttempt>();
    const { deps: d, dispatched } = deps({ stuck: [stuck(5)], attemptedPrep });
    const r = await runMergePrepCycle(d);
    expect(dispatched).toEqual([5]);
    expect(r.dispatched).toEqual([5]);
    expect(attemptedPrep.get(5)).toEqual({ headOid: 'oid5', attempts: 1 });
  });

  it('respects the cap (singleton) — excess is skippedForCap, FIFO by number', async () => {
    const { deps: d, dispatched } = deps({ stuck: [stuck(9), stuck(3)] });
    const r = await runMergePrepCycle(d);
    expect(dispatched).toEqual([3]); // FIFO
    expect(r.skippedForCap).toBe(1);
  });

  it('waits (no dispatch) when a prep worktree is already in-flight for the PR', async () => {
    const { deps: d, dispatched } = deps({
      stuck: [stuck(7)],
      deriveInFlight: async () => ({ inFlight: [{ prNumber: 7, branch: '', worktreePath: '/merge-7', pid: 1, startedAt: 1_000_000 }] }),
    });
    const r = await runMergePrepCycle(d);
    expect(dispatched).toEqual([]);
    expect(r.waiting).toEqual([7]);
  });

  it('waits when a review session is live on the PR (never prep under an active reviewer)', async () => {
    const { deps: d, dispatched } = deps({ stuck: [stuck(8)], reviewInFlight: new Set([8]) });
    const r = await runMergePrepCycle(d);
    expect(dispatched).toEqual([]);
    expect(r.waiting).toEqual([8]);
  });

  it('escalates (never preps) a code-owned PR', async () => {
    const { deps: d, dispatched, escalated } = deps({ stuck: [stuck(4)], isCodeOwned: async () => true });
    const r = await runMergePrepCycle(d);
    expect(dispatched).toEqual([]);
    expect(r.escalated).toEqual([4]);
    expect(escalated[0][1]).toContain('code-owned');
  });

  it('escalates on a same-head second sighting (the session died or pushed nothing)', async () => {
    const attemptedPrep = new Map<number, PrepAttempt>([[6, { headOid: 'oid6', attempts: 1 }]]);
    const { deps: d, dispatched, escalated } = deps({ stuck: [stuck(6)], attemptedPrep });
    const r = await runMergePrepCycle(d);
    expect(dispatched).toEqual([]);
    expect(r.escalated).toEqual([6]);
    expect(escalated[0][1]).toContain('exact head');
  });

  it('re-dispatches when the head advanced (attempts below the ceiling)', async () => {
    const attemptedPrep = new Map<number, PrepAttempt>([[6, { headOid: 'OLD', attempts: 1 }]]);
    const { deps: d, dispatched } = deps({ stuck: [stuck(6)], attemptedPrep });
    await runMergePrepCycle(d);
    expect(dispatched).toEqual([6]);
    expect(attemptedPrep.get(6)).toEqual({ headOid: 'oid6', attempts: 2 });
  });

  it('escalates once the attempt ceiling is reached across advancing heads', async () => {
    const attemptedPrep = new Map<number, PrepAttempt>([[6, { headOid: 'OLD', attempts: MAX_PREP_ATTEMPTS }]]);
    const { deps: d, dispatched, escalated } = deps({ stuck: [stuck(6)], attemptedPrep });
    const r = await runMergePrepCycle(d);
    expect(dispatched).toEqual([]);
    expect(r.escalated).toEqual([6]);
    expect(escalated[0][1]).toContain('ceiling');
  });

  it('skips an already-escalated PR entirely', async () => {
    const { deps: d, dispatched, escalated } = deps({ stuck: [stuck(2, { escalated: true })] });
    const r = await runMergePrepCycle(d);
    expect(dispatched).toEqual([]);
    expect(escalated).toEqual([]);
    expect(r).toMatchObject({ dispatched: [], escalated: [], waiting: [] });
  });

  it('reaps a stale worktree and the freed slot dispatches the same cycle', async () => {
    const now = 10 * MERGE_PREP_REAP_MS;
    const { deps: d, dispatched, reaped } = deps({
      stuck: [stuck(5)],
      now: () => now,
      // startedAt: 1 → a definitely-old, known age (unknown-age 0 is never reaped).
      deriveInFlight: async () => ({ inFlight: [{ prNumber: 99, branch: '', worktreePath: '/merge-99', pid: 1, startedAt: 1 }] }),
    });
    const r = await runMergePrepCycle(d);
    expect(reaped).toEqual([99]);
    expect(r.reaped).toEqual([99]);
    expect(dispatched).toEqual([5]); // slot freed by the reap
  });

  it('does NOT reap an unknown-age worktree (startedAt 0) — protects a fresh session', async () => {
    const { deps: d, reaped } = deps({
      stuck: [],
      now: () => 10 * MERGE_PREP_REAP_MS,
      deriveInFlight: async () => ({ inFlight: [{ prNumber: 99, branch: '', worktreePath: '/merge-99', pid: 1, startedAt: 0 }] }),
    });
    const r = await runMergePrepCycle(d);
    expect(reaped).toEqual([]);
    expect(r.reaped).toEqual([]);
  });

  it('isolates a per-PR failure — a throwing PR is recorded, the rest still run', async () => {
    const seen: number[] = [];
    const { deps: d } = deps({
      stuck: [stuck(1), stuck(2)],
      cfg: { ...CFG, mergePrepCap: 5 },
      dispatch: async (s) => {
        if (s.number === 1) throw new Error('dispatch boom');
        seen.push(s.number);
        return { prNumber: s.number, branch: s.headRefName, worktreePath: `/merge-${s.number}`, pid: 1, startedAt: 0 };
      },
    });
    const r = await runMergePrepCycle(d);
    expect(r.failed).toEqual([1]);
    expect(seen).toEqual([2]); // #2 still dispatched despite #1 throwing
  });

  it('isolates a reap failure — the worktree stays live and counts against the cap', async () => {
    const { deps: d, dispatched } = deps({
      stuck: [stuck(5)],
      now: () => 10 * MERGE_PREP_REAP_MS,
      deriveInFlight: async () => ({ inFlight: [{ prNumber: 99, branch: '', worktreePath: '/merge-99', pid: 1, startedAt: 1 }] }),
      removeWorktree: async () => { throw new Error('remove boom'); },
    });
    const r = await runMergePrepCycle(d);
    expect(r.reaped).toEqual([]);       // reap failed
    expect(dispatched).toEqual([]);     // #99 stayed live, cap(1) still full
    expect(r.skippedForCap).toBe(1);
  });

  it('does NOT reap a fresh worktree, and it still counts against the cap', async () => {
    const now = 1_000_000;
    const { deps: d, dispatched, reaped } = deps({
      stuck: [stuck(5)],
      now: () => now,
      deriveInFlight: async () => ({ inFlight: [{ prNumber: 99, branch: '', worktreePath: '/merge-99', pid: 1, startedAt: now - 1000 }] }),
    });
    const r = await runMergePrepCycle(d);
    expect(reaped).toEqual([]);
    expect(dispatched).toEqual([]);       // cap (1) filled by the fresh #99
    expect(r.skippedForCap).toBe(1);
  });
});
