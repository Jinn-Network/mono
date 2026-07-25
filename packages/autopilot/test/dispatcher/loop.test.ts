import { describe, it, expect, vi } from 'vitest';
import { runCycle } from '../../src/dispatcher/loop.js';
import type { CycleReport } from '../../src/dispatcher/loop.js';
import { WallClock } from '../../src/dispatcher/wall-clock.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import type {
  PolledIssue,
  ReadyIssue,
  InFlightSession,
  DispatcherConfig,
  SessionResult,
} from '../../src/dispatcher/types.js';
import type { IssueSource } from '../../src/dispatcher/issue-source.js';
import type { ProjectSnapshot } from '../../src/dispatcher/project-snapshot.js';
import type { PrLink } from '../../src/dispatcher/pr-links.js';

/**
 * runCycle is now snapshot-driven (jinn-mono#585). These tests inject a
 * mocked IssueSource whose `poll` returns canned issues regardless of the
 * snapshot, so we can pass a trivial snapshot — the dispatcher's decisions
 * are tested via `polled` + `inFlight` + `openPrCount`, not the snapshot
 * contents.
 */
const EMPTY_SNAPSHOT: ProjectSnapshot = {
  items: [],
  rateLimit: { remaining: 5000, used: 0, resetAt: '2026-05-25T16:00:00Z' },
  currentSprintIterationId: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolled(overrides: Partial<PolledIssue> = {}): PolledIssue {
  return {
    number: 100,
    title: 'Test issue',
    shape: 'feat',
    blockedOn: 'Nothing',
    blockedByIssues: [],
    effort: 'Low',
    priority: 'P1',
    status: 'Todo',
    onBoard: true,
    author: 'alice',
    projectItemId: 'PVTI_test',
    inCurrentSprint: false,
    ...overrides,
  };
}

function makeInFlight(issueNumber: number, startedAt?: number): InFlightSession {
  return {
    issueNumber,
    branch: `feat/${issueNumber}-something`,
    worktreePath: `/tmp/fixture/jinn-mono_worktrees/${issueNumber}`,
    pid: 1234,
    startedAt: startedAt ?? Date.now(),
    logPath: `/tmp/fixture/sessions/${issueNumber}.log`,
  };
}

function makeSource(issues: PolledIssue[]): IssueSource {
  return { poll: vi.fn().mockResolvedValue(issues) };
}

/**
 * Default test cfg: `authorAllowlist: ['alice']` matches the `makePolled`
 * default author so callers don't have to thread it everywhere. Pass
 * `authorAllowlist: []` (or any other override) to exercise that path.
 */
function makeCfg(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return { ...DEFAULT_CONFIG, authorAllowlist: ['alice'], ...overrides };
}

/** A WallClock that never expires any session (all sessions are fresh). */
function makeNeverExpiredClock(): WallClock {
  // Use a nowFn that always returns 0 so elapsed is always negative vs. a large wallClockMs
  return new WallClock(DEFAULT_CONFIG.wallClockMs, () => 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCycle', () => {
  it('dispatches ready issues up to concurrency budget', async () => {
    // 3 ready issues, 0 in-flight, cap=3 → dispatch all 3
    const issues = [
      makePolled({ number: 101, priority: 'P1' }),
      makePolled({ number: 102, priority: 'P2' }),
      makePolled({ number: 103, priority: 'P3' }),
    ];
    const source = makeSource(issues);
    const cfg = makeCfg({ concurrencyCap: 3 });

    const dispatchedNumbers: number[] = [];
    const dispatchIssue = vi.fn().mockImplementation((issue: ReadyIssue) => {
      dispatchedNumbers.push(issue.number);
      return Promise.resolve(makeInFlight(issue.number));
    });

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(report.dispatched.map((d) => d.issueNumber)).toEqual([101, 102, 103]);
    // #533 AC#2: each dispatched session carries its spawned pid + log path so
    // the cycle report can surface them. makeInFlight stubs both fields.
    expect(report.dispatched).toEqual([
      { issueNumber: 101, pid: 1234, logPath: '/tmp/fixture/sessions/101.log' },
      { issueNumber: 102, pid: 1234, logPath: '/tmp/fixture/sessions/102.log' },
      { issueNumber: 103, pid: 1234, logPath: '/tmp/fixture/sessions/103.log' },
    ]);
    expect(report.skippedForThrottle).toBe(0);
    expect(report.drift).toEqual([]);
    expect(report.backpressureTripped).toBe(false);
    expect(report.paused).toEqual([]);
    expect(report.skippedForAuthor).toEqual([]);
    expect(dispatchIssue).toHaveBeenCalledTimes(3);
  });

  it('dispatches only up to remaining budget when some in-flight', async () => {
    // 3 ready issues, 2 in-flight, cap=3 → budget=1, dispatch only 1
    const issues = [
      makePolled({ number: 101, priority: 'P1' }),
      makePolled({ number: 102, priority: 'P2' }),
      makePolled({ number: 103, priority: 'P3' }),
    ];
    const source = makeSource(issues);
    const cfg = makeCfg({ concurrencyCap: 3 });

    // In-flight are 201, 202 (not overlapping with ready 101-103)
    const existingInFlight = [makeInFlight(201), makeInFlight(202)];

    const dispatchIssue = vi.fn().mockImplementation((issue: ReadyIssue) =>
      Promise.resolve(makeInFlight(issue.number)),
    );

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: existingInFlight, drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    // Budget = 3 - 2 = 1; only top-priority (101) is dispatched
    expect(report.dispatched.map((d) => d.issueNumber)).toEqual([101]);
    expect(report.skippedForThrottle).toBe(2); // 102, 103 skipped
    expect(report.backpressureTripped).toBe(false);
    expect(report.paused).toEqual([]);
    expect(report.skippedForAuthor).toEqual([]);
    expect(dispatchIssue).toHaveBeenCalledTimes(1);
  });

  it('dispatches nothing when in-flight fills the cap (budget 0)', async () => {
    // 3 ready issues, cap=3, 3 in-flight → budget=0
    const issues = [
      makePolled({ number: 101, priority: 'P1' }),
      makePolled({ number: 102, priority: 'P2' }),
    ];
    const source = makeSource(issues);
    const cfg = makeCfg({ concurrencyCap: 3 });

    const existingInFlight = [makeInFlight(201), makeInFlight(202), makeInFlight(203)];

    const dispatchIssue = vi.fn().mockResolvedValue(makeInFlight(999));

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: existingInFlight, drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(report.dispatched).toEqual([]);
    expect(report.skippedForThrottle).toBe(2);
    expect(report.backpressureTripped).toBe(false);
    expect(report.paused).toEqual([]);
    expect(report.skippedForAuthor).toEqual([]);
    expect(dispatchIssue).not.toHaveBeenCalled();
  });

  it('trips backpressure when open ready PRs exceed threshold', async () => {
    // Plenty of ready issues, but 6 open ready PRs > threshold 5 → dispatch nothing
    const issues = [
      makePolled({ number: 101, priority: 'P0' }),
      makePolled({ number: 102, priority: 'P1' }),
    ];
    const source = makeSource(issues);
    const cfg = makeCfg({ concurrencyCap: 3, openPrBackpressure: 5 });

    const dispatchIssue = vi.fn().mockResolvedValue(makeInFlight(999));

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(6), // over threshold
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(report.dispatched).toEqual([]);
    expect(report.backpressureTripped).toBe(true);
    expect(report.skippedForAuthor).toEqual([]);
    expect(dispatchIssue).not.toHaveBeenCalled();
  });

  it('includes drift strings from deriveInFlight in the report', async () => {
    const source = makeSource([]);
    const cfg = makeCfg();

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({
        inFlight: [],
        drift: ['drift: issue #999 is In Progress on the board but has no worktree'],
      }),
      dispatchIssue: vi.fn(),
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toContain('#999');
  });

  it('excludes in-flight issues from ready set', async () => {
    // Issues 101 and 102 are polled; 101 is already in-flight
    const issues = [
      makePolled({ number: 101, priority: 'P1' }),
      makePolled({ number: 102, priority: 'P2' }),
    ];
    const source = makeSource(issues);
    const cfg = makeCfg({ concurrencyCap: 3 });

    const existingInFlight = [makeInFlight(101)]; // 101 already running

    const dispatchIssue = vi.fn().mockImplementation((issue: ReadyIssue) =>
      Promise.resolve(makeInFlight(issue.number)),
    );

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: existingInFlight, drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    // Only 102 should be dispatched; 101 is in-flight (budget = 3-1 = 2, but only 1 ready)
    expect(report.dispatched.map((d) => d.issueNumber)).toEqual([102]);
    expect(dispatchIssue).toHaveBeenCalledTimes(1);
    expect(dispatchIssue.mock.calls[0][0].number).toBe(102);
  });

  it('pauses an in-flight session whose wall-clock ceiling is exceeded', async () => {
    // Issue 201 started at t=1ms (a real, known start time). The clock's nowFn
    // returns WALL_CLOCK_MS + 1001ms — elapsed is 4h+1s, past the ceiling.
    // NOTE: startedAt=0 is the *unknown-age sentinel* (Bug 2b fix) and is
    // never treated as expired. Use startedAt=1 to represent a known old start.
    const WALL_CLOCK_MS = 4 * 60 * 60 * 1000; // 4 hours
    const expiredSession = makeInFlight(201, 1); // started at 1ms (known, old)
    const nowMs = WALL_CLOCK_MS + 1001; // elapsed = WALL_CLOCK_MS+1000ms ≥ ceiling

    // A WallClock whose nowFn returns nowMs — session 201 is expired
    const wallClock = new WallClock(WALL_CLOCK_MS, () => nowMs);
    const pauseSession = vi.fn().mockResolvedValue(undefined);

    const source = makeSource([]);
    const cfg = makeCfg({ concurrencyCap: 3, wallClockMs: WALL_CLOCK_MS });

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [expiredSession], drift: [] }),
      dispatchIssue: vi.fn(),
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock,
      pauseSession,
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    // pauseSession must be called for the expired session
    expect(pauseSession).toHaveBeenCalledOnce();
    expect(pauseSession).toHaveBeenCalledWith(201);

    // The paused session must appear in CycleReport.paused
    expect(report.paused).toEqual([201]);
  });

  it('dispatches nothing when the allowlist is empty (fail-safe)', async () => {
    // Otherwise fully-ready issue authored by a trusted-looking user;
    // an empty allowlist must filter it out and surface it in skippedForAuthor.
    const issues = [
      makePolled({ number: 444, priority: 'P0', author: 'trusteduser' }),
    ];
    const source = makeSource(issues);
    const cfg = makeCfg({ authorAllowlist: [] });

    const dispatchIssue = vi.fn().mockImplementation((issue: ReadyIssue) =>
      Promise.resolve(makeInFlight(issue.number)),
    );

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(report.dispatched).toEqual([]);
    expect(report.skippedForAuthor).toEqual([{ number: 444, author: 'trusteduser' }]);
    expect(dispatchIssue).not.toHaveBeenCalled();
  });

  it('does not pause in-flight sessions that are within the wall-clock ceiling', async () => {
    const WALL_CLOCK_MS = 4 * 60 * 60 * 1000;
    const freshSession = makeInFlight(301, Date.now()); // just started

    // WallClock uses real Date.now — session is fresh, not expired
    const wallClock = new WallClock(WALL_CLOCK_MS);
    const pauseSession = vi.fn().mockResolvedValue(undefined);

    const source = makeSource([]);
    const cfg = makeCfg({ wallClockMs: WALL_CLOCK_MS });

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [freshSession], drift: [] }),
      dispatchIssue: vi.fn(),
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock,
      pauseSession,
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(pauseSession).not.toHaveBeenCalled();
    expect(report.paused).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Finished-session detection (#489): the previous-vs-current in-flight diff is
// classified by the injected `collectCompletions` dep; `runCycle` hands it the
// full prev + current sets and surfaces the result in `report.collected`.
// ---------------------------------------------------------------------------

describe('runCycle — collectCompletions / report.collected', () => {
  it('calls collectCompletions with (prev, current) and surfaces its result', async () => {
    const source = makeSource([]);
    const cfg = makeCfg();

    // 102 still running; 101 finished (in prev, not in current).
    const current = [makeInFlight(102)];
    const prev = [makeInFlight(101), makeInFlight(102)];
    const collected: SessionResult[] = [
      { issueNumber: 101, outcome: 'pr-opened', prNumber: 900 },
    ];
    const collectCompletions = vi.fn().mockResolvedValue(collected);

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: current, drift: [] }),
      dispatchIssue: vi.fn(),
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: prev,
      collectCompletions,
    });

    expect(collectCompletions).toHaveBeenCalledOnce();
    const [prevArg, currentArg] = collectCompletions.mock.calls[0];
    expect(prevArg.map((s: InFlightSession) => s.issueNumber).sort()).toEqual([101, 102]);
    expect(currentArg.map((s: InFlightSession) => s.issueNumber)).toEqual([102]);
    expect(report.collected).toEqual(collected);
  });

  it('reports collected:[] when the in-flight set is unchanged', async () => {
    const source = makeSource([]);
    const cfg = makeCfg();
    const same = [makeInFlight(102)];
    const collectCompletions = vi.fn().mockResolvedValue([]);

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: same, drift: [] }),
      dispatchIssue: vi.fn(),
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [makeInFlight(102)],
      collectCompletions,
    });

    expect(collectCompletions).toHaveBeenCalledOnce();
    expect(report.collected).toEqual([]);
  });

  it('reports collected:[] on the first cycle (prevInFlight empty)', async () => {
    const source = makeSource([]);
    const cfg = makeCfg();
    const collectCompletions = vi.fn().mockResolvedValue([]);

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [makeInFlight(102)], drift: [] }),
      dispatchIssue: vi.fn(),
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions,
    });

    expect(report.collected).toEqual([]);
  });

  it('still collects completions even when backpressure is tripped', async () => {
    const source = makeSource([makePolled({ number: 101 })]);
    const cfg = makeCfg({ openPrBackpressure: 5 });

    const collected: SessionResult[] = [
      { issueNumber: 101, outcome: 'escalated' },
    ];
    const collectCompletions = vi.fn().mockResolvedValue(collected);

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue: vi.fn(),
      countOpenReadyPrs: vi.fn().mockResolvedValue(6), // over threshold → backpressure
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [makeInFlight(101)],
      collectCompletions,
    });

    expect(report.backpressureTripped).toBe(true);
    expect(collectCompletions).toHaveBeenCalledOnce();
    expect(report.collected).toEqual(collected);
  });

  // --- dependency-stacking wiring end-to-end (review 2026-07-13) ---

  it('dispatches a Blocked-on-Another-issue issue stacked on its blocker open PR', async () => {
    const blocked = makePolled({ number: 200, blockedOn: 'Another issue', blockedByIssues: [100] });
    let dispatchedBase: string | undefined = 'UNSET';
    const dispatchIssue = vi.fn().mockImplementation((issue: ReadyIssue) => {
      dispatchedBase = issue.stackBase;
      return Promise.resolve(makeInFlight(issue.number));
    });
    const prMap = new Map<number, PrLink[]>([
      [100, [{ prNumber: 10, headRefName: 'feat/100-base', baseRefName: 'next', state: 'OPEN', isDraft: true, author: 'alice', labels: [] }]],
    ]);
    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source: makeSource([blocked]),
      cfg: makeCfg({ concurrencyCap: 3 }), // allowlist ['alice']
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      fetchIssuePrMap: vi.fn().mockResolvedValue(prMap),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });
    expect(report.dispatched.map((d) => d.issueNumber)).toEqual([200]);
    expect(dispatchedBase).toBe('feat/100-base');
  });

  it('does NOT dispatch a blocked issue when the blocker PR author is not allowlisted', async () => {
    const blocked = makePolled({ number: 200, blockedOn: 'Another issue', blockedByIssues: [100] });
    const dispatchIssue = vi.fn();
    const prMap = new Map<number, PrLink[]>([
      [100, [{ prNumber: 10, headRefName: 'feat/100-base', baseRefName: 'next', state: 'OPEN', isDraft: true, author: 'outsider', labels: [] }]],
    ]);
    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source: makeSource([blocked]),
      cfg: makeCfg({ concurrencyCap: 3 }), // allowlist ['alice'] — 'outsider' not on it
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      fetchIssuePrMap: vi.fn().mockResolvedValue(prMap),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });
    expect(report.dispatched).toEqual([]);
    expect(dispatchIssue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dispatch isolation (review 2026-07-15): one failing dispatchIssue must not
// abort the remaining dispatches — observed live when a dangling branch ref
// fataled `worktree add` and took the whole cycle's dispatch loop down.
// ---------------------------------------------------------------------------

describe('runCycle — dispatch isolation', () => {
  it('a failing dispatch is reported and the rest of the batch still dispatches', async () => {
    const a = makePolled({ number: 100 });
    const b = makePolled({ number: 200 });
    const dispatchIssue = vi.fn().mockImplementation((issue: ReadyIssue) => {
      if (issue.number === 100) {
        return Promise.reject(new Error('git worktree add failed: branch already exists'));
      }
      return Promise.resolve(makeInFlight(issue.number));
    });
    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source: makeSource([a, b]),
      cfg: makeCfg({ concurrencyCap: 5 }),
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });
    expect(dispatchIssue).toHaveBeenCalledTimes(2);
    expect(report.dispatched.map((d) => d.issueNumber)).toEqual([200]);
    expect(report.dispatchErrors).toEqual([
      { issueNumber: 100, message: 'git worktree add failed: branch already exists' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Execution-mode branch (issue #1893, spec
// 2026-07-20-autopilot-marketplace-execution.md §Generator): `local` (the
// default) dispatches unchanged via `dispatchIssue`; `marketplace` routes
// ready issues to the marketplace via `routeToMarketplace` instead. Both
// share every gate above (ready-filter, backpressure, concurrency) — only
// the terminal per-issue action in step 7 differs.
// ---------------------------------------------------------------------------

describe('runCycle — execution-mode branch (issue #1893)', () => {
  it("executionMode default ('local') never calls routeToMarketplace, even when provided (fail-safe)", async () => {
    const issues = [makePolled({ number: 301 })];
    const dispatchIssue = vi.fn().mockResolvedValue(makeInFlight(301));
    const routeToMarketplace = vi.fn().mockResolvedValue({ issueNumber: 301, action: 'created' });

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source: makeSource(issues),
      cfg: makeCfg(), // executionMode defaults to 'local' via DEFAULT_CONFIG
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue,
      routeToMarketplace,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(dispatchIssue).toHaveBeenCalledTimes(1);
    expect(routeToMarketplace).not.toHaveBeenCalled();
    expect(report.dispatched.map((d) => d.issueNumber)).toEqual([301]);
    expect(report.routedToMarketplace).toEqual([]);
  });

  it("executionMode 'marketplace' routes ready issues via routeToMarketplace instead of dispatchIssue", async () => {
    const issues = [
      makePolled({ number: 401, priority: 'P1' }),
      makePolled({ number: 402, priority: 'P2' }),
    ];
    const dispatchIssue = vi.fn().mockResolvedValue(makeInFlight(999));
    const routeToMarketplace = vi.fn().mockImplementation((issue: ReadyIssue) =>
      Promise.resolve({ issueNumber: issue.number, action: 'created' as const }),
    );

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source: makeSource(issues),
      cfg: makeCfg({ executionMode: 'marketplace', concurrencyCap: 3 }),
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue,
      routeToMarketplace,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(dispatchIssue).not.toHaveBeenCalled();
    expect(routeToMarketplace).toHaveBeenCalledTimes(2);
    expect(report.dispatched).toEqual([]);
    expect(report.routedToMarketplace).toEqual([
      { issueNumber: 401, action: 'created' },
      { issueNumber: 402, action: 'created' },
    ]);
  });

  it("executionMode 'marketplace' respects the same concurrency budget as local mode", async () => {
    const issues = [
      makePolled({ number: 501, priority: 'P1' }),
      makePolled({ number: 502, priority: 'P2' }),
      makePolled({ number: 503, priority: 'P3' }),
    ];
    const routeToMarketplace = vi.fn().mockImplementation((issue: ReadyIssue) =>
      Promise.resolve({ issueNumber: issue.number, action: 'created' as const }),
    );

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source: makeSource(issues),
      cfg: makeCfg({ executionMode: 'marketplace', concurrencyCap: 1 }),
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue: vi.fn(),
      routeToMarketplace,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(routeToMarketplace).toHaveBeenCalledTimes(1);
    expect(report.routedToMarketplace).toEqual([{ issueNumber: 501, action: 'created' }]);
    expect(report.skippedForThrottle).toBe(2);
    // The FULL ready set (unsliced) is still surfaced for the retract sweep,
    // regardless of the concurrency budget applied to `routedToMarketplace`.
    expect(report.readyIssueNumbers).toEqual([501, 502, 503]);
  });

  it("executionMode 'marketplace' without a routeToMarketplace dep fails per-issue (not the whole cycle)", async () => {
    const issues = [makePolled({ number: 601 })];

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source: makeSource(issues),
      cfg: makeCfg({ executionMode: 'marketplace' }),
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue: vi.fn(),
      // routeToMarketplace deliberately omitted
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(report.routedToMarketplace).toEqual([]);
    expect(report.dispatchErrors).toHaveLength(1);
    expect(report.dispatchErrors[0]!.issueNumber).toBe(601);
    expect(report.dispatchErrors[0]!.message).toContain('routeToMarketplace');
  });

  it('readyIssueNumbers surfaces the full ready set even when backpressure trips (local mode)', async () => {
    const issues = [makePolled({ number: 701 }), makePolled({ number: 702 })];

    const report: CycleReport = await runCycle(EMPTY_SNAPSHOT, {
      source: makeSource(issues),
      cfg: makeCfg({ openPrBackpressure: 1 }),
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue: vi.fn(),
      countOpenReadyPrs: vi.fn().mockResolvedValue(10), // over the threshold
      wallClock: makeNeverExpiredClock(),
      pauseSession: vi.fn().mockResolvedValue(undefined),
      prevInFlight: [],
      collectCompletions: vi.fn().mockResolvedValue([]),
    });

    expect(report.backpressureTripped).toBe(true);
    expect(report.routedToMarketplace).toEqual([]);
    expect(report.readyIssueNumbers).toEqual([701, 702]);
  });
});
