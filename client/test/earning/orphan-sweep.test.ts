import { JsonRpcProvider, getAddress } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  previousSafeBeingAbandoned,
  sweepOrphanedServiceFunds,
} from '../../src/earning/orphan-sweep.js';
import type { ServiceState } from '../../src/earning/types.js';
import * as safeAdapter from '../../src/earning/safe-adapter.js';
import * as txRetry from '../../src/tx-retry.js';
import { deriveMasterSigner, deriveAgentSigner } from '../../src/earning/wallet.js';

const MNEMONIC = 'test test test test test test test test test test test junk';

describe('previousSafeBeingAbandoned', () => {
  const oldSafe = '0x1111111111111111111111111111111111111111';

  function baseSvc(over: Partial<ServiceState> = {}): ServiceState {
    return {
      index: 1,
      agent_address: '0x3333333333333333333333333333333333333333',
      safe_address: oldSafe,
      service_id: null,
      mech_address: null,
      staking_address: null,
      step: 'awaiting_stake',
      error: null,
      ...over,
    };
  }

  it('returns checksummed prior safe when patch clears safe_address', () => {
    const svc = baseSvc();
    expect(previousSafeBeingAbandoned(svc, { safe_address: null })).toBe(getAddress(oldSafe));
  });

  it('returns null when patch keeps safe_address implicit', () => {
    const svc = baseSvc();
    expect(previousSafeBeingAbandoned(svc, { service_id: null })).toBeNull();
  });

  it('returns old safe when patch sets a different safe_address', () => {
    const svc = baseSvc();
    const next = '0x4444444444444444444444444444444444444444';
    const abandoned = previousSafeBeingAbandoned(svc, { safe_address: next });
    expect(abandoned).toBe(getAddress(oldSafe));
  });

  it('returns null when no prior safe', () => {
    const svc = baseSvc({ safe_address: null });
    expect(previousSafeBeingAbandoned(svc, { safe_address: null })).toBeNull();
  });
});

describe('sweepOrphanedServiceFunds', () => {
  it('calls executeSafeTxDirect when Safe is deployed and has ETH', async () => {
    vi.spyOn(safeAdapter, 'executeSafeTxDirect').mockResolvedValue({ hash: '0x' + 'aa'.repeat(32) });
    vi.spyOn(txRetry, 'ethersWaitForTransactionHashWithRetry').mockResolvedValue({ status: 1 } as never);
    vi.spyOn(txRetry, 'ethersSendTransactionWithRetry').mockResolvedValue({
      hash: '0x' + 'bb'.repeat(32),
    } as never);

    const masterSigner = deriveMasterSigner(MNEMONIC);
    const agentSigner = deriveAgentSigner(MNEMONIC, 1);
    const abandonedSafe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const provider = {
      getCode: vi.fn().mockResolvedValue('0x6000'),
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(5_000_000_000_000_000_000n) // safe
        .mockResolvedValue(6_000_000_000_000_000_000n), // agent repeated
    } as unknown as JsonRpcProvider;

    await sweepOrphanedServiceFunds({
      rpcUrl: 'http://127.0.0.1:8545',
      provider,
      masterAddress: masterSigner.address,
      masterSigner,
      serviceIndex: 1,
      agentPrivateKey: agentSigner.privateKey,
      agentAddress: agentSigner.address,
      abandonedSafeAddress: abandonedSafe,
      minAgentReserveWei: 5_000_000_000_000_000_000n,
    });

    expect(safeAdapter.executeSafeTxDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        safeAddress: abandonedSafe,
        to: masterSigner.address,
        value: 5_000_000_000_000_000_000n,
      }),
    );
    vi.restoreAllMocks();
  });

  it('does not throw when executeSafeTxDirect fails', async () => {
    vi.spyOn(safeAdapter, 'executeSafeTxDirect').mockRejectedValue(new Error('rpc down'));
    vi.spyOn(txRetry, 'ethersWaitForTransactionHashWithRetry').mockResolvedValue(null);
    vi.spyOn(txRetry, 'ethersSendTransactionWithRetry').mockResolvedValue({
      hash: '0x' + 'cc'.repeat(32),
    } as never);

    const masterSigner = deriveMasterSigner(MNEMONIC);
    const agentSigner = deriveAgentSigner(MNEMONIC, 1);

    const provider = {
      getCode: vi.fn().mockResolvedValue('0x6000'),
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(1n)
        .mockResolvedValue(6_000_000_000_000_000_000n),
    } as unknown as JsonRpcProvider;

    await expect(
      sweepOrphanedServiceFunds({
        rpcUrl: 'http://127.0.0.1:8545',
        provider,
        masterAddress: masterSigner.address,
        masterSigner,
        serviceIndex: 1,
        agentPrivateKey: agentSigner.privateKey,
        agentAddress: agentSigner.address,
        abandonedSafeAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        minAgentReserveWei: 5_000_000_000_000_000_000n,
      }),
    ).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });
});
