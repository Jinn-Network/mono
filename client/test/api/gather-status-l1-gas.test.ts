import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetStateStore } from '../../src/earning/store.js';
import { withTempStore } from '@test/store.js';

// L1 (Ethereum Sepolia) master gas runway gathering (issue #1296). The L1
// master native balance is read on the Sepolia chain (id 11155111) via the
// same viem `createPublicClient` mock the sibling gather-status tests use; the
// L1 client helper (`createJinnL1PublicClient`) is just a thin wrapper over it.
describe('gatherGatheredStatusRaw — L1 master gas (issue #1296)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('viem');
    vi.resetModules();
  });

  it('populates raw.l1Master with the Sepolia master balance + L1 floor + daily estimate', async () => {
    const master = '0x1111111111111111111111111111111111111111';
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      return {
        ...actual,
        createPublicClient: ({ chain }: { chain: { id: number } }) => ({
          getBlockNumber: async () => 123n,
          getChainId: async () => chain.id,
          // L1 Sepolia (11155111) master read returns 0.002 ETH; the L2 Base
          // Sepolia (84532) read returns 0.01 ETH.
          getBalance: async () => (chain.id === 11155111 ? 2_000_000_000_000_000n : 10_000_000_000_000_000n),
          multicall: async (req: { contracts: ReadonlyArray<{ functionName: string }> }) =>
            req.contracts.map(() => ({ status: 'success' as const, result: 0n })),
          readContract: async () => 0n,
          getLogs: async () => [],
        }),
        http: () => ({}),
      };
    });

    const { gatherGatheredStatusRaw } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const earningDir = mkdtempSync(join(tmpdir(), 'jinn-l1-gas-test-'));
      const fleetStore = new FleetStateStore(earningDir);
      const state = await fleetStore.load('base-sepolia');
      await fleetStore.save({
        ...state,
        master_address: master,
        services: [
          {
            index: 1,
            agent_address: '0x2222222222222222222222222222222222222222',
            safe_address: '0x3333333333333333333333333333333333333333',
            service_id: 41,
            mech_address: null,
            staking_address: '0x5555555555555555555555555555555555555555',
            step: 'complete',
            error: null,
          },
        ],
      });

      const raw = await gatherGatheredStatusRaw(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });

      expect(raw.l1Master).toBeDefined();
      expect(raw.l1Master!.address).toBe(master);
      expect(raw.l1Master!.balanceWei).toBe('2000000000000000');
      expect(raw.minL1MasterEthWei).toBeDefined();
      expect(raw.l1MasterDailyEstimateWei).toBeDefined();
    });
  });

  it('omits raw.l1Master on mainnet (no L1 gas surface here)', async () => {
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      return {
        ...actual,
        createPublicClient: ({ chain }: { chain: { id: number } }) => ({
          getBlockNumber: async () => 123n,
          getChainId: async () => chain.id,
          getBalance: async () => 0n,
          multicall: async (req: { contracts: ReadonlyArray<{ functionName: string }> }) =>
            req.contracts.map(() => ({ status: 'success' as const, result: 0n })),
          readContract: async () => 0n,
          getLogs: async () => [],
        }),
        http: () => ({}),
      };
    });

    const { gatherGatheredStatusRaw } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const earningDir = mkdtempSync(join(tmpdir(), 'jinn-l1-gas-mainnet-'));
      const fleetStore = new FleetStateStore(earningDir);
      const state = await fleetStore.load('base');
      await fleetStore.save({
        ...state,
        master_address: '0x1111111111111111111111111111111111111111',
        services: [],
      });

      const raw = await gatherGatheredStatusRaw(store, {
        earningDir,
        rpcUrl: 'http://base.example',
        network: 'mainnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });

      expect(raw.l1Master).toBeUndefined();
    });
  });
});
