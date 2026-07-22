import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTING_WINDOW_MS,
  resolvePostingWindowMs,
} from '../../src/solver-types/_jinn-repo-posting-window.js';

describe('resolvePostingWindowMs', () => {
  it('defaults to exactly six hours when omitted / null / undefined', () => {
    expect(DEFAULT_POSTING_WINDOW_MS).toBe(6 * 60 * 60 * 1000);
    expect(resolvePostingWindowMs(undefined)).toBe(DEFAULT_POSTING_WINDOW_MS);
    expect(resolvePostingWindowMs(null)).toBe(DEFAULT_POSTING_WINDOW_MS);
  });

  it('accepts a finite positive integer override', () => {
    expect(resolvePostingWindowMs(2 * 60 * 60 * 1000)).toBe(7_200_000);
    expect(resolvePostingWindowMs(1)).toBe(1);
  });

  it('throws clearly for invalid values (no silent fallback)', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, 'fast', {}, true]) {
      expect(() => resolvePostingWindowMs(bad)).toThrow(/postingWindowMs/);
    }
  });
});
