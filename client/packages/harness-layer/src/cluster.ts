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
import type { DistillCluster, SkillKind } from './distill.js';
import type { SkillPackage } from './skill-package.js';
import type { TraceEnvelopeV0 } from './envelope.js';

export interface ClusterItem {
  /** Source evidence envelope ref → `metadata.jinn.provenance`. */
  ref: string;
  /** The SWE-bench-style instance id this evidence belongs to. */
  instanceId: string;
  /** Lineage equivalence key — echo instances collapse to source (§7). */
  lineageKey?: string;
  /** The scrubbed layer-1 trace envelope. */
  env: TraceEnvelopeV0;
}

export interface ClusterOptions {
  /** Held-out cap-v0 slate predicate — an item's instance in the slate is dropped. */
  heldOut?: (instanceId: string) => boolean;
  /** Overrides the gate's placeholder-density defacement threshold (§6). */
  maxPlaceholderDensity?: number;
  /**
   * `network-strict` preserves the evaluator-verified promotion gate. The
   * local experimental path may draft private skills from user-accepted traces,
   * but those are not publishable network evidence.
   */
  eligibilityMode?: 'network-strict' | 'local-experimental';
}

/**
 * A compact projection of one eligible item's envelope — enough for the LLM
 * port to distill. Steps carry their `attributes` (the patch diff, the solver
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
  pass: ClusterItem[],
  fail: ClusterItem[],
): DistillCluster {
  const items = [...pass, ...fail];
  return {
    clusterId,
    tier,
    evidenceRefs: items.map((it) => it.ref),
    instanceIds: [instanceId],
    // The distiller reads group-relative signal off the pass/fail split; carry
    // it EXPLICITLY (§7, #1478) rather than making the model re-derive it from
    // per-item outcomes. `items` is the flat projection (pass then fail).
    input: {
      instanceId,
      tier,
      groupSize: items.length,
      nPass: pass.length,
      nFail: fail.length,
      items: projectInput(items),
    },
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
    const heldOut = opts.heldOut?.(item.instanceId) ?? false;
    const result = evaluateEligibility(item.env, {
      heldOut,
      maxPlaceholderDensity: opts.maxPlaceholderDensity,
    });
    let tier = result.eligible ? result.tier : null;
    if (tier === null && opts.eligibilityMode === 'local-experimental') {
      const localSafe =
        item.env.provenance === 'contributed' &&
        !heldOut &&
        !result.redactionHealth.defaced;
      if (localSafe && item.env.outcome.status === 'completed') tier = 'pattern';
      if (localSafe && item.env.outcome.status === 'failed') tier = 'lesson';
    }
    if (tier === null) continue;

    let slot = byInstance.get(item.instanceId);
    if (!slot) {
      slot = { pattern: [], lesson: [], order: order++ };
      byInstance.set(item.instanceId, slot);
    }
    slot[tier].push(item);
  }

  const clusters: DistillCluster[] = [];
  for (const [instanceId, slot] of byInstance) {
    const hasPattern = slot.pattern.length > 0;
    const hasLesson = slot.lesson.length > 0;
    if (hasPattern && hasLesson) {
      // Precedence: the contrastive fold SUPPRESSES the pattern-only/lesson-only
      // singles. Pattern refs precede lesson refs in the merged provenance.
      clusters.push(buildCluster(`contrastive:${instanceId}`, 'contrastive', instanceId, slot.pattern, slot.lesson));
    } else if (hasPattern) {
      clusters.push(buildCluster(`pattern:${instanceId}`, 'pattern', instanceId, slot.pattern, []));
    } else if (hasLesson) {
      clusters.push(buildCluster(`lesson:${instanceId}`, 'lesson', instanceId, [], slot.lesson));
    }
  }

  clusters.sort((a, b) => (a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0));
  return clusters;
}

/**
 * A stage-1 published skill joined to its originating cluster's provenance —
 * the stage-2 (cross-instance meta-distill) input (issue #1463). `pkg` supplies
 * the meta-distiller's reading material (the distilled skill); `evidenceRefs` /
 * `instanceIds` supply the union provenance and the ≥2-distinct-instance test.
 */
export interface Stage1PublishedSkill {
  clusterId: string;
  skillKind: SkillKind;
  pkg: SkillPackage;
  evidenceRefs: string[];
  instanceIds: string[];
  lineageKeys?: string[];
}

/** One labelled source inside a meta-cluster (its id is what the model echoes in `supports`). */
export interface MetaSource {
  id: string;
  name: string;
  description: string;
  body: string;
  evidenceRefs: string[];
  instanceIds: string[];
}

/**
 * The three stage-1 polarities eligible for stage-2 — `cross-instance` is
 * excluded (no meta-of-meta), so it is deliberately absent from this union.
 */
export type MetaPolarity = 'strategic-pattern' | 'failure-lesson' | 'contrastive';

/** A same-polarity batch of ≥2-distinct-instance stage-1 skills for the meta-distiller. */
export interface MetaCluster {
  metaClusterId: string;
  polarity: MetaPolarity;
  gateTier: DistillCluster['tier'];
  sources: MetaSource[];
}

/** The structural-gate tier each meta-eligible polarity keeps in stage-2. */
const META_GATE_TIER: Record<MetaPolarity, DistillCluster['tier']> = {
  'strategic-pattern': 'pattern',
  'failure-lesson': 'lesson',
  'contrastive': 'contrastive',
};

/** Meta-eligible polarity guard — the type-level "never recurse on cross-instance" gate. */
function isMetaPolarity(kind: SkillKind): kind is MetaPolarity {
  return kind in META_GATE_TIER;
}

export function lineageEquivalenceKey(item: ClusterItem): string {
  return item.lineageKey ?? item.instanceId;
}

/**
 * Group stage-1 published skills into one meta-cluster per polarity. A polarity
 * is meta-distillable only when it spans **≥2 distinct instances** (a
 * cross-instance rule needs corroboration from different problems). Meta-of-meta
 * is impossible: a `cross-instance` polarity is skipped. Deterministic —
 * meta-clusters and their sources come back in a stable order.
 */
export function buildMetaClusters(published: Stage1PublishedSkill[]): MetaCluster[] {
  const byPolarity = new Map<MetaPolarity, Stage1PublishedSkill[]>();
  for (const p of published) {
    if (!isMetaPolarity(p.skillKind)) continue; // never recurse on cross-instance
    const group = byPolarity.get(p.skillKind) ?? [];
    group.push(p);
    byPolarity.set(p.skillKind, group);
  }

  const clusters: MetaCluster[] = [];
  for (const [polarity, group] of byPolarity) {
    const distinctInstances = new Set(
      group.flatMap((g, gi) =>
        g.instanceIds.map((id, ii) => g.lineageKeys?.[ii] ?? id),
      ),
    );
    if (distinctInstances.size < 2) continue;
    const sources: MetaSource[] = group.map((g, i) => ({
      id: `s${i + 1}`,
      name: g.pkg.name,
      description: g.pkg.description,
      body: g.pkg.body,
      evidenceRefs: g.evidenceRefs,
      instanceIds: g.instanceIds,
    }));
    clusters.push({
      metaClusterId: `cross-instance:${polarity}`,
      polarity,
      gateTier: META_GATE_TIER[polarity],
      sources,
    });
  }

  clusters.sort((a, b) => (a.metaClusterId < b.metaClusterId ? -1 : a.metaClusterId > b.metaClusterId ? 1 : 0));
  return clusters;
}
