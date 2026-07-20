import { describe, expect, it } from 'vitest';
import {
  attemptRecordFileName,
  metaSourceSignature,
  rebuildModelManifestFromAttemptRecords,
  reconstructSelectedClusters,
  type FrozenClusterSelection,
  type Stage1AttemptRecord,
} from '../src/eval-prep.js';

function env(status: 'completed' | 'failed', summary: string): any {
  return {
    schemaVersion: 'jinn.trace-envelope.v0',
    session: { sessionId: 's', capturedAt: '2026-07-09T00:00:00.000Z' },
    task: { summary, distributionTags: ['coding'] },
    environment: { harness: { name: 'test', version: '0.0.0' }, model: 'test', tools: [] },
    steps: [{ name: 'tool:apply_patch', attributes: { patch: 'diff --git a/x b/x\n+ ok\n' } }],
    outcome: { status, verifiabilityTier: 'evaluator-verified' },
    cost: { durationMs: 0 },
    provenance: 'contributed',
    consent: { contributionConsent: true, scrubCompleted: true },
  };
}

describe('eval-prep idempotency helpers', () => {
  it('encodes attempt record names safely for cluster ids with separators', () => {
    const file = attemptRecordFileName('contrastive:owner__repo-123/path-ish');

    expect(file).toMatch(/^[A-Za-z0-9_-]+\.json$/);
    expect(file).not.toContain(':');
    expect(file).not.toContain('/');
  });

  it('reconstructs selected clusters from frozen selection and raw evidence in selection order', () => {
    const raw = [
      { ref: 'ref-pass', instanceId: 'owner__repo-1', env: env('completed', 'fix the passing version') },
      { ref: 'ref-fail', instanceId: 'owner__repo-1', env: env('failed', 'fix the failing version') },
      { ref: 'ref-other', instanceId: 'other__repo-2', env: env('completed', 'some other passing version') },
    ];
    const frozen: FrozenClusterSelection[] = [
      {
        clusterId: 'pattern:other__repo-2',
        tier: 'pattern',
        evidenceRefs: ['ref-other'],
        instanceIds: ['other__repo-2'],
        score: {
          clusterId: 'pattern:other__repo-2',
          tier: 'pattern',
          score: 1,
          estimatedInputTokens: 1,
          groupSize: 1,
          nPass: 1,
          nFail: 0,
          reasons: ['pattern'],
        },
      },
      {
        clusterId: 'contrastive:owner__repo-1',
        tier: 'contrastive',
        evidenceRefs: ['ref-pass', 'ref-fail'],
        instanceIds: ['owner__repo-1'],
        score: {
          clusterId: 'contrastive:owner__repo-1',
          tier: 'contrastive',
          score: 2,
          estimatedInputTokens: 1,
          groupSize: 2,
          nPass: 1,
          nFail: 1,
          reasons: ['contrastive'],
        },
      },
    ];

    const clusters = reconstructSelectedClusters(frozen, raw, new Set());

    expect(clusters.map((cluster) => cluster.clusterId)).toEqual([
      'pattern:other__repo-2',
      'contrastive:owner__repo-1',
    ]);
  });

  it('rebuilds a model manifest from stage-1 attempt records', () => {
    const records: Stage1AttemptRecord[] = [
      {
        schema: 'jinn.distill.eval-attempt.v1',
        label: 'mini',
        model: 'gpt-5.4-mini',
        clusterId: 'pattern:a__repo-1',
        status: 'published',
        published: {
          clusterId: 'pattern:a__repo-1',
          skillKind: 'strategic-pattern',
          envelopeRef: 'local:mini:a',
          pkg: {
            name: 'a',
            description: 'Use when testing. Not for: production.',
            license: null,
            jinn: {
              schema: 'jinn.skill.v1',
              distribution: 'coding',
              verifiabilityTier: 'evaluator-verified',
              distilledFrom: 1,
              provenance: ['ref-a'],
            },
            body: '## When to use\nA\n## Strategy\nB\n## Steps\nC\n## Pitfalls\nD\n## Verify\nE\n',
          },
        },
      },
      {
        schema: 'jinn.distill.eval-attempt.v1',
        label: 'mini',
        model: 'gpt-5.4-mini',
        clusterId: 'lesson:b__repo-2',
        status: 'rejected',
        rejected: { clusterId: 'lesson:b__repo-2', reason: 'missing section' },
      },
    ];

    const manifest = rebuildModelManifestFromAttemptRecords('mini', 'gpt-5.4-mini', [
      'pattern:a__repo-1',
      'lesson:b__repo-2',
    ], records, []);

    expect(manifest.published.map((row) => row.clusterId)).toEqual(['pattern:a__repo-1']);
    expect(manifest.rejected.map((row) => row.clusterId)).toEqual(['lesson:b__repo-2']);
    expect(manifest.errors).toEqual([]);
  });

  it('changes meta source signatures when accepted stage-1 sources change', () => {
    const base = metaSourceSignature({
      metaClusterId: 'cross-instance:contrastive',
      polarity: 'contrastive',
      gateTier: 'contrastive',
      sources: [
        { id: 's1', name: 'alpha', description: 'A', body: 'Body A', evidenceRefs: ['ref-a'], instanceIds: ['a__repo-1'] },
        { id: 's2', name: 'beta', description: 'B', body: 'Body B', evidenceRefs: ['ref-b'], instanceIds: ['b__repo-2'] },
      ],
    });
    const changed = metaSourceSignature({
      metaClusterId: 'cross-instance:contrastive',
      polarity: 'contrastive',
      gateTier: 'contrastive',
      sources: [
        { id: 's1', name: 'alpha', description: 'A', body: 'Body A changed', evidenceRefs: ['ref-a'], instanceIds: ['a__repo-1'] },
        { id: 's2', name: 'beta', description: 'B', body: 'Body B', evidenceRefs: ['ref-b'], instanceIds: ['b__repo-2'] },
      ],
    });

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(base);
  });
});
