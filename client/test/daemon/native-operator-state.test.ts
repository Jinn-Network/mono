import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import {
  NATIVE_OPERATOR_STATE_SCHEMA_VERSION,
  NativeOperatorStateConflictError,
  NativeOperatorStateRepository,
} from '../../src/daemon/native-operator-state.js';
import { engagementId } from '../../src/daemon/native-operation-identity.js';
import { deriveMarketplaceAttemptUri } from '@jinn-network/marketplace-binding';

const SOURCE = {
  cardId: 1,
  agent: 'urn:jinn:requester:one',
  name: 'native-requester',
  sequence: '0000000000000001',
  entryDigest: `sha256:${'1'.repeat(64)}` as const,
  announcementId: 'announcement-1',
};
const INPUT = {
  chainId: 84532,
  coordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98',
  taskId: 7n,
  operatorAgent: 'urn:jinn:operator:solver-a',
  taskDigest: `sha256:${'2'.repeat(64)}` as const,
  submissionUri: 'urn:uuid:33333333-3333-4333-8333-333333333333' as const,
  submissionDigest: `sha256:${'4'.repeat(64)}` as const,
  source: SOURCE,
};

function storeWithCard(): Store {
  const store = new Store(':memory:');
  store.db.prepare(
    `INSERT INTO native_discovery_cards
       (id, source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(
    SOURCE.cardId,
    SOURCE.agent,
    SOURCE.name,
    SOURCE.sequence,
    SOURCE.entryDigest,
    SOURCE.announcementId,
    '2026-08-02T00:00:00.000Z',
  );
  return store;
}

describe('NativeOperatorStateRepository', () => {
  it('installs additive versioned tables without converting legacy rows', () => {
    const store = new Store(':memory:');
    store.db.prepare(
      `INSERT INTO engagement_ledger
        (idempotency_key, chain_id, task_coordinator, task_id, work_kind, wiring_json, outcome, created_at, updated_at)
       VALUES ('legacy', 84532, '0xlegacy', '1', 'legacy', '{}', 'claimed', 't', 't')`,
    ).run();
    const state = new NativeOperatorStateRepository(store, { now: () => new Date('2026-08-02T00:00:00Z') });
    expect(state.schemaVersion()).toBe(NATIVE_OPERATOR_STATE_SCHEMA_VERSION);
    expect(state.listEngagements()).toEqual([]);
    expect(store.db.prepare(`SELECT COUNT(*) AS count FROM engagement_ledger`).get()).toEqual({ count: 1 });
  });

  it('atomically acknowledges a source card with an eligible engagement and claim intent', () => {
    const store = storeWithCard();
    const state = new NativeOperatorStateRepository(store, { now: () => new Date('2026-08-02T00:00:00Z') });
    const result = state.recordDecision({
      ...INPUT,
      decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
    });
    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') throw new Error('expected admission');
    expect(result.engagementId).toBe(engagementId(INPUT));
    expect(state.getEngagement(result.engagementId)).toMatchObject({ state: 'claim-pending' });
    expect(state.getOperation(result.claimOperationId)).toMatchObject({ status: 'intent', kind: 'claim' });
    expect(store.db.prepare(
      `SELECT acknowledged_at FROM native_discovery_cards WHERE id = ?`,
    ).get(SOURCE.cardId)).toEqual({ acknowledged_at: '2026-08-02T00:00:00.000Z' });
  });

  it('deduplicates a replay but fails closed and audits different sealed inputs', () => {
    const store = storeWithCard();
    const state = new NativeOperatorStateRepository(store, { now: () => new Date('2026-08-02T00:00:00Z') });
    const admitted = state.recordDecision({
      ...INPUT,
      decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
    });
    if (admitted.kind !== 'admitted') throw new Error('expected admission');
    expect(state.recordDecision({
      ...INPUT,
      decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
    })).toMatchObject({ kind: 'duplicate', engagementId: admitted.engagementId });
    expect(() => state.recordDecision({
      ...INPUT,
      submissionDigest: `sha256:${'9'.repeat(64)}`,
      decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
    })).toThrow(NativeOperatorStateConflictError);

    store.db.prepare(
      `INSERT INTO native_discovery_cards
       (id, source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
       VALUES (2, ?, ?, '0000000000000002', ?, 'announcement-2', '{}', 't')`,
    ).run(SOURCE.agent, SOURCE.name, `sha256:${'5'.repeat(64)}`);
    expect(() => state.recordDecision({
      ...INPUT,
      submissionDigest: `sha256:${'6'.repeat(64)}`,
      source: {
        ...SOURCE,
        cardId: 2,
        sequence: '0000000000000002',
        entryDigest: `sha256:${'5'.repeat(64)}`,
        announcementId: 'announcement-2',
      },
      decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
    })).toThrow(NativeOperatorStateConflictError);
    expect(state.listAuditEvents(admitted.engagementId).at(-1)).toMatchObject({ kind: 'sealed-input-conflict' });
    expect(state.listOperations(admitted.engagementId)).toHaveLength(1);
  });

  it('durably records refusal before acknowledging without creating a claim intent', () => {
    const store = storeWithCard();
    const state = new NativeOperatorStateRepository(store, { now: () => new Date('2026-08-02T00:00:00Z') });
    expect(state.recordDecision({
      ...INPUT,
      decision: {
        ok: false,
        reason: 'unsupported-profile',
        capability: { ok: false, reason: 'profile-mismatch' },
        policy: { ok: false, reason: 'unsupported-profile' },
      },
    })).toEqual({ kind: 'refused', reason: 'unsupported-profile' });
    expect(state.listEngagements()).toEqual([]);
    expect(state.listOperations()).toEqual([]);
    expect(state.listAuditEvents()).toEqual([
      expect.objectContaining({ kind: 'admission-refused', detail: expect.stringContaining('unsupported-profile') }),
    ]);
    expect(store.db.prepare(`SELECT acknowledged_at FROM native_discovery_cards WHERE id = 1`).get())
      .toEqual({ acknowledged_at: '2026-08-02T00:00:00.000Z' });
  });

  it('records retryable deferrals without acknowledging or creating an engagement', () => {
    const store = storeWithCard();
    const state = new NativeOperatorStateRepository(store, { now: () => new Date('2026-08-02T00:00:00Z') });
    state.recordDeferral({ ...INPUT, reason: 'capacity-policy', detail: { active: 1 } });
    state.recordDeferral({ ...INPUT, reason: 'capacity-policy', detail: { active: 1 } });
    expect(store.db.prepare(`SELECT acknowledged_at FROM native_discovery_cards WHERE id = 1`).get())
      .toEqual({ acknowledged_at: null });
    expect(store.db.prepare(`SELECT reason, retry_count FROM native_source_deferrals WHERE card_id = 1`).get())
      .toEqual({ reason: 'capacity-policy', retry_count: 2 });
    expect(state.listEngagements()).toEqual([]);
    expect(state.listOperations()).toEqual([]);

    state.recordDecision({
      ...INPUT,
      decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
    });
    expect(store.db.prepare(`SELECT COUNT(*) AS count FROM native_source_deferrals WHERE card_id = 1`).get())
      .toEqual({ count: 0 });
    expect(() => state.recordDeferral({ ...INPUT, reason: 'capacity-policy', detail: {} }))
      .toThrow(NativeOperatorStateConflictError);
  });

  it('tracks claim intent, uncertain broadcast, replacement, safe observation, and finality under one operation id', () => {
    const store = storeWithCard();
    const state = new NativeOperatorStateRepository(store, { now: () => new Date('2026-08-02T00:00:00Z') });
    const admitted = state.recordDecision({
      ...INPUT,
      decision: { ok: true, capability: { snapshot: 'real' }, policy: { profile: 'prediction' } },
    });
    if (admitted.kind !== 'admitted') throw new Error('expected admission');
    const firstTx = `0x${'a'.repeat(64)}` as const;
    const replacementTx = `0x${'b'.repeat(64)}` as const;
    state.recordClaimBroadcast(admitted.claimOperationId, undefined, { uncertainty: 'wallet-return-lost' });
    expect(state.getOperation(admitted.claimOperationId)).toMatchObject({ status: 'broadcast', txHash: null });
    state.recordClaimBroadcast(admitted.claimOperationId, firstTx);
    state.recordClaimReplacement(admitted.claimOperationId, firstTx, replacementTx);
    state.recordClaimObservedSafe(admitted.claimOperationId, {
      txHash: replacementTx,
      blockHash: `0x${'c'.repeat(64)}`,
      blockNumber: 101n,
      attemptIndex: 3,
      requestId: `0x${'d'.repeat(64)}`,
    });
    state.recordClaimFinalized(admitted.claimOperationId, {
      txHash: replacementTx,
      blockHash: `0x${'c'.repeat(64)}`,
      blockNumber: 101n,
      attemptIndex: 3,
      requestId: `0x${'d'.repeat(64)}`,
    });
    expect(state.getOperation(admitted.claimOperationId)).toMatchObject({
      status: 'finalized', txHash: replacementTx, priorTxHash: firstTx, blockNumber: 101n,
    });
    expect(state.getEngagement(admitted.engagementId)).toMatchObject({
      state: 'claim-finalized',
      attemptIndex: 3,
      attemptUri: deriveMarketplaceAttemptUri({
        chainId: INPUT.chainId,
        coordinator: INPUT.coordinator,
        taskId: INPUT.taskId,
        attemptIndex: 3,
      }),
      requestId: `0x${'d'.repeat(64)}`,
    });
    expect(state.listNonterminalClaimOperations()).toEqual([]);
  });

  it('reopens the same logical claim after an orphan and fails closed on changed canonical facts', () => {
    const store = storeWithCard();
    const state = new NativeOperatorStateRepository(store, { now: () => new Date('2026-08-02T00:00:00Z') });
    const admitted = state.recordDecision({
      ...INPUT,
      decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
    });
    if (admitted.kind !== 'admitted') throw new Error('expected admission');
    const tx = `0x${'a'.repeat(64)}` as const;
    state.recordClaimBroadcast(admitted.claimOperationId, tx);
    state.recordClaimOrphaned(admitted.claimOperationId, { txHash: tx, reason: 'safe-reorg' });
    expect(state.getEngagement(admitted.engagementId)).toMatchObject({ state: 'eligible' });
    state.prepareClaimRetry(admitted.claimOperationId);
    expect(state.getOperation(admitted.claimOperationId)).toMatchObject({ status: 'intent', txHash: null });
    state.recordClaimBroadcast(admitted.claimOperationId, tx);
    state.recordClaimObservedSafe(admitted.claimOperationId, {
      txHash: tx,
      blockHash: `0x${'c'.repeat(64)}`,
      blockNumber: 2n,
      attemptIndex: 0,
      requestId: `0x${'d'.repeat(64)}`,
    });
    expect(() => state.recordClaimFinalized(admitted.claimOperationId, {
      txHash: tx,
      blockHash: `0x${'e'.repeat(64)}`,
      blockNumber: 2n,
      attemptIndex: 0,
      requestId: `0x${'d'.repeat(64)}`,
    })).toThrow(NativeOperatorStateConflictError);
    state.recordClaimLost(admitted.claimOperationId, { reason: 'race-lost' });
    expect(state.getOperation(admitted.claimOperationId)).toMatchObject({ status: 'failed-terminal' });
    expect(state.getEngagement(admitted.engagementId)).toMatchObject({ state: 'lost' });
  });
});
