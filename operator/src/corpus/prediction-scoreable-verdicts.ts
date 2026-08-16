import type { Store } from '../store/store.js';
import type { EnvelopeProjection, EnvelopeProjectionQuery } from './types.js';

export type ScoreablePredictionBrierVerdictQuery = Omit<
  EnvelopeProjectionQuery,
  'solverType' | 'role' | 'metadata'
>;

export function queryScoreablePredictionBrierVerdicts(
  store: Pick<Store, 'queryEnvelopeProjections'>,
  query: ScoreablePredictionBrierVerdictQuery = {},
): EnvelopeProjection[] {
  const { limit, ...projectionQuery } = query;
  const scoreable = store.queryEnvelopeProjections({
    ...projectionQuery,
    limit: 1000,
    solverType: 'prediction.v1',
    role: 'verdict',
    metadata: { verdict: 'SCORED' },
  }).filter(hasBrierScoreMetadata);

  if (limit === undefined) return scoreable;
  return scoreable.slice(0, Math.max(0, limit));
}

function hasBrierScoreMetadata(projection: EnvelopeProjection): boolean {
  return hasStringMetadata(projection, 'scores.solverBrier')
    && hasStringMetadata(projection, 'scores.consensusBrier')
    && hasStringMetadata(projection, 'scores.brierSpread');
}

function hasStringMetadata(projection: EnvelopeProjection, key: string): boolean {
  const value = projection.metadata[key];
  return typeof value === 'string' && value.length > 0;
}
