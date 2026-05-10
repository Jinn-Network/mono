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
  const variables: Record<string, unknown> = { first };
  const variableDefs = ['$first: Int!'];
  const where: string[] = [];

  if (q.evidenceTier) {
    variableDefs.push('$tier: ExecutionTier');
    variables.tier = TIER_TO_GQL[q.evidenceTier];
    where.push('tier: $tier');
  }
  if (q.generatedAfter !== undefined) {
    variableDefs.push('$publishedAfter: BigInt');
    variables.publishedAfter = String(q.generatedAfter);
    where.push('publishedAt_gte: $publishedAfter');
  }
  if (q.generatedBefore !== undefined) {
    variableDefs.push('$publishedBefore: BigInt');
    variables.publishedBefore = String(q.generatedBefore);
    where.push('publishedAt_lte: $publishedBefore');
  }
  if (q.participant?.safeAddress) {
    variableDefs.push('$operatorWallet: Bytes');
    variables.operatorWallet = q.participant.safeAddress;
    where.push('operator_: { agentWallet: $operatorWallet }');
  }

  const whereClause = where.length > 0 ? `where: { ${where.join(', ')} },` : '';
  const query = `
    query CorpusExecutions(${variableDefs.join(', ')}) {
      executions(
        first: $first,
        ${whereClause}
        orderBy: publishedAt,
        orderDirection: desc
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
  return { query, variables };
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
