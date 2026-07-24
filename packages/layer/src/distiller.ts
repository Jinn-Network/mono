/**
 * The `Distiller` seam (issue #1488) — one interface, two backends.
 *
 * A single surface, "distill these captures → skills", sits OVER the merged
 * distillation engine (`clusterEvidence` → `distillClusters`, spec
 * §6–§7). The engine is untouched; a backend only binds the SOURCE (where the
 * captures come from) and the SINK (where the distilled skills go):
 *
 *   - {@link createLocalDistiller} (rung 1) — source = the operator's OWN local
 *     captures; sink = a private local skill install (SKILL.md, NO chain
 *     anchor). It scrubs each capture at the layer-2 (secret-only) altitude —
 *     the same altitude the network bridge uses (bridge.ts, D6) — parses the
 *     resulting envelope, and hands it to the SAME gate/cluster/distill engine
 *     the network path runs. Nothing is published to the corpus; both the
 *     layer-1 evidence and the layer-2 skill stay on the operator's machine.
 *
 *   - {@link createNetworkDistiller} (rung 3) — source = the bonded network's
 *     verified evidence (the existing `session-derived.v1` task path); sink =
 *     the public anchored corpus. STUBBED for the MVP: it fails closed until
 *     #1395 wires the source + sink, so it is a drop-in later.
 *
 * The two rungs are symmetric behind the one interface: the same `distill()`
 * call, a different backend.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildLayer2ScrubPipeline,
  type ScrubPipeline,
} from '@jinn-network/core/scrub';
import { capture, type CapturedTask } from './capture.js';
import { parseTraceEnvelopeV0 } from './envelope.js';
import { clusterEvidence, type ClusterItem } from './cluster.js';
import {
  distillClusters,
  type DistillCluster,
  type DistillDeps,
  type DistillLLMOutput,
  type DistillResult,
} from './distill.js';
import { assertConformantName, buildSkillMarkdown, type SkillPackage } from './skill-package.js';

/** The held-out slate shape shared by the engine's gate + contamination scan. */
export interface HeldOutSlate {
  instanceIds: Set<string>;
  repos?: Set<string>;
}

/**
 * The layer-2 skill sink: install one distilled skill, returning the corpus ref
 * and (if anchored) the anchor tx. This is the engine's `publishSkill` port
 * shape, named as the seam's SINK so a backend supplies either a private local
 * install (no anchor) or the anchored corpus.
 */
export type SkillSink = (
  pkg: SkillPackage,
) => Promise<{ envelopeRef: string; anchorTx: string | null }>;

/** The result of one distillation run: the engine's distilled output + cluster count. */
export interface DistillerResult {
  /** Distinct clusters the eligible captures formed (§7). */
  clusterCount: number;
  /** The engine's per-cluster outcome: published skills, rejections, errors. */
  distilled: DistillResult;
}

/**
 * The single distillation surface. Backends bind the source (via the captures
 * they accept) and the sink (where the skills go); the engine in between is
 * shared and unchanged.
 */
export interface Distiller {
  /** Distill a batch of captures into layer-2 skills via this backend's sink. */
  distill(captures: CapturedTask[]): Promise<DistillerResult>;
}

/**
 * A private local skill install (rung-1 sink): write `<outDir>/<name>/SKILL.md`
 * with the embedded provenance block, no chain anchor. Mirrors the fs-writer the
 * `distill run` CLI + `distill-run-live.ts` already use, extracted so the
 * LocalDistiller and those call sites share one implementation.
 */
export function createLocalSkillSink(outDir: string): SkillSink {
  return async (pkg) => {
    // Validate the publisher-controlled name BEFORE it touches the filesystem —
    // the engine already emits conformant names, but this helper is exported, so
    // it defends its own boundary (no `../` in the install path).
    assertConformantName(pkg.name);
    const dir = join(outDir, pkg.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), buildSkillMarkdown(pkg));
    return { envelopeRef: `local:${pkg.name}`, anchorTx: null };
  };
}

export interface LocalDistillerDeps {
  /** The LLM distill port (jinn-skill-distill-prompt-v1 over a cluster). */
  distill: (cluster: DistillCluster) => Promise<DistillLLMOutput>;
  /** Where distilled skills are installed (default sink: {@link createLocalSkillSink}). */
  sink: SkillSink;
  /**
   * Held-out slate — defence-in-depth over the gate + the distiller's
   * contamination scan. Own-captures rarely intersect a public held-out slate,
   * so this defaults to empty.
   */
  slate?: HeldOutSlate;
  /** Skill distribution recorded in provenance (§5). Default `coding`. */
  distribution?: string;
  /** The distilling model, recorded in each skill's provenance (§5 auditability). */
  distillModel?: string;
  /** Injectable layer-2 scrub pipeline (tests). Default: {@link buildLayer2ScrubPipeline}. */
  scrubPipeline?: ScrubPipeline;
  now?: () => Date;
  /** Progress seam (#1533), threaded through to {@link distillClusters}. */
  onPlan?: DistillDeps['onPlan'];
  onCluster?: DistillDeps['onCluster'];
}

/**
 * Rung-1 backend: distill the operator's OWN local captures in-process.
 *
 * Each capture is scrubbed at the layer-2 altitude and turned into an in-memory
 * layer-1 envelope (never published), then the whole batch runs through the
 * shared gate/cluster/distill engine. The instance key for clustering is the
 * capture's `sessionId` — one own session is one instance. Only
 * evaluator-verified captures are eligible (the gate, §6); everything else is
 * dropped before the LLM is called.
 */
export function createLocalDistiller(deps: LocalDistillerDeps): Distiller {
  return {
    async distill(captures: CapturedTask[]): Promise<DistillerResult> {
      const layer2 = deps.scrubPipeline ?? buildLayer2ScrubPipeline();
      const slate: HeldOutSlate = deps.slate ?? { instanceIds: new Set<string>() };

      // Source binding: own capture → scrubbed layer-1 envelope → cluster item.
      // Parsing with consent=true only CONSTRUCTS the in-memory envelope for the
      // gate/cluster; nothing leaves the machine (the network bridge does the
      // same, pipeline.ts).
      const items: ClusterItem[] = [];
      for (const task of captures) {
        const pending = await capture(task, { pipeline: layer2 });
        const env = parseTraceEnvelopeV0({
          ...pending.draft,
          consent: { contributionConsent: true, scrubCompleted: true },
        });
        items.push({
          ref: `local-capture:${task.session.sessionId}`,
          instanceId: task.session.sessionId,
          env,
        });
      }

      const clusters = clusterEvidence(items, {
        heldOut: (id) => slate.instanceIds.has(id),
        eligibilityMode: 'local-experimental',
      });
      const sourceTools = [...new Set(captures.map((task) => task.environment.harness.name))].sort();
      const evidenceTier =
        clusters.some((cluster) => cluster.tier === 'contrastive')
          ? 'contrastive'
          : captures.length > 1
            ? 'recurring-pattern'
            : 'single-example';
      const distilled = await distillClusters(clusters, {
        distill: deps.distill,
        publishSkill: deps.sink,
        slate,
        distribution: deps.distribution ?? 'coding',
        verifiabilityTier: 'user-accepted',
        skillStatus: 'experimental',
        evidenceTier,
        sourceTools,
        targetTools: ['current'],
        ...(deps.distillModel ? { distillModel: deps.distillModel } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.onPlan ? { onPlan: deps.onPlan } : {}),
        ...(deps.onCluster ? { onCluster: deps.onCluster } : {}),
      });

      return { clusterCount: clusters.length, distilled };
    },
  };
}

/**
 * Thrown when {@link createNetworkDistiller}'s backend is invoked before it is
 * wired (fail-closed). The rung-3 wiring — a `session-derived.v1` verdict source
 * feeding `runDistillationPipeline`, sinking to the anchored corpus — lands with
 * #1395.
 */
export class NetworkDistillerNotWiredError extends Error {
  constructor() {
    super(
      'NetworkDistiller is not wired for the MVP (rung 3). The bonded-network ' +
        'source (session-derived.v1 verified evidence) and the anchored-corpus ' +
        'sink land with #1395; until then this backend fails closed. Use ' +
        'createLocalDistiller for own-captures distillation.',
    );
    this.name = 'NetworkDistillerNotWiredError';
  }
}

/**
 * Rung-3 backend (STUBBED). The drop-in seam: the wired version drives the same
 * merged engine as LocalDistiller, but binds the network SOURCE — the
 * `session-derived.v1` task path over the bonded network's verified evidence
 * (bridge-verdict-source.ts → bridgeAttempts → clusterEvidence) — and the
 * anchored-corpus SINK (`publishSkill` with a chain anchor). Until #1395 wires
 * those ports, `distill()` fails closed with {@link NetworkDistillerNotWiredError}
 * so the not-wired state is loud, never a silent no-op.
 */
export function createNetworkDistiller(): Distiller {
  return {
    async distill(): Promise<DistillerResult> {
      throw new NetworkDistillerNotWiredError();
    },
  };
}
