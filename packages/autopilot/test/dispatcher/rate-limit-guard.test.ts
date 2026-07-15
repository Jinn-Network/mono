import { describe, it, expect, vi } from 'vitest';
import {
  gateOrRun,
  isSkipped,
  DEFAULT_FLOOR,
  type GateResult,
} from '../../src/dispatcher/rate-limit-guard.js';
import type { CycleDeps, CycleReport } from '../../src/dispatcher/loop.js';
import type { ProjectSnapshot } from '../../src/dispatcher/project-snapshot.js';
import { WallClock } from '../../src/dispatcher/wall-clock.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSnapshot(remaining: number, resetAt: string): ProjectSnapshot {
  return {
    items: [],
    rateLimit: { remaining, used: 5000 - remaining, resetAt },
    currentSprintIterationId: null,
  };
}

function buildReport(): CycleReport {
  return {
    dispatched: [],
    skippedForThrottle: 0,
    drift: [],
    dispatchErrors: [],
    backpressureTripped: false,
    paused: [],
    skippedForAuthor: [],
    collected: [],
  };
}

/** Minimal CycleDeps; values are never read because runCycle is injected. */
function buildDeps(): CycleDeps {
  return {
    source: { poll: vi.fn() },
    cfg: DEFAULT_CONFIG,
    deriveInFlight: vi.fn(),
    dispatchIssue: vi.fn(),
    countOpenReadyPrs: vi.fn(),
    wallClock: new WallClock(DEFAULT_CONFIG.wallClockMs, () => 0),
    pauseSession: vi.fn(),
    prevInFlight: [],
    collectCompletions: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gateOrRun — budget above floor', () => {
  it('calls runCycle and returns its CycleReport when remaining >= floor', async () => {
    const snapshot = buildSnapshot(4999, '2026-05-25T16:00:00Z');
    const deps = buildDeps();
    const fakeReport = buildReport();
    const runCycleFn = vi.fn().mockResolvedValue(fakeReport);

    const result = await gateOrRun(snapshot, deps, { runCycleFn });

    expect(isSkipped(result)).toBe(false);
    expect(result).toBe(fakeReport);
    expect(runCycleFn).toHaveBeenCalledTimes(1);
    expect(runCycleFn).toHaveBeenCalledWith(snapshot, deps);
  });

  it('calls runCycle when remaining is exactly at the floor (>= boundary)', async () => {
    const snapshot = buildSnapshot(DEFAULT_FLOOR, '2026-05-25T16:00:00Z');
    const deps = buildDeps();
    const runCycleFn = vi.fn().mockResolvedValue(buildReport());

    await gateOrRun(snapshot, deps, { runCycleFn });
    expect(runCycleFn).toHaveBeenCalledTimes(1);
  });
});

describe('gateOrRun — budget below floor', () => {
  it('returns a RateLimitSkip without calling runCycle when remaining < floor', async () => {
    const snapshot = buildSnapshot(499, '2026-05-25T16:00:00Z');
    const deps = buildDeps();
    const runCycleFn = vi.fn().mockResolvedValue(buildReport());
    // now = 15:30 UTC; reset at 16:00 UTC → 30 min + 5s = 1805000 ms
    const now = () => Date.parse('2026-05-25T15:30:00Z');

    const result = await gateOrRun(snapshot, deps, { runCycleFn, now });

    expect(runCycleFn).not.toHaveBeenCalled();
    expect(isSkipped(result)).toBe(true);
    if (isSkipped(result)) {
      expect(result.reason).toBe('budget-low');
      expect(result.remaining).toBe(499);
      expect(result.sleepMs).toBe(30 * 60 * 1000 + 5_000);
      expect(result.resetAt).toBe('2026-05-25T16:00:00Z');
    }
  });

  it('honours a custom floor override', async () => {
    const snapshot = buildSnapshot(4998, '2026-05-25T16:00:00Z');
    const deps = buildDeps();
    const runCycleFn = vi.fn().mockResolvedValue(buildReport());
    // Floor set high enough that remaining=4998 falls below it
    const result = await gateOrRun(snapshot, deps, {
      runCycleFn,
      floor: 4999,
      now: () => Date.parse('2026-05-25T15:30:00Z'),
    });

    expect(runCycleFn).not.toHaveBeenCalled();
    expect(isSkipped(result)).toBe(true);
  });
});

describe('gateOrRun — sleep duration edge cases', () => {
  it('clamps sleepMs to 0 when resetAt is already in the past (clock skew / window rolled)', async () => {
    const snapshot = buildSnapshot(0, '2026-05-25T15:00:00Z');
    const deps = buildDeps();
    const runCycleFn = vi.fn().mockResolvedValue(buildReport());
    const now = () => Date.parse('2026-05-25T15:30:00Z'); // 30 min PAST resetAt

    const result = await gateOrRun(snapshot, deps, { runCycleFn, now });

    expect(isSkipped(result)).toBe(true);
    if (isSkipped(result)) {
      expect(result.sleepMs).toBe(0);
    }
  });

  it('clamps sleepMs to a 1-hour maximum (sanity cap against malformed resetAt)', async () => {
    const snapshot = buildSnapshot(0, '2027-01-01T00:00:00Z'); // far-future
    const deps = buildDeps();
    const runCycleFn = vi.fn().mockResolvedValue(buildReport());
    const now = () => Date.parse('2026-05-25T15:00:00Z');

    const result = await gateOrRun(snapshot, deps, { runCycleFn, now });

    expect(isSkipped(result)).toBe(true);
    if (isSkipped(result)) {
      expect(result.sleepMs).toBeLessThanOrEqual(60 * 60 * 1000);
      expect(result.sleepMs).toBe(60 * 60 * 1000);
    }
  });

  it('clamps sleepMs to 0 when resetAt is unparseable', async () => {
    const snapshot = buildSnapshot(0, 'not-a-date');
    const deps = buildDeps();
    const runCycleFn = vi.fn().mockResolvedValue(buildReport());

    const result = await gateOrRun(snapshot, deps, { runCycleFn });

    expect(isSkipped(result)).toBe(true);
    if (isSkipped(result)) {
      expect(result.sleepMs).toBe(0);
    }
  });
});

describe('gateOrRun — DEFAULT_FLOOR', () => {
  it('uses DEFAULT_FLOOR (500) when no override given', async () => {
    expect(DEFAULT_FLOOR).toBe(500);

    const snapshot = buildSnapshot(499, '2026-05-25T16:00:00Z');
    const deps = buildDeps();
    const runCycleFn = vi.fn().mockResolvedValue(buildReport());

    const result = await gateOrRun(snapshot, deps, { runCycleFn });
    expect(isSkipped(result)).toBe(true);
  });
});

describe('isSkipped narrows GateResult', () => {
  it('returns true for RateLimitSkip', () => {
    const result: GateResult = {
      skipped: true,
      reason: 'budget-low',
      remaining: 0,
      sleepMs: 100,
      resetAt: '2026-05-25T16:00:00Z',
    };
    expect(isSkipped(result)).toBe(true);
  });

  it('returns false for CycleReport', () => {
    const result: GateResult = buildReport();
    expect(isSkipped(result)).toBe(false);
  });
});
