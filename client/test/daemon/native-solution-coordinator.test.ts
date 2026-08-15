import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { archivePagePath } from '@jinn-network/record-discovery-protocol';
import { Store } from '../../src/store/store.js';
import { NativeOperatorStateRepository, NativeWorkerLeaseError } from '../../src/daemon/native-operator-state.js';
import {
  NativeSolutionCoordinator,
  type NativeSolutionSettlementCanonicalFact,
  type NativeSolutionSettlementPort,
  type NativeSolutionVerificationPort,
} from '../../src/daemon/native-solution-coordinator.js';
import { openNativeSolutionPublisher } from '../../src/daemon/native-solution-publisher.js';

const COORDINATOR = '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98';
const SUBMISSION = 'urn:uuid:33333333-3333-4333-8333-333333333333' as const;
const REQUESTER = 'urn:uuid:44444444-4444-4444-8444-444444444444';
const outputBytes = new TextEncoder().encode('{"probability":0.62}');
const evidenceBytes = serializeCanonicalJson({
  '@context': 'https://spec.jinn.network/evidence/context/v1',
  '@graph': [{
    '@id': 'urn:uuid:55555555-5555-4555-8555-555555555555',
    '@type': 'https://spec.jinn.network/evidence/Execution',
  }],
});
const envelopeBytes = new TextEncoder().encode('{"payloadType":"application/vnd.jinn.marketplace.executor-binding.v1+json"}');

function exactDocuments() {
  const taskBytes = sealTask({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    profile: {
      uri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0',
      digest: { sha256: '1'.repeat(64) },
    },
    instructions: 'Return a deterministic prediction.',
    outputs: [{ name: 'prediction', mediaType: 'application/json', required: true }],
  });
  const submissionBytes = sealSubmission({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    submission: SUBMISSION,
    task: { digest: { sha256: documentDigest(taskBytes).slice('sha256:'.length) } },
    requester: REQUESTER,
    idempotencyKey: 'native-solution-coordinator-test',
    nonce: 'native-solution-nonce',
    deadline: '2099-01-01T00:00:00Z',
  });
  return { taskBytes, submissionBytes };
}

function finalizedClaim(now: () => Date = () => new Date('2026-08-02T00:00:00Z')) {
  const store = new Store(':memory:');
  store.db.prepare(
    `INSERT INTO native_discovery_cards
       (id, source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
     VALUES (1, 'urn:jinn:requester:one', 'native-requester', '0000000000000001', ?,
       'announcement-1', '{}', '2026-08-02T00:00:00.000Z')`,
  ).run(`sha256:${'2'.repeat(64)}`);
  const state = new NativeOperatorStateRepository(store, {
    now,
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
  readonly verification?:
    | Awaited<ReturnType<NativeSolutionVerificationPort['verify']>>
    | (() => Awaited<ReturnType<NativeSolutionVerificationPort['verify']>>);
  readonly settlementFacts?: readonly NativeSolutionSettlementCanonicalFact[];
  readonly evidenceFailure?: () => Error | undefined;
  readonly deliverySignatureFailure?: () => Error | undefined;
  readonly publicationFailure?: () => Error | undefined;
  readonly settlementFailure?: () => Error | undefined;
  readonly outputs?: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
  readonly publisher?: ConstructorParameters<typeof NativeSolutionCoordinator>[0]['publisher'];
} = {}) {
  let nowMs = Date.parse('2026-08-02T00:00:00Z');
  const now = () => new Date(nowMs);
  const subject = finalizedClaim(now);
  const engagement = subject.state.getEngagement(subject.engagementId)!;
  const outputs = input.outputs ?? [{ name: 'prediction', bytes: outputBytes }];
  const outputByDigest = new Map(
    outputs.map(({ bytes }) => [documentDigest(bytes), bytes] as const),
  );
  const deliveryBytes = sealDelivery({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    attempt: engagement.attemptUri!,
    task: documentDigest(subject.documents.taskBytes),
    outputs: outputs.map(({ name, bytes }) => ({
      name,
      mediaType: 'application/json',
      digest: { sha256: documentDigest(bytes).slice('sha256:'.length) },
    })),
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
        protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
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
    fetchArtifact: vi.fn(async (descriptor: { digest?: { sha256?: string } }) => {
      const bytes = outputByDigest.get(`sha256:${descriptor.digest?.sha256 ?? ''}`);
      if (bytes === undefined) throw new Error('unexpected output descriptor');
      return bytes;
    }),
  };
  const verify = vi.fn(async () =>
    (typeof input.verification === 'function' ? input.verification() : input.verification) ?? ({ ok: true as const }));
  const publish = vi.fn(async ({ publication }: Parameters<NonNullable<ConstructorParameters<typeof NativeSolutionCoordinator>[0]['publisher']['publish']>>[0]) => {
    const failure = input.publicationFailure?.();
    if (failure !== undefined) throw failure;
    return {
      location: `https://operator.example/records/${publication.recordDigest.slice('sha256:'.length)}`,
      sequence: '0000000000000001',
      entryDigest: `sha256:${'6'.repeat(64)}` as const,
    };
  });
  let settlementBroadcast = false;
  let settlementFactIndex = 0;
  const settlement = {
    broadcast: vi.fn(async () => {
      const failure = input.settlementFailure?.();
      if (failure !== undefined) throw failure;
      settlementBroadcast = true;
      return { txHash: `0x${'7'.repeat(64)}` as const };
    }),
    readCanonical: vi.fn(async (_request: Parameters<NativeSolutionSettlementPort['readCanonical']>[0]) => {
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
    deliverySignature: {
      get: () => {
        const failure = input.deliverySignatureFailure?.();
        if (failure !== undefined) throw failure;
        return envelopeBytes;
      },
    },
    evidence: {
      awaitIndexed: async (reference) => ({ status: 'indexed' as const, reference }),
      getRecord: async () => {
        const failure = input.evidenceFailure?.();
        if (failure !== undefined) throw failure;
        return input.evidenceBytes === undefined ? evidenceBytes : input.evidenceBytes;
      },
    },
    verification: { verify },
    publisher: input.publisher ?? { sourceId: 'urn:jinn:source:solver-records', publish },
    settlement,
    retry: {
      now,
      delayMs: 1_000,
      maxAttempts: 3,
      deadline: () => '2026-08-03T00:00:00.000Z',
    },
  });
  return {
    ...subject,
    coordinator,
    backend,
    submit,
    verify,
    publish,
    settlement,
    deliveryBytes,
    advanceRetry: () => { nowMs += 1_001; },
  };
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

  // #2561 sibling, solver-side: the settlement reconcile re-fetches the delivery payload to bind
  // the on-chain settlement to the exact public Delivery. Native records are HTTP-served and never
  // IPFS-pinned, so the coordinator must hand the settlement reader the solver's OWN published
  // delivery record location (from the publication outbox) — otherwise the reader falls to the
  // IPFS-only plane, throws, and the engagement wedges in `solution-settlement-pending`, holding
  // the operator's concurrency slot forever.
  it('hands the settlement reader the solver-published delivery record HTTP location', async () => {
    const subject = setup();

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toMatchObject({ kind: 'solution-settled' });

    const deliveryDigest = documentDigest(subject.deliveryBytes);
    const expectedLocation = `https://operator.example/records/${deliveryDigest.slice('sha256:'.length)}`;
    expect(subject.settlement.readCanonical).toHaveBeenCalled();
    for (const [request] of subject.settlement.readCanonical.mock.calls) {
      expect(request.deliveryPublicLocations).toContain(expectedLocation);
    }
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

  // #30 Part B1: a hung/unpinned IPFS eval-spec fetch (now bounded by Part A) makes the fail-closed
  // self-verify report `evaluation-spec-unavailable`. That is an AVAILABILITY failure, not a proof
  // of invalidity, so it must PAUSE and retry — not terminally kill an on-chain-claimed engagement.
  // Contrast `delivery-binding-revoked` above, which is genuine invalidity and stays terminal.
  // Mutation check: make line-391 unconditionally non-retryable again and the first assertion
  // reddens to `{ kind: 'failed', reason: 'evaluation-spec-unavailable' }`.
  it('pauses and resumes on a transient evaluation-spec-unavailable self-verify outage', async () => {
    let unavailable = true;
    const subject = setup({
      verification: () => (unavailable
        ? { ok: false as const, reason: 'evaluation-spec-unavailable' }
        : { ok: true as const }),
    });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toMatchObject({ kind: 'paused' });
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'paused' });
    expect(subject.publish).not.toHaveBeenCalled();

    unavailable = false;
    subject.advanceRetry();
    await expect(subject.coordinator.reconcileStartup())
      .resolves.toEqual([expect.objectContaining({ kind: 'solution-settled' })]);
  });

  // #30 Part B2: a NativeWorkerLeaseError raised by a drive-path operation is a LOCAL coordination
  // loss (the single-writer lease lapsed while a bounded-but-non-trivial op ran), never a solution
  // failure. It must be RETRYABLE — re-driven once the lease is held again — not converted to a
  // terminal `failed` engagement. Injected through the unwrapped delivery-signature lookup, the one
  // synchronous drive-path access that is not already funneled through the retryable `dependency()`
  // wrapper. Mutation check: drop the `NativeWorkerLeaseError` arm from the catch and the first
  // assertion reddens to `{ kind: 'failed', reason: 'solution-internal-failed' }`.
  it('treats a mid-solve worker-lease loss as retryable, not a terminal engagement failure', async () => {
    let leaseLost = true;
    const subject = setup({
      deliverySignatureFailure: () => (leaseLost
        ? new NativeWorkerLeaseError('native worker lease is expired or not owned by this worker')
        : undefined),
    });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toMatchObject({ kind: 'paused' });
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'paused' });
    expect(subject.publish).not.toHaveBeenCalled();

    leaseLost = false;
    subject.advanceRetry();
    await expect(subject.coordinator.reconcileStartup())
      .resolves.toEqual([expect.objectContaining({ kind: 'solution-settled' })]);
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

  // #2623: the settlement operation's `detail_json` is its IDENTITY — `{attempt, deliveryDigest}`,
  // written at intent and read by the settlement reader to bind the settlement to the exact public
  // Delivery. An orphan notice must ANNOTATE it, never replace it.
  it('annotates the settlement identity when an orphan notice lands', async () => {
    const txHash = `0x${'7'.repeat(64)}` as const;
    const subject = setup({
      settlementFacts: [
        { kind: 'absent', checkedAtBlock: 119n },
        { kind: 'orphaned', txHash, reason: 'projector-reorg-correction' },
      ],
    });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toEqual({ kind: 'solution-published' });

    const operation = subject.state.listOperations(subject.engagementId)
      .find(({ kind }) => kind === 'solution-settlement')!;
    expect(operation.status).toBe('orphaned');
    expect(operation.detail).toEqual({
      attempt: subject.state.getEngagement(subject.engagementId)!.attemptUri,
      deliveryDigest: documentDigest(subject.deliveryBytes),
      kind: 'orphaned',
      txHash,
      reason: 'projector-reorg-correction',
    });
  });

  // Round 26 (CP6 live gate, Base Sepolia), operator B, task 1234. An older build's orphan notice
  // overwrote the settlement operation's detail with `{kind, txHash, reason}`, and the reopen
  // restored only `status` / `tx_hash` / `block_*` — so every subsequent poll read an operation with
  // no exact Delivery digest, orphaned it again, and rolled the engagement back to
  // `solution-published`: 48 orphan events at the ~33s cadence, no deadline, no attempt ceiling, one
  // permanently occupied `maxConcurrent: 1` slot. The row seeded below is that operator's exact
  // on-disk shape. Recovery must not require hand-editing a database: the reopen re-derives the
  // identity from durable state no orphan notice can reach (`native_engagements.attempt_uri` plus
  // the `delivery` row in `native_solution_artifacts`) and the engagement reaches terminal
  // `solution-settled`, freeing the slot.
  it('recovers a settlement whose operation detail an older build already destroyed', async () => {
    const liveTxHash = '0xc5d458e15d4deaae121500b0689bdd2d8084193c4383350fdf5a94dcbb432474' as const;
    const liveBlockHash = `0x${'ab'.repeat(32)}` as const;
    const liveBlockNumber = 45_401_836n;
    const liveReason = 'solution operation has no exact Delivery digest';
    const subject = setup({
      settlementFacts: [
        { kind: 'absent', checkedAtBlock: 119n },
        { kind: 'orphaned', txHash: `0x${'7'.repeat(64)}`, reason: liveReason },
      ],
    });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toEqual({ kind: 'solution-published' });
    const operation = subject.state.listOperations(subject.engagementId)
      .find(({ kind }) => kind === 'solution-settlement')!;

    // Replay the poisoned write an older build persisted, field for field.
    subject.store.db.prepare(
      `UPDATE native_operations SET status = 'orphaned', tx_hash = ?, block_hash = NULL,
         block_number = NULL, detail_json = ? WHERE operation_id = ?`,
    ).run(
      liveTxHash,
      JSON.stringify({ kind: 'orphaned', txHash: liveTxHash, reason: liveReason }),
      operation.operationId,
    );
    expect(subject.state.getOperation(operation.operationId)).toMatchObject({
      status: 'orphaned',
      blockNumber: null,
      detail: { kind: 'orphaned', txHash: liveTxHash, reason: liveReason },
    });
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'solution-published' });

    // The settlement reader as it now stands: a local row carrying no exact Delivery digest is
    // unreadable and RAISES; it is never reported as `orphaned`.
    const digestsRead: Array<string | undefined> = [];
    subject.settlement.readCanonical.mockImplementation(async ({ operation: row }) => {
      const digest = (row.detail as { readonly deliveryDigest?: unknown }).deliveryDigest;
      digestsRead.push(typeof digest === 'string' ? digest : undefined);
      if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
        throw new Error(`solution settlement operation ${row.operationId} carries no exact Delivery digest`);
      }
      return {
        kind: 'finalized' as const,
        txHash: liveTxHash,
        blockHash: liveBlockHash,
        blockNumber: liveBlockNumber,
      };
    });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toMatchObject({ kind: 'solution-settled', operationId: operation.operationId });

    // One read, off the re-derived identity — no orphan, no re-broadcast, no second operation.
    expect(digestsRead).toEqual([documentDigest(subject.deliveryBytes)]);
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'solution-settled' });
    expect(subject.state.getOperation(operation.operationId)).toMatchObject({
      status: 'finalized',
      txHash: liveTxHash,
      blockNumber: liveBlockNumber,
    });
    expect(subject.state.listOperations(subject.engagementId)
      .filter(({ kind }) => kind === 'solution-settlement')).toHaveLength(1);
  });

  it.each(['evidence', 'publication', 'settlement'] as const)(
    'durably pauses and resumes a retryable %s outage without duplicating logical operations',
    async (dependency) => {
      let unavailable = true;
      const failure = () => unavailable ? new Error(`${dependency} temporarily unavailable`) : undefined;
      const subject = setup({
        ...(dependency === 'evidence' ? { evidenceFailure: failure } : {}),
        ...(dependency === 'publication' ? { publicationFailure: failure } : {}),
        ...(dependency === 'settlement' ? { settlementFailure: failure } : {}),
      });

      await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
        .resolves.toMatchObject({ kind: 'paused', reason: 'solution-dependency-failed' });
      expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'paused' });
      unavailable = false;
      subject.advanceRetry();
      await expect(subject.coordinator.reconcileStartup())
        .resolves.toEqual([expect.objectContaining({ kind: 'solution-settled' })]);

      expect(subject.state.listOperations(subject.engagementId).filter(({ kind }) => kind === 'backend-submit')).toHaveLength(1);
      expect(subject.state.listOperations(subject.engagementId).filter(({ kind }) => kind === 'solution-settlement')).toHaveLength(1);
      expect(subject.settlement.broadcast).toHaveBeenCalledTimes(dependency === 'settlement' ? 2 : 1);
      if (dependency === 'settlement') {
        expect(subject.settlement.readCanonical.mock.invocationCallOrder.some(
          (order) => order < subject.settlement.broadcast.mock.invocationCallOrder[1]!,
        )).toBe(true);
      }
    },
  );

  it('fails terminal after the durable solution retry budget is exhausted', async () => {
    const subject = setup({ evidenceFailure: () => new Error('evidence offline') });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
        .resolves.toMatchObject({ kind: 'paused' });
      subject.advanceRetry();
    }
    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toEqual({ kind: 'failed', reason: 'solution-retry-exhausted' });
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'failed' });
    expect(subject.publish).not.toHaveBeenCalled();
    expect(subject.settlement.broadcast).not.toHaveBeenCalled();
  });

  it('fails stop on a canonical settlement contradiction instead of scheduling a retry', async () => {
    const subject = setup({
      settlementFacts: [
        { kind: 'absent', checkedAtBlock: 119n },
        {
          kind: 'finalized',
          txHash: `0x${'9'.repeat(64)}`,
          blockHash: `0x${'8'.repeat(64)}`,
          blockNumber: 120n,
        },
      ],
    });
    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toEqual({ kind: 'failed', reason: 'solution-internal-failed' });
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'failed' });
    expect(subject.store.db.prepare(
      'SELECT COUNT(*) AS count FROM native_solution_retries WHERE engagement_id = ?',
    ).get(subject.engagementId)).toEqual({ count: 0 });
  });
});

function subjectDeliverySentinel(): Uint8Array {
  return new TextEncoder().encode('{"this":"is not the referenced evidence"}');
}

// A five-record solution (2 outputs + evidence + Delivery + Delivery envelope) published into ONE
// append-only signed source: the source-writer's head must strictly advance per announcement, so
// the coordinator must give distinct records distinct, strictly-increasing announcement timestamps.
// Regression for the CP5 delivery blocker where every record inherited the same outbox createdAt
// and records 2+ were rejected with SourceWriterIntegrityError (integration/evidence-v1 round 12).
describe('NativeSolutionCoordinator multi-record publication (CP5 delivery)', () => {
  const secondOutputBytes = new TextEncoder().encode('{"probability":0.31}');
  const fiveRecordOutputs = [
    { name: 'prediction', bytes: outputBytes },
    { name: 'prediction-alt', bytes: secondOutputBytes },
  ];
  const roots: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  function realSigner() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      keyId: 'did:key:z6MkRealSolverDiscovery',
      sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, privateKey)),
      verify: (payload: Uint8Array, signature: Uint8Array) => cryptoVerify(null, payload, publicKey, signature),
    };
  }

  async function realPublisher() {
    const rootDir = await mkdtemp(join(tmpdir(), 'jinn-solution-cp5-'));
    roots.push(rootDir);
    const publisher = await openNativeSolutionPublisher({
      rootDir,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: realSigner(),
      settlementDeclarationKey: 'did:key:z6MkSolverSettlement',
    });
    closers.push(() => publisher.close());
    return publisher;
  }

  async function announcementTimestamps(publisher: Awaited<ReturnType<typeof realPublisher>>, count: number): Promise<string[]> {
    const timestamps: string[] = [];
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const page = String(sequence).padStart(16, '0');
      const response = await publisher.handler(new Request(
        `https://operator.example/native${archivePagePath('solver-records', page)}`,
      ));
      expect(response.status).toBe(200);
      const parsed = JSON.parse(await response.text()) as { entries: Array<{ entry: { timestamp: string } }> };
      timestamps.push(parsed.entries[0]!.entry.timestamp);
    }
    return timestamps;
  }

  it('publishes all five records with strictly-advancing announcement timestamps', async () => {
    const publisher = await realPublisher();
    const subject = setup({ outputs: fiveRecordOutputs, publisher });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toMatchObject({ kind: 'solution-settled' });
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'solution-settled' });

    // Every record committed to the one signed source: the head reached sequence five, which the
    // source-writer would have refused had any two announcements shared a timestamp.
    const timestamps = await announcementTimestamps(publisher, 5);
    expect(timestamps).toHaveLength(5);
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(Date.parse(timestamps[index]!)).toBeGreaterThan(Date.parse(timestamps[index - 1]!));
    }
  });

  it('resumes a partially-published solution past the already-advanced head (task 1223)', async () => {
    // Reproduce the wedged durable state: the first record already advanced the signed head on a
    // failed attempt, the remaining records are still `intent`, and the engagement is paused. A
    // one-record-then-fault publisher wrapper drives the coordinator into exactly that state.
    const publisher = await realPublisher();
    let published = 0;
    let faulting = true;
    const faultingPublisher = {
      sourceId: publisher.sourceId,
      publish: async (value: Parameters<typeof publisher.publish>[0]) => {
        if (faulting && published >= 1) throw new Error('publisher briefly unavailable');
        published += 1;
        return publisher.publish(value);
      },
    };
    const subject = setup({ outputs: fiveRecordOutputs, publisher: faultingPublisher });

    await expect(subject.coordinator.reconcileEngagement(subject.engagementId))
      .resolves.toMatchObject({ kind: 'paused', reason: 'solution-dependency-failed' });
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'paused' });
    // One record committed; head is now at that first announcement's timestamp.
    const [headTimestamp] = await announcementTimestamps(publisher, 1);
    const pendingBefore = subject.state.listPendingPublications()
      .filter((row) => row.engagementId === subject.engagementId);
    expect(pendingBefore).toHaveLength(4);
    // Every still-pending record carries the SAME outbox createdAt as the published one — the exact
    // condition that made naive re-publishing collide with the advanced head forever.
    expect(new Set(pendingBefore.map((row) => row.createdAt)).size).toBe(1);
    expect(pendingBefore[0]!.createdAt).toBe(headTimestamp);

    // Retry with the source healthy: the remaining four records must advance strictly past the head.
    faulting = false;
    subject.advanceRetry();
    await expect(subject.coordinator.reconcileStartup())
      .resolves.toEqual([expect.objectContaining({ kind: 'solution-settled' })]);
    expect(subject.state.getEngagement(subject.engagementId)).toMatchObject({ state: 'solution-settled' });

    const timestamps = await announcementTimestamps(publisher, 5);
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(Date.parse(timestamps[index]!)).toBeGreaterThan(Date.parse(timestamps[index - 1]!));
    }
    // No duplicate settlement, and exactly five distinct records reached the source.
    expect(subject.state.listOperations(subject.engagementId)
      .filter(({ kind }) => kind === 'solution-settlement')).toHaveLength(1);
  });
});
