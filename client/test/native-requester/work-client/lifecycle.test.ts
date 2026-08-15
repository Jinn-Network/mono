import { describe, expect, it, vi } from 'vitest';
import {
  cancelAttempt,
  closePosting,
  isRequesterError,
  releasePostedAttempt,
} from '../../../src/native-requester/work-client/index.js';

const ATTEMPT = 'urn:uuid:11111111-2222-3333-4444-555555555555' as const;

describe('closePosting', () => {
  it('prefers the revised closeTask when the port carries it', async () => {
    const closeTask = vi.fn(async () => {});
    const refund = vi.fn(async () => {});
    const withdraw = vi.fn(async () => {});
    const result = await closePosting({
      taskId: 42n,
      port: { closeTask, refundUnusedTaskBudget: refund, withdrawAnnouncement: withdraw },
    });
    expect(result).toEqual({
      verb: 'tasks close',
      taskId: '42',
      action: 'closed',
      announcementWithdrawn: true,
    });
    expect(closeTask).toHaveBeenCalledWith({ taskId: 42n });
    expect(refund).not.toHaveBeenCalled();
    expect(withdraw).toHaveBeenCalledWith({ taskId: 42n });
  });

  it('falls back to refundUnusedTaskBudget on the today generation', async () => {
    const refund = vi.fn(async () => {});
    const result = await closePosting({
      taskId: 7n,
      port: { refundUnusedTaskBudget: refund, withdrawAnnouncement: async () => {} },
    });
    expect(result.action).toBe('refunded');
    expect(refund).toHaveBeenCalledWith({ taskId: 7n });
  });

  it('does not require withdrawAnnouncement', async () => {
    const result = await closePosting({ taskId: 1n, port: { refundUnusedTaskBudget: async () => {} } });
    expect(result.announcementWithdrawn).toBe(false);
    expect(result.action).toBe('refunded');
  });

  it('refuses fail-closed when the port has neither close path', async () => {
    await expect(closePosting({ taskId: 1n, port: {} })).rejects.toSatisfy((err: unknown) =>
      isRequesterError(err) && err.category === 'config' && err.code === 'close-unsupported',
    );
  });

  it('rejects a negative taskId as config error', async () => {
    await expect(closePosting({ taskId: -1n, port: {} })).rejects.toSatisfy((err: unknown) =>
      isRequesterError(err) && err.code === 'invalid-task-id',
    );
  });
});

describe('cancelAttempt', () => {
  it('resolves the attempt and persists the durable cancel signal', async () => {
    const resolveAttempt = vi.fn(async () => ({ taskId: 99n, attemptIndex: 2 }));
    const requestCancel = vi.fn(async () => 'requested' as const);
    const result = await cancelAttempt({ attempt: ATTEMPT, reason: 'stale', port: { resolveAttempt, requestCancel } });
    expect(result).toEqual({
      verb: 'tasks cancel',
      attempt: ATTEMPT,
      taskId: '99',
      attemptIndex: 2,
      signal: 'requested',
    });
    expect(requestCancel).toHaveBeenCalledWith({ attempt: ATTEMPT, taskId: 99n, attemptIndex: 2, reason: 'stale' });
  });

  it('surfaces already-requested idempotently', async () => {
    const result = await cancelAttempt({
      attempt: ATTEMPT,
      reason: 'stale',
      port: { resolveAttempt: async () => ({ taskId: 1n, attemptIndex: 0 }), requestCancel: async () => 'already-requested' },
    });
    expect(result.signal).toBe('already-requested');
  });

  it('rejects a non-urn attempt', async () => {
    await expect(
      cancelAttempt({ attempt: 'not-a-urn' as never, reason: 'x', port: { resolveAttempt: async () => ({ taskId: 1n, attemptIndex: 0 }), requestCancel: async () => 'requested' } }),
    ).rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.code === 'invalid-attempt');
  });

  it('rejects an empty reason', async () => {
    await expect(
      cancelAttempt({ attempt: ATTEMPT, reason: '  ', port: { resolveAttempt: async () => ({ taskId: 1n, attemptIndex: 0 }), requestCancel: async () => 'requested' } }),
    ).rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.code === 'invalid-reason');
  });
});

describe('releasePostedAttempt', () => {
  it('reports released when the chain write runs (revised)', async () => {
    const releaseAttempt = vi.fn(async () => undefined);
    const result = await releasePostedAttempt({ taskId: 5n, attemptIndex: 1, port: { releaseAttempt } });
    expect(result).toEqual({ verb: 'tasks release', taskId: '5', attemptIndex: 1, outcome: 'released' });
    expect(releaseAttempt).toHaveBeenCalledWith({ taskId: 5n, attemptIndex: 1 });
  });

  it('reports unsupported (not a throw) on the today generation', async () => {
    const result = await releasePostedAttempt({
      taskId: 5n,
      attemptIndex: 0,
      port: { releaseAttempt: async () => ({ ok: false, kind: 'unsupported' }) },
    });
    expect(result.outcome).toBe('unsupported');
  });

  it('rejects a negative attemptIndex', async () => {
    await expect(
      releasePostedAttempt({ taskId: 1n, attemptIndex: -1, port: { releaseAttempt: async () => undefined } }),
    ).rejects.toSatisfy((err: unknown) => isRequesterError(err) && err.code === 'invalid-attempt-index');
  });
});
