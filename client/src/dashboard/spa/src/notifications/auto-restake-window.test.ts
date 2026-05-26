import { describe, expect, it } from 'vitest';
import { isWithinAutoRestakeWindow } from './auto-restake-window.js';

describe('isWithinAutoRestakeWindow (#651)', () => {
  const evictedAt = '2026-05-26T10:00:00.000Z';
  const evictedAtMs = new Date(evictedAt).getTime();

  it('returns true when loop enabled AND within 2x check interval', () => {
    const out = isWithinAutoRestakeWindow(
      { evictedSince: evictedAt },
      { enabled: true, checkIntervalMs: 60_000 },
      evictedAtMs + 60_000, // 1 min after — well inside the 2 × 60s window
    );
    expect(out).toBe(true);
  });

  it('returns false when loop enabled AND beyond 2x check interval', () => {
    const out = isWithinAutoRestakeWindow(
      { evictedSince: evictedAt },
      { enabled: true, checkIntervalMs: 60_000 },
      evictedAtMs + 121_000, // 2 × 60s + 1s — past the window
    );
    expect(out).toBe(false);
  });

  it('returns false when loop disabled', () => {
    const out = isWithinAutoRestakeWindow(
      { evictedSince: evictedAt },
      { enabled: false, checkIntervalMs: 0 },
      evictedAtMs + 1_000, // would be suppressed if loop were on
    );
    expect(out).toBe(false);
  });

  it('returns false when autoRestake is undefined (older daemon)', () => {
    const out = isWithinAutoRestakeWindow(
      { evictedSince: evictedAt },
      undefined,
      evictedAtMs + 1_000,
    );
    expect(out).toBe(false);
  });

  it('returns false when evictedSince is missing', () => {
    const out = isWithinAutoRestakeWindow(
      {},
      { enabled: true, checkIntervalMs: 60_000 },
      evictedAtMs + 1_000,
    );
    expect(out).toBe(false);
  });

  it('returns false when evictedSince is malformed', () => {
    const out = isWithinAutoRestakeWindow(
      { evictedSince: 'not-an-iso-string' },
      { enabled: true, checkIntervalMs: 60_000 },
      evictedAtMs + 1_000,
    );
    // Bad data must fall through to "outside window" — never silently suppress.
    expect(out).toBe(false);
  });
});
