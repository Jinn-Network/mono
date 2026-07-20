import { describe, expect, it, vi } from 'vitest';
import { createPublisherSafeResolver } from '../../src/erc8004/publisher-safe-resolver.js';

const SAFE = '0x1111111111111111111111111111111111111111';

describe('createPublisherSafeResolver', () => {
  it('reads getAgentWallet on the exact chain and caches the binding', async () => {
    const getChainId = vi.fn(async () => 84532);
    const readContract = vi.fn(async () => SAFE);
    const resolve = createPublisherSafeResolver({
      rpcUrl: 'http://unused.test',
      expectedChainId: 84532,
      client: { getChainId, readContract },
    });

    await expect(resolve(84532, '101', 123n)).resolves.toBe(SAFE);
    await expect(resolve(84532, '101', 123n)).resolves.toBe(SAFE);
    expect(getChainId).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'getAgentWallet',
      args: [101n],
      blockNumber: 123n,
    }));
  });

  it('rejects chain drift and an unbound zero address', async () => {
    const resolveWrongChain = createPublisherSafeResolver({
      rpcUrl: 'http://unused.test',
      expectedChainId: 84532,
      client: {
        getChainId: async () => 8453,
        readContract: async () => SAFE,
      },
    });
    await expect(resolveWrongChain(84532, '101', 123n)).rejects.toThrow(
      /RPC chain 8453.*expected 84532/,
    );

    const resolveUnbound = createPublisherSafeResolver({
      rpcUrl: 'http://unused.test',
      expectedChainId: 84532,
      client: {
        getChainId: async () => 84532,
        readContract: async () => '0x0000000000000000000000000000000000000000',
      },
    });
    await expect(resolveUnbound(84532, '101', 123n)).rejects.toThrow(/not bound to a Safe/);
  });
});
