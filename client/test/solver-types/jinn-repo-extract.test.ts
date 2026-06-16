import { describe, it, expect } from 'vitest';
import { extractPoolItem } from '../../src/solver-types/jinn-repo-extract.js';

const fakeExec = async (cmd: string, args: string[]): Promise<string> => {
  const key = [cmd, ...args].join(' ');
  if (key.includes('rev-parse')) return 'b'.repeat(40);                       // base = parent
  if (key.includes('show') && key.includes(':client/test/')) return 'TEST_CONTENT';
  if (key.includes('diff')) return 'diff --git a/client/src/safe.ts ...';     // test-stripped
  throw new Error(`unexpected: ${key}`);
};
const fakeIssue = async (_n: number) => ({ title: 'Nonce stale', body: 'On retry the mech safe nonce is stale.' });

describe('extractPoolItem', () => {
  it('builds a pool item with issue-derived problem statement and gold tests', async () => {
    const item = await extractPoolItem(
      { number: 1042, files: ['client/src/safe.ts', 'client/test/adapters/mech/safe.nonce.test.ts'], closingIssues: [501] },
      { exec: fakeExec, fetchIssue: fakeIssue, mergeCommit: 'c'.repeat(40) },
    );
    expect(item.base_commit).toBe('b'.repeat(40));
    expect(item.problem_statement).toContain('nonce is stale');
    expect(item.gold_tests['client/test/adapters/mech/safe.nonce.test.ts']).toBe('TEST_CONTENT');
    expect(item.solution_patch).not.toContain('client/test/');
    expect(item.test_cmd).toContain('client/test/adapters/mech/safe.nonce.test.ts');
  });
});
