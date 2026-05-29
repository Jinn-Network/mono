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

  it('reports per-credential AI-units sums + paused state', async () => {
    store = freshStore();
    const now = new Date();
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 120,
      claimStatus: 'claimed',
    });
    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 2800,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 5 },
        manifestModels: { 'cid-1': 'claude-opus-4-7' },
      },
    });
    const row = body.aiUnits?.credentials.find((c) => c.credentialId === 'anthropic:api-key');
    expect(row).toBeTruthy();
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
      claimStatus: 'claimed',
    });
    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 2800,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 5 },
        manifestModels: { 'cid-1': 'claude-opus-4-7' },
      },
    });
    const row = body.aiUnits?.credentials.find((c) => c.credentialId === 'anthropic:api-key');
    expect(row?.paused).toBe(false);
  });
});
