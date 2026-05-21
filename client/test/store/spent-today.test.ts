import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'spend-today-')), 'jinn.db'));
}

describe('spentTodayMicros', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('sums cost for one credential since UTC midnight', () => {
    store = freshStore();
    const now = new Date();
    store.recordActivityEvent({ ts: now.toISOString(), kind: 'task_cost', credentialId: 'anthropic:api-key', costUsdMicros: 300_000 });
    store.recordActivityEvent({ ts: now.toISOString(), kind: 'task_cost', credentialId: 'anthropic:api-key', costUsdMicros: 250_000 });
    expect(store.spentTodayMicros('anthropic:api-key', now)).toBe(550_000);
  });

  it('excludes other credentials', () => {
    store = freshStore();
    const now = new Date();
    store.recordActivityEvent({ ts: now.toISOString(), kind: 'task_cost', credentialId: 'openai:api-key', costUsdMicros: 999_000 });
    expect(store.spentTodayMicros('anthropic:api-key', now)).toBe(0);
  });

  it('excludes rows from before UTC midnight', () => {
    store = freshStore();
    const now = new Date('2026-05-21T10:00:00.000Z');
    const yesterday = new Date('2026-05-20T23:00:00.000Z');
    store.recordActivityEvent({ ts: yesterday.toISOString(), kind: 'task_cost', credentialId: 'anthropic:api-key', costUsdMicros: 700_000 });
    store.recordActivityEvent({ ts: now.toISOString(), kind: 'task_cost', credentialId: 'anthropic:api-key', costUsdMicros: 100_000 });
    expect(store.spentTodayMicros('anthropic:api-key', now)).toBe(100_000);
  });

  it('returns 0 when nothing is recorded', () => {
    store = freshStore();
    expect(store.spentTodayMicros('anthropic:api-key', new Date())).toBe(0);
  });
});
