import { describe, expect, it } from 'vitest';
import type { MergeBatchManifest, MergeBatchPr } from '../../src/merge-batch/types.js';

describe('merge-batch types', () => {
  it('models a resumable wave manifest', () => {
    const pr: MergeBatchPr = {
      number: 101,
      title: 'fix(api): correct pagination',
      headRefName: 'fix/101-pagination',
      headRefOid: 'aaa111',
      author: 'contributor',
      linkedIssueNumber: 501,
      blockedOn: 'Nothing',
      files: ['client/src/api/server.ts'],
      additions: 42,
      deletions: 9,
      dependsOnPrNumbers: [],
      review: { kind: 'satisfied', approvers: ['oaksprout'] },
      ci: { kind: 'green' },
      risk: 'normal',
    };

    const manifest: MergeBatchManifest = {
      schemaVersion: 1,
      repo: 'Jinn-Network/mono',
      baseBranch: 'next',
      baseNextSha: 'base123',
      createdAt: '2026-06-17T10:00:00.000Z',
      waves: [
        {
          id: 'wave-1',
          kind: 'independent',
          prs: [pr],
          reason: 'one independent PR',
          status: 'planned',
        },
      ],
      skipped: [],
    };

    expect(manifest.waves[0]?.prs[0]?.number).toBe(101);
  });
});
