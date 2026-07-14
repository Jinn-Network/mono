import { describe, expect, it } from 'vitest';
import { runMergeBatchCli } from '../../src/merge-batch/cli.js';

describe('runMergeBatchCli', () => {
  it('prints a manifest from fixture JSON', async () => {
    const writes: string[] = [];
    const code = await runMergeBatchCli({
      argv: ['plan', '--fixture-json', JSON.stringify({
        baseNextSha: 'base',
        createdAt: '2026-06-17T10:00:00.000Z',
        maxWaveSize: 2,
        prs: [
          {
            number: 1,
            title: 'pr 1',
            headRefName: 'b1',
            headRefOid: 's1',
            author: 'author',
            linkedIssueNumber: 1001,
            blockedOn: 'Nothing',
            files: ['a.ts'],
            additions: 1,
            deletions: 1,
            dependsOnPrNumbers: [],
            review: { kind: 'satisfied', approvers: ['oaksprout'] },
            ci: { kind: 'green' },
            risk: 'small',
          },
        ],
      })],
      write: (text) => writes.push(text),
      writeError: (text) => writes.push(`ERR:${text}`),
    });

    expect(code).toBe(0);
    expect(JSON.parse(writes.join('')).waves[0].prs[0].number).toBe(1);
  });
});
