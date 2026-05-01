/**
 * acquire_artifact MCP tool handler.
 *
 * Tries fast paths in order before falling through to the corpus:
 *   1. served_artifacts (own published bytes; free)
 *   2. network_artifacts (previously fetched + cached; touches last_used_at)
 *   3. corpus.acquireBySha256 (route-resolver, then origin x402)
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §4.2.
 */

import type { Corpus, ArtifactContent } from '../corpus/index.js';
import type { Store } from '../store/store.js';

export interface AcquireArtifactArgs {
  sha256: string;
  access: { endpoint: string; priceUsdc: string };
  envelopeCid?: string;
  artifactType?: string;
}

export async function handleAcquireArtifact(
  corpus: Pick<Corpus, 'acquireBySha256'>,
  store: Store,
  args: AcquireArtifactArgs,
): Promise<ArtifactContent> {
  const own = store.getServedArtifact(args.sha256);
  if (own) {
    return {
      sha256: args.sha256,
      bytes: own.content,
      artifactType: own.artifactType,
      source: 'self-store',
      paidAmountUsdc: '0',
      fetchedAt: own.createdAt,
    };
  }
  const cached = store.getNetworkArtifact(args.sha256);
  if (cached) {
    store.touchNetworkArtifactUsage(args.sha256, new Date().toISOString());
    return {
      sha256: args.sha256,
      bytes: cached.content,
      artifactType: cached.artifactType,
      source: 'cache',
      paidAmountUsdc: '0',
      fetchedAt: cached.fetchedAt,
      sourceOperator: cached.sourceOperator ?? undefined,
    };
  }
  return corpus.acquireBySha256(args.sha256, args.access, {
    artifactType: args.artifactType,
    envelopeCid: args.envelopeCid,
  });
}
