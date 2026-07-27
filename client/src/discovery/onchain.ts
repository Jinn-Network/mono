/**
 * OnchainDiscoveryAPI — always-live floor implementation of DiscoveryAPI.
 *
 * Implements all four DiscoveryAPI methods backed by viem `getLogs` RPC reads
 * against JinnRouter and IdentityRegistry contracts. No indexer required;
 * this is the floor that keeps the daemon functional during indexer outages.
 *
 * Design choices:
 *
 * - `findClaimableTasks` enumerates `TaskCreated` events from a known start
 *   block, filters by manifest digest(s), then multicalls `canClaimTask` in
 *   parallel batches to check current claimability. Attempt counts are derived
 *   from `TaskAttemptCreated` event logs grouped client-side.
 *
 * - `listLaunchedSolverNets` / `getLifecycleStatus` read `MetadataSet` events
 *   from IdentityRegistry (key prefix `solvernet-manifest:`) and fold via the
 *   existing `resolveMostRecentWins` helper.
 *
 * - `listPluginPublications` / `listBuilderArtifacts` read `MetadataSet` events
 *   (key prefix `plugin:`), decode the on-chain PLUGIN_PAYLOAD_TUPLE /
 *   REVOCATION_PAYLOAD_TUPLE, and fold most-recent-wins so the operator app's
 *   /build registry panels keep rendering during an indexer outage (gh#290).
 *
 * - `queryEnvelopes` delegates to the existing `runOnchainCorpusQuery`.
 *
 * - `cursorCache` is an optional injection point: when provided, the start
 *   block for future scans is advanced to the current head after each
 *   successful scan, so repeated calls avoid re-scanning history.
 *
 * Spec: spec/2026-05-11-discovery-api-and-shared-indexer.md §6.3.
 */

import {
  createPublicClient,
  decodeAbiParameters,
  decodeEventLog,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { DiscoveryAPI, ClaimableTaskCandidate, InstanceClaimCount, TaskStatusSnapshot, VerdictTallyResult, TaskLifecycleEvidence, SolverNetManifestSummary, SolverNetLifecycleStatus, PluginPublication, PluginScoreHistoryRow, PublishedArtifact, CodeDigestRewardRow, TaskPostCounts, AutopilotDeliveryRole, AutopilotDeliveryCandidateLookup } from './types.js';
import { DiscoveryUnavailableError, TASK_POST_WINDOW_BLOCKS, bucketTaskPostCounts } from './types.js';
import type { EnvelopeRef, CorpusQuery } from '../corpus/types.js';
import { runOnchainCorpusQuery, DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK } from '../corpus/onchain-query.js';
import { JINN_ROUTER_ABI } from '../adapters/mech/types.js';
import { JINN_ROUTER_ADDRESSES, IDENTITY_REGISTRY_ADDRESSES } from '../contracts/addresses.js';
import {
  canClaimTask,
  ROUTER_TASK_ATTEMPT_CREATED_EVENT,
  ROUTER_TASK_BUDGET_REFUNDED_EVENT,
  ROUTER_TASK_CREATED_EVENT,
  ROUTER_VERDICT_DELIVERY_CLAIMED_EVENT,
} from '../adapters/mech/contracts.js';
import { manifestDigestForCid } from '../adapters/mech/digest.js';
import { assembleTaskLifecycleEvidence } from './task-lifecycle-evidence.js';
import type { RawAttemptRow, RawTaskRow, RawVerdictRow } from './task-lifecycle-evidence.js';
import { resolveMostRecentWins, type SetMetadataEvent, type SetMetadataLifecyclePayload } from '../solvernets/most-recent-wins.js';
import { isRateLimitedEthReadError, withTransientEthReadRetry } from '../chain-read-errors.js';
import { PLUGIN_PAYLOAD_TUPLE, REVOCATION_PAYLOAD_TUPLE } from '../erc8004/abis.js';
import { PLUGIN_METADATA_KEY_PREFIX } from '../erc8004/plugin-registry.js';

/**
 * Wrap an RPC read failure into a `DiscoveryUnavailableError`, preserving a
 * typed `rpc_rate_limited` code when the underlying error is a 429 / "too many
 * requests". The shared default RPC throttles the whole operator pool; without
 * this signal a throttle is indistinguishable from any other transport failure
 * and the operator UI cannot tell them to add their own key. See jinn-mono #325.
 */
function discoveryUnavailableFromReadError(
  message: string,
  cause: unknown,
): DiscoveryUnavailableError {
  return new DiscoveryUnavailableError(
    message,
    cause,
    isRateLimitedEthReadError(cause) ? 'rpc_rate_limited' : undefined,
  );
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;
// 1999-block chunks: the public Base / Base Sepolia RPCs (the default fallback
// `rpcUrl`) cap `eth_getLogs` at a 2000-block range. Daemons configured with a
// higher-limit RPC can override via `chunkBlocks`, but the default must work
// against the bare public endpoint since this is the always-live fallback floor.
const DEFAULT_CHUNK_BLOCKS = 1_999n;

/** Concurrency cap for parallel canClaimTask calls. */
const CLAIM_CHECK_CONCURRENCY = 8;

/**
 * Hard cap on the number of getLogs chunks `getSolverNetOperatorCount` scans
 * per pass. Bounds the dashboard's recurring operator-count poll so it cannot
 * walk unbounded chain history; past the cap the count is a lower bound. See
 * `DiscoveryAPI.getSolverNetOperatorCount`. The HTTP backing's sibling cap is
 * `MAX_OPERATOR_COUNT_TASK_PAGES` in `http.ts`.
 */
const MAX_OPERATOR_COUNT_TASK_PAGES = 50;

/**
 * Hard cap on getLogs chunks `getTaskPostCounts` scans per pass. 50 × ~1999
 * blocks ≫ the 43,200-block 24h window, so the cap never truncates the window.
 * The HTTP backing's sibling cap is `MAX_TASK_POST_PAGES` in `http.ts`.
 */
const MAX_TASK_POST_COUNT_SCAN_PAGES = 50;

const SOLVERNET_MANIFEST_KEY_PREFIX = 'solvernet-manifest:';

/** The 24h window as a bigint, for the on-chain scan-range floor (the shared
 * numeric `TASK_POST_WINDOW_BLOCKS` drives the bucketing). */
const TASK_POST_24H_BLOCKS = BigInt(TASK_POST_WINDOW_BLOCKS.h24);

// ── ABI fragments ─────────────────────────────────────────────────────────────

const IDENTITY_METADATA_ABI = [
  {
    type: 'event',
    name: 'MetadataSet',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'indexedMetadataKey', type: 'string', indexed: true },
      { name: 'metadataKey', type: 'string', indexed: false },
      { name: 'metadataValue', type: 'bytes', indexed: false },
    ],
  },
] as const;

// ── Options ───────────────────────────────────────────────────────────────────

export interface OnchainCursorCache {
  /** Highest block scanned for a given label. Returns null if never scanned. */
  read(label: string): bigint | null;
  /** Persist highest block scanned. */
  write(label: string, block: bigint): void;
}

/**
 * Operator context required by findClaimableTasks. Optional because other
 * DiscoveryAPI methods (listLaunchedSolverNets, getLifecycleStatus,
 * queryEnvelopes) do not need them. If absent, findClaimableTasks throws
 * DiscoveryUnavailableError.
 */
export interface OnchainDiscoveryAPIOptions {
  rpcUrl?: string;
  chainId: number;
  /** JinnRouter proxy address. Defaults to chain-specific well-known address. */
  routerAddress?: `0x${string}`;
  /** IdentityRegistry address. Defaults to chain-specific well-known address. */
  identityRegistryAddress?: `0x${string}`;
  /** Operator Safe multisig address. Required by findClaimableTasks for canClaimTask simulation. */
  safeAddress?: `0x${string}`;
  /** Operator priority mech contract address. Required by findClaimableTasks for canClaimTask simulation. */
  mechAddress?: `0x${string}`;
  /** Lower bound block for TaskCreated / MetadataSet scans. Defaults to chain-specific well-known block. */
  taskDiscoveryFromBlock?: bigint | number;
  /** Block range per getLogs chunk. Default: 9999. */
  chunkBlocks?: bigint | number;
  /** Optional pre-built viem PublicClient (for testing). */
  publicClient?: PublicClient;
  /** Optional cursor cache to avoid re-scanning history on repeated calls. */
  cursorCache?: OnchainCursorCache;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function chainForId(chainId: number) {
  return chainId === 84532 ? baseSepolia : base;
}

function toBigInt(value: bigint | number | undefined, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  if (typeof value === 'bigint') return value;
  return BigInt(Math.max(0, Math.floor(value)));
}

/**
 * Resolve the start block for a scan. Priority order:
 *  1. cursorCache.read(label) — advance past already-scanned history
 *  2. opts.taskDiscoveryFromBlock — explicit override
 *  3. DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK[chainId] — chain default
 *  4. currentBlock (no history)
 */
function resolveFromBlock(
  opts: OnchainDiscoveryAPIOptions,
  cursorLabel: string,
  currentBlock: bigint,
): bigint {
  // Cursor takes priority — avoid re-scanning history
  const cached = opts.cursorCache?.read(cursorLabel);
  if (cached !== null && cached !== undefined) {
    return cached > currentBlock ? currentBlock : cached;
  }

  const defaultFromBlock =
    DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK[opts.chainId] ?? currentBlock;

  return toBigInt(opts.taskDiscoveryFromBlock, defaultFromBlock);
}

/**
 * Resolve the start block for a scan that must always see full history,
 * deliberately ignoring `cursorCache`. Used by `scanPluginMetadataEvents`:
 * `foldPluginPublications` re-folds from scratch each call, so a cursor would
 * cause latent data-loss (every publication before the cursor would vanish).
 * Priority order:
 *  1. opts.taskDiscoveryFromBlock — explicit override
 *  2. DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK[chainId] — chain default
 *  3. currentBlock (no history)
 */
function resolveScanFromBlock(
  opts: OnchainDiscoveryAPIOptions,
  currentBlock: bigint,
): bigint {
  const defaultFromBlock =
    DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK[opts.chainId] ?? currentBlock;
  return toBigInt(opts.taskDiscoveryFromBlock, defaultFromBlock);
}

/** Decode a MetadataSet log into a SetMetadataEvent or null if not a solvernet-manifest event. */
function decodeSolvernetMetadataLog(log: {
  data: Hex;
  topics: readonly Hex[];
  blockNumber: bigint | null;
  transactionIndex: number | null;
}): SetMetadataEvent | null {
  let decoded: {
    eventName: 'MetadataSet';
    args: {
      agentId: bigint;
      metadataKey: string;
      metadataValue: Hex;
    };
  };
  try {
    decoded = decodeEventLog({
      abi: IDENTITY_METADATA_ABI,
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    }) as typeof decoded;
  } catch {
    return null;
  }

  if (decoded.eventName !== 'MetadataSet') return null;
  if (!decoded.args.metadataKey.startsWith(SOLVERNET_MANIFEST_KEY_PREFIX)) return null;

  // Decode the lifecycle payload — it's JCS-canonical UTF-8 JSON
  let payload: SetMetadataLifecyclePayload;
  try {
    const text = new TextDecoder().decode(
      Buffer.from(decoded.args.metadataValue.slice(2), 'hex'),
    );
    payload = JSON.parse(text) as SetMetadataLifecyclePayload;
    if (!payload.status || !payload.at || !payload.hash) return null;
  } catch {
    return null;
  }

  return {
    agentId: decoded.args.agentId.toString(),
    key: decoded.args.metadataKey,
    payload,
    blockNumber: Number(log.blockNumber ?? 0n),
    transactionIndex: log.transactionIndex ?? 0,
  };
}

// ── Plug-in publication on-chain floor ────────────────────────────────────────
//
// The on-chain floor enumerates `plugin:<cid>` MetadataSet events directly so
// the operator app's /build registry panels keep rendering during an indexer
// outage. The indexer's `pluginPublication` entity is the rich source (it also
// IPFS-enriches); this floor decodes the same on-chain payload tuples
// (PLUGIN_PAYLOAD_TUPLE / REVOCATION_PAYLOAD_TUPLE) without the IPFS hop, then
// folds most-recent-wins by (blockNumber, transactionIndex, logIndex).

/**
 * A decoded `plugin:<cid>` MetadataSet event. `kind` discriminates a v1
 * publish (carries the full payload) from a v2 revocation (carries only the
 * reason). Provenance fields drive the most-recent-wins fold.
 */
interface PluginMetadataEvent {
  agentId: string;
  pluginCid: string;
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
  kind: 'publish' | 'revoke';
  /** v1-publish fields — present only when kind === 'publish'. */
  publish?: {
    pluginName: string;
    pluginVersion: string;
    pluginSha256: `0x${string}`;
    supports: readonly string[];
    publishedAt: number;
  };
  /** v2-revocation reason — present only when kind === 'revoke'. */
  revokedReason?: string;
}

/**
 * Decode a MetadataSet log into a PluginMetadataEvent, or null if the key is
 * not a `plugin:` key or the payload decodes to neither a v1-publish nor a
 * v2-revocation tuple. Mirrors `decodeSolvernetMetadataLog`.
 */
function decodePluginMetadataLog(log: {
  data: Hex;
  topics: readonly Hex[];
  blockNumber: bigint | null;
  transactionIndex: number | null;
  logIndex: number | null;
}): PluginMetadataEvent | null {
  let decoded: {
    eventName: 'MetadataSet';
    args: { agentId: bigint; metadataKey: string; metadataValue: Hex };
  };
  try {
    decoded = decodeEventLog({
      abi: IDENTITY_METADATA_ABI,
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    }) as typeof decoded;
  } catch {
    return null;
  }

  if (decoded.eventName !== 'MetadataSet') return null;
  if (!decoded.args.metadataKey.startsWith(PLUGIN_METADATA_KEY_PREFIX)) return null;

  const pluginCid = decoded.args.metadataKey.slice(PLUGIN_METADATA_KEY_PREFIX.length);
  if (pluginCid.length === 0) return null;

  const base = {
    agentId: decoded.args.agentId.toString(),
    pluginCid,
    blockNumber: log.blockNumber ?? 0n,
    transactionIndex: log.transactionIndex ?? 0,
    logIndex: log.logIndex ?? 0,
  };

  // Try v1 publish first; on failure fall back to v2 revocation. Garbage
  // payloads decode to neither and are dropped (return null).
  try {
    const d = decodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, decoded.args.metadataValue);
    if (Number(d[0]) === 1) {
      return {
        ...base,
        kind: 'publish',
        publish: {
          pluginName: d[1],
          pluginVersion: d[2],
          pluginSha256: d[3],
          supports: d[4],
          publishedAt: Number(d[5]),
        },
      };
    }
  } catch {
    // not a v1 payload — try v2 below
  }
  try {
    const d = decodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, decoded.args.metadataValue);
    if (Number(d[0]) === 2 && d[1] === true) {
      return { ...base, kind: 'revoke', revokedReason: d[2] };
    }
  } catch {
    // not a v2 payload either
  }
  return null;
}

/**
 * The chain-attested provenance anchor for a folded publication. Carried
 * alongside the public `PluginPublication` shape so `listPluginPublications`
 * can sort by `(blockNumber, transactionIndex, logIndex) desc` for true
 * parity with the HTTP layer's `orderBy: blockNumber` without widening the
 * public result type.
 */
interface PluginPublicationAnchor {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
}

/**
 * Fold a stream of plug-in MetadataSet events into the latest state per
 * `<agentId>:<pluginCid>` key, most-recent-wins by
 * (blockNumber, transactionIndex, logIndex). A v2 revocation only mutates the
 * `revoked` / `revokedReason` fields of an existing publish; a revocation with
 * no prior publish is meaningless and dropped (no row materialised).
 *
 * Returns the materialised rows plus an `anchors` map keyed by row identity,
 * so callers can sort by the chain-attested anchor.
 */
function foldPluginPublications(events: PluginMetadataEvent[]): {
  rows: PluginPublication[];
  anchors: Map<PluginPublication, PluginPublicationAnchor>;
} {
  interface Folded {
    agentId: string;
    pluginCid: string;
    blockNumber: bigint;
    transactionIndex: number;
    logIndex: number;
    pluginName: string;
    pluginVersion: string;
    pluginSha256: `0x${string}`;
    supports: readonly string[];
    publishedAt: number;
    revoked: boolean;
    revokedReason?: string;
  }
  const byKey = new Map<string, Folded>();

  const isNewer = (e: PluginMetadataEvent, row: Folded): boolean =>
    e.blockNumber > row.blockNumber ||
    (e.blockNumber === row.blockNumber && e.transactionIndex > row.transactionIndex) ||
    (e.blockNumber === row.blockNumber &&
      e.transactionIndex === row.transactionIndex &&
      e.logIndex > row.logIndex);

  for (const e of events) {
    const key = `${e.agentId}:${e.pluginCid}`;
    const existing = byKey.get(key);

    if (e.kind === 'publish' && e.publish) {
      // A republish un-revokes (revoked resets to false), matching the
      // indexer's handleMetadataSet v1 path.
      if (!existing || isNewer(e, existing)) {
        byKey.set(key, {
          agentId: e.agentId,
          pluginCid: e.pluginCid,
          blockNumber: e.blockNumber,
          transactionIndex: e.transactionIndex,
          logIndex: e.logIndex,
          pluginName: e.publish.pluginName,
          pluginVersion: e.publish.pluginVersion,
          pluginSha256: e.publish.pluginSha256,
          supports: e.publish.supports,
          publishedAt: e.publish.publishedAt,
          revoked: false,
          revokedReason: undefined,
        });
      }
      continue;
    }

    // revoke — only valid against an existing publish, and only if newer.
    if (e.kind === 'revoke' && existing && isNewer(e, existing)) {
      existing.revoked = true;
      existing.revokedReason = e.revokedReason;
      existing.blockNumber = e.blockNumber;
      existing.transactionIndex = e.transactionIndex;
      existing.logIndex = e.logIndex;
    }
  }

  const rows: PluginPublication[] = [];
  const anchors = new Map<PluginPublication, PluginPublicationAnchor>();
  for (const row of byKey.values()) {
    const out: PluginPublication = {
      artifactType: 'plugin',
      builderAgentId: row.agentId,
      cid: row.pluginCid,
      name: row.pluginName,
      version: row.pluginVersion,
      supports: row.supports,
      publishedAt: row.publishedAt,
      pluginSha256: row.pluginSha256,
      revoked: row.revoked,
    };
    if (row.revokedReason !== undefined) out.revokedReason = row.revokedReason;
    rows.push(out);
    anchors.set(out, {
      blockNumber: row.blockNumber,
      transactionIndex: row.transactionIndex,
      logIndex: row.logIndex,
    });
  }
  return { rows, anchors };
}

/**
 * Scan logs in chunks. When `maxResults` is provided, scans newest-first
 * (from `toBlock` down to `fromBlock`) and stops as soon as `maxResults`
 * items have been accumulated — avoiding scanning the entire history when
 * only a bounded result set is needed. Without `maxResults`, scans
 * oldest-first (standard order).
 *
 * When `maxChunks` is provided, the oldest-first scan stops after at most
 * `maxChunks` getLogs round-trips. This bounds a recurring caller (e.g. the
 * dashboard's operator-count poll) so it cannot walk unbounded history; past
 * the cap the result set is a prefix of the full range.
 */
async function scanLogsInChunks<T>(
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  chunkBlocks: bigint,
  maxResults?: number,
  maxChunks?: number,
): Promise<T[]> {
  const results: T[] = [];

  if (maxResults !== undefined) {
    // Newest-first scan with early exit. Each chunk is [start, end] inclusive,
    // i.e. `chunkBlocks` blocks wide (one fewer than the oldest-first branch's
    // `chunkBlocks + 1`); this is harmless — `end = start - 1n` on the next
    // iteration means chunks neither overlap nor skip blocks at the boundary —
    // and not worth complicating the index arithmetic to make symmetric.
    for (let end = toBlock; end >= fromBlock && results.length < maxResults; ) {
      const start = end > chunkBlocks && end - chunkBlocks + 1n > fromBlock
        ? end - chunkBlocks + 1n
        : fromBlock;
      const chunk = await getLogs(start, end);
      results.push(...chunk);
      if (start === fromBlock) break;
      end = start - 1n;
    }
  } else {
    // Oldest-first scan. Each chunk is [start, start + chunkBlocks] inclusive,
    // and the next iteration starts at `start + chunkBlocks + 1n` — no overlap,
    // no gap.
    let chunksScanned = 0;
    for (let start = fromBlock; start <= toBlock; start += chunkBlocks + 1n) {
      if (maxChunks !== undefined && chunksScanned >= maxChunks) break;
      const end = start + chunkBlocks > toBlock ? toBlock : start + chunkBlocks;
      const chunk = await getLogs(start, end);
      results.push(...chunk);
      chunksScanned += 1;
    }
  }

  return results;
}

/**
 * Run a list of async tasks with a concurrency cap.
 *
 * Tasks are responsible for handling their own errors and returning a
 * result-shaped value (e.g. `{ ok: false }` on failure). If a task throws
 * anyway, the slot is silently released and processing continues — the thrown
 * result is not included in the output array.
 *
 * @internal Exported for unit testing only.
 */
export async function limitedConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  const queue = [...tasks];

  async function runNext(): Promise<void> {
    const task = queue.shift();
    if (!task) return;
    try {
      results.push(await task());
    } catch {
      // task threw; slot continues processing queue
    }
    await runNext();
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates an `OnchainDiscoveryAPI` instance backed by viem `getLogs`.
 *
 * This is the always-live floor: no indexer required, works as long as the
 * configured RPC endpoint is reachable.
 */
export function createOnchainDiscoveryAPI(opts: OnchainDiscoveryAPIOptions): DiscoveryAPI {
  const routerAddress: Address = (opts.routerAddress ??
    JINN_ROUTER_ADDRESSES[opts.chainId]) as Address;

  const identityRegistryAddress: Address | undefined = (opts.identityRegistryAddress ??
    IDENTITY_REGISTRY_ADDRESSES[opts.chainId]) as Address | undefined;

  const chunk = toBigInt(opts.chunkBlocks, DEFAULT_CHUNK_BLOCKS);

  function getClient(): Pick<PublicClient, 'getBlockNumber' | 'getLogs' | 'simulateContract'> {
    return opts.publicClient ?? createPublicClient({
      chain: chainForId(opts.chainId),
      transport: http(opts.rpcUrl),
    });
  }

  function getAutopilotDeliveryCandidates(args: {
    chainId: number;
    taskId: string;
    role: AutopilotDeliveryRole;
  }): Promise<AutopilotDeliveryCandidateLookup> {
    return Promise.resolve({
      status: 'pending',
      reason: 'exact-indexer-required',
      taskId: args.taskId,
      role: args.role,
    });
  }

  // ── findClaimableTasks ─────────────────────────────────────────────────────

  async function findClaimableTasks(args: {
    solverNetManifestCids: string[];
    operatorAddress: `0x${string}`;
    nowSeconds?: number;
    pageSize?: number;
    maxPages?: number;
  }): Promise<ClaimableTaskCandidate[]> {
    if (!opts.safeAddress || !opts.mechAddress) {
      throw new DiscoveryUnavailableError(
        'OnchainDiscoveryAPI.findClaimableTasks requires safeAddress and mechAddress in options',
      );
    }

    const manifestCids = Array.from(new Set(args.solverNetManifestCids.filter(Boolean)));
    if (manifestCids.length === 0) return [];
    if (!routerAddress) throw new DiscoveryUnavailableError(
      `OnchainDiscoveryAPI: no routerAddress configured for chainId=${opts.chainId}`,
    );

    const pageSize = Math.min(100, Math.max(1, args.pageSize ?? DEFAULT_PAGE_SIZE));
    const maxPages = Math.max(1, args.maxPages ?? DEFAULT_MAX_PAGES);
    const maxResults = pageSize * maxPages;

    const client = getClient();

    let currentBlock: bigint;
    try {
      currentBlock = await (client as PublicClient).getBlockNumber();
    } catch (err) {
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI.findClaimableTasks: failed to get block number`,
        err,
      );
    }

    const fromBlock = resolveFromBlock(opts, 'tasks', currentBlock);

    // Compute manifest digests for each CID
    const manifestDigests = manifestCids.map((cid) => ({
      cid,
      digest: manifestDigestForCid(cid).toLowerCase() as Hex,
    }));
    const digestSet = new Set(manifestDigests.map((d) => d.digest));

    // Scan TaskCreated events
    let taskCreatedLogs: Array<{
      taskId: string;
      taskCidDigest: Hex;
      manifestDigest: Hex;
      maxClaims: number;
      blockNumber: number;
      transactionHash?: Hex;
    }>;
    try {
      taskCreatedLogs = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: routerAddress,
            event: ROUTER_TASK_CREATED_EVENT,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: typeof taskCreatedLogs = [];
          for (const log of logs) {
            try {
              const event = decodeEventLog({
                abi: JINN_ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (event.eventName !== 'TaskCreated') continue;
              const evArgs = event.args as {
                taskId: bigint;
                taskCidDigest: Hex;
                manifestDigest: Hex;
                maxClaims: number;
              };
              const digestLower = (evArgs.manifestDigest as string).toLowerCase() as Hex;
              if (!digestSet.has(digestLower)) continue;
              decoded.push({
                taskId: String(evArgs.taskId),
                taskCidDigest: evArgs.taskCidDigest,
                manifestDigest: evArgs.manifestDigest,
                maxClaims: Number(evArgs.maxClaims),
                blockNumber: log.blockNumber != null ? Number(log.blockNumber) : 0,
                transactionHash: log.transactionHash ?? undefined,
              });
            } catch {
              // Not a TaskCreated event or decode error — skip
            }
          }
          return decoded;
        },
        fromBlock,
        currentBlock,
        chunk,
        maxResults,
      );
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI.findClaimableTasks: getLogs for TaskCreated failed`,
        err,
      );
    }

    // De-duplicate by taskId (keep first occurrence)
    const seen = new Set<string>();
    const uniqueTasks = taskCreatedLogs.filter((t) => {
      if (seen.has(t.taskId)) return false;
      seen.add(t.taskId);
      return true;
    });

    // Cap the candidate set BEFORE the canClaimTask fan-out: scanLogsInChunks
    // accumulates whole getLogs chunks, so taskCreatedLogs can be far larger
    // than maxResults. Without this trim, findClaimableTasks would run a
    // simulateContract RPC (at concurrency CLAIM_CHECK_CONCURRENCY) on every
    // scanned TaskCreated row before any cap applies. The scan ran newest-first
    // (see scanLogsInChunks), so the head of `uniqueTasks` is the newest tasks —
    // keep those. Note this differs from the subgraph's server-side window
    // filter; here we approximate it with a client-side newest-first cap.
    const cappedTasks = uniqueTasks.slice(0, maxResults);

    // Apply canClaimTask eligibility checks (safeAddress + mechAddress validated above)
    const eligibleTasks: typeof cappedTasks = [];

    const safeAddress = opts.safeAddress as Address;
    const mechAddress = opts.mechAddress as Address;

    const checkTasks = cappedTasks.map((task) => async () => {
      try {
        const result = await canClaimTask(
          client as PublicClient,
          safeAddress,
          routerAddress,
          task.taskId,
          mechAddress,
        );
        return { task, ok: result.ok };
      } catch {
        return { task, ok: false };
      }
    });

    const claimCheckResults = await limitedConcurrency(checkTasks, CLAIM_CHECK_CONCURRENCY);
    for (const r of claimCheckResults) {
      if (r.ok) eligibleTasks.push(r.task);
    }

    // Get attempt counts via TaskAttemptCreated events for eligible tasks
    let attemptLogs: Array<{ taskId: string; operator: string }>;
    try {
      const eligibleTaskIds = new Set(eligibleTasks.map((t) => t.taskId));
      attemptLogs = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: routerAddress,
            event: ROUTER_TASK_ATTEMPT_CREATED_EVENT,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: Array<{ taskId: string; operator: string }> = [];
          for (const log of logs) {
            try {
              const event = decodeEventLog({
                abi: JINN_ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (event.eventName !== 'TaskAttemptCreated') continue;
              const evArgs = event.args as { taskId: bigint; operator: Address };
              const taskIdStr = String(evArgs.taskId);
              if (!eligibleTaskIds.has(taskIdStr)) continue;
              decoded.push({
                taskId: taskIdStr,
                operator: evArgs.operator.toLowerCase(),
              });
            } catch {
              // Not a TaskAttemptCreated event — skip
            }
          }
          return decoded;
        },
        fromBlock,
        currentBlock,
        chunk,
      );
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI.findClaimableTasks: getLogs for TaskAttemptCreated failed`,
        err,
      );
    }

    // Group attempt counts
    const attemptCountByTaskId = new Map<string, number>();
    const operatorAttemptCountByTaskId = new Map<string, number>();
    const operatorLower = args.operatorAddress.toLowerCase();

    for (const attempt of attemptLogs) {
      attemptCountByTaskId.set(
        attempt.taskId,
        (attemptCountByTaskId.get(attempt.taskId) ?? 0) + 1,
      );
      if (attempt.operator === operatorLower) {
        operatorAttemptCountByTaskId.set(
          attempt.taskId,
          (operatorAttemptCountByTaskId.get(attempt.taskId) ?? 0) + 1,
        );
      }
    }

    // Build ClaimableTaskCandidate results
    const results: ClaimableTaskCandidate[] = [];

    for (const task of eligibleTasks) {
      if (results.length >= maxResults) break;

      const normalizedDigest = (task.manifestDigest as string).toLowerCase() as Hex;

      const candidate: ClaimableTaskCandidate = {
        taskId: task.taskId,
        taskCidDigest: task.taskCidDigest,
        manifestDigest: normalizedDigest,
        createdAtBlock: task.blockNumber || undefined,
        createdAtTx: task.transactionHash,
        maxClaims: task.maxClaims > 0 ? task.maxClaims : undefined,
        attemptCount: attemptCountByTaskId.get(task.taskId) ?? 0,
        operatorAttemptCount: operatorAttemptCountByTaskId.get(task.taskId) ?? 0,
      };
      results.push(candidate);
    }

    // Sort by taskId ascending (matches subgraph ordering)
    results.sort((a, b) => Number(BigInt(a.taskId) - BigInt(b.taskId)));

    // Update cursor cache
    opts.cursorCache?.write('tasks', currentBlock);

    return results;
  }

  // ── SolverNet helpers ──────────────────────────────────────────────────────

  async function scanSolvernetMetadataEvents(): Promise<{
    events: SetMetadataEvent[];
    currentBlock: bigint;
  }> {
    if (!identityRegistryAddress) {
      return { events: [], currentBlock: 0n };
    }

    const client = getClient();
    let currentBlock: bigint;
    try {
      currentBlock = await withTransientEthReadRetry(() =>
        (client as PublicClient).getBlockNumber(),
      );
    } catch (err) {
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI: failed to get block number`,
        err,
      );
    }

    const fromBlock = resolveFromBlock(opts, 'solvernets', currentBlock);

    let events: SetMetadataEvent[];
    try {
      events = await scanLogsInChunks(
        async (start, end) =>
          withTransientEthReadRetry(async () => {
            const logs = await (client as PublicClient).getLogs({
              address: identityRegistryAddress,
              fromBlock: start,
              toBlock: end,
            });
            const decoded: SetMetadataEvent[] = [];
            for (const log of logs) {
              const event = decodeSolvernetMetadataLog(log as {
                data: Hex;
                topics: readonly Hex[];
                blockNumber: bigint | null;
                transactionIndex: number | null;
              });
              if (event) decoded.push(event);
            }
            return decoded;
          }),
        fromBlock,
        currentBlock,
        chunk,
      );
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI: getLogs for MetadataSet failed`,
        err,
      );
    }

    // Update cursor cache on success so both listLaunchedSolverNets and
    // getLifecycleStatus advance the scan window after every successful call.
    if (currentBlock > 0n) {
      opts.cursorCache?.write('solvernets', currentBlock);
    }

    return { events, currentBlock };
  }

  // ── listLaunchedSolverNets ─────────────────────────────────────────────────

  async function listLaunchedSolverNets(args?: {
    launcherAgentId?: string;
    status?: Array<'launched' | 'paused' | 'retired'>;
  }): Promise<SolverNetManifestSummary[]> {
    let events: SetMetadataEvent[];

    try {
      const scanned = await scanSolvernetMetadataEvents();
      events = scanned.events;
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.listLaunchedSolverNets: scan failed`,
        err,
      );
    }

    const resolved = resolveMostRecentWins(events);

    // Filter and project into SolverNetManifestSummary
    const out: SolverNetManifestSummary[] = [];
    for (const row of resolved) {
      if (args?.launcherAgentId !== undefined && row.launcherAgentId !== args.launcherAgentId) {
        continue;
      }
      if (args?.status !== undefined && !args.status.includes(row.status)) {
        continue;
      }

      // The on-chain floor cannot fetch manifest bodies from IPFS (that's
      // retrieval, not discovery). We populate only what we can derive
      // from the on-chain events. Fields we can't fill are set to empty/default.
      out.push({
        manifestCid: row.manifestCid,
        solverNetId: row.manifestCid,     // best-effort: cid as id
        name: '',                          // requires IPFS fetch
        network: '',                       // requires IPFS fetch
        launcherAgentId: row.launcherAgentId,
        launcherSafeAddress: '0x0000000000000000000000000000000000000000',
        status: row.status,
        statusUpdatedAt: row.statusUpdatedAt,
        contractId: '',                    // requires IPFS fetch
        contractVersion: '',               // requires IPFS fetch
        solutionPriceWei: '0',            // requires IPFS fetch
        verdictPriceWei: '0',             // requires IPFS fetch
        openRoles: [],                     // requires IPFS fetch
        anchorBlock: row.anchorBlock,
        chainId: opts.chainId,             // issue #985: indexed chain scope
      });
    }

    return out;
  }

  // ── getLifecycleStatus ─────────────────────────────────────────────────────

  async function getLifecycleStatus(manifestCid: string): Promise<SolverNetLifecycleStatus | undefined> {
    let events: SetMetadataEvent[];

    try {
      const scanned = await scanSolvernetMetadataEvents();
      events = scanned.events;
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.getLifecycleStatus: scan failed`,
        err,
      );
    }

    // Filter to events for this specific cid
    const key = `${SOLVERNET_MANIFEST_KEY_PREFIX}${manifestCid}`;
    const cidEvents = events.filter((e) => e.key === key);

    if (cidEvents.length === 0) return undefined;

    const resolved = resolveMostRecentWins(cidEvents);
    if (resolved.length === 0) return undefined;

    // Pick the most-recent across all launchers
    const latest = resolved.reduce((acc, cur) => {
      if (cur.anchorBlock !== acc.anchorBlock) {
        return cur.anchorBlock > acc.anchorBlock ? cur : acc;
      }
      return cur.anchorTransactionIndex > acc.anchorTransactionIndex ? cur : acc;
    });

    return {
      status: latest.status,
      statusUpdatedAt: latest.statusUpdatedAt,
      sourceBlock: latest.anchorBlock,
      manifestHash: latest.manifestHash,
    };
  }

  // ── getSolverNetOperatorCount ──────────────────────────────────────────────

  async function getSolverNetOperatorCount(manifestCid: string): Promise<number> {
    if (!routerAddress) {
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI: no routerAddress configured for chainId=${opts.chainId}`,
      );
    }

    const client = getClient();
    let currentBlock: bigint;
    try {
      currentBlock = await (client as PublicClient).getBlockNumber();
    } catch (err) {
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.getSolverNetOperatorCount: failed to get block number`,
        err,
      );
    }

    // Scan from the execution-discovery floor (not the cursor cache): like
    // listPluginPublications this is a complete-recount call with no
    // accumulator, so it must always see every TaskCreated / TaskAttemptCreated
    // event for the SolverNet. Both passes are capped at
    // MAX_OPERATOR_COUNT_TASK_PAGES getLogs chunks so this recurring poll
    // cannot walk unbounded history; past the cap the count is a lower bound.
    const fromBlock = resolveScanFromBlock(opts, currentBlock);
    const targetDigest = manifestDigestForCid(manifestCid).toLowerCase() as Hex;

    // Pass 1: TaskCreated → the set of task ids belonging to this SolverNet.
    let solverNetTaskIds: Set<string>;
    try {
      const taskIdLists = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: routerAddress,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: string[] = [];
          for (const log of logs) {
            try {
              const event = decodeEventLog({
                abi: JINN_ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (event.eventName !== 'TaskCreated') continue;
              const evArgs = event.args as { taskId: bigint; manifestDigest: Hex };
              if ((evArgs.manifestDigest as string).toLowerCase() !== targetDigest) continue;
              decoded.push(String(evArgs.taskId));
            } catch {
              // Not a TaskCreated event — skip.
            }
          }
          return decoded;
        },
        fromBlock,
        currentBlock,
        chunk,
        undefined,
        MAX_OPERATOR_COUNT_TASK_PAGES,
      );
      solverNetTaskIds = new Set(taskIdLists);
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.getSolverNetOperatorCount: getLogs for TaskCreated failed`,
        err,
      );
    }

    // No tasks → no attempts → no participating operators.
    if (solverNetTaskIds.size === 0) return 0;

    // Pass 2: TaskAttemptCreated → distinct operators across those tasks.
    let operators: Set<string>;
    try {
      const operatorLists = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: routerAddress,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: string[] = [];
          for (const log of logs) {
            try {
              const event = decodeEventLog({
                abi: JINN_ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (event.eventName !== 'TaskAttemptCreated') continue;
              const evArgs = event.args as { taskId: bigint; operator: Address };
              if (!solverNetTaskIds.has(String(evArgs.taskId))) continue;
              decoded.push(evArgs.operator.toLowerCase());
            } catch {
              // Not a TaskAttemptCreated event — skip.
            }
          }
          return decoded;
        },
        fromBlock,
        currentBlock,
        chunk,
        undefined,
        MAX_OPERATOR_COUNT_TASK_PAGES,
      );
      operators = new Set(operatorLists);
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.getSolverNetOperatorCount: getLogs for TaskAttemptCreated failed`,
        err,
      );
    }

    return operators.size;
  }

  // ── queryEnvelopes ─────────────────────────────────────────────────────────

  async function queryEnvelopes(query: CorpusQuery): Promise<EnvelopeRef[]> {
    try {
      return await runOnchainCorpusQuery(query, {
        rpcUrl: opts.rpcUrl,
        chainId: opts.chainId,
        identityRegistryAddress: identityRegistryAddress as Address | undefined,
        fromBlock: opts.taskDiscoveryFromBlock,
        chunkBlocks: opts.chunkBlocks,
        publicClient: opts.publicClient as Pick<PublicClient, 'getBlockNumber' | 'getLogs'> | undefined,
      });
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI.queryEnvelopes: onchain query failed`,
        err,
      );
    }
  }

  // ── listPluginPublications (gh#290) ───────────────────────────────────────
  // The on-chain floor enumerates `plugin:<cid>` MetadataSet events directly so
  // the operator app's /build registry panels keep rendering during an indexer
  // outage. Unlike the indexer's `pluginPublication` entity, the floor does NOT
  // IPFS-enrich — but the rich fields (name, version, supports, sha256,
  // publishedAt) are all in the on-chain PLUGIN_PAYLOAD_TUPLE, so the floor
  // serves complete rows without an IPFS hop.

  async function scanPluginMetadataEvents(): Promise<PluginMetadataEvent[]> {
    if (!identityRegistryAddress) return [];

    const client = getClient();
    let currentBlock: bigint;
    try {
      currentBlock = await (client as PublicClient).getBlockNumber();
    } catch (err) {
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI.listPluginPublications: failed to get block number`,
        err,
      );
    }

    // No cursor here. `listPluginPublications` must return the *complete*
    // catalog from a single call: `foldPluginPublications` re-folds from
    // scratch every call, so it must see *all* events. A cursor would scan
    // only `[cachedBlock, head]` on the second call and silently drop every
    // publication before the cursor — unlike `findClaimableTasks`, whose
    // caller accumulates across calls, this method has no accumulator.
    // Always scan from the chain default, ignoring any injected cursorCache.
    const fromBlock = resolveScanFromBlock(opts, currentBlock);

    let events: PluginMetadataEvent[];
    try {
      events = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: identityRegistryAddress,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: PluginMetadataEvent[] = [];
          for (const log of logs) {
            const event = decodePluginMetadataLog(log as {
              data: Hex;
              topics: readonly Hex[];
              blockNumber: bigint | null;
              transactionIndex: number | null;
              logIndex: number | null;
            });
            if (event) decoded.push(event);
          }
          return decoded;
        },
        fromBlock,
        currentBlock,
        chunk,
      );
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI.listPluginPublications: getLogs for MetadataSet failed`,
        err,
      );
    }

    // Intentionally no cursorCache.write here — see resolveScanFromBlock.
    return events;
  }

  async function listPluginPublications(args?: {
    solverType?: string;
    builderAgentId?: string;
    includeRevoked?: boolean;
    limit?: number;
  }): Promise<PluginPublication[]> {
    let events: PluginMetadataEvent[];
    try {
      events = await scanPluginMetadataEvents();
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.listPluginPublications: scan failed`,
        err,
      );
    }

    const { rows: foldedRows, anchors: foldedAnchors } = foldPluginPublications(events);
    let rows = foldedRows;

    // Apply the same filters the HTTP layer pushes into its `where` clause.
    if (args?.builderAgentId !== undefined) {
      rows = rows.filter((r) => r.builderAgentId === args.builderAgentId);
    }
    if (args?.solverType !== undefined) {
      rows = rows.filter((r) => r.supports.includes(args.solverType as string));
    }
    // Revoked rows are included by default; drop them only when asked.
    if (args?.includeRevoked === false) {
      rows = rows.filter((r) => !r.revoked);
    }

    // Newest-first by the fold's chain-attested anchor
    // (blockNumber, transactionIndex, logIndex) desc — true parity with the
    // HTTP layer's `orderBy: "blockNumber", orderDirection: "desc"`. Sorting
    // by the builder-supplied `publishedAt` would diverge: that value is not
    // chain-attested. `foldedAnchors` carries the anchor alongside each row so
    // the public `PluginPublication` shape stays unchanged.
    rows.sort((a, b) => {
      const aa = foldedAnchors.get(a);
      const ba = foldedAnchors.get(b);
      if (!aa || !ba) return 0;
      if (aa.blockNumber !== ba.blockNumber) {
        return aa.blockNumber > ba.blockNumber ? -1 : 1;
      }
      if (aa.transactionIndex !== ba.transactionIndex) {
        return ba.transactionIndex - aa.transactionIndex;
      }
      return ba.logIndex - aa.logIndex;
    });

    // Clamp `limit` to `[1, 500]` (default 100), mirroring the HTTP layer for
    // drop-in `with-fallback` parity.
    const limit = Math.min(500, Math.max(1, args?.limit ?? 100));
    return rows.slice(0, limit);
  }

  // ── listBuilderArtifacts (gh#290) ─────────────────────────────────────────
  // Today only plug-ins are published; mirror the HTTP layer and delegate to
  // listPluginPublications so the "Your published plug-ins" panel populates on
  // the floor too. The harness variant is added when Path 2 ships.

  async function listBuilderArtifacts(args: {
    builderAgentId: string;
    limit?: number;
  }): Promise<PublishedArtifact[]> {
    return listPluginPublications({
      builderAgentId: args.builderAgentId,
      limit: args.limit,
    });
  }

  // ── getPluginScores stub (ebu7 dependency) ────────────────────────────────
  // Score history needs the indexer's `attemptEnvelopeMeta` + `verdict`
  // enrichment join, which the on-chain floor cannot reconstruct. Stays a stub.

  async function getPluginScores(): Promise<PluginScoreHistoryRow[]> { return []; }

  // ── getInstanceSuccessCounts (#669) — empty Map stub ───────────────────────
  // Network-truth success counts are derived from the indexer's IPFS
  // enrichment of evaluation envelopes (verdictEnvelopeMeta.instanceId), which
  // the on-chain floor cannot reconstruct without fetching IPFS bodies for
  // every MetadataSet event with key 'evaluation:*'. That is a non-trivial
  // scan + IPFS fan-out and is out of scope for the floor. Returning an empty
  // Map is the documented contract: callers see local counters as the floor.

  async function getInstanceSuccessCounts(): Promise<Map<string, number>> {
    return new Map();
  }

  // ── getCodeDigestRewards (#764) — empty-array stub ─────────────────────────
  // Per-codeDigest aggregates derive from the indexer's IPFS enrichment
  // (attempt/verdict envelope meta), which the on-chain floor cannot
  // reconstruct. withFallback never routes here (no silent fall-through).
  async function getCodeDigestRewards(_args?: {
    codeDigests: string[];
    operator?: `0x${string}`;
    solverNetManifestCid?: string;
    window?: number;
  }): Promise<CodeDigestRewardRow[]> {
    // `window` accepted for interface parity; the floor returns no rows.
    void _args;
    return [];
  }

  // ── getInstanceClaimCounts (#802) — empty Map stub ─────────────────────────
  // The claim data (task.maxClaims + attempt counts) IS reconstructible from
  // TaskCreated / TaskAttemptCreated logs, but the floor stays a no-op for two
  // distinct paths:
  //   (1) http + fallbackToOnchain=true — withFallback never routes this method
  //       to the floor, so this stub is never reached; the primary's error
  //       propagates and the launcher aborts the tick (abort-on-outage).
  //   (2) mode='onchain' (mainnet default) — the factory returns this floor
  //       un-wrapped, so this stub IS the runtime path. The empty Map makes the
  //       generator's classifier treat every known posting's taskId as absent =
  //       not-yet-indexed = `live`, so the generator goes safely INERT (posts
  //       each instance once, never tops up) instead of storming. A live
  //       on-chain claim scan is deferred to its own scoped issue.
  async function getInstanceClaimCounts(): Promise<Map<string, InstanceClaimCount>> {
    return new Map();
  }

  // ── getTaskStatuses (#579) — empty Map stub ────────────────────────────────
  // The floor cannot cheaply reconstruct finalized/refunded state (the indexer
  // tracks it via the task lifecycle; the floor would need a per-task call-trace
  // scan + IPFS hop). Returning an empty Map is the documented contract: the
  // caller maps absence to 'unknown', the safe degraded default. This is a
  // DISPLAY signal, so withFallback DOES route here on an indexer outage (unlike
  // the abort-on-outage getInstanceClaimCounts) — an empty Map → all-'unknown'
  // chips, which is honest rather than guessing 'open'.
  async function getTaskStatuses(): Promise<Map<string, TaskStatusSnapshot>> {
    return new Map();
  }

  // ── getVerdictTallies (#502) — empty Map stub ──────────────────────────────
  // Resolved verdict poles derive from the indexer's IPFS enrichment
  // (verdictEnvelopeMeta.evaluatorVerdict), which the on-chain floor cannot
  // decode. Returning an empty Map is the documented contract: callers map an
  // absent taskId to 'awaiting', the safe degraded default. This is a DISPLAY
  // signal, so withFallback DOES route here on an indexer outage — an empty Map
  // → all-'awaiting' outcomes, which is honest rather than guessing a 'fail'.
  async function getVerdictTallies(): Promise<Map<string, VerdictTallyResult>> {
    return new Map();
  }

  // ── getTaskLifecycleEvidence (#2044) ───────────────────────────────────────
  // Reconstruct the authoritative task→attempt→verdict spine from router logs.
  // Candidates are always empty on the floor (no IPFS enrichment). Scans are
  // hard-capped at MAX_OPERATOR_COUNT_TASK_PAGES chunks; if the range would
  // exceed the cap the whole call returns empty (absence > partial lie).
  async function getTaskLifecycleEvidence(args: {
    taskIds: string[];
  }): Promise<Map<string, TaskLifecycleEvidence>> {
    if (args.taskIds.length === 0) return new Map();
    if (!routerAddress) {
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI: no routerAddress configured for chainId=${opts.chainId}`,
      );
    }

    const requested = new Set(args.taskIds.filter(Boolean));
    if (requested.size === 0) return new Map();

    const client = getClient();
    let currentBlock: bigint;
    try {
      currentBlock = await client.getBlockNumber();
    } catch (err) {
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.getTaskLifecycleEvidence: failed to get block number`,
        err,
      );
    }

    const fromBlock = resolveScanFromBlock(opts, currentBlock);
    // Pre-check truncation: if the floor→head range needs more than the hard
    // chunk cap, omit everything rather than return a partial spine.
    {
      const span = chunk + 1n;
      const range = currentBlock >= fromBlock ? currentBlock - fromBlock + 1n : 0n;
      const needed = range === 0n ? 0n : (range + span - 1n) / span;
      if (needed > BigInt(MAX_OPERATOR_COUNT_TASK_PAGES)) {
        return new Map();
      }
    }

    type DecodedTask = RawTaskRow;
    type DecodedAttempt = RawAttemptRow;
    type DecodedVerdict = RawVerdictRow;

    let tasks: DecodedTask[];
    try {
      const lists = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: routerAddress,
            event: ROUTER_TASK_CREATED_EVENT,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: DecodedTask[] = [];
          for (const log of logs) {
            try {
              const event = decodeEventLog({
                abi: JINN_ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (event.eventName !== 'TaskCreated') continue;
              const evArgs = event.args as {
                creator: Address;
                taskId: bigint;
                manifestDigest: Hex;
                taskCidDigest: Hex;
                maxClaims: number;
              };
              const taskId = String(evArgs.taskId);
              if (!requested.has(taskId)) continue;
              const createdAtBlock = log.blockNumber != null ? Number(log.blockNumber) : NaN;
              if (!Number.isFinite(createdAtBlock)) continue;
              const row: DecodedTask = {
                taskId,
                chainId: opts.chainId,
                manifestDigest: evArgs.manifestDigest.toLowerCase() as `0x${string}`,
                taskCidDigest: evArgs.taskCidDigest.toLowerCase() as `0x${string}`,
                creator: evArgs.creator.toLowerCase() as `0x${string}`,
                maxClaims: Number(evArgs.maxClaims),
                // Tokenless JinnRouterV3 finalizes on the first delivered
                // verdict; requiredVerdicts is not present in TaskCreated.
                requiredVerdicts: 1,
                createdAtBlock,
                finalized: false,
                refunded: false,
              };
              if (log.transactionHash) {
                row.createdAtTx = log.transactionHash.toLowerCase() as `0x${string}`;
              }
              decoded.push(row);
            } catch {
              // Not a TaskCreated event — skip.
            }
          }
          return decoded;
        },
        fromBlock,
        currentBlock,
        chunk,
        undefined,
        MAX_OPERATOR_COUNT_TASK_PAGES,
      );
      tasks = lists;
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.getTaskLifecycleEvidence: getLogs for TaskCreated failed`,
        err,
      );
    }

    if (tasks.length === 0) return new Map();
    const knownTaskIds = new Set(tasks.map((t) => t.taskId));

    let attempts: DecodedAttempt[];
    try {
      const lists = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: routerAddress,
            event: ROUTER_TASK_ATTEMPT_CREATED_EVENT,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: DecodedAttempt[] = [];
          for (const log of logs) {
            try {
              const event = decodeEventLog({
                abi: JINN_ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (event.eventName !== 'TaskAttemptCreated') continue;
              const evArgs = event.args as {
                taskId: bigint;
                attemptIndex: number;
                requestId: Hex;
                operator: Address;
                priorityMech: Address;
                deliveryRate: bigint;
              };
              const taskId = String(evArgs.taskId);
              if (!knownTaskIds.has(taskId)) continue;
              const createdAtBlock = log.blockNumber != null ? Number(log.blockNumber) : NaN;
              if (!Number.isFinite(createdAtBlock)) continue;
              decoded.push({
                taskId,
                chainId: opts.chainId,
                attemptIndex: Number(evArgs.attemptIndex),
                requestId: evArgs.requestId.toLowerCase() as `0x${string}`,
                operator: evArgs.operator.toLowerCase() as `0x${string}`,
                priorityMech: evArgs.priorityMech.toLowerCase() as `0x${string}`,
                deliveryRate: String(evArgs.deliveryRate),
                createdAtBlock,
              });
            } catch {
              // Not a TaskAttemptCreated event — skip.
            }
          }
          return decoded;
        },
        fromBlock,
        currentBlock,
        chunk,
        undefined,
        MAX_OPERATOR_COUNT_TASK_PAGES,
      );
      attempts = lists;
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.getTaskLifecycleEvidence: getLogs for TaskAttemptCreated failed`,
        err,
      );
    }

    let verdicts: DecodedVerdict[];
    try {
      const lists = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: routerAddress,
            event: ROUTER_VERDICT_DELIVERY_CLAIMED_EVENT,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: DecodedVerdict[] = [];
          for (const log of logs) {
            try {
              const event = decodeEventLog({
                abi: JINN_ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (event.eventName !== 'VerdictDeliveryClaimed') continue;
              const evArgs = event.args as {
                evaluator: Address;
                requestId: Hex;
                taskId: bigint;
                attemptIndex: number;
                verdictIndex: number;
                verdictCode: number;
              };
              const taskId = String(evArgs.taskId);
              if (!knownTaskIds.has(taskId)) continue;
              const createdAtBlock = log.blockNumber != null ? Number(log.blockNumber) : NaN;
              if (!Number.isFinite(createdAtBlock)) continue;
              decoded.push({
                taskId,
                chainId: opts.chainId,
                attemptIndex: Number(evArgs.attemptIndex),
                verdictIndex: Number(evArgs.verdictIndex),
                requestId: evArgs.requestId.toLowerCase() as `0x${string}`,
                evaluator: evArgs.evaluator.toLowerCase() as `0x${string}`,
                verdictCode: Number(evArgs.verdictCode),
                createdAtBlock,
              });
            } catch {
              // Not a VerdictDeliveryClaimed event — skip.
            }
          }
          return decoded;
        },
        fromBlock,
        currentBlock,
        chunk,
        undefined,
        MAX_OPERATOR_COUNT_TASK_PAGES,
      );
      verdicts = lists;
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.getTaskLifecycleEvidence: getLogs for VerdictDeliveryClaimed failed`,
        err,
      );
    }

    let refundedTaskIds: Set<string>;
    try {
      const lists = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: routerAddress,
            event: ROUTER_TASK_BUDGET_REFUNDED_EVENT,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: string[] = [];
          for (const log of logs) {
            try {
              const event = decodeEventLog({
                abi: JINN_ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (event.eventName !== 'TaskBudgetRefunded') continue;
              const taskId = String((event.args as { taskId: bigint }).taskId);
              if (knownTaskIds.has(taskId)) decoded.push(taskId);
            } catch {
              // Not a TaskBudgetRefunded event — skip.
            }
          }
          return decoded;
        },
        fromBlock,
        currentBlock,
        chunk,
        undefined,
        MAX_OPERATOR_COUNT_TASK_PAGES,
      );
      refundedTaskIds = new Set(lists);
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.getTaskLifecycleEvidence: getLogs for TaskBudgetRefunded failed`,
        err,
      );
    }

    const verdictCountsByAttempt = new Map<string, number>();
    for (const verdict of verdicts) {
      const key = `${verdict.taskId}|${verdict.attemptIndex}|${verdict.chainId}`;
      verdictCountsByAttempt.set(key, (verdictCountsByAttempt.get(key) ?? 0) + 1);
    }
    for (const task of tasks) {
      task.finalized = attempts.some((attempt) =>
        attempt.taskId === task.taskId
        && attempt.chainId === task.chainId
        && (verdictCountsByAttempt.get(
          `${attempt.taskId}|${attempt.attemptIndex}|${attempt.chainId}`,
        ) ?? 0) >= task.requiredVerdicts,
      );
      task.refunded = refundedTaskIds.has(task.taskId);
    }

    return assembleTaskLifecycleEvidence({
      tasks,
      attempts,
      verdicts,
      attemptCandidates: [],
      verdictCandidates: [],
    });
  }

  // ── getTaskPostCounts (#918) ───────────────────────────────────────────────
  // Windowed count of TaskCreated events (last 1h / 6h / 24h) sourced directly
  // from the JinnRouter logs. Block-window approximation; capped at
  // MAX_TASK_POST_COUNT_SCAN_PAGES getLogs chunks like getSolverNetOperatorCount
  // so the recurring dashboard poll cannot walk unbounded history. This is the
  // runtime path when discovery.mode is 'onchain' AND the fallback floor for
  // the http backing (withFallback routes here — supply-signal, not abort).
  async function getTaskPostCounts(args?: { manifestCids?: string[] }): Promise<{
    windowEndBlock: number;
    windowEndTs: number;
    chain: TaskPostCounts;
    byCid: Record<string, TaskPostCounts>;
  }> {
    if (!routerAddress) {
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI: no routerAddress configured for chainId=${opts.chainId}`,
      );
    }

    const client = getClient();
    let head: bigint;
    try {
      head = await (client as PublicClient).getBlockNumber();
    } catch (err) {
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI.getTaskPostCounts: failed to get block number`,
        err,
      );
    }

    const windowEndTs = Math.floor(Date.now() / 1000);
    const h24Cut = head > TASK_POST_24H_BLOCKS ? head - TASK_POST_24H_BLOCKS : 0n;

    // Scan from max(configured floor, head-24h) so we never re-walk the whole
    // chain — the 24h window is the only data we bucket.
    const floor = resolveScanFromBlock(opts, head);
    const scanFrom = floor > h24Cut ? floor : h24Cut;

    // digest → cid lookup for the per-cid buckets (only when requested).
    const cids = Array.from(new Set((args?.manifestCids ?? []).filter(Boolean)));
    const cidByDigest = new Map<string, string>();
    for (const cid of cids) {
      cidByDigest.set(manifestDigestForCid(cid).toLowerCase(), cid);
    }

    let events: Array<{ block: number; digest: string }>;
    try {
      events = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: routerAddress,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: Array<{ block: number; digest: string }> = [];
          for (const log of logs) {
            try {
              const event = decodeEventLog({
                abi: JINN_ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (event.eventName !== 'TaskCreated') continue;
              const evArgs = event.args as { manifestDigest: Hex };
              decoded.push({
                block: Number(log.blockNumber ?? 0n),
                digest: (evArgs.manifestDigest as string).toLowerCase(),
              });
            } catch {
              // Not a TaskCreated event — skip.
            }
          }
          return decoded;
        },
        scanFrom,
        head,
        chunk,
        undefined,
        MAX_TASK_POST_COUNT_SCAN_PAGES,
      );
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI.getTaskPostCounts: getLogs for TaskCreated failed`,
        err,
      );
    }

    const { chain, byCid } = bucketTaskPostCounts(Number(head), windowEndTs, events, cidByDigest);

    return { windowEndBlock: Number(head), windowEndTs, chain, byCid };
  }

  // ── getMostRecentTaskCidDigest (#957) ──────────────────────────────────────
  // Scan TaskCreated logs filtered by the SolverNet's manifestDigest and return
  // the highest-block one's taskCidDigest + taskId. Pure chain read — no IPFS
  // hop; the caller reconstructs the task CID from the returned digest. Capped at
  // MAX_OPERATOR_COUNT_TASK_PAGES getLogs chunks like getSolverNetOperatorCount.
  async function getMostRecentTaskCidDigest(manifestCid: string): Promise<{
    taskCidDigest: `0x${string}`;
    taskId: string;
  } | undefined> {
    if (!routerAddress) {
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI: no routerAddress configured for chainId=${opts.chainId}`,
      );
    }

    const client = getClient();
    let currentBlock: bigint;
    try {
      currentBlock = await (client as PublicClient).getBlockNumber();
    } catch (err) {
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI.getMostRecentTaskCidDigest: failed to get block number`,
        err,
      );
    }

    // Complete-read call (no accumulator), so scan from the discovery floor
    // ignoring the cursor cache — mirrors getSolverNetOperatorCount.
    const fromBlock = resolveScanFromBlock(opts, currentBlock);
    const targetDigest = manifestDigestForCid(manifestCid).toLowerCase() as Hex;

    let matches: Array<{ taskId: string; taskCidDigest: Hex; block: number; txIndex: number; logIndex: number }>;
    try {
      matches = await scanLogsInChunks(
        async (start, end) => {
          const logs = await (client as PublicClient).getLogs({
            address: routerAddress,
            fromBlock: start,
            toBlock: end,
          });
          const decoded: Array<{ taskId: string; taskCidDigest: Hex; block: number; txIndex: number; logIndex: number }> = [];
          for (const log of logs) {
            try {
              const event = decodeEventLog({
                abi: JINN_ROUTER_ABI,
                data: log.data,
                topics: log.topics,
              });
              if (event.eventName !== 'TaskCreated') continue;
              const evArgs = event.args as { taskId: bigint; taskCidDigest: Hex; manifestDigest: Hex };
              if ((evArgs.manifestDigest as string).toLowerCase() !== targetDigest) continue;
              decoded.push({
                taskId: String(evArgs.taskId),
                taskCidDigest: evArgs.taskCidDigest,
                block: log.blockNumber != null ? Number(log.blockNumber) : 0,
                txIndex: log.transactionIndex ?? 0,
                logIndex: log.logIndex ?? 0,
              });
            } catch {
              // Not a TaskCreated event — skip.
            }
          }
          return decoded;
        },
        fromBlock,
        currentBlock,
        chunk,
        undefined,
        MAX_OPERATOR_COUNT_TASK_PAGES,
      );
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw discoveryUnavailableFromReadError(
        `OnchainDiscoveryAPI.getMostRecentTaskCidDigest: getLogs for TaskCreated failed`,
        err,
      );
    }

    if (matches.length === 0) return undefined;

    // Most recent by (block, transactionIndex, logIndex).
    const newest = matches.reduce((acc, cur) =>
      cur.block > acc.block ||
      (cur.block === acc.block && cur.txIndex > acc.txIndex) ||
      (cur.block === acc.block && cur.txIndex === acc.txIndex && cur.logIndex > acc.logIndex)
        ? cur
        : acc,
    );
    return { taskCidDigest: newest.taskCidDigest, taskId: newest.taskId };
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
    getCodeDigestRewards,
    getInstanceClaimCounts,
    getTaskPostCounts,
    getMostRecentTaskCidDigest,
    getTaskStatuses,
    getVerdictTallies,
    getAutopilotDeliveryCandidates,
    getTaskLifecycleEvidence,
  };
}
