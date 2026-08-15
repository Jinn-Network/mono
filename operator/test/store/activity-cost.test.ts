import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'spend-store-')), 'jinn.db'));
}

describe('activity_events cost columns', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('round-trips credentialId, costUsdMicros and model', () => {
    store = freshStore();
    store.recordActivityEvent({
      ts: new Date().toISOString(),
      kind: 'task_cost',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      costUsdMicros: 420_000,
      model: 'claude-opus-4-7',
    });
    const rows = store.getRecentActivityEvents(10);
    const row = rows.find(r => r.requestId === 'req-1');
    expect(row?.credentialId).toBe('anthropic:api-key');
    expect(row?.costUsdMicros).toBe(420_000);
    expect(row?.model).toBe('claude-opus-4-7');
  });

  it('leaves cost columns null for non-cost events', () => {
    store = freshStore();
    store.recordActivityEvent({ ts: new Date().toISOString(), kind: 'claimed', requestId: 'req-2' });
    const row = store.getRecentActivityEvents(10).find(r => r.requestId === 'req-2');
    expect(row?.credentialId).toBeNull();
    expect(row?.costUsdMicros).toBeNull();
    expect(row?.model).toBeNull();
  });
});
