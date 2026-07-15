import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createContributionAdapter,
  createContributionStatusStore,
  type ContributionStatusStore,
} from '../../src/adapters/contribution-adapter.js';

function tmpStatusFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'contrib-fwd-')), 'status.json');
}

function makeStoreAndAdapter() {
  const store = createContributionStatusStore(tmpStatusFile());
  return { store, adapter: createContributionAdapter({ statusStore: store }) };
}

// AC1 — adapter-state foundation coverage for queued/minted/published values
// already present in the store, plus the adapter-authored vetoed state.
describe('ContributionAdapter — adapter-state foundation (AC1)', () => {
  it('ledger() surfaces queued / minted / published entries from the store', async () => {
    const { store, adapter } = makeStoreAndAdapter();
    store.put({ recordId: 'r-queued', episodeId: 'e-queued', status: 'queued' });
    store.put({ recordId: 'r-minted', episodeId: 'e-minted', status: 'queued' });
    store.put({ recordId: 'r-published', episodeId: 'e-published', status: 'queued' });
    store.setStatus('r-minted', 'minted');
    store.setStatus('r-published', 'published');

    const result = await adapter.ledger();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const byId = new Map(result.value.map((r) => [r.recordId, r.status]));
    expect(byId.get('r-queued')).toBe('queued');
    expect(byId.get('r-minted')).toBe('minted');
    expect(byId.get('r-published')).toBe('published');
  });

  it('mintStatus() reports each forward state', async () => {
    const { store, adapter } = makeStoreAndAdapter();
    for (const status of ['queued', 'minted', 'published'] as const) {
      store.put({ recordId: `r-${status}`, episodeId: `e-${status}`, status: 'queued' });
      store.setStatus(`r-${status}`, status);
      const result = await adapter.mintStatus(`r-${status}`);
      expect(result).toEqual({ status: 'ok', value: { status } });
    }
  });
});

// AC4 — foundation coverage for a freshly recorded mineable record reading
// back as queued. Distinct from the unknown-id case, which is `unavailable`.
describe('ContributionAdapter — queued-state foundation (AC4)', () => {
  it('recordMineable then mintStatus is ok/queued, ledger lists it, no throw', async () => {
    const { adapter } = makeStoreAndAdapter();
    const rec = await adapter.recordMineable('e1');
    expect(rec.status).toBe('ok');
    if (rec.status !== 'ok') return;

    const status = await adapter.mintStatus(rec.value.recordId);
    expect(status).toEqual({ status: 'ok', value: { status: 'queued' } });

    const ledger = await adapter.ledger();
    expect(ledger.status).toBe('ok');
    if (ledger.status !== 'ok') return;
    expect(ledger.value.find((r) => r.recordId === rec.value.recordId)?.status).toBe('queued');
  });
});

// AC3 — adapter-state foundation for recordMineable → veto projection.
describe('ContributionAdapter — veto-state foundation (AC3)', () => {
  it('recordMineable then veto reads vetoed in mintStatus and ledger', async () => {
    const { adapter } = makeStoreAndAdapter();
    const rec = await adapter.recordMineable('e-veto');
    if (rec.status !== 'ok') throw new Error('recordMineable failed');

    const vetoed = await adapter.veto(rec.value.recordId);
    expect(vetoed).toEqual({ status: 'ok', value: { recordId: rec.value.recordId, status: 'vetoed' } });

    const status = await adapter.mintStatus(rec.value.recordId);
    expect(status).toEqual({ status: 'ok', value: { status: 'vetoed' } });

    const ledger = await adapter.ledger();
    expect(ledger.status).toBe('ok');
    if (ledger.status !== 'ok') return;
    expect(ledger.value.find((r) => r.recordId === rec.value.recordId)?.status).toBe('vetoed');
  });
});

// A minor compile-time guard the test file exercises: the store type is exported.
const _typeGuard: ContributionStatusStore | undefined = undefined;
void _typeGuard;
