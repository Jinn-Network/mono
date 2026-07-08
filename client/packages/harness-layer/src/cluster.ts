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

function projectInput(items: ClusterItem[]): ClusterInputItem[] {
  return items.map((it) => ({
    ref: it.ref,
    instanceId: it.instanceId,
    taskSummary: it.env.task.summary,
    distributionTags: it.env.task.distributionTags,
    outcome: { status: it.env.outcome.status, summary: it.env.outcome.summary },
    steps: it.env.steps.map((s) => ({ name: s.name, attributes: s.attributes })),
  }));
}

function buildCluster(
  clusterId: string,
  tier: DistillCluster['tier'],
  instanceId: string,
  items: ClusterItem[],
): DistillCluster {
  return {
    clusterId,
    tier,
    evidenceRefs: items.map((it) => it.ref),
    instanceIds: [instanceId],
    input: projectInput(items),
  };
}

/**
 * Group eligible layer-1 evidence into distill clusters. Ineligible items (per
 * the gate) are dropped. An instance with a single polarity yields one
 * `pattern:`/`lesson:` cluster; an instance carrying BOTH an
 * (eligible) pattern and lesson folds into ONE `contrastive:` cluster whose
 * evidence refs link both polarities, and the singles are suppressed (§7 v0.5,
 * ExpeL). The returned clusters are sorted by `clusterId` for determinism.
 */
export function clusterEvidence(items: ClusterItem[], opts: ClusterOptions = {}): DistillCluster[] {
  // Bucket eligible items by (instanceId → polarity), preserving input order.
  const byInstance = new Map<string, { pattern: ClusterItem[]; lesson: ClusterItem[]; order: number }>();
  let order = 0;

  for (const item of items) {
    const result = evaluateEligibility(item.env, {
      heldOut: opts.heldOut?.(item.instanceId),
      maxPlaceholderDensity: opts.maxPlaceholderDensity,
    });
    if (!result.eligible || result.tier === null) continue;

    let slot = byInstance.get(item.instanceId);
    if (!slot) {
      slot = { pattern: [], lesson: [], order: order++ };
      byInstance.set(item.instanceId, slot);
    }
    slot[result.tier].push(item);
  }

  const clusters: DistillCluster[] = [];
  for (const [instanceId, slot] of byInstance) {
    const hasPattern = slot.pattern.length > 0;
    const hasLesson = slot.lesson.length > 0;
    if (hasPattern && hasLesson) {
      // Precedence: the contrastive fold SUPPRESSES the pattern-only/lesson-only
      // singles. Pattern refs precede lesson refs in the merged provenance.
      clusters.push(buildCluster(`contrastive:${instanceId}`, 'contrastive', instanceId, [...slot.pattern, ...slot.lesson]));
    } else if (hasPattern) {
      clusters.push(buildCluster(`pattern:${instanceId}`, 'pattern', instanceId, slot.pattern));
    } else if (hasLesson) {
      clusters.push(buildCluster(`lesson:${instanceId}`, 'lesson', instanceId, slot.lesson));
    }
  }

  clusters.sort((a, b) => (a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0));
  return clusters;
}
