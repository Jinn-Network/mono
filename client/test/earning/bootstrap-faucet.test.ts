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

    // Fresh-fleet Stage 2 gate is now `minEoaGasEth = 0.005 ETH` (jinn-mono-u34i:
    // dropped from `× 2` because the `× 2` double-counted a service-1 transfer
    // that doesn't fire — HD-1 reuses Stage 1's leftover). At 0.0001 ETH/drip
    // that's 50 drips to reach the target.
    expect(requestTestnetFundingMock).toHaveBeenCalledTimes(50);
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
    // Stage 2 gate is now `minEoaGasEth = 0.005 ETH` for fresh fleets
    // (jinn-mono-u34i tightening; see comment in the test above).
    const expectedCap = computeFaucetDripCap({
      targetWei: 5_000_000_000_000_000n,
      balanceWei: 0n,
    });
    expect(expectedCap).toBeGreaterThan(60);
    expect(requestTestnetFundingMock).toHaveBeenCalledTimes(expectedCap);
  });

  it('stops the auto-faucet loop at the wall-clock cutoff', async () => {
    const earningDir = await mkdtemp(join(tmpdir(), 'jinn-faucet-timeout-'));
    dirs.push(earningDir);

    let now = 0;
    // #984 work unit 1 removed the unconditional inter-drip setTimeout, so the
    // wall-clock now-source must advance through a seam that survives that
    // change. The faucet call itself trips the clock past the deadline — same
    // pattern as the setup-endpoints drip-timeout test.
    const tripClockMock = vi.fn(async () => {
      now = 3;
      return { ok: true as const, txHash: '0x' + '12'.repeat(32) };
    });
    const { FleetBootstrapper } = await import('../../src/earning/bootstrap.js');
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'https://sepolia.base.org',
      env: {},
      stakingMode: 'standard',
      requestFunding: tripClockMock,
      faucetLoopTimeoutMs: 2,
      now: () => now,
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);
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
    expect(tripClockMock).toHaveBeenCalledTimes(1);
  });

  // AC-2 (issue #984 work unit 1): a transient CDP 429 must back off and retry
  // within the bootstrap drip loop rather than `break`-ing on the first
  // throttle. `faucetRateLimitBackoffMs: 0` skips the real 15s backoff so the
  // test stays fast.
  it('bootstrap faucet backs off on 429 and retries', async () => {
    const earningDir = await mkdtemp(join(tmpdir(), 'jinn-faucet-429-'));
    dirs.push(earningDir);

    let call = 0;
    const flakyFundingMock = vi.fn(async () => {
      call += 1;
      if (call <= 2) {
        return { ok: false as const, rateLimited: true, reason: 'rate limited' };
      }
      return { ok: true as const, txHash: '0x' + '34'.repeat(32) };
    });

    const { FleetBootstrapper } = await import('../../src/earning/bootstrap.js');
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'https://sepolia.base.org',
      env: {},
      stakingMode: 'standard',
      requestFunding: flakyFundingMock,
      faucetRateLimitBackoffMs: 0,
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);
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

    await bootstrapper.bootstrap('test-password');

    expect(flakyFundingMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
