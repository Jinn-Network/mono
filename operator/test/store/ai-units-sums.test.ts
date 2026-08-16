/**
 * Store-side AI-units aggregation queries for the issue #815 gate.
 *
 * Both the 6h-block sum and the 7d-window sum must read straight from
 * `activity_events` — no in-memory state. A restart must give the right
 * total on the first call.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'ai-units-sums-')), 'jinn.db'));
}

describe('aiUnitsThisBlock', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('sums AI units within the current 6h UTC block for one credential', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z'); // in the 12:00-18:00 block
    const inBlock = new Date('2026-05-28T13:00:00.000Z');
    const sameBlockEarlier = new Date('2026-05-28T12:05:00.000Z');
    store.recordActivityEvent({
      ts: inBlock.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 30,
      claimStatus: 'claimed',
    });
    store.recordActivityEvent({
      ts: sameBlockEarlier.toISOString(),
      kind: 'claimed',
      requestId: 'req-2',
      credentialId: 'anthropic:api-key',
      aiUnits: 20,
      claimStatus: 'claimed',
    });
    expect(store.aiUnitsThisBlock('anthropic:api-key', now)).toBe(50);
  });

  it('excludes rows from the previous 6h block', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z');
    const lastBlock = new Date('2026-05-28T11:00:00.000Z'); // 06:00-12:00 block
    store.recordActivityEvent({
      ts: lastBlock.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 100,
      claimStatus: 'claimed',
    });
    expect(store.aiUnitsThisBlock('anthropic:api-key', now)).toBe(0);
  });

  it('excludes other credentials', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z');
    const inBlock = new Date('2026-05-28T13:00:00.000Z');
    store.recordActivityEvent({
      ts: inBlock.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'openai:api-key',
      aiUnits: 50,
      claimStatus: 'claimed',
    });
    expect(store.aiUnitsThisBlock('anthropic:api-key', now)).toBe(0);
  });

  it('ignores rows whose claim was not successful (claim_status=claim_failed)', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z');
    const inBlock = new Date('2026-05-28T13:00:00.000Z');
    store.recordActivityEvent({
      ts: inBlock.toISOString(),
      kind: 'claim_failed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 0, // claim_failed rows carry ai_units=0 per spec
      claimStatus: 'claim_failed',
    });
    expect(store.aiUnitsThisBlock('anthropic:api-key', now)).toBe(0);
  });
});

describe('aiUnitsThisWeek', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('sums AI units across the trailing 7-day window for one credential', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    store.recordActivityEvent({
      ts: fiveDaysAgo.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 200,
      claimStatus: 'claimed',
    });
    store.recordActivityEvent({
      ts: eightDaysAgo.toISOString(),
      kind: 'claimed',
      requestId: 'req-2',
      credentialId: 'anthropic:api-key',
      aiUnits: 500,
      claimStatus: 'claimed',
    });
    expect(store.aiUnitsThisWeek('anthropic:api-key', now)).toBe(200);
  });

  it('returns 0 for an unknown credential', () => {
    store = freshStore();
    expect(store.aiUnitsThisWeek('nobody:none', new Date())).toBe(0);
  });
});

describe('finalizeClaimDelivered', () => {
  let store: Store;
  afterEach(() => store?.close());

  it("sets the per-request claimed row's claim_status to 'delivered' and writes actual_cost_usd_micros", () => {
    store = freshStore();
    store.recordActivityEvent({
      ts: new Date().toISOString(),
      kind: 'claimed',
      requestId: 'req-A',
      credentialId: 'anthropic:api-key',
      aiUnits: 45,
      claimStatus: 'claimed',
      estimatedCostUsdMicros: 2_250_000,
    });
    store.finalizeClaimDelivered('req-A', 3_100_000, false);
    const row = store.getRecentActivityEvents(10).find((r) => r.requestId === 'req-A');
    expect(row?.claimStatus).toBe('delivered');
    expect(row?.actualCostUsdMicros).toBe(3_100_000);
    // ai_units must NOT change at completion — it is the gate input.
    expect(row?.aiUnits).toBe(45);
    // estimated stays put too.
    expect(row?.estimatedCostUsdMicros).toBe(2_250_000);
  });

  it('is a no-op when no claimed row exists for the request id', () => {
    store = freshStore();
    expect(() => store.finalizeClaimDelivered('no-such', 100, false)).not.toThrow();
  });
});

describe('hasAiUnitsCapReachedFor (issue #815 finding 1 — cross-restart memo)', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('returns true after the daemon has written an ai_units_cap_reached row for (credential, window, blockId)', () => {
    store = freshStore();
    const blockId = '2026-05-28T12:00:00.000Z';
    // Daemon-shape: marker prepended to the human reason.
    store.recordActivityEvent({
      ts: '2026-05-28T13:30:00.000Z',
      kind: 'ai_units_cap_reached',
      credentialId: 'anthropic:api-key',
      outcome: 'paused',
      detail: `[block=${blockId}][window=block] AI-units block cap reached for anthropic:api-key (110.0 / 100 units; +50.0 projected for this claim)`,
    });
    expect(store.hasAiUnitsCapReachedFor('anthropic:api-key', 'block', blockId)).toBe(true);
  });

  it('returns false when no row exists for the queried (credential, window, blockId)', () => {
    store = freshStore();
    expect(
      store.hasAiUnitsCapReachedFor('anthropic:api-key', 'block', '2026-05-28T12:00:00.000Z'),
    ).toBe(false);
  });

  it('does not collide across credentials', () => {
    store = freshStore();
    const blockId = '2026-05-28T12:00:00.000Z';
    store.recordActivityEvent({
      ts: '2026-05-28T13:30:00.000Z',
      kind: 'ai_units_cap_reached',
      credentialId: 'anthropic:api-key',
      outcome: 'paused',
      detail: `[block=${blockId}][window=block] reason text`,
    });
    expect(store.hasAiUnitsCapReachedFor('openai:api-key', 'block', blockId)).toBe(false);
  });

  it('does not collide across windows', () => {
    store = freshStore();
    const blockId = '2026-05-28T12:00:00.000Z';
    store.recordActivityEvent({
      ts: '2026-05-28T13:30:00.000Z',
      kind: 'ai_units_cap_reached',
      credentialId: 'anthropic:api-key',
      outcome: 'paused',
      detail: `[block=${blockId}][window=week] reason text`,
    });
    expect(store.hasAiUnitsCapReachedFor('anthropic:api-key', 'block', blockId)).toBe(false);
    expect(store.hasAiUnitsCapReachedFor('anthropic:api-key', 'week', blockId)).toBe(true);
  });

  it('does not collide across blockIds', () => {
    store = freshStore();
    store.recordActivityEvent({
      ts: '2026-05-28T13:30:00.000Z',
      kind: 'ai_units_cap_reached',
      credentialId: 'anthropic:api-key',
      outcome: 'paused',
      detail: `[block=2026-05-28T12:00:00.000Z][window=block] reason text`,
    });
    expect(
      store.hasAiUnitsCapReachedFor('anthropic:api-key', 'block', '2026-05-28T18:00:00.000Z'),
    ).toBe(false);
  });
});

describe('usdMicrosThisBlock / usdMicrosThisWeek (issue #1004 — actual-spend accumulator)', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('sums actual_cost_usd_micros for delivered rows in the current 6h block', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z'); // 12:00-18:00 block
    const inBlock = new Date('2026-05-28T13:00:00.000Z');
    // A delivered row carries the real harvested cost.
    store.recordActivityEvent({
      ts: inBlock.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 30, // projection — must NOT be what the USD sum reads
      claimStatus: 'delivered',
      estimatedCostUsdMicros: 150_000,
      actualCostUsdMicros: 480_000, // real cost, much higher than the estimate
    });
    const r = store.usdMicrosThisBlock('anthropic:api-key', now);
    expect(r.usdMicros).toBe(480_000);
    expect(r.estimated).toBe(false);
  });

  it('marks the block estimated when a delivered row carries a heuristic actual cost (Hermes, AC4)', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z'); // 12:00-18:00 block
    const inBlock = new Date('2026-05-28T13:00:00.000Z');
    // A delivered Hermes row: finalizeClaimDelivered writes a NON-null actual
    // cost, but that figure is a pure heuristic (estimate-backed). The block
    // must report estimated:true even though actual_cost_usd_micros is set.
    store.recordActivityEvent({
      ts: inBlock.toISOString(),
      kind: 'claimed',
      requestId: 'req-hermes',
      credentialId: 'anthropic:api-key',
      claimStatus: 'claimed',
      estimatedCostUsdMicros: 1_000_000,
    });
    store.finalizeClaimDelivered('req-hermes', 1_000_000, true); // estimate-backed
    const r = store.usdMicrosThisBlock('anthropic:api-key', now);
    expect(r.usdMicros).toBe(1_000_000);
    expect(r.estimated).toBe(true);
  });

  it('keeps the block metered when the only delivered row is observed telemetry (Codex/Claude-Code)', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z');
    const inBlock = new Date('2026-05-28T13:00:00.000Z');
    store.recordActivityEvent({
      ts: inBlock.toISOString(),
      kind: 'claimed',
      requestId: 'req-codex',
      credentialId: 'anthropic:api-key',
      claimStatus: 'claimed',
      estimatedCostUsdMicros: 150_000,
    });
    store.finalizeClaimDelivered('req-codex', 480_000, false); // harvested telemetry
    const r = store.usdMicrosThisBlock('anthropic:api-key', now);
    expect(r.usdMicros).toBe(480_000);
    expect(r.estimated).toBe(false);
  });

  it('falls back to estimated_cost_usd_micros for an in-flight claimed row (no actual yet)', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z');
    store.recordActivityEvent({
      ts: new Date('2026-05-28T13:00:00.000Z').toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 30,
      claimStatus: 'claimed',
      estimatedCostUsdMicros: 150_000,
      // actualCostUsdMicros omitted — claim still in flight
    });
    const r = store.usdMicrosThisBlock('anthropic:api-key', now);
    expect(r.usdMicros).toBe(150_000);
    expect(r.estimated).toBe(true); // estimate-backed contribution present
  });

  it('excludes claim_failed rows and previous-block rows', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z');
    store.recordActivityEvent({
      ts: new Date('2026-05-28T13:00:00.000Z').toISOString(),
      kind: 'claim_failed',
      requestId: 'req-fail',
      credentialId: 'anthropic:api-key',
      claimStatus: 'claim_failed',
      estimatedCostUsdMicros: 999_000,
    });
    store.recordActivityEvent({
      ts: new Date('2026-05-28T11:00:00.000Z').toISOString(), // prev block
      kind: 'claimed',
      requestId: 'req-old',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 500_000,
    });
    const r = store.usdMicrosThisBlock('anthropic:api-key', now);
    expect(r.usdMicros).toBe(0);
    expect(r.estimated).toBe(false);
  });

  it('sums actual cost across the trailing 7-day window', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    store.recordActivityEvent({
      ts: fiveDaysAgo.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 200_000,
    });
    store.recordActivityEvent({
      ts: eightDaysAgo.toISOString(),
      kind: 'claimed',
      requestId: 'req-2',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 500_000,
    });
    const r = store.usdMicrosThisWeek('anthropic:api-key', now);
    expect(r.usdMicros).toBe(200_000);
    expect(r.estimated).toBe(false);
  });

  it('returns zero / not-estimated for an unknown credential', () => {
    store = freshStore();
    expect(store.usdMicrosThisWeek('nobody:none', new Date())).toEqual({
      usdMicros: 0,
      estimated: false,
    });
  });
});
