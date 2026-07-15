import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContributionStatusStore } from '../../src/adapters/contribution-adapter.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'contrib-')), 'status.json');
}

describe('ContributionStatusStore', () => {
  it('put then get returns the entry', () => {
    const store = createContributionStatusStore(tmpFile());
    store.put({ recordId: 'r1', episodeId: 'e1', status: 'queued' });
    expect(store.get('r1')).toEqual({ recordId: 'r1', episodeId: 'e1', status: 'queued' });
  });

  it('list includes stored entries', () => {
    const store = createContributionStatusStore(tmpFile());
    store.put({ recordId: 'r1', episodeId: 'e1', status: 'queued' });
    store.put({ recordId: 'r2', episodeId: 'e2', status: 'queued' });
    expect(store.list().map((e) => e.recordId).sort()).toEqual(['r1', 'r2']);
  });

  it('setStatus flips a record status', () => {
    const store = createContributionStatusStore(tmpFile());
    store.put({ recordId: 'r1', episodeId: 'e1', status: 'queued' });
    store.setStatus('r1', 'vetoed');
    expect(store.get('r1')?.status).toBe('vetoed');
  });

  it('get on an unknown id returns undefined', () => {
    const store = createContributionStatusStore(tmpFile());
    expect(store.get('nope')).toBeUndefined();
  });

  it('persists across a fresh store on the same path', () => {
    const path = tmpFile();
    const a = createContributionStatusStore(path);
    a.put({ recordId: 'r1', episodeId: 'e1', status: 'queued' });
    a.setStatus('r1', 'minted');
    const b = createContributionStatusStore(path);
    expect(b.get('r1')).toEqual({ recordId: 'r1', episodeId: 'e1', status: 'minted' });
  });
});
