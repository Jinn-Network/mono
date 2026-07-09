import { describe, expect, it } from 'vitest';
import { scoreCluster, selectUsefulClusters } from '../src/cluster-selection.js';
import type { DistillCluster } from '../src/distill.js';

function cluster(
  tier: DistillCluster['tier'],
  id: string,
  counts: { nPass?: number; nFail?: number; bytes?: number } = {},
): DistillCluster {
  const nPass = counts.nPass ?? (tier === 'lesson' ? 0 : 1);
  const nFail = counts.nFail ?? (tier === 'pattern' ? 0 : 1);
  const groupSize = nPass + nFail;
  return {
    clusterId: `${tier}:${id}`,
    tier,
    evidenceRefs: Array.from({ length: Math.max(1, groupSize) }, (_, i) => `ref-${id}-${i}`),
    instanceIds: [id],
    input: {
      instanceId: id,
      tier,
      groupSize,
      nPass,
      nFail,
      items: [],
      payload: counts.bytes ? 'x'.repeat(counts.bytes) : 'short',
    },
  };
}

describe('cluster selection', () => {
  it('ranks contrastive clusters above single-polarity clusters', () => {
    const selected = selectUsefulClusters([
      cluster('lesson', 'b__repo-2', { nFail: 8 }),
      cluster('pattern', 'c__repo-3', { nPass: 8 }),
      cluster('contrastive', 'a__repo-1', { nPass: 1, nFail: 1 }),
    ], { maxClusters: 1 });

    expect(selected.selected.map((row) => row.cluster.clusterId)).toEqual(['contrastive:a__repo-1']);
  });

  it('ranks high-attempt lessons above one-off lessons', () => {
    const high = scoreCluster(cluster('lesson', 'high__repo-2', { nFail: 5 }));
    const oneOff = scoreCluster(cluster('lesson', 'one__repo-1', { nFail: 1 }));

    expect(high.score).toBeGreaterThan(oneOff.score);
    expect(high.reasons).toContain('high-attempt-lesson');
  });

  it('penalizes token-heavy clusters', () => {
    const small = scoreCluster(cluster('pattern', 'small__repo-1', { nPass: 3, bytes: 10 }));
    const large = scoreCluster(cluster('pattern', 'large__repo-2', { nPass: 3, bytes: 200_000 }));

    expect(large.estimatedInputTokens).toBeGreaterThan(small.estimatedInputTokens);
    expect(large.score).toBeLessThan(small.score);
  });

  it('enforces tier caps and the total cap', () => {
    const result = selectUsefulClusters([
      cluster('contrastive', 'c1__repo-1'),
      cluster('contrastive', 'c2__repo-2'),
      cluster('lesson', 'l1__repo-3', { nFail: 3 }),
      cluster('lesson', 'l2__repo-4', { nFail: 3 }),
      cluster('pattern', 'p1__repo-5', { nPass: 3 }),
      cluster('pattern', 'p2__repo-6', { nPass: 3 }),
    ], {
      maxContrastive: 1,
      maxLessons: 1,
      maxPatterns: 1,
      maxClusters: 2,
    });

    expect(result.selected).toHaveLength(2);
    expect(result.selected.filter((row) => row.cluster.tier === 'contrastive')).toHaveLength(1);
    expect(result.rejected.map((row) => row.reason)).toContain('total-cap');
    expect(result.rejected.map((row) => row.reason)).toContain('contrastive-cap');
  });

  it('breaks ties deterministically by cluster id', () => {
    const result = selectUsefulClusters([
      cluster('pattern', 'z__repo-9', { nPass: 1 }),
      cluster('pattern', 'a__repo-1', { nPass: 1 }),
    ], { maxClusters: 1 });

    expect(result.selected.map((row) => row.cluster.clusterId)).toEqual(['pattern:a__repo-1']);
  });
});
