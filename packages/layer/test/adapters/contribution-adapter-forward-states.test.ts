import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContributionCandidateV1 } from '@jinn-network/plugin';
import { describe, expect, it } from 'vitest';
import {
  createContributionAdapter,
  createContributionStatusStore,
} from '../../src/adapters/contribution-adapter.js';

function tmpStatusFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'contrib-fwd-')), 'mineable-traces.json');
}

function candidate(sourceId: string, share = false): ContributionCandidateV1 {
  return {
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId,
    repositorySlug: 'Jinn-Network/mono',
    baseCommit: '0123456789abcdef',
    acceptedDiff: `diff --git a/${sourceId} b/${sourceId}\n+fixed\n`,
    testRuns: [],
    intermediateFailureDiffs: [],
    skillEvents: [],
    publishMinedTasksConsent: share,
    createdAt: '2026-07-15T12:00:00.000Z',
  };
}

describe('ContributionAdapter shared forward states', () => {
  it('surfaces queued, local-minted, and published records from the shared store', async () => {
    const store = createContributionStatusStore(tmpStatusFile());
    const adapter = createContributionAdapter({ statusStore: store });
    await store.record(candidate('queued', true));
    await store.authorize('queued', '2026-07-15T12:01:00.000Z');
    await store.record(candidate('minted'));
    await store.markMinted('minted', 'mint:local');
    await store.record(candidate('published', true));
    await store.markMinted('published', 'mint:published');
    await store.markPublished('published', 'ipfs://published');

    const result = await adapter.ledger();

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const byId = new Map(result.value.map((record) => [record.recordId, record]));
    expect(byId.get('queued')).toMatchObject({
      localState: 'recorded',
      publicationState: 'queued',
      status: 'queued',
    });
    expect(byId.get('minted')).toMatchObject({
      localState: 'minted',
      publicationState: 'disabled',
      mintRef: 'mint:local',
      status: 'minted',
    });
    expect(byId.get('published')).toMatchObject({
      localState: 'minted',
      publicationState: 'published',
      mintRef: 'mint:published',
      publicationRef: 'ipfs://published',
      status: 'published',
    });
  });

  it('returns unavailable instead of mutating a published record on veto', async () => {
    const store = createContributionStatusStore(tmpStatusFile());
    const adapter = createContributionAdapter({ statusStore: store });
    await store.record(candidate('published', true));
    await store.authorize('published', '2026-07-15T12:01:00.000Z');
    await store.markMinted('published', 'mint:published');
    await store.markPublished('published', 'ipfs://published');

    const result = await adapter.veto('published');

    expect(result.status).toBe('unavailable');
    expect((await store.get('published'))?.publicationState).toBe('published');
  });
});
