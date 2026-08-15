import { describe, expect, it, vi } from 'vitest';
import { BalanceTopupLoop } from '../../src/daemon/balance-topup-loop.js';

// Valid checksummed Ethereum addresses for use in tests
const AGENT_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';  // Hardhat/Anvil account 0
const SAFE_ADDR  = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';  // Hardhat/Anvil account 1
const MASTER_ADDR = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // Hardhat/Anvil account 2

function mockPublicClient(balances: Record<string, bigint>) {
  return {
    getBalance: vi.fn(async ({ address }: { address: string }) => balances[address.toLowerCase()] ?? 0n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  } as any;
}

function mockWalletClient(address: string) {
  return {
    account: { address },
    sendTransaction: vi.fn(async () => '0xdeadbeef'),
  } as any;
}

function mockStore(services: any[]) {
  return {
    load: vi.fn(async () => ({
      master_address: MASTER_ADDR,
      services,
      staking_mode: 'standard',
    })),
  } as any;
}

function completeService(overrides: Partial<{ agent_address: string | null; safe_address: string | null; step: string }> = {}) {
  return {
    index: 1,
    step: 'complete',
    agent_address: AGENT_ADDR,
    safe_address: SAFE_ADDR,
    ...overrides,
  };
}

describe('BalanceTopupLoop', () => {
  const TRIGGER_EOA = 1_000_000_000_000_000n;
  const TARGET_EOA = 5_000_000_000_000_000n;
  const TRIGGER_SAFE = 500_000_000_000_000n;
  const TARGET_SAFE = 2_000_000_000_000_000n;

  it('does not top up when balances are above triggers', async () => {
    const pub = mockPublicClient({
      [AGENT_ADDR.toLowerCase()]: TARGET_EOA,
      [SAFE_ADDR.toLowerCase()]:  TARGET_SAFE,
      [MASTER_ADDR.toLowerCase()]: 1_000_000_000_000_000_000n,
    });
    const wallet = mockWalletClient(MASTER_ADDR);
    const loop = new BalanceTopupLoop({
      intervalMs: 300_000,
      publicClient: pub,
      masterWallet: wallet,
      store: mockStore([completeService()]),
      chain: 'base-sepolia',
      eoaTopupTrigger: TRIGGER_EOA,
      eoaTopupTarget: TARGET_EOA,
      safeTopupTrigger: TRIGGER_SAFE,
      safeTopupTarget: TARGET_SAFE,
    });
    await loop.runOnce();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('tops up agent EOA when below trigger', async () => {
    // Agent has 500_000_000_000_000 (below 1_000_000_000_000_000 trigger)
    const pub = mockPublicClient({
      [AGENT_ADDR.toLowerCase()]: 500_000_000_000_000n,
      [SAFE_ADDR.toLowerCase()]:  TARGET_SAFE,
      [MASTER_ADDR.toLowerCase()]: 1_000_000_000_000_000_000n,
    });
    const wallet = mockWalletClient(MASTER_ADDR);
    const loop = new BalanceTopupLoop({
      intervalMs: 300_000,
      publicClient: pub,
      masterWallet: wallet,
      store: mockStore([completeService()]),
      chain: 'base-sepolia',
      eoaTopupTrigger: TRIGGER_EOA,
      eoaTopupTarget: TARGET_EOA,
      safeTopupTrigger: TRIGGER_SAFE,
      safeTopupTarget: TARGET_SAFE,
    });
    await loop.runOnce();
    // Should have sent a transaction to top up agent
    expect(wallet.sendTransaction).toHaveBeenCalled();
  });

  it('tops up Safe when below trigger', async () => {
    // Safe has 200_000_000_000_000 (below 500_000_000_000_000 trigger)
    const pub = mockPublicClient({
      [AGENT_ADDR.toLowerCase()]: TARGET_EOA,
      [SAFE_ADDR.toLowerCase()]:  200_000_000_000_000n,
      [MASTER_ADDR.toLowerCase()]: 1_000_000_000_000_000_000n,
    });
    const wallet = mockWalletClient(MASTER_ADDR);
    const loop = new BalanceTopupLoop({
      intervalMs: 300_000,
      publicClient: pub,
      masterWallet: wallet,
      store: mockStore([completeService()]),
      chain: 'base-sepolia',
      eoaTopupTrigger: TRIGGER_EOA,
      eoaTopupTarget: TARGET_EOA,
      safeTopupTrigger: TRIGGER_SAFE,
      safeTopupTarget: TARGET_SAFE,
    });
    await loop.runOnce();
    expect(wallet.sendTransaction).toHaveBeenCalled();
  });

  it('skips services that are not complete', async () => {
    const pub = mockPublicClient({});
    const wallet = mockWalletClient(MASTER_ADDR);
    const loop = new BalanceTopupLoop({
      intervalMs: 300_000,
      publicClient: pub,
      masterWallet: wallet,
      store: mockStore([completeService({ step: 'staked' })]),
      chain: 'base-sepolia',
      eoaTopupTrigger: TRIGGER_EOA,
      eoaTopupTarget: TARGET_EOA,
      safeTopupTrigger: TRIGGER_SAFE,
      safeTopupTarget: TARGET_SAFE,
    });
    await loop.runOnce();
    expect(pub.getBalance).not.toHaveBeenCalled();
  });

  it('does not top up when master balance is too low', async () => {
    // Agent needs top up but master cannot cover it
    const pub = mockPublicClient({
      [AGENT_ADDR.toLowerCase()]: 500_000_000_000_000n,  // below trigger
      [SAFE_ADDR.toLowerCase()]:  TARGET_SAFE,
      [MASTER_ADDR.toLowerCase()]: 1n,  // effectively empty
    });
    const wallet = mockWalletClient(MASTER_ADDR);
    const loop = new BalanceTopupLoop({
      intervalMs: 300_000,
      publicClient: pub,
      masterWallet: wallet,
      store: mockStore([completeService()]),
      chain: 'base-sepolia',
      eoaTopupTrigger: TRIGGER_EOA,
      eoaTopupTarget: TARGET_EOA,
      safeTopupTrigger: TRIGGER_SAFE,
      safeTopupTarget: TARGET_SAFE,
    });
    await loop.runOnce();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('does not crash when balance read fails', async () => {
    const pub = {
      getBalance: vi.fn(async () => { throw new Error('RPC down'); }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    } as any;
    const wallet = mockWalletClient(MASTER_ADDR);
    const loop = new BalanceTopupLoop({
      intervalMs: 300_000,
      publicClient: pub,
      masterWallet: wallet,
      store: mockStore([completeService()]),
      chain: 'base-sepolia',
      eoaTopupTrigger: TRIGGER_EOA,
      eoaTopupTarget: TARGET_EOA,
      safeTopupTrigger: TRIGGER_SAFE,
      safeTopupTarget: TARGET_SAFE,
    });
    // Should not throw — errors are caught per-service
    await expect(loop.runOnce()).resolves.toBeUndefined();
  });

  it('skips services missing agent_address or safe_address', async () => {
    const pub = mockPublicClient({});
    const wallet = mockWalletClient(MASTER_ADDR);
    const loop = new BalanceTopupLoop({
      intervalMs: 300_000,
      publicClient: pub,
      masterWallet: wallet,
      store: mockStore([
        completeService({ agent_address: null }),
        completeService({ safe_address: null }),
      ]),
      chain: 'base-sepolia',
      eoaTopupTrigger: TRIGGER_EOA,
      eoaTopupTarget: TARGET_EOA,
      safeTopupTrigger: TRIGGER_SAFE,
      safeTopupTarget: TARGET_SAFE,
    });
    await loop.runOnce();
    expect(pub.getBalance).not.toHaveBeenCalled();
  });

  it('does nothing when intervalMs is 0 (run exits immediately)', async () => {
    const pub = mockPublicClient({});
    const wallet = mockWalletClient(MASTER_ADDR);
    const store = mockStore([completeService()]);
    const loop = new BalanceTopupLoop({
      intervalMs: 0,
      publicClient: pub,
      masterWallet: wallet,
      store,
      chain: 'base-sepolia',
      eoaTopupTrigger: TRIGGER_EOA,
      eoaTopupTarget: TARGET_EOA,
      safeTopupTrigger: TRIGGER_SAFE,
      safeTopupTarget: TARGET_SAFE,
    });
    // run() should return immediately when intervalMs is 0
    await expect(loop.run()).resolves.toBeUndefined();
    expect(store.load).not.toHaveBeenCalled();
  });
});
