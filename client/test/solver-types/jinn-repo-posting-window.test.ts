import { describe, expect, it } from 'vitest';
import * as postingWindow from '../../src/solver-types/_jinn-repo-posting-window.js';

const { DEFAULT_POSTING_WINDOW_MS, resolvePostingWindowMs } = postingWindow;
const NODE_MAX_TIMER_MS = 2_147_483_647;

describe('resolvePostingWindowMs', () => {
  it('exports Node’s signed 32-bit timer ceiling as the maximum', () => {
    expect(postingWindow).toHaveProperty(
      'MAX_POSTING_WINDOW_MS',
      NODE_MAX_TIMER_MS,
    );
  });

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
    expect(resolvePostingWindowMs(NODE_MAX_TIMER_MS)).toBe(NODE_MAX_TIMER_MS);
  });

  it('rejects finite integer overrides below the six-hour floor', () => {
    for (const bad of [
      1,
      DEFAULT_POSTING_WINDOW_MS - 1,
      2 * 60 * 60 * 1000,
    ]) {
      expect(() => resolvePostingWindowMs(bad)).toThrow(
        /between six hours .*2147483647 ms/,
      );
    }
  });

  it('throws clearly for other invalid values (no silent fallback)', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, 'fast', {}, true]) {
      expect(() => resolvePostingWindowMs(bad)).toThrow(
        /between six hours .*2147483647 ms/,
      );
    }
  });

  it('rejects durations above Node’s timer ceiling and unsafe integers', () => {
    for (const bad of [
      NODE_MAX_TIMER_MS + 1,
      30 * 24 * 60 * 60 * 1000,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => resolvePostingWindowMs(bad)).toThrow(
        /between six hours .*2147483647 ms/,
      );
    }
  });
});
