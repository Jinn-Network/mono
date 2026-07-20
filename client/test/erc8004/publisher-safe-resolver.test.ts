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

  it('falls back after an archive read failure and caches the historical binding', async () => {
    const primaryRead = vi.fn(async () => {
      throw new Error('historical state requires an archive token');
    });
    const fallbackRead = vi.fn(async () => SAFE);
    const resolve = createPublisherSafeResolver({
      rpcUrl: 'http://unused-primary.test',
      expectedChainId: 84532,
      client: {
        getChainId: vi.fn(async () => 84532),
        readContract: primaryRead,
      },
      fallbackClients: [{
        getChainId: vi.fn(async () => 84532),
        readContract: fallbackRead,
      }],
    });

    await expect(resolve(84532, '101', 123n)).resolves.toBe(SAFE);
    await expect(resolve(84532, '101', 123n)).resolves.toBe(SAFE);
    expect(primaryRead).toHaveBeenCalledTimes(1);
    expect(fallbackRead).toHaveBeenCalledTimes(1);
    expect(fallbackRead).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'getAgentWallet',
      args: [101n],
      blockNumber: 123n,
    }));
  });

  it('rejects when every provider fails or is on the wrong chain', async () => {
    const wrongChainRead = vi.fn(async () => SAFE);
    const resolve = createPublisherSafeResolver({
      rpcUrl: 'http://unused-primary.test',
      expectedChainId: 84532,
      client: {
        getChainId: async () => 84532,
        readContract: async () => {
          throw new Error('archive state unavailable');
        },
      },
      fallbackClients: [{
        getChainId: async () => 8453,
        readContract: wrongChainRead,
      }],
    });

    await expect(resolve(84532, '101', 123n)).rejects.toThrow(
      /all RPC providers.*archive state unavailable.*RPC chain 8453.*expected 84532/,
    );
    expect(wrongChainRead).not.toHaveBeenCalled();
  });

  it('retries provider chain identification after a transient all-provider failure', async () => {
    const primaryGetChainId = vi.fn()
      .mockRejectedValueOnce(new Error('primary chain probe timed out'))
      .mockResolvedValue(84532);
    const primaryRead = vi.fn(async () => SAFE);
    const fallbackGetChainId = vi.fn()
      .mockRejectedValueOnce(new Error('fallback chain probe timed out'))
      .mockResolvedValue(84532);
    const fallbackRead = vi.fn(async () => SAFE);
    const resolve = createPublisherSafeResolver({
      rpcUrl: 'http://unused-primary.test',
      expectedChainId: 84532,
      client: {
        getChainId: primaryGetChainId,
        readContract: primaryRead,
      },
      fallbackClients: [{
        getChainId: fallbackGetChainId,
        readContract: fallbackRead,
      }],
    });

    await expect(resolve(84532, '101', 123n)).rejects.toThrow(
      /all RPC providers.*primary chain probe timed out.*fallback chain probe timed out/,
    );
    await expect(resolve(84532, '101', 123n)).resolves.toBe(SAFE);
    expect(primaryGetChainId).toHaveBeenCalledTimes(2);
    expect(primaryRead).toHaveBeenCalledTimes(1);
    expect(fallbackRead).not.toHaveBeenCalled();
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
