import type { Store } from '../store/store.js';
import type { EnvelopeProjection, EnvelopeProjectionQuery } from './types.js';
import {
  DEFAULT_PREDICTION_BRIER_SCOREBOARD_WINDOW_DAYS,
  aggregatePredictionBrierScoreboard,
  type PredictionBrierMetricSummary,
  type PredictionBrierScoreboard,
  type PredictionBrierScoreboardOptions,
} from './prediction-brier-scoreboard.js';

export const DEFAULT_PREDICTION_SCOREBOARD_REPORT_PATH =
  'docs/superpowers/reports/prediction-solvernet-scoreboard.md';

export interface PredictionBrierScoreboardProjectionQuery extends Pick<
  EnvelopeProjectionQuery,
  'generatedAfter' | 'generatedBefore' | 'limit'
> {}

export interface BuildPredictionBrierScoreboardOptions extends PredictionBrierScoreboardOptions {
  projectionQuery?: PredictionBrierScoreboardProjectionQuery;
}

export interface PredictionBrierScoreboardMarkdownOptions {
  title?: string;
  generatedAtIso?: string;
  staleAfterDays?: number;
}

export function queryPredictionBrierScoreboardProjections(
  store: Pick<Store, 'queryEnvelopeProjections'>,
  query: PredictionBrierScoreboardProjectionQuery = {},
): EnvelopeProjection[] {
  const verdicts = store.queryEnvelopeProjections({
    solverType: 'prediction.v1',
    role: 'verdict',
    generatedAfter: query.generatedAfter,
    generatedBefore: query.generatedBefore,
    limit: query.limit ?? 1000,
  });
  const solutionRefs = compactRefs(verdicts.flatMap(verdictSolutionRefs));
  if (solutionRefs.length === 0) return verdicts;

  const solutions = store.queryEnvelopeProjections({
    envelopeRefs: solutionRefs,
    solverType: 'prediction.v1',
    role: 'solution',
    limit: solutionRefs.length,
  });
  return dedupeProjections([...verdicts, ...solutions]);
}

export function buildPredictionBrierScoreboard(
  store: Pick<Store, 'queryEnvelopeProjections'>,
  options: BuildPredictionBrierScoreboardOptions = {},
): PredictionBrierScoreboard {
  const projectionQuery = windowedProjectionQuery(options);
  return aggregatePredictionBrierScoreboard(
    queryPredictionBrierScoreboardProjections(store, projectionQuery),
    options,
  );
}

export function renderPredictionBrierScoreboardMarkdown(
  scoreboard: PredictionBrierScoreboard,
  options: PredictionBrierScoreboardMarkdownOptions = {},
): string {
  const title = options.title ?? 'Prediction SolverNet Scoreboard';
  const generatedAtIso = options.generatedAtIso ?? new Date().toISOString();
  const status = scoreboardStatus(scoreboard, generatedAtIso, options.staleAfterDays ?? 14);
  const lines: string[] = [
    `# ${title}`,
    '',
    `Generated: ${generatedAtIso}`,
    `Status: ${status}`,
    `Window: trailing ${scoreboard.trailingWindowDays} days ending ${formatGeneratedAt(scoreboard.asOfGeneratedAt)}`,
    '',
    '## Headline',
    '',
  ];

  if (scoreboard.overall.scoredVerdictCount === 0) {
    lines.push(
      'Insufficient scoreable Verdict data. The report will populate after Prediction SolverNet evaluators emit `SCORED` Verdict envelopes with Brier metadata.',
      '',
    );
  }

  lines.push(
    '| Metric | Value |',
    '|---|---:|',
    `| Mean Brier spread | ${formatNumber(scoreboard.overall.meanBrierSpread)} |`,
    `| Mean solver Brier | ${formatNumber(scoreboard.overall.meanSolverBrier)} |`,
    `| Mean consensus Brier | ${formatNumber(scoreboard.overall.meanConsensusBrier)} |`,
    `| Scored Verdicts | ${scoreboard.overall.scoredVerdictCount} |`,
    `| Shared Tasks | ${scoreboard.overall.distinctTaskCount} |`,
    `| Active operators | ${scoreboard.overall.activeOperatorCount} |`,
    '',
    '## Weekly Trend',
    '',
    metricTable(
      ['Week', 'Scored Verdicts', 'Mean Spread', 'Solver Brier', 'Consensus Brier', 'Tasks', 'Operators'],
      scoreboard.weeklyTrend.map((summary) => [
        summary.weekStartIso.slice(0, 10),
        String(summary.scoredVerdictCount),
        formatNumber(summary.meanBrierSpread),
        formatNumber(summary.meanSolverBrier),
        formatNumber(summary.meanConsensusBrier),
        String(summary.distinctTaskCount),
        String(summary.activeOperatorCount),
      ]),
      'No weekly trend data yet.',
    ),
    '',
    '## Operators',
    '',
    metricTable(
      ['Operator', 'Scored Verdicts', 'Mean Spread', 'Solver Brier', 'Consensus Brier', 'Tasks'],
      scoreboard.perOperator.map((summary) => [
        summary.participantSafeAddress ?? summary.participantAgentEoa ?? summary.key,
        String(summary.scoredVerdictCount),
        formatNumber(summary.meanBrierSpread),
        formatNumber(summary.meanSolverBrier),
        formatNumber(summary.meanConsensusBrier),
        String(summary.distinctTaskCount),
      ]),
      'No operator rows yet.',
    ),
    '',
    '## Harnesses',
    '',
    metricTable(
      ['Harness', 'Runtime Digest', 'Scored Verdicts', 'Mean Spread', 'Tasks'],
      scoreboard.perHarness.map((summary) => [
        [summary.implName ?? 'unknown', summary.implVersion ?? 'unknown'].join('@'),
        summary.runtimeBundleDigest ?? 'unknown',
        String(summary.scoredVerdictCount),
        formatNumber(summary.meanBrierSpread),
        String(summary.distinctTaskCount),
      ]),
      'No Harness rows yet.',
    ),
    '',
    '## Plugins',
    '',
    metricTable(
      ['Plugin', 'Scored Verdicts', 'Mean Spread', 'Tasks'],
      scoreboard.perPlugin.map((summary) => [
        summary.plugin,
        String(summary.scoredVerdictCount),
        formatNumber(summary.meanBrierSpread),
        String(summary.distinctTaskCount),
      ]),
      'No plugin rows yet.',
    ),
    '',
    '## Exclusions',
    '',
    '| Reason | Count |',
    '|---|---:|',
    `| Total input rows | ${scoreboard.excluded.totalInputRows} |`,
    `| Included score rows | ${scoreboard.excluded.includedRows} |`,
    `| Non-prediction/non-Verdict rows | ${scoreboard.excluded.nonPredictionVerdictRows} |`,
    `| Non-SCORED Verdict rows | ${scoreboard.excluded.nonScoredVerdictRows} |`,
    `| Missing score rows | ${scoreboard.excluded.missingScoreRows} |`,
    `| Non-numeric score rows | ${scoreboard.excluded.nonNumericScoreRows} |`,
    `| Outside trailing window | ${scoreboard.excluded.outsideWindowRows} |`,
  );

  return `${lines.join('\n')}\n`;
}

function windowedProjectionQuery(
  options: BuildPredictionBrierScoreboardOptions,
): PredictionBrierScoreboardProjectionQuery {
  const projectionQuery = options.projectionQuery ?? {};
  if (options.asOfGeneratedAt === undefined) return projectionQuery;

  const trailingWindowDays = options.trailingWindowDays
    ?? DEFAULT_PREDICTION_BRIER_SCOREBOARD_WINDOW_DAYS;
  return {
    ...projectionQuery,
    generatedAfter: projectionQuery.generatedAfter
      ?? options.asOfGeneratedAt - generatedAtSpanForDays(options.asOfGeneratedAt, trailingWindowDays),
    generatedBefore: projectionQuery.generatedBefore ?? options.asOfGeneratedAt,
  };
}

function generatedAtSpanForDays(asOfGeneratedAt: number, days: number): number {
  const daySpan = Math.abs(asOfGeneratedAt) >= 10_000_000_000 ? 86_400_000 : 86_400;
  return days * daySpan;
}

function verdictSolutionRefs(projection: EnvelopeProjection): string[] {
  return [
    projection.solutionEnvelopeCid,
    projection.solutionEnvelopeSha256,
    projection.solutionEnvelopeRef,
    projection.metadata['solutionEnvelope.cid'],
    projection.metadata['solutionEnvelope.sha256'],
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function compactRefs(refs: readonly string[]): string[] {
  return [...new Set(refs)];
}

function dedupeProjections(projections: readonly EnvelopeProjection[]): EnvelopeProjection[] {
  const byId = new Map<string, EnvelopeProjection>();
  for (const projection of projections) byId.set(projection.envelopeId, projection);
  return [...byId.values()];
}

function metricTable(headers: string[], rows: string[][], emptyText: string): string {
  if (rows.length === 0) return emptyText;
  const alignment = headers.map((_, index) => (index === 0 ? '---' : '---:')).join('|');
  const rendered = [
    `| ${headers.map(escapeTableCell).join(' | ')} |`,
    `|${alignment}|`,
  ];
  for (const row of rows) {
    rendered.push(`| ${row.map(escapeTableCell).join(' | ')} |`);
  }
  return rendered.join('\n');
}

function scoreboardStatus(
  scoreboard: PredictionBrierScoreboard,
  generatedAtIso: string,
  staleAfterDays: number,
): string {
  if (scoreboard.overall.scoredVerdictCount === 0) return 'INSUFFICIENT_DATA';
  if (scoreboard.asOfGeneratedAt === null) return 'INSUFFICIENT_DATA';

  const generatedAtMs = Date.parse(generatedAtIso);
  if (!Number.isFinite(generatedAtMs)) return 'OK';
  const asOfMs = generatedAtToMs(scoreboard.asOfGeneratedAt);
  const staleAfterMs = staleAfterDays * 86_400_000;
  if (generatedAtMs - asOfMs > staleAfterMs) return `STALE (latest scored Verdict older than ${staleAfterDays} days)`;
  return 'OK';
}

function formatGeneratedAt(generatedAt: number | null): string {
  if (generatedAt === null) return '-';
  return new Date(generatedAtToMs(generatedAt)).toISOString();
}

function generatedAtToMs(generatedAt: number): number {
  return Math.abs(generatedAt) >= 10_000_000_000 ? generatedAt : generatedAt * 1000;
}

function formatNumber(value: PredictionBrierMetricSummary['meanBrierSpread']): string {
  return value === null ? '-' : value.toFixed(6);
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}
