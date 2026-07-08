import { describe, it, expect } from 'vitest';
import { clusterEvidence, type ClusterItem } from '../src/cluster.js';
import { parseTraceEnvelopeV0, type TraceEnvelopeV0 } from '../src/envelope.js';

/** A valid, clean layer-1 trace; override the eligibility-relevant slices. */
function env(over: {
  status?: 'completed' | 'failed' | 'abandoned';
  tier?: 'user-accepted' | 'tests-passed' | 'evaluator-verified';
  provenance?: 'contributed' | 'imported';
  summary?: string;
} = {}): TraceEnvelopeV0 {
  return parseTraceEnvelopeV0({
    schemaVersion: 'jinn.trace-envelope.v0',
    session: { sessionId: 's1', capturedAt: '2026-07-06T00:00:00.000Z' },
    task: { summary: over.summary ?? 'Fix duplicate rows', distributionTags: ['coding'] },
    environment: { harness: { name: 'jinn-execution-ledger-bridge', version: '0.1.0' }, model: 'm', tools: [] },
    steps: [
      {
        spanId: 'patch',
        parentSpanId: null,
        name: 'tool:apply_patch',
        startTimeUnixNano: '1751452882000000000',
        endTimeUnixNano: '1751452882000000000',
        attributes: { patch: 'diff --git a/models.py b/models.py\n+ qs = qs.distinct()' },
        redactedKeys: [],
      },
    ],
    outcome: { status: over.status ?? 'completed', verifiabilityTier: over.tier ?? 'evaluator-verified' },
    cost: { durationMs: 0 },
    consent: { contributionConsent: true, scrubCompleted: true },
    provenance: over.provenance ?? 'contributed',
  });
}

/** completed + evaluator-verified + contributed → pattern-eligible. */
const pattern = () => env({ status: 'completed', tier: 'evaluator-verified' });
/** failed + evaluator-verified + contributed → lesson-eligible. */
const lesson = () => env({ status: 'failed', tier: 'evaluator-verified' });
/** user-accepted → not distillable → dropped by the gate. */
const ineligible = () => env({ status: 'completed', tier: 'user-accepted' });

describe('clusterEvidence (distinct-instance clustering by tier, §7)', () => {
  const items: ClusterItem[] = [
    { ref: 'evA-p1', instanceId: 'instA', env: pattern() },
    { ref: 'evA-p2', instanceId: 'instA', env: pattern() },
    { ref: 'evA-l1', instanceId: 'instA', env: lesson() },
    { ref: 'evX-i1', instanceId: 'instA', env: ineligible() },
    { ref: 'evB-p1', instanceId: 'instB', env: pattern() },
  ];

  it('collapses multiple pattern refs for a single-polarity instance into one pattern cluster', () => {
    const clusters = clusterEvidence([
      { ref: 'p1', instanceId: 'instP', env: pattern() },
      { ref: 'p2', instanceId: 'instP', env: pattern() },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.clusterId).toBe('pattern:instP');
    expect(clusters[0]!.tier).toBe('pattern');
    expect(clusters[0]!.evidenceRefs).toEqual(['p1', 'p2']);
  });

  it('folds a both-polarity instance into ONE contrastive cluster, suppressing the singles (§7 v0.5)', () => {
    // instA in the shared fixture carries pattern×2 + lesson×1 (+ an ineligible).
    const clusters = clusterEvidence(items);
    const a = clusters.find((c) => c.instanceIds[0] === 'instA')!;
    expect(a.clusterId).toBe('contrastive:instA');
    expect(a.tier).toBe('contrastive');
    // provenance links BOTH polarities' eligible refs (ineligible dropped)
    expect(a.evidenceRefs.sort()).toEqual(['evA-l1', 'evA-p1', 'evA-p2']);
    // the pattern-only / lesson-only singles are suppressed
    expect(clusters.some((c) => c.clusterId === 'pattern:instA')).toBe(false);
    expect(clusters.some((c) => c.clusterId === 'lesson:instA')).toBe(false);
  });

  it('produces exactly 2 clusters (one contrastive, one single) and drops the ineligible item', () => {
    const clusters = clusterEvidence(items);
    expect(clusters).toHaveLength(2);
    const allRefs = clusters.flatMap((c) => c.evidenceRefs);
    expect(allRefs).not.toContain('evX-i1');
    expect(allRefs.sort()).toEqual(['evA-l1', 'evA-p1', 'evA-p2', 'evB-p1']);
  });

  it('a single-polarity distinct instance stays its own pattern cluster', () => {
    const clusters = clusterEvidence(items);
    const b = clusters.find((c) => c.clusterId === 'pattern:instB');
    expect(b).toBeDefined();
    expect(b!.instanceIds).toEqual(['instB']);
    expect(b!.evidenceRefs).toEqual(['evB-p1']);
  });

  it('is deterministic — clusters sorted by clusterId', () => {
    const ids = clusterEvidence(items).map((c) => c.clusterId);
    expect(ids).toEqual(['contrastive:instA', 'pattern:instB']);
    // shuffling the input does not change the output ordering
    const shuffled = [...items].reverse();
    expect(clusterEvidence(shuffled).map((c) => c.clusterId)).toEqual(ids);
  });

  it('carries a compact projection (task summary + step names) as cluster input', () => {
    const clusters = clusterEvidence([
      { ref: 'evA-p1', instanceId: 'instA', env: env({ summary: 'Dedup queryset rows' }) },
    ]);
    const input = clusters[0]!.input as Array<{ taskSummary: string; steps: Array<{ name: string }> }>;
    expect(input[0]!.taskSummary).toBe('Dedup queryset rows');
    expect(input[0]!.steps[0]!.name).toBe('tool:apply_patch');
  });

  it('projects step ATTRIBUTES (patch content), not just names — the distiller must see the evidence (§8, v0.5)', () => {
    const clusters = clusterEvidence([
      { ref: 'evA-p1', instanceId: 'instA', env: pattern() },
    ]);
    const input = clusters[0]!.input as Array<{
      steps: Array<{ name: string; attributes?: Record<string, unknown> }>;
    }>;
    const patchStep = input[0]!.steps.find((s) => s.name === 'tool:apply_patch')!;
    // the fixture env() carries a real diff in the patch attribute
    expect(String(patchStep.attributes?.patch)).toContain('qs.distinct()');
  });

  it('honours the heldOut predicate — a slate instance is dropped', () => {
    const clusters = clusterEvidence(items, { heldOut: (id) => id === 'instA' });
    expect(clusters.map((c) => c.clusterId)).toEqual(['pattern:instB']);
  });

  it('returns no clusters when every item is ineligible', () => {
    const clusters = clusterEvidence([{ ref: 'x', instanceId: 'instA', env: ineligible() }]);
    expect(clusters).toEqual([]);
  });
});
