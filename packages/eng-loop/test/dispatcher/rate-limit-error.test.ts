import { describe, it, expect } from 'vitest';
import { classifyRateLimitError } from '../../src/dispatcher/rate-limit-error.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a header-bearing stderr string mimicking gh's 403/429 error dump. */
function headerStderr(
  status: 403 | 429,
  remaining: number,
  resetSec?: number,
): string {
  const lines = [
    `gh: failed to run git: exit status 1`,
    `HTTP ${status}`,
    `X-RateLimit-Limit: 5000`,
    `X-RateLimit-Remaining: ${remaining}`,
  ];
  if (resetSec !== undefined) {
    lines.push(`X-RateLimit-Reset: ${resetSec}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyRateLimitError — phrase detection', () => {
  it('detects GraphQL rate-limit phrase in stderr, default 5-min sleep, no resetAt', () => {
    const err = { stderr: 'gh: API rate limit exceeded for user ID 123.' };
    const result = classifyRateLimitError(err);

    expect(result.isRateLimit).toBe(true);
    expect(result.sleepMs).toBe(5 * 60 * 1000);
    expect(result.resetAt).toBeUndefined();
    expect('resetAt' in result).toBe(false);
  });

  it('detects the phrase in the message field (coalesce coverage)', () => {
    const err = { message: 'something: rate limit exceeded; retry later' };
    const result = classifyRateLimitError(err);

    expect(result.isRateLimit).toBe(true);
    expect(result.sleepMs).toBe(5 * 60 * 1000);
  });
});

describe('classifyRateLimitError — non-rate-limit', () => {
  it('returns isRateLimit false for a plain unrelated error', () => {
    const result = classifyRateLimitError(new Error('fatal: branch already exists'));
    expect(result.isRateLimit).toBe(false);
    expect(result.sleepMs).toBe(0);
    expect('resetAt' in result).toBe(false);
  });

  it('does not trip on a 403 line when remaining is non-zero', () => {
    const err = { stderr: headerStderr(403, 12) };
    const result = classifyRateLimitError(err);
    expect(result.isRateLimit).toBe(false);
    expect(result.sleepMs).toBe(0);
  });

  it('returns isRateLimit false for non-object err (string / null)', () => {
    expect(classifyRateLimitError('boom').isRateLimit).toBe(false);
    expect(classifyRateLimitError(null).isRateLimit).toBe(false);
  });
});

describe('classifyRateLimitError — header parsing', () => {
  it('403 + remaining:0 + reset header → sleeps until reset + buffer', () => {
    const resetSec = Math.floor(Date.parse('2026-05-25T16:00:00Z') / 1000);
    const err = { stderr: headerStderr(403, 0, resetSec) };
    // now = 30 min before reset
    const now = () => Date.parse('2026-05-25T15:30:00Z');

    const result = classifyRateLimitError(err, now);

    expect(result.isRateLimit).toBe(true);
    expect(result.sleepMs).toBe(30 * 60 * 1000 + 5_000);
    expect(result.resetAt).toBe(new Date(resetSec * 1000).toISOString());
  });

  it('429 variant with the same header trio matches', () => {
    const resetSec = Math.floor(Date.parse('2026-05-25T16:00:00Z') / 1000);
    const err = { stderr: headerStderr(429, 0, resetSec) };
    const now = () => Date.parse('2026-05-25T15:30:00Z');

    const result = classifyRateLimitError(err, now);

    expect(result.isRateLimit).toBe(true);
    expect(result.sleepMs).toBe(30 * 60 * 1000 + 5_000);
  });

  it('clamps sleepMs to 0 when reset is already in the past', () => {
    const resetSec = Math.floor(Date.parse('2026-05-25T15:00:00Z') / 1000);
    const err = { stderr: headerStderr(403, 0, resetSec) };
    const now = () => Date.parse('2026-05-25T15:30:00Z'); // 30 min after reset

    const result = classifyRateLimitError(err, now);

    expect(result.isRateLimit).toBe(true);
    expect(result.sleepMs).toBe(0);
    expect(result.resetAt).toBe(new Date(resetSec * 1000).toISOString());
  });

  it('clamps sleepMs to the 1-hour maximum for a far-future reset', () => {
    const resetSec = Math.floor(Date.parse('2027-05-25T00:00:00Z') / 1000);
    const err = { stderr: headerStderr(403, 0, resetSec) };
    const now = () => Date.parse('2026-05-25T00:00:00Z');

    const result = classifyRateLimitError(err, now);

    expect(result.isRateLimit).toBe(true);
    expect(result.sleepMs).toBe(60 * 60 * 1000);
  });

  it('falls back to the 5-min default when reset header is non-numeric', () => {
    const err = {
      stderr: [
        'HTTP 403',
        'X-RateLimit-Remaining: 0',
        'X-RateLimit-Reset: notanumber',
        'gh: API rate limit exceeded',
      ].join('\n'),
    };
    const result = classifyRateLimitError(err);

    expect(result.isRateLimit).toBe(true);
    expect(result.sleepMs).toBe(5 * 60 * 1000);
    expect('resetAt' in result).toBe(false);
  });
});
