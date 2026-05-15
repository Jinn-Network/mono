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
  decodeEventLog,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { DiscoveryAPI, ClaimableTaskCandidate, SolverNetManifestSummary, SolverNetLifecycleStatus, PluginPublication, PluginScoreHistoryRow, PublishedArtifact } from './types.js';
import { DiscoveryUnavailableError } from './types.js';
import type { EnvelopeRef, CorpusQuery } from '../corpus/types.js';
import { runOnchainCorpusQuery, DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK, DEFAULT_IDENTITY_REGISTRY_BY_CHAIN_ID } from '../corpus/onchain-query.js';
import { JINN_ROUTER_ABI } from '../adapters/mech/types.js';
import { canClaimTask } from '../adapters/mech/contracts.js';
import { manifestDigestForCid } from '../adapters/mech/digest.js';
import { resolveMostRecentWins, type SetMetadataEvent, type SetMetadataLifecyclePayload } from '../solvernets/most-recent-wins.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;
// 1999-block chunks: the public Base / Base Sepolia RPCs (the default fallback
// `rpcUrl`) cap `eth_getLogs` at a 2000-block range. Daemons configured with a
// higher-limit RPC can override via `chunkBlocks`, but the default must work
// against the bare public endpoint since this is the always-live fallback floor.
const DEFAULT_CHUNK_BLOCKS = 1_999n;

/** Default JinnRouter addresses by chain ID. */
const DEFAULT_ROUTER_BY_CHAIN_ID: Record<number, Address> = {
  8453: '0xfFa7118A3D820cd4E820010837D65FAfF463181B',  // Base mainnet
  // Base Sepolia is loaded from deployment artifact; no fixed default
};

/** Concurrency cap for parallel canClaimTask calls. */
const CLAIM_CHECK_CONCURRENCY = 8;

const SOLVERNET_MANIFEST_KEY_PREFIX = 'solvernet-manifest:';

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

/**
 * Scan logs in chunks. When `maxResults` is provided, scans newest-first
 * (from `toBlock` down to `fromBlock`) and stops as soon as `maxResults`
 * items have been accumulated — avoiding scanning the entire history when
 * only a bounded result set is needed. Without `maxResults`, scans
 * oldest-first (standard order).
 */
async function scanLogsInChunks<T>(
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  chunkBlocks: bigint,
  maxResults?: number,
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
    for (let start = fromBlock; start <= toBlock; start += chunkBlocks + 1n) {
      const end = start + chunkBlocks > toBlock ? toBlock : start + chunkBlocks;
      const chunk = await getLogs(start, end);
      results.push(...chunk);
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
    DEFAULT_ROUTER_BY_CHAIN_ID[opts.chainId]) as Address;

  const identityRegistryAddress: Address | undefined = (opts.identityRegistryAddress ??
    DEFAULT_IDENTITY_REGISTRY_BY_CHAIN_ID[opts.chainId]) as Address | undefined;

  const chunk = toBigInt(opts.chunkBlocks, DEFAULT_CHUNK_BLOCKS);

  function getClient(): Pick<PublicClient, 'getBlockNumber' | 'getLogs' | 'simulateContract'> {
    return opts.publicClient ?? createPublicClient({
      chain: chainForId(opts.chainId),
      transport: http(opts.rpcUrl),
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
      throw new DiscoveryUnavailableError(
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
      throw new DiscoveryUnavailableError(
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
      throw new DiscoveryUnavailableError(
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
      currentBlock = await (client as PublicClient).getBlockNumber();
    } catch (err) {
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI: failed to get block number`,
        err,
      );
    }

    const fromBlock = resolveFromBlock(opts, 'solvernets', currentBlock);

    let events: SetMetadataEvent[];
    try {
      events = await scanLogsInChunks(
        async (start, end) => {
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
        },
        fromBlock,
        currentBlock,
        chunk,
      );
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) throw err;
      throw new DiscoveryUnavailableError(
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
      throw new DiscoveryUnavailableError(
        `OnchainDiscoveryAPI.queryEnvelopes: onchain query failed`,
        err,
      );
    }
  }

  // ── Builder discovery stubs (attd) ────────────────────────────────────────
  // Builder discovery requires the indexer's `pluginPublication` entity; the
  // on-chain RPC floor does not enumerate it (would require a getLogs sweep +
  // payload decode that the floor is not designed for). When falling back to the
  // on-chain floor, builder browsing is unavailable until the indexer recovers.

  async function listPluginPublications(): Promise<PluginPublication[]> { return []; }
  async function getPluginScores(): Promise<PluginScoreHistoryRow[]> { return []; }
  async function listBuilderArtifacts(): Promise<PublishedArtifact[]> { return []; }

  return {
    findClaimableTasks,
    listLaunchedSolverNets,
    getLifecycleStatus,
    queryEnvelopes,
    listPluginPublications,
    getPluginScores,
    listBuilderArtifacts,
  };
}
