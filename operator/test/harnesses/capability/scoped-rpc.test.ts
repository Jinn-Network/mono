import { describe, it, expect, vi } from 'vitest';
import { createScopedRpc } from '../../../src/harnesses/capability/scoped-rpc.js';
import type { ScopedRpc } from '../../../src/harnesses/capability/index.js';

describe('createScopedRpc', () => {
  it('passes allow-listed methods through', async () => {
    const upstream = {
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      readContract: vi.fn(),
      getBalance: vi.fn(),
      getCode: vi.fn(),
      getChainId: vi.fn().mockResolvedValue(8453),
    };
    const rpc = createScopedRpc({
      upstream: upstream as unknown as ScopedRpc,
      chainIdAllowList: [8453],
    });
    expect(await rpc.getBlockNumber()).toBe(123n);
    expect(upstream.getBlockNumber).toHaveBeenCalledOnce();
  });

  it('rejects readContract on a chain not in the allow-list', async () => {
    const upstream = {
      getChainId: vi.fn().mockResolvedValue(1),
      readContract: vi.fn().mockResolvedValue('forbidden'),
      getBlockNumber: vi.fn(),
      getBalance: vi.fn(),
      getCode: vi.fn(),
    };
    const rpc = createScopedRpc({
      upstream: upstream as unknown as ScopedRpc,
      chainIdAllowList: [8453],
    });
    await expect(
      rpc.readContract({
        address: '0x1111111111111111111111111111111111111111',
        abi: [],
        functionName: 'x',
      }),
    ).rejects.toThrow(/chain 1 not in allow-list/i);
    expect(upstream.readContract).not.toHaveBeenCalled();
  });

  it('passes getChainId through unconditionally', async () => {
    const upstream = {
      getChainId: vi.fn().mockResolvedValue(42),
      readContract: vi.fn(),
      getBlockNumber: vi.fn(),
      getBalance: vi.fn(),
      getCode: vi.fn(),
    };
    const rpc = createScopedRpc({
      upstream: upstream as unknown as ScopedRpc,
      chainIdAllowList: [8453],
    });
    expect(await rpc.getChainId()).toBe(42);
  });
});
