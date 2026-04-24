import { describe, it, expect, vi } from 'vitest';
import { Registry8004 } from '../../src/discovery/registry.js';

function makeRegistry() {
  const writeMock = vi.fn().mockResolvedValue('0xtx');
  const waitMock = vi.fn().mockResolvedValue({ blockNumber: 42n });
  const registry = new Registry8004({
    chainId: 'eip155:84532',
    contractAddress: '0x' + '00'.repeat(20),
    privateKey: '0x' + '11'.repeat(32),
  });
  (registry as any).walletClient = { writeContract: writeMock };
  (registry as any).publicClient = { waitForTransactionReceipt: waitMock };
  return { registry, writeMock, waitMock };
}

describe('Registry8004.registerIntent', () => {
  it('builds the correct (agentURI, metadata[]) call and returns the tx block number', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtxhash');
    const waitMock = vi.fn().mockResolvedValue({ blockNumber: 42n });
    const registry = new Registry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    const blockNumber = await registry.registerIntent({
      intentCid: 'bafy-intent',
      kind: 'portfolio.v0',
      creator: '0x1111111111111111111111111111111111111111',
      createdAt: 1700000000000,
      requestId: '0x' + 'ab'.repeat(32),
    });

    expect(blockNumber).toBe(42n);
    expect(writeMock).toHaveBeenCalledTimes(1);
    const args = writeMock.mock.calls[0]![0];
    expect(args.functionName).toBe('register');
    expect(args.args[0]).toBe('intent:bafy-intent');

    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).toContain('documentType');
    expect(keys).toContain('kind');
    expect(keys).toContain('creator');
    expect(keys).toContain('createdAt');
    expect(keys).toContain('requestId');
  });
});

describe('Registry8004.registerEnvelope', () => {
  it('builds correct args for a restoration envelope', async () => {
    const { registry, writeMock } = makeRegistry();

    await registry.registerEnvelope({
      envelopeCid: 'bafy-env',
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'self-signed',
      intentCid: 'bafy-intent',
      participant: '0x2222222222222222222222222222222222222222',
      generatedAt: 1700000000000,
    });

    const args = writeMock.mock.calls[0]![0];
    expect(args.args[0]).toBe('envelope:bafy-env');
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).toContain('role');
    expect(keys).toContain('evidenceTier');
    expect(keys).not.toContain('parentEnvelopeCid');
  });

  it('includes parentEnvelopeCid for verdict envelopes', async () => {
    const { registry, writeMock, waitMock } = makeRegistry();
    waitMock.mockResolvedValue({ blockNumber: 101n });

    await registry.registerEnvelope({
      envelopeCid: 'bafy-verdict',
      kind: 'portfolio.v0',
      role: 'verdict',
      evidenceTier: 'self-signed',
      intentCid: 'bafy-intent',
      parentEnvelopeCid: 'bafy-restore',
      participant: '0x3333333333333333333333333333333333333333',
      generatedAt: 1700000000500,
    });

    const args = writeMock.mock.calls[0]![0];
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).toContain('parentEnvelopeCid');
  });

  it('includes measurement for attested tier envelopes', async () => {
    const { registry, writeMock, waitMock } = makeRegistry();
    waitMock.mockResolvedValue({ blockNumber: 102n });

    await registry.registerEnvelope({
      envelopeCid: 'bafy-env',
      kind: 'portfolio.v0',
      role: 'restoration',
      evidenceTier: 'attested',
      intentCid: 'bafy-intent',
      measurement: '0x' + 'cc'.repeat(48),
      participant: '0x3333333333333333333333333333333333333333',
      generatedAt: 1700000000000,
    });

    const args = writeMock.mock.calls[0]![0];
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).toContain('measurement');
  });
});

describe('Registry8004.registerSourceBundle', () => {
  it('registers an adw:SourceBundle under source:<cid>', async () => {
    const { registry, writeMock, waitMock } = makeRegistry();
    waitMock.mockResolvedValue({ blockNumber: 200n });

    const block = await registry.registerSourceBundle({
      bundleCid: 'bafy-src',
      measurement: '0x' + 'dd'.repeat(48),
      buildRecipeKind: 'dockerfile',
      publishedBy: '0x4444444444444444444444444444444444444444',
      humanUrl: 'https://github.com/jinn/client-1.0.0',
    });

    expect(block).toBe(200n);
    const args = writeMock.mock.calls[0]![0];
    expect(args.args[0]).toBe('source:bafy-src');
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'documentType',
        'measurement',
        'buildRecipeKind',
        'publishedBy',
        'humanUrl',
      ]),
    );
  });

  it('omits humanUrl when not provided', async () => {
    const { registry, writeMock, waitMock } = makeRegistry();
    waitMock.mockResolvedValue({ blockNumber: 201n });

    await registry.registerSourceBundle({
      bundleCid: 'bafy-src',
      measurement: '0x' + 'dd'.repeat(48),
      buildRecipeKind: 'nix',
      publishedBy: '0x4444444444444444444444444444444444444444',
    });

    const args = writeMock.mock.calls[0]![0];
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).not.toContain('humanUrl');
  });
});

describe('Registry8004.registerArtifactWithParent', () => {
  it('includes parentEnvelopeCid in metadata', async () => {
    const { registry, writeMock, waitMock } = makeRegistry();
    waitMock.mockResolvedValue({ blockNumber: 300n });

    await registry.registerArtifactWithParent({
      id: 'bafy-art',
      title: 'trajectory',
      tags: ['portfolio.v0'],
      outcome: 'PASS',
      endpoint: 'ipfs://bafy-art',
      parentEnvelopeCid: 'bafy-env',
    });

    const args = writeMock.mock.calls[0]![0];
    const kv = (args.args[1] as Array<{ metadataKey: string; metadataValue: string }>)
      .reduce((acc, { metadataKey, metadataValue }) => {
        acc[metadataKey] = metadataValue;
        return acc;
      }, {} as Record<string, string>);
    expect(kv['parentEnvelopeCid']).toBeDefined();
  });

  it('existing registerArtifact still works without parentEnvelopeCid (back-compat)', async () => {
    const { registry, writeMock, waitMock } = makeRegistry();
    waitMock.mockResolvedValue({ blockNumber: 301n });

    await registry.registerArtifact({
      id: 'bafy-art-legacy',
      title: 'old-artifact',
      tags: ['tag1'],
      outcome: 'PASS',
      endpoint: 'ipfs://bafy-art-legacy',
    });

    const args = writeMock.mock.calls[0]![0];
    expect(args.args[0]).toBe('artifact:bafy-art-legacy');
    const keys = (args.args[1] as Array<{ metadataKey: string }>).map((m) => m.metadataKey);
    expect(keys).not.toContain('parentEnvelopeCid');
  });
});
