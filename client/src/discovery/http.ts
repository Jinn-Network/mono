/**
 * HTTP-backed `DiscoveryAPI` implementation that talks GraphQL to a Ponder
 * indexer at a configured URL. Sibling to `onchain.ts` which talks RPC
 * directly.
 *
 * Moved from `packages/indexer/src/api/discovery-adapter.ts` into the daemon
 * source tree as part of jinn-mono-280n.4. The indexer package is now purely
 * server-side (schema + handlers + Ponder runtime); this file is the
 * daemon-side client that consumes that GraphQL endpoint.
 *
 * Any GraphQL errors or network failures wrap into DiscoveryUnavailableError
 * so the daemon's withFallback chain can engage the OnchainDiscoveryAPI floor.
 *
 * Spec: spec/2026-05-11-discovery-api-and-shared-indexer.md §6.1.
 */
import type {
  DiscoveryAPI,
  ClaimableTaskCandidate,
  SolverNetManifestSummary,
  SolverNetLifecycleStatus,
  EnvelopeRef,
  CorpusQuery,
  PluginPublication,
  PluginScoreHistoryRow,
  PublishedArtifact,
} from './types.js';
import { DiscoveryUnavailableError } from './types.js';
import { manifestDigestForCid } from '../adapters/mech/digest.js';

// ── GraphQL query strings ─────────────────────────────────────────────────────

/**
 * Claimable tasks query. Fetches task rows in pages; attempt counts are
 * retrieved in a single batched round-trip via ATTEMPTS_FOR_TASKS_QUERY
 * (note the plural form) after each page is fetched.
 *
 * NOTE: The GraphQL field names match ponder.schema.ts column names (camelCase
 * as exposed by Ponder's auto-generated GraphQL layer).
 *
 * claimWindowStart/claimWindowEnd are queried but may be null (see schema note).
 * The daemon's canClaimTask simulation is the correctness gate at claim time.
 */
const TASKS_QUERY = `
query Tasks(
  $manifestDigest: String!,
  $limit: Int!,
  $offset: Int!
) {
  tasks(
    where: {
      manifestDigest: $manifestDigest,
      finalized: false,
      refunded: false
    },
    limit: $limit,
    offset: $offset,
    orderBy: "id",
    orderDirection: "asc"
  ) {
    items {
      id
      taskCidDigest
      manifestDigest
      createdAtBlock
      createdAtTx
      claimWindowEnd
      maxClaims
      chainId
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

/**
 * Batched attempt fetch for a page of tasks.
 *
 * Ponder's auto-generated GraphQL exposes `_in` filter operators on indexed
 * text columns. The `attempt.taskId` column has an `index` directive in
 * ponder.schema.ts which satisfies Ponder 0.16.x's prerequisite for `_in`
 * support. This single query replaces the N per-task queries that were causing
 * an N+1 round-trip problem (at pageSize=100, that was 100 serial requests).
 *
 * Ponder caps plural-query `limit` at 1000, so this is paginated with the
 * `after` cursor — the caller loops until `pageInfo.hasNextPage` is false.
 * Client-side grouping by taskId produces per-task counts.
 */
const ATTEMPTS_PAGE_LIMIT = 1000;

/**
 * Hard cap on `OPERATOR_COUNT_TASKS_QUERY` pages (leg 1 of the operator-count
 * query). At `ATTEMPTS_PAGE_LIMIT` rows per page that is 50_000 tasks — far
 * beyond any realistic SolverNet — and bounds the scan so the dashboard's
 * recurring poll cannot trigger an unbounded walk. On a SolverNet past the cap
 * the resulting count is a lower bound; see `getSolverNetOperatorCount`.
 */
const MAX_OPERATOR_COUNT_TASK_PAGES = 50;

const ATTEMPTS_FOR_TASKS_QUERY = `
query AttemptsForTasks($taskIds: [String!]!, $chainId: Int!, $limit: Int!, $after: String) {
  attempts(
    where: { taskId_in: $taskIds, chainId: $chainId },
    limit: $limit,
    after: $after,
    orderBy: "attemptIndex",
    orderDirection: "asc"
  ) {
    items {
      taskId
      operator
      attemptIndex
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

// NOTE on the `where` filter pattern: Ponder's GraphQL treats a `null` value
// for a `where` field as "field IS NULL" (not "skip this filter"), and a `null`
// value for a `_in` operator as a SQL error. So every optional filter must be
// constructed dynamically in JS — include the key only when it has a value —
// and passed as a single typed `$where` variable. Passing individual nullable
// scalar variables into a literal `where: { ... }` block is a bug.

const LIST_SOLVER_NETS_QUERY = `
query ListSolverNets($where: solverNetManifestFilter, $limit: Int!) {
  solverNetManifests(
    where: $where,
    limit: $limit,
    orderBy: "anchorBlock",
    orderDirection: "desc"
  ) {
    items {
      id
      launcherAgentId
      status
      statusUpdatedAt
      manifestHash
      anchorBlock
      chainId
    }
  }
}
`;

const GET_LIFECYCLE_STATUS_QUERY = `
query GetLifecycleStatus($manifestCid: String!) {
  solverNetManifest(id: $manifestCid) {
    status
    statusUpdatedAt
    anchorBlock
    manifestHash
  }
}
`;

/**
 * Per-SolverNet attempt fetch for the operator-count query. Pages through every
 * `attempt` row whose `taskId` belongs to a task with the given
 * `manifestDigest`. The caller de-duplicates `operator` client-side to derive
 * the distinct-operator count.
 *
 * There is no single GraphQL field joining `attempt` to `task.manifestDigest`,
 * so this runs in two legs: first `OPERATOR_COUNT_TASKS_QUERY` (task ids for
 * the digest), then `OPERATOR_COUNT_ATTEMPTS_QUERY` batched over those ids via
 * the `_in` operator — the same pattern `findClaimableTasks` already uses.
 *
 * The task query intentionally does NOT filter `finalized` / `refunded`: the
 * on-chain backing reads raw `TaskAttemptCreated` logs and cannot see lifecycle
 * state, so adding the filter here would make HTTP and on-chain disagree. The
 * count is an *ever-participated* signal across all task lifecycle states — see
 * `DiscoveryAPI.getSolverNetOperatorCount`.
 */
const OPERATOR_COUNT_TASKS_QUERY = `
query OperatorCountTasks($manifestDigest: String!, $limit: Int!, $after: String) {
  tasks(
    where: { manifestDigest: $manifestDigest },
    limit: $limit,
    after: $after,
    orderBy: "id",
    orderDirection: "asc"
  ) {
    items {
      id
      chainId
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const OPERATOR_COUNT_ATTEMPTS_QUERY = `
query OperatorCountAttempts($taskIds: [String!]!, $chainId: Int!, $limit: Int!, $after: String) {
  attempts(
    where: { taskId_in: $taskIds, chainId: $chainId },
    limit: $limit,
    after: $after,
    orderBy: "attemptIndex",
    orderDirection: "asc"
  ) {
    items {
      operator
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

/**
 * Paginated read of verdictEnvelopeMeta rows for swe-rebench-v2 successes.
 *
 * Ponder's auto-GraphQL does not expose GROUP BY / count aggregations, so the
 * aggregator (below in getInstanceSuccessCounts) pages this query with the
 * `after` cursor and groups client-side. Capped at 1000 per page (Ponder's
 * upper bound on plural-query `limit`).
 *
 * The `solverType_starts_with` filter is GraphQL-syntactic — verify it
 * matches the Ponder generated filter shape; if Ponder requires the explicit
 * suffix (`solverType: { startsWith: "..." }`) shape, adjust accordingly when
 * the test fails. As of jinn-mono today the Ponder GraphQL layer accepts
 * `solverType_starts_with: "swe-rebench-v2"` directly.
 */
const INSTANCE_SUCCESS_COUNTS_QUERY = `
query InstanceSuccessCounts($limit: Int!, $after: String) {
  verdictEnvelopeMetas(
    where: {
      solverType_starts_with: "swe-rebench-v2",
      actualPassed: true,
      enrichmentStatus: "ok",
      instanceId_not: ""
    },
    limit: $limit,
    after: $after,
    orderBy: "enrichedAtBlock",
    orderDirection: "asc"
  ) {
    items {
      requestId
      chainId
      instanceId
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const QUERY_ENVELOPES_QUERY = `
query QueryEnvelopes($where: envelopeFilter, $limit: Int!) {
  envelopes(
    where: $where,
    limit: $limit,
    orderBy: "publishedAtBlock",
    orderDirection: "desc"
  ) {
    items {
      agentId
      manifestCid
      manifestHash
      evidenceTier
      publishedAtBlock
    }
  }
}
`;

// ── GraphQL response types ────────────────────────────────────────────────────

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface TaskRow {
  id: string;
  taskCidDigest: string;
  manifestDigest: string;
  createdAtBlock?: string | number | null;
  createdAtTx?: string | null;
  claimWindowEnd?: string | number | null;
  maxClaims?: number | null;
  chainId: number;
}

interface AttemptRow {
  /** taskId is only present in the batched ATTEMPTS_FOR_TASKS_QUERY response. */
  taskId: string;
  operator: string;
  attemptIndex: number;
}

interface TasksPage {
  tasks: {
    items: TaskRow[];
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface AttemptsPage {
  attempts: {
    items: AttemptRow[];
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface SolverNetRow {
  id: string;
  launcherAgentId: string;
  status: string;
  statusUpdatedAt: string;
  manifestHash: string;
  anchorBlock: string | number;
  chainId: number;
}

interface SolverNetPage {
  solverNetManifests: { items: SolverNetRow[] };
}

interface SolverNetSingle {
  solverNetManifest: {
    status: string;
    statusUpdatedAt: string;
    anchorBlock: string | number;
    manifestHash?: string | null;
  } | null;
}

interface EnvelopeRow {
  agentId: string;
  manifestCid: string;
  manifestHash: string;
  evidenceTier: string;
  publishedAtBlock: string | number;
}

interface EnvelopePage {
  envelopes: { items: EnvelopeRow[] };
}

// ── Operator-count query response types (issue #351) ─────────────────────────

interface OperatorCountTasksPage {
  tasks: {
    items: Array<{ id: string; chainId: number }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface OperatorCountAttemptsPage {
  attempts: {
    items: Array<{ operator: string }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface InstanceSuccessCountsPage {
  verdictEnvelopeMetas: {
    items: Array<{ requestId: string; chainId: number; instanceId: string }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

// ── Plug-in publication queries (attd) ───────────────────────────────────────

const LIST_PLUGIN_PUBLICATIONS_QUERY = `
query ListPluginPublications($where: pluginPublicationFilter, $limit: Int!) {
  pluginPublications(
    where: $where,
    limit: $limit,
    orderBy: "blockNumber",
    orderDirection: "desc"
  ) {
    items {
      id
      builderAgentId
      pluginCid
      pluginName
      pluginVersion
      pluginSha256
      supports
      publishedAt
      revoked
      revokedReason
    }
  }
}
`;

const GET_PLUGIN_SCORES_QUERY = `
query GetPluginScores($pluginCid: String!, $limit: Int!) {
  attemptEnvelopeMetas(
    where: { pluginsContains: $pluginCid },
    limit: $limit,
    orderBy: "enrichedAtBlock",
    orderDirection: "desc"
  ) {
    items {
      requestId
      manifestCid
      pluginsJson
      enrichedAtBlock
    }
  }
}
`;

interface PluginPublicationRow {
  id: string;
  builderAgentId: string;
  pluginCid: string;
  pluginName: string;
  pluginVersion: string;
  pluginSha256: string;
  supports: string[];
  publishedAt: string | number;
  revoked: boolean;
  revokedReason: string | null;
}

interface PluginPublicationsPage {
  pluginPublications: { items: PluginPublicationRow[] };
}

// ── Client options ────────────────────────────────────────────────────────────

export interface HttpDiscoveryAPIOptions {
  /** URL of the Ponder GraphQL endpoint, e.g. http://localhost:42069/graphql */
  url: string;
  /**
   * Custom fetch implementation. Defaults to globalThis.fetch.
   * Pass a mock in tests to assert request shapes.
   */
  fetchImpl?: typeof fetch;
  /**
   * TTL (ms) for the cached `/ready` probe result. Defaults to
   * READY_PROBE_TTL_MS — short enough that a sync catch-up is noticed quickly,
   * long enough that the probe isn't issued on every single discovery call.
   * Exposed mostly for tests.
   */
  readyProbeTtlMs?: number;
}

/**
 * How long a `/ready` probe result is trusted before re-probing. Ponder's
 * `/ready` flips to 200 once the indexer has caught up to realtime; before that
 * GraphQL still serves 200 with stale/empty data, so the daemon must consult
 * `/ready` rather than the GraphQL status code. 20s keeps the latency to notice
 * a sync stall low without hammering the endpoint.
 */
const READY_PROBE_TTL_MS = 20_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseOptionalNumber(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function isHex(value: string | undefined): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value);
}

async function postGql<T>(
  url: string,
  fetchImpl: typeof fetch,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new DiscoveryUnavailableError(`Ponder GraphQL network error: ${String(err)}`, err);
  }

  if (!response.ok) {
    throw new DiscoveryUnavailableError(
      `Ponder GraphQL HTTP ${response.status} ${response.statusText}`,
    );
  }

  let json: GqlResponse<T>;
  try {
    json = await response.json() as GqlResponse<T>;
  } catch (err) {
    throw new DiscoveryUnavailableError(`Ponder GraphQL response parse error: ${String(err)}`, err);
  }

  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message ?? 'unknown').join('; ');
    throw new DiscoveryUnavailableError(`Ponder GraphQL error: ${msg}`);
  }

  if (!json.data) {
    throw new DiscoveryUnavailableError('Ponder GraphQL response missing data field');
  }

  return json.data;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a DiscoveryAPI backed by a Ponder GraphQL endpoint.
 *
 * Usage:
 *
 *   import { createHttpDiscoveryAPI } from './discovery/http.js';
 *   const discovery = createHttpDiscoveryAPI({ url: 'https://my-indexer.example/graphql' });
 *   const tasks = await discovery.findClaimableTasks({ ... });
 */
export function createHttpDiscoveryAPI(opts: HttpDiscoveryAPIOptions): DiscoveryAPI {
  const gqlUrl = opts.url.endsWith('/graphql') ? opts.url : `${opts.url}/graphql`;
  // Ponder's `/ready` lives at the host root, not under `/graphql`.
  const readyUrl = `${opts.url.replace(/\/graphql\/?$/, '').replace(/\/$/, '')}/ready`;
  const readyTtlMs = opts.readyProbeTtlMs ?? READY_PROBE_TTL_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  if (!fetchImpl) {
    throw new Error('No fetch implementation available; pass fetchImpl in options');
  }

  // ── /ready probe (memoized with a short TTL) ──────────────────────────────
  // Ponder serves GraphQL with 200 + stale/empty data while still catching up;
  // `/ready` returns non-200 until it is at realtime. The daemon's fallback
  // chain only routes to the on-chain floor on a *thrown* error, so we turn an
  // unready indexer into a DiscoveryUnavailableError rather than silently
  // returning cold-sync emptiness. Memoized so it isn't probed on every call.
  let readyCache: { at: number; ok: boolean; status: number } | null = null;

  async function ensureReady(): Promise<void> {
    const now = Date.now();
    if (readyCache && now - readyCache.at < readyTtlMs) {
      if (!readyCache.ok) {
        throw new DiscoveryUnavailableError(`indexer not ready: ${readyCache.status}`);
      }
      return;
    }
    let res: Response;
    try {
      res = await fetchImpl(readyUrl, { method: 'GET' });
    } catch (err) {
      readyCache = { at: now, ok: false, status: 0 };
      throw new DiscoveryUnavailableError(`indexer /ready probe failed: ${String(err)}`, err);
    }
    readyCache = { at: now, ok: res.ok, status: res.status };
    if (!res.ok) {
      throw new DiscoveryUnavailableError(`indexer not ready: ${res.status}`);
    }
  }

  // ── findClaimableTasks ────────────────────────────────────────────────────

  async function findClaimableTasks(args: {
    solverNetManifestCids: string[];
    operatorAddress: `0x${string}`;
    nowSeconds?: number;
    pageSize?: number;
    maxPages?: number;
  }): Promise<ClaimableTaskCandidate[]> {
    const { keccak256, toBytes } = await import('viem');
    const cids = Array.from(new Set(args.solverNetManifestCids.filter(Boolean)));
    if (cids.length === 0) return [];

    await ensureReady();

    const pageSize = Math.min(200, Math.max(1, args.pageSize ?? 100));
    const maxPages = Math.max(1, args.maxPages ?? 5);
    const operatorLower = args.operatorAddress.toLowerCase();
    const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
    const seen = new Set<string>();

    // Per-CID buckets. We must not flatten + global-sort by taskId across CIDs
    // — that lets a backlogged SolverNet monopolise the per-tick yield in the
    // adapter (which yields one announcement per cycle), starving siblings.
    // Each bucket holds its CID's candidates in lowest-taskId-first order (the
    // TASKS_QUERY already orders ASC by id, so the page-merged list is also
    // ASC). After collection we interleave the buckets round-robin.
    const buckets: ClaimableTaskCandidate[][] = [];

    for (const cid of cids) {
      const manifestDigest = keccak256(toBytes(cid));
      const bucket: ClaimableTaskCandidate[] = [];

      for (let page = 0; page < maxPages; page++) {
        const data = await postGql<TasksPage>(
          gqlUrl,
          fetchImpl,
          TASKS_QUERY,
          { manifestDigest, limit: pageSize, offset: page * pageSize },
        );

        const rows = data.tasks?.items ?? [];

        // Validate and de-duplicate rows before batch fetching attempts.
        const validRows = rows.filter((row) => {
          if (seen.has(row.id)) return false;
          if (!isHex(row.taskCidDigest) || !isHex(row.manifestDigest)) return false;
          return true;
        });

        // Group attempt counts by taskId from the batched response.
        const attemptCountByTaskId = new Map<string, number>();
        const operatorAttemptCountByTaskId = new Map<string, number>();

        if (validRows.length > 0) {
          // Batch-fetch all attempts for this page of tasks. This replaces the
          // previous N+1 pattern (one query per task) with one query per page,
          // paginated with the `after` cursor because Ponder caps plural-query
          // `limit` at 1000 (a larger literal `limit` is a GraphQL validation
          // error). ATTEMPTS_FOR_TASKS_QUERY uses the `taskId_in` filter which
          // Ponder 0.16.x supports on indexed text columns.
          //
          // A genuine failure here is NOT swallowed: postGql throws
          // DiscoveryUnavailableError, which propagates so withFallback engages
          // the on-chain floor. Silently zeroing the counts would make the
          // indexer-side pre-filter a no-op while looking like it works.
          const taskIds = validRows.map((r) => r.id);

          // All rows in a page share the same chainId (single-chain query), so
          // take chainId from the first valid row.
          const pageChainId = validRows[0].chainId;

          let after: string | null = null;
          // Hard page cap: taskIds.length attempts of pages of 1000 is far more
          // than any realistic claim window; the cap just bounds a pathological
          // cursor loop.
          for (let attemptsPage = 0; attemptsPage < taskIds.length + 1; attemptsPage++) {
            const attData: AttemptsPage = await postGql<AttemptsPage>(
              gqlUrl,
              fetchImpl,
              ATTEMPTS_FOR_TASKS_QUERY,
              { taskIds, chainId: pageChainId, limit: ATTEMPTS_PAGE_LIMIT, after },
            );
            for (const a of attData.attempts?.items ?? []) {
              attemptCountByTaskId.set(a.taskId, (attemptCountByTaskId.get(a.taskId) ?? 0) + 1);
              if (a.operator.toLowerCase() === operatorLower) {
                operatorAttemptCountByTaskId.set(
                  a.taskId,
                  (operatorAttemptCountByTaskId.get(a.taskId) ?? 0) + 1,
                );
              }
            }
            const pageInfo = attData.attempts?.pageInfo;
            if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
            after = pageInfo.endCursor;
          }
        }

        for (const row of validRows) {
          const attemptCount = attemptCountByTaskId.get(row.id) ?? 0;
          const operatorAttemptCount = operatorAttemptCountByTaskId.get(row.id) ?? 0;

          // maxClaims gate: skip if task is fully claimed.
          const maxClaims = typeof row.maxClaims === 'number' && row.maxClaims > 0
            ? row.maxClaims
            : undefined;
          if (maxClaims !== undefined && attemptCount >= maxClaims) continue;

          // claimWindowEnd gate (if available): skip expired tasks.
          const claimWindowEnd = parseOptionalNumber(row.claimWindowEnd);
          if (claimWindowEnd !== undefined && claimWindowEnd < now) continue;

          seen.add(row.id);

          const candidate: ClaimableTaskCandidate = {
            taskId: row.id,
            taskCidDigest: row.taskCidDigest as `0x${string}`,
            manifestDigest: row.manifestDigest as `0x${string}`,
            attemptCount,
            operatorAttemptCount,
          };

          const createdAtBlock = parseOptionalNumber(row.createdAtBlock);
          if (createdAtBlock !== undefined) candidate.createdAtBlock = createdAtBlock;
          if (isHex(row.createdAtTx ?? undefined)) candidate.createdAtTx = row.createdAtTx as `0x${string}`;
          if (claimWindowEnd !== undefined) candidate.claimWindowEnd = claimWindowEnd;
          if (maxClaims !== undefined) candidate.maxClaims = maxClaims;

          bucket.push(candidate);
        }

        const hasNextPage = data.tasks?.pageInfo?.hasNextPage ?? (rows.length === pageSize);
        if (!hasNextPage) break;
      }

      // Each bucket is already ASC by taskId (the GraphQL TASKS_QUERY orders
      // by id ASC and pages are appended in page order), but sort defensively
      // so the round-robin always pulls the lowest unclaimed id from each CID
      // even if upstream ordering ever changes.
      bucket.sort((a, b) => Number(BigInt(a.taskId) - BigInt(b.taskId)));
      buckets.push(bucket);
    }

    // Round-robin interleave across CID buckets: pull index 0 from each CID
    // first, then index 1 from each, etc. This guarantees that a backlog on
    // one SolverNet cannot starve a sibling SolverNet that also has claimable
    // work, because `discoverSubgraphRestorationTasks` in adapter.ts yields
    // only one announcement per poll cycle.
    const out: ClaimableTaskCandidate[] = [];
    const maxBucketLen = buckets.reduce((m, b) => Math.max(m, b.length), 0);
    for (let i = 0; i < maxBucketLen; i++) {
      for (const bucket of buckets) {
        if (i < bucket.length) out.push(bucket[i]);
      }
    }
    return out;
  }

  // ── listLaunchedSolverNets ────────────────────────────────────────────────

  async function listLaunchedSolverNets(args?: {
    launcherAgentId?: string;
    status?: Array<'launched' | 'paused' | 'retired'>;
  }): Promise<SolverNetManifestSummary[]> {
    await ensureReady();

    // Build the where object dynamically — only include filters that are set.
    // A null `status_in` is a SQL error in Ponder; a null `launcherAgentId`
    // means "IS NULL". Omit, don't nullify.
    const where: Record<string, unknown> = {};
    if (args?.status && args.status.length > 0) where['status_in'] = args.status;
    if (args?.launcherAgentId) where['launcherAgentId'] = args.launcherAgentId;

    const data = await postGql<SolverNetPage>(
      gqlUrl,
      fetchImpl,
      LIST_SOLVER_NETS_QUERY,
      { where, limit: 200 },
    );

    return (data.solverNetManifests?.items ?? []).map((row): SolverNetManifestSummary => ({
      manifestCid: row.id,
      // The 8 fields below are IPFS-only: not stored in the indexer. Populate
      // with the same sentinels used by OnchainDiscoveryAPI.listLaunchedSolverNets
      // in client/src/discovery/onchain.ts. Consumers enrich via IPFS fetch.
      solverNetId: row.id,                                          // best-effort: cid as id
      name: '',                                                      // requires IPFS fetch
      network: '',                                                   // requires IPFS fetch
      launcherSafeAddress: '0x0000000000000000000000000000000000000000', // requires IPFS fetch
      contractId: '',                                                // requires IPFS fetch
      contractVersion: '',                                           // requires IPFS fetch
      solutionPriceWei: '0',                                        // requires IPFS fetch
      verdictPriceWei: '0',                                         // requires IPFS fetch
      openRoles: [],                                                 // requires IPFS fetch
      launcherAgentId: row.launcherAgentId,
      status: (row.status as 'launched' | 'paused' | 'retired') ?? 'launched',
      statusUpdatedAt: row.statusUpdatedAt,
      anchorBlock: Number(row.anchorBlock),
    }));
  }

  // ── getLifecycleStatus ────────────────────────────────────────────────────

  async function getLifecycleStatus(manifestCid: string): Promise<SolverNetLifecycleStatus | undefined> {
    await ensureReady();

    const data = await postGql<SolverNetSingle>(
      gqlUrl,
      fetchImpl,
      GET_LIFECYCLE_STATUS_QUERY,
      { manifestCid },
    );

    const row = data.solverNetManifest;
    if (!row) return undefined;

    const validStatus = (s: string): s is 'launched' | 'paused' | 'retired' =>
      s === 'launched' || s === 'paused' || s === 'retired';

    return {
      status: validStatus(row.status) ? row.status : 'launched',
      statusUpdatedAt: row.statusUpdatedAt,
      sourceBlock: Number(row.anchorBlock),
      manifestHash: (typeof row.manifestHash === 'string' && /^0x[0-9a-fA-F]+$/.test(row.manifestHash)
        ? row.manifestHash
        : '0x') as `0x${string}`,
    };
  }

  // ── getSolverNetOperatorCount ─────────────────────────────────────────────

  async function getSolverNetOperatorCount(manifestCid: string): Promise<number> {
    await ensureReady();

    // The indexer keys tasks by `manifestDigest = keccak256(toBytes(cid))`,
    // not by the cid string. Compute the digest so the task filter matches.
    const manifestDigest = manifestDigestForCid(manifestCid).toLowerCase();

    // Leg 1: page every task id for this SolverNet. Single-chain query, so all
    // rows share a chainId — captured for the leg-2 attempt filter. Capped at
    // MAX_OPERATOR_COUNT_TASK_PAGES so the dashboard's recurring poll cannot
    // trigger an unbounded scan.
    const taskIds: string[] = [];
    let chainId: number | undefined;
    let taskCursor: string | null = null;
    for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
      const data: OperatorCountTasksPage = await postGql<OperatorCountTasksPage>(
        gqlUrl,
        fetchImpl,
        OPERATOR_COUNT_TASKS_QUERY,
        { manifestDigest, limit: ATTEMPTS_PAGE_LIMIT, after: taskCursor },
      );
      const items = data.tasks?.items ?? [];
      for (const row of items) {
        taskIds.push(row.id);
        if (chainId === undefined) chainId = row.chainId;
      }
      const pageInfo: OperatorCountTasksPage['tasks']['pageInfo'] = data.tasks?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      taskCursor = pageInfo.endCursor;
    }

    // No tasks → no attempts → no participating operators.
    if (taskIds.length === 0 || chainId === undefined) return 0;

    // Leg 2: page every attempt for those task ids, collecting distinct
    // operators. Batched over the id set via the `_in` operator (Ponder caps
    // plural-query limit at 1000, hence ATTEMPTS_PAGE_LIMIT paging).
    const operators = new Set<string>();
    let attemptCursor: string | null = null;
    for (;;) {
      const data: OperatorCountAttemptsPage = await postGql<OperatorCountAttemptsPage>(
        gqlUrl,
        fetchImpl,
        OPERATOR_COUNT_ATTEMPTS_QUERY,
        { taskIds, chainId, limit: ATTEMPTS_PAGE_LIMIT, after: attemptCursor },
      );
      for (const row of data.attempts?.items ?? []) {
        if (typeof row.operator === 'string' && row.operator.length > 0) {
          operators.add(row.operator.toLowerCase());
        }
      }
      const pageInfo: OperatorCountAttemptsPage['attempts']['pageInfo'] = data.attempts?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      attemptCursor = pageInfo.endCursor;
    }

    return operators.size;
  }

  // ── queryEnvelopes ────────────────────────────────────────────────────────

  async function queryEnvelopes(query: CorpusQuery): Promise<EnvelopeRef[]> {
    await ensureReady();

    const limit = Math.min(500, Math.max(1, query.limit ?? 50));

    // Build the where object dynamically — only include filters that are set.
    // A null filter value means "IS NULL" in Ponder, not "skip the filter".
    // `kind` is not part of CorpusQuery (we return all envelope kinds).
    // `query.solverType` is intentionally ignored: solverType lives in the IPFS
    // manifest body, not in the on-chain envelope payload, so the indexer has no
    // column for it. Callers must filter by solverType client-side after fetching
    // the IPFS manifests. See packages/indexer/README.md §Known limitations.
    const where: Record<string, unknown> = {};
    if (query.evidenceTier) where['evidenceTier'] = query.evidenceTier;
    if (query.manifestHash) where['manifestHash'] = query.manifestHash;

    const data = await postGql<EnvelopePage>(
      gqlUrl,
      fetchImpl,
      QUERY_ENVELOPES_QUERY,
      { where, limit },
    );

    const items = data.envelopes?.items ?? [];

    // Map to EnvelopeRef. The indexer does not store safeAddress (not in the
    // IdentityRegistry event); leave it empty. The corpus library enriches it
    // on retrieval via the IPFS manifest fetch.
    return items.map((row): EnvelopeRef => ({
      manifestCid: row.manifestCid,
      manifestHash: row.manifestHash,
      operator: {
        agentId: row.agentId,
        safeAddress: '',
      },
      evidenceTier: (row.evidenceTier as EnvelopeRef['evidenceTier']) ?? 'unknown',
      publishedAt: Number(row.publishedAtBlock),
    }));
  }

  // ── listPluginPublications (attd) ─────────────────────────────────────────

  async function listPluginPublications(args?: {
    solverType?: string;
    builderAgentId?: string;
    includeRevoked?: boolean;
    limit?: number;
  }): Promise<PluginPublication[]> {
    await ensureReady();
    const where: Record<string, unknown> = {};
    if (args?.solverType) where['supports_has'] = args.solverType;
    if (args?.builderAgentId) where['builderAgentId'] = args.builderAgentId;
    if (args?.includeRevoked === false) where['revoked'] = false;
    const limit = Math.min(500, Math.max(1, args?.limit ?? 100));

    const data = await postGql<PluginPublicationsPage>(
      gqlUrl,
      fetchImpl,
      LIST_PLUGIN_PUBLICATIONS_QUERY,
      { where, limit },
    );

    return (data.pluginPublications?.items ?? []).map((row): PluginPublication => ({
      artifactType: 'plugin',
      builderAgentId: row.builderAgentId,
      cid: row.pluginCid,
      name: row.pluginName,
      version: row.pluginVersion,
      supports: row.supports,
      publishedAt: Number(row.publishedAt),
      revoked: row.revoked,
      revokedReason: row.revokedReason ?? undefined,
      pluginSha256: (row.pluginSha256 as `0x${string}`),
    }));
  }

  // ── getPluginScores (attd) ─────────────────────────────────────────────────

  async function getPluginScores(args: {
    pluginCid: string;
    limit?: number;
  }): Promise<PluginScoreHistoryRow[]> {
    await ensureReady();
    const limit = Math.min(500, Math.max(1, args.limit ?? 100));
    try {
      const data = await postGql<{
        attemptEnvelopeMetas: {
          items: Array<{
            requestId: string;
            manifestCid: string;
            pluginsJson: string;
            enrichedAtBlock: string | number;
          }>;
        };
      }>(
        gqlUrl,
        fetchImpl,
        GET_PLUGIN_SCORES_QUERY,
        { pluginCid: args.pluginCid, limit },
      );
      // ebu7's AttemptEnvelopeMeta carries `pluginsJson` — JSON.stringify of
      // executor.plugins[]. Parse it and emit one row per matching entry; flag
      // forkSuspected when the sha256 doesn't match the publication.
      // For now, return whatever the server returns; full join with verdict +
      // pluginPublication.sha256 is a §6.5 Discovery API endpoint that lands
      // alongside the /builders/:agentId/runs Hono route. attd's read-shape
      // ships the empty-array contract; ebu7 + 6.5 flesh it in.
      return (data.attemptEnvelopeMetas?.items ?? []).flatMap((row): PluginScoreHistoryRow[] => {
        let plugins: Array<{ cid?: string; sha256: string }> = [];
        try { plugins = JSON.parse(row.pluginsJson) as typeof plugins; } catch { return []; }
        const match = plugins.find((p) => p.cid === args.pluginCid);
        if (!match) return [];
        return [{
          pluginCid: args.pluginCid,
          taskId: '',
          operatorAgentId: '',
          verdict: 'Unknown',
          ts: Number(row.enrichedAtBlock),
          forkSuspected: false,
        }];
      });
    } catch (err) {
      // attemptEnvelopeMeta entity not present (ebu7 not deployed yet) → empty.
      if (err instanceof Error && /attemptEnvelopeMetas|Unknown type|Cannot query/.test(err.message)) {
        return [];
      }
      throw err;
    }
  }

  // ── listBuilderArtifacts (attd) ────────────────────────────────────────────

  async function listBuilderArtifacts(args: {
    builderAgentId: string;
    limit?: number;
  }): Promise<PublishedArtifact[]> {
    // Today only plug-ins; the harness variant is added when Path 2 ships. We
    // satisfy the unified read by delegating to listPluginPublications.
    const plugins = await listPluginPublications({
      builderAgentId: args.builderAgentId,
      limit: args.limit,
    });
    return plugins;
  }

  // ── getInstanceSuccessCounts (#669) ────────────────────────────────────────
  // manifestCid is ignored in the GraphQL filter — see types.ts JSDoc for why.
  // It is preserved on the call-signature so a future refinement (per-manifest
  // scoping) is a non-breaking change.

  async function getInstanceSuccessCounts(_args: {
    manifestCid: string;
  }): Promise<Map<string, number>> {
    await ensureReady();

    // Cap on total rows scanned, defensive: 10 pages × 1000 = 10k rows. A
    // healthy SolverNet has ~25 candidates × N_target_successes = 125 expected
    // successes; 10k is two orders of magnitude headroom.
    const MAX_PAGES = 10;
    const PAGE_LIMIT = 1000;
    const counts = new Map<string, number>();
    const seen = new Set<string>();   // (requestId|chainId) dedupe across pages
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await postGql<InstanceSuccessCountsPage>(
        gqlUrl,
        fetchImpl,
        INSTANCE_SUCCESS_COUNTS_QUERY,
        { limit: PAGE_LIMIT, after: cursor },
      );
      const rows = data.verdictEnvelopeMetas?.items ?? [];
      for (const row of rows) {
        const key = `${row.requestId}|${row.chainId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const id = row.instanceId;
        if (!id) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const pageInfo = data.verdictEnvelopeMetas?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }

    return counts;
  }

  return {
    findClaimableTasks,
    listLaunchedSolverNets,
    getLifecycleStatus,
    getSolverNetOperatorCount,
    queryEnvelopes,
    listPluginPublications,
    getPluginScores,
    listBuilderArtifacts,
    getInstanceSuccessCounts,
  };
}
