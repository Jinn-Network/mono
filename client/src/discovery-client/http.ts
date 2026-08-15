/**
 * HTTP client for the surviving indexer read slice (one-swap R3b, issue #2494).
 *
 * Relocated verbatim out of `discovery/http.ts` — same GraphQL documents, same
 * transport semantics (`/ready` gate, per-request timeout, transparent 502/503
 * retry), same result projections. `discovery/http.ts` now delegates these four
 * methods here rather than keeping a second copy, so the D-wave deletion of
 * `discovery/` cannot change what these consumers observe.
 *
 * Nothing in this module may import from `client/src/discovery/` — see the
 * module note in `./types.ts`.
 */

import {
  createHttpCorpusDiscovery,
  DiscoveryUnavailableError as CoreDiscoveryUnavailableError,
} from '@jinn-network/core/corpus-read';

import type { CorpusQuery, EnvelopeRef } from '../corpus/types.js';
import {
  DiscoveryUnavailableError,
  type AutopilotDeliveryCandidateLookup,
  type AutopilotDeliveryRole,
  type CodeDigestRewardRow,
  type DiscoveryClient,
  type SolverNetManifestSummary,
} from './types.js';

// ── GraphQL query strings ─────────────────────────────────────────────────────

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

// ── GraphQL response types ────────────────────────────────────────────────────

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
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

interface SolverNetPage {
  solverNetManifests: { items: SolverNetRow[] };
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

/** Sentinel for an unenriched / unknown launcher safe address. */
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

/** Coerce an indexer-supplied address to a typed hex, or fall back to the zero sentinel. */
function safeAddr(a: string | undefined): `0x${string}` {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : ZERO_ADDR;
}

// ── Client options ────────────────────────────────────────────────────────────

export interface HttpDiscoveryClientOptions {
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

// ── Shared transport ──────────────────────────────────────────────────────────

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
export function fetchWithRetry(
  baseFetch: typeof fetch,
  retryDelaysMs: readonly number[],
): typeof fetch {
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

export async function postGql<T>(
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

/**
 * The resolved endpoints, bounded fetch, and memoized `/ready` gate shared by
 * this client and by the legacy `discovery/http.ts` `DiscoveryAPI` that layers
 * its remaining methods on top. Exported so there is exactly ONE transport
 * implementation across the two, not a copy that can drift.
 */
export interface DiscoveryHttpTransport {
  gqlUrl: string;
  readyUrl: string;
  /** Retry- and timeout-wrapped fetch used for every indexer request. */
  fetchImpl: typeof fetch;
  /** Raw operator-supplied fetch, before the timeout/retry wrap. */
  baseFetch: typeof fetch;
  readyTtlMs: number;
  retryDelaysMs: readonly number[];
  fetchTimeoutMs: number;
  /** Throws `DiscoveryUnavailableError` unless the indexer reports ready. */
  ensureReady(): Promise<void>;
}

export function createDiscoveryHttpTransport(
  opts: HttpDiscoveryClientOptions,
): DiscoveryHttpTransport {
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

  return {
    gqlUrl,
    readyUrl,
    fetchImpl,
    baseFetch,
    readyTtlMs,
    retryDelaysMs,
    fetchTimeoutMs,
    ensureReady,
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the surviving indexer read slice over a Ponder GraphQL endpoint.
 *
 * Usage:
 *
 *   import { createHttpDiscoveryClient } from './discovery-client/http.js';
 *   const client = createHttpDiscoveryClient({ url: 'https://my-indexer.example/graphql' });
 *   const nets = await client.listLaunchedSolverNets({ status: ['launched'] });
 */
export function createHttpDiscoveryClient(
  opts: HttpDiscoveryClientOptions,
  transport: DiscoveryHttpTransport = createDiscoveryHttpTransport(opts),
): DiscoveryClient {
  const { gqlUrl, fetchImpl, ensureReady } = transport;
  const corpusDiscovery = createHttpCorpusDiscovery({
    url: opts.url,
    fetchImpl: transport.baseFetch,
    readyProbeTtlMs: transport.readyTtlMs,
    retryDelaysMs: transport.retryDelaysMs,
    fetchTimeoutMs: transport.fetchTimeoutMs,
  });

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

  return {
    getAutopilotDeliveryCandidates,
    listLaunchedSolverNets,
    queryEnvelopes,
    getCodeDigestRewards,
  };
}

// ── Local parse helpers ───────────────────────────────────────────────────────

function parseOptionalNumber(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
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
