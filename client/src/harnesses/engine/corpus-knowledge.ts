/**
 * Corpus knowledge autoload (#1393).
 *
 * Pure retrieval + ranking: query the corpus for prior *solution* records of
 * the given solverType and shape the top few into a payload the engine can
 * inject into task.context.corpusKnowledge before harness spawn.
 *
 * Reuses handleSearchRecords (client/src/mcp/search-records.ts) so the result
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
  /** Records to fetch before ranking. Default 12. */
  searchLimit?: number;
  /** Hard bound on the whole lookup. Default 10_000 ms. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export const CORPUS_KNOWLEDGE_GUIDANCE =
  'Prior solution records for this solverType, ranked by evidence tier then recency. '
  + 'Full artifact content is acquirable via the MCP tools: inspect_record (pass the '
  + 'envelopeCid) and acquire_artifact (pass each artifact\'s acquisition arguments).';

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

export async function loadCorpusKnowledge(
  opts: LoadCorpusKnowledgeOptions,
): Promise<CorpusKnowledgePayload | null> {
  const limit = opts.limit ?? 3;
  const searchLimit = opts.searchLimit ?? 12;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const log = opts.log ?? ((msg: string) => console.warn(msg));

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`corpus knowledge lookup timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const result = await Promise.race([
      handleSearchRecords(opts.corpus, opts.store, {
        solverType: opts.solverType,
        role: 'solution',
        limit: searchLimit,
      }),
      timeout,
    ]);

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

    return {
      version: 1,
      solverType: opts.solverType,
      retrievedAt: Date.now(),
      guidance: CORPUS_KNOWLEDGE_GUIDANCE,
      records: ranked.map(([cid, record]) => ({
        recordRef: record.recordRef,
        envelopeCid: cid,
        evidenceTier: record.envelopeRef?.evidenceTier ?? 'unknown',
        ...(record.generatedAt !== undefined ? { generatedAt: record.generatedAt } : {}),
        artifacts: artifactsByCid.get(cid) ?? [],
        ...(record.scoreMetadata ? { scoreMetadata: record.scoreMetadata } : {}),
      })),
    };
  } catch (err) {
    log(
      `[corpus-knowledge] lookup failed for solverType=${opts.solverType}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
