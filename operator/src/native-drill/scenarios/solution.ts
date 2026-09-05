// operator/src/native-drill/scenarios/solution.ts
/**
 * Checkpoints `backend-submit`, `evidence`, and `solution-settlement` (#2434).
 *
 * All three drill the solver's solution path, so they share one seeding and one coordinator
 * wiring and differ only in where the process is killed:
 *
 * - `backend-submit` — the execution backend has durably accepted the submission and the process
 *   dies before learning that. Proof: `backend.recover` reports matching; no second Attempt.
 * - `evidence` — the Delivery and its evidence are sealed and publication is incomplete. Proof:
 *   every `Delivery.evidenceRecords` digest still resolves, publication resumes once, and the
 *   Delivery bytes do not change.
 * - `solution-settlement` — the settlement transaction is on the node and the process dies before
 *   reconciling it. Proof: receipt and canonical history reconcile to one finalized operation.
 *
 * The backend and the publisher are external systems here, journalled on disk, because what each
 * of these checkpoints proves is precisely that the operator reconciles against a system whose
 * state outlived its own process.
 */
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import type { TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import { Store } from '../../store/store.js';
import { NativeOperatorStateRepository } from '../../daemon/native-operator-state.js';
import type { NativeOperationId } from '../../daemon/native-operation-identity.js';
import { NativeSolutionCoordinator } from '../../daemon/native-solution-coordinator.js';
import type { DrillCheckpoint } from '../checkpoints.js';
import type { RunObservation } from '../observation.js';
import {
  DRILL_CLOCK,
  broadcastOnce,
  digestOf,
  journal,
  observedMode,
  storePath,
  type ScenarioContext,
} from './support.js';
import {
  DRILL_OPERATOR,
  DRILL_REQUEST_ID,
  DRILL_SOURCE_ENTRY,
  enqueueCard,
  queuedCard,
} from './claim.js';

const CLAIM_TX = `0x${'3'.repeat(64)}` as const;
const CLAIM_BLOCK = `0x${'4'.repeat(64)}` as const;
const OUTPUT_BYTES = new TextEncoder().encode('{"probability":0.62}');
const EVIDENCE_BYTES = serializeCanonicalJson({
  '@context': 'https://spec.jinn.network/evidence/context/v1',
  '@graph': [{
    '@id': 'urn:uuid:55555555-5555-4555-8555-555555555555',
    '@type': 'https://spec.jinn.network/evidence/Execution',
  }],
});
const ENVELOPE_BYTES = new TextEncoder().encode(
  '{"payloadType":"application/vnd.jinn.marketplace.executor-binding.v1+json"}',
);
const SUBMISSION_URI = 'urn:uuid:33333333-3333-4333-8333-333333333333';

function solutionDocuments() {
  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0',
      digest: { sha256: '1'.repeat(64) },
    },
    instructions: 'Return a deterministic prediction.',
    outputs: [{ name: 'prediction', mediaType: 'application/json', required: true }],
  });
  const submissionBytes = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: SUBMISSION_URI,
    task: { digest: { sha256: documentDigest(taskBytes).slice(7) } },
    requester: 'urn:uuid:44444444-4444-4444-8444-444444444444',
    idempotencyKey: 'drill-solution',
    nonce: 'drill-solution',
    deadline: '2026-08-03T00:00:00Z',
  });
  return { taskBytes, submissionBytes };
}

/** Seed the durable state up to a finalized claim — the state every solution checkpoint starts from. */
function seedClaimedEngagement(path: string): NativeOperationId {
  const store = new Store(path);
  try {
    enqueueCard(store);
    const state = new NativeOperatorStateRepository(store, { now: () => DRILL_CLOCK });
    const existing = state.listEngagements()[0];
    if (existing !== undefined) return existing.engagementId;
    const documents = solutionDocuments();
    const card = queuedCard();
    const admitted = state.recordDecision({
      chainId: 84532,
      coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
      taskId: 7n,
      operatorAgent: DRILL_OPERATOR,
      taskDigest: documentDigest(documents.taskBytes),
      submissionUri: SUBMISSION_URI,
      submissionDigest: documentDigest(documents.submissionBytes),
      source: {
        cardId: 1,
        agent: card.card.discovery!.source.agent,
        name: card.card.discovery!.source.name,
        sequence: card.card.discovery!.sequence,
        entryDigest: card.card.discovery!.entryDigest,
        announcementId: card.announcementId,
      },
      decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
    });
    if (admitted.kind !== 'admitted') {
      throw new Error('restart drill could not admit the solution engagement');
    }
    state.recordClaimBroadcast(admitted.claimOperationId, CLAIM_TX);
    state.recordClaimFinalized(admitted.claimOperationId, {
      txHash: CLAIM_TX,
      blockHash: CLAIM_BLOCK,
      blockNumber: 100n,
      attemptIndex: 0,
      requestId: DRILL_REQUEST_ID,
    });
    return admitted.engagementId;
  } finally {
    store.close();
  }
}

/**
 * Every `submit` call the backend saw, across both processes of a pair — not a deduplicated set.
 * A journal that silently swallowed the second submit would make the no-duplicate proof
 * unfalsifiable: the counter could never be anything but zero, whatever the operator did.
 */
interface BackendEntry { readonly key: string; readonly digest: string }
interface PublishEntry { readonly key: string; readonly sequence: number }

export async function runSolutionScenario(
  context: ScenarioContext,
  checkpoint: Extract<DrillCheckpoint, 'backend-submit' | 'evidence' | 'solution-settlement'>,
): Promise<RunObservation | undefined> {
  const path = storePath(context);
  const engagementId = seedClaimedEngagement(path);
  const documents = solutionDocuments();
  const settlementKey = `${context.runId}:solution-settlement`;

  const backendJournal = journal<BackendEntry>(context, 'backend');
  const publishJournal = journal<PublishEntry>(context, 'publisher');

  const invocations = {
    backendRecover: 0,
    backendSubmit: 0,
    evidenceRead: 0,
    publish: 0,
    settlementBroadcast: 0,
  };

  const store = new Store(path);
  try {
    const state = new NativeOperatorStateRepository(store, { now: () => DRILL_CLOCK });
    const engagement = state.getEngagement(engagementId)!;
    const attemptUri = engagement.attemptUri as `urn:uuid:${string}`;
    const deliveryBytes = sealDelivery({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      attempt: attemptUri,
      task: documentDigest(documents.taskBytes),
      outputs: [{
        name: 'prediction',
        mediaType: 'application/json',
        digest: { sha256: documentDigest(OUTPUT_BYTES).slice(7) },
      }],
      evidenceRecords: [{ family: 'execution-evidence', digest: documentDigest(EVIDENCE_BYTES) }],
      executionIds: ['urn:uuid:55555555-5555-4555-8555-555555555555'],
      outcome: 'fulfilled',
      createdAt: '2026-08-02T00:05:00.000Z',
    });

    const backend: TaskExecutionBackend = {
      capabilities: async () => ({
        taskProfiles: [], inputMediaTypes: [], outputMediaTypes: [], isolation: [],
        watch: false, cancel: false, preflight: false, fetchArtifact: true,
        confidentialInputs: false, signedObservations: false, signedDeliveries: true,
        evidenceCapture: 'none' as const, deadlineEnforcement: false,
        attempts: {}, runPinning: { keys: [] },
      }),
      recover: async () => {
        invocations.backendRecover += 1;
        const known = backendJournal.entries().some(({ key }) => key === SUBMISSION_URI);
        return { classification: known ? 'matching' as const : 'absent' as const };
      },
      submit: async () => {
        invocations.backendSubmit += 1;
        // The backend durably accepts FIRST; only then may the process die. That ordering is what
        // makes the checkpoint meaningful: the operator's ignorance, not the backend's.
        backendJournal.append({
          key: SUBMISSION_URI,
          digest: documentDigest(documents.submissionBytes),
        });
        if (checkpoint === 'backend-submit') await context.boundary();
        return {
          accepted: true as const,
          submission: SUBMISSION_URI,
          digest: documentDigest(documents.submissionBytes),
        };
      },
      observe: async () => ({
        descriptor: {
          protocol: TASK_EXECUTION_PROTOCOL_URI,
          attempt: attemptUri,
          task: documentDigest(documents.taskBytes),
          submission: SUBMISSION_URI,
          derived: {
            state: 'delivered' as const,
            terminal: true,
            contradictory: false,
            cancelRequested: false,
            executionIds: ['urn:uuid:55555555-5555-4555-8555-555555555555'],
            deliveries: [{ digest: documentDigest(deliveryBytes) }],
          },
        },
        cursor: { sequence: '0000000000000010' },
        observations: [],
      }),
      deliveries: async () => [{ attempt: attemptUri, digest: documentDigest(deliveryBytes) }],
      fetchDelivery: async () => deliveryBytes,
      fetchArtifact: async () => OUTPUT_BYTES,
    };

    const coordinator = new NativeSolutionCoordinator({
      state,
      backend,
      documents: { resolve: async () => documents },
      deliverySignature: { get: () => ENVELOPE_BYTES },
      evidence: {
        awaitIndexed: async (reference) => ({ status: 'indexed', reference }),
        getRecord: async () => {
          invocations.evidenceRead += 1;
          return EVIDENCE_BYTES;
        },
      },
      verification: { verify: async () => ({ ok: true }) },
      publisher: {
        sourceId: 'urn:jinn:source:drill-solver-records',
        publish: async ({ publication }) => {
          invocations.publish += 1;
          const wrote = publishJournal.appendOnce(publication.publicationKey, {
            key: publication.publicationKey,
            sequence: publishJournal.entries().length + 1,
          });
          if (checkpoint === 'evidence' && wrote && publishJournal.entries().length === 1) {
            // The first record is durably published; the process dies before the operator can
            // record that, so the restart must resume publication without duplicating it.
            await context.boundary();
          }
          const entry = publishJournal.entries().find(({ key }) => key === publication.publicationKey)!;
          return {
            location: `https://solver.example/records/${publication.recordDigest.slice(7)}`,
            sequence: String(entry.sequence),
            entryDigest: publication.recordDigest,
          };
        },
      },
      settlement: {
        broadcast: async () => {
          const sent = await broadcastOnce(context, settlementKey, async () => {
            if (checkpoint === 'solution-settlement') await context.boundary();
          });
          if (sent.broadcast) invocations.settlementBroadcast += 1;
          return { txHash: sent.txHash };
        },
        readCanonical: async () => {
          const history = await context.chain.findByDigest(settlementKey);
          const first = history[0];
          if (first === undefined) {
            return { kind: 'absent' as const, checkedAtBlock: 0n };
          }
          const finalized = await context.chain.awaitFinalized(first.hash);
          return {
            kind: 'finalized' as const,
            txHash: finalized.hash,
            blockHash: finalized.blockHash,
            blockNumber: finalized.blockNumber,
          };
        },
      },
      retry: {
        now: () => DRILL_CLOCK,
        delayMs: 0,
        maxAttempts: 5,
        deadline: () => '2026-08-03T00:00:00.000Z',
      },
    });

    // One reconcile loop drives the engagement to its terminal state in both modes. The recovered
    // run enters it with the same durable row the uninterrupted run passed through.
    for (let pass = 0; pass < 8; pass += 1) {
      const results = await coordinator.reconcileStartup();
      if (results.every(({ kind }) => kind === 'solution-settled' || kind === 'failed')) break;
    }

    const finalEngagement = state.getEngagement(engagementId)!;
    // The graph digest deliberately excludes transaction hashes. The oracle lane and the recovery
    // lane broadcast their own independent transactions, so their hashes differ by construction;
    // what must match is the record graph. The hashes themselves are retained in the report's
    // `transactionHashes`, and duplicate-freedom is asserted from canonical chain history.
    const operations = state.listOperations(engagementId).map((operation) => ({
      id: operation.operationId,
      kind: operation.kind,
      status: operation.status,
    }));
    const artifacts = state.listSolutionArtifacts(engagementId).map((artifact) => ({
      role: artifact.role,
      name: artifact.name,
      digest: artifact.digest,
    }));
    const publications = store.db.prepare(
      'SELECT publication_key, status FROM native_publication_outbox WHERE engagement_id = ? ORDER BY publication_key',
    ).all(engagementId) as Array<{ publication_key: string; status: string }>;
    const settlementHistory = await context.chain.findByDigest(settlementKey);
    const backendEntries = backendJournal.entries();
    const acceptedSubmissions = new Set(backendEntries.map(({ key }) => key));
    const publishedKeys = new Set(publishJournal.entries().map(({ key }) => key));

    return {
      checkpoint,
      seed: context.seed,
      mode: observedMode(context.mode),
      finalState: finalEngagement.state,
      graphDigest: digestOf({
        engagement: { id: finalEngagement.engagementId, state: finalEngagement.state },
        operations,
        artifacts,
        publications,
        delivery: documentDigest(deliveryBytes),
      }),
      operationIds: operations.map(({ id }) => id),
      transactionHashes: settlementHistory.map(({ hash }) => hash),
      sourceHeads: [DRILL_SOURCE_ENTRY],
      effects: {
        backendSubmissions: acceptedSubmissions.size,
        // Every submit the backend saw, from both processes: a recovery that re-submitted instead
        // of reconciling shows up here as a duplicate, which is the whole point of the checkpoint.
        duplicateSubmits: Math.max(backendEntries.length - acceptedSubmissions.size, 0),
        // Distinct records in the source. The publisher is idempotent by publication key, so a
        // resumed publication pass is expected to re-offer keys it already wrote; what must not
        // change is how many records the source ends up holding.
        publishedRecords: publishedKeys.size,
        settlements: settlementHistory.length === 0 ? 0 : 1,
        duplicateSettlements: Math.max(settlementHistory.length - 1, 0),
      },
      invocations,
      stateBefore: `engagement ${finalEngagement.engagementId} claimed and finalized`,
      stateAfter: `state ${finalEngagement.state}; ${publishedKeys.size} published record(s); `
        + `${settlementHistory.length} canonical settlement transaction(s)`,
    };
  } finally {
    store.close();
  }
}
