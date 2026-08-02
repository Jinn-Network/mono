import { describe, expect, it } from 'vitest';
import { deriveMarketplaceAttemptUri } from '@jinn-network/marketplace-binding';
import {
  documentDigest,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import { Store } from '../../src/store/store.js';
import {
  NativeOperatorStateConflictError,
  NativeOperatorStateRepository,
} from '../../src/daemon/native-operator-state.js';
import {
  backendSubmissionOperationId,
  engagementId,
  solutionSettlementId,
} from '../../src/daemon/native-operation-identity.js';

const SOURCE = {
  cardId: 1,
  agent: 'urn:jinn:requester:one',
  name: 'native-requester',
  sequence: '0000000000000001',
  entryDigest: `sha256:${'1'.repeat(64)}` as const,
  announcementId: 'announcement-1',
};
const CHAIN = {
  chainId: 84532,
  coordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98',
  taskId: 7n,
  operatorAgent: 'urn:jinn:operator:solver-a',
};
const SUBMISSION_URI = 'urn:uuid:33333333-3333-4333-8333-333333333333' as const;
const taskBytes = new TextEncoder().encode('{"native":"task"}');
const submissionBytes = new TextEncoder().encode('{"native":"submission"}');
const taskDigest = documentDigest(taskBytes);
const submissionDigest = documentDigest(submissionBytes);

function finalizedClaim() {
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
  const state = new NativeOperatorStateRepository(store, {
    now: () => new Date('2026-08-02T00:00:00Z'),
  });
  const admitted = state.recordDecision({
    ...CHAIN,
    taskDigest,
    submissionUri: SUBMISSION_URI,
    submissionDigest,
    source: SOURCE,
    decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
  });
  if (admitted.kind !== 'admitted') throw new Error('expected admission');
  const claimTx = `0x${'2'.repeat(64)}` as const;
  state.recordClaimBroadcast(admitted.claimOperationId, claimTx);
  state.recordClaimFinalized(admitted.claimOperationId, {
    txHash: claimTx,
    blockHash: `0x${'3'.repeat(64)}`,
    blockNumber: 100n,
    attemptIndex: 2,
    requestId: `0x${'4'.repeat(64)}`,
  });
  const engagement = state.getEngagement(admitted.engagementId)!;
  const dispatchContextBytes = serializeCanonicalJson({
    taskDigest,
    submission: SUBMISSION_URI,
    nonce: 'native-nonce',
    attempt: engagement.attemptUri!,
  });
  return { store, state, engagement, dispatchContextBytes };
}

describe('native solution state', () => {
  it('migrates v1 metadata additively and leaves claim rows intact', () => {
    const subject = finalizedClaim();
    subject.store.db.prepare(
      `UPDATE native_operator_state_metadata SET schema_version = 1 WHERE singleton = 1`,
    ).run();

    const reopened = new NativeOperatorStateRepository(subject.store);

    expect(reopened.schemaVersion()).toBe(2);
    expect(reopened.getEngagement(subject.engagement.engagementId)).toMatchObject({
      state: 'claim-finalized',
      attemptUri: subject.engagement.attemptUri,
    });
  });

  it('persists exact execution inputs and one backend operation before submission', () => {
    const subject = finalizedClaim();
    const expectedOperation = backendSubmissionOperationId({
      engagementId: subject.engagement.engagementId,
      attempt: subject.engagement.attemptUri!,
    });

    expect(subject.state.beginSolutionExecution(subject.engagement.engagementId, {
      taskBytes,
      submissionBytes,
      dispatchContextBytes: subject.dispatchContextBytes,
    })).toEqual({ kind: 'created', operationId: expectedOperation });
    expect(subject.state.getSolutionExecution(subject.engagement.engagementId)).toMatchObject({
      operationId: expectedOperation,
      attemptUri: subject.engagement.attemptUri,
      taskDigest,
      submissionDigest,
      dispatchContextDigest: documentDigest(subject.dispatchContextBytes),
      taskBytes,
      submissionBytes,
      dispatchContextBytes: subject.dispatchContextBytes,
      status: 'intent',
    });
    expect(subject.state.getEngagement(subject.engagement.engagementId)).toMatchObject({ state: 'executing' });
    expect(subject.state.getOperation(expectedOperation)).toMatchObject({
      kind: 'backend-submit',
      status: 'intent',
    });

    expect(subject.state.beginSolutionExecution(subject.engagement.engagementId, {
      taskBytes,
      submissionBytes,
      dispatchContextBytes: subject.dispatchContextBytes,
    })).toEqual({ kind: 'matching', operationId: expectedOperation });
    expect(() => subject.state.beginSolutionExecution(subject.engagement.engagementId, {
      taskBytes: new Uint8Array([...taskBytes, 0]),
      submissionBytes,
      dispatchContextBytes: subject.dispatchContextBytes,
    })).toThrow(NativeOperatorStateConflictError);
  });

  it('stores a verified artifact graph and publication intents atomically', () => {
    const subject = finalizedClaim();
    const execution = subject.state.beginSolutionExecution(subject.engagement.engagementId, {
      taskBytes,
      submissionBytes,
      dispatchContextBytes: subject.dispatchContextBytes,
    });
    subject.state.recordBackendSubmissionAccepted(execution.operationId);
    const output = new TextEncoder().encode('{"probability":0.62}');
    const evidence = new TextEncoder().encode('{"protocol":"execution-evidence"}');
    const delivery = new TextEncoder().encode('{"protocol":"delivery"}');
    const envelope = new TextEncoder().encode('{"payloadType":"delivery"}');

    subject.state.recordSolutionReady(subject.engagement.engagementId, {
      sourceId: 'urn:jinn:source:solver-records',
      artifacts: [
        { role: 'output', family: 'task-output', name: 'prediction', digest: documentDigest(output), bytes: output },
        { role: 'evidence', family: 'execution-evidence', digest: documentDigest(evidence), bytes: evidence },
        { role: 'delivery', family: 'delivery', digest: documentDigest(delivery), bytes: delivery },
        { role: 'delivery-envelope', family: 'delivery-envelope', digest: documentDigest(envelope), bytes: envelope },
      ],
    });

    expect(subject.state.getEngagement(subject.engagement.engagementId)).toMatchObject({ state: 'solution-ready' });
    expect(subject.state.listSolutionArtifacts(subject.engagement.engagementId)).toHaveLength(4);
    const pending = subject.state.listPendingPublications();
    expect(pending).toHaveLength(4);
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'urn:jinn:source:solver-records', role: 'delivery', recordDigest: documentDigest(delivery) }),
      expect.objectContaining({ role: 'evidence', recordDigest: documentDigest(evidence) }),
    ]));
    for (const publication of pending) {
      subject.state.recordPublicationPublished(publication.publicationKey, {
        location: `https://operator.example/records/${publication.recordDigest.slice('sha256:'.length)}`,
        sequence: '0000000000000001',
        entryDigest: `sha256:${'5'.repeat(64)}`,
      });
    }
    expect(subject.state.getEngagement(subject.engagement.engagementId)).toMatchObject({ state: 'solution-published' });

    const settlement = subject.state.beginSolutionSettlement(subject.engagement.engagementId);
    expect(settlement).toEqual({
      kind: 'created',
      operationId: solutionSettlementId({
        attempt: subject.engagement.attemptUri!,
        deliveryDigest: documentDigest(delivery),
      }),
    });
    expect(subject.state.getEngagement(subject.engagement.engagementId)).toMatchObject({
      state: 'solution-settlement-pending',
    });
    expect(subject.state.getOperation(settlement.operationId)).toMatchObject({
      kind: 'solution-settlement',
      status: 'intent',
    });
  });

  it('refuses an artifact whose advertised digest does not name its exact bytes', () => {
    const subject = finalizedClaim();
    const execution = subject.state.beginSolutionExecution(subject.engagement.engagementId, {
      taskBytes,
      submissionBytes,
      dispatchContextBytes: subject.dispatchContextBytes,
    });
    subject.state.recordBackendSubmissionAccepted(execution.operationId);
    expect(() => subject.state.recordSolutionReady(subject.engagement.engagementId, {
      sourceId: 'urn:jinn:source:solver-records',
      artifacts: [{
        role: 'delivery',
        family: 'delivery',
        digest: `sha256:${'f'.repeat(64)}`,
        bytes: new TextEncoder().encode('different bytes'),
      }],
    })).toThrow(NativeOperatorStateConflictError);
    expect(subject.state.listPendingPublications()).toEqual([]);
    expect(subject.state.listSolutionArtifacts(subject.engagement.engagementId)).toEqual([]);
  });

  it('keeps the deterministic Attempt from the finalized claim', () => {
    const subject = finalizedClaim();
    expect(subject.engagement.attemptUri).toBe(deriveMarketplaceAttemptUri({
      chainId: CHAIN.chainId,
      coordinator: CHAIN.coordinator,
      taskId: CHAIN.taskId,
      attemptIndex: 2,
    }));
    expect(subject.engagement.engagementId).toBe(engagementId(CHAIN));
  });
});
