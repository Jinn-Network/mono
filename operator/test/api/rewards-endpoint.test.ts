import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetStateStore } from '../../src/earning/store.js';
import { Store } from '../../src/store/store.js';

describe('/v1/rewards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('viem');
    vi.resetModules();
  });

  it('is UI-token protected and returns pending OLAS from calculateStakingReward', async () => {
    const stakingCalls: string[] = [];
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
          readContract: async (req: { functionName: string }) => {
            stakingCalls.push(req.functionName);
            if (req.functionName === 'calculateStakingReward') return 1234n;
            if (req.functionName === 'getNextRewardCheckpointTimestamp') return 1_800_000_000n;
            return 0n;
          },
          getLogs: async () => [],
        }),
        http: () => ({}),
      };
    });

    const { startApiServer } = await import('../../src/api/server.js');

    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-rewards-endpoint-'));
    const fleetStore = new FleetStateStore(earningDir);
    const state = await fleetStore.load('base-sepolia');
    await fleetStore.save({
      ...state,
      master_address: '0x1111111111111111111111111111111111111111',
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

    const store = new Store(':memory:');
    store.recordRewardClaim({
      ts: '2026-04-14T10:45:00.000Z',
      serviceIndex: 0,
      serviceId: 41,
      stakingProxy: '0x5555555555555555555555555555555555555555',
      distributor: '0x6666666666666666666666666666666666666666',
      txHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
      amountWei: '99',
    });

    const server = await startApiServer({
      port: 0,
      store,
      apiToken: 'api-token',
      ui: { token: 'ui-token', handshakeKey: 'handshake-key' },
      status: {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const unauthenticated = await fetch(`${baseUrl}/v1/rewards`);
      expect(unauthenticated.status).toBe(401);

      const authenticated = await fetch(`${baseUrl}/v1/rewards`, {
        headers: { 'x-jinn-ui-token': 'ui-token' },
      });
      expect(authenticated.status).toBe(200);
      const body = await authenticated.json() as {
        readState: string;
        totalPending: string;
        totalClaimed: string;
        lastClaimAt: string | null;
        nextCheckpointAt: string | null;
        services: Array<{
          index: number;
          pending: string;
          claimed: string;
          asset: string;
          lastClaimAt: string | null;
          lastClaimTxHash: string | null;
        }>;
      };
      expect(stakingCalls).toContain('calculateStakingReward');
      expect(body.readState).toBe('ready');
      expect(body.totalPending).toBe('1234');
      expect(body.totalClaimed).toBe('99');
      expect(body.lastClaimAt).toBe('2026-04-14T10:45:00.000Z');
      expect(body.nextCheckpointAt).toBe('2027-01-15T08:00:00.000Z');
      expect(body.services).toMatchObject([
        {
          index: 0,
          pending: '1234',
          claimed: '99',
          asset: 'OLAS',
          lastClaimAt: '2026-04-14T10:45:00.000Z',
          lastClaimTxHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
        },
      ]);
    } finally {
      await server.close();
      store.close();
    }
  });
});
