import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRef, BridgeEvidence } from './bridge.js';
import type { TraceEnvelopeV0 } from './envelope.js';
import type { HarnessPublishDeps } from './publish.js';
import { prepareDistillationEvidence } from './pipeline.js';
import {
  resolveClusterSelectionCaps,
  selectUsefulClusters,
  type ClusterSelectionOptions,
  type ClusterScore,
} from './cluster-selection.js';
import {
  buildMetaClusters,
  clusterEvidence,
  type ClusterItem,
  type MetaCluster,
  type Stage1PublishedSkill,
} from './cluster.js';
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
  selectOnly?: boolean;
  meta?: boolean;
  force?: boolean;
  retryErrors?: boolean;
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
  selectOnly: boolean;
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

export interface RawEvidenceRow {
  ref: string;
  instanceId: string;
  env: TraceEnvelopeV0;
}

export type AttemptStatus = 'published' | 'rejected' | 'error';

export interface Stage1AttemptRecord {
  schema: 'jinn.distill.eval-attempt.v1';
  label: string;
  model: string;
  clusterId: string;
  status: AttemptStatus;
  completedAt?: string;
  published?: DistillResult['published'][number];
  rejected?: DistillResult['rejected'][number];
  error?: DistillResult['errors'][number];
}

export interface MetaAttemptRecord {
  schema: 'jinn.distill.eval-meta-attempt.v1';
  label: string;
  model: string;
  metaClusterId: string;
  sourceSignature: string;
  status: AttemptStatus;
  completedAt?: string;
  published?: MetaDistillResult['published'][number];
  rejected?: MetaDistillResult['rejected'][number];
  error?: MetaDistillResult['errors'][number];
}

interface SelectionFile {
  schema: 'jinn.distill.eval-selection.v1';
  caps: Required<ClusterSelectionOptions>;
  selected: FrozenClusterSelection[];
  rejected: Array<{ clusterId: string; reason: string; score: ClusterScore }>;
}

interface PreparedEvalSelection {
  frozenSelection: FrozenClusterSelection[];
  selectedClusters: DistillCluster[];
  selectedClusterIds: string[];
  clusterCount: number;
  bridge: EvalPrepManifest['bridge'];
  dirty: boolean;
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

export function attemptRecordFileName(id: string): string {
  return `${Buffer.from(id, 'utf8').toString('base64url')}.json`;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) output[key] = stableJsonValue(input[key]);
    return output;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export function metaSourceSignature(cluster: MetaCluster): string {
  return createHash('sha256').update(stableJson({
    metaClusterId: cluster.metaClusterId,
    polarity: cluster.polarity,
    gateTier: cluster.gateTier,
    sources: cluster.sources.map((source) => ({
      id: source.id,
      name: source.name,
      description: source.description,
      body: source.body,
      evidenceRefs: source.evidenceRefs,
      instanceIds: source.instanceIds,
    })),
  })).digest('hex');
}

export function reconstructSelectedClusters(
  frozen: FrozenClusterSelection[],
  rawRows: RawEvidenceRow[],
  slateInstanceIds: Set<string>,
): DistillCluster[] {
  const clusters = clusterEvidence(rawRows as ClusterItem[], { heldOut: (id) => slateInstanceIds.has(id) });
  const byId = new Map(clusters.map((cluster) => [cluster.clusterId, cluster]));
  return frozen.map((row) => {
    const cluster = byId.get(row.clusterId);
    if (!cluster) {
      throw new Error(`eval-prep resume: frozen cluster ${row.clusterId} could not be reconstructed from raw evidence`);
    }
    return cluster;
  });
}

export function rebuildModelManifestFromAttemptRecords(
  label: string,
  model: string,
  selectedClusterIds: string[],
  stage1Records: Stage1AttemptRecord[],
  metaRecords: MetaAttemptRecord[],
  opts: { metaClusterIds?: string[] } = {},
): EvalPrepModelManifest {
  const stage1ById = new Map(stage1Records.map((record) => [record.clusterId, record]));
  const published: DistillResult['published'] = [];
  const rejected: DistillResult['rejected'] = [];
  const errors: DistillResult['errors'] = [];
  const attemptedClusterIds: string[] = [];

  for (const clusterId of selectedClusterIds) {
    const record = stage1ById.get(clusterId);
    if (!record) continue;
    attemptedClusterIds.push(clusterId);
    if (record.status === 'published' && record.published) published.push(record.published);
    else if (record.status === 'rejected' && record.rejected) rejected.push(record.rejected);
    else if (record.status === 'error' && record.error) errors.push(record.error);
  }

  const metaById = new Map(metaRecords.map((record) => [record.metaClusterId, record]));
  const metaClusterIds = opts.metaClusterIds ?? [...metaById.keys()].sort();
  const metaResult: MetaDistillResult = { published: [], rejected: [], errors: [] };
  for (const metaClusterId of metaClusterIds) {
    const record = metaById.get(metaClusterId);
    if (!record) continue;
    if (record.status === 'published' && record.published) metaResult.published.push(record.published);
    else if (record.status === 'rejected' && record.rejected) metaResult.rejected.push(record.rejected);
    else if (record.status === 'error' && record.error) metaResult.errors.push(record.error);
  }

  return {
    label,
    model,
    attemptedClusterIds,
    published,
    rejected,
    errors,
    ...(metaRecords.length > 0 || opts.metaClusterIds !== undefined ? { metaClusterIds, metaDistilled: metaResult } : {}),
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function writeEvidenceJsonl(path: string, rows: RawEvidenceRow[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''));
}

function readEvidenceJsonl(path: string): RawEvidenceRow[] {
  const text = readFileSync(path, 'utf-8').trim();
  if (text === '') return [];
  return text.split('\n').map((line) => JSON.parse(line) as RawEvidenceRow);
}

function ensureUniqueLabels(models: EvalPrepModel[]): void {
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.label)) throw new Error(`duplicate eval-prep model label: ${model.label}`);
    seen.add(model.label);
  }
}

function sameCaps(a: Required<ClusterSelectionOptions>, b: Required<ClusterSelectionOptions>): boolean {
  return a.maxClusters === b.maxClusters &&
    a.maxContrastive === b.maxContrastive &&
    a.maxLessons === b.maxLessons &&
    a.maxPatterns === b.maxPatterns;
}

function describeCaps(caps: Required<ClusterSelectionOptions>): string {
  return `maxClusters=${caps.maxClusters}, maxContrastive=${caps.maxContrastive}, maxLessons=${caps.maxLessons}, maxPatterns=${caps.maxPatterns}`;
}

function validateResumeConfig(
  outDir: string,
  selectionFile: SelectionFile,
  manifest: EvalPrepManifest,
  deps: Pick<EvalPrepDeps, 'limit' | 'groupCap' | 'selection'>,
): void {
  const conflicts: string[] = [];
  const requestedCaps = resolveClusterSelectionCaps(deps.selection ?? {});
  if (!sameCaps(selectionFile.caps, requestedCaps)) {
    conflicts.push(`selection caps existing (${describeCaps(selectionFile.caps)}) requested (${describeCaps(requestedCaps)})`);
  }
  if (manifest.limit !== deps.limit) conflicts.push(`limit existing ${manifest.limit ?? 'unset'} requested ${deps.limit ?? 'unset'}`);
  if (manifest.groupCap !== deps.groupCap) conflicts.push(`group-cap existing ${manifest.groupCap ?? 'unset'} requested ${deps.groupCap ?? 'unset'}`);
  if (conflicts.length > 0) {
    throw new Error(`eval-prep output ${outDir} was created with a different frozen selection config: ${conflicts.join('; ')}. Pass --force to rebuild from scratch.`);
  }
}

async function prepareOrLoadSelection(deps: EvalPrepDeps): Promise<PreparedEvalSelection> {
  const selectionPath = join(deps.outDir, 'selection.json');
  const rawDir = join(deps.outDir, 'raw-evidence');
  const rawPath = join(rawDir, 'evidence.jsonl');
  const manifestPath = join(deps.outDir, 'manifest.json');
  const hasSelection = existsSync(selectionPath);
  const hasRaw = existsSync(rawPath);

  if (hasSelection || hasRaw) {
    if (!hasSelection || !hasRaw) {
      throw new Error(`eval-prep output ${deps.outDir} has partial frozen artifacts; pass --force to rebuild`);
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`eval-prep output ${deps.outDir} cannot be resumed because manifest.json is missing; pass --force to rebuild legacy or partial output`);
    }

    const selectionFile = readJson<SelectionFile>(selectionPath);
    const manifest = readJson<EvalPrepManifest>(manifestPath);
    validateResumeConfig(deps.outDir, selectionFile, manifest, deps);
    const rawRows = readEvidenceJsonl(rawPath);
    const selectedClusters = reconstructSelectedClusters(selectionFile.selected, rawRows, deps.slate.instanceIds);
    const selectedClusterIds = selectedClusters.map((cluster) => cluster.clusterId);
    assertAttemptedClusterIds(selectionFile.selected.map((row) => row.clusterId), selectedClusterIds);
    return {
      frozenSelection: selectionFile.selected,
      selectedClusters,
      selectedClusterIds,
      clusterCount: manifest.clusterCount,
      bridge: manifest.bridge,
      dirty: false,
    };
  }

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

  const selectionFile: SelectionFile = {
    schema: 'jinn.distill.eval-selection.v1',
    caps: selected.caps,
    selected: frozenSelection,
    rejected: selected.rejected,
  };
  writeJson(selectionPath, selectionFile);

  mkdirSync(rawDir, { recursive: true });
  writeEvidenceJsonl(rawPath, prepared.collected);
  writeJson(join(rawDir, 'manifest.json'), {
    schema: 'jinn.distill.raw-evidence.v1',
    count: prepared.collected.length,
    refs: prepared.collected.map((row) => row.ref),
  });

  return {
    frozenSelection,
    selectedClusters,
    selectedClusterIds,
    clusterCount: prepared.clusters.length,
    bridge: {
      bridged: prepared.bridge.bridged.length,
      excludedHeldOut: prepared.bridge.excludedHeldOut.length,
      deduped: prepared.bridge.deduped.length,
      errors: prepared.bridge.errors.length,
      verdictsTruncated: prepared.verdictsTruncated,
    },
    dirty: true,
  };
}

function buildManifest(
  deps: EvalPrepDeps,
  prepared: PreparedEvalSelection,
  modelResults: EvalPrepModelManifest[],
): EvalPrepManifest {
  const generatedAt = (deps.now?.() ?? new Date()).toISOString();
  return {
    schema: 'jinn.distill.eval-prep.v1',
    generatedAt,
    mode: 'local-only',
    outDir: deps.outDir,
    ...(deps.limit !== undefined ? { limit: deps.limit } : {}),
    ...(deps.groupCap !== undefined ? { groupCap: deps.groupCap } : {}),
    selectOnly: deps.selectOnly ?? false,
    meta: deps.meta ?? false,
    clusterCount: prepared.clusterCount,
    selectedClusterIds: prepared.selectedClusterIds,
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
    bridge: prepared.bridge,
  };
}

function writeSkillPackage(dir: string, pkg: SkillPackage): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), buildSkillMarkdown(pkg));
}

function attemptPath(dir: string, id: string): string {
  return join(dir, attemptRecordFileName(id));
}

function loadStage1Record(
  dir: string,
  label: string,
  model: string,
  clusterId: string,
): Stage1AttemptRecord | null {
  const path = attemptPath(dir, clusterId);
  if (!existsSync(path)) return null;
  const record = readJson<Stage1AttemptRecord>(path);
  if (record.schema !== 'jinn.distill.eval-attempt.v1' || record.label !== label || record.model !== model || record.clusterId !== clusterId) {
    throw new Error(`eval-prep attempt record mismatch at ${path}`);
  }
  return record;
}

function loadMetaRecord(
  dir: string,
  label: string,
  model: string,
  metaClusterId: string,
): MetaAttemptRecord | null {
  const path = attemptPath(dir, metaClusterId);
  if (!existsSync(path)) return null;
  const record = readJson<MetaAttemptRecord>(path);
  if (record.schema !== 'jinn.distill.eval-meta-attempt.v1' || record.label !== label || record.model !== model || record.metaClusterId !== metaClusterId) {
    throw new Error(`eval-prep meta-attempt record mismatch at ${path}`);
  }
  return record;
}

function stage1RecordFromResult(
  label: string,
  model: string,
  clusterId: string,
  result: DistillResult,
  completedAt: string,
): Stage1AttemptRecord {
  const published = result.published.find((row) => row.clusterId === clusterId);
  if (published) {
    return { schema: 'jinn.distill.eval-attempt.v1', label, model, clusterId, status: 'published', completedAt, published };
  }
  const rejected = result.rejected.find((row) => row.clusterId === clusterId);
  if (rejected) {
    return { schema: 'jinn.distill.eval-attempt.v1', label, model, clusterId, status: 'rejected', completedAt, rejected };
  }
  const error = result.errors.find((row) => row.clusterId === clusterId);
  if (error) {
    return { schema: 'jinn.distill.eval-attempt.v1', label, model, clusterId, status: 'error', completedAt, error };
  }
  return {
    schema: 'jinn.distill.eval-attempt.v1',
    label,
    model,
    clusterId,
    status: 'error',
    completedAt,
    error: { clusterId, error: 'distill returned no terminal result for cluster' },
  };
}

function metaRecordFromResult(
  label: string,
  model: string,
  metaClusterId: string,
  sourceSignature: string,
  result: MetaDistillResult,
  completedAt: string,
): MetaAttemptRecord {
  const published = result.published.find((row) => row.metaClusterId === metaClusterId);
  if (published) {
    return { schema: 'jinn.distill.eval-meta-attempt.v1', label, model, metaClusterId, sourceSignature, status: 'published', completedAt, published };
  }
  const rejected = result.rejected.find((row) => row.metaClusterId === metaClusterId);
  if (rejected) {
    return { schema: 'jinn.distill.eval-meta-attempt.v1', label, model, metaClusterId, sourceSignature, status: 'rejected', completedAt, rejected };
  }
  const error = result.errors.find((row) => row.metaClusterId === metaClusterId);
  if (error) {
    return { schema: 'jinn.distill.eval-meta-attempt.v1', label, model, metaClusterId, sourceSignature, status: 'error', completedAt, error };
  }
  return {
    schema: 'jinn.distill.eval-meta-attempt.v1',
    label,
    model,
    metaClusterId,
    sourceSignature,
    status: 'error',
    completedAt,
    error: { metaClusterId, error: 'meta-distill returned no terminal result for cluster' },
  };
}

function ensurePublishedSkillFile(record: Stage1AttemptRecord, skillsDir: string): boolean {
  if (record.status !== 'published' || !record.published) return false;
  const skillPath = join(skillsDir, record.published.pkg.name, 'SKILL.md');
  if (existsSync(skillPath)) return false;
  writeSkillPackage(join(skillsDir, record.published.pkg.name), record.published.pkg);
  return true;
}

function ensurePublishedMetaSkillFile(record: MetaAttemptRecord, metaSkillsDir: string): boolean {
  if (record.status !== 'published' || !record.published) return false;
  const skillPath = join(metaSkillsDir, record.published.pkg.name, 'SKILL.md');
  if (existsSync(skillPath)) return false;
  writeSkillPackage(join(metaSkillsDir, record.published.pkg.name), record.published.pkg);
  return true;
}

function stage1PublishedForMeta(
  selectedClusters: DistillCluster[],
  records: Stage1AttemptRecord[],
): Stage1PublishedSkill[] {
  const clusterById = new Map(selectedClusters.map((cluster) => [cluster.clusterId, cluster]));
  return records.flatMap((record) => {
    if (record.status !== 'published' || !record.published) return [];
    const cluster = clusterById.get(record.clusterId);
    if (!cluster) throw new Error(`eval-prep meta: no originating cluster for ${record.clusterId}`);
    return [{
      clusterId: record.clusterId,
      skillKind: record.published.skillKind,
      pkg: record.published.pkg,
      evidenceRefs: cluster.evidenceRefs,
      instanceIds: cluster.instanceIds,
    }];
  });
}

function loadUnrequestedModelManifests(outDir: string, requestedLabels: Set<string>): EvalPrepModelManifest[] {
  const distilledDir = join(outDir, 'distilled');
  if (!existsSync(distilledDir)) return [];
  return readdirSync(distilledDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !requestedLabels.has(entry.name))
    .map((entry) => join(distilledDir, entry.name, 'manifest.json'))
    .filter((path) => existsSync(path))
    .map((path) => readJson<EvalPrepModelManifest>(path))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function runEvalPrep(deps: EvalPrepDeps): Promise<EvalPrepResult> {
  ensureUniqueLabels(deps.models);
  if (deps.force) rmSync(deps.outDir, { recursive: true, force: true });
  mkdirSync(deps.outDir, { recursive: true });

  const prepared = await prepareOrLoadSelection(deps);
  const manifestPath = join(deps.outDir, 'manifest.json');
  let dirty = prepared.dirty;

  if (!existsSync(manifestPath)) {
    writeJson(manifestPath, buildManifest(deps, prepared, []));
    dirty = true;
  }

  const modelResults: EvalPrepModelManifest[] = [];
  for (const model of deps.selectOnly ? [] : deps.models) {
    const modelDir = join(deps.outDir, 'distilled', model.label);
    const skillsDir = join(modelDir, 'skills');
    const metaSkillsDir = join(modelDir, 'meta-skills');
    const attemptsDir = join(modelDir, 'attempts');
    const metaAttemptsDir = join(modelDir, 'meta-attempts');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(attemptsDir, { recursive: true });

    let modelDirty = false;
    const stage1Records: Stage1AttemptRecord[] = [];
    for (const cluster of prepared.selectedClusters) {
      const existing = loadStage1Record(attemptsDir, model.label, model.model, cluster.clusterId);
      if (existing && !(deps.retryErrors && existing.status === 'error')) {
        if (ensurePublishedSkillFile(existing, skillsDir)) {
          modelDirty = true;
          dirty = true;
        }
        stage1Records.push(existing);
        continue;
      }

      const publishSkill = async (pkg: SkillPackage): Promise<{ envelopeRef: string; anchorTx: string | null }> => {
        writeSkillPackage(join(skillsDir, pkg.name), pkg);
        return { envelopeRef: `local:${model.label}:${pkg.name}`, anchorTx: null };
      };
      const result = await distillClusters([cluster], {
        distill: model.distill,
        publishSkill,
        slate: deps.slate,
        distribution: deps.distribution ?? 'coding',
        distillModel: model.model,
        ...(deps.now ? { now: deps.now } : {}),
      });
      const record = stage1RecordFromResult(
        model.label,
        model.model,
        cluster.clusterId,
        result,
        (deps.now?.() ?? new Date()).toISOString(),
      );
      writeJson(attemptPath(attemptsDir, cluster.clusterId), record);
      stage1Records.push(record);
      modelDirty = true;
      dirty = true;
    }

    assertAttemptedClusterIds(
      prepared.selectedClusterIds,
      stage1Records.map((record) => record.clusterId),
    );

    let metaRecords: MetaAttemptRecord[] = [];
    let metaClusterIds: string[] | undefined;
    if (deps.meta) {
      if (!model.metaDistill) {
        throw new Error(`eval-prep meta enabled but no metaDistill port was provided for ${model.label}`);
      }
      mkdirSync(metaSkillsDir, { recursive: true });
      mkdirSync(metaAttemptsDir, { recursive: true });
      const metaClusters = buildMetaClusters(stage1PublishedForMeta(prepared.selectedClusters, stage1Records));
      metaClusterIds = metaClusters.map((cluster) => cluster.metaClusterId);
      for (const cluster of metaClusters) {
        const signature = metaSourceSignature(cluster);
        const existing = loadMetaRecord(metaAttemptsDir, model.label, model.model, cluster.metaClusterId);
        if (
          existing &&
          existing.sourceSignature === signature &&
          !(deps.retryErrors && existing.status === 'error')
        ) {
          if (ensurePublishedMetaSkillFile(existing, metaSkillsDir)) {
            modelDirty = true;
            dirty = true;
          }
          metaRecords.push(existing);
          continue;
        }

        const publishMetaSkill = async (pkg: SkillPackage): Promise<{ envelopeRef: string; anchorTx: string | null }> => {
          writeSkillPackage(join(metaSkillsDir, pkg.name), pkg);
          return { envelopeRef: `local:${model.label}:meta:${pkg.name}`, anchorTx: null };
        };
        const result = await metaDistill([cluster], {
          metaDistill: model.metaDistill,
          publishSkill: publishMetaSkill,
          slate: deps.slate,
          distribution: deps.distribution ?? 'coding',
          distillModel: model.model,
          ...(deps.now ? { now: deps.now } : {}),
        });
        const record = metaRecordFromResult(
          model.label,
          model.model,
          cluster.metaClusterId,
          signature,
          result,
          (deps.now?.() ?? new Date()).toISOString(),
        );
        writeJson(attemptPath(metaAttemptsDir, cluster.metaClusterId), record);
        metaRecords.push(record);
        modelDirty = true;
        dirty = true;
      }
    }

    const modelManifest = rebuildModelManifestFromAttemptRecords(
      model.label,
      model.model,
      prepared.selectedClusterIds,
      stage1Records,
      metaRecords,
      ...(metaClusterIds !== undefined ? [{ metaClusterIds }] : []),
    );
    assertAttemptedClusterIds(prepared.selectedClusterIds, modelManifest.attemptedClusterIds);
    const modelManifestPath = join(modelDir, 'manifest.json');
    if (modelDirty || !existsSync(modelManifestPath)) writeJson(modelManifestPath, modelManifest);
    modelResults.push(modelManifest);
  }

  const requestedLabels = new Set((deps.selectOnly ? [] : deps.models).map((model) => model.label));
  const allModelResults = deps.selectOnly
    ? modelResults
    : [...loadUnrequestedModelManifests(deps.outDir, requestedLabels), ...modelResults]
      .sort((a, b) => a.label.localeCompare(b.label));
  const manifest = buildManifest(deps, prepared, allModelResults);
  if (dirty || !existsSync(manifestPath)) writeJson(manifestPath, manifest);

  return { manifest, selection: prepared.frozenSelection, models: allModelResults };
}
