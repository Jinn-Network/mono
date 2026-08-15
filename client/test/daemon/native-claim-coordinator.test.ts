import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { Store } from '../../src/store/store.js';
import type { NativeDiscoveryQueuedCard } from '../../src/daemon/native-discovery.js';
import type { NativeClaimDecision } from '../../src/daemon/native-claim-policy.js';
import {
  NativeClaimCoordinator,
  type NativeClaimCanonicalReader,
} from '../../src/daemon/native-claim-coordinator.js';
import {
  NativeOperatorStateRepository,
  NativeWorkerLeaseError,
} from '../../src/daemon/native-operator-state.js';

const TASK_DIGEST = `sha256:${'1'.repeat(64)}` as const;
const SUBMISSION_DIGEST = `sha256:${'2'.repeat(64)}` as const;
const TX = `0x${'3'.repeat(64)}` as const;
const BLOCK = `0x${'4'.repeat(64)}` as const;
const REQUEST = `0x${'5'.repeat(64)}` as const;
const SOURCE_ENTRY = `sha256:${'6'.repeat(64)}` as const;
const OPERATOR = 'urn:jinn:operator:solver-a';

function queued(id = 1, sequence = '0000000000000001'): NativeDiscoveryQueuedCard {
  return {
    id,
    announcementId: `announcement-${id}`,
    card: {
      record: { kind: 'https://spec.jinn.network/records/submission/v1', digest: SUBMISSION_DIGEST },
      facts: {
        taskDigest: TASK_DIGEST,
        taskProfileUri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0',
      },
      chain: {
        taskId: 7n,
        submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
        nonce: 'nonce-1',
        intendedSpendWei: 2n,
      },
      discovery: {
        source: { agent: 'urn:jinn:requester:one', name: 'native-requester' },
        sequence,
        entryDigest: SOURCE_ENTRY,
        signedHighWater: {
          sequence,
          entry: SOURCE_ENTRY,
          issuedAt: '2026-08-02T00:00:00.000Z',
          refreshBy: '2026-08-03T00:00:00.000Z',
          signature: {},
        },
      },
    },
  };
}

function enqueue(store: Store, item: NativeDiscoveryQueuedCard): void {
  const source = item.card.discovery!;
  store.db.prepare(
    `INSERT INTO native_discovery_cards
      (id, source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', '2026-08-02T00:00:00.000Z')`,
  ).run(
    item.id,
    source.source.agent,
    source.source.name,
    source.sequence,
    source.entryDigest,
    item.announcementId,
  );
}

function accepted(): NativeClaimDecision {
  return {
    ok: true,
    facts: {
      taskId: 7n,
      taskDigest: TASK_DIGEST,
      submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      nonce: 'nonce-1',
      profileUri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0',
      requirements: {},
      runnable: true,
      intendedSpendWei: 2n,
      intendedAiUnits: 0,
      workKind: 'prediction',
    },
    capability: { ok: true, backend: {} as never, launcher: {} as never, preflight: { ready: true } },
    policy: {
      ok: true,
      chainId: 84532,
      coordinator: BASE_SEPOLIA_TODAY.taskCoordinator.toLowerCase(),
      intendedSpendWei: '2',
      activeEngagements: 0,
      canonicalFinalized: true,
    },
  };
}

function setup(input: {
  decision?: NativeClaimDecision;
  read?: NativeClaimCanonicalReader['read'];
  broadcast?: ConstructorParameters<typeof NativeClaimCoordinator>[0]['claim']['broadcast'];
} = {}) {
  const store = new Store(':memory:');
  const item = queued();
  enqueue(store, item);
  const state = new NativeOperatorStateRepository(store, { now: () => new Date('2026-08-02T00:00:00Z') });
  const broadcast = vi.fn(input.broadcast ?? (async () => ({
    txHash: TX,
    blockHash: BLOCK,
    blockNumber: 10n,
    attemptIndex: 0,
    requestId: REQUEST,
  })));
  const read = vi.fn(input.read ?? (async ({ operation }) => operation.txHash !== null
    ? {
        kind: 'finalized' as const,
        txHash: TX,
        blockHash: BLOCK,
        blockNumber: 10n,
        attemptIndex: 0,
        requestId: REQUEST,
      }
    : { kind: 'absent' as const, checkedAtBlock: 9n }));
  const coordinator = new NativeClaimCoordinator({
    state,
    chain: BASE_SEPOLIA_TODAY,
    operatorAgent: OPERATOR,
    admission: { evaluate: async () => input.decision ?? accepted() },
    claim: { priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace, broadcast },
    canonical: { read },
    worker: { ownerId: 'worker-a', ttlMs: 60_000 },
  });
  coordinator.startWorker();
  return { store, item, state, coordinator, broadcast, read };
}

describe('NativeClaimCoordinator', () => {
  it('atomically persists decision evidence and claim intent before broadcasting, then finalizes canonical facts', async () => {
    const subject = setup();
    subject.broadcast.mockImplementationOnce(async (input) => {
      expect(subject.state.getOperation(input.operationId)).toMatchObject({ status: 'intent' });
      return { txHash: TX, blockHash: BLOCK, blockNumber: 10n, attemptIndex: 0, requestId: REQUEST };
    });
    await expect(subject.coordinator.process(subject.item, { taskBytes: new Uint8Array([1]), submissionBytes: new Uint8Array([2]) }))
      .resolves.toMatchObject({ kind: 'claim-finalized' });
    expect(subject.broadcast).toHaveBeenCalledOnce();
    expect(subject.state.listOperations()).toEqual([expect.objectContaining({ status: 'finalized' })]);
    expect(subject.store.db.prepare(`SELECT acknowledged_at FROM native_discovery_cards WHERE id = 1`).get())
      .toEqual({ acknowledged_at: '2026-08-02T00:00:00.000Z' });
  });

  it('acknowledges stable policy refusal but keeps retryable dependency refusal pending', async () => {
    const stable = setup({ decision: {
      ok: false,
      reason: 'unsupported-profile',
      retryable: false,
      capability: { ok: false },
      policy: {
        ok: false, reason: 'unsupported-profile', chainId: 84532,
        coordinator: BASE_SEPOLIA_TODAY.taskCoordinator, intendedSpendWei: '2', activeEngagements: 0,
        canonicalFinalized: true,
      },
    } });
    await expect(stable.coordinator.process(stable.item, { taskBytes: new Uint8Array(), submissionBytes: new Uint8Array() }))
      .resolves.toEqual({ kind: 'refused', reason: 'unsupported-profile' });
    expect(stable.broadcast).not.toHaveBeenCalled();
    expect(stable.store.db.prepare(`SELECT acknowledged_at FROM native_discovery_cards WHERE id = 1`).get())
      .toEqual({ acknowledged_at: '2026-08-02T00:00:00.000Z' });

    const retryable = setup({ decision: {
      ok: false,
      reason: 'launcher-probe-failed',
      retryable: true,
      capability: { ok: false, reason: 'launcher-probe-failed' },
      policy: {
        ok: true, chainId: 84532, coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
        intendedSpendWei: '2', activeEngagements: 0, canonicalFinalized: true,
      },
    } });
    await expect(retryable.coordinator.process(retryable.item, { taskBytes: new Uint8Array(), submissionBytes: new Uint8Array() }))
      .resolves.toEqual({ kind: 'deferred', reason: 'launcher-probe-failed' });
    expect(retryable.broadcast).not.toHaveBeenCalled();
    expect(retryable.store.db.prepare(`SELECT acknowledged_at FROM native_discovery_cards WHERE id = 1`).get())
      .toEqual({ acknowledged_at: null });
  });

  it('recovers a wallet-return uncertainty by proving absence before rebroadcasting the same operation', async () => {
    const canonicalFacts: Array<Awaited<ReturnType<NativeClaimCanonicalReader['read']>>> = [
      { kind: 'absent', checkedAtBlock: 10n },
      { kind: 'absent', checkedAtBlock: 11n },
      { kind: 'finalized', txHash: TX, blockHash: BLOCK, blockNumber: 11n, attemptIndex: 0, requestId: REQUEST },
    ];
    let call = 0;
    const subject = setup({
      read: async () => canonicalFacts.shift() ?? { kind: 'absent', checkedAtBlock: 12n },
      broadcast: async () => {
        call += 1;
        if (call === 1) throw new Error('wallet response lost');
        return { txHash: TX, blockHash: BLOCK, blockNumber: 11n, attemptIndex: 0, requestId: REQUEST };
      },
    });
    await expect(subject.coordinator.process(subject.item, { taskBytes: new Uint8Array([1]), submissionBytes: new Uint8Array([2]) }))
      .resolves.toMatchObject({ kind: 'claim-pending', reason: 'broadcast-uncertain' });
    expect(subject.state.listOperations()[0]).toMatchObject({ status: 'broadcast', txHash: null });
    await expect(subject.coordinator.reconcileStartup()).resolves.toEqual({ reconciled: 1, finalized: 1 });
    expect(subject.broadcast).toHaveBeenCalledTimes(2);
    expect(subject.broadcast.mock.calls[0]![0].operationId).toBe(subject.broadcast.mock.calls[1]![0].operationId);
    expect(subject.state.listOperations()[0]).toMatchObject({ status: 'finalized' });
  });

  it('reconciles replacement, orphan, and race loss without creating another operation identity', async () => {
    const facts: Array<Awaited<ReturnType<NativeClaimCanonicalReader['read']>>> = [
      { kind: 'absent', checkedAtBlock: 9n },
      { kind: 'replaced', priorTxHash: TX, txHash: `0x${'7'.repeat(64)}` },
      { kind: 'orphaned', txHash: `0x${'7'.repeat(64)}`, reason: 'safe-reorg' },
      { kind: 'lost', reason: 'race-lost' },
    ];
    const subject = setup({ read: async () => facts.shift()! });
    await subject.coordinator.process(subject.item, { taskBytes: new Uint8Array([1]), submissionBytes: new Uint8Array([2]) });
    expect(subject.state.listOperations()[0]).toMatchObject({ status: 'replaced', priorTxHash: TX });
    await subject.coordinator.reconcileStartup();
    expect(subject.state.listOperations()[0]).toMatchObject({ status: 'orphaned' });
    await subject.coordinator.reconcileStartup();
    expect(subject.state.listOperations()).toHaveLength(1);
    expect(subject.state.listOperations()[0]).toMatchObject({ status: 'failed-terminal' });
    expect(subject.state.listEngagements()[0]).toMatchObject({ state: 'lost' });
  });

  it('does not promote broadcaster receipt block data without a canonical safe observation', async () => {
    const facts: Array<Awaited<ReturnType<NativeClaimCanonicalReader['read']>>> = [
      { kind: 'absent', checkedAtBlock: 9n },
      { kind: 'broadcast', txHash: TX },
    ];
    const subject = setup({ read: async () => facts.shift()! });
    await expect(subject.coordinator.process(subject.item, { taskBytes: new Uint8Array([1]), submissionBytes: new Uint8Array([2]) }))
      .resolves.toMatchObject({ kind: 'claim-pending', reason: 'broadcast' });
    expect(subject.state.listOperations()[0]).toMatchObject({
      status: 'broadcast', txHash: TX, blockHash: null, blockNumber: null,
    });
    expect(subject.state.listEngagements()[0]).toMatchObject({ attemptIndex: null, attemptUri: null });
  });

  it('deduplicates an exact second source announcement across restart without another broadcast', async () => {
    const subject = setup();
    await subject.coordinator.process(subject.item, { taskBytes: new Uint8Array([1]), submissionBytes: new Uint8Array([2]) });
    const duplicate = queued(2, '0000000000000002');
    enqueue(subject.store, duplicate);
    await subject.coordinator.process(duplicate, { taskBytes: new Uint8Array([1]), submissionBytes: new Uint8Array([2]) });
    expect(subject.broadcast).toHaveBeenCalledOnce();
    expect(subject.state.listEngagements()).toHaveLength(1);
    expect(subject.state.listOperations()).toHaveLength(1);
  });

  it('requires a live scoped worker lease and rejects a second coordinator before admission or broadcast', async () => {
    const subject = setup();
    const admission = vi.fn(async () => accepted());
    const broadcast = vi.fn(async () => ({ txHash: TX, attemptIndex: 0 }));
    const second = new NativeClaimCoordinator({
      state: subject.state,
      chain: BASE_SEPOLIA_TODAY,
      operatorAgent: OPERATOR,
      admission: { evaluate: admission },
      claim: { priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace, broadcast },
      canonical: { read: async () => ({ kind: 'absent', checkedAtBlock: 9n }) },
      worker: { ownerId: 'worker-b', ttlMs: 60_000 },
    });
    expect(() => second.startWorker()).toThrow(NativeWorkerLeaseError);
    await expect(second.process(subject.item, { taskBytes: new Uint8Array(), submissionBytes: new Uint8Array() }))
      .rejects.toThrow('has not acquired its worker lease');
    await expect(second.reconcileStartup()).rejects.toThrow('has not acquired its worker lease');
    expect(admission).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('stops idempotently, loses ownership immediately, and permits a different worker to acquire the scope', async () => {
    const subject = setup();
    expect(await subject.coordinator.workerOwned()).toBe(true);

    await subject.coordinator.stopWorker();
    await subject.coordinator.stopWorker();
    expect(await subject.coordinator.workerOwned()).toBe(false);
    expect(() => subject.coordinator.renewWorker()).toThrow('has not acquired its worker lease');
    await expect(subject.coordinator.process(
      subject.item,
      { taskBytes: new Uint8Array(), submissionBytes: new Uint8Array() },
    )).rejects.toThrow('has not acquired its worker lease');

    const replacement = new NativeClaimCoordinator({
      state: subject.state,
      chain: BASE_SEPOLIA_TODAY,
      operatorAgent: OPERATOR,
      admission: { evaluate: async () => accepted() },
      claim: { priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace, broadcast: subject.broadcast },
      canonical: { read: async () => ({ kind: 'absent', checkedAtBlock: 9n }) },
      worker: { ownerId: 'worker-b', ttlMs: 60_000 },
    });
    replacement.startWorker();
    expect(await replacement.workerOwned()).toBe(true);

    // A repeated stop by the old coordinator must not release the new worker's row.
    await subject.coordinator.stopWorker();
    expect(await replacement.workerOwned()).toBe(true);
  });

  // #37: live gate round 22 wedged operator B's work loop permanently. One tick outran the 30s
  // lease TTL (its RPC fallback chain timed out), the lease lapsed, and every subsequent tick threw
  // out of `renewWorker()` — 320 consecutive ticks, zero claims attempted, only a daemon restart
  // cleared it. A lapsed lease that nobody else took is this worker's to resume.
  // Mutation check: delete the `acquireLease` arm from `requireLiveWorker`'s catch and the first
  // test reddens on the very first `renewWorker()`.
  it('re-acquires its own lapsed worker lease and keeps claiming instead of wedging forever', async () => {
    const subject = setup();
    // The wall-clock lapse a slow tick produces: the row is still ours, it is simply past expiry.
    subject.store.db.prepare(`UPDATE native_worker_leases SET expires_at = ?`)
      .run('2026-08-01T23:59:00.000Z');
    expect(await subject.coordinator.workerOwned()).toBe(false);

    expect(() => subject.coordinator.renewWorker()).not.toThrow();
    expect(await subject.coordinator.workerOwned()).toBe(true);
    expect(subject.store.db.prepare(`SELECT owner_id, expires_at FROM native_worker_leases`).get())
      .toEqual({ owner_id: 'worker-a', expires_at: '2026-08-02T00:01:00.000Z' });

    await expect(subject.coordinator.process(
      subject.item,
      { taskBytes: new Uint8Array([1]), submissionBytes: new Uint8Array([2]) },
    )).resolves.toMatchObject({ kind: 'claim-finalized' });
    expect(subject.broadcast).toHaveBeenCalledOnce();
  });

  it('still refuses a live lease held by a different worker after its own lapses', async () => {
    const subject = setup();
    // Another worker legitimately took the scope over while ours was lapsed. Re-acquire must refuse:
    // this is the mutual-exclusion guarantee, and recovery may never step over a live foreign owner.
    subject.store.db.prepare(`UPDATE native_worker_leases SET owner_id = ?, expires_at = ?`)
      .run('worker-b', '2026-08-02T01:00:00.000Z');

    expect(() => subject.coordinator.renewWorker()).toThrow(NativeWorkerLeaseError);
    // The refusal comes from `acquireLease`, so the re-acquire was attempted and declined —
    // not skipped.
    expect(() => subject.coordinator.renewWorker()).toThrow('already held by worker-b');
    await expect(subject.coordinator.process(
      subject.item,
      { taskBytes: new Uint8Array([1]), submissionBytes: new Uint8Array([2]) },
    )).rejects.toThrow(NativeWorkerLeaseError);

    expect(subject.broadcast).not.toHaveBeenCalled();
    expect(subject.state.listOperations()).toEqual([]);
    expect(subject.store.db.prepare(`SELECT owner_id, expires_at FROM native_worker_leases`).get())
      .toEqual({ owner_id: 'worker-b', expires_at: '2026-08-02T01:00:00.000Z' });
  });
});
