import { describe, it, expect } from 'vitest';
import { buildMetaClusters, type Stage1PublishedSkill } from '../src/cluster.js';
import type { SkillPackage } from '../src/skill-package.js';
import type { SkillKind } from '../src/distill.js';

function pkg(name: string): SkillPackage {
  return {
    name,
    description: `Use when ${name}. Not for: unrelated cases.`,
    license: null,
    jinn: {
      schema: 'jinn.skill.v1',
      distribution: 'coding',
      verifiabilityTier: 'evaluator-verified',
      distilledFrom: 1,
      provenance: [`bafy-${name}`],
    },
    body: `## When to use\nx\n## Strategy\nx\n## Steps\nx\n## Pitfalls\nx\n## Verify\nx\n`,
  };
}

function s1(over: Partial<Stage1PublishedSkill> & { clusterId: string; skillKind: SkillKind; instanceIds: string[] }): Stage1PublishedSkill {
  return {
    pkg: pkg(over.clusterId),
    evidenceRefs: [`ev-${over.clusterId}`],
    ...over,
  } as Stage1PublishedSkill;
}

describe('buildMetaClusters (group stage-1 skills by polarity, §7 stage-2)', () => {
  it('groups a ≥2-distinct-instance polarity into one meta-cluster with labelled sources', () => {
    const clusters = buildMetaClusters([
      s1({ clusterId: 'lesson:instA', skillKind: 'failure-lesson', instanceIds: ['instA'] }),
      s1({ clusterId: 'lesson:instB', skillKind: 'failure-lesson', instanceIds: ['instB'] }),
    ]);
    expect(clusters).toHaveLength(1);
    const mc = clusters[0]!;
    expect(mc.metaClusterId).toBe('cross-instance:failure-lesson');
    expect(mc.polarity).toBe('failure-lesson');
    expect(mc.gateTier).toBe('lesson');
    expect(mc.sources.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(mc.sources[0]!.evidenceRefs).toEqual(['ev-lesson:instA']);
    expect(mc.sources[0]!.instanceIds).toEqual(['instA']);
  });

  it('drops a polarity with fewer than 2 DISTINCT instances', () => {
    const clusters = buildMetaClusters([
      s1({ clusterId: 'lesson:instA', skillKind: 'failure-lesson', instanceIds: ['instA'] }),
      s1({ clusterId: 'lesson:instA-2', skillKind: 'failure-lesson', instanceIds: ['instA'] }), // same instance
    ]);
    expect(clusters).toEqual([]);
  });

  it('maps each stage-1 polarity to its gate tier', () => {
    const clusters = buildMetaClusters([
      s1({ clusterId: 'pattern:a', skillKind: 'strategic-pattern', instanceIds: ['a'] }),
      s1({ clusterId: 'pattern:b', skillKind: 'strategic-pattern', instanceIds: ['b'] }),
      s1({ clusterId: 'contrastive:c', skillKind: 'contrastive', instanceIds: ['c'] }),
      s1({ clusterId: 'contrastive:d', skillKind: 'contrastive', instanceIds: ['d'] }),
    ]);
    const byPolarity = Object.fromEntries(clusters.map((c) => [c.polarity, c.gateTier]));
    expect(byPolarity['strategic-pattern']).toBe('pattern');
    expect(byPolarity['contrastive']).toBe('contrastive');
  });

  it('never recurses on a cross-instance polarity (no meta-of-meta)', () => {
    const clusters = buildMetaClusters([
      s1({ clusterId: 'xi:a', skillKind: 'cross-instance', instanceIds: ['a'] }),
      s1({ clusterId: 'xi:b', skillKind: 'cross-instance', instanceIds: ['b'] }),
    ]);
    expect(clusters).toEqual([]);
  });

  it('is deterministic — meta-clusters sorted by metaClusterId', () => {
    const clusters = buildMetaClusters([
      s1({ clusterId: 'pattern:a', skillKind: 'strategic-pattern', instanceIds: ['a'] }),
      s1({ clusterId: 'pattern:b', skillKind: 'strategic-pattern', instanceIds: ['b'] }),
      s1({ clusterId: 'lesson:a', skillKind: 'failure-lesson', instanceIds: ['a'] }),
      s1({ clusterId: 'lesson:b', skillKind: 'failure-lesson', instanceIds: ['b'] }),
    ]);
    expect(clusters.map((c) => c.metaClusterId)).toEqual([
      'cross-instance:failure-lesson',
      'cross-instance:strategic-pattern',
    ]);
  });
});
