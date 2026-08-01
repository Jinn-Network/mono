/**
 * Task 16 (cutover stage 1 — docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md):
 * the TaskEngine solution path retires. `canAcceptTask({ taskRole: 'restoration', ... })` always
 * refuses with a named reason. Cutover stage 2 retires the mech evaluation machinery too —
 * `watchForTasks()` no longer yields evaluation announcements.
 */
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import { engineFixture, restorationTask, adapterFixture } from './_engine-fixtures.js';

// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls; mocking
// it is mocking the boundary (matches test/adapters/mech/adapter.test.ts's own convention).
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

// MOCK_JUSTIFICATION: src/adapters/mech/ipfs.js is the I/O leaf for IPFS gateway HTTP calls;
// mocking it is mocking the boundary.
vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  buildResultPayload: vi.fn((requestId: string, result: unknown) => ({ requestId, ...(result as Record<string, unknown>) })),
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue(`0x${'ab'.repeat(32)}`),
  fetchFromIpfs: vi.fn(),
  fetchSignedTaskFromIpfs: vi.fn(),
  fetchSignedEnvelopeFromIpfs: vi.fn().mockResolvedValue(null),
  digestHexToGatewayUrl: vi.fn(),
}));

// MOCK_JUSTIFICATION: digest.js is a pure CID-to-digest transform; mocking it pins the output.
vi.mock('../../src/adapters/mech/digest.js', () => ({
  manifestDigestForCid: vi.fn().mockReturnValue(`0x${'99'.repeat(32)}`),
}));

// MOCK_JUSTIFICATION: canonical-json is a pure transform; isolated here from adapter routing logic.
vi.mock('../../src/harnesses/engine/canonical-json.js', () => ({
  canonicalJson: vi.fn().mockReturnValue('{"mocked":"jcs"}'),
}));

// MOCK_JUSTIFICATION: envelope schema validation is covered elsewhere; isolate adapter routing.
vi.mock('../../src/types/envelope.js', () => ({
  normalizeEnvelopeRole: vi.fn((role: unknown) => (role === 'restoration' ? 'solution' : role)),
  SignedEnvelopeSchema: {
    parse: vi.fn(),
    safeParse: vi.fn().mockReturnValue({ success: false }),
  },
}));

// MOCK_JUSTIFICATION: src/adapters/mech/safe.js is the Safe/RPC I/O leaf; mocking it is mocking
// the boundary — watchForTasks()'s publicClient/walletClient are overwritten by adapterFixture
// anyway (it bypasses initialize()), but MechAdapter's constructor/other paths still import it.
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
  it('refuses a restoration task with a named reason', async () => {
    const engine = engineFixture();
    await expect(
      engine.canAcceptTask({ solverType: 'prediction.v1', taskRole: 'restoration', task: restorationTask() }),
    ).resolves.toEqual({ ok: false, reason: 'solution path retired at cutover stage 1' });
  });

  it('writes no new restoration row to task_runs', async () => {
    const store = new Store(':memory:');
    const engine = engineFixture({ store });
    await engine.canAcceptTask({ solverType: 'prediction.v1', taskRole: 'restoration', task: restorationTask() });
    const rows = new TaskRunPersistence(store.db).getInFlight();
    expect(rows.filter((row) => row.taskRole === 'restoration')).toEqual([]);
  });

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
