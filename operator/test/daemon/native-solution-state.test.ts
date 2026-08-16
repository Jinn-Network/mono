import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveMarketplaceAttemptUri } from '@jinn-network/marketplace-binding';
import {
  DELIVERY_MEDIA_TYPE,
  documentDigest,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import { EXECUTION_EVIDENCE_MEDIA_TYPE } from '@jinn-network/evidence-protocol';
import { DSSE_ENVELOPE_MEDIA_TYPE } from '@jinn-network/trust-core';
import { Store } from '../../src/store/store.js';
import {
  NATIVE_OPERATOR_STATE_SCHEMA_VERSION,
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

function finalizedClaim(dbPath = ':memory:') {
  const store = new Store(dbPath);
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
  it.each([1, 2, 3, 4])('opens a real on-disk v%s database additively and leaves claim rows intact', async (version) => {
    const root = await mkdtemp(join(tmpdir(), `jinn-native-state-v${version}-`));
    const dbPath = join(root, 'operator.sqlite');
    let openStore: Store | undefined;
    try {
      const subject = finalizedClaim(dbPath);
      const engagementId = subject.engagement.engagementId;
      const attemptUri = subject.engagement.attemptUri;
      if (version === 1) subject.store.db.exec(`
          DROP TABLE native_solution_retries;
          DROP TABLE native_solution_artifacts;
          DROP TABLE native_solution_executions;
        `);
      else subject.store.db.exec('DROP TABLE native_solution_retries;');
      if (version === 4) subject.store.db.exec('ALTER TABLE native_solution_artifacts DROP COLUMN media_type;');
      subject.store.db.prepare(
        'UPDATE native_operator_state_metadata SET schema_version = ? WHERE singleton = 1',
      ).run(version);
      subject.store.close();

      openStore = new Store(dbPath);
      const reopened = new NativeOperatorStateRepository(openStore);

      expect(reopened.schemaVersion()).toBe(NATIVE_OPERATOR_STATE_SCHEMA_VERSION);
      expect(reopened.getEngagement(engagementId)).toMatchObject({
        state: 'claim-finalized',
        attemptUri,
      });
      const tables = openStore.db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'native_solution_%' ORDER BY name`,
      ).all() as Array<{ name: string }>;
      expect(tables.map(({ name }) => name)).toEqual([
        'native_solution_artifacts',
        // One-swap M3 (#2461): moved into NATIVE_OPERATOR_STATE_SCHEMA from an inline exec in
        // `native-solver-production.ts`, so the fleet daemon's shared Store carries it too. It is
        // additive — an existing v1..v5 database gains the table on reopen and no schema-version
        // bump is required (the whole schema is `CREATE TABLE IF NOT EXISTS`).
        'native_solution_discovery_corrections',
        'native_solution_executions',
        'native_solution_retries',
      ]);
    } finally {
      openStore?.close();
      await rm(root, { recursive: true, force: true });
    }
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
        { role: 'output', family: 'task-output', mediaType: 'application/json', name: 'prediction', digest: documentDigest(output), bytes: output },
        { role: 'evidence', family: 'execution-evidence', mediaType: EXECUTION_EVIDENCE_MEDIA_TYPE, digest: documentDigest(evidence), bytes: evidence },
        { role: 'delivery', family: 'delivery', mediaType: DELIVERY_MEDIA_TYPE, digest: documentDigest(delivery), bytes: delivery },
        { role: 'delivery-envelope', family: 'delivery-envelope', mediaType: DSSE_ENVELOPE_MEDIA_TYPE, digest: documentDigest(envelope), bytes: envelope },
      ],
    });

    expect(subject.state.getEngagement(subject.engagement.engagementId)).toMatchObject({ state: 'solution-ready' });
    expect(subject.state.listSolutionArtifacts(subject.engagement.engagementId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'delivery', family: 'delivery', mediaType: DELIVERY_MEDIA_TYPE }),
      expect.objectContaining({ role: 'evidence', family: 'execution-evidence', mediaType: EXECUTION_EVIDENCE_MEDIA_TYPE }),
    ]));
    const pending = subject.state.listPendingPublications();
    expect(pending).toHaveLength(4);
    // The externally advertised Delivery is the signed high-water for evaluator admission;
    // every exact referenced artifact and the executor envelope must precede it.
    expect(pending.map(({ role }) => role)).toEqual([
      'output', 'evidence', 'delivery-envelope', 'delivery',
    ]);
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

  // A finalized claim for a distinct task in an ALREADY-open store/state, so two engagements can
  // coexist in one operator database — the shape a real operator hits when the gate's deterministic
  // golden makes a second task's solution byte-identical to a settled one.
  function finalizeClaimFor(
    store: Store,
    state: NativeOperatorStateRepository,
    opts: { taskId: bigint; cardId: number; sequence: string; announcementId: string; attemptIndex: number },
  ) {
    const entryDigest = `sha256:${String(opts.cardId).padStart(64, '0')}` as const;
    store.db.prepare(
      `INSERT INTO native_discovery_cards
         (id, source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
    ).run(
      opts.cardId, SOURCE.agent, SOURCE.name, opts.sequence, entryDigest, opts.announcementId,
      '2026-08-02T00:00:00.000Z',
    );
    const submissionUri = `urn:uuid:${String(opts.cardId).padStart(8, '0')}-3333-4333-8333-333333333333` as const;
    const admitted = state.recordDecision({
      ...CHAIN,
      taskId: opts.taskId,
      taskDigest,
      submissionUri,
      submissionDigest,
      source: { ...SOURCE, cardId: opts.cardId, sequence: opts.sequence, entryDigest, announcementId: opts.announcementId },
      decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
    });
    if (admitted.kind !== 'admitted') throw new Error('expected admission');
    const claimTx = `0x${String(opts.cardId).padStart(64, '0')}` as const;
    state.recordClaimBroadcast(admitted.claimOperationId, claimTx);
    state.recordClaimFinalized(admitted.claimOperationId, {
      txHash: claimTx,
      blockHash: `0x${String(opts.cardId + 100).padStart(64, '0')}`,
      blockNumber: BigInt(100 + opts.cardId),
      attemptIndex: opts.attemptIndex,
      requestId: `0x${String(opts.cardId + 200).padStart(64, '0')}`,
    });
    return state.getEngagement(admitted.engagementId)!;
  }

  // Deterministic-golden solution content: byte-identical across tasks, so both engagements name
  // the SAME content-addressed records.
  const goldenOutput = new TextEncoder().encode('{"probability":0.62}');
  const goldenEvidence = new TextEncoder().encode('{"protocol":"execution-evidence"}');
  const goldenDelivery = new TextEncoder().encode('{"protocol":"delivery"}');
  const goldenEnvelope = new TextEncoder().encode('{"payloadType":"delivery"}');
  const GOLDEN_SOURCE_ID = 'urn:jinn:source:solver-records';
  function goldenArtifacts() {
    return [
      { role: 'output' as const, family: 'task-output', mediaType: 'application/json', name: 'prediction', digest: documentDigest(goldenOutput), bytes: goldenOutput },
      { role: 'evidence' as const, family: 'execution-evidence', mediaType: EXECUTION_EVIDENCE_MEDIA_TYPE, digest: documentDigest(goldenEvidence), bytes: goldenEvidence },
      { role: 'delivery' as const, family: 'delivery', mediaType: DELIVERY_MEDIA_TYPE, digest: documentDigest(goldenDelivery), bytes: goldenDelivery },
      { role: 'delivery-envelope' as const, family: 'delivery-envelope', mediaType: DSSE_ENVELOPE_MEDIA_TYPE, digest: documentDigest(goldenEnvelope), bytes: goldenEnvelope },
    ];
  }
  function dispatchFor(engagement: { submissionUri: string | null; attemptUri: string | null }) {
    return serializeCanonicalJson({
      taskDigest,
      submission: engagement.submissionUri,
      nonce: 'native-nonce',
      attempt: engagement.attemptUri,
    });
  }
  function readyAndPublish(state: NativeOperatorStateRepository, engagement: { engagementId: NativeOperationId; submissionUri: string | null; attemptUri: string | null }) {
    const execution = state.beginSolutionExecution(engagement.engagementId, {
      taskBytes, submissionBytes, dispatchContextBytes: dispatchFor(engagement),
    });
    state.recordBackendSubmissionAccepted(execution.operationId);
    state.recordSolutionReady(engagement.engagementId, { sourceId: GOLDEN_SOURCE_ID, artifacts: goldenArtifacts() });
    for (const publication of state.listPendingPublications().filter((p) => p.engagementId === engagement.engagementId)) {
      state.recordPublicationPublished(publication.publicationKey, {
        location: `https://operator.example/records/${publication.recordDigest.slice('sha256:'.length)}`,
        sequence: '0000000000000001',
        entryDigest: `sha256:${'5'.repeat(64)}`,
      });
    }
  }

  it('reuses already-published content-addressed records when a second task has byte-identical golden content', () => {
    const first = finalizedClaim();
    // First engagement solves, publishes its 4 records — the serving plane now holds them.
    readyAndPublish(first.state, first.engagement);
    expect(first.state.getEngagement(first.engagement.engagementId)).toMatchObject({ state: 'solution-published' });

    // Second engagement: a DISTINCT task whose deterministic-golden solution is byte-identical.
    const second = finalizeClaimFor(first.store, first.state, {
      taskId: 8n, cardId: 2, sequence: '0000000000000002', announcementId: 'announcement-2', attemptIndex: 3,
    });
    const secondId = second.engagementId;
    const execution = first.state.beginSolutionExecution(secondId, {
      taskBytes, submissionBytes, dispatchContextBytes: dispatchFor(second),
    });
    first.state.recordBackendSubmissionAccepted(execution.operationId);

    // Before the fix this threw `UNIQUE constraint failed: native_publication_outbox...`, rolling
    // back the whole transaction and leaving zero artifact rows → terminal failure.
    expect(() => first.state.recordSolutionReady(secondId, {
      sourceId: GOLDEN_SOURCE_ID,
      artifacts: goldenArtifacts(),
    })).not.toThrow();

    // The second engagement stores its OWN exact artifact bytes (per-engagement) ...
    expect(first.state.listSolutionArtifacts(secondId)).toHaveLength(4);
    // ... but owns no NEW pending publications — the shared records are already served.
    expect(first.state.listPendingPublications().filter((p) => p.engagementId === secondId)).toEqual([]);
    expect(first.state.getEngagement(secondId)).toMatchObject({ state: 'solution-ready' });

    // Downstream deliver leg PROCEEDS: the engagement promotes to solution-published by reusing the
    // shared served records, and resolves its Delivery to the already-advertised public location.
    expect(first.state.promoteSolutionPublishedIfComplete(secondId)).toBe(true);
    expect(first.state.getEngagement(secondId)).toMatchObject({ state: 'solution-published' });

    const publications = first.state.listSolutionPublications(secondId);
    expect(publications).toHaveLength(4);
    expect(publications.every((p) => p.status === 'published')).toBe(true);
    const deliveryLocation = publications.find((p) => p.role === 'delivery')?.detail as { location?: string } | null;
    expect(deliveryLocation?.location).toBe(
      `https://operator.example/records/${documentDigest(goldenDelivery).slice('sha256:'.length)}`,
    );

    // On-chain deliver is per-(attempt) — the shared delivery digest settles under the SECOND
    // engagement's distinct Attempt, so it is a genuinely separate settlement, not a collision.
    const settlement = first.state.beginSolutionSettlement(secondId);
    expect(settlement).toEqual({
      kind: 'created',
      operationId: solutionSettlementId({
        attempt: second.attemptUri!,
        deliveryDigest: documentDigest(goldenDelivery),
      }),
    });
    expect(second.attemptUri).not.toBe(first.engagement.attemptUri);
    expect(first.state.getEngagement(secondId)).toMatchObject({ state: 'solution-settlement-pending' });
    first.store.close();
  });

  it('does not promote or dedupe a second engagement whose content genuinely differs (fail-closed)', () => {
    const first = finalizedClaim();
    readyAndPublish(first.state, first.engagement);

    const second = finalizeClaimFor(first.store, first.state, {
      taskId: 8n, cardId: 2, sequence: '0000000000000002', announcementId: 'announcement-2', attemptIndex: 3,
    });
    const secondId = second.engagementId;
    const execution = first.state.beginSolutionExecution(secondId, {
      taskBytes, submissionBytes, dispatchContextBytes: dispatchFor(second),
    });
    first.state.recordBackendSubmissionAccepted(execution.operationId);

    // Same three records, but a DIFFERENT delivery payload → a different content key.
    const differentDelivery = new TextEncoder().encode('{"protocol":"delivery","v":2}');
    first.state.recordSolutionReady(secondId, {
      sourceId: GOLDEN_SOURCE_ID,
      artifacts: [
        ...goldenArtifacts().filter((a) => a.role !== 'delivery'),
        { role: 'delivery', family: 'delivery', mediaType: DELIVERY_MEDIA_TYPE, digest: documentDigest(differentDelivery), bytes: differentDelivery },
      ],
    });

    // The genuinely-new delivery record is NOT masked — it is inserted as its own pending intent
    // that this engagement still owns and must publish. Promotion refuses while it is unpublished.
    const pending = first.state.listPendingPublications().filter((p) => p.engagementId === secondId);
    expect(pending.map((p) => p.role)).toEqual(['delivery']);
    expect(pending[0]!.recordDigest).toBe(documentDigest(differentDelivery));
    expect(first.state.promoteSolutionPublishedIfComplete(secondId)).toBe(false);
    expect(first.state.getEngagement(secondId)).toMatchObject({ state: 'solution-ready' });
    first.store.close();
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
        mediaType: DELIVERY_MEDIA_TYPE,
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
