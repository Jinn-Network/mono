/**
 * Plugin-publication read path — on-chain host implementation.
 *
 * One-swap R3 (umbrella #2461, DR-2026-08-05). This is the carved-out host for
 * `listPluginPublications` / `getPluginScores` / `listBuilderArtifacts`: it
 * enumerates `plugin:<cid>` `MetadataSet` events on the ERC-8004
 * IdentityRegistry, decodes the on-chain `PLUGIN_PAYLOAD_TUPLE` /
 * `REVOCATION_PAYLOAD_TUPLE`, and folds most-recent-wins — the same shape the
 * legacy `discovery/onchain.ts` floor produced, but with NO dependency on the
 * `discovery/` tree, so it survives the D-wave deletion.
 *
 * The reader reads through a narrow `PluginPublicationLogSource` port. The
 * canonical adapter (`createVenuePluginLogSource`) is layered over venue-base's
 * `ChainLogSource` — the same chunked-`getLogs` reader the projector consumes —
 * per the R3 mandate. A thin RPC adapter (`createRpcPluginLogSource`) exists for
 * one-shot contexts that do not own a `ChainLogSource` (the `jinn
 * solver-plugins` read verbs and the daemon's API-server injection). Both feed
 * the identical decode/fold/filter/sort/limit reader; there is no cursor or
 * reorg state to diverge on because the scan re-folds the complete catalog on
 * every call.
 */
import { decodeAbiParameters, decodeEventLog } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import type { ChainLogSource } from '@jinn-network/marketplace-venue-base';
import { PLUGIN_PAYLOAD_TUPLE, REVOCATION_PAYLOAD_TUPLE } from '../erc8004/abis.js';
import { PLUGIN_METADATA_KEY_PREFIX } from '../erc8004/plugin-registry.js';
import { DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK } from '../corpus/onchain-query.js';
import {
  PluginPublicationUnavailableError,
  type PluginPublication,
  type PluginPublicationReader,
  type PluginScoreHistoryRow,
  type PublishedArtifact,
} from './publication-reader.js';

/** Default block range per `getLogs` chunk for the RPC log source. */
const DEFAULT_CHUNK_BLOCKS = 9_999n;

/** ERC-8004 IdentityRegistry `MetadataSet` event ABI (decode-only). */
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

/**
 * The minimal log shape the reader folds. A structural subset of venue-base's
 * `MarketplaceRawLog` (and of a viem `Log`). Note there is no `transactionIndex`
 * — `logIndex` is a total order within a block, consistent with the legacy
 * floor's `(blockNumber, transactionIndex, logIndex)` sort, so `(blockNumber,
 * logIndex)` is the provenance anchor here.
 */
export interface PluginRawLog {
  blockNumber: bigint;
  logIndex: number;
  topics: readonly Hex[];
  data: Hex;
}

/**
 * The reader's log feed. `scanAll` returns the COMPLETE history of logs at the
 * IdentityRegistry address (empty blocks omitted); the reader decodes and folds
 * from scratch every call — a cursor would silently drop publications before it.
 */
export interface PluginPublicationLogSource {
  scanAll(): Promise<readonly PluginRawLog[]>;
}

// ── Decode ─────────────────────────────────────────────────────────────────────

interface PluginMetadataEvent {
  agentId: string;
  pluginCid: string;
  blockNumber: bigint;
  logIndex: number;
  kind: 'publish' | 'revoke';
  publish?: {
    pluginName: string;
    pluginVersion: string;
    pluginSha256: `0x${string}`;
    supports: readonly string[];
    publishedAt: number;
  };
  revokedReason?: string;
}

/**
 * Decode a `MetadataSet` log into a `PluginMetadataEvent`, or null if the key is
 * not a `plugin:` key or the payload decodes to neither a v1-publish nor a
 * v2-revocation tuple. Mirrors `discovery/onchain.ts::decodePluginMetadataLog`.
 */
export function decodePluginMetadataLog(log: PluginRawLog): PluginMetadataEvent | null {
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
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
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

// ── Fold ─────────────────────────────────────────────────────────────────────

interface PluginPublicationAnchor {
  blockNumber: bigint;
  logIndex: number;
}

/**
 * Fold a stream of plug-in `MetadataSet` events into the latest state per
 * `<agentId>:<pluginCid>` key, most-recent-wins by `(blockNumber, logIndex)`. A
 * v2 revocation only mutates the `revoked` / `revokedReason` fields of an
 * existing publish; a revocation with no prior publish is dropped. Returns the
 * materialised rows plus an `anchors` map keyed by row identity, so callers can
 * sort by the chain-attested anchor. Mirrors
 * `discovery/onchain.ts::foldPluginPublications`.
 */
export function foldPluginPublications(events: PluginMetadataEvent[]): {
  rows: PluginPublication[];
  anchors: Map<PluginPublication, PluginPublicationAnchor>;
} {
  interface Folded {
    agentId: string;
    pluginCid: string;
    blockNumber: bigint;
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
    (e.blockNumber === row.blockNumber && e.logIndex > row.logIndex);

  for (const e of events) {
    const key = `${e.agentId}:${e.pluginCid}`;
    const existing = byKey.get(key);

    if (e.kind === 'publish' && e.publish) {
      // A republish un-revokes (revoked resets to false).
      if (!existing || isNewer(e, existing)) {
        byKey.set(key, {
          agentId: e.agentId,
          pluginCid: e.pluginCid,
          blockNumber: e.blockNumber,
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
    anchors.set(out, { blockNumber: row.blockNumber, logIndex: row.logIndex });
  }
  return { rows, anchors };
}

// ── Reader ─────────────────────────────────────────────────────────────────────

/**
 * Build a `PluginPublicationReader` over a `PluginPublicationLogSource`. The
 * decode / fold / filter / sort / limit behaviour is byte-for-byte the legacy
 * on-chain floor's: newest-first by the chain-attested `(blockNumber, logIndex)`
 * anchor, `limit` clamped to `[1, 500]` (default 100), revoked rows included
 * unless `includeRevoked: false`. `getPluginScores` returns an empty array (the
 * score-history join needs indexer enrichment the on-chain scan cannot supply),
 * matching the legacy floor's documented contract.
 */
export function createPluginPublicationReader(input: {
  logSource: PluginPublicationLogSource;
}): PluginPublicationReader {
  const { logSource } = input;

  async function listPluginPublications(args?: {
    solverType?: string;
    builderAgentId?: string;
    includeRevoked?: boolean;
    limit?: number;
  }): Promise<PluginPublication[]> {
    let logs: readonly PluginRawLog[];
    try {
      logs = await logSource.scanAll();
    } catch (err) {
      if (err instanceof PluginPublicationUnavailableError) throw err;
      throw new PluginPublicationUnavailableError(
        'listPluginPublications: log scan failed',
        err,
      );
    }

    const events: PluginMetadataEvent[] = [];
    for (const log of logs) {
      const event = decodePluginMetadataLog(log);
      if (event) events.push(event);
    }

    const { rows: foldedRows, anchors } = foldPluginPublications(events);
    let rows = foldedRows;

    if (args?.builderAgentId !== undefined) {
      rows = rows.filter((r) => r.builderAgentId === args.builderAgentId);
    }
    if (args?.solverType !== undefined) {
      rows = rows.filter((r) => r.supports.includes(args.solverType as string));
    }
    if (args?.includeRevoked === false) {
      rows = rows.filter((r) => !r.revoked);
    }

    // Newest-first by the fold's chain-attested `(blockNumber, logIndex)` anchor.
    rows.sort((a, b) => {
      const aa = anchors.get(a);
      const ba = anchors.get(b);
      if (!aa || !ba) return 0;
      if (aa.blockNumber !== ba.blockNumber) {
        return aa.blockNumber > ba.blockNumber ? -1 : 1;
      }
      return ba.logIndex - aa.logIndex;
    });

    const limit = Math.min(500, Math.max(1, args?.limit ?? 100));
    return rows.slice(0, limit);
  }

  async function listBuilderArtifacts(args: {
    builderAgentId: string;
    limit?: number;
  }): Promise<PublishedArtifact[]> {
    return listPluginPublications({
      builderAgentId: args.builderAgentId,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
  }

  async function getPluginScores(): Promise<PluginScoreHistoryRow[]> {
    return [];
  }

  return { listPluginPublications, getPluginScores, listBuilderArtifacts };
}

// ── Log-source adapters ──────────────────────────────────────────────────────

/**
 * Resolve the block a full-history scan starts from — the chain-specific
 * IdentityRegistry-era default, falling back to the head when unknown.
 */
function resolveScanFromBlock(chainId: number, headBlock: bigint): bigint {
  return DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK[chainId] ?? headBlock;
}

/**
 * The canonical adapter: read the IdentityRegistry's full log history through
 * venue-base's `ChainLogSource`. Construct the `ChainLogSource` with
 * `addresses: [identityRegistry]` so `logsInRange` returns only IdentityRegistry
 * logs. `latestBlock` supplies the scan's upper bound (`ChainLogSource` does not
 * expose the chain head, so a `PublicClient` provides it).
 */
export function createVenuePluginLogSource(input: {
  chainLogSource: ChainLogSource;
  publicClient: Pick<PublicClient, 'getBlockNumber'>;
  chainId: number;
  /** Explicit scan-from override; defaults to the chain-era default. */
  fromBlock?: bigint;
}): PluginPublicationLogSource {
  return {
    async scanAll(): Promise<readonly PluginRawLog[]> {
      let head: bigint;
      try {
        head = await input.publicClient.getBlockNumber();
      } catch (err) {
        throw new PluginPublicationUnavailableError(
          'plugin log scan: failed to read chain head',
          err,
        );
      }
      const from = input.fromBlock ?? resolveScanFromBlock(input.chainId, head);
      if (from > head) return [];
      try {
        const logs = await input.chainLogSource.logsInRange(from, head);
        return logs.map((l) => ({
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
          topics: l.topics,
          data: l.data,
        }));
      } catch (err) {
        throw new PluginPublicationUnavailableError(
          'plugin log scan: logsInRange failed',
          err,
        );
      }
    },
  };
}

/**
 * Thin RPC adapter for one-shot contexts (CLI verbs, API-server injection) that
 * do not own a venue `ChainLogSource`. Chunked `getLogs` over the IdentityRegistry
 * address — behaviourally identical to `ChainLogSource.logsInRange`, but with no
 * venue state handle to open. There is no cursor / reorg state, so it cannot
 * disagree with the canonical adapter about what the fold sees.
 */
export function createRpcPluginLogSource(input: {
  publicClient: Pick<PublicClient, 'getBlockNumber' | 'getLogs'>;
  identityRegistry: Address;
  chainId: number;
  fromBlock?: bigint;
  chunkBlocks?: bigint;
}): PluginPublicationLogSource {
  const chunk = input.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS;
  return {
    async scanAll(): Promise<readonly PluginRawLog[]> {
      let head: bigint;
      try {
        head = await input.publicClient.getBlockNumber();
      } catch (err) {
        throw new PluginPublicationUnavailableError(
          'plugin log scan: failed to read chain head',
          err,
        );
      }
      const from = input.fromBlock ?? resolveScanFromBlock(input.chainId, head);
      if (from > head) return [];

      const collected: PluginRawLog[] = [];
      try {
        for (let start = from; start <= head; start += chunk) {
          const end = start + chunk - 1n > head ? head : start + chunk - 1n;
          // eslint-disable-next-line no-await-in-loop -- chunks are strictly sequential.
          const logs = await input.publicClient.getLogs({
            address: input.identityRegistry,
            fromBlock: start,
            toBlock: end,
          });
          for (const log of logs) {
            if (log.blockNumber === null || log.logIndex === null) continue;
            collected.push({
              blockNumber: log.blockNumber,
              logIndex: log.logIndex,
              topics: log.topics,
              data: log.data,
            });
          }
        }
      } catch (err) {
        throw new PluginPublicationUnavailableError(
          'plugin log scan: getLogs failed',
          err,
        );
      }
      return collected;
    },
  };
}
