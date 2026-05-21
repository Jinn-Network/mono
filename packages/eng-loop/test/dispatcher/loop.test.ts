import { describe, it, expect, vi } from 'vitest';
import { runCycle } from '../../src/dispatcher/loop.js';
import type { CycleReport } from '../../src/dispatcher/loop.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import type {
  PolledIssue,
  ReadyIssue,
  InFlightSession,
  DispatcherConfig,
} from '../../src/dispatcher/types.js';
import type { IssueSource } from '../../src/dispatcher/issue-source.js';

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
    ...overrides,
  };
}

function makeInFlight(issueNumber: number): InFlightSession {
  return {
    issueNumber,
    branch: `feat/${issueNumber}-something`,
    worktreePath: `cargo/.tasks/${issueNumber}`,
    pid: 1234,
    startedAt: Date.now(),
  };
}

function makeSource(issues: PolledIssue[]): IssueSource {
  return { poll: vi.fn().mockResolvedValue(issues) };
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
    const cfg: DispatcherConfig = { ...DEFAULT_CONFIG, concurrencyCap: 3 };

    const dispatchedNumbers: number[] = [];
    const dispatchIssue = vi.fn().mockImplementation((issue: ReadyIssue) => {
      dispatchedNumbers.push(issue.number);
      return Promise.resolve(makeInFlight(issue.number));
    });

    const report: CycleReport = await runCycle({
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
    });

    expect(report.dispatched).toEqual([101, 102, 103]);
    expect(report.skippedForThrottle).toBe(0);
    expect(report.drift).toEqual([]);
    expect(report.backpressureTripped).toBe(false);
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
    const cfg: DispatcherConfig = { ...DEFAULT_CONFIG, concurrencyCap: 3 };

    // In-flight are 201, 202 (not overlapping with ready 101-103)
    const existingInFlight = [makeInFlight(201), makeInFlight(202)];

    const dispatchIssue = vi.fn().mockImplementation((issue: ReadyIssue) =>
      Promise.resolve(makeInFlight(issue.number)),
    );

    const report: CycleReport = await runCycle({
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: existingInFlight, drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
    });

    // Budget = 3 - 2 = 1; only top-priority (101) is dispatched
    expect(report.dispatched).toEqual([101]);
    expect(report.skippedForThrottle).toBe(2); // 102, 103 skipped
    expect(report.backpressureTripped).toBe(false);
    expect(dispatchIssue).toHaveBeenCalledTimes(1);
  });

  it('dispatches nothing when in-flight fills the cap (budget 0)', async () => {
    // 3 ready issues, cap=3, 3 in-flight → budget=0
    const issues = [
      makePolled({ number: 101, priority: 'P1' }),
      makePolled({ number: 102, priority: 'P2' }),
    ];
    const source = makeSource(issues);
    const cfg: DispatcherConfig = { ...DEFAULT_CONFIG, concurrencyCap: 3 };

    const existingInFlight = [makeInFlight(201), makeInFlight(202), makeInFlight(203)];

    const dispatchIssue = vi.fn().mockResolvedValue(makeInFlight(999));

    const report: CycleReport = await runCycle({
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: existingInFlight, drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
    });

    expect(report.dispatched).toEqual([]);
    expect(report.skippedForThrottle).toBe(2);
    expect(report.backpressureTripped).toBe(false);
    expect(dispatchIssue).not.toHaveBeenCalled();
  });

  it('trips backpressure when open ready PRs exceed threshold', async () => {
    // Plenty of ready issues, but 6 open ready PRs > threshold 5 → dispatch nothing
    const issues = [
      makePolled({ number: 101, priority: 'P0' }),
      makePolled({ number: 102, priority: 'P1' }),
    ];
    const source = makeSource(issues);
    const cfg: DispatcherConfig = { ...DEFAULT_CONFIG, concurrencyCap: 3, openPrBackpressure: 5 };

    const dispatchIssue = vi.fn().mockResolvedValue(makeInFlight(999));

    const report: CycleReport = await runCycle({
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: [], drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(6), // over threshold
    });

    expect(report.dispatched).toEqual([]);
    expect(report.backpressureTripped).toBe(true);
    expect(dispatchIssue).not.toHaveBeenCalled();
  });

  it('includes drift strings from deriveInFlight in the report', async () => {
    const source = makeSource([]);
    const cfg: DispatcherConfig = { ...DEFAULT_CONFIG };

    const report: CycleReport = await runCycle({
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({
        inFlight: [],
        drift: ['drift: issue #999 is In Progress on the board but has no worktree'],
      }),
      dispatchIssue: vi.fn(),
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
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
    const cfg: DispatcherConfig = { ...DEFAULT_CONFIG, concurrencyCap: 3 };

    const existingInFlight = [makeInFlight(101)]; // 101 already running

    const dispatchIssue = vi.fn().mockImplementation((issue: ReadyIssue) =>
      Promise.resolve(makeInFlight(issue.number)),
    );

    const report: CycleReport = await runCycle({
      source,
      cfg,
      deriveInFlight: vi.fn().mockResolvedValue({ inFlight: existingInFlight, drift: [] }),
      dispatchIssue,
      countOpenReadyPrs: vi.fn().mockResolvedValue(0),
    });

    // Only 102 should be dispatched; 101 is in-flight (budget = 3-1 = 2, but only 1 ready)
    expect(report.dispatched).toEqual([102]);
    expect(dispatchIssue).toHaveBeenCalledTimes(1);
    expect(dispatchIssue.mock.calls[0][0].number).toBe(102);
  });
});
