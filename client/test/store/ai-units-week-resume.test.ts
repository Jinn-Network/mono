/**
 * weekWindowResumeAt — the true "claims resume at" instant for the rolling
 * 7-day AI-units window (issue #830, item 1). Unlike `weekResetsAtUtc`
 * (always `now + 7d`, a fixed instant that doesn't reflect the rolling
 * window shedding its oldest rows continuously), this walks the in-window
 * rows oldest-to-newest and returns the instant the running total plus the
 * next projected debit first falls to or below the cap.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'ai-units-week-resume-')), 'jinn.db'));
}

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1_000;

describe('weekWindowResumeAt', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('returns null when the window sum is under cap', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');
    const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    store.recordActivityEvent({
      ts: recent.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 100_000,
    });
    expect(store.weekWindowResumeAt('anthropic:api-key', 500_000, now)).toBeNull();
  });

  it('resume = oldest.ts + 7d when a single oldest row over cap', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');
    const oldest = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    store.recordActivityEvent({
      ts: oldest.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 1_000_000, // over the 500_000 cap alone
    });
    const resumeAt = store.weekWindowResumeAt('anthropic:api-key', 500_000, now);
    expect(resumeAt).toBe(new Date(oldest.getTime() + SEVEN_DAY_MS).toISOString());
  });

  it('resume requires dropping the two oldest rows', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');
    const oldest = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    const middle = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
    const newest = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    // total = 600_000, cap = 500_000.
    // Drop oldest (200_000) -> remaining 400_000 < cap -> resume at oldest+7d.
    store.recordActivityEvent({
      ts: oldest.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 200_000,
    });
    store.recordActivityEvent({
      ts: middle.toISOString(),
      kind: 'claimed',
      requestId: 'req-2',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 250_000,
    });
    store.recordActivityEvent({
      ts: newest.toISOString(),
      kind: 'claimed',
      requestId: 'req-3',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 150_000,
    });
    // total = 600_000 >= cap(500_000). Drop oldest (200_000) -> remaining
    // 400_000 < 500_000 cap already. So resume = oldest + 7d.
    const resumeAt = store.weekWindowResumeAt('anthropic:api-key', 500_000, now);
    expect(resumeAt).toBe(new Date(oldest.getTime() + SEVEN_DAY_MS).toISOString());

    // Now raise the cap so dropping just the oldest isn't enough: total 600_000,
    // cap 450_000. Drop oldest -> remaining 400_000 < 450_000 -> still oldest+7d
    // (dropping one row is enough here too). Use a cap that forces two drops:
    // cap = 380_000. Drop oldest -> remaining 400_000 >= 380_000 (not enough).
    // Drop middle too -> remaining 150_000 < 380_000 -> resume = middle + 7d.
    const resumeAt2 = store.weekWindowResumeAt('anthropic:api-key', 380_000, now);
    expect(resumeAt2).toBe(new Date(middle.getTime() + SEVEN_DAY_MS).toISOString());
  });

  it('includes the projected debit and waits until remaining + projected is within cap', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');
    const oldest = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1_000);
    const middle = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1_000);
    const newest = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1_000);
    for (const [requestId, ts, actualCostUsdMicros] of [
      ['projected-oldest', oldest, 200_000],
      ['projected-middle', middle, 50_000],
      ['projected-newest', newest, 350_000],
    ] as const) {
      store.recordActivityEvent({
        ts: ts.toISOString(),
        kind: 'claimed',
        requestId,
        credentialId: 'anthropic:api-key',
        claimStatus: 'delivered',
        actualCostUsdMicros,
      });
    }

    const resumeAt = store.weekWindowResumeAt(
      'anthropic:api-key',
      500_000,
      now,
      150_000,
    );
    // total 600k + projected 150k. Expiring 200k leaves 550k, still blocked;
    // expiring the next 50k leaves exactly 500k, which the strict-`>` gate
    // allows.
    expect(resumeAt).toBe(new Date(middle.getTime() + SEVEN_DAY_MS).toISOString());
  });

  it('returns null when the projection alone exceeds the weekly cap', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');

    expect(
      store.weekWindowResumeAt('anthropic:api-key', 500_000, now, 600_000),
    ).toBeNull();
  });
});
