import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requestTestnetFundingMock = vi.fn(async () => ({
  ok: true,
  txHash: '0x' + '12'.repeat(32),
}));

describe('Fleet bootstrap faucet cap', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    requestTestnetFundingMock.mockClear();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('keeps dripping until the master EOA reaches the fresh-fleet bootstrap target', async () => {
    const earningDir = await mkdtemp(join(tmpdir(), 'jinn-faucet-success-'));
    dirs.push(earningDir);

    const { FleetBootstrapper } = await import('../../src/earning/bootstrap.js');
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'https://sepolia.base.org',
      env: {},
      stakingMode: 'standard',
      requestFunding: requestTestnetFundingMock,
    });

    const DRIP_WEI = 100_000_000_000_000n;
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockImplementation(async () => {
      const drips = BigInt(requestTestnetFundingMock.mock.calls.length);
      return drips * DRIP_WEI;
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: (...args: unknown[]) => void) => {
      queueMicrotask(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    // Stage 1 must short-circuit so the faucet loop in ensureStage1And2 runs.
    // Mock ensureStage1 to return ok: true with fleet_stage='stage1' (nghf).
    vi.spyOn(bootstrapper as any, 'ensureStage1').mockResolvedValue({
      ok: true,
      fleet_state: {
        master_address: null,
        chain: 'base-sepolia',
        staking_mode: 'standard',
        services: [],
        updated_at: new Date().toISOString(),
        fleet_agent_id: null,
        fleet_safe_address: null,
        fleet_identity_registry: null,
        fleet_stage: 'stage1',
      },
      message: 'Stage 1 already complete.',
    });
    vi.spyOn(bootstrapper as any, 'reconcileFleetWithChain').mockImplementation(async () => {
      throw new Error('reconcile_short_circuit');
    });

    await bootstrapper.bootstrap('test-password');

    expect(requestTestnetFundingMock).toHaveBeenCalledTimes(100);
  });

  it('does not send an extra faucet request after the drip cap', async () => {
    const earningDir = await mkdtemp(join(tmpdir(), 'jinn-faucet-cap-'));
    dirs.push(earningDir);

    const { FleetBootstrapper } = await import('../../src/earning/bootstrap.js');
    const { computeFaucetDripCap } = await import('../../src/earning/faucet.js');
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'https://sepolia.base.org',
      env: {},
      stakingMode: 'standard',
      requestFunding: requestTestnetFundingMock,
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: (...args: unknown[]) => void) => {
      queueMicrotask(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    // Stage 1 must short-circuit so the faucet loop in ensureStage1And2 runs.
    vi.spyOn(bootstrapper as any, 'ensureStage1').mockResolvedValue({
      ok: true,
      fleet_state: {
        master_address: null,
        chain: 'base-sepolia',
        staking_mode: 'standard',
        services: [],
        updated_at: new Date().toISOString(),
        fleet_agent_id: null,
        fleet_safe_address: null,
        fleet_identity_registry: null,
        fleet_stage: 'stage1',
      },
      message: 'Stage 1 already complete.',
    });

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    const expectedCap = computeFaucetDripCap({
      targetWei: 10_000_000_000_000_000n,
      balanceWei: 0n,
    });
    expect(expectedCap).toBeGreaterThan(60);
    expect(requestTestnetFundingMock).toHaveBeenCalledTimes(expectedCap);
  });

  it('stops the auto-faucet loop at the wall-clock cutoff', async () => {
    const earningDir = await mkdtemp(join(tmpdir(), 'jinn-faucet-timeout-'));
    dirs.push(earningDir);

    let now = 0;
    const { FleetBootstrapper } = await import('../../src/earning/bootstrap.js');
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'https://sepolia.base.org',
      env: {},
      stakingMode: 'standard',
      requestFunding: requestTestnetFundingMock,
      faucetLoopTimeoutMs: 2,
      now: () => now,
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: (...args: unknown[]) => void) => {
      now = 3;
      queueMicrotask(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    // Stage 1 must short-circuit so the faucet loop in ensureStage1And2 runs.
    vi.spyOn(bootstrapper as any, 'ensureStage1').mockResolvedValue({
      ok: true,
      fleet_state: {
        master_address: null,
        chain: 'base-sepolia',
        staking_mode: 'standard',
        services: [],
        updated_at: new Date().toISOString(),
        fleet_agent_id: null,
        fleet_safe_address: null,
        fleet_identity_registry: null,
        fleet_stage: 'stage1',
      },
      message: 'Stage 1 already complete.',
    });

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    expect(requestTestnetFundingMock).toHaveBeenCalledTimes(1);
  });
});
