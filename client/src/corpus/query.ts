/**
 * Subgraph GraphQL query for the corpus.
 *
 * v0: query Execution rows; filter by evidenceTier, participant, time window
 * directly on the subgraph; filter by `solverType` post-fetch since the
 * subgraph's Execution.kind is the router-level ENVELOPE/EVALUATION discriminator,
 * not the per-SolverType string.
 *
 * Spec §2.3 step 1, §10 Q6.
 */

import type { CorpusQuery, EnvelopeRef } from './types.js';
import { CorpusQueryError } from './types.js';

const HARD_LIMIT = 500;
const DEFAULT_LIMIT = 50;

const QUERY_GQL = `
  query CorpusExecutions(
    $first: Int!,
    $tier: ExecutionTier,
    $publishedAfter: BigInt,
    $publishedBefore: BigInt,
    $operatorWallet: Bytes,
  ) {
    executions(
      first: $first,
      where: {
        tier: $tier,
        publishedAt_gte: $publishedAfter,
        publishedAt_lte: $publishedBefore,
        operator_: { agentWallet: $operatorWallet },
      },
      orderBy: publishedAt,
      orderDirection: desc,
    ) {
      id
      manifestCid
      manifestHash
      tier
      publishedAt
      operator {
        id
        agentId
        owner
        agentWallet
      }
    }
  }
`;

export interface BuiltQuery {
  query: string;
  variables: Record<string, unknown>;
}

const TIER_TO_GQL: Record<NonNullable<CorpusQuery['evidenceTier']>, string> = {
  'self-signed': 'SELF_SIGNED',
  'committed': 'COMMITTED',
  'attested': 'ATTESTED',
};

const TIER_FROM_GQL: Record<string, EnvelopeRef['evidenceTier']> = {
  SELF_SIGNED: 'self-signed',
  COMMITTED: 'committed',
  ATTESTED: 'attested',
  UNKNOWN: 'unknown',
};

export function buildSubgraphQuery(q: CorpusQuery): BuiltQuery {
  const first = Math.min(Math.max(1, q.limit ?? DEFAULT_LIMIT), HARD_LIMIT);
  const variables: Record<string, unknown> = {
    first,
    tier: q.evidenceTier ? TIER_TO_GQL[q.evidenceTier] : null,
    publishedAfter: q.generatedAfter !== undefined ? String(q.generatedAfter) : null,
    publishedBefore: q.generatedBefore !== undefined ? String(q.generatedBefore) : null,
    operatorWallet: q.participant?.safeAddress ?? null,
    solverType: null, // post-fetch filter; spec §10 Q6.
  };
  return { query: QUERY_GQL, variables };
}

interface SubgraphResponse {
  data?: {
    executions: Array<{
      id: string;
      manifestCid: string;
      manifestHash: string;
      tier: string;
      publishedAt: string;
      operator: { id: string; agentId: string; owner: string; agentWallet: string | null };
    }>;
  };
  errors?: Array<{ message: string }>;
}

export async function runCorpusQuery(
  subgraphUrl: string,
  q: CorpusQuery,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<EnvelopeRef[]> {
  const built = buildSubgraphQuery(q);
  let response: Response;
  try {
    response = await fetchImpl(subgraphUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(built),
    });
  } catch (err) {
    throw new CorpusQueryError(`subgraph fetch failed`, err);
  }
  if (!response.ok) {
    throw new CorpusQueryError(`subgraph HTTP ${response.status}`);
  }
  let body: SubgraphResponse;
  try {
    body = (await response.json()) as SubgraphResponse;
  } catch (err) {
    throw new CorpusQueryError(`subgraph returned non-JSON body`, err);
  }
  if (body.errors && body.errors.length > 0) {
    throw new CorpusQueryError(`subgraph errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  const rows = body.data?.executions ?? [];
  return rows.map((r) => ({
    manifestCid: r.manifestCid,
    manifestHash: r.manifestHash,
    operator: {
      agentId: r.operator.agentId,
      safeAddress: r.operator.agentWallet ?? r.operator.owner,
    },
    evidenceTier: TIER_FROM_GQL[r.tier] ?? 'unknown',
    publishedAt: Number(r.publishedAt),
  }));
}
