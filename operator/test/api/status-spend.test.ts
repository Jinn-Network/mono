import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { gatherStatusForApi } from '../../src/api/gather-status.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'status-spend-')), 'jinn.db'));
}

describe('/v1/status spend block', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('reports per-credential spend and paused state', async () => {
    store = freshStore();
    const now = new Date();
    store.recordActivityEvent({ ts: now.toISOString(), kind: 'task_cost', credentialId: 'anthropic:api-key', costUsdMicros: 21_000_000 });
    const body = await gatherStatusForApi(store, { spendCaps: { 'anthropic:api-key': 20 } });
    const row = body.spend?.credentials.find(c => c.credentialId === 'anthropic:api-key');
    expect(row?.capUsd).toBe(20);
    expect(row?.spentTodayUsd).toBeCloseTo(21);
    expect(row?.paused).toBe(true);
  });

  it('omits the spend block when no caps are configured', async () => {
    store = freshStore();
    const body = await gatherStatusForApi(store, {});
    expect(body.spend).toBeUndefined();
  });

  it('reports zero spend and not-paused for a capped credential with no activity', async () => {
    store = freshStore();
    const body = await gatherStatusForApi(store, { spendCaps: { 'anthropic:api-key': 20 } });
    const row = body.spend?.credentials.find(c => c.credentialId === 'anthropic:api-key');
    expect(row?.spentTodayUsd).toBe(0);
    expect(row?.paused).toBe(false);
  });
});
