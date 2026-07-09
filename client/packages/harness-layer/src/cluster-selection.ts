import type { DistillCluster } from './distill.js';

export type ClusterSelectionTier = DistillCluster['tier'];

export interface ClusterSelectionOptions {
  maxClusters?: number;
  maxContrastive?: number;
  maxLessons?: number;
  maxPatterns?: number;
}

export interface ClusterScore {
  clusterId: string;
  tier: ClusterSelectionTier;
  score: number;
  estimatedInputTokens: number;
  groupSize: number;
  nPass: number;
  nFail: number;
  reasons: string[];
}

export interface SelectedCluster {
  cluster: DistillCluster;
  score: ClusterScore;
}

export interface ClusterSelectionResult {
  selected: SelectedCluster[];
  rejected: Array<{ clusterId: string; reason: string; score: ClusterScore }>;
  caps: Required<ClusterSelectionOptions>;
}

const DEFAULT_CAPS: Required<ClusterSelectionOptions> = {
  maxContrastive: 8,
  maxLessons: 6,
  maxPatterns: 4,
  maxClusters: 18,
};

const TIER_BASE: Record<ClusterSelectionTier, number> = {
  contrastive: 10_000,
  lesson: 6_000,
  pattern: 3_000,
};

function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value ?? ''), 'utf8') / 4);
}

function numberField(input: unknown, key: 'groupSize' | 'nPass' | 'nFail'): number | null {
  if (input && typeof input === 'object' && key in input) {
    const value = (input as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  return null;
}

function inputItems(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object' && Array.isArray((input as { items?: unknown }).items)) {
    return (input as { items: unknown[] }).items;
  }
  return [];
}

function outcomeStatus(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const outcome = (item as { outcome?: unknown }).outcome;
  if (!outcome || typeof outcome !== 'object') return null;
  const status = (outcome as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

function clusterCounts(cluster: DistillCluster): { groupSize: number; nPass: number; nFail: number } {
  const items = inputItems(cluster.input);
  const derivedPass = items.filter((item) => outcomeStatus(item) === 'completed').length;
  const derivedFail = items.filter((item) => outcomeStatus(item) === 'failed').length;
  const nPass = numberField(cluster.input, 'nPass') ?? derivedPass;
  const nFail = numberField(cluster.input, 'nFail') ?? derivedFail;
  const groupSize = numberField(cluster.input, 'groupSize') ?? Math.max(items.length, nPass + nFail, cluster.evidenceRefs.length);
  return { groupSize, nPass, nFail };
}

export function scoreCluster(cluster: DistillCluster): ClusterScore {
  const { groupSize, nPass, nFail } = clusterCounts(cluster);
  const estimatedInputTokens = estimateTokens(cluster.input);
  const reasons: string[] = [cluster.tier];
  let score = TIER_BASE[cluster.tier];

  if (cluster.tier === 'contrastive') {
    score += 1_500;
    score += Math.min(nPass, nFail) * 250;
    reasons.push('contrastive-pass-fail-delta');
  }

  if (cluster.tier === 'lesson') {
    score += Math.min(nFail, 8) * 180;
    if (nFail > 1) reasons.push('high-attempt-lesson');
  }

  if (cluster.tier === 'pattern') {
    score += Math.min(nPass, 8) * 120;
    if (nPass > 1) reasons.push('multi-attempt-pattern');
  }

  score += Math.min(groupSize, 8) * 80;
  if (groupSize > 1) reasons.push('multi-attempt');

  const tokenPenalty = Math.ceil(estimatedInputTokens / 500);
  score -= tokenPenalty;
  if (tokenPenalty > 0) reasons.push('token-penalty');

  return {
    clusterId: cluster.clusterId,
    tier: cluster.tier,
    score,
    estimatedInputTokens,
    groupSize,
    nPass,
    nFail,
    reasons,
  };
}

function capsFromOptions(opts: ClusterSelectionOptions): Required<ClusterSelectionOptions> {
  return {
    maxContrastive: opts.maxContrastive ?? DEFAULT_CAPS.maxContrastive,
    maxLessons: opts.maxLessons ?? DEFAULT_CAPS.maxLessons,
    maxPatterns: opts.maxPatterns ?? DEFAULT_CAPS.maxPatterns,
    maxClusters: opts.maxClusters ?? DEFAULT_CAPS.maxClusters,
  };
}

export function selectUsefulClusters(
  clusters: DistillCluster[],
  opts: ClusterSelectionOptions = {},
): ClusterSelectionResult {
  const caps = capsFromOptions(opts);
  const ranked = clusters
    .map((cluster) => ({ cluster, score: scoreCluster(cluster) }))
    .sort((a, b) => {
      if (b.score.score !== a.score.score) return b.score.score - a.score.score;
      return a.cluster.clusterId.localeCompare(b.cluster.clusterId);
    });

  let contrastive = 0;
  let lessons = 0;
  let patterns = 0;
  const selected: SelectedCluster[] = [];
  const rejected: ClusterSelectionResult['rejected'] = [];

  for (const row of ranked) {
    if (selected.length >= caps.maxClusters) {
      rejected.push({ clusterId: row.cluster.clusterId, reason: 'total-cap', score: row.score });
      continue;
    }
    if (row.cluster.tier === 'contrastive' && contrastive >= caps.maxContrastive) {
      rejected.push({ clusterId: row.cluster.clusterId, reason: 'contrastive-cap', score: row.score });
      continue;
    }
    if (row.cluster.tier === 'lesson' && lessons >= caps.maxLessons) {
      rejected.push({ clusterId: row.cluster.clusterId, reason: 'lesson-cap', score: row.score });
      continue;
    }
    if (row.cluster.tier === 'pattern' && patterns >= caps.maxPatterns) {
      rejected.push({ clusterId: row.cluster.clusterId, reason: 'pattern-cap', score: row.score });
      continue;
    }

    selected.push(row);
    if (row.cluster.tier === 'contrastive') contrastive += 1;
    else if (row.cluster.tier === 'lesson') lessons += 1;
    else patterns += 1;
  }

  selected.sort((a, b) => a.cluster.clusterId.localeCompare(b.cluster.clusterId));
  return { selected, rejected, caps };
}
