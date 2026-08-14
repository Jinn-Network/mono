/**
 * #1043 / #1038 — the two for-await adapter loops (watchForTasks →
 * "engine-watcher", watchForDeliveries → "delivery-watcher") heartbeat at the
 * POLL-CYCLE TAIL, every poll, even when nothing is yielded. This is what
 * makes idle != stale: a quiet-but-polling loop keeps advancing its heartbeat,
 * while a loop wedged inside an RPC call (the #1038 4.5h wedge) freezes it.
 *
 * The setImmediate yield-point in daemon.ts only fires when items are yielded,
 * so the heartbeat could NOT live there — it lives in the adapter at the tail.
 *
 * Wave-4 D2 note: `watchForTasks` no longer performs any chain read (its
 * solution path retired in cutover stage 1 and its evaluation path retired
 * with `legacy-evaluator-delivery-watcher`), so it can no longer be wedged
 * inside an RPC call. The freeze half of the #1038 guard therefore survives
 * only on `watchForDeliveries`, which still scans Deliver logs; the
 * engine-watcher freeze case was removed rather than rewritten to assert a
 * condition the code can no longer reach.
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

describe('#1043 adapter for-await poll heartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the engine-watcher heartbeat advancing while idle (steady block, nothing yielded)', async () => {
    const { MechAdapter } = await import('../../../src/adapters/mech/adapter.js');
    const store = makeStore();
    const adapter = new MechAdapter(TEST_CONFIG, store as never);
    await adapter.initialize();
    // Steady block: getBlockNumber resolves, nothing new ever yields.
    (adapter as any).publicClient.getBlockNumber = vi.fn().mockResolvedValue(100n);

    // Drive the iterator without ever requesting a yielded value (idle path).
    const driven = (async () => {
      for await (const _ of adapter.watchForTasks()) {
        void _;
      }
    })();

    await vi.advanceTimersByTimeAsync(0);
    const first = store.values.get('loop_heartbeat:engine-watcher');
    expect(first).toBeTruthy();

    // Advance one poll interval at a time so each idle cycle reaches the tail
    // heartbeat with a freshly bumped clock.
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + TEST_CONFIG.pollIntervalMs);
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.pollIntervalMs);
    }
    const later = store.values.get('loop_heartbeat:engine-watcher');
    expect(Number(later)).toBeGreaterThan(Number(first));

    await adapter.stop();
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.pollIntervalMs);
    await driven;
  });

  it('keeps the delivery-watcher heartbeat advancing while idle', async () => {
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
    const first = store.values.get('loop_heartbeat:delivery-watcher');
    expect(first).toBeTruthy();

    // Advance one poll interval at a time so each idle cycle reaches the tail
    // heartbeat with a freshly bumped clock.
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + TEST_CONFIG.pollIntervalMs);
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.pollIntervalMs);
    }
    const later = store.values.get('loop_heartbeat:delivery-watcher');
    expect(Number(later)).toBeGreaterThan(Number(first));

    await adapter.stop();
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.pollIntervalMs);
    await driven;
  });
});
