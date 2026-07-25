/**
 * /v1/status `aiUnits` block — issue #815.
 *
 * One row per credential configured in `aiUnits.manifestCredentials`,
 * each carrying the current 6h-block sum, 7d-window sum, active caps,
 * gate-parity projected-debit classification, and the next reset instants.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { gatherStatusForApi } from '../../src/api/gather-status.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'status-ai-units-')), 'jinn.db'));
}

describe('/v1/status aiUnits block', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('reports per-credential spend sums + paused state', async () => {
    store = freshStore();
    const now = new Date();
    // $0.60 actual spend this block — over the $0.50 block cap, so paused.
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 120,
      claimStatus: 'delivered',
      actualCostUsdMicros: 600_000,
    });
    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 2800,
        capPerBlockUsdMicros: 500_000,
        capPerWeekUsdMicros: 14_000_000,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 5 },
        manifestProjectedUsdMicros: { 'cid-1': 25_000 },
        manifestModels: { 'cid-1': 'claude-opus-4-7' },
      },
    });
    const row = body.aiUnits?.credentials.find((c) => c.credentialId === 'anthropic:api-key');
    expect(row).toBeTruthy();
    // $0.60 / $0.50 per 100 units => 120 units derived via the peg.
    expect(row?.unitsThisBlock).toBe(120);
    expect(row?.capPerBlock).toBe(100);
    expect(row?.capPerWeek).toBe(2800);
    expect(row?.paused).toBe(true);
    expect(row?.blockResetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T(00|06|12|18):00:00\.000Z$/);
  });

  it('omits the aiUnits block when no aiUnits config is threaded through', async () => {
    store = freshStore();
    const body = await gatherStatusForApi(store, {});
    expect(body.aiUnits).toBeUndefined();
  });

  it('reports paused=false when both sums are under the caps', async () => {
    store = freshStore();
    const now = new Date();
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'req-2',
      credentialId: 'anthropic:api-key',
      aiUnits: 10,
      claimStatus: 'delivered',
      actualCostUsdMicros: 50_000,
    });
    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 2800,
        capPerBlockUsdMicros: 500_000,
        capPerWeekUsdMicros: 14_000_000,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 5 },
        manifestProjectedUsdMicros: { 'cid-1': 25_000 },
        manifestModels: { 'cid-1': 'claude-opus-4-7' },
      },
    });
    const row = body.aiUnits?.credentials.find((c) => c.credentialId === 'anthropic:api-key');
    expect(row?.paused).toBe(false);
  });

  it('reports the gate window when the next projected claim would exceed both caps', async () => {
    store = freshStore();
    const now = new Date();
    const outsideBlock = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    store.recordActivityEvent({
      ts: outsideBlock.toISOString(),
      kind: 'claimed',
      requestId: 'projected-old',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 450_000,
    });
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'projected-current',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 450_000,
    });

    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 200,
        capPerBlockUsdMicros: 500_000,
        capPerWeekUsdMicros: 1_000_000,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 30 },
        manifestProjectedUsdMicros: { 'cid-1': 150_000 },
        manifestModels: { 'cid-1': 'claude-opus-4-7' },
      },
    });

    const row = body.aiUnits?.credentials[0];
    expect(row?.usdMicrosThisBlock).toBe(450_000);
    expect(row?.usdMicrosThisWeek).toBe(900_000);
    expect(row?.paused).toBe(true);
    expect(row?.pausedWindow).toBe('block');
  });

  it('keeps an unknown projection fail-open even when current sums exceed caps', async () => {
    store = freshStore();
    store.recordActivityEvent({
      ts: new Date().toISOString(),
      kind: 'claimed',
      requestId: 'unknown-projection',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 600_000,
    });

    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 200,
        capPerBlockUsdMicros: 500_000,
        capPerWeekUsdMicros: 500_000,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': null },
        manifestProjectedUsdMicros: { 'cid-1': null },
        manifestModels: { 'cid-1': 'unknown-model' },
      },
    });

    const row = body.aiUnits?.credentials[0];
    expect(row?.paused).toBe(false);
    expect(row?.pausedWindow).toBeNull();
  });

  it('uses the largest known week projection to report a safe rolling resume instant', async () => {
    store = freshStore();
    const now = new Date();
    const oldest = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1_000);
    const middle = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1_000);
    const newest = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1_000);
    for (const [requestId, ts, actualCostUsdMicros] of [
      ['week-oldest', oldest, 200_000],
      ['week-middle', middle, 50_000],
      ['week-newest', newest, 350_000],
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

    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 2_000,
        capPerWeek: 100,
        capPerBlockUsdMicros: 10_000_000,
        capPerWeekUsdMicros: 500_000,
        manifestCredentials: {
          'cid-small': 'anthropic:api-key',
          'cid-large': 'anthropic:api-key',
        },
        manifestProjectedAiUnits: { 'cid-small': 10, 'cid-large': 30 },
        manifestProjectedUsdMicros: { 'cid-small': 50_000, 'cid-large': 150_000 },
        manifestModels: {
          'cid-small': 'claude-haiku-4-5-20251001',
          'cid-large': 'claude-opus-4-7',
        },
      },
    });

    const row = body.aiUnits?.credentials[0];
    expect(row?.pausedWindow).toBe('week');
    expect(row?.weekResetsAt).toBe(
      new Date(middle.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    );
  });

  it('reports no scheduled weekly resume when the projection alone exceeds the cap', async () => {
    store = freshStore();

    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 2_000,
        capPerWeek: 100,
        capPerBlockUsdMicros: 1_000_000,
        capPerWeekUsdMicros: 500_000,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 120 },
        manifestProjectedUsdMicros: { 'cid-1': 600_000 },
        manifestModels: { 'cid-1': 'claude-opus-4-7' },
      },
    });

    const row = body.aiUnits?.credentials[0];
    expect(row?.paused).toBe(true);
    expect(row?.pausedWindow).toBe('week');
    expect(row?.weekResetsAt).toBeNull();
  });

  it('marks a credential with recorded weekly spend as active (#891)', async () => {
    store = freshStore();
    const now = new Date();
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'active-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 10,
      claimStatus: 'delivered',
      actualCostUsdMicros: 50_000,
    });
    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 2800,
        capPerBlockUsdMicros: 500_000,
        capPerWeekUsdMicros: 14_000_000,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 5 },
        manifestProjectedUsdMicros: { 'cid-1': 25_000 },
        manifestModels: { 'cid-1': 'claude-opus-4-7' },
      },
    });
    const row = body.aiUnits?.credentials.find((c) => c.credentialId === 'anthropic:api-key');
    expect(row?.active).toBe(true);
  });

  it('marks a joined-but-idle credential as not active without disturbing other fields (#891)', async () => {
    store = freshStore();
    // No recorded spend for this credential — it is configured but idle.
    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 2800,
        capPerBlockUsdMicros: 500_000,
        capPerWeekUsdMicros: 14_000_000,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 5 },
        manifestProjectedUsdMicros: { 'cid-1': 25_000 },
        manifestModels: { 'cid-1': 'claude-opus-4-7' },
      },
    });
    const row = body.aiUnits?.credentials.find((c) => c.credentialId === 'anthropic:api-key');
    expect(row?.active).toBe(false);
    expect(row?.usdMicrosThisWeek).toBe(0);
    expect(row?.paused).toBe(false);
  });

  it('adds USD spend fields + an estimated flag while keeping the unit fields (issue #1004)', async () => {
    store = freshStore();
    const now = new Date();
    // One delivered row with a real actual cost ($0.30) and one in-flight
    // claimed row carrying only an estimate ($0.05) — so estimated must be true.
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'delivered-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 10,
      claimStatus: 'delivered',
      actualCostUsdMicros: 300_000,
    });
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'inflight-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 5,
      claimStatus: 'claimed',
      estimatedCostUsdMicros: 50_000,
    });
    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 2800,
        capPerBlockUsdMicros: 500_000,
        capPerWeekUsdMicros: 14_000_000,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 5 },
        manifestProjectedUsdMicros: { 'cid-1': 50_000 },
        manifestModels: { 'cid-1': 'claude-opus-4-7' },
      },
    });
    const row = body.aiUnits!.credentials[0];
    // USD fields present and correct.
    expect(row.usdMicrosThisBlock).toBe(350_000);
    expect(row.capPerBlockUsdMicros).toBe(500_000);
    expect(row.estimated).toBe(true); // in-flight row had no actual
    // Legacy unit fields still present, derived from USD via the peg
    // ($0.35 block / $0.50 per 100 units => 70 units).
    expect(row.unitsThisBlock).toBe(70);
    expect(row.capPerBlock).toBe(100);
  });
});
