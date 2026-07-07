/**
 * Distillation pipeline orchestrator (spec/2026-07-06-distillation-v1.md §6–§8).
 *
 * Composes the run-time loop end to end: verdict source → **bridge** (ledger →
 * layer-1 evidence, both polarities, exclusion + dedup) → **gate + cluster**
 * (eligible evidence grouped by distinct instance/tier) → **distill** (patterns
 * + lessons → layer-2 skills). Every I/O boundary is an injected port, so the
 * whole loop runs green under stubs (the Tier-0 dry-run) and swaps to the real
 * adapters (verdict-source / fetchEvidence / claude distiller / publishSkill) +
 * `ANTHROPIC_API_KEY` for a Tier-1 run with no code change.
 *
 * The bridge and distiller are decoupled in production through the corpus; here
 * the pipeline captures each bridged envelope via the `publishEvidence` port and
 * hands the same envelopes to clustering, so it reuses the tested `bridgeAttempts`
 * (exclusion/dedup) without a corpus round-trip or a double fetch.
 */

import {
  bridgeAttempts,
  type AttemptRef,
  type BridgeEvidence,
  type BridgeResult,
} from './bridge.js';
import { capture } from './capture.js';
import { publish, type HarnessPublishDeps } from './publish.js';
import { buildLayer2ScrubPipeline } from '../../../src/trajectory/scrub/layer2.js';
import { parseTraceEnvelopeV0, type TraceEnvelopeV0 } from './envelope.js';
import { clusterEvidence } from './cluster.js';
import { distillClusters, type DistillCluster, type DistillLLMOutput, type DistillResult } from './distill.js';
import type { SkillPackage } from './skill-package.js';

export interface PipelineDeps {
  /** Ledger verdict-row source (both polarities). */
  verdictSource: { list: (args?: { limit?: number }) => Promise<AttemptRef[]> };
  /** Fetch the patch + task descriptor for an attempt. */
  fetchEvidence: (ref: AttemptRef) => Promise<BridgeEvidence>;
  /** Deps for the layer-1 publish (capture→publish). */
  publishDeps: HarnessPublishDeps;
  /** The LLM distill port (jinn-skill-distill-prompt-v1 over a cluster). */
  distill: (cluster: DistillCluster) => Promise<DistillLLMOutput>;
  /** Publish a layer-2 skill package (Plan A publishSkill). */
  publishSkill: (pkg: SkillPackage) => Promise<{ envelopeRef: string; anchorTx: string | null }>;
  /** Held-out slate (§12): excluded from the bridge AND the gate/cluster. */
  slate: { instanceIds: Set<string>; repos?: Set<string> };
  distribution?: string;
  limit?: number;
  now?: () => Date;
}

export interface PipelineResult {
  bridge: BridgeResult;
  clusterCount: number;
  distilled: DistillResult;
}

export async function runDistillationPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const layer2 = buildLayer2ScrubPipeline();
  const slateIds = deps.slate.instanceIds;
  const collected: Array<{ ref: string; instanceId: string; env: TraceEnvelopeV0 }> = [];

  // The bridge's publish port: capture at layer-2 altitude, publish layer-1
  // evidence, and collect the envelope for the gate/cluster stage.
  const publishEvidence = async (
    task: Parameters<typeof capture>[0],
    ref: AttemptRef,
  ): Promise<{ envelopeRef: string; anchorTx: string | null }> => {
    const pending = await capture(task, { pipeline: layer2 });
    const env = parseTraceEnvelopeV0({
      ...pending.draft,
      consent: { contributionConsent: true, scrubCompleted: true },
    });
    const published = await publish(pending, deps.publishDeps);
    if (published.vetoed) throw new Error('unexpected veto bridging evidence');
    collected.push({ ref: published.envelopeRef, instanceId: ref.instanceId, env });
    return { envelopeRef: published.envelopeRef, anchorTx: published.anchorTx };
  };

  // 1. Bridge — ledger → layer-1 evidence (exclusion + dedup live in bridgeAttempts).
  const refs = await deps.verdictSource.list({ ...(deps.limit !== undefined ? { limit: deps.limit } : {}) });
  const bridge = await bridgeAttempts(refs, {
    slateInstanceIds: slateIds,
    fetchEvidence: deps.fetchEvidence,
    publishEvidence,
    ...(deps.now ? { now: deps.now } : {}),
  });

  // 2. Gate + cluster — eligible evidence grouped by distinct (instance, tier).
  //    heldOut is defence-in-depth over the bridge's own exclusion.
  const clusters = clusterEvidence(collected, { heldOut: (id) => slateIds.has(id) });

  // 3. Distill — patterns + lessons → layer-2 skills (output scrub + contamination scan inside).
  const distilled = await distillClusters(clusters, {
    distill: deps.distill,
    publishSkill: deps.publishSkill,
    slate: deps.slate,
    ...(deps.distribution ? { distribution: deps.distribution } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });

  return { bridge, clusterCount: clusters.length, distilled };
}
