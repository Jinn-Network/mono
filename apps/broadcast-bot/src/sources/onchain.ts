import { createPublicClient, http, decodeEventLog, type Hex, type PublicClient } from 'viem';
import type { BroadcastEvent } from '../types.js';

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

const SOLVERNET_KEY_PREFIX = 'solvernet-manifest:';
const PLUGIN_KEY_PREFIX = 'plugin:';

export interface OnchainOptions {
  rpcUrl: string;
  chainId: number;
  identityRegistry: `0x${string}`;
  sources: ReadonlyArray<'solvernet-manifests' | 'plugins'>;
  /** Last block already scanned. Next scan starts at lastBlock + 1. */
  lastBlock: number | null;
  postedKeys: Set<string>;
  blockChunk: number;
  /** Maximum blocks to lookback if state has no watermark. */
  maxLookback?: number;
  /** Injected client for tests. */
  client?: PublicClient;
}

export async function fetchOnchain(opts: OnchainOptions): Promise<{
  events: BroadcastEvent[];
  newWatermark: number | null;
}> {
  const client =
    opts.client ??
    createPublicClient({
      transport: http(opts.rpcUrl),
    });

  const tip = await client.getBlockNumber();
  const tipNum = Number(tip);
  const lookback = opts.maxLookback ?? 5_000;
  const fromBlock = opts.lastBlock != null ? opts.lastBlock + 1 : Math.max(0, tipNum - lookback);

  if (fromBlock > tipNum) {
    return { events: [], newWatermark: opts.lastBlock };
  }

  const events: BroadcastEvent[] = [];
  const seenKeysThisRun = new Set<string>();
  let cursor = fromBlock;
  while (cursor <= tipNum) {
    const end = Math.min(cursor + opts.blockChunk, tipNum);
    const logs = await client.getLogs({
      address: opts.identityRegistry,
      fromBlock: BigInt(cursor),
      toBlock: BigInt(end),
    });
    for (const log of logs) {
      const decoded = tryDecode(log.data, log.topics);
      if (!decoded) continue;
      const key = decoded.metadataKey;
      const kind = classifyKey(key, opts.sources);
      if (!kind) continue;
      if (opts.postedKeys.has(key)) continue;
      if (seenKeysThisRun.has(key)) continue; // first observation per run wins
      seenKeysThisRun.add(key);

      const cid = key.slice(kind === 'solvernet-manifest' ? SOLVERNET_KEY_PREFIX.length : PLUGIN_KEY_PREFIX.length);
      const txHash = log.transactionHash;
      const explorerUrl = buildExplorerUrl(opts.chainId, txHash);
      events.push({
        type: kind,
        dedupeKey: key,
        link: explorerUrl,
        timestamp: new Date().toISOString(), // chain time not strictly needed; we sort by block
        payload: {
          cid,
          chainId: opts.chainId,
          txHash: txHash ?? '',
          blockNumber: Number(log.blockNumber ?? 0n),
          link: explorerUrl,
        },
      });
    }
    cursor = end + 1;
  }

  return { events, newWatermark: tipNum };
}

function tryDecode(data: Hex, topics: readonly Hex[]): { metadataKey: string } | null {
  try {
    const decoded = decodeEventLog({
      abi: IDENTITY_METADATA_ABI,
      data,
      topics: topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== 'MetadataSet') return null;
    return { metadataKey: (decoded.args as { metadataKey: string }).metadataKey };
  } catch {
    return null;
  }
}

function classifyKey(
  key: string,
  sources: ReadonlyArray<'solvernet-manifests' | 'plugins'>,
): 'solvernet-manifest' | 'plugin' | null {
  if (sources.includes('solvernet-manifests') && key.startsWith(SOLVERNET_KEY_PREFIX)) {
    return 'solvernet-manifest';
  }
  if (sources.includes('plugins') && key.startsWith(PLUGIN_KEY_PREFIX)) {
    return 'plugin';
  }
  return null;
}

function buildExplorerUrl(chainId: number, txHash: string | null): string {
  if (!txHash) return '';
  switch (chainId) {
    case 84532:
      return `https://sepolia.basescan.org/tx/${txHash}`;
    case 8453:
      return `https://basescan.org/tx/${txHash}`;
    case 11155111:
      return `https://sepolia.etherscan.io/tx/${txHash}`;
    case 1:
      return `https://etherscan.io/tx/${txHash}`;
    default:
      return txHash;
  }
}
