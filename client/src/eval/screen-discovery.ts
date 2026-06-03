/**
 * Held-out screening's authoritative "already trained-on" exclusion source (#986).
 *
 * Returns the set of swe-rebench-v2 `instance_id`s that have been ATTEMPTED on
 * the network for a SolverNet — any verdict envelope, passed OR failed,
 * cross-operator. An attempted instance was executed by an operator, so the
 * learner trained on it; holding it out later would make a trained-checkpoint
 * pass count as memorization, not generalization.
 *
 * Why the indexer and not the local generator-state: the local ledger only
 * reflects THIS box's posting and can be stale (a different active generator —
 * e.g. a hosted operator — posts to its own ledger). The indexer's
 * `verdictEnvelopeMeta` is the cross-operator, current record. (The on-chain
 * task/attempt tables carry no instance_id; only the indexer's IPFS enrichment
 * resolves it — same backing as `DiscoveryAPI.getInstanceSuccessCounts`, minus
 * the `actualPassed: true` filter so failed attempts count too.)
 *
 * Throws on indexer failure — callers MUST abort rather than screen against an
 * unknown attempted set, because a missing exclusion can silently contaminate
 * the exam (the whole point of held-out discipline).
 */

const ATTEMPTED_QUERY = `
query InstanceAttempted($cid: String!, $limit: Int!, $after: String) {
  verdictEnvelopeMetas(
    where: {
      solverNetManifestCid: $cid,
      solverType_starts_with: "swe-rebench-v2",
      enrichmentStatus: "ok",
      instanceId_not: ""
    },
    limit: $limit,
    after: $after,
    orderBy: "enrichedAtBlock",
    orderDirection: "asc"
  ) {
    items { instanceId }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface AttemptedPage {
  data?: {
    verdictEnvelopeMetas?: {
      items?: { instanceId: string }[];
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: unknown;
}

export async function fetchAttemptedInstanceIds(
  discoveryUrl: string,
  manifestCid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const gqlUrl = discoveryUrl.endsWith('/graphql') ? discoveryUrl : `${discoveryUrl.replace(/\/$/, '')}/graphql`;
  const ids = new Set<string>();
  let cursor: string | null = null;
  const MAX_PAGES = 20;
  const PAGE_LIMIT = 1000;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: ATTEMPTED_QUERY, variables: { cid: manifestCid, limit: PAGE_LIMIT, after: cursor } }),
    });
    if (!res.ok) {
      throw new Error(`held-out screening: indexer attempted-ids query failed (HTTP ${res.status}) at ${gqlUrl}`);
    }
    const json = (await res.json()) as AttemptedPage;
    if (json.errors) {
      throw new Error(`held-out screening: indexer attempted-ids query errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
    }
    const conn = json.data?.verdictEnvelopeMetas;
    for (const item of conn?.items ?? []) {
      if (item.instanceId) ids.add(item.instanceId);
    }
    const pageInfo = conn?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  return ids;
}
