import { describe, expect, it, vi } from 'vitest';
import {
  listStolasClaimTargets,
  tickStolasDistributorClaims,
} from '../../src/earning/stolas-claim.js';
import type { ServiceState } from '../../src/earning/types.js';

describe('listStolasClaimTargets', () => {
  it('returns staking proxy and service id for post-stake steps only', () => {
    const services: ServiceState[] = [
      {
        index: 1,
        agent_address: '0x1',
        safe_address: '0xs',
        service_id: 10,
        mech_address: null,
        staking_address: '0xstaking',
        step: 'complete',
        error: null,
      },
      {
        index: 2,
        agent_address: '0x2',
        safe_address: null,
        service_id: null,
        mech_address: null,
        staking_address: null,
        step: 'awaiting_stake',
        error: null,
      },
      {
        index: 3,
        agent_address: '0x3',
        safe_address: '0xs3',
        service_id: 20,
        mech_address: null,
        staking_address: '0xstaking3',
        step: 'mech_deployed',
        error: null,
      },
    ];

    expect(listStolasClaimTargets(services)).toEqual([
      { stakingProxy: '0xstaking', serviceId: 10 },
      { stakingProxy: '0xstaking3', serviceId: 20 },
    ]);
  });

  it('drops rows missing service_id or staking_address', () => {
    const services: ServiceState[] = [
      {
        index: 1,
        agent_address: '0x1',
        safe_address: '0xs',
        service_id: null,
        mech_address: null,
        staking_address: '0xstaking',
        step: 'complete',
        error: null,
      },
      {
        index: 2,
        agent_address: '0x2',
        safe_address: '0xs',
        service_id: 5,
        mech_address: null,
        staking_address: null,
        step: 'complete',
        error: null,
      },
    ];
    expect(listStolasClaimTargets(services)).toEqual([]);
  });
});

describe('tickStolasDistributorClaims', () => {
  it('skips when staking mode is not standard', async () => {
    const provider = {} as import('ethers').JsonRpcProvider;
    const signer = { sendTransaction: vi.fn() } as unknown as import('ethers').Signer;

    const r = await tickStolasDistributorClaims(provider, signer, {
      distributorAddress: '0xdist',
      stakingMode: 'self-bond',
      targets: [{ stakingProxy: '0xstake', serviceId: 1 }],
    });

    expect(r.skippedWrongMode).toBe(true);
    expect(signer.sendTransaction).not.toHaveBeenCalled();
  });

  it('skips when distributor is not configured', async () => {
    const provider = {} as import('ethers').JsonRpcProvider;
    const signer = { sendTransaction: vi.fn() } as unknown as import('ethers').Signer;

    const r = await tickStolasDistributorClaims(provider, signer, {
      distributorAddress: undefined,
      stakingMode: 'standard',
      targets: [{ stakingProxy: '0xstake', serviceId: 1 }],
    });

    expect(r.skippedNoDistributor).toBe(true);
    expect(signer.sendTransaction).not.toHaveBeenCalled();
  });
});
