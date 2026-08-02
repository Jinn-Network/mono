import { describe, expect, it, vi } from 'vitest';
import type {
  ReconciliationReport,
  TaskExecutionBackend,
} from '@jinn-network/task-execution-backend';
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import { Store } from '../../src/store/store.js';
import { NativeOperatorStateRepository } from '../../src/daemon/native-operator-state.js';
import {
  NativeSolutionCoordinator,
  type NativeSolutionSettlementCanonicalFact,
  type NativeSolutionVerificationPort,
} from '../../src/daemon/native-solution-coordinator.js';

const COORDINATOR = '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98';
const SUBMISSION = 'urn:uuid:33333333-3333-4333-8333-333333333333' as const;
const REQUESTER = 'urn:uuid:44444444-4444-4444-8444-444444444444';
const outputBytes = new TextEncoder().encode('{"probability":0.62}');
const evidenceBytes = serializeCanonicalJson({
  '@context': 'https://jinn.network/evidence/context/1.0',
  '@graph': [{
    '@id': 'urn:uuid:55555555-5555-4555-8555-555555555555',
    '@type': 'https://jinn.network/evidence/Execution',
  }],
});
const envelopeBytes = new TextEncoder().encode('{"payloadType":"application/vnd.jinn.marketplace.executor-binding.v1+json"}');

function exactDocuments() {
  const taskBytes = sealTask({
    protocol: 'https://jinn.network/profiles/task-execution/1.0',
    profile: {
      uri: 'https://jinn.network/task-profiles/prediction-forecast/1.0',
      digest: { sha256: '1'.repeat(64) },
    },
    instructions: 'Return a deterministic prediction.',
    outputs: [{ name: 'prediction', mediaType: 'application/json', required: true }],
  });
  const submissionBytes = sealSubmission({
    protocol: 'https://jinn.network/profiles/task-execution/1.0',
    submission: SUBMISSION,
    task: { digest: { sha256: documentDigest(taskBytes).slice('sha256:'.length) } },
    requester: REQUESTER,
    idempotencyKey: 'native-solution-coordinator-test',
    nonce: 'native-solution-nonce',
    deadline: '2099-01-01T00:00:00Z',
  });
  return { taskBytes, submissionBytes };
}

function finalizedClaim() {
  const store = new Store(':memory:');
  store.db.prepare(
    `INSERT INTO native_discovery_cards
       (id, source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
     VALUES (1, 'urn:jinn:requester:one', 'native-requester', '0000000000000001', ?,
       'announcement-1', '{}', '2026-08-02T00:00:00.000Z')`,
  ).run(`sha256:${'2'.repeat(64)}`);
  const state = new NativeOperatorStateRepository(store, {
    now: () => new Date('2026-08-02T00:00:00Z'),
  });
  const documents = exactDocuments();
  const admitted = state.recordDecision({
    chainId: 84532,
    coordinator: COORDINATOR,
    taskId: 7n,
    operatorAgent: 'urn:jinn:operator:solver-a',
    taskDigest: documentDigest(documents.taskBytes),
    submissionUri: SUBMISSION,
    submissionDigest: documentDigest(documents.submissionBytes),
    source: {
      cardId: 1,
      agent: 'urn:jinn:requester:one',
      name: 'native-requester',
      sequence: '0000000000000001',
      entryDigest: `sha256:${'2'.repeat(64)}`,
      announcementId: 'announcement-1',
    },
    decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
  });
  if (admitted.kind !== 'admitted') throw new Error('expected native admission');
  const txHash = `0x${'3'.repeat(64)}` as const;
  state.recordClaimBroadcast(admitted.claimOperationId, txHash);
  state.recordClaimFinalized(admitted.claimOperationId, {
    txHash,
    blockHash: `0x${'4'.repeat(64)}`,
    blockNumber: 100n,
    attemptIndex: 0,
    requestId: `0x${'5'.repeat(64)}`,
  });
  return { store, state, engagementId: admitted.engagementId, documents };
}

function setup(input: {
  readonly recover?: ReconciliationReport;
  readonly evidenceBytes?: Uint8Array | null;
  readonly verification?: Awaited<ReturnType<NativeSolutionVerificationPort['verify']>>;
  readonly settlementFacts?: readonly NativeSolutionSettlementCanonicalFact[];
} = {}) {
  const subject = finalizedClaim();
  const engagement = subject.state.getEngagement(subject.engagementId)!;
  const deliveryBytes = sealDelivery({
    protocol: 'https://jinn.network/profiles/task-execution/1.0',
    attempt: engagement.attemptUri!,
    task: documentDigest(subject.documents.taskBytes),
    outputs: [{
      name: 'prediction',
      mediaType: 'application/json',
      digest: { sha256: documentDigest(outputBytes).slice('sha256:'.length) },
    }],
    evidenceRecords: [{ family: 'execution-evidence', digest: documentDigest(evidenceBytes) }],
    executionIds: ['urn:uuid:55555555-5555-4555-8555-555555555555'],
    outcome: 'fulfilled',
    createdAt: '2026-08-02T00:05:00.000Z',
  });
  let submitted = false;
  const submit = vi.fn(async () => {
    submitted = true;
    return { accepted: true as const, submission: SUBMISSION, digest: documentDigest(subject.documents.submissionBytes) };
  });
  const backend: TaskExecutionBackend = {
    capabilities: async () => ({
      taskProfiles: [], inputMediaTypes: [], outputMediaTypes: [], workspaceKinds: [], isolation: [],
      watch: false, cancel: false, fetchArtifact: true, signedDeliveries: true,
      runPinning: { posture: 'none', keys: [] },
    }),
    submit,
    recover: vi.fn(async () => input.recover ?? { classification: submitted ? 'matching' : 'absent' }),
    observe: vi.fn(async () => ({
      descriptor: {
        protocol: 'https://jinn.network/profiles/task-execution/1.0',
        attempt: engagement.attemptUri!,
        task: documentDigest(subject.documents.taskBytes),
        submission: SUBMISSION,
        derived: { state: 'delivered', terminal: true },
      },
      cursor: { sequence: '0000000000000010' },
      observations: [],
    })),
    deliveries: vi.fn(async () => [{ attempt: engagement.attemptUri!, digest: documentDigest(deliveryBytes) }]),
    fetchDelivery: vi.fn(async () => deliveryBytes),
    fetchArtifact: vi.fn(async () => outputBytes),
  };
  const verify = vi.fn(async () => input.verification ?? ({ ok: true as const }));
  const publish = vi.fn(async ({ publication }: Parameters<NonNullable<ConstructorParameters<typeof NativeSolutionCoordinator>[0]['publisher']['publish']>>[0]) => ({
    location: `https://operator.example/records/${publication.recordDigest.slice('sha256:'.length)}`,
    sequence: '0000000000000001',
    entryDigest: `sha256:${'6'.repeat(64)}` as const,
  }));
  let settlementBroadcast = false;
  let settlementFactIndex = 0;
  const settlement = {
    broadcast: vi.fn(async () => {
      settlementBroadcast = true;
      return { txHash: `0x${'7'.repeat(64)}` as const };
    }),
    readCanonical: vi.fn(async () => {
      const configured = input.settlementFacts?.[settlementFactIndex++];
      if (configured !== undefined) return configured;
      return settlementBroadcast
        ? {
            kind: 'finalized' as const,
            txHash: `0x${'7'.repeat(64)}` as const,
            blockHash: `0x${'8'.repeat(64)}` as const,
            blockNumber: 120n,
          }
        : { kind: 'absent' as const, checkedAtBlock: 119n };
    }),
  };
  const coordinator = new NativeSolutionCoordinator({
    state: subject.state,
    backend,
    documents: { resolve: async () => subject.documents },
    deliverySignature: { get: () => envelopeBytes },
    evidence: {
      awaitIndexed: async (reference) => ({ status: 'indexed' as const, reference }),
      getRecord: async () => input.evidenceBytes === undefined ? evidenceBytes : input.evidenceBytes,
    },
    verification: { verify },
    publisher: { sourceId: 'urn:jinn:source:solver-records', publish },
    settlement,
  });
  return { ...subject, coordinator, backend, submit, verify, publish, settlement, deliveryBytes };
}

describe('NativeSolutionCoordinator', () => {
  it('recovers before submit, verifies the exact public graph, publishes, and finalizes one settlement', async () => {
    const subject = setup();

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toMatchObject({ kind: 'solution-settled' });

    expect(subject.backend.recover).toHaveBeenCalledBefore(subject.submit);
    expect(subject.submit).toHaveBeenCalledOnce();
    const engagement = subject.state.getEngagement(subject.engagementId)!;
    const execution = subject.state.getSolutionExecution(subject.engagementId)!;
    expect(subject.submit).toHaveBeenCalledWith(
      execution.taskBytes,
      execution.submissionBytes,
      expect.objectContaining({ attemptUri: engagement.attemptUri }),
    );
    expect(subject.verify).toHaveBeenCalledWith(expect.objectContaining({
      effectiveTime: '2026-08-02T00:05:00.000Z',
      deliveryBytes: subject.deliveryBytes,
      deliveryEnvelopeBytes: envelopeBytes,
      dispatchContextBytes: execution.dispatchContextBytes,
    }));
    expect(subject.publish).toHaveBeenCalledTimes(4);
    expect(subject.settlement.broadcast).toHaveBeenCalledOnce();
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'solution-settled' });
  });

  it('accepts matching backend recovery without a duplicate submit', async () => {
    const subject = setup({ recover: { classification: 'matching' } });

    await subject.coordinator.reconcileEngagement(subject.engagementId);

    expect(subject.submit).not.toHaveBeenCalled();
    expect(subject.state.listOperations(subject.engagementId).filter(({ kind }) => kind === 'backend-submit')).toHaveLength(1);
  });

  it('fails closed on contradictory backend recovery', async () => {
    const subject = setup({ recover: { classification: 'contradictory', detail: 'different sealed input' } });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId)).resolves.toEqual({
      kind: 'failed',
      reason: 'backend-contradictory',
    });

    expect(subject.submit).not.toHaveBeenCalled();
    expect(subject.publish).not.toHaveBeenCalled();
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'failed' });
  });

  it('does not confuse Delivery bytes with execution evidence', async () => {
    const subject = setup({ evidenceBytes: subjectDeliverySentinel() });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId)).resolves.toEqual({
      kind: 'failed',
      reason: 'evidence-digest-mismatch',
    });

    expect(subject.publish).not.toHaveBeenCalled();
    expect(subject.settlement.broadcast).not.toHaveBeenCalled();
  });

  it('blocks publication and settlement when delivery-time binding resolution fails', async () => {
    const subject = setup({ verification: { ok: false, reason: 'delivery-binding-revoked' } });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId)).resolves.toEqual({
      kind: 'failed',
      reason: 'delivery-binding-revoked',
    });

    expect(subject.verify).toHaveBeenCalledWith(expect.objectContaining({
      effectiveTime: '2026-08-02T00:05:00.000Z',
    }));
    expect(subject.publish).not.toHaveBeenCalled();
    expect(subject.settlement.broadcast).not.toHaveBeenCalled();
  });

  it('reopens an orphaned settlement with the same durable operation identity', async () => {
    const txHash = `0x${'7'.repeat(64)}` as const;
    const subject = setup({
      settlementFacts: [
        { kind: 'absent', checkedAtBlock: 119n },
        { kind: 'orphaned', txHash, reason: 'projector-reorg-correction' },
        { kind: 'absent', checkedAtBlock: 121n },
        {
          kind: 'finalized', txHash,
          blockHash: `0x${'8'.repeat(64)}`, blockNumber: 122n,
        },
      ],
    });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toEqual({ kind: 'solution-published' });
    const originalOperation = subject.state.listOperations(subject.engagementId)
      .find(({ kind }) => kind === 'solution-settlement')!;
    expect(originalOperation.status).toBe('orphaned');

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toMatchObject({ kind: 'solution-settled', operationId: originalOperation.operationId });

    expect(subject.settlement.broadcast).toHaveBeenCalledTimes(2);
    expect(subject.settlement.broadcast.mock.calls.map(([request]) => request.operationId))
      .toEqual([originalOperation.operationId, originalOperation.operationId]);
    expect(subject.state.listOperations(subject.engagementId)
      .filter(({ kind }) => kind === 'solution-settlement')).toHaveLength(1);
  });
});

function subjectDeliverySentinel(): Uint8Array {
  return new TextEncoder().encode('{"this":"is not the referenced evidence"}');
}
