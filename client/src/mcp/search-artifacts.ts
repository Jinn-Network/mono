/**
 * search_artifacts MCP tool handler.
 *
 * Returns a combined view of locally available artifacts (own served + cached
 * network) plus network discovery results from the corpus. The local fast path
 * lets agents see artifacts they already have without paying for IPFS or
 * x402 fetches.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §4.
 */

import type { Corpus, CorpusQuery, EnvelopeRef } from '../corpus/index.js';
import type { Store } from '../store/store.js';

export interface SearchArtifactsResult {
  local: Array<{
    sha256: string;
    artifactType: string;
    source: 'served' | 'network';
    envelopeCid: string | null;
    createdAt: string;
  }>;
  network: EnvelopeRef[];
  warning?: string;
}

export async function handleSearchArtifacts(
  corpus: Pick<Corpus, 'query'>,
  store: Store,
  args: CorpusQuery,
): Promise<SearchArtifactsResult> {
  const local = store.searchOwnAndCached({
    artifactType: args.kind,
    limit: args.limit ?? 50,
  });
  const network = await corpus.query(args);
  return { local, network };
}

/**
 * Wrapper that handles the corpus=null fallback by returning local results
 * with a warning. Emits a `console.warn` so daemon stderr surfaces the
 * misconfiguration via runner/claude.ts:243-245 for the operator. Use this
 * from the MCP tool handler instead of branching inline.
 */
export async function handleSearchArtifactsOrLocalFallback(
  corpus: Pick<Corpus, 'query'> | null,
  store: Store,
  args: CorpusQuery,
): Promise<SearchArtifactsResult> {
  if (!corpus) {
    console.warn(
      '[mcp:search_artifacts] corpus not configured (missing JINN_CORPUS_SUBGRAPH_URL or JINN_CORPUS_IPFS_GATEWAY_URL) — local-only results',
    );
    const local = store.searchOwnAndCached({
      artifactType: args.kind,
      limit: args.limit ?? 50,
    });
    return {
      local,
      network: [],
      warning:
        'corpus not configured (missing JINN_CORPUS_SUBGRAPH_URL or JINN_CORPUS_IPFS_GATEWAY_URL); network results unavailable',
    };
  }
  return handleSearchArtifacts(corpus, store, args);
}
