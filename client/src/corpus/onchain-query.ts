import {
  createPublicClient,
  decodeAbiParameters,
  decodeEventLog,
  http,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { CorpusQuery, EnvelopeRef } from './types.js';
import { PAYLOAD_TUPLE, PAYLOAD_TUPLE_V2 } from '../erc8004/abis.js';
import { IDENTITY_REGISTRY_ADDRESSES } from '../contracts/addresses.js';

const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 500;
const DEFAULT_CHUNK_BLOCKS = 9_999n;

export const DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK: Record<number, bigint> = {
  84532: 41_100_000n,
  8453: 25_000_000n,
};

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

export interface OnchainCorpusQueryOptions {
  rpcUrl?: string;
  chainId: number;
  identityRegistryAddress?: Address;
  fromBlock?: bigint | number;
  chunkBlocks?: bigint | number;
  publicClient?: Pick<PublicClient, 'getBlockNumber' | 'getLogs'>;
}

interface ExecutionMetadataEvent {
  ref: EnvelopeRef;
  blockNumber: bigint;
  logIndex: number;
}

function chainForId(chainId: number) {
  return chainId === 84532 ? baseSepolia : base;
}

function toBigIntBlock(value: bigint | number | undefined, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  if (typeof value === 'bigint') return value;
  return BigInt(Math.max(0, Math.floor(value)));
}

function parseExecutionMetadataKey(key: string): { kind: string; cid: string } | null {
  const colon = key.indexOf(':');
  if (colon <= 0 || colon === key.length - 1) return null;
  const kind = key.slice(0, colon);
  if (kind !== 'envelope' && kind !== 'evaluation' && kind !== 'capture') return null;
  return { kind, cid: key.slice(colon + 1) };
}

function tierFromRaw(value: number): EnvelopeRef['evidenceTier'] {
  if (value === 0) return 'self-signed';
  if (value === 1) return 'committed';
  if (value === 3) return 'attested';
  return 'unknown';
}

function decodePayload(value: Hex): { manifestHash: string; evidenceTier: EnvelopeRef['evidenceTier'] } {
  try {
    const decoded = decodeAbiParameters(PAYLOAD_TUPLE_V2, value);
    return {
      manifestHash: decoded[2],
      evidenceTier: tierFromRaw(Number(decoded[1])),
    };
  } catch {
    // v1 payloads do not have the trailing harness identity fields.
  }
  try {
    const decoded = decodeAbiParameters(PAYLOAD_TUPLE, value);
    return {
      manifestHash: decoded[2],
      evidenceTier: tierFromRaw(Number(decoded[1])),
    };
  } catch {
    return { manifestHash: '', evidenceTier: 'unknown' };
  }
}

function decodeMetadataLog(log: Log): ExecutionMetadataEvent | null {
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
      topics: log.topics,
    }) as typeof decoded;
  } catch {
    return null;
  }
  if (decoded.eventName !== 'MetadataSet') return null;
  const parsedKey = parseExecutionMetadataKey(decoded.args.metadataKey);
  if (!parsedKey) return null;
  const payload = decodePayload(decoded.args.metadataValue);
  return {
    ref: {
      manifestCid: parsedKey.cid,
      manifestHash: payload.manifestHash,
      operator: {
        agentId: decoded.args.agentId.toString(),
        safeAddress: '',
      },
      evidenceTier: payload.evidenceTier,
      publishedAt: 0,
    },
    blockNumber: log.blockNumber ?? 0n,
    logIndex: log.logIndex ?? 0,
  };
}

function matchesQuery(ref: EnvelopeRef, q: CorpusQuery): boolean {
  if (q.evidenceTier && ref.evidenceTier !== q.evidenceTier) return false;
  if (q.manifestHash && ref.manifestHash.toLowerCase() !== q.manifestHash.toLowerCase()) return false;
  return true;
}

export async function runOnchainCorpusQuery(
  q: CorpusQuery,
  opts: OnchainCorpusQueryOptions,
): Promise<EnvelopeRef[]> {
  const address = opts.identityRegistryAddress ?? IDENTITY_REGISTRY_ADDRESSES[opts.chainId];
  if (!address) return [];
  const client = opts.publicClient ?? createPublicClient({
    chain: chainForId(opts.chainId),
    transport: http(opts.rpcUrl),
  });
  const currentBlock = await client.getBlockNumber();
  const fromBlock = toBigIntBlock(
    opts.fromBlock,
    DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK[opts.chainId] ?? currentBlock,
  );
  if (fromBlock > currentBlock) return [];

  const limit = Math.min(Math.max(1, q.limit ?? DEFAULT_LIMIT), HARD_LIMIT);
  const chunk = toBigIntBlock(opts.chunkBlocks, DEFAULT_CHUNK_BLOCKS);
  const out: ExecutionMetadataEvent[] = [];
  const seen = new Set<string>();

  for (let end = currentBlock; end >= fromBlock && out.length < limit; ) {
    const start = end > chunk && end - chunk + 1n > fromBlock
      ? end - chunk + 1n
      : fromBlock;
    const logs = await client.getLogs({
      address,
      fromBlock: start,
      toBlock: end,
    });
    const decoded = logs
      .map(decodeMetadataLog)
      .filter((item): item is ExecutionMetadataEvent => item !== null)
      .sort((a, b) => {
        if (a.blockNumber === b.blockNumber) return b.logIndex - a.logIndex;
        return a.blockNumber > b.blockNumber ? -1 : 1;
      });
    for (const item of decoded) {
      if (!matchesQuery(item.ref, q)) continue;
      const key = item.ref.manifestCid;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= limit) break;
    }
    if (start === fromBlock) break;
    end = start - 1n;
  }

  return out.map((item) => item.ref);
}
