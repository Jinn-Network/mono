/**
 * Corpus library entry point.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §2.
 */

import type {
  Corpus,
  CorpusOptions,
} from './types.js';
import {
  createCorpus as createCoreCorpus,
  fetchFromIpfs as fetchFromIpfsCore,
} from '@jinn-network/core/corpus-read';
import { runOnchainCorpusQuery } from './onchain-query.js';
import type { AcquireResult } from './fetch-artifact.js';
import { SignedEnvelopeSchema, type SignedEnvelope } from '../types/envelope.js';

export type {
  Corpus,
  CorpusOptions,
  CorpusQuery,
  EnvelopeRef,
  ManifestPreview,
  Envelope,
  ArtifactContent,
  ReadArgs,
  RouteResolver,
} from './types.js';
export { CorpusQueryError, ManifestFetchError, AcquireError, HashMismatchError } from './types.js';
export { noopRouteResolver } from './route-resolver.js';
export { getCachedArtifact, hasCachedArtifact } from './cache.js';
export {
  queryScoreablePredictionBrierVerdicts,
  type ScoreablePredictionBrierVerdictQuery,
} from './prediction-scoreable-verdicts.js';
export {
  DEFAULT_PREDICTION_BRIER_SCOREBOARD_WINDOW_DAYS,
  aggregatePredictionBrierScoreboard,
  type PredictionBrierExclusionCounts,
  type PredictionBrierHarnessSummary,
  type PredictionBrierMetricSummary,
  type PredictionBrierOperatorSummary,
  type PredictionBrierOverallSummary,
  type PredictionBrierPluginSummary,
  type PredictionBrierScoreboard,
  type PredictionBrierScoreboardOptions,
  type PredictionBrierWeeklySummary,
} from './prediction-brier-scoreboard.js';
export {
  DEFAULT_PREDICTION_SCOREBOARD_REPORT_PATH,
  buildPredictionBrierScoreboard,
  queryPredictionBrierScoreboardProjections,
  renderPredictionBrierScoreboardMarkdown,
  type BuildPredictionBrierScoreboardOptions,
  type PredictionBrierScoreboardMarkdownOptions,
  type PredictionBrierScoreboardProjectionQuery,
} from './prediction-brier-scoreboard-report.js';

interface InternalDeps {
  fetchFromIpfs?: (gatewayUrl: string, cid: string) => Promise<unknown>;
  acquireFn?: (endpoint: string, sha256: string, privateKey?: string) => Promise<Buffer | null | AcquireResult>;
}

export function createCorpus(opts: CorpusOptions, deps: InternalDeps = {}): Corpus {
  return createCoreCorpus<SignedEnvelope>(
    {
      ipfsGatewayUrl: opts.ipfsGatewayUrl,
      store: opts.store,
      signer: opts.signer,
      selfSafeAddress: opts.selfSafeAddress,
      routeResolver: opts.routeResolver,
      discovery: opts.discovery,
      ...(opts.onchain
        ? { legacyQuery: (query) => runOnchainCorpusQuery(query, opts.onchain!) }
        : {}),
      parseEnvelope(input) {
        return SignedEnvelopeSchema.parse(input);
      },
    },
    {
      fetchFromIpfs: deps.fetchFromIpfs ?? fetchFromIpfsCore,
      acquireFn: deps.acquireFn,
    },
  );
}
