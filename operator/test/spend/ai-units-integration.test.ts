/**
 * Integration coverage for the spend ceiling (issues #815, #1004):
 *
 * 1. **48h claim-trace within cap** — simulate 48h of delivered claim rows
 *    landing against one credential, with the gate respected (no row pushes
 *    the per-block USD spend over the cap). Assert both the per-block USD sum
 *    and the per-week USD sum stay within cap across the entire trace.
 *
 * 2. **Actual cost crosses the ceiling** — the #1004 regression: one
 *    delivered run whose *actual* harvested cost exceeds the block cap pauses
 *    the next claim, even though a flat projection would have read well under.
 *
 * 3. **Per-credential isolation** — when credential A's 6h block is
 *    exhausted, the gate must still proceed for credential B.
 *
 * These exercise the pure decision function (`gateClaimByAiUnits`) against
 * real store aggregations (`usdMicrosThisBlock` / `usdMicrosThisWeek`) — the
 * same code paths the daemon runs. The integration is across modules.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import {
  gateClaimByAiUnits,
  _resetAiUnitsGateMemoForTests,
} from '../../src/daemon/ai-units-gate.js';
import { blockIdUtc, REFERENCE_CEILING_USD_MICROS } from '../../src/spend/ai-units.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'ai-units-int-')), 'jinn.db'));
}

beforeEach(() => _resetAiUnitsGateMemoForTests());

describe('spend ceiling integration', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('48h trace: actual delivered USD spend stays within both USD caps for one credential', () => {
    store = freshStore();
    const credentialId = 'anthropic:api-key';
    const start = new Date('2026-05-25T00:00:00.000Z');
    const projectedUsdMicros = 50_000; // $0.05 projected per claim
    const actualUsdMicros = 50_000;    // delivered actual matches projection here
    const logger = { warn: vi.fn(), info: vi.fn() };
    const stepMs = 30 * 60 * 1_000;
    const totalSteps = (48 * 60) / 30;
    let claimsLanded = 0;
    let skips = 0;
    for (let i = 0; i < totalSteps; i++) {
      const now = new Date(start.getTime() + i * stepMs);
      const block = store.usdMicrosThisBlock(credentialId, now);
      const week = store.usdMicrosThisWeek(credentialId, now);
      const decision = gateClaimByAiUnits({
        credentialId,
        projectedUsdMicros,
        usdMicrosThisBlock: block.usdMicros,
        usdMicrosThisWeek: week.usdMicros,
        capPerBlockUsdMicros: REFERENCE_CEILING_USD_MICROS.usd_micros_per_block,
        capPerWeekUsdMicros: REFERENCE_CEILING_USD_MICROS.usd_micros_per_week,
        blockId: blockIdUtc(now),
        logger,
      });
      if (decision.proceed) {
        store.recordActivityEvent({
          ts: now.toISOString(),
          kind: 'claimed',
          requestId: `req-${i}`,
          credentialId,
          claimStatus: 'delivered',
          actualCostUsdMicros: actualUsdMicros,
        });
        claimsLanded++;
      } else {
        skips++;
      }
    }
    expect(claimsLanded).toBeGreaterThan(0);
    expect(skips).toBeGreaterThan(0);
    for (let b = 0; b < 8; b++) {
      const midBlock = new Date(start.getTime() + b * 6 * 60 * 60 * 1_000 + 3 * 60 * 60 * 1_000);
      expect(store.usdMicrosThisBlock(credentialId, midBlock).usdMicros).toBeLessThanOrEqual(
        REFERENCE_CEILING_USD_MICROS.usd_micros_per_block,
      );
    }
    const endOfTrace = new Date(start.getTime() + 48 * 60 * 60 * 1_000);
    expect(store.usdMicrosThisWeek(credentialId, endOfTrace).usdMicros).toBeLessThanOrEqual(
      REFERENCE_CEILING_USD_MICROS.usd_micros_per_week,
    );
  });

  it('a high-actual-cost delivered run pushes the block over the USD ceiling and pauses the next claim', () => {
    store = freshStore();
    const credentialId = 'anthropic:api-key';
    const now = new Date('2026-05-28T13:00:00.000Z');
    const logger = { warn: vi.fn(), info: vi.fn() };
    // One delivered run whose ACTUAL cost ($0.60) exceeds the $0.50 block cap —
    // a flat projection would have read well under. This is the #1004 bug.
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'big',
      credentialId,
      claimStatus: 'delivered',
      estimatedCostUsdMicros: 50_000,
      actualCostUsdMicros: 600_000,
    });
    const block = store.usdMicrosThisBlock(credentialId, now);
    expect(block.usdMicros).toBe(600_000); // actual, not the 50_000 estimate
    const decision = gateClaimByAiUnits({
      credentialId,
      projectedUsdMicros: 50_000,
      usdMicrosThisBlock: block.usdMicros,
      usdMicrosThisWeek: store.usdMicrosThisWeek(credentialId, now).usdMicros,
      capPerBlockUsdMicros: REFERENCE_CEILING_USD_MICROS.usd_micros_per_block,
      capPerWeekUsdMicros: REFERENCE_CEILING_USD_MICROS.usd_micros_per_week,
      blockId: blockIdUtc(now),
      logger,
    });
    expect(decision.proceed).toBe(false);
  });

  it('per-credential isolation: A exhausted, B still proceeds', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');
    const blockId = blockIdUtc(now);
    const logger = { warn: vi.fn(), info: vi.fn() };

    // Exhaust credential A in this block ($0.50 already booked as actual).
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'A-seed',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 500_000,
    });

    const decisionA = gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 50_000,
      usdMicrosThisBlock: store.usdMicrosThisBlock('anthropic:api-key', now).usdMicros,
      usdMicrosThisWeek: store.usdMicrosThisWeek('anthropic:api-key', now).usdMicros,
      capPerBlockUsdMicros: 500_000,
      capPerWeekUsdMicros: 14_000_000,
      blockId,
      logger,
    });
    expect(decisionA.proceed).toBe(false);

    const decisionB = gateClaimByAiUnits({
      credentialId: 'openai:api-key',
      projectedUsdMicros: 50_000,
      usdMicrosThisBlock: store.usdMicrosThisBlock('openai:api-key', now).usdMicros,
      usdMicrosThisWeek: store.usdMicrosThisWeek('openai:api-key', now).usdMicros,
      capPerBlockUsdMicros: 500_000,
      capPerWeekUsdMicros: 14_000_000,
      blockId,
      logger,
    });
    expect(decisionB.proceed).toBe(true);
  });

  it('restart-safety: USD sum on first query after a fresh Store reflects on-disk delivered rows', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ai-units-restart-')), 'jinn.db');
    {
      const s1 = new Store(dbPath);
      const now = new Date('2026-05-28T13:00:00.000Z');
      s1.recordActivityEvent({
        ts: now.toISOString(),
        kind: 'claimed',
        requestId: 'req-1',
        credentialId: 'anthropic:api-key',
        claimStatus: 'delivered',
        actualCostUsdMicros: 420_000,
      });
      s1.close();
    }
    // Fresh instance — no in-memory state to rebuild.
    const s2 = new Store(dbPath);
    const now = new Date('2026-05-28T13:30:00.000Z'); // same 6h block
    expect(s2.usdMicrosThisBlock('anthropic:api-key', now).usdMicros).toBe(420_000);
    s2.close();
  });
});
