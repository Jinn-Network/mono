import { describe, it, expect } from 'vitest';
import { WallClock } from '../../src/dispatcher/wall-clock.js';
import type { InFlightSession } from '../../src/dispatcher/types.js';

const session: InFlightSession = {
  issueNumber: 1,
  branch: 'feat/test-branch',
  worktreePath: '/tmp/worktree',
  pid: 12345,
  startedAt: 0,
};

describe('WallClock', () => {
  it('mid-window (500ms): expired false, softWarningDue false', () => {
    const clock = new WallClock(1000, () => 500);
    expect(clock.expired(session)).toBe(false);
    expect(clock.softWarningDue(session)).toBe(false);
  });

  it('final 10% (950ms): expired false, softWarningDue true', () => {
    const clock = new WallClock(1000, () => 950);
    expect(clock.expired(session)).toBe(false);
    expect(clock.softWarningDue(session)).toBe(true);
  });

  it('at ceiling (1000ms): expired true, softWarningDue true', () => {
    const clock = new WallClock(1000, () => 1000);
    expect(clock.expired(session)).toBe(true);
    expect(clock.softWarningDue(session)).toBe(true);
  });

  it('past ceiling (1200ms): expired true', () => {
    const clock = new WallClock(1000, () => 1200);
    expect(clock.expired(session)).toBe(true);
  });
});
