import { describe, it, expect } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, type Hex } from 'viem';
import { fetchOnchain } from '../../src/sources/onchain.js';

const METADATA_SET_ABI = [
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

function makeLog(metadataKey: string, blockNumber: number, txHash: string) {
  const topics = encodeEventTopics({
    abi: METADATA_SET_ABI,
    eventName: 'MetadataSet',
    args: { agentId: 1n, indexedMetadataKey: metadataKey },
  });
  const data = encodeAbiParameters(
    [
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    [metadataKey, '0x' as Hex],
  );
  return {
    address: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    topics,
    data,
    blockNumber: BigInt(blockNumber),
    transactionHash: txHash as `0x${string}`,
    transactionIndex: 0,
    logIndex: 0,
    blockHash: '0x',
    removed: false,
  };
}

function mockClient(logs: ReturnType<typeof makeLog>[], tip: number) {
  // Use unknown cast — we only need the two methods fetchOnchain calls.
  return {
    async getBlockNumber() {
      return BigInt(tip);
    },
    async getLogs() {
      return logs;
    },
  } as unknown as import('viem').PublicClient;
}

describe('fetchOnchain', () => {
  it('emits solvernet-manifest and plugin events from MetadataSet logs', async () => {
    const logs = [
      makeLog('solvernet-manifest:bafyA', 100, '0xaaa'),
      makeLog('plugin:bafyB', 101, '0xbbb'),
      makeLog('envelope:bafyC', 102, '0xccc'), // not a watched key
    ];
    const result = await fetchOnchain({
      rpcUrl: 'http://stub',
      chainId: 84532,
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      sources: ['solvernet-manifests', 'plugins'],
      lastBlock: 99,
      postedKeys: new Set(),
      blockChunk: 100,
      client: mockClient(logs, 200),
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe('solvernet-manifest');
    expect(result.events[0].payload.cid).toBe('bafyA');
    expect(result.events[0].link).toBe('https://sepolia.basescan.org/tx/0xaaa');
    expect(result.events[1].type).toBe('plugin');
    expect(result.events[1].payload.cid).toBe('bafyB');
    expect(result.newWatermark).toBe(200);
  });

  it('skips already-posted keys', async () => {
    const logs = [makeLog('solvernet-manifest:bafyA', 100, '0xaaa')];
    const result = await fetchOnchain({
      rpcUrl: 'http://stub',
      chainId: 84532,
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      sources: ['solvernet-manifests'],
      lastBlock: 99,
      postedKeys: new Set(['solvernet-manifest:bafyA']),
      blockChunk: 100,
      client: mockClient(logs, 200),
    });
    expect(result.events).toHaveLength(0);
  });

  it('respects the source allowlist', async () => {
    const logs = [
      makeLog('solvernet-manifest:bafyA', 100, '0xaaa'),
      makeLog('plugin:bafyB', 101, '0xbbb'),
    ];
    const result = await fetchOnchain({
      rpcUrl: 'http://stub',
      chainId: 84532,
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      sources: ['solvernet-manifests'],
      lastBlock: 99,
      postedKeys: new Set(),
      blockChunk: 100,
      client: mockClient(logs, 200),
    });
    expect(result.events.map((e) => e.type)).toEqual(['solvernet-manifest']);
  });

  it('returns no events when there are no new blocks', async () => {
    const result = await fetchOnchain({
      rpcUrl: 'http://stub',
      chainId: 84532,
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      sources: ['solvernet-manifests', 'plugins'],
      lastBlock: 200,
      postedKeys: new Set(),
      blockChunk: 100,
      client: mockClient([], 200),
    });
    expect(result.events).toHaveLength(0);
    expect(result.newWatermark).toBe(200);
  });

  it('dedupes repeat keys within a single run', async () => {
    const logs = [
      makeLog('solvernet-manifest:bafyA', 100, '0xaaa'),
      makeLog('solvernet-manifest:bafyA', 101, '0xbbb'), // lifecycle update
    ];
    const result = await fetchOnchain({
      rpcUrl: 'http://stub',
      chainId: 84532,
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      sources: ['solvernet-manifests'],
      lastBlock: 99,
      postedKeys: new Set(),
      blockChunk: 100,
      client: mockClient(logs, 200),
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload.txHash).toBe('0xaaa');
  });
});
