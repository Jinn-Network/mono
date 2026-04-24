import { describe, it, expect, vi } from 'vitest';
import { Registry8004 } from '../../src/discovery/registry.js';

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
