/**
 * Issue #815 — activity_events gains four columns to track AI-units
 * claim-time bookkeeping. The existing `cost_usd_micros` column stays in
 * place for backward compatibility, but the issue's acceptance contract
 * is the explicit `estimated_cost_usd_micros` / `actual_cost_usd_micros`
 * pair plus `ai_units` + `claim_status`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'ai-units-store-')), 'jinn.db'));
}

describe('activity_events AI-units columns', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('round-trips aiUnits, claimStatus, estimatedCostUsdMicros, actualCostUsdMicros', () => {
    store = freshStore();
    store.recordActivityEvent({
      ts: new Date().toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      model: 'claude-opus-4-7',
      aiUnits: 45,
      claimStatus: 'claimed',
      estimatedCostUsdMicros: 2_250_000,
    });
    const rows = store.getRecentActivityEvents(10);
    const row = rows.find((r) => r.requestId === 'req-1');
    expect(row?.aiUnits).toBe(45);
    expect(row?.claimStatus).toBe('claimed');
    expect(row?.estimatedCostUsdMicros).toBe(2_250_000);
    expect(row?.actualCostUsdMicros).toBeNull();
  });

  it('leaves new columns null when not set (non-cost-bearing rows)', () => {
    store = freshStore();
    store.recordActivityEvent({ ts: new Date().toISOString(), kind: 'tick', requestId: 'req-2' });
    const row = store.getRecentActivityEvents(10).find((r) => r.requestId === 'req-2');
    expect(row?.aiUnits).toBeNull();
    expect(row?.claimStatus).toBeNull();
    expect(row?.estimatedCostUsdMicros).toBeNull();
    expect(row?.actualCostUsdMicros).toBeNull();
  });
});
