import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRef, BridgeEvidence } from './bridge.js';
import type { TraceEnvelopeV0 } from './envelope.js';
import type { HarnessPublishDeps } from './publish.js';
import { prepareDistillationEvidence } from './pipeline.js';
import { selectUsefulClusters, type ClusterSelectionOptions, type ClusterScore } from './cluster-selection.js';
import { buildMetaClusters, type MetaCluster, type Stage1PublishedSkill } from './cluster.js';
import {
  distillClusters,
  metaDistill,
  type DistillCluster,
  type DistillLLMOutput,
  type DistillResult,
  type MetaDistillLLMOutput,
  type MetaDistillResult,
} from './distill.js';
import { buildSkillMarkdown, type SkillPackage } from './skill-package.js';

export interface EvalPrepModel {
  label: string;
  model: string;
  distill: (cluster: DistillCluster) => Promise<DistillLLMOutput>;
  metaDistill?: (cluster: MetaCluster) => Promise<MetaDistillLLMOutput>;
}

export interface EvalPrepDeps {
  verdictSource: { list: (args?: { limit?: number }) => Promise<AttemptRef[]> };
  fetchEvidence: (ref: AttemptRef) => Promise<BridgeEvidence>;
  publishDeps: HarnessPublishDeps;
  slate: { instanceIds: Set<string>; repos?: Set<string> };
  models: EvalPrepModel[];
  outDir: string;
  selection?: ClusterSelectionOptions;
  meta?: boolean;
  distribution?: string;
  groupCap?: number;
  limit?: number;
  now?: () => Date;
}

export interface FrozenClusterSelection {
  clusterId: string;
  tier: DistillCluster['tier'];
  evidenceRefs: string[];
  instanceIds: string[];
  score: ClusterScore;
}

export interface EvalPrepModelManifest {
  label: string;
  model: string;
  attemptedClusterIds: string[];
  published: DistillResult['published'];
  rejected: DistillResult['rejected'];
  errors: DistillResult['errors'];
  metaClusterIds?: string[];
  metaDistilled?: MetaDistillResult;
}

export interface EvalPrepManifest {
  schema: 'jinn.distill.eval-prep.v1';
  generatedAt: string;
  mode: 'local-only';
  outDir: string;
  limit?: number;
  groupCap?: number;
  meta: boolean;
  clusterCount: number;
  selectedClusterIds: string[];
  models: Array<{
    label: string;
    model: string;
    attemptedClusterIds: string[];
    published: number;
    rejected: number;
    errors: number;
    metaClusterIds?: string[];
    metaPublished?: number;
    metaRejected?: number;
    metaErrors?: number;
  }>;
  bridge: {
    bridged: number;
    excludedHeldOut: number;
    deduped: number;
    errors: number;
    verdictsTruncated: boolean;
  };
}

export interface EvalPrepResult {
  manifest: EvalPrepManifest;
  selection: FrozenClusterSelection[];
  models: EvalPrepModelManifest[];
}

export function modelLabel(model: string): string {
  if (model === 'gpt-5.4-mini') return 'mini';
  const label = model.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return label === '' ? 'model' : label;
}

export function assertAttemptedClusterIds(selectedClusterIds: string[], attemptedClusterIds: string[]): void {
  if (
    selectedClusterIds.length !== attemptedClusterIds.length ||
    selectedClusterIds.some((id, i) => id !== attemptedClusterIds[i])
  ) {
    throw new Error(
      `eval-prep invariant failed: attempted cluster ids ${JSON.stringify(attemptedClusterIds)} did not match frozen selection ${JSON.stringify(selectedClusterIds)}`,
    );
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function writeEvidenceJsonl(path: string, rows: Array<{ ref: string; instanceId: string; env: TraceEnvelopeV0 }>): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''));
}

function ensureUniqueLabels(models: EvalPrepModel[]): void {
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.label)) throw new Error(`duplicate eval-prep model label: ${model.label}`);
    seen.add(model.label);
  }
}

export async function runEvalPrep(deps: EvalPrepDeps): Promise<EvalPrepResult> {
  ensureUniqueLabels(deps.models);
  mkdirSync(deps.outDir, { recursive: true });

  const prepared = await prepareDistillationEvidence({
    verdictSource: deps.verdictSource,
    fetchEvidence: deps.fetchEvidence,
    publishDeps: deps.publishDeps,
    slate: deps.slate,
    ...(deps.groupCap !== undefined ? { groupCap: deps.groupCap } : {}),
    ...(deps.limit !== undefined ? { limit: deps.limit } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });

  const selected = selectUsefulClusters(prepared.clusters, deps.selection);
  const selectedClusters = selected.selected.map((row) => row.cluster);
  const selectedClusterIds = selectedClusters.map((cluster) => cluster.clusterId);
  const frozenSelection: FrozenClusterSelection[] = selected.selected.map((row) => ({
    clusterId: row.cluster.clusterId,
    tier: row.cluster.tier,
    evidenceRefs: row.cluster.evidenceRefs,
    instanceIds: row.cluster.instanceIds,
    score: row.score,
  }));

  writeJson(join(deps.outDir, 'selection.json'), {
    schema: 'jinn.distill.eval-selection.v1',
    caps: selected.caps,
    selected: frozenSelection,
    rejected: selected.rejected,
  });

  const rawDir = join(deps.outDir, 'raw-evidence');
  mkdirSync(rawDir, { recursive: true });
  writeEvidenceJsonl(join(rawDir, 'evidence.jsonl'), prepared.collected);
  writeJson(join(rawDir, 'manifest.json'), {
    schema: 'jinn.distill.raw-evidence.v1',
    count: prepared.collected.length,
    refs: prepared.collected.map((row) => row.ref),
  });

  const modelResults: EvalPrepModelManifest[] = [];
  for (const model of deps.models) {
    const modelDir = join(deps.outDir, 'distilled', model.label);
    const skillsDir = join(modelDir, 'skills');
    const metaSkillsDir = join(modelDir, 'meta-skills');
    mkdirSync(skillsDir, { recursive: true });
    const attemptedClusterIds = selectedClusters.map((cluster) => cluster.clusterId);
    assertAttemptedClusterIds(selectedClusterIds, attemptedClusterIds);

    const publishSkill = async (pkg: SkillPackage): Promise<{ envelopeRef: string; anchorTx: string | null }> => {
      const dir = join(skillsDir, pkg.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), buildSkillMarkdown(pkg));
      return { envelopeRef: `local:${model.label}:${pkg.name}`, anchorTx: null };
    };

    const distilled = await distillClusters(selectedClusters, {
      distill: model.distill,
      publishSkill,
      slate: deps.slate,
      distribution: deps.distribution ?? 'coding',
      distillModel: model.model,
      ...(deps.now ? { now: deps.now } : {}),
    });

    let metaResult: MetaDistillResult | undefined;
    let metaClusterIds: string[] | undefined;
    if (deps.meta) {
      if (!model.metaDistill) {
        throw new Error(`eval-prep meta enabled but no metaDistill port was provided for ${model.label}`);
      }
      mkdirSync(metaSkillsDir, { recursive: true });
      const clusterById = new Map(selectedClusters.map((cluster) => [cluster.clusterId, cluster]));
      const stage1: Stage1PublishedSkill[] = distilled.published.map((published) => {
        const cluster = clusterById.get(published.clusterId);
        if (!cluster) throw new Error(`eval-prep meta: no originating cluster for ${published.clusterId}`);
        return {
          clusterId: published.clusterId,
          skillKind: published.skillKind,
          pkg: published.pkg,
          evidenceRefs: cluster.evidenceRefs,
          instanceIds: cluster.instanceIds,
        };
      });
      const metaClusters = buildMetaClusters(stage1);
      metaClusterIds = metaClusters.map((cluster) => cluster.metaClusterId);
      const publishMetaSkill = async (pkg: SkillPackage): Promise<{ envelopeRef: string; anchorTx: string | null }> => {
        const dir = join(metaSkillsDir, pkg.name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'SKILL.md'), buildSkillMarkdown(pkg));
        return { envelopeRef: `local:${model.label}:meta:${pkg.name}`, anchorTx: null };
      };
      metaResult = await metaDistill(metaClusters, {
        metaDistill: model.metaDistill,
        publishSkill: publishMetaSkill,
        slate: deps.slate,
        distribution: deps.distribution ?? 'coding',
        distillModel: model.model,
        ...(deps.now ? { now: deps.now } : {}),
      });
    }

    const modelManifest: EvalPrepModelManifest = {
      label: model.label,
      model: model.model,
      attemptedClusterIds,
      published: distilled.published,
      rejected: distilled.rejected,
      errors: distilled.errors,
      ...(metaClusterIds ? { metaClusterIds } : {}),
      ...(metaResult ? { metaDistilled: metaResult } : {}),
    };
    assertAttemptedClusterIds(selectedClusterIds, modelManifest.attemptedClusterIds);
    writeJson(join(modelDir, 'manifest.json'), modelManifest);
    modelResults.push(modelManifest);
  }

  const generatedAt = (deps.now?.() ?? new Date()).toISOString();
  const manifest: EvalPrepManifest = {
    schema: 'jinn.distill.eval-prep.v1',
    generatedAt,
    mode: 'local-only',
    outDir: deps.outDir,
    ...(deps.limit !== undefined ? { limit: deps.limit } : {}),
    ...(deps.groupCap !== undefined ? { groupCap: deps.groupCap } : {}),
    meta: deps.meta ?? false,
    clusterCount: prepared.clusters.length,
    selectedClusterIds,
    models: modelResults.map((m) => ({
      label: m.label,
      model: m.model,
      attemptedClusterIds: m.attemptedClusterIds,
      published: m.published.length,
      rejected: m.rejected.length,
      errors: m.errors.length,
      ...(m.metaClusterIds ? { metaClusterIds: m.metaClusterIds } : {}),
      ...(m.metaDistilled ? {
        metaPublished: m.metaDistilled.published.length,
        metaRejected: m.metaDistilled.rejected.length,
        metaErrors: m.metaDistilled.errors.length,
      } : {}),
    })),
    bridge: {
      bridged: prepared.bridge.bridged.length,
      excludedHeldOut: prepared.bridge.excludedHeldOut.length,
      deduped: prepared.bridge.deduped.length,
      errors: prepared.bridge.errors.length,
      verdictsTruncated: prepared.verdictsTruncated,
    },
  };
  writeJson(join(deps.outDir, 'manifest.json'), manifest);

  return { manifest, selection: frozenSelection, models: modelResults };
}
