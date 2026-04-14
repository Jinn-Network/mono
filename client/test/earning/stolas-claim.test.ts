import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbiCoder, type JsonRpcProvider, type Signer } from 'ethers';
import {
  listStolasClaimTargets,
  tickStolasDistributorClaims,
} from '../../src/earning/stolas-claim.js';
import type { ServiceState } from '../../src/earning/types.js';
import * as txRetry from '../../src/tx-retry.js';
import { TransientError } from '../../src/types/errors.js';

vi.mock('../../src/tx-retry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/tx-retry.js')>();
  return {
    ...actual,
    ethersSendTransactionWithRetry: vi.fn(),
    ethersWaitForTransactionHashWithRetry: vi.fn(),
  };
});

function providerWithPendingReward(pendingWei = 1n): JsonRpcProvider {
  const coder = AbiCoder.defaultAbiCoder();
  return {
    call: vi.fn().mockResolvedValue(coder.encode(['uint256'], [pendingWei])),
  } as unknown as JsonRpcProvider;
}

function providerWithReadFailure(message: string): JsonRpcProvider {
  return {
    call: vi.fn().mockRejectedValue(new Error(message)),
  } as unknown as JsonRpcProvider;
}

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

describe('tickStolasDistributorClaims failure accounting / strict', () => {
  const dist = '0x0000000000000000000000000000000000000001';
  const signer = {} as Signer;

  beforeEach(() => {
    vi.mocked(txRetry.ethersSendTransactionWithRetry).mockReset();
    vi.mocked(txRetry.ethersWaitForTransactionHashWithRetry).mockReset();
  });

  it('default mode does not throw on recoverable send failure', async () => {
    const provider = providerWithPendingReward();
    vi.mocked(txRetry.ethersSendTransactionWithRetry).mockRejectedValue(new Error('nonce too low'));

    const r = await tickStolasDistributorClaims(provider, signer, {
      distributorAddress: dist,
      stakingMode: 'standard',
      targets: [{ stakingProxy: '0x0000000000000000000000000000000000000002', serviceId: 1 }],
    });

    expect(r.claimAttempted).toBe(1);
    expect(r.submitted).toBe(0);
    expect(r.failedRecoverable).toBe(1);
    expect(r.failedPermanent).toBe(0);
  });

  it('strict mode throws TransientError when every claim send fails recoverably', async () => {
    const provider = providerWithPendingReward();
    vi.mocked(txRetry.ethersSendTransactionWithRetry).mockRejectedValue(new Error('nonce too low'));

    await expect(
      tickStolasDistributorClaims(provider, signer, {
        distributorAddress: dist,
        stakingMode: 'standard',
        targets: [{ stakingProxy: '0x0000000000000000000000000000000000000002', serviceId: 1 }],
        strict: true,
      }),
    ).rejects.toThrow(TransientError);
  });

  it('strict mode throws TransientError when every pending-reward read fails recoverably', async () => {
    const provider = providerWithReadFailure('timeout');

    await expect(
      tickStolasDistributorClaims(provider, signer, {
        distributorAddress: dist,
        stakingMode: 'standard',
        targets: [{ stakingProxy: '0x0000000000000000000000000000000000000002', serviceId: 1 }],
        strict: true,
      }),
    ).rejects.toThrow(TransientError);
  });

  it('strict mode throws Error on insufficient funds (non-recoverable)', async () => {
    const provider = providerWithPendingReward();
    vi.mocked(txRetry.ethersSendTransactionWithRetry).mockRejectedValue(new Error('insufficient funds'));

    await expect(
      tickStolasDistributorClaims(provider, signer, {
        distributorAddress: dist,
        stakingMode: 'standard',
        targets: [{ stakingProxy: '0x0000000000000000000000000000000000000002', serviceId: 1 }],
        strict: true,
      }),
    ).rejects.toThrow(/Distributor claim: all/);
  });

  it('strict mode does not throw when at least one claim succeeds (partial failure)', async () => {
    const provider = providerWithPendingReward();
    vi.mocked(txRetry.ethersSendTransactionWithRetry)
      .mockResolvedValueOnce({ hash: '0xabc' } as never)
      .mockRejectedValueOnce(new Error('nonce too low'));
    vi.mocked(txRetry.ethersWaitForTransactionHashWithRetry).mockResolvedValue({ status: 1 } as never);

    const r = await tickStolasDistributorClaims(provider, signer, {
      distributorAddress: dist,
      stakingMode: 'standard',
      targets: [
        { stakingProxy: '0x0000000000000000000000000000000000000002', serviceId: 1 },
        { stakingProxy: '0x0000000000000000000000000000000000000003', serviceId: 2 },
      ],
      strict: true,
    });

    expect(r.submitted).toBe(1);
    expect(r.failedRecoverable).toBe(1);
  });
});
