/**
 * Corpus library entry point.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §2.
 */

import type {
  Corpus,
  CorpusOptions,
  CorpusQuery,
  EnvelopeRef,
  ManifestPreview,
  Envelope,
  ArtifactContent,
  ReadArgs,
} from './types.js';
import { runCorpusQuery } from './query.js';
import { runOnchainCorpusQuery } from './onchain-query.js';
import { fetchManifest } from './fetch.js';
import { acquireArtifactContent } from './acquire.js';
import type { ArtifactSource } from '../types/envelope.js';

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
  fetch?: typeof globalThis.fetch;
  fetchFromIpfs?: (gatewayUrl: string, cid: string) => Promise<unknown>;
  acquireFn?: (endpoint: string, sha256: string, privateKey: string) => Promise<Buffer | null>;
}

export function createCorpus(opts: CorpusOptions, deps: InternalDeps = {}): Corpus {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const fetchFromIpfsImpl = deps.fetchFromIpfs;
  const acquireFn = deps.acquireFn;

  async function query(q: CorpusQuery): Promise<EnvelopeRef[]> {
    const refs: EnvelopeRef[] = [];
    const warnings: string[] = [];
    let successfulSources = 0;
    if (opts.subgraphUrl) {
      try {
        refs.push(...await runCorpusQuery(opts.subgraphUrl, q, fetchImpl));
        successfulSources += 1;
      } catch (err) {
        warnings.push(`subgraph: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (opts.onchain) {
      try {
        refs.push(...await runOnchainCorpusQuery(q, opts.onchain));
        successfulSources += 1;
      } catch (err) {
        warnings.push(`onchain: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const deduped = new Map<string, EnvelopeRef>();
    for (const ref of refs) {
      if (!deduped.has(ref.manifestCid)) deduped.set(ref.manifestCid, ref);
    }
    if (deduped.size === 0 && warnings.length > 0 && successfulSources === 0) {
      throw new Error(`corpus query failed: ${warnings.join('; ')}`);
    }
    return [...deduped.values()];
  }

  async function fetchOne(ref: EnvelopeRef): Promise<ManifestPreview> {
    return fetchManifest(ref, opts.ipfsGatewayUrl, fetchFromIpfsImpl);
  }

  async function acquire(manifest: ManifestPreview): Promise<Envelope> {
    const contents = new Map<string, ArtifactContent>();
    for (const a of manifest.envelope.artifacts) {
      const ac = await acquireArtifactContent({
        sha256: a.sha256,
        artifactType: a.artifactType,
        access: a.access,
        store: opts.store,
        selfSafeAddress: opts.selfSafeAddress,
        privateKey: opts.signer.privateKey,
        routeResolver: opts.routeResolver,
        envelopeCid: manifest.ref.manifestCid,
        sources: a.sources,
        ipfsGatewayUrl: opts.ipfsGatewayUrl,
        ownerSafe: manifest.envelope.participant.safeAddress,
        acquireFn,
        fetchFromIpfs: fetchFromIpfsImpl,
      });
      contents.set(a.sha256, ac);
    }
    return { ref: manifest.ref, envelope: manifest.envelope, artifactContents: contents };
  }

  async function acquireBySha256(
    sha256: string,
    access: { endpoint: string; priceUsdc: string },
    hint?: { artifactType?: string; envelopeCid?: string; sources?: ArtifactSource[]; ownerSafe?: string },
  ): Promise<ArtifactContent> {
    return acquireArtifactContent({
      sha256,
      artifactType: hint?.artifactType ?? 'unknown',
      access,
      store: opts.store,
      selfSafeAddress: opts.selfSafeAddress,
      privateKey: opts.signer.privateKey,
      routeResolver: opts.routeResolver,
      envelopeCid: hint?.envelopeCid,
      sources: hint?.sources,
      ipfsGatewayUrl: opts.ipfsGatewayUrl,
      ownerSafe: hint?.ownerSafe,
      acquireFn,
      fetchFromIpfs: fetchFromIpfsImpl,
    });
  }

  async function read(args: ReadArgs): Promise<Envelope[]> {
    const refs = await query(args.query);
    const previews: ManifestPreview[] = [];
    for (const ref of refs) {
      previews.push(await fetchOne(ref));
    }
    // Post-fetch solverType filter.
    const kindFilter = args.query.solverType;
    const kindFiltered = kindFilter ? previews.filter((p) => p.envelope.solverType === kindFilter) : previews;
    const selected = args.select ? args.select(kindFiltered) : kindFiltered;
    const envelopes: Envelope[] = [];
    for (const sel of selected) {
      envelopes.push(await acquire(sel));
    }
    return envelopes;
  }

  return {
    read,
    query,
    fetchManifest: fetchOne,
    acquire,
    acquireBySha256,
  };
}
