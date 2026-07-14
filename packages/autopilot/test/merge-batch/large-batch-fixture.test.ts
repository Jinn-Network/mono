import { describe, expect, it } from 'vitest';
import { createMergeBatchManifest } from '../../src/merge-batch/manifest.js';
import type { MergeBatchPr } from '../../src/merge-batch/types.js';

function pr(number: number, file: string, overrides: Partial<MergeBatchPr> = {}): MergeBatchPr {
  return {
    number,
    title: `pr ${number}`,
    headRefName: `branch-${number}`,
    headRefOid: `sha-${number}`,
    author: 'author',
    linkedIssueNumber: number + 1000,
    blockedOn: 'Nothing',
    files: [file],
    additions: 12,
    deletions: 2,
    dependsOnPrNumbers: [],
    review: { kind: 'satisfied', approvers: ['oaksprout'] },
    ci: { kind: 'green' },
    risk: 'normal',
    ...overrides,
  };
}

describe('large-batch fixture', () => {
  it('plans 50 PRs into bounded waves with solo lanes and review skips', () => {
    const prs: MergeBatchPr[] = Array.from({ length: 50 }, (_, i) => {
      const number = i + 1;
      return pr(number, `client/src/module-${number}.ts`);
    });

    prs[4] = pr(5, 'client/package.json', { risk: 'solo' });
    prs[9] = pr(10, 'client/src/store.ts');
    prs[10] = pr(11, 'client/src/store.ts');
    prs[19] = pr(20, 'client/src/feature.ts', { dependsOnPrNumbers: [19] });
    prs[29] = pr(30, 'client/src/review.ts', {
      review: { kind: 'awaiting-maintainer-review' },
    });

    const manifest = createMergeBatchManifest({
      baseNextSha: 'base',
      createdAt: '2026-06-17T10:00:00.000Z',
      prs,
      maxWaveSize: 8,
    });

    expect(manifest.skipped.map((skip) => skip.pr.number)).toEqual([30]);
    expect(
      manifest.waves.every((wave) => wave.prs.length <= 8 || wave.kind === 'dependency-stack'),
    ).toBe(true);
    expect(
      manifest.waves.some((wave) => wave.kind === 'solo-large' && wave.prs[0]?.number === 5),
    ).toBe(true);
    expect(
      manifest.waves.some((wave) =>
        wave.kind === 'reactive-overlap' &&
        wave.prs.some((item) => item.number === 10) &&
        wave.prs.some((item) => item.number === 11),
      ),
    ).toBe(true);
  });
});
