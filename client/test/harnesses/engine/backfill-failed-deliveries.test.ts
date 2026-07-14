/**
 * Tests for the #506 backfill: FAILED task_runs whose delivery tx actually
 * landed on-chain get reclassified as COMPLETE.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { Store } from '../../../src/store/store.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import { backfillFailedDeliveries } from '../../../src/harnesses/engine/backfill-failed-deliveries.js';

function makeInput(requestId: string, overrides: Partial<PersistedTaskRunInput> = {}): PersistedTaskRunInput {
  return {
    requestId,
    taskCid: 'bafyabc123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 1000,
    solverType: 'portfolio.v0',
    windowStartTs: Date.now() - 60_000,
    windowEndTs: Date.now() + 86_400_000,
    task: { id: requestId, description: 'test' },
    ...overrides,
  };
}

/** Walk a fresh row through to a FAILED terminal state, optionally with a deliveryTxHash. */
function seedFailed(
  p: TaskRunPersistence,
  requestId: string,
  opts: { deliveryTxHash?: string } = {},
): void {
  p.insertDiscovered(makeInput(requestId));
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  p.transition(requestId, TaskRunState.PRE_SNAPSHOT);
  p.transition(requestId, TaskRunState.RUNNING);
  p.transition(requestId, TaskRunState.POST_SNAPSHOT);
  p.transition(requestId, TaskRunState.PACKAGING);
  p.transition(requestId, TaskRunState.DELIVERING, {
    deliveryTxHash: opts.deliveryTxHash ?? null,
  });
  p.markFailed(requestId, 'insertArtifact threw: NOT NULL constraint failed');
}

describe('backfillFailedDeliveries', () => {
  let store: Store;
  let persistence: TaskRunPersistence;

  beforeEach(() => {
    store = new Store(':memory:');
    persistence = new TaskRunPersistence(store.db);
  });

  afterEach(() => {
    store.close();
  });

  it('reclassifies a FAILED row as COMPLETE when the delivery tx succeeded', async () => {
    seedFailed(persistence, 'req-success', { deliveryTxHash: '0xaaa' });
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient;

    const result = await backfillFailedDeliveries({ persistence, publicClient });

    expect(result.reclassified).toEqual(['req-success']);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(persistence.getByRequestId('req-success')!.state).toBe(TaskRunState.COMPLETE);
  });

  it('skips a FAILED row with no deliveryTxHash', async () => {
    seedFailed(persistence, 'req-no-hash');
    const publicClient = {
      getTransactionReceipt: vi.fn(),
    } as unknown as PublicClient;

    const result = await backfillFailedDeliveries({ persistence, publicClient });

    expect(result.reclassified).toEqual([]);
    expect(result.skipped).toEqual([{ requestId: 'req-no-hash', reason: expect.any(String) }]);
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled();
    expect(persistence.getByRequestId('req-no-hash')!.state).toBe(TaskRunState.FAILED);
  });

  it('skips a FAILED row whose delivery tx reverted', async () => {
    seedFailed(persistence, 'req-reverted', { deliveryTxHash: '0xbbb' });
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted' }),
    } as unknown as PublicClient;

    const result = await backfillFailedDeliveries({ persistence, publicClient });

    expect(result.reclassified).toEqual([]);
    expect(result.skipped).toEqual([{ requestId: 'req-reverted', reason: expect.any(String) }]);
    expect(persistence.getByRequestId('req-reverted')!.state).toBe(TaskRunState.FAILED);
  });

  it('records an RPC rejection as failed and keeps processing the rest of the batch', async () => {
    seedFailed(persistence, 'req-rpc-down', { deliveryTxHash: '0xccc' });
    seedFailed(persistence, 'req-healthy', { deliveryTxHash: '0xddd' });
    const getTransactionReceipt = vi.fn().mockImplementation(async ({ hash }: { hash: string }) => {
      if (hash === '0xccc') throw new Error('RPC unavailable');
      return { status: 'success' };
    });
    const publicClient = { getTransactionReceipt } as unknown as PublicClient;

    const result = await backfillFailedDeliveries({ persistence, publicClient });

    expect(result.failed).toEqual([{ requestId: 'req-rpc-down', error: expect.stringContaining('RPC unavailable') }]);
    expect(result.reclassified).toEqual(['req-healthy']);
    expect(persistence.getByRequestId('req-rpc-down')!.state).toBe(TaskRunState.FAILED);
    expect(persistence.getByRequestId('req-healthy')!.state).toBe(TaskRunState.COMPLETE);
  });

  it('does not touch COMPLETE rows', async () => {
    persistence.insertDiscovered(makeInput('req-complete'));
    persistence.transition('req-complete', TaskRunState.CLAIMED);
    persistence.transition('req-complete', TaskRunState.WAITING);
    persistence.transition('req-complete', TaskRunState.PRE_SNAPSHOT);
    persistence.transition('req-complete', TaskRunState.RUNNING);
    persistence.transition('req-complete', TaskRunState.POST_SNAPSHOT);
    persistence.transition('req-complete', TaskRunState.PACKAGING);
    persistence.transition('req-complete', TaskRunState.DELIVERING, { deliveryTxHash: '0xeee' });
    persistence.transition('req-complete', TaskRunState.COMPLETE);
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient;

    const result = await backfillFailedDeliveries({ persistence, publicClient });

    expect(result.reclassified).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled();
    expect(persistence.getByRequestId('req-complete')!.state).toBe(TaskRunState.COMPLETE);
  });

  it('dryRun: true reports reclassification without writing to the DB', async () => {
    seedFailed(persistence, 'req-dry-run', { deliveryTxHash: '0xfff' });
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient;

    const result = await backfillFailedDeliveries({ persistence, publicClient, dryRun: true });

    expect(result.reclassified).toEqual(['req-dry-run']);
    expect(persistence.getByRequestId('req-dry-run')!.state).toBe(TaskRunState.FAILED);
  });

  it('is idempotent — a second run reclassifies nothing further', async () => {
    seedFailed(persistence, 'req-idempotent', { deliveryTxHash: '0x111' });
    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    } as unknown as PublicClient;

    const first = await backfillFailedDeliveries({ persistence, publicClient });
    expect(first.reclassified).toEqual(['req-idempotent']);

    const second = await backfillFailedDeliveries({ persistence, publicClient });
    expect(second.reclassified).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.failed).toEqual([]);
  });
});
