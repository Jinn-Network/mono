import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContributionCandidateV1 } from '@jinn-network/plugin';
import { describe, expect, it } from 'vitest';
import { createContributionStatusStore } from '../../src/adapters/contribution-adapter.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'contrib-')), 'mineable-traces.json');
}

function candidate(sourceId: string): ContributionCandidateV1 {
  return {
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId,
    repositorySlug: 'Jinn-Network/mono',
    baseCommit: '0123456789abcdef',
    acceptedDiff: 'diff --git a/a b/a\n+fixed\n',
    testRuns: [],
    intermediateFailureDiffs: [],
    skillEvents: [],
    publishMinedTasksConsent: false,
    createdAt: '2026-07-15T12:00:00.000Z',
  };
}

describe('createContributionStatusStore compatibility factory', () => {
  it('persists shared records across fresh adapter and daemon readers', async () => {
    const path = tmpFile();
    const adapterStore = createContributionStatusStore(path);
    await adapterStore.record(candidate('source-1'));
    await adapterStore.markMinted('source-1', 'mint:1');

    const daemonStore = createContributionStatusStore(path);

    expect(await daemonStore.get('source-1')).toMatchObject({
      recordId: 'source-1',
      localState: 'minted',
      publicationState: 'disabled',
      mintRef: 'mint:1',
    });
  });

  it('returns undefined for an unknown id', async () => {
    expect(await createContributionStatusStore(tmpFile()).get('missing')).toBeUndefined();
  });
});
