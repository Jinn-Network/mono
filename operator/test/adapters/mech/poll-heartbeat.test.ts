/**
 * Wave-4 D6 dropped `engine-watcher` and `delivery-watcher` from
 * `LOOP_REGISTRY`. The leftover MechAdapter generators (stage 5 /
 * `legacy-operator-composition`) must not stamp those retired heartbeat
 * keys — the watchdog no longer reads them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MechAdapterConfig } from '../../../src/adapters/mech/types.js';

// MOCK_JUSTIFICATION: safe.js / contracts.js are the I/O leaves for chain RPC;
// mocking them is mocking the boundary (same policy as adapter.test.ts).
vi.mock('../../../src/adapters/mech/safe.js', () => ({
  createClients: vi.fn().mockReturnValue({
    publicClient: {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      getLogs: vi.fn().mockResolvedValue([]),
      readContract: vi.fn().mockResolvedValue(false),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
    },
    walletClient: {},
    account: {},
  }),
}));

vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  decodeTaskCreatedLogs: vi.fn().mockReturnValue([]),
  decodeSolutionDeliveryClaimedLogs: vi.fn().mockReturnValue([]),
  decodeDeliverLogs: vi.fn().mockReturnValue([]),
}));

const TEST_CONFIG: MechAdapterConfig = {
  rpcUrl: 'http://localhost:8545',
  mechMarketplaceAddress: ('0x' + '11'.repeat(20)) as `0x${string}`,
  routerAddress: ('0x' + '22'.repeat(20)) as `0x${string}`,
  mechContractAddress: ('0x' + '33'.repeat(20)) as `0x${string}`,
  safeAddress: ('0x' + '44'.repeat(20)) as `0x${string}`,
  agentEoaPrivateKey: ('0x' + '55'.repeat(32)) as `0x${string}`,
  ipfsRegistryUrl: 'http://localhost:5001',
  ipfsGatewayUrl: 'http://localhost:8080',
  pollIntervalMs: 1000,
  chainId: 8453,
  routerClaimDeliveryVariant: 'v1',
};

function makeStore() {
  const values = new Map<string, string>();
  return {
    getLastProcessedBlock: vi.fn(() => null),
    setLastProcessedBlock: vi.fn(),
    getConfigValue: vi.fn((key: string) => values.get(key) ?? null),
    setConfigValue: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    values,
  };
}

describe('#1043 adapter for-await poll heartbeat (Wave-4 D6: no retired ticks)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('watchForTasks does not write loop_heartbeat:engine-watcher', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const store = makeStore();
    const adapter = new MechAdapter(TEST_CONFIG, store as never);
    await adapter.initialize();

    const driven = (async () => {
      for await (const _ of adapter.watchForTasks()) {
        void _;
      }
    })();

    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + TEST_CONFIG.pollIntervalMs);
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.pollIntervalMs);
    }
    expect(store.values.get('loop_heartbeat:engine-watcher')).toBeUndefined();
    expect(store.values.get('loop_heartbeat:delivery-watcher')).toBeUndefined();

    await adapter.stop();
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.pollIntervalMs);
    await driven;
  });

  it('watchForDeliveries does not write loop_heartbeat:delivery-watcher', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const store = makeStore();
    const adapter = new MechAdapter(TEST_CONFIG, store as never);
    await adapter.initialize();
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(100n);

    const driven = (async () => {
      for await (const _ of adapter.watchForDeliveries()) {
        void _;
      }
    })();

    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + TEST_CONFIG.pollIntervalMs);
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.pollIntervalMs);
    }
    expect(store.values.get('loop_heartbeat:delivery-watcher')).toBeUndefined();
    expect(store.values.get('loop_heartbeat:engine-watcher')).toBeUndefined();

    await adapter.stop();
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.pollIntervalMs);
    await driven;
  });
});
