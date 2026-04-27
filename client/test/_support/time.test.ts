import { describe, it, expect } from 'vitest';
import { FakeClock } from '@test/time.js';

describe('FakeClock', () => {
  it('returns the initial time', () => {
    const clock = new FakeClock(1000);
    expect(clock.now()).toBe(1000);
  });

  it('advances by the given number of ms', () => {
    const clock = new FakeClock(0);
    clock.advance(500);
    expect(clock.now()).toBe(500);
    clock.advance(250);
    expect(clock.now()).toBe(750);
  });

  it('defaults to Date.now() when no initial time is given', () => {
    const before = Date.now();
    const clock = new FakeClock();
    const after = Date.now();
    expect(clock.now()).toBeGreaterThanOrEqual(before);
    expect(clock.now()).toBeLessThanOrEqual(after);
  });
});
