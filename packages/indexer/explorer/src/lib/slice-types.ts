/**
 * Mirror of packages/indexer/src/api/slice.ts SliceResponse shapes.
 * Kept in /lib/ so the SPA doesn't import from the indexer src tree.
 * Update both files together — drift here = wire-protocol bug.
 */

import type { LearningCurveBucket } from './api';

export type SliceGroupBy =
  | 'none'
  | 'operator'
  | 'harness'
  | 'plugin'
  | 'mode'
  | 'model';

export type SliceBucketSize = 'auto' | 'per-block' | 'per-day' | 'per-week';

export interface SliceFilter {
  operator?: string[];
  harness?: string[];
  plugin?: string[];
  mode?: string[];
  model?: string[];
}

export interface SliceParams {
  manifestDigest: string;
  group: SliceGroupBy;
  filter: SliceFilter;
  includeUnenriched: boolean;
  bucket: SliceBucketSize;
}

export interface SliceSeriesKPIs {
  attempts: number;
  verdicts: number;
  verdictsPass: number;
  resolvedRate: number | null;
  jinnEarned: string;
}

export interface SliceSeries {
  groupValue: string | null;
  buckets: LearningCurveBucket[];
  rolling: number[];
  kpis: SliceSeriesKPIs;
}

export interface SliceResponseLeaderboardRow {
  operator: string;
  attempts: number;
  verdictsTotal: number;
  verdictsPass: number;
  resolvedRate: number | null;
  jinnEarned: string;
  dominantMode?: string;
  dominantHarness?: string;
}

export interface SliceResponse {
  params: SliceParams;
  enrichmentCoverage: number;
  kpis: SliceSeriesKPIs;
  series: SliceSeries[];
  leaderboard: {
    train: SliceResponseLeaderboardRow[];
    frozen: SliceResponseLeaderboardRow[];
  };
}
