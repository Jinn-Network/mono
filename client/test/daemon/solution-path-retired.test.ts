/**
 * Task 16 (cutover stage 1): the TaskEngine solution path retires.
 * Cutover stage 2 retires the mech evaluation machinery too —
 * `watchForTasks()` no longer yields evaluation announcements.
 */
import { describe, expect, it, vi } from 'vitest';
import { adapterFixture } from './adapter-fixture.js';

// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls.
vi.mock('../../src/adapters/mech/contracts.js', () => ({
  submitTask: vi.fn(),
  claimTask: vi.fn(),
  canClaimTask: vi.fn().mockResolvedValue({ ok: true }),
  canClaimEvaluation: vi.fn().mockResolvedValue({ ok: true }),
  claimEvaluation: vi.fn(),
  claimDelivery: vi.fn().mockResolvedValue(`0x${'ef'.repeat(32)}`),
  getMechDeliveryRate: vi.fn().mockResolvedValue(1000000n),
  getTimeoutBounds: vi.fn().mockResolvedValue({ min: 60n, max: 300n }),
  decodeTaskCreatedLogs: vi.fn().mockReturnValue([]),
  decodeSolutionDeliveryClaimedLogs: vi.fn().mockReturnValue([]),
  decodeDeliverLogs: vi.fn().mockReturnValue([]),
  ROUTER_DISCOVERY_EVENTS: ['TaskCreated', 'SolutionDeliveryClaimed'],
  ROUTER_TASK_CREATED_EVENT: { type: 'event', name: 'TaskCreated' },
  ROUTER_SOLUTION_DELIVERY_CLAIMED_EVENT: { type: 'event', name: 'SolutionDeliveryClaimed' },
  MECH_DELIVER_EVENT: { type: 'event', name: 'Deliver' },
  findLatestDeliveryDataHexForRequest: vi.fn().mockResolvedValue(`0x${'cc'.repeat(32)}`),
  getMarketplaceRequestDeliveryMech: vi.fn().mockResolvedValue(`0x${'77'.repeat(20)}`),
  getTaskCidDigest: vi.fn().mockResolvedValue(`0x${'cc'.repeat(32)}`),
  callDeliverToMarketplace: vi.fn().mockResolvedValue(`0x${'cd'.repeat(32)}`),
  findLatestDeliveryForRequest: vi.fn(),
  isDeliveryAlreadyClaimed: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  buildResultPayload: vi.fn((requestId: string, result: unknown) => ({ requestId, ...(result as Record<string, unknown>) })),
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue(`0x${'ab'.repeat(32)}`),
  fetchFromIpfs: vi.fn(),
  fetchSignedTaskFromIpfs: vi.fn(),
  fetchSignedEnvelopeFromIpfs: vi.fn().mockResolvedValue(null),
  digestHexToGatewayUrl: vi.fn(),
}));

vi.mock('../../src/adapters/mech/digest.js', () => ({
  manifestDigestForCid: vi.fn().mockReturnValue(`0x${'99'.repeat(32)}`),
}));

vi.mock('../../src/adapters/mech/safe.js', () => ({
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

describe('solution path retired at stage 1', () => {
  it('yields no task announcements from watchForTasks', async () => {
    const adapter = adapterFixture({ routerLogs: ['TaskCreated', 'SolutionDeliveryClaimed'], pollIntervalMs: 10 });
    const yielded: unknown[] = [];
    const consume = async () => {
      for await (const announcement of adapter.watchForTasks()) {
        yielded.push(announcement);
      }
    };
    const consumer = consume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await adapter.stop();
    await consumer;
    expect(yielded).toEqual([]);
  });

  it('does not gate router polling on joinedSolverNets', async () => {
    const adapter = adapterFixture({ joinedSolverNets: {}, routerLogs: ['TaskCreated'], pollIntervalMs: 10 });
    const yielded: unknown[] = [];
    const consume = async () => {
      for await (const _announcement of adapter.watchForTasks()) {
        yielded.push(_announcement);
      }
    };
    const consumer = consume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await adapter.stop();
    await consumer;
    expect(yielded).toEqual([]);
  });
});
