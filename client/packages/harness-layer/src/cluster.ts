/**
 * The clustering step — group gate-eligible layer-1 evidence into
 * `DistillCluster[]` for the distiller (spec/2026-07-06-distillation-v1.md §7).
 *
 * v1 clustering is deliberately simple: run each item through the promotion
 * gate (`evaluateEligibility`, §6), drop ineligible evidence, then group the
 * survivors by `(tier, instanceId)` — one cluster per distinct instance id per
 * tier. A `pattern` and a `lesson` for the same instance are SEPARATE clusters
 * (distinct-instance clustering; recursion/hierarchy are v3). Pure and
 * deterministic: clusters come back sorted by `clusterId`.
 */

import { evaluateEligibility } from './gate.js';
import type { DistillCluster } from './distill.js';
import type { TraceEnvelopeV0 } from './envelope.js';

export interface ClusterItem {
  /** Source evidence envelope ref → `metadata.jinn.provenance`. */
  ref: string;
  /** The SWE-bench-style instance id this evidence belongs to. */
  instanceId: string;
  /** The scrubbed layer-1 trace envelope. */
  env: TraceEnvelopeV0;
}

export interface ClusterOptions {
  /** Held-out cap-v0 slate predicate — an item's instance in the slate is dropped. */
  heldOut?: (instanceId: string) => boolean;
  /** Overrides the gate's placeholder-density defacement threshold (§6). */
  maxPlaceholderDensity?: number;
}

/**
 * A compact projection of one eligible item's envelope — enough for the LLM
 * port to distil. Steps carry their `attributes` (the patch diff, the solver
 * step trace) as well as their name: a name-only projection under-feeds the
 * distiller — the patch is *what changed* and the trace is *the decision path*
 * (§8, v0.5). Each attribute is already ≤16 KiB (capped by `capture()`), so no
 * further bound is applied here.
 */
interface ClusterInputItem {
  ref: string;
  instanceId: string;
  taskSummary: string;
  distributionTags: string[];
  outcome: { status: TraceEnvelopeV0['outcome']['status']; summary?: string };
  steps: Array<{ name: string; attributes?: Record<string, unknown> }>;
}

/**
 * Group eligible layer-1 evidence into distill clusters, one per distinct
 * `(tier, instanceId)`. Ineligible items (per the gate) are dropped. The
 * returned clusters are sorted by `clusterId` for deterministic output.
 */
export function clusterEvidence(items: ClusterItem[], opts: ClusterOptions = {}): DistillCluster[] {
  const groups = new Map<string, { tier: 'pattern' | 'lesson'; instanceId: string; items: ClusterItem[] }>();

  for (const item of items) {
    const result = evaluateEligibility(item.env, {
      heldOut: opts.heldOut?.(item.instanceId),
      maxPlaceholderDensity: opts.maxPlaceholderDensity,
    });
    if (!result.eligible || result.tier === null) continue;

    const clusterId = `${result.tier}:${item.instanceId}`;
    let group = groups.get(clusterId);
    if (!group) {
      group = { tier: result.tier, instanceId: item.instanceId, items: [] };
      groups.set(clusterId, group);
    }
    group.items.push(item);
  }

  const clusters: DistillCluster[] = [];
  for (const [clusterId, group] of groups) {
    const input: ClusterInputItem[] = group.items.map((it) => ({
      ref: it.ref,
      instanceId: it.instanceId,
      taskSummary: it.env.task.summary,
      distributionTags: it.env.task.distributionTags,
      outcome: { status: it.env.outcome.status, summary: it.env.outcome.summary },
      steps: it.env.steps.map((s) => ({ name: s.name, attributes: s.attributes })),
    }));
    clusters.push({
      clusterId,
      tier: group.tier,
      evidenceRefs: group.items.map((it) => it.ref),
      instanceIds: [group.instanceId],
      input,
    });
  }

  clusters.sort((a, b) => (a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0));
  return clusters;
}
