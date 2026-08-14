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
  InstanceClaimCount,
  TaskStatusSnapshot,
  VerdictTallyResult,
  TaskLifecycleEvidence,
  AttemptEnvelopeCandidate,
  VerdictEnvelopeCandidate,
  SolverNetManifestSummary,
  SolverNetLifecycleStatus,
  EnvelopeRef,
  CorpusQuery,
  PluginPublication,
  PluginScoreHistoryRow,
  PublishedArtifact,
  CodeDigestRewardRow,
  TaskPostCounts,
  AutopilotDeliveryCandidateLookup,
  AutopilotDeliveryRole,
} from './types.js';
import { DiscoveryUnavailableError, TASK_POST_WINDOW_BLOCKS, bucketTaskPostCounts } from './types.js';
import {
  applyTaskLifecycleTerminals,
  assembleTaskLifecycleEvidence,
} from './task-lifecycle-evidence.js';
import type { RawAttemptRow, RawTaskRow, RawVerdictRow } from './task-lifecycle-evidence.js';
import { manifestDigestForCid } from '../adapters/mech/digest.js';
// One-swap R3b (issue #2494): the four methods the surviving HTTP-indexer
// consumers drive — getAutopilotDeliveryCandidates, listLaunchedSolverNets,
// queryEnvelopes, getCodeDigestRewards — plus the transport they share now live
// in the neutral `discovery-client/`. This file composes that client instead of
// keeping a second copy, so the D-wave deletion of `discovery/` cannot change
// what those consumers observe. Import direction is one-way: never the reverse.
import {
  createDiscoveryHttpTransport,
  createHttpDiscoveryClient,
  postGql,
  type HttpDiscoveryClientOptions,
} from '../discovery-client/http.js';

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

/** Page cap for the task-post-rate scan (1000 rows/page → 50k recent tasks). */
const MAX_TASK_POST_PAGES = 50;

const LIFECYCLE_TASKS_QUERY = `
query LifecycleTasks($taskIds: [String!]!, $limit: Int!, $after: String) {
  tasks(
    where: { id_in: $taskIds },
    limit: $limit,
    after: $after,
    orderBy: "id",
    orderDirection: "asc"
  ) {
    items {
      id
      chainId
      manifestDigest
      taskCidDigest
      creator
      maxClaims
      requiredVerdicts
      createdAtBlock
      createdAtTx
      finalized
      refunded
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const LIFECYCLE_ATTEMPTS_QUERY = `
query LifecycleAttempts($taskIds: [String!]!, $chainId: Int!, $limit: Int!, $after: String) {
  attempts(
    where: { taskId_in: $taskIds, chainId: $chainId },
    limit: $limit,
    after: $after,
    orderBy: "attemptIndex",
    orderDirection: "asc"
  ) {
    items {
      taskId
      chainId
      attemptIndex
      requestId
      operator
      priorityMech
      deliveryRate
      createdAtBlock
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const LIFECYCLE_VERDICTS_QUERY = `
query LifecycleVerdicts($taskIds: [String!]!, $chainId: Int!, $limit: Int!, $after: String) {
  verdicts(
    where: { taskId_in: $taskIds, chainId: $chainId },
    limit: $limit,
    after: $after,
    orderBy: "verdictIndex",
    orderDirection: "asc"
  ) {
    items {
      taskId
      chainId
      attemptIndex
      verdictIndex
      requestId
      evaluator
      verdictCode
      createdAtBlock
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const LIFECYCLE_ATTEMPT_METAS_QUERY = `
query LifecycleAttemptMetas($requestIds: [String!]!, $limit: Int!, $after: String) {
  attemptEnvelopeMetas(
    where: { requestId_in: $requestIds },
    limit: $limit,
    after: $after,
    orderBy: "enrichedAtBlock",
    orderDirection: "asc"
  ) {
    items {
      requestId
      chainId
      manifestCid
      publisherAgentId
      manifestHash
      enrichedAtBlock
      solverType
      implName
      implVersion
      codeDigest
      mode
      pluginsJson
      model
      evidenceTier
      sourcePublished
      enrichmentStatus
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const LIFECYCLE_VERDICT_METAS_QUERY = `
query LifecycleVerdictMetas($requestIds: [String!]!, $limit: Int!, $after: String) {
  verdictEnvelopeMetas(
    where: { requestId_in: $requestIds },
    limit: $limit,
    after: $after,
    orderBy: "enrichedAtBlock",
    orderDirection: "asc"
  ) {
    items {
      requestId
      chainId
      manifestCid
      publisherAgentId
      manifestHash
      enrichedAtBlock
      solverType
      evidenceTier
      actualPassed
      actualScore
      evaluatorVerdict
      solutionRequestId
      instanceId
      solverNetManifestCid
      enrichmentStatus
      taskId
      attemptIndex
      verdictIndex
      evaluator
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

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
 * Leg 1 of getInstanceClaimCounts (#802): page every task id + maxClaims for a
 * SolverNet's manifestDigest. Leg 2 reuses ATTEMPTS_FOR_TASKS_QUERY to count
 * attempts (= consumed slots) per task. Same two-leg shape as
 * getSolverNetOperatorCount; the only delta is selecting maxClaims here.
 */
const CLAIM_COUNT_TASKS_QUERY = `
query ClaimCountTasks($manifestDigest: String!, $limit: Int!, $after: String) {
  tasks(
    where: { manifestDigest: $manifestDigest },
    limit: $limit,
    after: $after,
    orderBy: "id",
    orderDirection: "asc"
  ) {
    items {
      id
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
 * Per-task on-chain finalization snapshot (#579). Pages every task row for a
 * SolverNet's manifestDigest, then co-fetches attempts/verdicts to derive
 * finalized (spine parity with getTaskLifecycleEvidence / #2236). refunded
 * comes from the task-row boolean only; claimWindowEnd is advisory display.
 * Capped at MAX_OPERATOR_COUNT_TASK_PAGES like CLAIM_COUNT_TASKS_QUERY.
 */
const TASK_STATUSES_QUERY = `
query TaskStatuses($manifestDigest: String!, $limit: Int!, $after: String) {
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
      manifestDigest
      taskCidDigest
      creator
      maxClaims
      requiredVerdicts
      createdAtBlock
      refunded
      claimWindowEnd
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

/**
 * Task-post-rate query (#918). Pages the most-recent tasks ordered by
 * createdAtBlock desc; the daemon reads the top row's block as the window head
 * and buckets the three windows (1h / 6h / 24h) AND the per-cid totals
 * client-side from createdAtBlock + manifestDigest.
 *
 * We do NOT push a `manifestDigest_in` / `createdAtBlock_gte` filter into the
 * query: `manifestDigest_in` is not a stable Ponder filter operator across all
 * deploys, and the chain-wide total needs every recent task anyway. A
 * client-side scan-then-bucket over the most-recent N pages is the portable
 * shape. `windowEndBlock` for the HTTP backing is the indexer's latest indexed
 * task block (the top row), not the chain head.
 */
const TASK_POST_COUNTS_QUERY = `
query TaskPostCounts($limit: Int!, $after: String) {
  tasks(
    limit: $limit,
    after: $after,
    orderBy: "createdAtBlock",
    orderDirection: "desc"
  ) {
    items {
      id
      manifestDigest
      createdAtBlock
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

/**
 * Most-recent task for a SolverNet (#957). Filters the `task` table by
 * `manifestDigest = keccak256(manifestCid)` (the same digest join the other
 * task queries use), orders newest-first by `createdAtBlock`, limit 1. Returns
 * the row's `taskCidDigest` + `id` so the caller can reconstruct the IPFS task
 * CID and read its eligibility ref.
 */
const MOST_RECENT_TASK_QUERY = `
query MostRecentTask($manifestDigest: String!) {
  tasks(
    where: { manifestDigest: $manifestDigest },
    limit: 1,
    orderBy: "createdAtBlock",
    orderDirection: "desc"
  ) {
    items {
      id
      taskCidDigest
    }
  }
}
`;

// ── GraphQL response types ────────────────────────────────────────────────────

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

interface SolverNetSingle {
  solverNetManifest: {
    status: string;
    statusUpdatedAt: string;
    anchorBlock: string | number;
    manifestHash?: string | null;
  } | null;
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

interface ClaimCountTasksPage {
  tasks: {
    items: Array<{ id: string; maxClaims: number; chainId: number }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface TaskStatusesPage {
  tasks: {
    items: Array<{
      id: string;
      chainId: number;
      manifestDigest: string;
      taskCidDigest: string;
      creator: string;
      maxClaims: number;
      requiredVerdicts: number;
      createdAtBlock: string | number;
      refunded: boolean;
      claimWindowEnd?: string | number | null;
    }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface StatusSpineAttemptsPage {
  attempts: {
    items: Array<{
      taskId: string;
      chainId: number;
      attemptIndex: number;
      requestId: string;
      operator: string;
      priorityMech: string;
      deliveryRate: string | number;
      createdAtBlock: string | number;
    }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface StatusSpineVerdictsPage {
  verdicts: {
    items: Array<{
      taskId: string;
      chainId: number;
      attemptIndex: number;
      verdictIndex: number;
      requestId: string;
      evaluator: string;
      verdictCode: number;
      createdAtBlock: string | number;
    }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface TaskPostCountsPage {
  tasks: {
    items: Array<{ id: string; manifestDigest: string; createdAtBlock: string | number }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface MostRecentTaskPage {
  tasks: {
    items: Array<{ id: string; taskCidDigest: string }>;
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

/**
 * Options for the composed `DiscoveryAPI` client. Structurally the relocated
 * slice's options (one-swap R3b, issue #2494) — aliased rather than redeclared
 * so the two halves cannot drift apart on url/fetch/timeout/retry semantics.
 */
export type HttpDiscoveryAPIOptions = HttpDiscoveryClientOptions;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseOptionalNumber(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function parseOptionalBoolean(
  value: boolean | string | number | null | undefined,
): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return undefined;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return undefined;
}

function isHex(value: string | undefined): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value);
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
  // One transport, shared with the relocated slice: same `/ready` gate (and
  // therefore the same memoized readiness cache), same per-request AbortSignal
  // timeout, same 502/503 retry schedule. Building it here and handing it to
  // `createHttpDiscoveryClient` keeps both halves of this client on one cache
  // rather than probing `/ready` twice per instance.
  const transport = createDiscoveryHttpTransport(opts);
  const { gqlUrl, fetchImpl, ensureReady } = transport;
  const slice = createHttpDiscoveryClient(opts, transport);


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
      bucket.sort((a, b) => {
        const diff = BigInt(a.taskId) - BigInt(b.taskId);
        return diff < 0n ? -1 : diff > 0n ? 1 : 0;
      });
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
    void args;
    // attemptEnvelopeMeta is a permissionless, shape-parsed projection. Until
    // the indexer exposes a canonical row authenticated with the historical
    // publisher Safe, envelope signature/hash, and authoritative attempt,
    // plugin attribution cannot be treated as verified score history.
    return [];
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
  // Scoped to a single SolverNet via `verdictEnvelopeMeta.solverNetManifestCid`
  // — the indexer enrichment writes this column from the task body's top-level
  // `solverNetManifestCid` (task.v1 schema). Prevents multi-SolverNet operators
  // with overlapping instance_id pools from cross-tenant over-counting
  // (#669 Finding 2).

  async function getInstanceSuccessCounts(args: {
    manifestCid: string;
  }): Promise<Map<string, number>> {
    void args;
    // A unique verdictEnvelopeMeta row is not evidence: any ERC-8004 publisher
    // can project a fresh requestId, victim instance, and passing outcome. Keep
    // the launcher on its local counters until canonical bridge-grade verdict
    // authentication is materialized by the indexer.
    return new Map();
  }

  // ── getInstanceClaimCounts (#802) ──────────────────────────────────────────
  // Per-task consumed-vs-maxClaims for a SolverNet. Two legs, mirroring
  // getSolverNetOperatorCount: leg 1 pages tasks (+ maxClaims) for the
  // manifestDigest; leg 2 pages attempts (consumed slots) batched by taskId_in.
  async function getInstanceClaimCounts(args: {
    manifestCid: string;
  }): Promise<Map<string, InstanceClaimCount>> {
    await ensureReady();

    const manifestDigest = manifestDigestForCid(args.manifestCid).toLowerCase();

    // Leg 1: task ids + maxClaims for this SolverNet (single-chain → shared chainId).
    const maxClaimsByTaskId = new Map<string, number>();
    const taskIds: string[] = [];
    let chainId: number | undefined;
    let taskCursor: string | null = null;
    for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
      const data: ClaimCountTasksPage = await postGql<ClaimCountTasksPage>(
        gqlUrl,
        fetchImpl,
        CLAIM_COUNT_TASKS_QUERY,
        { manifestDigest, limit: ATTEMPTS_PAGE_LIMIT, after: taskCursor },
      );
      for (const row of data.tasks?.items ?? []) {
        taskIds.push(row.id);
        maxClaimsByTaskId.set(row.id, row.maxClaims);
        if (chainId === undefined) chainId = row.chainId;
      }
      const pageInfo = data.tasks?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      taskCursor = pageInfo.endCursor;
    }

    if (taskIds.length === 0 || chainId === undefined) {
      return new Map();
    }

    // Leg 2: count attempts per taskId (= consumed slots), batched by taskId_in.
    const consumedByTaskId = new Map<string, number>();
    let attemptCursor: string | null = null;
    for (;;) {
      const data: AttemptsPage = await postGql<AttemptsPage>(
        gqlUrl,
        fetchImpl,
        ATTEMPTS_FOR_TASKS_QUERY,
        { taskIds, chainId, limit: ATTEMPTS_PAGE_LIMIT, after: attemptCursor },
      );
      for (const a of data.attempts?.items ?? []) {
        consumedByTaskId.set(a.taskId, (consumedByTaskId.get(a.taskId) ?? 0) + 1);
      }
      const pageInfo = data.attempts?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      attemptCursor = pageInfo.endCursor;
    }

    const out = new Map<string, InstanceClaimCount>();
    for (const taskId of taskIds) {
      out.set(taskId, {
        taskId,
        consumed: consumedByTaskId.get(taskId) ?? 0,
        maxClaims: maxClaimsByTaskId.get(taskId) ?? 0,
      });
    }
    return out;
  }

  // ── getTaskPostCounts (#918) ───────────────────────────────────────────────
  // Page the most-recent tasks (createdAtBlock desc); the top row's block is the
  // window head. Bucket the three windows AND the per-cid totals client-side.
  // windowEndBlock here is the indexer's latest indexed task block, not the
  // chain head (the indexer is the source of truth on the HTTP path).
  async function getTaskPostCounts(args?: { manifestCids?: string[] }): Promise<{
    windowEndBlock: number;
    windowEndTs: number;
    chain: TaskPostCounts;
    byCid: Record<string, TaskPostCounts>;
  }> {
    await ensureReady();

    const windowEndTs = Math.floor(Date.now() / 1000);

    const cids = Array.from(new Set((args?.manifestCids ?? []).filter(Boolean)));
    const cidByDigest = new Map<string, string>();
    for (const cid of cids) {
      cidByDigest.set(manifestDigestForCid(cid).toLowerCase(), cid);
    }

    // Page createdAtBlock desc. The first row sets the window head; we stop
    // paging once a page's oldest row falls before the 24h cut (everything
    // beyond is outside every window).
    const rows: Array<{ digest: string; block: number }> = [];
    let head: number | undefined;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TASK_POST_PAGES; page++) {
      const data: TaskPostCountsPage = await postGql<TaskPostCountsPage>(
        gqlUrl,
        fetchImpl,
        TASK_POST_COUNTS_QUERY,
        { limit: 1000, after: cursor },
      );
      const items = data.tasks?.items ?? [];
      for (const row of items) {
        const block = Number(row.createdAtBlock);
        if (!Number.isFinite(block)) continue;
        if (head === undefined) head = block;
        rows.push({ digest: (row.manifestDigest ?? '').toLowerCase(), block });
      }
      const pageInfo = data.tasks?.pageInfo;
      // Once the oldest row this page is past the 24h cut, no further page can
      // contribute (desc order) — stop early.
      if (head !== undefined && items.length > 0) {
        const oldest = Number(items[items.length - 1]!.createdAtBlock);
        if (Number.isFinite(oldest) && oldest < head - TASK_POST_WINDOW_BLOCKS.h24) break;
      }
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }

    const windowEndBlock = head ?? 0;
    const { chain, byCid } = bucketTaskPostCounts(windowEndBlock, windowEndTs, rows, cidByDigest);

    return { windowEndBlock, windowEndTs, chain, byCid };
  }

  // ── getMostRecentTaskCidDigest (#957) ──────────────────────────────────────
  // Single newest task (createdAtBlock desc, limit 1) for the SolverNet's
  // manifestDigest. Pure indexer read — no IPFS hop; the caller reconstructs the
  // task CID from the returned digest.
  async function getMostRecentTaskCidDigest(manifestCid: string): Promise<{
    taskCidDigest: `0x${string}`;
    taskId: string;
  } | undefined> {
    await ensureReady();

    // The indexer keys tasks by `manifestDigest = keccak256(toBytes(cid))`, not
    // by the cid string — same join the other task queries use.
    const manifestDigest = manifestDigestForCid(manifestCid).toLowerCase();

    const data = await postGql<MostRecentTaskPage>(
      gqlUrl,
      fetchImpl,
      MOST_RECENT_TASK_QUERY,
      { manifestDigest },
    );

    const row = data.tasks?.items?.[0];
    if (!row || !isHex(row.taskCidDigest)) return undefined;
    return { taskCidDigest: row.taskCidDigest, taskId: row.id };
  }

  // ── getTaskStatuses (#579) ─────────────────────────────────────────────────
  // Per-task finalized/refunded/claimWindowEnd for a SolverNet, keyed by taskId.
  // Leg 1 pages tasks for manifestDigest; legs 2–3 co-fetch attempts/verdicts so
  // finalized matches getTaskLifecycleEvidence (#2236 / #2241). refunded uses the
  // task-row boolean only; claimWindowEnd is display-only from the task row.
  // Page-cap contract (#2247): shares MAX_OPERATOR_COUNT_TASK_PAGES with lifecycle
  // evidence, but silently stops paging attempts/verdicts at the cap (partial Map,
  // may under-report finalized) instead of returning empty like getTaskLifecycleEvidence.
  async function getTaskStatuses(args: {
    manifestCid: string;
  }): Promise<Map<string, TaskStatusSnapshot>> {
    await ensureReady();

    const manifestDigest = manifestDigestForCid(args.manifestCid).toLowerCase();

    const tasks: RawTaskRow[] = [];
    const refundedTaskIds = new Set<string>();
    const claimWindowEndByTaskId = new Map<string, number | undefined>();
    let taskCursor: string | null = null;
    for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
      const data: TaskStatusesPage = await postGql<TaskStatusesPage>(
        gqlUrl,
        fetchImpl,
        TASK_STATUSES_QUERY,
        { manifestDigest, limit: ATTEMPTS_PAGE_LIMIT, after: taskCursor },
      );
      for (const row of data.tasks?.items ?? []) {
        const createdAtBlock = Number(row.createdAtBlock);
        if (!Number.isFinite(createdAtBlock)) continue;
        if (!isHex(row.manifestDigest) || !isHex(row.taskCidDigest) || !isHex(row.creator)) continue;
        if (row.refunded === true) refundedTaskIds.add(row.id);
        claimWindowEndByTaskId.set(row.id, parseOptionalNumber(row.claimWindowEnd));
        tasks.push({
          taskId: row.id,
          chainId: row.chainId,
          manifestDigest: row.manifestDigest.toLowerCase() as `0x${string}`,
          taskCidDigest: row.taskCidDigest.toLowerCase() as `0x${string}`,
          creator: row.creator.toLowerCase() as `0x${string}`,
          maxClaims: row.maxClaims,
          requiredVerdicts: row.requiredVerdicts > 0 ? row.requiredVerdicts : 1,
          createdAtBlock,
          finalized: false,
          refunded: false,
        });
      }
      const pageInfo = data.tasks?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      taskCursor = pageInfo.endCursor;
    }

    if (tasks.length === 0) return new Map();

    const taskIdsByChain = new Map<number, string[]>();
    for (const t of tasks) {
      const list = taskIdsByChain.get(t.chainId) ?? [];
      list.push(t.taskId);
      taskIdsByChain.set(t.chainId, list);
    }

    const attempts: RawAttemptRow[] = [];
    for (const [chainId, taskIds] of taskIdsByChain) {
      let attemptCursor: string | null = null;
      for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
        const data: StatusSpineAttemptsPage = await postGql<StatusSpineAttemptsPage>(
          gqlUrl,
          fetchImpl,
          LIFECYCLE_ATTEMPTS_QUERY,
          {
            taskIds,
            chainId,
            limit: ATTEMPTS_PAGE_LIMIT,
            after: attemptCursor,
          },
        );
        for (const row of data.attempts?.items ?? []) {
          const createdAtBlock = Number(row.createdAtBlock);
          if (!Number.isFinite(createdAtBlock)) continue;
          if (!isHex(row.requestId) || !isHex(row.operator) || !isHex(row.priorityMech)) continue;
          attempts.push({
            taskId: row.taskId,
            chainId: row.chainId,
            attemptIndex: row.attemptIndex,
            requestId: row.requestId.toLowerCase() as `0x${string}`,
            operator: row.operator.toLowerCase() as `0x${string}`,
            priorityMech: row.priorityMech.toLowerCase() as `0x${string}`,
            deliveryRate: String(row.deliveryRate),
            createdAtBlock,
          });
        }
        const pageInfo = data.attempts?.pageInfo;
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
        attemptCursor = pageInfo.endCursor;
      }
    }

    const verdicts: RawVerdictRow[] = [];
    for (const [chainId, taskIds] of taskIdsByChain) {
      let verdictCursor: string | null = null;
      for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
        const data: StatusSpineVerdictsPage = await postGql<StatusSpineVerdictsPage>(
          gqlUrl,
          fetchImpl,
          LIFECYCLE_VERDICTS_QUERY,
          {
            taskIds,
            chainId,
            limit: ATTEMPTS_PAGE_LIMIT,
            after: verdictCursor,
          },
        );
        for (const row of data.verdicts?.items ?? []) {
          const createdAtBlock = Number(row.createdAtBlock);
          if (!Number.isFinite(createdAtBlock)) continue;
          if (!isHex(row.requestId) || !isHex(row.evaluator)) continue;
          verdicts.push({
            taskId: row.taskId,
            chainId: row.chainId,
            attemptIndex: row.attemptIndex,
            verdictIndex: row.verdictIndex,
            requestId: row.requestId.toLowerCase() as `0x${string}`,
            evaluator: row.evaluator.toLowerCase() as `0x${string}`,
            verdictCode: row.verdictCode,
            createdAtBlock,
          });
        }
        const pageInfo = data.verdicts?.pageInfo;
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
        verdictCursor = pageInfo.endCursor;
      }
    }

    applyTaskLifecycleTerminals({
      tasks,
      attempts,
      verdicts,
      refundedTaskIds,
    });

    const out = new Map<string, TaskStatusSnapshot>();
    for (const task of tasks) {
      out.set(task.taskId, {
        taskId: task.taskId,
        finalized: task.finalized,
        refunded: task.refunded,
        claimWindowEnd: claimWindowEndByTaskId.get(task.taskId),
      });
    }
    return out;
  }

  // ── getVerdictTallies (#502) ───────────────────────────────────────────────
  // Resolved PASS/FAIL tallies per task, grouped client-side (Ponder has no
  // GROUP BY). DISPLAY signal backing the Activity Outcome column. Dedupes on
  // (requestId|chainId); folds PASS→pass, FAIL→fail; excludes
  // INVALID/INDETERMINATE/UNKNOWN. Empty taskIds short-circuits with no query.
  async function getVerdictTallies(args: {
    taskIds: string[];
  }): Promise<Map<string, VerdictTallyResult>> {
    void args;
    // The on-chain fallback still exposes authoritative delivery state. Do not
    // decorate it with unauthenticated off-chain polarity projections.
    return new Map();
  }

  // ── getTaskLifecycleEvidence (#2044) ───────────────────────────────────────
  // Authoritative task→attempt→verdict spine + untrusted envelope candidates.
  // Empty taskIds short-circuits with no query. Unknown taskIds are omitted.
  // Candidates attach last by (requestId, chainId) and never rewrite spine.
  // If any GraphQL leg hits MAX_OPERATOR_COUNT_TASK_PAGES with more pages
  // remaining, return empty (absence > partial lie) — same honesty rule as the
  // on-chain floor's chunk-cap pre-check.
  async function getTaskLifecycleEvidence(args: {
    taskIds: string[];
  }): Promise<Map<string, TaskLifecycleEvidence>> {
    if (args.taskIds.length === 0) return new Map();
    await ensureReady();

    const requestedIds = Array.from(new Set(args.taskIds.filter(Boolean)));
    if (requestedIds.length === 0) return new Map();

    type LifecyclePageInfo = { hasNextPage?: boolean; endCursor?: string | null } | undefined;
    /** Advance a cursor page, or signal truncation when the hard page cap binds. */
    const nextLifecyclePage = (
      page: number,
      pageInfo: LifecyclePageInfo,
    ): { kind: 'done' } | { kind: 'next'; cursor: string } | { kind: 'truncated' } => {
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return { kind: 'done' };
      if (page + 1 >= MAX_OPERATOR_COUNT_TASK_PAGES) return { kind: 'truncated' };
      return { kind: 'next', cursor: pageInfo.endCursor };
    };
    const emptyOnLifecycleTruncate = (leg: string): Map<string, TaskLifecycleEvidence> => {
      console.warn(
        `[discovery] getTaskLifecycleEvidence: HTTP page cap hit on ${leg}; ` +
          'omitting results (absence > partial lie)',
      );
      return new Map();
    };

    type LifecycleTaskGql = {
      id: string;
      chainId: number;
      manifestDigest: string;
      taskCidDigest: string;
      creator: string;
      maxClaims: number;
      requiredVerdicts: number;
      createdAtBlock: string | number;
      createdAtTx?: string | null;
      finalized: boolean;
      refunded: boolean;
    };
    type LifecycleAttemptGql = {
      taskId: string;
      chainId: number;
      attemptIndex: number;
      requestId: string;
      operator: string;
      priorityMech: string;
      deliveryRate: string | number;
      createdAtBlock: string | number;
    };
    type LifecycleVerdictGql = {
      taskId: string;
      chainId: number;
      attemptIndex: number;
      verdictIndex: number;
      requestId: string;
      evaluator: string;
      verdictCode: number;
      createdAtBlock: string | number;
    };
    type LifecycleAttemptMetaGql = {
      requestId: string;
      chainId: number;
      manifestCid: string;
      publisherAgentId: string;
      manifestHash: string;
      enrichedAtBlock: string | number;
      solverType?: string;
      implName?: string;
      implVersion?: string;
      codeDigest?: string;
      mode?: string;
      pluginsJson?: string;
      model?: string;
      evidenceTier?: string;
      sourcePublished?: boolean;
      enrichmentStatus?: string;
    };
    type LifecycleVerdictMetaGql = {
      requestId: string;
      chainId: number;
      manifestCid: string;
      publisherAgentId: string;
      manifestHash: string;
      enrichedAtBlock: string | number;
      solverType?: string;
      evidenceTier?: string;
      actualPassed?: boolean;
      actualScore?: string;
      evaluatorVerdict?: string;
      solutionRequestId?: string;
      instanceId?: string;
      solverNetManifestCid?: string;
      enrichmentStatus?: string;
      taskId?: string;
      attemptIndex?: number;
      verdictIndex?: number;
      evaluator?: string;
    };

    const tasks: RawTaskRow[] = [];
    const refundedTaskIds = new Set<string>();
    let taskCursor: string | null = null;
    for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
      const data = await postGql<{
        tasks: { items: LifecycleTaskGql[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
      }>(gqlUrl, fetchImpl, LIFECYCLE_TASKS_QUERY, {
        taskIds: requestedIds,
        limit: ATTEMPTS_PAGE_LIMIT,
        after: taskCursor,
      });
      for (const row of data.tasks?.items ?? []) {
        const createdAtBlock = Number(row.createdAtBlock);
        if (!Number.isFinite(createdAtBlock)) continue;
        if (!isHex(row.manifestDigest) || !isHex(row.taskCidDigest) || !isHex(row.creator)) continue;
        if (row.refunded === true) refundedTaskIds.add(row.id);
        const task: RawTaskRow = {
          taskId: row.id,
          chainId: row.chainId,
          manifestDigest: row.manifestDigest.toLowerCase() as `0x${string}`,
          taskCidDigest: row.taskCidDigest.toLowerCase() as `0x${string}`,
          creator: row.creator.toLowerCase() as `0x${string}`,
          maxClaims: row.maxClaims,
          requiredVerdicts: row.requiredVerdicts > 0 ? row.requiredVerdicts : 1,
          createdAtBlock,
          // Provisional — applyTaskLifecycleTerminals overwrites both before assemble.
          finalized: false,
          refunded: false,
        };
        if (isHex(row.createdAtTx ?? undefined)) {
          task.createdAtTx = row.createdAtTx!.toLowerCase() as `0x${string}`;
        }
        tasks.push(task);
      }
      const advance = nextLifecyclePage(page, data.tasks?.pageInfo);
      if (advance.kind === 'done') break;
      if (advance.kind === 'truncated') return emptyOnLifecycleTruncate('tasks');
      taskCursor = advance.cursor;
    }

    if (tasks.length === 0) return new Map();

    const taskIdsByChain = new Map<number, string[]>();
    for (const t of tasks) {
      const list = taskIdsByChain.get(t.chainId) ?? [];
      list.push(t.taskId);
      taskIdsByChain.set(t.chainId, list);
    }

    const attempts: RawAttemptRow[] = [];
    for (const [chainId, taskIds] of taskIdsByChain) {
      let attemptCursor: string | null = null;
      for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
        const data = await postGql<{
          attempts: { items: LifecycleAttemptGql[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
        }>(gqlUrl, fetchImpl, LIFECYCLE_ATTEMPTS_QUERY, {
          taskIds,
          chainId,
          limit: ATTEMPTS_PAGE_LIMIT,
          after: attemptCursor,
        });
        for (const row of data.attempts?.items ?? []) {
          const createdAtBlock = Number(row.createdAtBlock);
          if (!Number.isFinite(createdAtBlock)) continue;
          if (!isHex(row.requestId) || !isHex(row.operator) || !isHex(row.priorityMech)) continue;
          attempts.push({
            taskId: row.taskId,
            chainId: row.chainId,
            attemptIndex: row.attemptIndex,
            requestId: row.requestId.toLowerCase() as `0x${string}`,
            operator: row.operator.toLowerCase() as `0x${string}`,
            priorityMech: row.priorityMech.toLowerCase() as `0x${string}`,
            deliveryRate: String(row.deliveryRate),
            createdAtBlock,
          });
        }
        const advance = nextLifecyclePage(page, data.attempts?.pageInfo);
        if (advance.kind === 'done') break;
        if (advance.kind === 'truncated') return emptyOnLifecycleTruncate('attempts');
        attemptCursor = advance.cursor;
      }
    }

    const verdicts: RawVerdictRow[] = [];
    for (const [chainId, taskIds] of taskIdsByChain) {
      let verdictCursor: string | null = null;
      for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
        const data = await postGql<{
          verdicts: { items: LifecycleVerdictGql[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
        }>(gqlUrl, fetchImpl, LIFECYCLE_VERDICTS_QUERY, {
          taskIds,
          chainId,
          limit: ATTEMPTS_PAGE_LIMIT,
          after: verdictCursor,
        });
        for (const row of data.verdicts?.items ?? []) {
          const createdAtBlock = Number(row.createdAtBlock);
          if (!Number.isFinite(createdAtBlock)) continue;
          if (!isHex(row.requestId) || !isHex(row.evaluator)) continue;
          verdicts.push({
            taskId: row.taskId,
            chainId: row.chainId,
            attemptIndex: row.attemptIndex,
            verdictIndex: row.verdictIndex,
            requestId: row.requestId.toLowerCase() as `0x${string}`,
            evaluator: row.evaluator.toLowerCase() as `0x${string}`,
            verdictCode: row.verdictCode,
            createdAtBlock,
          });
        }
        const advance = nextLifecyclePage(page, data.verdicts?.pageInfo);
        if (advance.kind === 'done') break;
        if (advance.kind === 'truncated') return emptyOnLifecycleTruncate('verdicts');
        verdictCursor = advance.cursor;
      }
    }

    // finalized from co-fetched attempts/verdicts (floor parity); refunded from
    // task-row boolean only — no refund-event GraphQL entity to cross-check (#2236).
    applyTaskLifecycleTerminals({
      tasks,
      attempts,
      verdicts,
      refundedTaskIds,
    });

    const solveRequestIds = Array.from(new Set(attempts.map((a) => a.requestId)));
    const evalRequestIds = Array.from(new Set(verdicts.map((v) => v.requestId)));

    const attemptCandidates: AttemptEnvelopeCandidate[] = [];
    if (solveRequestIds.length > 0) {
      let metaCursor: string | null = null;
      for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
        const data = await postGql<{
          attemptEnvelopeMetas: {
            items: LifecycleAttemptMetaGql[];
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        }>(gqlUrl, fetchImpl, LIFECYCLE_ATTEMPT_METAS_QUERY, {
          requestIds: solveRequestIds,
          limit: ATTEMPTS_PAGE_LIMIT,
          after: metaCursor,
        });
        for (const row of data.attemptEnvelopeMetas?.items ?? []) {
          const enrichedAtBlock = Number(row.enrichedAtBlock);
          if (!Number.isFinite(enrichedAtBlock)) continue;
          if (!isHex(row.requestId) || !isHex(row.manifestHash)) continue;
          const cand: AttemptEnvelopeCandidate = {
            requestId: row.requestId.toLowerCase() as `0x${string}`,
            chainId: row.chainId,
            manifestCid: row.manifestCid,
            publisherAgentId: row.publisherAgentId,
            manifestHash: row.manifestHash.toLowerCase() as `0x${string}`,
            enrichedAtBlock,
          };
          if (row.solverType) cand.solverType = row.solverType;
          if (row.implName) cand.implName = row.implName;
          if (row.implVersion) cand.implVersion = row.implVersion;
          if (row.codeDigest) cand.codeDigest = row.codeDigest;
          if (row.mode) cand.mode = row.mode;
          if (row.pluginsJson) cand.pluginsJson = row.pluginsJson;
          if (row.model) cand.model = row.model;
          if (row.evidenceTier) cand.evidenceTier = row.evidenceTier;
          if (typeof row.sourcePublished === 'boolean') cand.sourcePublished = row.sourcePublished;
          if (row.enrichmentStatus) cand.enrichmentStatus = row.enrichmentStatus;
          attemptCandidates.push(cand);
        }
        const advance = nextLifecyclePage(page, data.attemptEnvelopeMetas?.pageInfo);
        if (advance.kind === 'done') break;
        if (advance.kind === 'truncated') return emptyOnLifecycleTruncate('attemptEnvelopeMetas');
        metaCursor = advance.cursor;
      }
    }

    const verdictCandidates: VerdictEnvelopeCandidate[] = [];
    if (evalRequestIds.length > 0) {
      let metaCursor: string | null = null;
      for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
        const data = await postGql<{
          verdictEnvelopeMetas: {
            items: LifecycleVerdictMetaGql[];
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        }>(gqlUrl, fetchImpl, LIFECYCLE_VERDICT_METAS_QUERY, {
          requestIds: evalRequestIds,
          limit: ATTEMPTS_PAGE_LIMIT,
          after: metaCursor,
        });
        for (const row of data.verdictEnvelopeMetas?.items ?? []) {
          const enrichedAtBlock = Number(row.enrichedAtBlock);
          if (!Number.isFinite(enrichedAtBlock)) continue;
          if (!isHex(row.requestId) || !isHex(row.manifestHash)) continue;
          const cand: VerdictEnvelopeCandidate = {
            requestId: row.requestId.toLowerCase() as `0x${string}`,
            chainId: row.chainId,
            manifestCid: row.manifestCid,
            publisherAgentId: row.publisherAgentId,
            manifestHash: row.manifestHash.toLowerCase() as `0x${string}`,
            enrichedAtBlock,
          };
          if (row.solverType) cand.solverType = row.solverType;
          if (row.evidenceTier) cand.evidenceTier = row.evidenceTier;
          if (typeof row.actualPassed === 'boolean') cand.actualPassed = row.actualPassed;
          if (row.actualScore) cand.actualScore = row.actualScore;
          if (row.evaluatorVerdict) cand.evaluatorVerdict = row.evaluatorVerdict;
          if (row.solutionRequestId) cand.solutionRequestId = row.solutionRequestId;
          if (row.instanceId) cand.instanceId = row.instanceId;
          if (row.solverNetManifestCid) cand.solverNetManifestCid = row.solverNetManifestCid;
          if (row.enrichmentStatus) cand.enrichmentStatus = row.enrichmentStatus;
          // Projected hints only — never used as spine keys (AC3).
          if (row.taskId) cand.projectedTaskId = row.taskId;
          if (typeof row.attemptIndex === 'number') cand.projectedAttemptIndex = row.attemptIndex;
          if (typeof row.verdictIndex === 'number') cand.projectedVerdictIndex = row.verdictIndex;
          if (isHex(row.evaluator)) {
            cand.projectedEvaluator = row.evaluator.toLowerCase() as `0x${string}`;
          }
          verdictCandidates.push(cand);
        }
        const advance = nextLifecyclePage(page, data.verdictEnvelopeMetas?.pageInfo);
        if (advance.kind === 'done') break;
        if (advance.kind === 'truncated') return emptyOnLifecycleTruncate('verdictEnvelopeMetas');
        metaCursor = advance.cursor;
      }
    }

    return assembleTaskLifecycleEvidence({
      tasks,
      attempts,
      verdicts,
      attemptCandidates,
      verdictCandidates,
    });
  }

  return {
    // Relocated to `discovery-client/` by one-swap R3b (issue #2494); delegated
    // rather than reimplemented so both call paths observe identical behavior.
    getAutopilotDeliveryCandidates: slice.getAutopilotDeliveryCandidates,
    listLaunchedSolverNets: slice.listLaunchedSolverNets,
    queryEnvelopes: slice.queryEnvelopes,
    getCodeDigestRewards: slice.getCodeDigestRewards,
    findClaimableTasks,
    getLifecycleStatus,
    getSolverNetOperatorCount,
    listPluginPublications,
    getPluginScores,
    listBuilderArtifacts,
    getInstanceSuccessCounts,
    getInstanceClaimCounts,
    getTaskPostCounts,
    getMostRecentTaskCidDigest,
    getTaskStatuses,
    getVerdictTallies,
    getTaskLifecycleEvidence,
  };
}
