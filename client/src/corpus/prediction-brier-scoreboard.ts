import type { EnvelopeProjection } from './types.js';
import { normalizeEnvelopeRole } from '../types/envelope.js';

export const DEFAULT_PREDICTION_BRIER_SCOREBOARD_WINDOW_DAYS = 84;

export interface PredictionBrierScoreboardOptions {
  asOfGeneratedAt?: number;
  trailingWindowDays?: number;
}

export interface PredictionBrierScoreboard {
  asOfGeneratedAt: number | null;
  windowStartGeneratedAt: number | null;
  trailingWindowDays: number;
  overall: PredictionBrierOverallSummary;
  weeklyTrend: PredictionBrierWeeklySummary[];
  perOperator: PredictionBrierOperatorSummary[];
  perHarness: PredictionBrierHarnessSummary[];
  perPlugin: PredictionBrierPluginSummary[];
  excluded: PredictionBrierExclusionCounts;
}

export interface PredictionBrierOverallSummary extends PredictionBrierMetricSummary {
  activeOperatorCount: number;
}

export interface PredictionBrierMetricSummary {
  scoredVerdictCount: number;
  distinctTaskCount: number;
  meanBrierSpread: number | null;
  meanSolverBrier: number | null;
  meanConsensusBrier: number | null;
}

export interface PredictionBrierOperatorSummary extends PredictionBrierMetricSummary {
  key: string;
  participantSafeAddress: string | null;
  participantAgentEoa: string | null;
}

export interface PredictionBrierHarnessSummary extends PredictionBrierMetricSummary {
  key: string;
  implName: string | null;
  implVersion: string | null;
  runtimeBundleDigest: string | null;
}

export interface PredictionBrierPluginSummary extends PredictionBrierMetricSummary {
  key: string;
  plugin: string;
}

export interface PredictionBrierWeeklySummary extends PredictionBrierOverallSummary {
  weekStartGeneratedAt: number;
  weekStartIso: string;
}

export interface PredictionBrierExclusionCounts {
  totalInputRows: number;
  includedRows: number;
  nonPredictionVerdictRows: number;
  nonScoredVerdictRows: number;
  missingScoreRows: number;
  nonNumericScoreRows: number;
  outsideWindowRows: number;
}

interface ScoreablePredictionBrierRow {
  projection: EnvelopeProjection;
  attributionProjection: EnvelopeProjection;
  solverBrier: number;
  consensusBrier: number;
  brierSpread: number;
  taskKey: string;
  operatorKey: string;
  harnessKey: string;
}

type TimestampUnit = 'seconds' | 'milliseconds';

export function aggregatePredictionBrierScoreboard(
  projections: readonly EnvelopeProjection[],
  options: PredictionBrierScoreboardOptions = {},
): PredictionBrierScoreboard {
  const trailingWindowDays = options.trailingWindowDays
    ?? DEFAULT_PREDICTION_BRIER_SCOREBOARD_WINDOW_DAYS;
  const excluded: PredictionBrierExclusionCounts = {
    totalInputRows: projections.length,
    includedRows: 0,
    nonPredictionVerdictRows: 0,
    nonScoredVerdictRows: 0,
    missingScoreRows: 0,
    nonNumericScoreRows: 0,
    outsideWindowRows: 0,
  };
  const candidates: ScoreablePredictionBrierRow[] = [];
  const solutionProjectionByRef = indexSolutionProjections(projections);

  for (const projection of projections) {
    const parsed = parseScoreableProjection(projection, solutionProjectionByRef, excluded);
    if (parsed) candidates.push(parsed);
  }

  const asOfGeneratedAt = options.asOfGeneratedAt ?? maxGeneratedAt(candidates.map((row) => row.projection));
  const windowStartGeneratedAt = asOfGeneratedAt === null
    ? null
    : asOfGeneratedAt - generatedAtSpanForDays(asOfGeneratedAt, trailingWindowDays);

  const included = windowStartGeneratedAt === null || asOfGeneratedAt === null
    ? []
    : candidates.filter((row) => {
        const insideWindow = row.projection.generatedAt >= windowStartGeneratedAt
          && row.projection.generatedAt <= asOfGeneratedAt;
        if (!insideWindow) excluded.outsideWindowRows += 1;
        return insideWindow;
      });

  excluded.includedRows = included.length;

  return {
    asOfGeneratedAt,
    windowStartGeneratedAt,
    trailingWindowDays,
    overall: summarizeOverall(included),
    weeklyTrend: summarizeWeeklyTrend(included),
    perOperator: summarizeByOperator(included),
    perHarness: summarizeByHarness(included),
    perPlugin: summarizeByPlugin(included),
    excluded,
  };
}

function parseScoreableProjection(
  projection: EnvelopeProjection,
  solutionProjectionByRef: ReadonlyMap<string, EnvelopeProjection>,
  excluded: PredictionBrierExclusionCounts,
): ScoreablePredictionBrierRow | null {
  if (projection.solverType !== 'prediction.v1' || projection.role !== 'verdict') {
    excluded.nonPredictionVerdictRows += 1;
    return null;
  }
  if (projection.metadata['verdict'] !== 'SCORED') {
    excluded.nonScoredVerdictRows += 1;
    return null;
  }

  const solverBrier = parseRequiredFiniteNumber(projection.metadata['scores.solverBrier']);
  const consensusBrier = parseRequiredFiniteNumber(projection.metadata['scores.consensusBrier']);
  const brierSpread = parseRequiredFiniteNumber(projection.metadata['scores.brierSpread']);
  if (solverBrier.kind === 'missing' || consensusBrier.kind === 'missing' || brierSpread.kind === 'missing') {
    excluded.missingScoreRows += 1;
    return null;
  }
  if (solverBrier.kind === 'non-numeric' || consensusBrier.kind === 'non-numeric' || brierSpread.kind === 'non-numeric') {
    excluded.nonNumericScoreRows += 1;
    return null;
  }

  const attributionProjection = solutionAttributionProjection(projection, solutionProjectionByRef);

  return {
    projection,
    attributionProjection,
    solverBrier: solverBrier.value,
    consensusBrier: consensusBrier.value,
    brierSpread: brierSpread.value,
    taskKey: taskKey(projection),
    operatorKey: operatorKey(attributionProjection),
    harnessKey: harnessKey(attributionProjection),
  };
}

function summarizeOverall(rows: readonly ScoreablePredictionBrierRow[]): PredictionBrierOverallSummary {
  return {
    ...summarizeMetrics(rows),
    activeOperatorCount: new Set(rows.map((row) => row.operatorKey)).size,
  };
}

function summarizeMetrics(rows: readonly ScoreablePredictionBrierRow[]): PredictionBrierMetricSummary {
  return {
    scoredVerdictCount: rows.length,
    distinctTaskCount: new Set(rows.map((row) => row.taskKey)).size,
    meanBrierSpread: mean(rows.map((row) => row.brierSpread)),
    meanSolverBrier: mean(rows.map((row) => row.solverBrier)),
    meanConsensusBrier: mean(rows.map((row) => row.consensusBrier)),
  };
}

function summarizeWeeklyTrend(rows: readonly ScoreablePredictionBrierRow[]): PredictionBrierWeeklySummary[] {
  const byWeek = new Map<string, ScoreablePredictionBrierRow[]>();

  for (const row of rows) {
    const bucket = weekBucket(row.projection.generatedAt);
    const existing = byWeek.get(bucket.key) ?? [];
    existing.push(row);
    byWeek.set(bucket.key, existing);
  }

  return [...byWeek.entries()]
    .map(([key, bucketRows]) => {
      const generatedAt = Number(key);
      return {
        weekStartGeneratedAt: generatedAt,
        weekStartIso: generatedAtIso(generatedAt),
        ...summarizeOverall(bucketRows),
      };
    })
    .sort((a, b) => a.weekStartGeneratedAt - b.weekStartGeneratedAt);
}

function summarizeByOperator(rows: readonly ScoreablePredictionBrierRow[]): PredictionBrierOperatorSummary[] {
  return summarizeGroups(
    rows,
    (row) => row.operatorKey,
    (key, groupRows) => ({
      key,
      participantSafeAddress: firstPresent(groupRows.map((row) => row.attributionProjection.participantSafeAddress)),
      participantAgentEoa: firstPresent(groupRows.map((row) => row.attributionProjection.participantAgentEoa)),
    }),
  );
}

function summarizeByHarness(rows: readonly ScoreablePredictionBrierRow[]): PredictionBrierHarnessSummary[] {
  return summarizeGroups(
    rows,
    (row) => row.harnessKey,
    (key, groupRows) => ({
      key,
      implName: firstPresent(groupRows.map((row) => row.attributionProjection.executorImplName)),
      implVersion: firstPresent(groupRows.map((row) => row.attributionProjection.executorImplVersion)),
      runtimeBundleDigest: firstPresent(groupRows.map((row) => row.attributionProjection.executorRuntimeBundleDigest)),
    }),
  );
}

function summarizeByPlugin(rows: readonly ScoreablePredictionBrierRow[]): PredictionBrierPluginSummary[] {
  const expanded: Array<{ row: ScoreablePredictionBrierRow; plugin: string }> = [];
  for (const row of rows) {
    for (const plugin of new Set(row.attributionProjection.executorPlugins)) {
      expanded.push({ row, plugin });
    }
  }

  return summarizeGroups(
    expanded,
    (entry) => entry.plugin,
    (key) => ({ key, plugin: key }),
    (entry) => entry.row,
  );
}

function summarizeGroups<T, M extends object>(
  entries: readonly T[],
  keyOf: (entry: T) => string,
  metadataOf: (key: string, groupRows: ScoreablePredictionBrierRow[]) => M,
  rowOf: (entry: T) => ScoreablePredictionBrierRow = (entry) => entry as ScoreablePredictionBrierRow,
): Array<PredictionBrierMetricSummary & { key: string } & M> {
  const groups = new Map<string, ScoreablePredictionBrierRow[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const existing = groups.get(key) ?? [];
    existing.push(rowOf(entry));
    groups.set(key, existing);
  }

  return [...groups.entries()]
    .map(([key, groupRows]) => ({
      key,
      ...metadataOf(key, groupRows),
      ...summarizeMetrics(groupRows),
    }))
    .sort(groupSummarySort);
}

function groupSummarySort(a: PredictionBrierMetricSummary & { key: string }, b: PredictionBrierMetricSummary & { key: string }): number {
  if (b.scoredVerdictCount !== a.scoredVerdictCount) return b.scoredVerdictCount - a.scoredVerdictCount;
  const aSpread = a.meanBrierSpread ?? Number.POSITIVE_INFINITY;
  const bSpread = b.meanBrierSpread ?? Number.POSITIVE_INFINITY;
  if (aSpread !== bSpread) return aSpread - bSpread;
  return a.key.localeCompare(b.key);
}

type ParsedScore =
  | { kind: 'ok'; value: number }
  | { kind: 'missing' }
  | { kind: 'non-numeric' };

function parseRequiredFiniteNumber(value: unknown): ParsedScore {
  if (value === undefined || value === null || value === '') return { kind: 'missing' };
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return { kind: 'non-numeric' };
  return { kind: 'ok', value: parsed };
}

function indexSolutionProjections(projections: readonly EnvelopeProjection[]): Map<string, EnvelopeProjection> {
  const byRef = new Map<string, EnvelopeProjection>();

  for (const projection of projections) {
    if (
      projection.solverType !== 'prediction.v1' ||
      normalizeEnvelopeRole(projection.role) !== 'solution'
    ) continue;
    for (const ref of solutionProjectionRefs(projection)) {
      if (!byRef.has(ref)) byRef.set(ref, projection);
    }
  }

  return byRef;
}

function solutionAttributionProjection(
  verdictProjection: EnvelopeProjection,
  solutionProjectionByRef: ReadonlyMap<string, EnvelopeProjection>,
): EnvelopeProjection {
  for (const ref of verdictSolutionRefs(verdictProjection)) {
    const solutionProjection = solutionProjectionByRef.get(ref);
    if (solutionProjection) return solutionProjection;
  }
  return verdictProjection;
}

function solutionProjectionRefs(projection: EnvelopeProjection): string[] {
  return compactRefs([
    projection.envelopeCid,
    projection.envelopeSha256,
    projection.envelopeId,
    projection.signatureHash,
  ]);
}

function verdictSolutionRefs(projection: EnvelopeProjection): string[] {
  return compactRefs([
    projection.solutionEnvelopeCid,
    projection.solutionEnvelopeSha256,
    projection.solutionEnvelopeRef,
    projection.metadata['solutionEnvelope.cid'],
    projection.metadata['solutionEnvelope.sha256'],
  ]);
}

function compactRefs(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function taskKey(projection: EnvelopeProjection): string {
  if (projection.taskCid) return `taskCid:${projection.taskCid}`;
  if (projection.taskId) return `taskId:${projection.taskId}`;
  return `unknown-task:${projection.envelopeId}`;
}

function operatorKey(projection: EnvelopeProjection): string {
  if (projection.participantSafeAddress) return `safe:${projection.participantSafeAddress.toLowerCase()}`;
  if (projection.participantAgentEoa) return `agent:${projection.participantAgentEoa.toLowerCase()}`;
  return 'unknown-operator';
}

function harnessKey(projection: EnvelopeProjection): string {
  return [
    projection.executorImplName ?? 'unknown-harness',
    projection.executorImplVersion ?? 'unknown-version',
    projection.executorRuntimeBundleDigest ?? 'unknown-runtime',
  ].join('@');
}

function firstPresent(values: ReadonlyArray<string | null>): string | null {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
}

function maxGeneratedAt(projections: readonly EnvelopeProjection[]): number | null {
  if (projections.length === 0) return null;
  return Math.max(...projections.map((projection) => projection.generatedAt));
}

function generatedAtSpanForDays(asOfGeneratedAt: number, days: number): number {
  const unit = timestampUnit(asOfGeneratedAt);
  const daySpan = unit === 'milliseconds' ? 86_400_000 : 86_400;
  return days * daySpan;
}

function weekBucket(generatedAt: number): { key: string } {
  const unit = timestampUnit(generatedAt);
  const date = generatedAtDate(generatedAt);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  date.setUTCHours(0, 0, 0, 0);
  const weekStart = unit === 'milliseconds' ? date.getTime() : Math.floor(date.getTime() / 1000);
  return { key: String(weekStart) };
}

function generatedAtIso(generatedAt: number): string {
  return generatedAtDate(generatedAt).toISOString();
}

function generatedAtDate(generatedAt: number): Date {
  return timestampUnit(generatedAt) === 'milliseconds'
    ? new Date(generatedAt)
    : new Date(generatedAt * 1000);
}

function timestampUnit(generatedAt: number): TimestampUnit {
  return Math.abs(generatedAt) >= 10_000_000_000 ? 'milliseconds' : 'seconds';
}
