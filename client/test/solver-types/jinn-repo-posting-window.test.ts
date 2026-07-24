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

  it('accepts a finite integer override at or above six hours', () => {
    expect(resolvePostingWindowMs(DEFAULT_POSTING_WINDOW_MS)).toBe(
      DEFAULT_POSTING_WINDOW_MS,
    );
    expect(resolvePostingWindowMs(7 * 60 * 60 * 1000)).toBe(25_200_000);
  });

  it('rejects finite integer overrides below the six-hour floor', () => {
    for (const bad of [
      1,
      DEFAULT_POSTING_WINDOW_MS - 1,
      2 * 60 * 60 * 1000,
    ]) {
      expect(() => resolvePostingWindowMs(bad)).toThrow(/at least six hours/);
    }
  });

  it('throws clearly for other invalid values (no silent fallback)', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, 'fast', {}, true]) {
      expect(() => resolvePostingWindowMs(bad)).toThrow(/at least six hours/);
    }
  });
});
