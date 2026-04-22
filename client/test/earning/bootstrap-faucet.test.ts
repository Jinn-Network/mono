import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requestTestnetFundingMock = vi.fn(async () => ({
  ok: true,
  txHash: '0x' + '12'.repeat(32),
}));

vi.mock('../../src/earning/faucet.js', () => ({
  requestTestnetFunding: requestTestnetFundingMock,
}));

describe('Fleet bootstrap faucet cap', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    requestTestnetFundingMock.mockClear();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('does not send an extra faucet request after the drip cap', async () => {
    const earningDir = await mkdtemp(join(tmpdir(), 'jinn-faucet-cap-'));
    dirs.push(earningDir);

    const { FleetBootstrapper } = await import('../../src/earning/bootstrap.js');
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'https://sepolia.base.org',
      env: {},
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: (...args: unknown[]) => void) => {
      queueMicrotask(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    expect(requestTestnetFundingMock).toHaveBeenCalledTimes(60);
  });
});
