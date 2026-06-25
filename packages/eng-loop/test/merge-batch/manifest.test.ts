import { describe, expect, it } from 'vitest';
import { createMergeBatchManifest, validateResume } from '../../src/merge-batch/manifest.js';
import type { MergeBatchPr } from '../../src/merge-batch/types.js';

function pr(number: number, overrides: Partial<MergeBatchPr> = {}): MergeBatchPr {
  return {
    number,
    title: `pr ${number}`,
    headRefName: `branch-${number}`,
    headRefOid: `sha-${number}`,
    author: 'author',
    linkedIssueNumber: number + 1000,
    blockedOn: 'Nothing',
    files: [`file-${number}.ts`],
    additions: 10,
    deletions: 1,
    dependsOnPrNumbers: [],
    review: { kind: 'satisfied', approvers: ['oaksprout'] },
    ci: { kind: 'green' },
    risk: 'normal',
    ...overrides,
  };
}

describe('merge-batch manifest', () => {
  it('creates waves and skips not-ready PRs', () => {
    const manifest = createMergeBatchManifest({
      baseNextSha: 'base',
      createdAt: '2026-06-17T10:00:00.000Z',
      prs: [
        pr(1),
        pr(2, { ci: { kind: 'pending', checks: ['build'] } }),
        pr(3, { review: { kind: 'awaiting-maintainer-review' } }),
      ],
      maxWaveSize: 5,
    });

    expect(manifest.waves.map((w) => w.prs.map((item) => item.number))).toEqual([[1]]);
    expect(manifest.skipped.map((s) => [s.pr.number, s.reason])).toEqual([
      [2, 'awaiting-ci'],
      [3, 'awaiting-maintainer-review'],
    ]);
  });

  it('keeps admin-authorized PRs in the merge plan', () => {
    const manifest = createMergeBatchManifest({
      baseNextSha: 'base',
      createdAt: '2026-06-18T10:00:00.000Z',
      prs: [pr(1, { review: { kind: 'admin-authorized', approver: 'ritsukai' } })],
      maxWaveSize: 5,
    });

    expect(manifest.waves.map((w) => w.prs.map((item) => item.number))).toEqual([[1]]);
    expect(manifest.skipped).toEqual([]);
  });

  it('allows resume when next still equals the manifest base', () => {
    const manifest = createMergeBatchManifest({
      baseNextSha: 'base',
      createdAt: '2026-06-17T10:00:00.000Z',
      prs: [pr(1)],
      maxWaveSize: 5,
    });

    expect(validateResume(manifest, 'base')).toEqual({ kind: 'valid' });
  });

  it('rejects resume when next advanced outside the batch', () => {
    const manifest = createMergeBatchManifest({
      baseNextSha: 'base',
      createdAt: '2026-06-17T10:00:00.000Z',
      prs: [pr(1)],
      maxWaveSize: 5,
    });

    expect(validateResume(manifest, 'other')).toEqual({
      kind: 'invalid',
      reason: 'origin/next changed since manifest creation',
    });
  });
});
