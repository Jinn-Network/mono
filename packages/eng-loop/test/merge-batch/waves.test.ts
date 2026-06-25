import { describe, expect, it } from 'vitest';
import { planMergeBatchWaves } from '../../src/merge-batch/waves.js';
import type { MergeBatchPr } from '../../src/merge-batch/types.js';

function pr(
  number: number,
  files: string[],
  overrides: Partial<MergeBatchPr> = {},
): MergeBatchPr {
  return {
    number,
    title: `pr ${number}`,
    headRefName: `branch-${number}`,
    headRefOid: `sha-${number}`,
    author: 'author',
    linkedIssueNumber: number + 1000,
    blockedOn: 'Nothing',
    files,
    additions: 10,
    deletions: 1,
    dependsOnPrNumbers: [],
    review: { kind: 'satisfied', approvers: ['oaksprout'] },
    ci: { kind: 'green' },
    risk: 'normal',
    ...overrides,
  };
}

describe('planMergeBatchWaves', () => {
  it('groups dependency stacks consecutively', () => {
    const waves = planMergeBatchWaves([
      pr(10, ['a.ts']),
      pr(11, ['b.ts'], { dependsOnPrNumbers: [10] }),
      pr(12, ['c.ts']),
    ], { maxWaveSize: 10 });

    expect(waves.map((w) => w.prs.map((p) => p.number))).toEqual([[10, 11], [12]]);
    expect(waves[0]?.kind).toBe('dependency-stack');
    expect(waves[1]?.kind).toBe('independent');
  });

  it('keeps overlapping PRs in the same reactive-overlap wave', () => {
    const waves = planMergeBatchWaves([
      pr(20, ['client/src/store.ts']),
      pr(21, ['client/src/store.ts']),
      pr(22, ['client/src/api.ts']),
    ], { maxWaveSize: 10 });

    expect(waves.map((w) => w.prs.map((p) => p.number))).toEqual([[20, 21], [22]]);
    expect(waves[0]?.kind).toBe('reactive-overlap');
    expect(waves[1]?.kind).toBe('independent');
  });

  it('splits independent PRs by max wave size', () => {
    const waves = planMergeBatchWaves([
      pr(1, ['a.ts']),
      pr(2, ['b.ts']),
      pr(3, ['c.ts']),
      pr(4, ['d.ts']),
      pr(5, ['e.ts']),
    ], { maxWaveSize: 2 });

    expect(waves.map((w) => w.prs.map((p) => p.number))).toEqual([[1, 2], [3, 4], [5]]);
    expect(waves.every((w) => w.kind === 'independent')).toBe(true);
  });

  it('puts large and solo PRs in single-PR waves', () => {
    const waves = planMergeBatchWaves([
      pr(1, ['a.ts']),
      pr(2, ['client/package.json'], { risk: 'solo' }),
      pr(3, ['c.ts'], { risk: 'large' }),
      pr(4, ['d.ts']),
    ], { maxWaveSize: 10 });

    expect(waves.map((w) => w.prs.map((p) => p.number))).toEqual([[1, 4], [2], [3]]);
    expect(waves[1]?.kind).toBe('solo-large');
    expect(waves[2]?.kind).toBe('solo-large');
  });
});
