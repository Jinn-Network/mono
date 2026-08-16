import { getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  previousSafeBeingAbandoned,
  sweepOrphanedServiceFunds,
} from '../../src/earning/orphan-sweep.js';
import type { ServiceState } from '../../src/earning/types.js';
import * as safeAdapter from '../../src/earning/safe-adapter.js';
import * as txRetry from '../../src/tx-retry.js';
import { deriveMasterSigner, walletPrivateKeyAtIndex } from '../../src/earning/wallet.js';

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
    vi.spyOn(txRetry, 'waitForTransactionReceiptWithRetry').mockResolvedValue({ status: 'success' } as never);
    vi.spyOn(txRetry, 'viemSendTransactionWithRetry').mockResolvedValue('0x' + 'bb'.repeat(32) as Hex);

    const masterSigner = deriveMasterSigner(MNEMONIC);
    const abandonedSafe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const publicClient = {
      getCode: vi.fn().mockResolvedValue('0x6000'),
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(5_000_000_000_000_000_000n) // safe
        .mockResolvedValue(6_000_000_000_000_000_000n), // agent repeated
      readContract: vi.fn().mockResolvedValue(0n), // no ERC-20 balances
    } as unknown as PublicClient;

    await sweepOrphanedServiceFunds({
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'base',
      publicClient,
      masterAddress: masterSigner.address,
      masterAccount: masterSigner,
      serviceIndex: 1,
      agentPrivateKey: walletPrivateKeyAtIndex(MNEMONIC, 1),
      agentAddress: getAddress('0x3333333333333333333333333333333333333333'),
      abandonedSafeAddress: abandonedSafe,
      minAgentReserveWei: 5_000_000_000_000_000_000n,
    });

    expect(safeAdapter.executeSafeTxDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        safeAddress: abandonedSafe,
        to: getAddress(masterSigner.address) as Address,
        value: 5_000_000_000_000_000_000n,
      }),
    );
    vi.restoreAllMocks();
  });

  it('does not throw when executeSafeTxDirect fails', async () => {
    vi.spyOn(safeAdapter, 'executeSafeTxDirect').mockRejectedValue(new Error('rpc down'));
    vi.spyOn(txRetry, 'waitForTransactionReceiptWithRetry').mockResolvedValue({ status: 'reverted' } as never);
    vi.spyOn(txRetry, 'viemSendTransactionWithRetry').mockResolvedValue('0x' + 'cc'.repeat(32) as Hex);

    const masterSigner = deriveMasterSigner(MNEMONIC);

    const publicClient = {
      getCode: vi.fn().mockResolvedValue('0x6000'),
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(1n)
        .mockResolvedValue(6_000_000_000_000_000_000n),
      readContract: vi.fn().mockResolvedValue(0n),
    } as unknown as PublicClient;

    await expect(
      sweepOrphanedServiceFunds({
        rpcUrl: 'http://127.0.0.1:8545',
        network: 'base',
        publicClient,
        masterAddress: masterSigner.address,
        masterAccount: masterSigner,
        serviceIndex: 1,
        agentPrivateKey: walletPrivateKeyAtIndex(MNEMONIC, 1),
        agentAddress: getAddress('0x3333333333333333333333333333333333333333'),
        abandonedSafeAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        minAgentReserveWei: 5_000_000_000_000_000_000n,
      }),
    ).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// ERC-20 sweep via erc20Tokens param
// ---------------------------------------------------------------------------

describe('sweepOrphanedServiceFunds — ERC-20 sweep', () => {
  const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';
  const abandonedSafe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  function basePublicClient(safeBal: bigint, agentBal: bigint, erc20Bal: bigint): PublicClient {
    return {
      getCode: vi.fn().mockResolvedValue('0x6000'),
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(safeBal) // safe ETH
        .mockResolvedValue(agentBal),   // agent ETH (repeated)
      readContract: vi.fn().mockResolvedValue(erc20Bal),
    } as unknown as PublicClient;
  }

  it('sweeps ERC-20 token from Safe when balance is non-zero', async () => {
    const masterSigner = deriveMasterSigner(MNEMONIC);
    const execSpy = vi
      .spyOn(safeAdapter, 'executeSafeTxDirect')
      .mockResolvedValue({ hash: '0x' + 'aa'.repeat(32) });
    vi.spyOn(txRetry, 'waitForTransactionReceiptWithRetry').mockResolvedValue({ status: 'success' } as never);
    vi.spyOn(txRetry, 'viemSendTransactionWithRetry').mockResolvedValue('0x' + 'bb'.repeat(32) as Hex);

    // Safe has 0 ETH (no ETH sweep), agent has plenty of gas, ERC-20 balance = 5000 OLAS
    const olasBalance = 5000n * 10n ** 18n;
    const publicClient = basePublicClient(0n, 6_000_000_000_000_000_000n, olasBalance);

    await sweepOrphanedServiceFunds({
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'base',
      publicClient,
      masterAddress: masterSigner.address,
      masterAccount: masterSigner,
      serviceIndex: 1,
      agentPrivateKey: walletPrivateKeyAtIndex(MNEMONIC, 1),
      agentAddress: getAddress('0x3333333333333333333333333333333333333333'),
      abandonedSafeAddress: abandonedSafe,
      minAgentReserveWei: 1_000_000_000_000_000n,
      erc20Tokens: [{ address: OLAS_TOKEN, symbol: 'OLAS' }],
    });

    // Should have called executeSafeTxDirect exactly once (for ERC-20 transfer)
    expect(execSpy).toHaveBeenCalledOnce();
    const call = execSpy.mock.calls[0][0];
    expect(call.safeAddress).toBe(abandonedSafe);
    // inner call goes to the token contract (not master)
    expect(call.to).toBe(getAddress(OLAS_TOKEN));
    expect(call.value).toBe(0n);
    // data should encode transfer(master, balance)
    expect(call.data).toMatch(/^0x/);

    vi.restoreAllMocks();
  });

  it('skips ERC-20 sweep when token balance is zero', async () => {
    const masterSigner = deriveMasterSigner(MNEMONIC);
    const execSpy = vi
      .spyOn(safeAdapter, 'executeSafeTxDirect')
      .mockResolvedValue({ hash: '0x' + 'aa'.repeat(32) });
    vi.spyOn(txRetry, 'waitForTransactionReceiptWithRetry').mockResolvedValue({ status: 'success' } as never);
    vi.spyOn(txRetry, 'viemSendTransactionWithRetry').mockResolvedValue('0x' + 'bb'.repeat(32) as Hex);

    // Safe has no ETH and ERC-20 balance = 0
    const publicClient = basePublicClient(0n, 6_000_000_000_000_000_000n, 0n);

    await sweepOrphanedServiceFunds({
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'base',
      publicClient,
      masterAddress: masterSigner.address,
      masterAccount: masterSigner,
      serviceIndex: 1,
      agentPrivateKey: walletPrivateKeyAtIndex(MNEMONIC, 1),
      agentAddress: getAddress('0x3333333333333333333333333333333333333333'),
      abandonedSafeAddress: abandonedSafe,
      minAgentReserveWei: 1_000_000_000_000_000n,
      erc20Tokens: [{ address: OLAS_TOKEN, symbol: 'OLAS' }],
    });

    // No exec should have been called (zero balance is skipped)
    expect(execSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('does not throw when ERC-20 sweep Safe exec fails', async () => {
    const masterSigner = deriveMasterSigner(MNEMONIC);
    vi.spyOn(safeAdapter, 'executeSafeTxDirect').mockRejectedValue(new Error('rpc timeout'));
    vi.spyOn(txRetry, 'waitForTransactionReceiptWithRetry').mockResolvedValue({ status: 'success' } as never);
    vi.spyOn(txRetry, 'viemSendTransactionWithRetry').mockResolvedValue('0x' + 'bb'.repeat(32) as Hex);

    // ERC-20 balance is non-zero but Safe exec fails
    const publicClient = basePublicClient(0n, 6_000_000_000_000_000_000n, 1000n);

    await expect(
      sweepOrphanedServiceFunds({
        rpcUrl: 'http://127.0.0.1:8545',
        network: 'base',
        publicClient,
        masterAddress: masterSigner.address,
        masterAccount: masterSigner,
        serviceIndex: 1,
        agentPrivateKey: walletPrivateKeyAtIndex(MNEMONIC, 1),
        agentAddress: getAddress('0x3333333333333333333333333333333333333333'),
        abandonedSafeAddress: abandonedSafe,
        minAgentReserveWei: 1_000_000_000_000_000n,
        erc20Tokens: [{ address: OLAS_TOKEN, symbol: 'OLAS' }],
      }),
    ).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });

  it('skips ERC-20 sweep when agent lacks gas', async () => {
    const masterSigner = deriveMasterSigner(MNEMONIC);
    const execSpy = vi
      .spyOn(safeAdapter, 'executeSafeTxDirect')
      .mockResolvedValue({ hash: '0x' + 'aa'.repeat(32) });
    vi.spyOn(txRetry, 'waitForTransactionReceiptWithRetry').mockResolvedValue({ status: 'success' } as never);
    vi.spyOn(txRetry, 'viemSendTransactionWithRetry').mockResolvedValue('0x' + 'bb'.repeat(32) as Hex);

    // Safe has 0 ETH, agent has less than reserve — no gas for Safe exec
    const publicClient: PublicClient = {
      getCode: vi.fn().mockResolvedValue('0x6000'),
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(0n)   // safe ETH
        .mockResolvedValue(100n),    // agent ETH — below minAgentReserveWei
      readContract: vi.fn().mockResolvedValue(9999n), // non-zero ERC-20
    } as unknown as PublicClient;

    await sweepOrphanedServiceFunds({
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'base',
      publicClient,
      masterAddress: masterSigner.address,
      masterAccount: masterSigner,
      serviceIndex: 1,
      agentPrivateKey: walletPrivateKeyAtIndex(MNEMONIC, 1),
      agentAddress: getAddress('0x3333333333333333333333333333333333333333'),
      abandonedSafeAddress: abandonedSafe,
      minAgentReserveWei: 1_000_000_000_000_000n,
      erc20Tokens: [{ address: OLAS_TOKEN, symbol: 'OLAS' }],
    });

    // exec should not have been called since agent lacks gas
    expect(execSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('handles multiple ERC-20 tokens and sweeps each with non-zero balance', async () => {
    const USDC_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const masterSigner = deriveMasterSigner(MNEMONIC);
    const execSpy = vi
      .spyOn(safeAdapter, 'executeSafeTxDirect')
      .mockResolvedValue({ hash: '0x' + 'ff'.repeat(32) });
    vi.spyOn(txRetry, 'waitForTransactionReceiptWithRetry').mockResolvedValue({ status: 'success' } as never);
    vi.spyOn(txRetry, 'viemSendTransactionWithRetry').mockResolvedValue('0x' + 'bb'.repeat(32) as Hex);

    // Both tokens have non-zero balance
    const publicClient: PublicClient = {
      getCode: vi.fn().mockResolvedValue('0x6000'),
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(0n)      // safe ETH
        .mockResolvedValue(6_000_000_000_000_000_000n), // agent ETH
      readContract: vi.fn().mockResolvedValue(100n), // non-zero for both tokens
    } as unknown as PublicClient;

    await sweepOrphanedServiceFunds({
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'base',
      publicClient,
      masterAddress: masterSigner.address,
      masterAccount: masterSigner,
      serviceIndex: 1,
      agentPrivateKey: walletPrivateKeyAtIndex(MNEMONIC, 1),
      agentAddress: getAddress('0x3333333333333333333333333333333333333333'),
      abandonedSafeAddress: abandonedSafe,
      minAgentReserveWei: 1_000_000_000_000_000n,
      erc20Tokens: [
        { address: OLAS_TOKEN, symbol: 'OLAS' },
        { address: USDC_TOKEN, symbol: 'USDC' },
      ],
    });

    // One exec call per token with non-zero balance
    expect(execSpy).toHaveBeenCalledTimes(2);
    const targets = execSpy.mock.calls.map(c => c[0].to);
    expect(targets).toContain(getAddress(OLAS_TOKEN));
    expect(targets).toContain(getAddress(USDC_TOKEN));

    vi.restoreAllMocks();
  });

  it('does not attempt ERC-20 sweep when erc20Tokens is omitted', async () => {
    const masterSigner = deriveMasterSigner(MNEMONIC);
    const execSpy = vi
      .spyOn(safeAdapter, 'executeSafeTxDirect')
      .mockResolvedValue({ hash: '0x' + 'aa'.repeat(32) });
    vi.spyOn(txRetry, 'waitForTransactionReceiptWithRetry').mockResolvedValue({ status: 'success' } as never);
    vi.spyOn(txRetry, 'viemSendTransactionWithRetry').mockResolvedValue('0x' + 'bb'.repeat(32) as Hex);

    const publicClient: PublicClient = {
      getCode: vi.fn().mockResolvedValue('0x6000'),
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(0n) // safe ETH
        .mockResolvedValue(6_000_000_000_000_000_000n),
      readContract: vi.fn().mockResolvedValue(9999n),
    } as unknown as PublicClient;

    await sweepOrphanedServiceFunds({
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'base',
      publicClient,
      masterAddress: masterSigner.address,
      masterAccount: masterSigner,
      serviceIndex: 1,
      agentPrivateKey: walletPrivateKeyAtIndex(MNEMONIC, 1),
      agentAddress: getAddress('0x3333333333333333333333333333333333333333'),
      abandonedSafeAddress: abandonedSafe,
      minAgentReserveWei: 1_000_000_000_000_000n,
      // erc20Tokens intentionally omitted
    });

    expect(execSpy).not.toHaveBeenCalled();
    // readContract should not have been called (no tokens to check)
    expect((publicClient.readContract as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
