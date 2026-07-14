import { describe, expect, it } from 'vitest';
import { classifyMergeBatchRisk } from '../../src/merge-batch/risk.js';
import type { MergeBatchPr } from '../../src/merge-batch/types.js';

function pr(overrides: Partial<MergeBatchPr>): MergeBatchPr {
  return {
    number: 1,
    title: 'fix(client): example',
    headRefName: 'fix/example',
    headRefOid: 'sha',
    author: 'author',
    linkedIssueNumber: 1,
    blockedOn: 'Nothing',
    files: ['client/src/foo.ts'],
    additions: 10,
    deletions: 2,
    dependsOnPrNumbers: [],
    review: { kind: 'satisfied', approvers: ['oaksprout'] },
    ci: { kind: 'green' },
    risk: 'normal',
    ...overrides,
  };
}

describe('classifyMergeBatchRisk', () => {
  it('marks tiny PRs as small', () => {
    expect(classifyMergeBatchRisk(pr({
      files: ['client/src/foo.ts'],
      additions: 8,
      deletions: 2,
    }))).toBe('small');
  });

  it('marks broad PRs as large', () => {
    const files = Array.from({ length: 21 }, (_, i) => `client/src/file-${i}.ts`);
    expect(classifyMergeBatchRisk(pr({ files, additions: 100, deletions: 20 }))).toBe('large');
  });

  it('marks high-churn PRs as large', () => {
    expect(classifyMergeBatchRisk(pr({ additions: 650, deletions: 220 }))).toBe('large');
  });

  it('puts release and workflow edits in the solo lane', () => {
    expect(classifyMergeBatchRisk(pr({ files: ['.github/workflows/npm-publish.yml'] }))).toBe('solo');
    expect(classifyMergeBatchRisk(pr({ files: ['client/package.json'] }))).toBe('solo');
  });
});
