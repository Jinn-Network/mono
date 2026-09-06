/**
 * B0a (#2446) — requester-only onboarding.
 *
 * The invariant these tests exist for: a requester reaches a funded creator
 * Safe without buying any of the supplier's machinery, and is asked for the
 * requester's number rather than the operator's.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetBootstrapper, stage1MinMasterEth } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  REQUESTER_SAFE_DEPLOY_ETH,
  requesterMinMasterEth,
} from '../../src/earning/requester-init.js';
import { encryptMnemonic, generateMnemonic } from '../../src/earning/wallet.js';

const PREDICTED_SAFE = '0xBBBB000000000000000000000000000000000002';

function buildBootstrapper(earningDir: string): FleetBootstrapper {
  return new FleetBootstrapper({
    earningDir,
    chain: 'base',
    rpcUrl: 'http://127.0.0.1:8545',
    stakingMode: 'standard',
  });
}

async function seedKeystore(earningDir: string): Promise<FleetStateStore> {
  const store = new FleetStateStore(earningDir);
  await store.saveMnemonicKeystore(await encryptMnemonic(generateMnemonic(), 'test-password'));
  return store;
}

describe('requesterMinMasterEth', () => {
  it('is far below the operator bootstrap target', () => {
    // The §4.2 defect in one assertion: a requester was being asked for the
    // operator's number. At ~0.0001 ETH per CDP drip that difference is the
    // difference between ~15 drips and ~200 against a 4:30 budget.
    const operator = stage1MinMasterEth({ minEoaGasEth: 5_000_000_000_000_000n }, 1);
    expect(requesterMinMasterEth()).toBeLessThan(operator / 10n);
  });
});

describe('FleetBootstrapper.ensureRequesterSafe', () => {
  const dirs: string[] = [];

  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('pauses at the requester funding gate, not the operator one', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const bootstrapper = buildBootstrapper(earningDir);
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding?.eth_required).toBe(requesterMinMasterEth().toString());
    expect(result.fleet_state.requester_stage).toBe('none');
    expect(result.fleet_state.services).toEqual([]);
  });

  it('never routes the requester to the operator daemon or bootstrap', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const bootstrapper = buildBootstrapper(earningDir);
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(result.message).not.toContain('jinn run');
    expect(result.message).not.toContain('bootstrap');
  });

  it('walks wallet → predict → deploy and stops, minting no identity', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const store = await seedKeystore(earningDir);
    const bootstrapper = buildBootstrapper(earningDir);

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );
    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
      return store.load('base');
    });
    const deploy = vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });
    const identity = vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister');

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(result.ok).toBe(true);
    expect(deploy).toHaveBeenCalledTimes(1);
    // No ERC-8004 mint, no bind, no service row, no staking, no mech.
    expect(identity).not.toHaveBeenCalled();
    expect(result.fleet_state.fleet_safe_address).toBe(PREDICTED_SAFE);
    expect(result.fleet_state.fleet_agent_id).toBeNull();
    expect(result.fleet_state.fleet_stage).toBe('none');
    expect(result.fleet_state.requester_stage).toBe('safe_deployed');
    expect(result.fleet_state.services).toEqual([]);
  });

  it('is idempotent: a second run redeploys nothing', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const store = await seedKeystore(earningDir);
    await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE, requester_stage: 'safe_deployed' });
    const bootstrapper = buildBootstrapper(earningDir);

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');
    const predict = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    const deploy = vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy');

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(result.ok).toBe(true);
    expect(predict).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
    expect(result.fleet_state.fleet_safe_address).toBe(PREDICTED_SAFE);
  });

  it('drains the testnet faucet toward the requester target before refusing', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    await seedKeystore(earningDir);

    const requestFunding = vi.fn(async () => ({ ok: true as const, txHash: '0xabc' }));
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      requestFunding,
      autoTestnetFaucet: true,
    });

    // Still short after every drip: the loop must terminate on its cap, not spin.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(requestFunding).toHaveBeenCalled();
    // ~15 drips at the requester target, nowhere near the operator's ~200.
    expect(requestFunding.mock.calls.length).toBeLessThan(60);
    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
  });

  it('funds the deploying EOA with an amount the requester gate can actually cover', async () => {
    // The gate and the transfer must agree. `stepFleetSafeDeploy` defaults to
    // the operator's STAGE1_AGENT_ETH (0.01), which a master that only cleared
    // the 0.0015 requester gate cannot send — it would clear the gate and then
    // fail on the very next transaction.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const store = await seedKeystore(earningDir);
    await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
    const bootstrapper = buildBootstrapper(earningDir);

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      requesterMinMasterEth(),
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0x');
    const deploy = vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy')
      .mockImplementation(async () => store.load('base'));

    await bootstrapper.ensureRequesterSafe('test-password');

    expect(deploy).toHaveBeenCalledTimes(1);
    const agentFundingWei = deploy.mock.calls[0]![2] as bigint;
    expect(agentFundingWei).toBe(REQUESTER_SAFE_DEPLOY_ETH);
    expect(agentFundingWei).toBeLessThan(requesterMinMasterEth());
  });
});
