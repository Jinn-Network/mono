import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EarningBootstrapper,
  reconcilePredictedSafeState,
  reconcileServiceProgressState,
} from '../../src/earning/bootstrap.js';
import { getChainConfig } from '../../src/earning/contracts.js';
import { EarningStateStore } from '../../src/earning/store.js';
import { createDefaultEarningState } from '../../src/earning/types.js';

describe('Earning bootstrap testnet support', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('exposes the committed Base Sepolia staking constants', () => {
    const config = getChainConfig('base-sepolia');

    expect(config.chainId).toBe(84532);
    expect(config.serviceRegistry).toBe('0x31D3202d8744B16A120117A053459DDFAE93c855');
    expect(config.serviceRegistryTokenUtility).toBe('0xeB49bE5DF00F74bd240DE4535DDe6Bc89CEfb994');
    expect(config.serviceManager).toBe('0x5BA58970c2Ae16Cf6218783018100aF2dCcFc915');
    expect(config.gnosisSafeSameAddressMultisig).toBe('0x10100e74b7F706222F8A7C0be9FC7Ae1717Ad8B2');
    expect(config.olasToken).toBe('0x4F177E56bd79c169742a1BF8907dB0A5e54F5524');
    expect(config.stakingContract).toBe('0xe9c8DaBb4062deEc921562e7E286be3cEcb826b0');
    expect(config.bondAmount).toBe(10n * 10n ** 18n);
  });

  it('persists base-sepolia earning state and stops cleanly after service staking', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-earning-'));
    dirs.push(earningDir);

    const store = new EarningStateStore(earningDir);
    const state = createDefaultEarningState('base-sepolia');
    state.step = 'mech_deployed';
    state.agent_address = '0x00000000000000000000000000000000000000a1';
    state.safe_address = '0x00000000000000000000000000000000000000a2';
    state.service_id = null;
    await store.save(state);

    const bootstrapper = new EarningBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      stopAt: 'service_staked',
      rpcUrl: 'http://127.0.0.1:8545',
    });

    const result = await bootstrapper.bootstrap('test-password');
    const persisted = await bootstrapper.getStatus();

    expect(result.ok).toBe(true);
    expect(result.step).toBe('mech_deployed');
    expect(result.message).toBe('Earning bootstrap reached stop target at service_staked.');
    expect(result.earning_state.chain).toBe('base-sepolia');
    expect(persisted.chain).toBe('base-sepolia');
    expect(persisted.step).toBe('mech_deployed');
  });

  it('rewinds to awaiting_funding when a stale Safe prediction no longer matches the current chain', () => {
    const result = reconcilePredictedSafeState(
      {
        step: 'safe_deployed',
        safe_address: '0x36cE9a1420c81A887CABFFE5086F958DF7403C40',
        service_id: null,
        mech_address: null,
        staking_address: null,
      },
      '0xCE377821Ff921Cb917484C391eBFd83220470188',
    );

    expect(result).toEqual({
      safeAddress: '0xCE377821Ff921Cb917484C391eBFd83220470188',
      step: 'awaiting_funding',
      changed: true,
      rewound: true,
    });
  });

  it('fails loudly if the Safe prediction changes after service creation', () => {
    expect(() => reconcilePredictedSafeState(
      {
        step: 'service_activated',
        safe_address: '0x36cE9a1420c81A887CABFFE5086F958DF7403C40',
        service_id: 7,
        mech_address: null,
        staking_address: null,
      },
      '0xCE377821Ff921Cb917484C391eBFd83220470188',
    )).toThrow('Stored Safe 0x36cE9a1420c81A887CABFFE5086F958DF7403C40 does not match current predicted Safe 0xCE377821Ff921Cb917484C391eBFd83220470188');
  });

  it('rewinds local service progress when on-chain service state lags behind', () => {
    const result = reconcileServiceProgressState(
      {
        step: 'service_staked',
        service_id: 11,
      },
      1,
      0,
    );

    expect(result).toEqual({
      step: 'service_activated',
      changed: true,
    });
  });

  it('advances to mech_deployed when the service is already staked on chain', () => {
    const result = reconcileServiceProgressState(
      {
        step: 'service_staked',
        service_id: 11,
      },
      4,
      1,
    );

    expect(result).toEqual({
      step: 'mech_deployed',
      changed: true,
    });
  });

  it('auto-tops the Safe from the EOA when the EOA has enough excess ETH', async () => {
    const bootstrapper = new EarningBootstrapper({
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
    });

    const state = {
      ...createDefaultEarningState('base'),
      step: 'awaiting_funding' as const,
      agent_address: '0x00000000000000000000000000000000000000a1',
      safe_address: '0x00000000000000000000000000000000000000a2',
    };

    let eoaBalance = 7_000_000_000_000_000n;
    let safeBalance = 0n;

    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockImplementation(async (address: string) => {
      if (address.toLowerCase() === state.agent_address.toLowerCase()) return eoaBalance;
      if (address.toLowerCase() === state.safe_address.toLowerCase()) return safeBalance;
      return 0n;
    });
    vi.spyOn(bootstrapper as any, 'getOlasBalance').mockResolvedValue((bootstrapper as any).config.bondAmount * 2n);
    vi.spyOn(bootstrapper as any, 'transferEth').mockImplementation(async (_password: string, to: string, amount: bigint) => {
      expect(to).toBe(state.safe_address);
      eoaBalance -= amount;
      safeBalance += amount;
    });
    vi.spyOn((bootstrapper as any).store, 'patch').mockImplementation(async (patch: Record<string, unknown>) => ({
      ...state,
      ...patch,
      updated_at: new Date().toISOString(),
    }));

    const result = await (bootstrapper as any).stepCheckFunding(state, 'test-password');

    expect((bootstrapper as any).transferEth).toHaveBeenCalledOnce();
    expect(safeBalance).toBe((bootstrapper as any).config.minSafeEth);
    expect(result.step).toBe('safe_deployed');
  });

  it('describes Safe ETH as part of the EOA funding requirement', () => {
    const bootstrapper = new EarningBootstrapper({
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
    });

    const message = (bootstrapper as any).describeStep('awaiting_funding', {
      eoa_address: '0x00000000000000000000000000000000000000a1',
      eoa_eth_required: '7000000000000000',
      eoa_eth_balance: '0',
      safe_address: '0x00000000000000000000000000000000000000a2',
      safe_eth_required: '2000000000000000',
      safe_eth_balance: '0',
      safe_olas_required: '10000000000000000000000',
      safe_olas_balance: '0',
    });

    expect(message).toContain('gas and Safe top-up');
    expect(message).toContain('auto-top-up the Safe');
    expect(message).toContain('service security deposit and agent bond');
  });
});
