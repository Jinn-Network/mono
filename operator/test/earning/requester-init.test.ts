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
  REQUESTER_MASTER_ETH_CAP,
  SAFE_CREATE_PROXY_GAS,
  quoteRequesterSafeFunding,
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

describe('quoteRequesterSafeFunding', () => {
  it('returns the static floor when fees are unknown', () => {
    expect(quoteRequesterSafeFunding(0n)).toEqual({
      agentWei: REQUESTER_SAFE_DEPLOY_ETH,
      masterWei: requesterMinMasterEth(),
    });
  });

  it('raises the agent transfer when gas × fee exceeds the 0.001 ETH floor', () => {
    // 10 gwei × 800k gas × 2 headroom = 0.016 ETH, then cap at 0.01.
    const tenGwei = 10_000_000_000n;
    const quote = quoteRequesterSafeFunding(tenGwei);
    expect(quote.masterWei).toBe(REQUESTER_MASTER_ETH_CAP);
    expect(quote.masterWei).toBeLessThan(20_000_000_000_000_000n);
    expect(quote.agentWei).toBeGreaterThan(REQUESTER_SAFE_DEPLOY_ETH);
    expect(SAFE_CREATE_PROXY_GAS * tenGwei).toBeGreaterThan(REQUESTER_SAFE_DEPLOY_ETH);
  });

  it('stays on the floor at current Base Sepolia sub-gwei fees', () => {
    const subGwei = 6_000_000n;
    expect(quoteRequesterSafeFunding(subGwei).masterWei).toBe(requesterMinMasterEth());
  });
});

describe('requesterMinMasterEth', () => {
  it('is far below the operator bootstrap target', () => {
    const operator = stage1MinMasterEth({ minEoaGasEth: 5_000_000_000_000_000n }, 1);
    expect(requesterMinMasterEth()).toBeLessThan(operator / 10n);
    expect(quoteRequesterSafeFunding(10_000_000_000n).masterWei).toBeLessThan(operator);
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

  it('refuses one wei below the gate', async () => {
    // Boundary test for the funding comparison itself (`masterBalance < required`):
    // one wei short must still refuse, proving the comparison is strict `<` and
    // not an off-by-one `<=`/rounding artifact that would let a requester through
    // a hair short of what Safe deployment actually costs.
    const short = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(short);
    const shortBootstrapper = buildBootstrapper(short);
    vi.spyOn((shortBootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      requesterMinMasterEth() - 1n,
    );

    const shortResult = await shortBootstrapper.ensureRequesterSafe('test-password');

    expect(shortResult.ok).toBe(false);
    expect(shortResult.funding).toBeDefined();
    expect(shortResult.funding?.eth_required).toBe('1');
    expect(shortResult.funding?.eth_balance).toBe((requesterMinMasterEth() - 1n).toString());
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

  it('is idempotent at the balance a first run actually leaves behind', async () => {
    // The balance matters. A completed first run sends REQUESTER_SAFE_DEPLOY_ETH
    // to the agent EOA plus gas, so the master lands *below* the pre-deployment
    // gate. Mocking a comfortable balance here would prove only the getCode
    // short-circuit and would miss a funding gate that runs ahead of it —
    // asking a requester whose Safe is deployed to fund work that is finished.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const store = await seedKeystore(earningDir);
    await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE, requester_stage: 'safe_deployed' });
    const bootstrapper = buildBootstrapper(earningDir);

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      requesterMinMasterEth() - REQUESTER_SAFE_DEPLOY_ETH,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');
    const predict = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    const deploy = vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy');

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(result.ok).toBe(true);
    expect(result.funding).toBeUndefined();
    expect(predict).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
    expect(result.fleet_state.fleet_safe_address).toBe(PREDICTED_SAFE);
  });

  it('does not mint the requester marker for a Safe deployed over the operator path', async () => {
    // `requester_stage` means "a creator Safe reached over the *requester*
    // path". An operator who already ran `jinn bootstrap` and then invokes this
    // entry point hits the same short-circuit with a Safe that says nothing of
    // the sort, and back-filling the marker there mints a claim the persona
    // predicate then has to talk down.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const store = await seedKeystore(earningDir);
    await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE, fleet_stage: 'stage1' });
    const bootstrapper = buildBootstrapper(earningDir);

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      requesterMinMasterEth(),
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.requester_stage).toBe('none');
  });

  it('does not re-enter the testnet faucet once the Safe is deployed', async () => {
    // Testnet degrades rather than breaks without the short-circuit: the drained
    // master re-enters the drip loop and spends part of the 4:30 budget on a
    // no-op.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(await encryptMnemonic(generateMnemonic(), 'test-password'));
    await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE, requester_stage: 'safe_deployed' });

    const requestFunding = vi.fn(async () => ({ ok: true as const, txHash: '0xabc' }));
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      requestFunding,
      autoTestnetFaucet: true,
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      requesterMinMasterEth() - REQUESTER_SAFE_DEPLOY_ETH,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(result.ok).toBe(true);
    expect(requestFunding).not.toHaveBeenCalled();
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
    vi.spyOn((bootstrapper as any).publicClient, 'estimateFeesPerGas').mockRejectedValue(
      new Error('offline'),
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getGasPrice').mockRejectedValue(
      new Error('offline'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(requestFunding).toHaveBeenCalled();
    // ~15 drips at the requester target, nowhere near the operator's ~200.
    expect(requestFunding.mock.calls.length).toBeLessThan(60);
    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    const logged = errorSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(logged.some((line) => line.includes('CDP faucet reached target'))).toBe(false);
  });

  it('logs when the CDP faucet reaches the requester target', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const store = await seedKeystore(earningDir);

    const requestFunding = vi.fn(async () => ({ ok: true as const, txHash: '0xabc' }));
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      requestFunding,
      autoTestnetFaucet: true,
    });
    vi.spyOn((bootstrapper as any).publicClient, 'estimateFeesPerGas').mockRejectedValue(
      new Error('offline'),
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getGasPrice').mockRejectedValue(
      new Error('offline'),
    );

    let getBalanceCalls = 0;
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockImplementation(async () => {
      getBalanceCalls += 1;
      return getBalanceCalls === 1 ? 0n : requesterMinMasterEth();
    });
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );
    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
      return store.load('base-sepolia');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base-sepolia');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    const logged = errorSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(logged).toContain('[requester-init] CDP faucet reached target after 5 drips');
    expect(logged.some((line) => line.includes('CDP faucet stopped after'))).toBe(false);
    expect(result.ok).toBe(true);
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

  it('quotes a higher agent transfer on Base Sepolia when maxFee is high', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const store = await seedKeystore(earningDir);
    await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
    const tenGwei = 10_000_000_000n;
    const quote = quoteRequesterSafeFunding(tenGwei);
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });
    vi.spyOn((bootstrapper as any).publicClient, 'estimateFeesPerGas').mockResolvedValue({
      maxFeePerGas: tenGwei,
      maxPriorityFeePerGas: 1_000_000n,
    });
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(quote.masterWei);
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0x');
    const deploy = vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy')
      .mockImplementation(async () => store.load('base-sepolia'));

    await bootstrapper.ensureRequesterSafe('test-password');

    expect(deploy).toHaveBeenCalledTimes(1);
    expect(deploy.mock.calls[0]![2]).toBe(quote.agentWei);
    expect(quote.agentWei).toBeGreaterThan(REQUESTER_SAFE_DEPLOY_ETH);
  });

  it('maps a post-gate insufficient-funds deploy to a funding pause, not a bare failure', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-b0a-'));
    dirs.push(earningDir);
    const store = await seedKeystore(earningDir);
    await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });
    vi.spyOn((bootstrapper as any).publicClient, 'estimateFeesPerGas').mockRejectedValue(
      new Error('no fees'),
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getGasPrice').mockRejectedValue(
      new Error('no gas'),
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      requesterMinMasterEth(),
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0x');
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockRejectedValue(
      new Error('insufficient funds for gas * price + value'),
    );

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    expect(result.funding?.master_address).toBe(result.fleet_state.master_address);
    expect(result.funding?.eth_required).toBeDefined();
  });
});
