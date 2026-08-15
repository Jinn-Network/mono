import { describe, it, expect, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import {
  createPluginPublicationReader,
  createRpcPluginLogSource,
  createVenuePluginLogSource,
  decodePluginMetadataLog,
  foldPluginPublications,
  type PluginPublicationLogSource,
  type PluginRawLog,
} from '../../src/plugin-registry/publication-host.js';
import {
  PluginPublicationUnavailableError,
} from '../../src/plugin-registry/publication-reader.js';
import { PLUGIN_PAYLOAD_TUPLE, REVOCATION_PAYLOAD_TUPLE } from '../../src/erc8004/abis.js';

const METADATA_ABI = [
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

function metadataLog(args: {
  agentId: bigint;
  metadataKey: string;
  metadataValue: Hex;
  blockNumber: bigint;
  logIndex: number;
}): PluginRawLog {
  const topics = encodeEventTopics({
    abi: METADATA_ABI,
    eventName: 'MetadataSet',
    args: { agentId: args.agentId, indexedMetadataKey: args.metadataKey },
  });
  const data = encodeAbiParameters(
    [{ type: 'string' }, { type: 'bytes' }],
    [args.metadataKey, args.metadataValue],
  );
  return { blockNumber: args.blockNumber, logIndex: args.logIndex, topics, data };
}

function publishLog(args: {
  agentId: bigint;
  cid: string;
  name?: string;
  version?: string;
  sha256?: Hex;
  supports?: string[];
  publishedAt?: number;
  blockNumber: bigint;
  logIndex: number;
}): PluginRawLog {
  const value = encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, [
    1,
    args.name ?? 'my-plugin',
    args.version ?? '1.0.0',
    args.sha256 ?? (`0x${'ab'.repeat(32)}` as Hex),
    args.supports ?? ['prediction.v0'],
    BigInt(args.publishedAt ?? 1_700_000_000),
  ]);
  return metadataLog({
    agentId: args.agentId,
    metadataKey: `plugin:${args.cid}`,
    metadataValue: value,
    blockNumber: args.blockNumber,
    logIndex: args.logIndex,
  });
}

function revokeLog(args: {
  agentId: bigint;
  cid: string;
  reason?: string;
  blockNumber: bigint;
  logIndex: number;
}): PluginRawLog {
  const value = encodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, [
    2,
    true,
    args.reason ?? 'deprecated',
  ]);
  return metadataLog({
    agentId: args.agentId,
    metadataKey: `plugin:${args.cid}`,
    metadataValue: value,
    blockNumber: args.blockNumber,
    logIndex: args.logIndex,
  });
}

function fakeLogSource(logs: readonly PluginRawLog[]): PluginPublicationLogSource {
  return { scanAll: async () => logs };
}

describe('decodePluginMetadataLog', () => {
  it('decodes a v1 publish payload', () => {
    const ev = decodePluginMetadataLog(
      publishLog({ agentId: 7n, cid: 'cidA', name: 'p', version: '2.1.0', blockNumber: 10n, logIndex: 3 }),
    );
    expect(ev).toMatchObject({
      agentId: '7',
      pluginCid: 'cidA',
      kind: 'publish',
      blockNumber: 10n,
      logIndex: 3,
    });
    expect(ev?.publish).toMatchObject({ pluginName: 'p', pluginVersion: '2.1.0' });
  });

  it('decodes a v2 revocation payload', () => {
    const ev = decodePluginMetadataLog(
      revokeLog({ agentId: 7n, cid: 'cidA', reason: 'gone', blockNumber: 11n, logIndex: 0 }),
    );
    expect(ev).toMatchObject({ kind: 'revoke', revokedReason: 'gone', pluginCid: 'cidA' });
  });

  it('drops a non-plugin metadata key', () => {
    const log = metadataLog({
      agentId: 1n,
      metadataKey: 'solvernet-manifest:xyz',
      metadataValue: '0x1234',
      blockNumber: 1n,
      logIndex: 0,
    });
    expect(decodePluginMetadataLog(log)).toBeNull();
  });

  it('drops a garbage / unrelated log', () => {
    expect(
      decodePluginMetadataLog({ blockNumber: 1n, logIndex: 0, topics: ['0xdead'], data: '0x' }),
    ).toBeNull();
  });
});

describe('foldPluginPublications', () => {
  it('most-recent-wins across republishes', () => {
    const events = [
      publishLog({ agentId: 7n, cid: 'c', version: '1.0.0', blockNumber: 5n, logIndex: 0 }),
      publishLog({ agentId: 7n, cid: 'c', version: '2.0.0', blockNumber: 9n, logIndex: 1 }),
    ].map((l) => decodePluginMetadataLog(l)!);
    const { rows } = foldPluginPublications(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe('2.0.0');
    expect(rows[0]!.revoked).toBe(false);
  });

  it('a revocation marks an existing publish revoked', () => {
    const events = [
      publishLog({ agentId: 7n, cid: 'c', blockNumber: 5n, logIndex: 0 }),
      revokeLog({ agentId: 7n, cid: 'c', reason: 'bad', blockNumber: 9n, logIndex: 0 }),
    ].map((l) => decodePluginMetadataLog(l)!);
    const { rows } = foldPluginPublications(events);
    expect(rows[0]!.revoked).toBe(true);
    expect(rows[0]!.revokedReason).toBe('bad');
  });

  it('a republish after a revoke un-revokes', () => {
    const events = [
      publishLog({ agentId: 7n, cid: 'c', blockNumber: 5n, logIndex: 0 }),
      revokeLog({ agentId: 7n, cid: 'c', blockNumber: 9n, logIndex: 0 }),
      publishLog({ agentId: 7n, cid: 'c', version: '3.0.0', blockNumber: 12n, logIndex: 0 }),
    ].map((l) => decodePluginMetadataLog(l)!);
    const { rows } = foldPluginPublications(events);
    expect(rows[0]!.revoked).toBe(false);
    expect(rows[0]!.version).toBe('3.0.0');
  });

  it('drops a revocation with no prior publish', () => {
    const events = [revokeLog({ agentId: 7n, cid: 'ghost', blockNumber: 5n, logIndex: 0 })].map(
      (l) => decodePluginMetadataLog(l)!,
    );
    const { rows } = foldPluginPublications(events);
    expect(rows).toHaveLength(0);
  });
});

describe('createPluginPublicationReader', () => {
  it('lists publications newest-first by (blockNumber, logIndex)', async () => {
    const reader = createPluginPublicationReader({
      logSource: fakeLogSource([
        publishLog({ agentId: 1n, cid: 'old', blockNumber: 5n, logIndex: 0 }),
        publishLog({ agentId: 2n, cid: 'newer', blockNumber: 5n, logIndex: 4 }),
        publishLog({ agentId: 3n, cid: 'newest', blockNumber: 8n, logIndex: 0 }),
      ]),
    });
    const rows = await reader.listPluginPublications();
    expect(rows.map((r) => r.cid)).toEqual(['newest', 'newer', 'old']);
  });

  it('filters by builderAgentId and solverType', async () => {
    const reader = createPluginPublicationReader({
      logSource: fakeLogSource([
        publishLog({ agentId: 1n, cid: 'a', supports: ['prediction.v0'], blockNumber: 5n, logIndex: 0 }),
        publishLog({ agentId: 2n, cid: 'b', supports: ['swe.v2'], blockNumber: 6n, logIndex: 0 }),
      ]),
    });
    expect((await reader.listPluginPublications({ builderAgentId: '2' })).map((r) => r.cid)).toEqual(['b']);
    expect((await reader.listPluginPublications({ solverType: 'prediction.v0' })).map((r) => r.cid)).toEqual(['a']);
  });

  it('includes revoked rows by default, excludes when includeRevoked=false', async () => {
    const logs = [
      publishLog({ agentId: 1n, cid: 'a', blockNumber: 5n, logIndex: 0 }),
      revokeLog({ agentId: 1n, cid: 'a', blockNumber: 6n, logIndex: 0 }),
    ];
    const reader = createPluginPublicationReader({ logSource: fakeLogSource(logs) });
    expect(await reader.listPluginPublications()).toHaveLength(1);
    expect(await reader.listPluginPublications({ includeRevoked: false })).toHaveLength(0);
  });

  it('clamps limit to [1, 500]', async () => {
    const logs = Array.from({ length: 6 }, (_, i) =>
      publishLog({ agentId: BigInt(i), cid: `c${i}`, blockNumber: BigInt(i + 1), logIndex: 0 }),
    );
    const reader = createPluginPublicationReader({ logSource: fakeLogSource(logs) });
    expect(await reader.listPluginPublications({ limit: 2 })).toHaveLength(2);
    expect(await reader.listPluginPublications({ limit: 0 })).toHaveLength(1);
  });

  it('listBuilderArtifacts delegates to listPluginPublications filtered by builder', async () => {
    const reader = createPluginPublicationReader({
      logSource: fakeLogSource([
        publishLog({ agentId: 1n, cid: 'a', blockNumber: 5n, logIndex: 0 }),
        publishLog({ agentId: 2n, cid: 'b', blockNumber: 6n, logIndex: 0 }),
      ]),
    });
    const rows = await reader.listBuilderArtifacts({ builderAgentId: '1' });
    expect(rows.map((r) => r.cid)).toEqual(['a']);
  });

  it('getPluginScores returns an empty array (on-chain floor contract)', async () => {
    const reader = createPluginPublicationReader({ logSource: fakeLogSource([]) });
    expect(await reader.getPluginScores({ pluginCid: 'x' })).toEqual([]);
  });

  it('wraps a log-source failure as PluginPublicationUnavailableError', async () => {
    const reader = createPluginPublicationReader({
      logSource: { scanAll: async () => { throw new Error('rpc 503'); } },
    });
    await expect(reader.listPluginPublications()).rejects.toBeInstanceOf(
      PluginPublicationUnavailableError,
    );
  });

  it('propagates an already-typed PluginPublicationUnavailableError', async () => {
    const reader = createPluginPublicationReader({
      logSource: {
        scanAll: async () => {
          throw new PluginPublicationUnavailableError('indexer down');
        },
      },
    });
    await expect(reader.listPluginPublications()).rejects.toThrow('indexer down');
  });
});

describe('createVenuePluginLogSource', () => {
  it('scans logsInRange from the chain-era default to the head', async () => {
    const logsInRange = vi.fn(async () => [
      { blockNumber: 41_200_000n, logIndex: 2, topics: ['0x'] as Hex[], data: '0x' as Hex, address: '0x0', blockHash: '0x0', transactionHash: '0x0', chainId: 84532, finalityTier: 'finalized' },
    ]);
    const src = createVenuePluginLogSource({
      chainLogSource: { logsInRange } as never,
      publicClient: { getBlockNumber: async () => 41_300_000n },
      chainId: 84532,
    });
    const out = await src.scanAll();
    expect(out).toHaveLength(1);
    expect(logsInRange).toHaveBeenCalledWith(41_100_000n, 41_300_000n);
  });

  it('returns [] when fromBlock is past the head', async () => {
    const src = createVenuePluginLogSource({
      chainLogSource: { logsInRange: vi.fn() } as never,
      publicClient: { getBlockNumber: async () => 100n },
      chainId: 84532,
      fromBlock: 200n,
    });
    expect(await src.scanAll()).toEqual([]);
  });

  it('wraps a chain-head read failure', async () => {
    const src = createVenuePluginLogSource({
      chainLogSource: { logsInRange: vi.fn() } as never,
      publicClient: { getBlockNumber: async () => { throw new Error('no rpc'); } },
      chainId: 8453,
    });
    await expect(src.scanAll()).rejects.toBeInstanceOf(PluginPublicationUnavailableError);
  });
});

describe('createRpcPluginLogSource', () => {
  it('chunks getLogs over the identity registry and maps raw logs', async () => {
    const getLogs = vi.fn(async () => [
      { blockNumber: 50n, logIndex: 1, topics: ['0x'] as Hex[], data: '0x' as Hex },
      { blockNumber: null, logIndex: 2, topics: ['0x'] as Hex[], data: '0x' as Hex },
    ]);
    const src = createRpcPluginLogSource({
      publicClient: { getBlockNumber: async () => 60n, getLogs } as never,
      identityRegistry: '0x1111111111111111111111111111111111111111',
      chainId: 8453,
      fromBlock: 40n,
      chunkBlocks: 100n,
    });
    const out = await src.scanAll();
    // null-blockNumber log is skipped
    expect(out).toEqual([{ blockNumber: 50n, logIndex: 1, topics: ['0x'], data: '0x' }]);
    expect(getLogs).toHaveBeenCalledWith({
      address: '0x1111111111111111111111111111111111111111',
      fromBlock: 40n,
      toBlock: 60n,
    });
  });

  it('wraps a getLogs failure', async () => {
    const src = createRpcPluginLogSource({
      publicClient: {
        getBlockNumber: async () => 60n,
        getLogs: async () => { throw new Error('boom'); },
      } as never,
      identityRegistry: '0x1111111111111111111111111111111111111111',
      chainId: 8453,
      fromBlock: 40n,
    });
    await expect(src.scanAll()).rejects.toBeInstanceOf(PluginPublicationUnavailableError);
  });
});
