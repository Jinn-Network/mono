/**
 * /v1/status `aiUnits` block — issue #815.
 *
 * One row per credential configured in `aiUnits.manifestCredentials`,
 * each carrying the current 6h-block sum, 7d-window sum, the active
 * caps, paused flag, and the next reset instants for both windows.
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
