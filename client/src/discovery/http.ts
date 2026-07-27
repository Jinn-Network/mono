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
import { assembleTaskLifecycleEvidence } from './task-lifecycle-evidence.js';
import type { RawAttemptRow, RawTaskRow, RawVerdictRow } from './task-lifecycle-evidence.js';
import { manifestDigestForCid } from '../adapters/mech/digest.js';
import {
  createHttpCorpusDiscovery,
  DiscoveryUnavailableError as CoreDiscoveryUnavailableError,
} from '@jinn-network/core/corpus-read';

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

/**
 * Exact Autopilot recovery queries. Each leg is bounded at two rows so the
 * client can distinguish a unique join from contradictory indexer state
 * without a recent/global scan.
 */
const EXACT_AUTOPILOT_TASK_QUERY = `
query ExactAutopilotTask($taskId: String!, $chainId: Int!) {
  tasks(
    where: { id: $taskId, chainId: $chainId },
    limit: 2
  ) {
    items {
      id
      chainId
      taskCidDigest
      createdAtBlock
      createdAtTx
    }
  }
}
`;

const EXACT_AUTOPILOT_SOLUTION_ATTEMPTS_QUERY = `
query ExactAutopilotSolutionAttempts($taskId: String!, $chainId: Int!) {
  attempts(
    where: { taskId: $taskId, chainId: $chainId },
    limit: 2
  ) {
    items {
      taskId
      chainId
      attemptIndex
      requestId
      operator
      createdAtBlock
    }
  }
}
`;

const EXACT_AUTOPILOT_ENVELOPES_QUERY = `
query ExactAutopilotEnvelopeMetadata($requestId: String!, $chainId: Int!) {
  attemptEnvelopeMetas(
    where: { requestId: $requestId, chainId: $chainId },
    limit: 2
  ) {
    items {
      requestId
      chainId
      manifestCid
      publisherAgentId
      manifestHash
      enrichedAtBlock
    }
  }
}
`;

const EXACT_AUTOPILOT_VERDICTS_QUERY = `
query ExactAutopilotVerdicts($taskId: String!, $chainId: Int!) {
  verdicts(
    where: { taskId: $taskId, chainId: $chainId },
    limit: 2
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
  }
}
`;

const EXACT_AUTOPILOT_VERDICT_ENVELOPES_QUERY = `
query ExactAutopilotVerdictEnvelopeMetadata($taskId: String!, $chainId: Int!) {
  verdictEnvelopeMetas(
    where: { taskId: $taskId, chainId: $chainId },
    limit: 2
  ) {
    items {
      taskId
      chainId
      attemptIndex
      verdictIndex
      requestId
      evaluator
      manifestCid
      publisherAgentId
      manifestHash
      enrichedAtBlock
    }
  }
}
`;

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
      name
      network
      solutionPriceWei
      verdictPriceWei
      openRoles
      launcherSafeAddress
      contractId
      contractVersion
      solverNetId
      manifestEnrichmentStatus
    }
  }
}
`;

// Legacy selection for the backward-compat degrade path (issue #985): the
// pre-enrichment field set, safe against an OLD indexer that lacks the
// enriched columns. The projection fills sentinels for the missing fields and
// leaves manifestEnrichmentStatus undefined → treated as not-ok → sentinels.
// These rows surface unenriched on the LIST path (empty name, '0' prices, zero
// address); they are not re-enriched anywhere — full fields require an indexer
// that persists the enriched columns, or the hash-verified getManifest detail path.
const LIST_SOLVER_NETS_QUERY_LEGACY = `
query ListSolverNetsLegacy($where: solverNetManifestFilter, $limit: Int!) {
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
 * Per-task on-chain finalization snapshot (#579). Pages every task id +
 * finalized/refunded/claimWindowEnd for a SolverNet's manifestDigest, capped at
 * MAX_OPERATOR_COUNT_TASK_PAGES like CLAIM_COUNT_TASKS_QUERY. Backs the Launcher
 * "Recent posted Tasks" status chip — a DISPLAY signal, not a correctness gate.
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
      finalized
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
  // Issue #985: enriched summary fields. Absent (undefined) when querying an
  // OLD indexer that predates these columns — the degrade catch handles that.
  name?: string;
  network?: string;
  solutionPriceWei?: string;
  verdictPriceWei?: string;
  openRoles?: string[];
  launcherSafeAddress?: string;
  contractId?: string;
  contractVersion?: string;
  solverNetId?: string;
  manifestEnrichmentStatus?: string;
}

/** Sentinel for an unenriched / unknown launcher safe address. */
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

/** Coerce an indexer-supplied address to a typed hex, or fall back to the zero sentinel. */
function safeAddr(a: string | undefined): `0x${string}` {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : ZERO_ADDR;
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
      finalized: boolean | string | number | null;
      refunded: boolean | string | number | null;
      claimWindowEnd?: string | number | null;
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

interface ExactAutopilotTaskPage {
  tasks: {
    items: Array<{
      id: string;
      chainId: number;
      taskCidDigest: string;
      createdAtBlock: string | number;
      createdAtTx: string;
    }>;
  };
}

interface ExactAutopilotAttemptsPage {
  attempts: {
    items: Array<{
      taskId: string;
      chainId: number;
      attemptIndex: number;
      requestId: string;
      operator: string;
      createdAtBlock: string | number;
    }>;
  };
}

interface ExactAutopilotEnvelopesPage {
  attemptEnvelopeMetas: {
    items: Array<{
      requestId: string;
      chainId: number;
      manifestCid: string;
      publisherAgentId: string;
      manifestHash: string;
      enrichedAtBlock: string | number;
    }>;
  };
}

interface ExactAutopilotVerdictsPage {
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
  };
}

interface ExactAutopilotVerdictEnvelopesPage {
  verdictEnvelopeMetas: {
    items: Array<{
      taskId: string;
      chainId: number;
      attemptIndex: number;
      verdictIndex: number;
      requestId: string;
      evaluator: string;
      manifestCid: string;
      publisherAgentId: string;
      manifestHash: string;
      enrichedAtBlock: string | number;
    }>;
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
  /**
   * Backoff schedule (ms) for transparent retries on transient indexer
   * failures (502/503 responses and network-level fetch errors). The number of
   * retries equals `retryDelaysMs.length`: a `[200, 500]` schedule retries
   * twice (sleep 200ms before the first retry, 500ms before the second) for a
   * worst-case added latency of 700ms (< 800ms, #782 AC#1). Defaults to
   * RETRY_DELAYS_MS. Tests pass `[0, 0]` to retry instantly. An empty array
   * disables retry entirely. Exposed mostly for tests.
   */
  retryDelaysMs?: readonly number[];
  /**
   * Per-request timeout (ms) applied to every indexer fetch — the `/ready`
   * probe and all GraphQL POSTs. Defaults to FETCH_TIMEOUT_MS. Bounds the fetch
   * so an indexer whose socket goes half-open (e.g. mid-redeploy) cannot wedge
   * a discovery loop forever (#1038). Exposed mostly for tests.
   */
  fetchTimeoutMs?: number;
}

/**
 * How long a `/ready` probe result is trusted before re-probing. Ponder's
 * `/ready` flips to 200 once the indexer has caught up to realtime; before that
 * GraphQL still serves 200 with stale/empty data, so the daemon must consult
 * `/ready` rather than the GraphQL status code. 20s keeps the latency to notice
 * a sync stall low without hammering the endpoint.
 */
const READY_PROBE_TTL_MS = 20_000;

/**
 * Per-request timeout for every indexer fetch (the `/ready` probe and all
 * GraphQL POSTs). A healthy indexer answers in well under a second; 15s is
 * generous headroom that still recovers quickly. Its purpose is to convert a
 * never-settling fetch (half-open socket during an indexer redeploy) into a
 * catchable `DiscoveryUnavailableError` so the discovery/generator/catalog
 * loops skip the tick and retry on the next poll, rather than wedging forever
 * with no self-recovery while the indexer-independent loops mask the outage
 * (#1038).
 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Default backoff schedule for transparent retries on transient indexer
 * failures. `[200, 500]` retries twice — worst-case added latency 700ms, under
 * the 800ms cap (#782 AC#1). Indexer flake (502/503) is bursty: a single
 * transient 502 otherwise silences a daemon poll for a full poll interval, so
 * a short transparent retry recovers without surfacing an outage.
 *
 * Retry is safe here because every retried POST is a read-only GraphQL *query*
 * (no mutations in this client), so re-issuing it is idempotent.
 */
const RETRY_DELAYS_MS = [200, 500] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wrap a fetch with transparent retry on transient indexer failures: 502/503
 * responses and network-level fetch errors (TCP/TLS/DNS). Retries follow the
 * `retryDelaysMs` schedule (one retry per entry). On exhaustion the last 502/503
 * Response is returned unchanged — so `postGql`'s `!response.ok` raiser
 * preserves the original status — or the last thrown error is re-thrown
 * unchanged — so the network-path raiser preserves the original cause. Any
 * non-502/503 response and any non-network outcome is returned/propagated on the
 * first attempt (NOT retried); GraphQL-level `errors[]` are not visible here
 * (they arrive in a 200 body) so they are likewise never retried.
 */
function fetchWithRetry(baseFetch: typeof fetch, retryDelaysMs: readonly number[]): typeof fetch {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await baseFetch(input, init);
        if ((res.status === 502 || res.status === 503) && attempt < retryDelaysMs.length) {
          await sleep(retryDelaysMs[attempt]);
          continue;
        }
        return res;
      } catch (err) {
        if (attempt < retryDelaysMs.length) {
          await sleep(retryDelaysMs[attempt]);
          continue;
        }
        throw err;
      }
    }
  };
}

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

function isBytes32(value: string | undefined): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: string | undefined): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parseExactBlock(value: string | number | null | undefined): number | undefined {
  const parsed = parseOptionalNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
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
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;

  if (!baseFetch) {
    throw new Error('No fetch implementation available; pass fetchImpl in options');
  }

  // Bound every indexer fetch with an AbortSignal timeout. Without it, a single
  // fetch against an indexer whose socket went half-open (e.g. mid-redeploy)
  // never resolves or rejects — and since the fetch is unbounded, the awaiting
  // discovery/generator/catalog loop wedges forever with no self-recovery,
  // while the indexer-independent loops keep running and mask the outage
  // on-chain (#1038). A timeout turns the hang into the same
  // DiscoveryUnavailableError those loops already catch and retry. A caller
  // that supplies its own signal keeps it.
  //
  // The AbortSignal-timeout wrap is INSIDE the retry loop (each retry attempt
  // gets a fresh per-request timeout), and transient 502/503 responses and
  // network-level fetch errors are transparently retried on the retryDelaysMs
  // schedule before the failure is allowed to settle. This means a single
  // bursty indexer flake no longer silences a whole daemon poll (#782); the
  // bad-state `/ready` cache is also only written once the retrying fetch
  // settles, so a transient probe blip cannot poison the cache (#782 AC#4).
  const timeoutFetch: typeof fetch = (input, init) =>
    baseFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(fetchTimeoutMs) });
  const fetchImpl: typeof fetch = fetchWithRetry(timeoutFetch, retryDelaysMs);
  const corpusDiscovery = createHttpCorpusDiscovery({
    url: opts.url,
    fetchImpl: baseFetch,
    readyProbeTtlMs: readyTtlMs,
    retryDelaysMs,
    fetchTimeoutMs,
  });

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

  async function getAutopilotDeliveryCandidates(args: {
    chainId: number;
    taskId: string;
    role: AutopilotDeliveryRole;
  }): Promise<AutopilotDeliveryCandidateLookup> {
    const pending = (
      reason: Extract<AutopilotDeliveryCandidateLookup, { status: 'pending' }>['reason'],
    ): AutopilotDeliveryCandidateLookup => ({
      status: 'pending',
      reason,
      taskId: args.taskId,
      role: args.role,
    });
    const contradiction = (
      reason: Extract<AutopilotDeliveryCandidateLookup, { status: 'contradiction' }>['reason'],
    ): AutopilotDeliveryCandidateLookup => ({
      status: 'contradiction',
      reason,
      taskId: args.taskId,
      role: args.role,
    });

    if (
      !Number.isSafeInteger(args.chainId)
      || args.chainId < 0
      || !/^(0|[1-9][0-9]*)$/.test(args.taskId)
    ) {
      return contradiction('inconsistent-indexer-data');
    }

    await ensureReady();

    const taskData = await postGql<ExactAutopilotTaskPage>(
      gqlUrl,
      fetchImpl,
      EXACT_AUTOPILOT_TASK_QUERY,
      { taskId: args.taskId, chainId: args.chainId },
    );
    const taskRows = taskData.tasks?.items ?? [];
    if (taskRows.length === 0) return pending('task-not-indexed');
    if (taskRows.length !== 1) return contradiction('multiple-tasks');
    const taskRow = taskRows[0];
    const taskCreatedAtBlock = parseExactBlock(taskRow.createdAtBlock);
    if (
      taskRow.id !== args.taskId
      || taskRow.chainId !== args.chainId
      || !isBytes32(taskRow.taskCidDigest)
      || !isBytes32(taskRow.createdAtTx)
      || taskCreatedAtBlock === undefined
    ) {
      return contradiction('inconsistent-indexer-data');
    }

    const attemptData = await postGql<ExactAutopilotAttemptsPage>(
      gqlUrl,
      fetchImpl,
      EXACT_AUTOPILOT_SOLUTION_ATTEMPTS_QUERY,
      { taskId: args.taskId, chainId: args.chainId },
    );
    const attemptRows = attemptData.attempts?.items ?? [];
    if (attemptRows.length === 0) return pending('attempt-not-indexed');
    if (attemptRows.length !== 1) return contradiction('multiple-attempts');
    const attemptRow = attemptRows[0];
    const attemptCreatedAtBlock = parseExactBlock(attemptRow.createdAtBlock);
    if (
      attemptRow.taskId !== args.taskId
      || attemptRow.chainId !== args.chainId
      || !Number.isSafeInteger(attemptRow.attemptIndex)
      || attemptRow.attemptIndex < 0
      || !isBytes32(attemptRow.requestId)
      || !isAddress(attemptRow.operator)
      || attemptCreatedAtBlock === undefined
      || attemptCreatedAtBlock < taskCreatedAtBlock
    ) {
      return contradiction('inconsistent-indexer-data');
    }

    if (args.role === 'verdict') {
      // The evaluation metadata anchor exists before adoption and Router
      // settlement. It is therefore the authoritative pre-adoption source for
      // the evaluation request and evaluator Safe. A verdict row is only an
      // optional postcondition cross-check once claimDelivery has happened.
      const envelopeData = await postGql<ExactAutopilotVerdictEnvelopesPage>(
        gqlUrl,
        fetchImpl,
        EXACT_AUTOPILOT_VERDICT_ENVELOPES_QUERY,
        { taskId: args.taskId, chainId: args.chainId },
      );
      const envelopeRows = envelopeData.verdictEnvelopeMetas?.items ?? [];
      if (envelopeRows.length === 0) return pending('envelope-not-indexed');
      if (envelopeRows.length !== 1) return contradiction('multiple-envelopes');
      const envelopeRow = envelopeRows[0];
      const enrichedAtBlock = parseExactBlock(envelopeRow.enrichedAtBlock);
      if (
        envelopeRow.taskId !== args.taskId
        || envelopeRow.chainId !== args.chainId
        || envelopeRow.attemptIndex !== attemptRow.attemptIndex
        || !Number.isSafeInteger(envelopeRow.verdictIndex)
        || envelopeRow.verdictIndex < 0
        || !isBytes32(envelopeRow.requestId)
        || envelopeRow.requestId.toLowerCase() === attemptRow.requestId.toLowerCase()
        || !isAddress(envelopeRow.evaluator)
        || typeof envelopeRow.manifestCid !== 'string'
        || envelopeRow.manifestCid.length === 0
        || !/^[1-9][0-9]*$/.test(envelopeRow.publisherAgentId)
        || !isBytes32(envelopeRow.manifestHash)
        || enrichedAtBlock === undefined
        || enrichedAtBlock < attemptCreatedAtBlock
      ) {
        return contradiction('inconsistent-indexer-data');
      }

      const verdictData = await postGql<ExactAutopilotVerdictsPage>(
        gqlUrl,
        fetchImpl,
        EXACT_AUTOPILOT_VERDICTS_QUERY,
        { taskId: args.taskId, chainId: args.chainId },
      );
      const verdictRows = verdictData.verdicts?.items ?? [];
      if (verdictRows.length > 1) return contradiction('multiple-verdicts');
      let verdictCreatedAtBlock: number | null = null;
      if (verdictRows.length === 1) {
        const verdictRow = verdictRows[0];
        verdictCreatedAtBlock = parseExactBlock(verdictRow.createdAtBlock) ?? null;
        if (
          verdictRow.taskId !== args.taskId
          || verdictRow.chainId !== args.chainId
          || verdictRow.attemptIndex !== envelopeRow.attemptIndex
          || verdictRow.verdictIndex !== envelopeRow.verdictIndex
          || !isBytes32(verdictRow.requestId)
          || verdictRow.requestId.toLowerCase() !== envelopeRow.requestId.toLowerCase()
          || !isAddress(verdictRow.evaluator)
          || verdictRow.evaluator.toLowerCase() !== envelopeRow.evaluator.toLowerCase()
          || !Number.isSafeInteger(verdictRow.verdictCode)
          || verdictCreatedAtBlock === null
          || verdictCreatedAtBlock < attemptCreatedAtBlock
        ) {
          return contradiction('inconsistent-indexer-data');
        }
      }

      return {
        status: 'ready',
        role: args.role,
        task: {
          taskId: taskRow.id,
          taskCidDigest: taskRow.taskCidDigest,
          createdAtBlock: taskCreatedAtBlock,
          createdAtTx: taskRow.createdAtTx,
        },
        attempt: {
          taskId: attemptRow.taskId,
          attemptIndex: envelopeRow.attemptIndex,
          requestId: envelopeRow.requestId,
          operator: envelopeRow.evaluator,
          createdAtBlock: verdictCreatedAtBlock,
        },
        solutionOperator: attemptRow.operator,
        envelope: {
          requestId: envelopeRow.requestId,
          manifestCid: envelopeRow.manifestCid,
          publisherAgentId: envelopeRow.publisherAgentId,
          manifestHash: envelopeRow.manifestHash,
          enrichedAtBlock,
        },
      };
    }

    const envelopeData = await postGql<ExactAutopilotEnvelopesPage>(
      gqlUrl,
      fetchImpl,
      EXACT_AUTOPILOT_ENVELOPES_QUERY,
      { requestId: attemptRow.requestId, chainId: args.chainId },
    );
    const envelopeRows = envelopeData.attemptEnvelopeMetas?.items ?? [];
    if (envelopeRows.length === 0) return pending('envelope-not-indexed');
    if (envelopeRows.length !== 1) return contradiction('multiple-envelopes');
    const envelopeRow = envelopeRows[0];
    const enrichedAtBlock = parseExactBlock(envelopeRow.enrichedAtBlock);
    if (
      !isBytes32(envelopeRow.requestId)
      || envelopeRow.requestId.toLowerCase() !== attemptRow.requestId.toLowerCase()
      || envelopeRow.chainId !== args.chainId
      || typeof envelopeRow.manifestCid !== 'string'
      || envelopeRow.manifestCid.length === 0
      || !/^(0|[1-9][0-9]*)$/.test(envelopeRow.publisherAgentId)
      || !isBytes32(envelopeRow.manifestHash)
      || enrichedAtBlock === undefined
      || enrichedAtBlock < attemptCreatedAtBlock
    ) {
      return contradiction('inconsistent-indexer-data');
    }
    return {
      status: 'ready',
      role: args.role,
      task: {
        taskId: taskRow.id,
        taskCidDigest: taskRow.taskCidDigest,
        createdAtBlock: taskCreatedAtBlock,
        createdAtTx: taskRow.createdAtTx,
      },
      attempt: {
        taskId: attemptRow.taskId,
        attemptIndex: attemptRow.attemptIndex,
        requestId: attemptRow.requestId,
        operator: attemptRow.operator,
        createdAtBlock: attemptCreatedAtBlock,
      },
      solutionOperator: attemptRow.operator,
      envelope: {
        requestId: envelopeRow.requestId,
        manifestCid: envelopeRow.manifestCid,
        publisherAgentId: envelopeRow.publisherAgentId,
        manifestHash: envelopeRow.manifestHash,
        enrichedAtBlock,
      },
    };
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

    let data: SolverNetPage;
    try {
      data = await postGql<SolverNetPage>(
        gqlUrl,
        fetchImpl,
        LIST_SOLVER_NETS_QUERY,
        { where, limit: 200 },
      );
    } catch (err) {
      // Backward-compat degrade (issue #985): an OLD indexer that predates the
      // enriched columns rejects the extended selection set with a GraphQL
      // validation error. Mirror the getPluginScores degrade pattern: re-run
      // the minimal legacy query and project sentinels, so a daemon on a new
      // build still lists against an old indexer (consumers re-enrich via IPFS).
      if (err instanceof Error && /Unknown type|Cannot query|Cannot query field/.test(err.message)) {
        data = await postGql<SolverNetPage>(
          gqlUrl,
          fetchImpl,
          LIST_SOLVER_NETS_QUERY_LEGACY,
          { where, limit: 200 },
        );
      } else {
        throw err;
      }
    }

    return (data.solverNetManifests?.items ?? []).map((row): SolverNetManifestSummary => {
      // Only trust enriched fields when the indexer marked the row 'ok'. A
      // pending/failed row (or an old indexer that omits the field) keeps the
      // sentinel rather than presenting an empty-string price as a real value.
      // On the LIST hot path these rows pass through unenriched (degraded but
      // present — empty name, '0' prices, zero address); full fields arrive once
      // indexer enrichment lands, or via the hash-verified getManifest detail path.
      const enriched = row.manifestEnrichmentStatus === 'ok';
      return {
        manifestCid: row.id,
        solverNetId: enriched && row.solverNetId ? row.solverNetId : row.id,
        name: enriched ? (row.name ?? '') : '',
        network: enriched ? (row.network ?? '') : '',
        launcherSafeAddress: enriched ? safeAddr(row.launcherSafeAddress) : ZERO_ADDR,
        contractId: enriched ? (row.contractId ?? '') : '',
        contractVersion: enriched ? (row.contractVersion ?? '') : '',
        solutionPriceWei: enriched ? (row.solutionPriceWei ?? '0') : '0',
        verdictPriceWei: enriched ? (row.verdictPriceWei ?? '0') : '0',
        openRoles: enriched
          ? ((row.openRoles ?? []).filter((r): r is 'solver' | 'evaluator' => r === 'solver' || r === 'evaluator'))
          : [],
        launcherAgentId: row.launcherAgentId,
        status: (row.status as 'launched' | 'paused' | 'retired') ?? 'launched',
        statusUpdatedAt: row.statusUpdatedAt,
        anchorBlock: Number(row.anchorBlock),
        chainId: row.chainId,
      };
    });
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
    try {
      return await corpusDiscovery.queryEnvelopes(query);
    } catch (error) {
      // Preserve the public client error identity used by withFallback and by
      // daemon/MCP callers while core owns the HTTP request implementation.
      if (error instanceof CoreDiscoveryUnavailableError) {
        throw new DiscoveryUnavailableError(error.message, error.cause);
      }
      throw error;
    }
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

  async function getCodeDigestRewards(args: {
    codeDigests: string[];
    operator?: `0x${string}`;
    solverNetManifestCid?: string;
    window?: number;
  }): Promise<CodeDigestRewardRow[]> {
    if (args.codeDigests.length === 0) return [];
    // Shape-parsed attempt/verdict projections are not authenticated reward
    // evidence. Returning no verified rows keeps the learner and revert gate
    // conservative; a future canonical route must bind publisher Safe,
    // signature/hash, authoritative chain tuple, and original task facts.
    return [];
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
  // Single leg, mirroring getInstanceClaimCounts leg 1: page tasks for the
  // manifestDigest, capped at MAX_OPERATOR_COUNT_TASK_PAGES.
  async function getTaskStatuses(args: {
    manifestCid: string;
  }): Promise<Map<string, TaskStatusSnapshot>> {
    await ensureReady();

    const manifestDigest = manifestDigestForCid(args.manifestCid).toLowerCase();

    const out = new Map<string, TaskStatusSnapshot>();
    let taskCursor: string | null = null;
    for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
      const data: TaskStatusesPage = await postGql<TaskStatusesPage>(
        gqlUrl,
        fetchImpl,
        TASK_STATUSES_QUERY,
        { manifestDigest, limit: ATTEMPTS_PAGE_LIMIT, after: taskCursor },
      );
      for (const row of data.tasks?.items ?? []) {
        const finalized = parseOptionalBoolean(row.finalized);
        const refunded = parseOptionalBoolean(row.refunded);
        if (finalized === undefined || refunded === undefined) continue;
        const claimWindowEnd = parseOptionalNumber(row.claimWindowEnd);
        out.set(row.id, {
          taskId: row.id,
          finalized,
          refunded,
          claimWindowEnd,
        });
      }
      const pageInfo = data.tasks?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      taskCursor = pageInfo.endCursor;
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
        const task: RawTaskRow = {
          taskId: row.id,
          chainId: row.chainId,
          manifestDigest: row.manifestDigest.toLowerCase() as `0x${string}`,
          taskCidDigest: row.taskCidDigest.toLowerCase() as `0x${string}`,
          creator: row.creator.toLowerCase() as `0x${string}`,
          maxClaims: row.maxClaims,
          requiredVerdicts: row.requiredVerdicts > 0 ? row.requiredVerdicts : 1,
          createdAtBlock,
          finalized: row.finalized === true,
          refunded: row.refunded === true,
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
    getAutopilotDeliveryCandidates,
    findClaimableTasks,
    listLaunchedSolverNets,
    getLifecycleStatus,
    getSolverNetOperatorCount,
    queryEnvelopes,
    listPluginPublications,
    getPluginScores,
    listBuilderArtifacts,
    getInstanceSuccessCounts,
    getCodeDigestRewards,
    getInstanceClaimCounts,
    getTaskPostCounts,
    getMostRecentTaskCidDigest,
    getTaskStatuses,
    getVerdictTallies,
    getTaskLifecycleEvidence,
  };
}
