import { describe, it, expect } from 'vitest';
import { WallClock } from '../../src/dispatcher/wall-clock.js';
import type { InFlightSession } from '../../src/dispatcher/types.js';

/** A session with a known start time (1 ms epoch). */
const session: InFlightSession = {
  issueNumber: 1,
  branch: 'feat/test-branch',
  worktreePath: '/tmp/worktree',
  pid: 12345,
  startedAt: 1,
  logPath: '/tmp/sessions/1.log',
};

/** A re-derived session whose start time is unknown (sentinel value 0). */
const unknownAgeSession: InFlightSession = {
  issueNumber: 2,
  branch: 'feat/rederived-branch',
  worktreePath: '/tmp/rederived-worktree',
  pid: null,
  startedAt: 0,
  logPath: '/tmp/sessions/2.log',
};

describe('WallClock', () => {
  it('mid-window (500ms): expired false, softWarningDue false', () => {
    const clock = new WallClock(1000, () => 501);
    expect(clock.expired(session)).toBe(false);
    expect(clock.softWarningDue(session)).toBe(false);
  });

  it('final 10% (950ms): expired false, softWarningDue true', () => {
    const clock = new WallClock(1000, () => 951);
    expect(clock.expired(session)).toBe(false);
    expect(clock.softWarningDue(session)).toBe(true);
  });

  it('at ceiling (1000ms): expired true, softWarningDue true', () => {
    const clock = new WallClock(1000, () => 1001);
    expect(clock.expired(session)).toBe(true);
    expect(clock.softWarningDue(session)).toBe(true);
  });

  it('past ceiling (1200ms): expired true', () => {
    const clock = new WallClock(1000, () => 1201);
    expect(clock.expired(session)).toBe(true);
  });

  describe('unknown-age session (startedAt: 0)', () => {
    it('expired() is false regardless of nowFn — unknown sessions are never force-paused', () => {
      // nowFn returning a very large value (decades of elapsed ms) must still return false
      const clock = new WallClock(1000, () => Date.now());
      expect(clock.expired(unknownAgeSession)).toBe(false);
    });

    it('softWarningDue() is false regardless of nowFn', () => {
      const clock = new WallClock(1000, () => Date.now());
      expect(clock.softWarningDue(unknownAgeSession)).toBe(false);
    });

    it('both remain false even when nowFn returns a small value', () => {
      // Confirm the guard is on startedAt, not on elapsed magnitude
      const clock = new WallClock(1000, () => 500);
      expect(clock.expired(unknownAgeSession)).toBe(false);
      expect(clock.softWarningDue(unknownAgeSession)).toBe(false);
    });
  });
});
