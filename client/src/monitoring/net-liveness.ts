/**
 * Net-liveness probe — operator-independent detector for the #1038 silent-stall
 * class.
 *
 * Context: when the shared indexer blips, every operator daemon's discovery
 * loops can wedge while the indexer-independent loops (jinn-claim, balance-topup)
 * keep emitting on-chain activity and mask the outage. No single operator can
 * be trusted to notice, so liveness must be observed from *outside* any daemon.
 *
 * This module reads on-chain truth two ways and cross-references them:
 *   - chain head    — direct RPC `getBlockNumber()` (always live)
 *   - latest indexed attempt/verdict block — indexer GraphQL
 *   - indexer head  — indexer `/status` (the indexer's own indexed head)
 *
 * The core decision is a pure function (`classifyNetLiveness`). The orchestrator
 * (`runNetLivenessProbe`) injects all I/O so the whole flow is testable with no
 * network. Designed to run from a stateless cron entry script
 * (`scripts/net-liveness-probe.ts`), NOT in-daemon.
 */

// ── Pure classifier ─────────────────────────────────────────────────────────

/**
 * Base produces ~one block every 2s → 30 blocks per minute. The probe works in
 * block-space (the schema carries `createdAtBlock`, no timestamp column), so the
 * minute threshold is converted to blocks with this constant.
 */
export const BASE_BLOCKS_PER_MINUTE = 30;

/** Convert a minute threshold to a Base block-count. */
export function minutesToThresholdBlocks(minutes: number): number {
  return minutes * BASE_BLOCKS_PER_MINUTE;
}

export interface NetLivenessInputs {
  /** Current chain head (second of two RPC reads). */
  chainHeadBlock: bigint;
  /** Chain head from the first RPC read, or null if only one read was taken. */
  prevChainHeadBlock: bigint | null;
  /** Block of the newest indexed attempt OR verdict, or null if none / unreadable. */
  latestActivityBlock: bigint | null;
  /** The indexer's own indexed head, or null if the indexer is unreachable. */
  indexerHeadBlock: bigint | null;
  /** Staleness threshold in block-space (minutes × BASE_BLOCKS_PER_MINUTE). */
  thresholdBlocks: number;
}

export type NetLivenessState =
  | 'healthy'
  | 'stale'
  | 'chain-halted'
  | 'indexer-lagging'
  | 'indexer-down';

export interface NetLivenessResult {
  state: NetLivenessState;
  /** Blocks since the last indexed activity (chainHead − latestActivity, floored at 0). */
  staleForBlocks: bigint;
  reason: string;
}

/**
 * Decide net-liveness from the four cross-referenced reads. PURE — no I/O.
 *
 * Decision order matters: only the `stale` state alerts. Each preceding state is
 * a confound that would otherwise look like a stall but isn't a *net* stall (a
 * down/lagging indexer or a halted chain is reported, not alerted).
 */
export function classifyNetLiveness(inputs: NetLivenessInputs): NetLivenessResult {
  const { chainHeadBlock, prevChainHeadBlock, latestActivityBlock, indexerHeadBlock, thresholdBlocks } =
    inputs;
  const threshold = BigInt(thresholdBlocks);
  const staleForBlocks = chainHeadBlock - (latestActivityBlock ?? 0n);

  // 1. Indexer unreachable — we have no indexed-activity truth to compare.
  if (indexerHeadBlock === null) {
    return {
      state: 'indexer-down',
      staleForBlocks,
      reason: 'indexer /status unreachable; cannot cross-reference indexed activity',
    };
  }

  // 2. Indexer reachable but far behind chain head — its activity reads are
  //    stale-by-construction, so absence of recent activity proves nothing.
  if (chainHeadBlock - indexerHeadBlock > threshold) {
    return {
      state: 'indexer-lagging',
      staleForBlocks,
      reason: `indexer head ${indexerHeadBlock} is ${chainHeadBlock - indexerHeadBlock} blocks behind chain head ${chainHeadBlock}`,
    };
  }

  // 3. Chain head did not advance between the two reads — a halted chain has no
  //    new blocks to carry activity, so this is not a net stall.
  if (prevChainHeadBlock !== null && chainHeadBlock <= prevChainHeadBlock) {
    return {
      state: 'chain-halted',
      staleForBlocks,
      reason: `chain head did not advance (${prevChainHeadBlock} → ${chainHeadBlock})`,
    };
  }

  // 4. Chain advancing + indexer caught up, but no recent indexed activity →
  //    the #1038 silent-stall signature. ALERT.
  if (latestActivityBlock === null || staleForBlocks > threshold) {
    return {
      state: 'stale',
      staleForBlocks,
      reason:
        latestActivityBlock === null
          ? 'no indexed attempt/verdict found at all'
          : `last indexed activity at block ${latestActivityBlock} is ${staleForBlocks} blocks behind chain head ${chainHeadBlock}`,
    };
  }

  // 5. Recent activity within threshold.
  return {
    state: 'healthy',
    staleForBlocks,
    reason: `last indexed activity ${staleForBlocks} blocks behind chain head (under ${thresholdBlocks})`,
  };
}

// ── Alert payload + orchestrator ─────────────────────────────────────────────

/**
 * Generic incoming-webhook payload. `text` makes it Slack-incoming-webhook
 * compatible; the structured fields ride alongside for any consumer that reads
 * JSON. bigints are serialized as strings (bigint is not JSON-serializable).
 */
export interface NetLivenessAlertPayload {
  text: string;
  state: NetLivenessState;
  staleForBlocks: string;
  staleForMinutes: number;
  chainHeadBlock: string;
  latestActivityBlock: string | null;
  runAt: string;
}

export interface NetLivenessProbeDeps {
  /** Read the current chain head via RPC. Called twice per run. */
  fetchChainHead: () => Promise<bigint>;
  /** Newest indexed attempt/verdict block, or null if none / unreadable. */
  fetchLatestActivityBlock: () => Promise<bigint | null>;
  /** The indexer's own indexed head, or null if unreachable. */
  fetchIndexerHeadBlock: () => Promise<bigint | null>;
  /** POST an alert, or null to disable alerting (NO-OP). */
  postWebhook: ((payload: NetLivenessAlertPayload) => Promise<void>) | null;
  thresholdMinutes: number;
  /**
   * Sleep between the two chain-head reads so a healthy chain has time to mint
   * a new block. Injected (no-op in tests) so the orchestrator is testable
   * without a real wall-clock wait.
   */
  sleep: (ms: number) => Promise<void>;
  /**
   * Delay between the two head samples. Default ~4s — above Base's ~2s blocktime
   * so a live chain advances at least one block between reads, and above viem's
   * 4s default cache window so even a cached read can't alias the two samples.
   */
  headSampleDelayMs?: number;
  now: () => Date;
}

/** Default delay between the two chain-head samples (ms). See headSampleDelayMs. */
export const DEFAULT_HEAD_SAMPLE_DELAY_MS = 4_000;

/**
 * Run one probe: read chain head twice (to detect advancement within the run),
 * read the indexer head and latest activity (tolerating throws as
 * indexer-down), classify, and POST an alert only when the state is `stale` and
 * a webhook is configured. Never throws on a read failure; returns the
 * classification for the caller to log.
 */
export async function runNetLivenessProbe(
  deps: NetLivenessProbeDeps,
): Promise<NetLivenessResult> {
  // Sample the chain head twice, separated by a real delay, so a healthy chain
  // has time to mint a new block between reads. Without the gap both reads land
  // in the same block (and viem caches getBlockNumber for ~4s), making the two
  // samples identical → the classifier would always read `chain-halted` and the
  // alert branch would be unreachable.
  const prevChainHeadBlock = await deps.fetchChainHead();
  await deps.sleep(deps.headSampleDelayMs ?? DEFAULT_HEAD_SAMPLE_DELAY_MS);
  const chainHeadBlock = await deps.fetchChainHead();

  // A throw on either indexer read means the indexer is unhealthy — we cannot
  // cross-reference indexed activity, so the run reports indexer-down rather than
  // crashing or mistaking an error for a genuine stall. Distinguish a *throw* (the
  // reader itself failed) from a clean null (the indexer answered "no rows"): only
  // the former is indexer-down. A failed activity read therefore forces the
  // indexer head to be treated as unreadable too, so the classifier short-circuits
  // to indexer-down (decision-order step 1) before it can read the empty activity
  // as `stale`.
  const indexerHead = await safeRead(deps.fetchIndexerHeadBlock);
  const activity = await safeRead(deps.fetchLatestActivityBlock);
  const indexerHeadBlock = indexerHead.threw || activity.threw ? null : indexerHead.value;
  const latestActivityBlock = activity.value;

  const result = classifyNetLiveness({
    chainHeadBlock,
    prevChainHeadBlock,
    latestActivityBlock,
    indexerHeadBlock,
    thresholdBlocks: minutesToThresholdBlocks(deps.thresholdMinutes),
  });

  if (result.state === 'stale' && deps.postWebhook) {
    const staleForMinutes = Math.round(Number(result.staleForBlocks) / BASE_BLOCKS_PER_MINUTE);
    const runAt = deps.now().toISOString();
    const payload: NetLivenessAlertPayload = {
      text:
        `Jinn net-liveness alert: no on-chain attempt/verdict indexed for ` +
        `~${staleForMinutes} min (${result.staleForBlocks} blocks). ` +
        `Chain head ${chainHeadBlock} is advancing and the indexer is caught up, ` +
        `so this is a network stall, not an indexer outage. ${result.reason}`,
      state: result.state,
      staleForBlocks: result.staleForBlocks.toString(),
      staleForMinutes,
      chainHeadBlock: chainHeadBlock.toString(),
      latestActivityBlock: latestActivityBlock === null ? null : latestActivityBlock.toString(),
      runAt,
    };
    await deps.postWebhook(payload);
  }

  return result;
}

async function safeRead(
  read: () => Promise<bigint | null>,
): Promise<{ value: bigint | null; threw: boolean }> {
  try {
    return { value: await read(), threw: false };
  } catch {
    return { value: null, threw: true };
  }
}

// ── Indexer readers ──────────────────────────────────────────────────────────

/**
 * Per-request timeout for every indexer fetch. Mirrors http.ts: a never-settling
 * fetch (half-open socket mid-redeploy) is bounded so a hang becomes a null read,
 * not a wedged probe.
 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Read the indexer's own indexed head via Ponder's host-root `/status` endpoint.
 * `/status` returns `{ <chainName>: { id, block: { number, timestamp } } }`; we
 * take the first chain entry's block number. Returns null on any failure or
 * shape mismatch — the probe classifies null as indexer-down.
 */
export async function fetchIndexerHeadBlock(args: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<bigint | null> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  // `/status` is served at the host root, not under `/graphql` (mirror http.ts).
  const statusUrl = `${args.baseUrl.replace(/\/graphql\/?$/, '').replace(/\/$/, '')}/status`;
  try {
    const res = await fetchImpl(statusUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, { block?: { number?: number } } | undefined>;
    for (const chain of Object.values(body)) {
      const n = chain?.block?.number;
      if (typeof n === 'number' && Number.isFinite(n)) return BigInt(Math.trunc(n));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the newest indexed activity block — the max `createdAtBlock` across the
 * latest verdict and the latest attempt (NOT task: a posted-but-unclaimed task is
 * itself the stall condition). Two `limit:1` descending GraphQL queries. Returns
 * null if both legs are empty, or on any failure / error-envelope — never throws.
 */
export async function fetchLatestActivityBlock(args: {
  gqlUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<bigint | null> {
  const [verdict, attempt] = await Promise.all([
    latestBlockFor(args, 'verdicts'),
    latestBlockFor(args, 'attempts'),
  ]);
  if (verdict === null && attempt === null) return null;
  return maxNullable(verdict, attempt);
}

async function latestBlockFor(
  args: { gqlUrl: string; fetchImpl?: typeof fetch },
  field: 'verdicts' | 'attempts',
): Promise<bigint | null> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const query = `query LatestActivity {
  ${field}(orderBy: "createdAtBlock", orderDirection: "desc", limit: 1) {
    items { createdAtBlock }
  }
}`;
  try {
    const res = await fetchImpl(args.gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Record<string, { items?: { createdAtBlock?: string | number }[] }>;
      errors?: unknown[];
    };
    if (json.errors?.length || !json.data) return null;
    const items = json.data[field]?.items ?? [];
    const raw = items[0]?.createdAtBlock;
    if (raw === undefined || raw === null) return null;
    return BigInt(raw);
  } catch {
    return null;
  }
}

function maxNullable(a: bigint | null, b: bigint | null): bigint | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

// ── Webhook POST helper ──────────────────────────────────────────────────────

/**
 * Build the `postWebhook` seam. Returns null when no URL is configured (NO-OP —
 * the probe still classifies and logs, it just never alerts). The returned
 * function POSTs the JSON payload to a generic incoming webhook.
 */
export function postNetLivenessWebhook(
  url: string | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
): ((payload: NetLivenessAlertPayload) => Promise<void>) | null {
  if (!url) return null;
  return async (payload: NetLivenessAlertPayload) => {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  };
}
