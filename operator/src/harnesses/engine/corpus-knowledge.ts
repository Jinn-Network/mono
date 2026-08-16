/**
 * Corpus knowledge autoload (#1393).
 *
 * Pure retrieval + ranking: query the corpus for prior *solution* records of
 * the given solverType and shape the top few into a payload the engine can
 * inject into task.context.corpusKnowledge before harness spawn.
 *
 * Reuses handleSearchRecords (operator/src/mcp/search-records.ts) so the result
 * set is exactly what the MCP tools would return: local envelope projections,
 * locally served/cached artifact rows, and (when a corpus is configured)
 * network manifests. Works corpus-null — the store-only path is the e2e
 * configuration and the mainnet default until an indexer is wired.
 *
 * Contract: loadCorpusKnowledge NEVER throws and is bounded by timeoutMs.
 * On failure or timeout it logs one warning and returns null — corpus
 * problems must never block the claim/solve path (AC3 of #1393).
 *
 * RecordSummary.scoreMetadata is passed through verbatim as the future
 * verdict-aware ranking seam (#1396).
 */

import {
  handleSearchRecords,
  type ArtifactDescriptor,
  type ReadOnlyCorpus,
  type RecordSummary,
  type SearchRecordsResult,
} from '../../mcp/search-records.js';
import type { Store } from '../../store/store.js';

export interface CorpusKnowledgeArtifactRef {
  sha256: string;
  artifactType: string;
  /** Self-describing acquisition recipe: MCP acquire_artifact arguments. */
  acquisition?: ArtifactDescriptor['acquisition'];
}

export interface CorpusKnowledgeRecordRef {
  recordRef: string;
  envelopeCid: string;
  evidenceTier: string;
  generatedAt?: number;
  artifacts: CorpusKnowledgeArtifactRef[];
  /** Score/verdict fields surfaced by search (seam for #1396). */
  scoreMetadata?: Record<string, unknown>;
}

export interface CorpusKnowledgePayload {
  version: 1;
  solverType: string;
  retrievedAt: number;
  guidance: string;
  records: CorpusKnowledgeRecordRef[];
}

export interface LoadCorpusKnowledgeOptions {
  corpus: ReadOnlyCorpus | null;
  store: Store;
  solverType: string;
  /** Records to inject. Default 3. */
  limit?: number;
  /**
   * Records to fetch (and rank) before slicing to `limit`. Default 200 —
   * large enough that an active solverType's older attested/committed
   * records aren't truncated out of the ranking pool by recency alone
   * (#1393 review finding 2). Also bounds queryEnvelopeProjections (cap
   * 1000) and the local served/cached artifact join (cap 500).
   */
  searchLimit?: number;
  /** Hard bound on the whole lookup. Default 10_000 ms. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const CORPUS_KNOWLEDGE_GUIDANCE =
  'Prior solution records for this solverType, ranked by evidence tier then recency. '
  + 'Full artifact content is acquirable via the MCP tools: inspect_record (pass the '
  + 'envelopeCid) and acquire_artifact (pass each artifact\'s acquisition arguments).';

const DEFAULT_SEARCH_LIMIT = 200;

const TIER_WEIGHT: Record<string, number> = {
  attested: 3,
  committed: 2,
  'self-signed': 1,
  unknown: 1,
};

function tierWeight(record: RecordSummary): number {
  return TIER_WEIGHT[record.envelopeRef?.evidenceTier ?? 'unknown'] ?? 1;
}

function recency(record: RecordSummary): number {
  return record.generatedAt ?? record.envelopeRef?.publishedAt ?? 0;
}

/** Reconstruct a payload from already-resolved record refs (#1393 review
 * finding 3 — RUNNING retries/recovery re-drives reuse this instead of
 * re-querying the corpus). */
export function buildCorpusKnowledgePayload(
  solverType: string,
  records: CorpusKnowledgeRecordRef[],
): CorpusKnowledgePayload {
  return {
    version: 1,
    solverType,
    retrievedAt: Date.now(),
    guidance: CORPUS_KNOWLEDGE_GUIDANCE,
    records,
  };
}

function artifactRefFromRow(row: {
  sha256: string;
  artifactType: string;
  source: 'served' | 'network';
  sourceEndpoint?: string | null;
  paidAmountUsdc?: string;
}): CorpusKnowledgeArtifactRef {
  const ref: CorpusKnowledgeArtifactRef = { sha256: row.sha256, artifactType: row.artifactType };
  if (row.source === 'network' && row.sourceEndpoint) {
    ref.acquisition = {
      tool: 'acquire_artifact',
      arguments: {
        sha256: row.sha256,
        access: { endpoint: row.sourceEndpoint, priceUsdc: row.paidAmountUsdc ?? '0' },
        artifactType: row.artifactType,
      },
    };
  }
  return ref;
}

/**
 * Search with a store-only fallback (#1393 review finding 4). A hung or
 * failing network corpus must not deny local knowledge that IS available.
 *
 * ReadOnlyCorpus.query() takes no AbortSignal, so a timed-out corpus.query
 * call cannot be cancelled — it keeps running in the background until it
 * settles on its own. We attach real (no-op-on-arrival) resolve/reject
 * handlers to it via `.then` rather than leaving it a bare `Promise.race`
 * loser, so Node never reports it as an unhandled rejection and it never
 * produces a second, duplicate log line when it eventually settles.
 */
async function searchWithTimeoutAndFallback(
  corpus: ReadOnlyCorpus | null,
  store: Store,
  solverType: string,
  searchLimit: number,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<SearchRecordsResult | null> {
  const args = { solverType, role: 'solution' as const, limit: searchLimit };
  try {
    return await withTimeout(handleSearchRecords(corpus, store, args), timeoutMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!corpus) {
      log(`[corpus-knowledge] lookup failed for solverType=${solverType}: ${reason}`);
      return null;
    }
    log(
      `[corpus-knowledge] network corpus failed for solverType=${solverType} (${reason}); `
      + 'falling back to store-only knowledge',
    );
    try {
      // corpus: null skips the network branch inside handleSearchRecords
      // entirely, so this retry is local-only and cannot itself hang.
      return await handleSearchRecords(null, store, args);
    } catch (fallbackErr) {
      log(
        `[corpus-knowledge] store-only fallback also failed for solverType=${solverType}: `
        + `${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
      );
      return null;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`corpus knowledge lookup timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function loadCorpusKnowledge(
  opts: LoadCorpusKnowledgeOptions,
): Promise<CorpusKnowledgePayload | null> {
  const limit = opts.limit ?? 3;
  const searchLimit = opts.searchLimit ?? DEFAULT_SEARCH_LIMIT;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const log = opts.log ?? ((msg: string) => console.warn(msg));

  try {
    const result = await searchWithTimeoutAndFallback(
      opts.corpus,
      opts.store,
      opts.solverType,
      searchLimit,
      timeoutMs,
      log,
    );
    if (!result) return null;

    // Index artifact refs by envelopeCid across ALL returned records: local
    // served/cached rows carry the sha256s but no solverType/role; projection
    // records carry solverType/role/tier but no artifact refs. The join key
    // is the envelope CID (backfilled onto served_artifacts by pack()).
    const artifactsByCid = new Map<string, CorpusKnowledgeArtifactRef[]>();
    for (const record of result.records) {
      const cid = record.envelopeRef?.cid;
      if (!cid) continue;
      for (const artifact of record.artifactRefs) {
        const list = artifactsByCid.get(cid) ?? [];
        if (!list.some((existing) => existing.sha256 === artifact.sha256)) {
          list.push({
            sha256: artifact.sha256,
            artifactType: artifact.artifactType,
            ...(artifact.acquisition ? { acquisition: artifact.acquisition } : {}),
          });
        }
        artifactsByCid.set(cid, list);
      }
    }

    // Candidates: solution records for this solverType with an envelope CID
    // (no CID → nothing to dedupe on or reference downstream). First record
    // per CID wins (projection ordering puts local knowledge first).
    const byCid = new Map<string, RecordSummary>();
    for (const record of result.records) {
      const cid = record.envelopeRef?.cid;
      if (!cid) continue;
      if (record.solverType !== opts.solverType) continue;
      if (record.role !== 'solution') continue;
      if (!byCid.has(cid)) byCid.set(cid, record);
    }

    const ranked = [...byCid.entries()]
      .sort(([, a], [, b]) => {
        const tierDelta = tierWeight(b) - tierWeight(a);
        if (tierDelta !== 0) return tierDelta;
        return recency(b) - recency(a);
      })
      .slice(0, limit);

    if (ranked.length === 0) return null;

    // Backfill artifact refs for exactly the ranked CIDs by a direct,
    // non-windowed store lookup (#1393 review finding 2). The `local` join
    // inside handleSearchRecords only covers the searchLimit most-recent
    // served/cached rows of ANY type — on a real store, a top-ranked record's
    // artifact can fall outside that window even though it's a top-3 result.
    // This backfill is deterministic regardless of store size because it's
    // scoped to the few (≤limit) CIDs we're actually about to inject.
    const rankedCids = ranked.map(([cid]) => cid);
    for (const row of opts.store.getArtifactsByEnvelopeCids(rankedCids)) {
      const cid = row.envelopeCid;
      if (!cid) continue;
      const list = artifactsByCid.get(cid) ?? [];
      if (!list.some((existing) => existing.sha256 === row.sha256)) {
        list.push(artifactRefFromRow(row));
      }
      artifactsByCid.set(cid, list);
    }

    return buildCorpusKnowledgePayload(
      opts.solverType,
      ranked.map(([cid, record]) => ({
        recordRef: record.recordRef,
        envelopeCid: cid,
        evidenceTier: record.envelopeRef?.evidenceTier ?? 'unknown',
        ...(record.generatedAt !== undefined ? { generatedAt: record.generatedAt } : {}),
        artifacts: artifactsByCid.get(cid) ?? [],
        ...(record.scoreMetadata ? { scoreMetadata: record.scoreMetadata } : {}),
      })),
    );
  } catch (err) {
    log(
      `[corpus-knowledge] lookup failed for solverType=${opts.solverType}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
