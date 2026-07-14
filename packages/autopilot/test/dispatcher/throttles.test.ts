import { describe, it, expect } from 'vitest';
import { concurrencyOk, backpressureOk } from '../../src/dispatcher/throttles.js';

describe('concurrencyOk', () => {
  it('returns true when in-flight count is below the cap', () => {
    expect(concurrencyOk(2, 3)).toBe(true);
  });

  it('returns false when in-flight count is at the cap', () => {
    expect(concurrencyOk(3, 3)).toBe(false);
  });

  it('returns true when idle (zero in-flight)', () => {
    expect(concurrencyOk(0, 3)).toBe(true);
  });
});

describe('backpressureOk', () => {
  it('returns true when open ready PR count is at the threshold', () => {
    expect(backpressureOk(5, 5)).toBe(true);
  });

  it('returns false when open ready PR count exceeds the threshold', () => {
    expect(backpressureOk(6, 5)).toBe(false);
  });

  it('returns true when the queue is empty', () => {
    expect(backpressureOk(0, 5)).toBe(true);
  });
});
