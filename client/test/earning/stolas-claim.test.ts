import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import type { WalletClient } from 'viem';
import {
  listStolasClaimTargets,
  tickStolasDistributorClaims,
  tickSelfBondStakingClaims,
} from '../../src/earning/stolas-claim.js';
import type { ServiceState } from '../../src/earning/types.js';
import { TransientError } from '../../src/types/errors.js';

function publicClientWithPendingReward(pendingWei = 1n): PublicClient {
  return {
    readContract: vi.fn().mockResolvedValue(pendingWei),
  } as unknown as PublicClient;
}

function publicClientWithReadFailure(message: string): PublicClient {
  return {
    readContract: vi.fn().mockRejectedValue(new Error(message)),
  } as unknown as PublicClient;
}

const noopWallet = {} as WalletClient;

const VALID_SAFE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VALID_KEY = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const VALID_RPC = 'http://127.0.0.1:8545';
const STAKING_PROXY = '0x0000000000000000000000000000000000000002';

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
    const publicClient = {} as PublicClient;
    const sendTx = vi.fn();

    const r = await tickStolasDistributorClaims(publicClient, noopWallet, {
      distributorAddress: '0xdist',
      stakingMode: 'self-bond',
      targets: [{ stakingProxy: '0xstake', serviceId: 1 }],
      retryDeps: { sendTx, waitForReceipt: vi.fn() },
    });

    expect(r.skippedWrongMode).toBe(true);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it('skips when distributor is not configured', async () => {
    const publicClient = {} as PublicClient;
    const sendTx = vi.fn();

    const r = await tickStolasDistributorClaims(publicClient, noopWallet, {
      distributorAddress: undefined,
      stakingMode: 'standard',
      targets: [{ stakingProxy: '0xstake', serviceId: 1 }],
      retryDeps: { sendTx, waitForReceipt: vi.fn() },
    });

    expect(r.skippedNoDistributor).toBe(true);
    expect(sendTx).not.toHaveBeenCalled();
  });
});

describe('tickStolasDistributorClaims failure accounting / strict', () => {
  const dist = '0x0000000000000000000000000000000000000001';

  let sendTx: ReturnType<typeof vi.fn>;
  let waitForReceipt: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendTx = vi.fn();
    waitForReceipt = vi.fn();
  });

  it('default mode does not throw on recoverable send failure', async () => {
    const publicClient = publicClientWithPendingReward();
    sendTx.mockRejectedValue(new Error('nonce too low'));

    const r = await tickStolasDistributorClaims(publicClient, noopWallet, {
      distributorAddress: dist,
      stakingMode: 'standard',
      targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1 }],
      retryDeps: { sendTx, waitForReceipt },
    });

    expect(r.claimAttempted).toBe(1);
    expect(r.submitted).toBe(0);
    expect(r.failedRecoverable).toBe(1);
    expect(r.failedPermanent).toBe(0);
  });

  it('strict mode throws TransientError when every claim send fails recoverably', async () => {
    const publicClient = publicClientWithPendingReward();
    sendTx.mockRejectedValue(new Error('nonce too low'));

    await expect(
      tickStolasDistributorClaims(publicClient, noopWallet, {
        distributorAddress: dist,
        stakingMode: 'standard',
        targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1 }],
        strict: true,
        retryDeps: { sendTx, waitForReceipt },
      }),
    ).rejects.toThrow(TransientError);
  });

  it('strict mode throws TransientError when every pending-reward read fails recoverably', async () => {
    const publicClient = publicClientWithReadFailure('timeout');

    await expect(
      tickStolasDistributorClaims(publicClient, noopWallet, {
        distributorAddress: dist,
        stakingMode: 'standard',
        targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1 }],
        strict: true,
        retryDeps: { sendTx, waitForReceipt },
      }),
    ).rejects.toThrow(TransientError);
  });

  it('strict mode throws Error on insufficient funds (non-recoverable)', async () => {
    const publicClient = publicClientWithPendingReward();
    sendTx.mockRejectedValue(new Error('insufficient funds'));

    await expect(
      tickStolasDistributorClaims(publicClient, noopWallet, {
        distributorAddress: dist,
        stakingMode: 'standard',
        targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1 }],
        strict: true,
        retryDeps: { sendTx, waitForReceipt },
      }),
    ).rejects.toThrow(/Distributor claim: all/);
  });

  it('strict mode does not throw when at least one claim succeeds (partial failure)', async () => {
    const publicClient = publicClientWithPendingReward();
    sendTx
      .mockResolvedValueOnce('0xabc' as `0x${string}`)
      .mockRejectedValueOnce(new Error('nonce too low'));
    waitForReceipt.mockResolvedValue({ status: 'success' } as never);

    const r = await tickStolasDistributorClaims(publicClient, noopWallet, {
      distributorAddress: dist,
      stakingMode: 'standard',
      targets: [
        { stakingProxy: STAKING_PROXY, serviceId: 1 },
        { stakingProxy: '0x0000000000000000000000000000000000000003', serviceId: 2 },
      ],
      strict: true,
      retryDeps: { sendTx, waitForReceipt },
    });

    expect(r.submitted).toBe(1);
    expect(r.failedRecoverable).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// tickSelfBondStakingClaims
// ---------------------------------------------------------------------------

describe('tickSelfBondStakingClaims', () => {
  it('skips with skippedWrongMode when stakingMode is standard', async () => {
    const executeSafeTx = vi.fn();
    const publicClient = {} as PublicClient;

    const r = await tickSelfBondStakingClaims(publicClient, {
      stakingMode: 'standard',
      targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1, safeAddress: VALID_SAFE, agentPrivateKey: VALID_KEY, rpcUrl: VALID_RPC }],
      deps: { executeSafeTx, waitForReceipt: vi.fn() },
    });

    expect(r.skippedWrongMode).toBe(true);
    expect(executeSafeTx).not.toHaveBeenCalled();
  });

  it('skips target missing safeAddress and counts skippedMissingConfig', async () => {
    const executeSafeTx = vi.fn();
    const publicClient = publicClientWithPendingReward(100n);

    const r = await tickSelfBondStakingClaims(publicClient, {
      stakingMode: 'self-bond',
      targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1 }],
      deps: { executeSafeTx, waitForReceipt: vi.fn() },
    });

    expect(r.attempted).toBe(1);
    expect(r.skippedMissingConfig).toBe(1);
    expect(executeSafeTx).not.toHaveBeenCalled();
  });

  it('skips target missing agentPrivateKey and counts skippedMissingConfig', async () => {
    const executeSafeTx = vi.fn();
    const publicClient = publicClientWithPendingReward(100n);

    const r = await tickSelfBondStakingClaims(publicClient, {
      stakingMode: 'self-bond',
      targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1, safeAddress: VALID_SAFE, rpcUrl: VALID_RPC }],
      deps: { executeSafeTx, waitForReceipt: vi.fn() },
    });

    expect(r.skippedMissingConfig).toBe(1);
    expect(executeSafeTx).not.toHaveBeenCalled();
  });

  it('skips when pending reward is zero', async () => {
    const executeSafeTx = vi.fn();
    const publicClient = publicClientWithPendingReward(0n);

    const r = await tickSelfBondStakingClaims(publicClient, {
      stakingMode: 'self-bond',
      targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1, safeAddress: VALID_SAFE, agentPrivateKey: VALID_KEY, rpcUrl: VALID_RPC }],
      deps: { executeSafeTx, waitForReceipt: vi.fn() },
    });

    expect(r.skippedNoPending).toBe(1);
    expect(r.claimAttempted).toBe(0);
    expect(executeSafeTx).not.toHaveBeenCalled();
  });

  it('calls executeSafeTxDirect with checkpointAndClaim calldata and records submitted claim', async () => {
    const txHash = '0x' + 'cc'.repeat(32);
    const executeSafeTx = vi.fn().mockResolvedValue({ hash: txHash });
    const waitForReceipt = vi.fn().mockResolvedValue({ status: 'success' });
    const publicClient = publicClientWithPendingReward(500n);

    const r = await tickSelfBondStakingClaims(publicClient, {
      stakingMode: 'self-bond',
      targets: [{ stakingProxy: STAKING_PROXY, serviceId: 42, safeAddress: VALID_SAFE, agentPrivateKey: VALID_KEY, rpcUrl: VALID_RPC }],
      deps: { executeSafeTx, waitForReceipt },
    });

    expect(executeSafeTx).toHaveBeenCalledOnce();
    const call = executeSafeTx.mock.calls[0][0];
    expect(call.safeAddress).toBe(VALID_SAFE);
    expect(call.signerKey).toBe(VALID_KEY);
    expect(call.rpcUrl).toBe(VALID_RPC);
    // data should be the checkpointAndClaim(42) selector + args
    expect(call.data).toMatch(/^0x/);
    expect(r.submitted).toBe(1);
    expect(r.claimAttempted).toBe(1);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]).toMatchObject({
      serviceId: 42,
      txHash,
      amountWei: '500',
    });
  });

  it('counts failedPermanent when receipt status is not success', async () => {
    const txHash = '0x' + 'dd'.repeat(32);
    const executeSafeTx = vi.fn().mockResolvedValue({ hash: txHash });
    const waitForReceipt = vi.fn().mockResolvedValue({ status: 'reverted' });
    const publicClient = publicClientWithPendingReward(1n);

    const r = await tickSelfBondStakingClaims(publicClient, {
      stakingMode: 'self-bond',
      targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1, safeAddress: VALID_SAFE, agentPrivateKey: VALID_KEY, rpcUrl: VALID_RPC }],
      deps: { executeSafeTx, waitForReceipt },
    });

    expect(r.submitted).toBe(0);
    expect(r.failedPermanent).toBe(1);
  });

  it('counts failedRecoverable on recoverable Safe exec error (nonce too low)', async () => {
    const executeSafeTx = vi.fn().mockRejectedValue(new Error('nonce too low'));
    const publicClient = publicClientWithPendingReward(1n);

    const r = await tickSelfBondStakingClaims(publicClient, {
      stakingMode: 'self-bond',
      targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1, safeAddress: VALID_SAFE, agentPrivateKey: VALID_KEY, rpcUrl: VALID_RPC }],
      deps: { executeSafeTx, waitForReceipt: vi.fn() },
    });

    expect(r.failedRecoverable).toBe(1);
    expect(r.failedPermanent).toBe(0);
  });

  it('counts failedPermanent on non-recoverable error (insufficient funds)', async () => {
    const executeSafeTx = vi.fn().mockRejectedValue(new Error('insufficient funds'));
    const publicClient = publicClientWithPendingReward(1n);

    const r = await tickSelfBondStakingClaims(publicClient, {
      stakingMode: 'self-bond',
      targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1, safeAddress: VALID_SAFE, agentPrivateKey: VALID_KEY, rpcUrl: VALID_RPC }],
      deps: { executeSafeTx, waitForReceipt: vi.fn() },
    });

    expect(r.failedPermanent).toBe(1);
    expect(r.failedRecoverable).toBe(0);
  });

  it('strict mode throws TransientError when all sends fail recoverably', async () => {
    const executeSafeTx = vi.fn().mockRejectedValue(new Error('nonce too low'));
    const publicClient = publicClientWithPendingReward(1n);

    await expect(
      tickSelfBondStakingClaims(publicClient, {
        stakingMode: 'self-bond',
        targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1, safeAddress: VALID_SAFE, agentPrivateKey: VALID_KEY, rpcUrl: VALID_RPC }],
        strict: true,
        deps: { executeSafeTx, waitForReceipt: vi.fn() },
      }),
    ).rejects.toThrow(TransientError);
  });

  it('strict mode throws Error on permanent failure', async () => {
    const executeSafeTx = vi.fn().mockRejectedValue(new Error('insufficient funds'));
    const publicClient = publicClientWithPendingReward(1n);

    await expect(
      tickSelfBondStakingClaims(publicClient, {
        stakingMode: 'self-bond',
        targets: [{ stakingProxy: STAKING_PROXY, serviceId: 1, safeAddress: VALID_SAFE, agentPrivateKey: VALID_KEY, rpcUrl: VALID_RPC }],
        strict: true,
        deps: { executeSafeTx, waitForReceipt: vi.fn() },
      }),
    ).rejects.toThrow(/Self-bond claim: all/);
  });

  it('processes multiple targets and accounts for mixed outcomes', async () => {
    const txHash = '0x' + 'ee'.repeat(32);
    const executeSafeTx = vi
      .fn()
      .mockResolvedValueOnce({ hash: txHash })
      .mockRejectedValueOnce(new Error('nonce too low'));
    const waitForReceipt = vi.fn().mockResolvedValue({ status: 'success' });
    const publicClient = publicClientWithPendingReward(10n);

    const r = await tickSelfBondStakingClaims(publicClient, {
      stakingMode: 'self-bond',
      targets: [
        { stakingProxy: STAKING_PROXY, serviceId: 1, safeAddress: VALID_SAFE, agentPrivateKey: VALID_KEY, rpcUrl: VALID_RPC },
        { stakingProxy: '0x0000000000000000000000000000000000000003', serviceId: 2, safeAddress: VALID_SAFE, agentPrivateKey: VALID_KEY, rpcUrl: VALID_RPC },
      ],
      deps: { executeSafeTx, waitForReceipt },
    });

    expect(r.attempted).toBe(2);
    expect(r.submitted).toBe(1);
    expect(r.failedRecoverable).toBe(1);
  });
});
