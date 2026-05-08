import { describe, expect, it } from 'vitest';
import { CaptureRateLimiter } from '../../src/captures/rate-limit.js';

describe('CaptureRateLimiter', () => {
  it('allows the default operator burst and then delays further publishes', () => {
    const limiter = new CaptureRateLimiter({ now: () => 0 });
    for (let i = 0; i < 30; i += 1) {
      expect(limiter.tryAcquire({ operator: '0xoperator', now: 0 }).allowed).toBe(true);
    }

    const denied = limiter.tryAcquire({ operator: '0xoperator', now: 0 });
    expect(denied).toMatchObject({ allowed: false, reason: 'operator_rate_limit' });
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    expect(limiter.tryAcquire({ operator: '0xoperator', now: 360_000 }).allowed).toBe(true);
  });

  it('enforces the per-repo hourly budget independently of the operator burst', () => {
    const limiter = new CaptureRateLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.tryAcquire({ operator: '0xoperator', repo: 'git@example.com/repo', now: 0 }).allowed).toBe(true);
    }

    expect(limiter.tryAcquire({
      operator: '0xoperator',
      repo: 'git@example.com/repo',
      now: 0,
    })).toMatchObject({ allowed: false, reason: 'repo_rate_limit' });
    expect(limiter.tryAcquire({
      operator: '0xoperator',
      repo: 'git@example.com/other',
      now: 0,
    }).allowed).toBe(true);
  });
});
