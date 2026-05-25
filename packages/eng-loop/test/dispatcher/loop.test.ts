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
} from '../../src/dispatcher/types.js';
import type { IssueSource } from '../../src/dispatcher/issue-source.js';
import type { ProjectSnapshot } from '../../src/dispatcher/project-snapshot.js';

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
    blockedOnIssue: null,
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
    });

    expect(report.dispatched).toEqual([101, 102, 103]);
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
    });

    // Budget = 3 - 2 = 1; only top-priority (101) is dispatched
    expect(report.dispatched).toEqual([101]);
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
    });

    // Only 102 should be dispatched; 101 is in-flight (budget = 3-1 = 2, but only 1 ready)
    expect(report.dispatched).toEqual([102]);
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
    });

    expect(pauseSession).not.toHaveBeenCalled();
    expect(report.paused).toEqual([]);
  });
});
