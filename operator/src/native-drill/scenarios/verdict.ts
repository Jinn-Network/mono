// operator/src/native-drill/scenarios/verdict.ts
/**
 * Checkpoint `verdict-settlement` (#2434).
 *
 * Boundary: the verdict settlement transaction is on the node and the process is killed before
 * the operation is reconciled — the runbook's "verdict/evaluation Delivery publication and
 * verdict-settlement intent are durable".
 *
 * Proof: the restarted evaluator reconciles canonical history to exactly one finalized verdict
 * operation, and the graph it ends on equals the uninterrupted run's.
 */
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealSubmission,
} from '@jinn-network/task-execution-protocol';
import type { VerdictPorts } from '@jinn-network/marketplace-venue-base';
import type { TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import { Store } from '../../store/store.js';
import { NativeEvaluatorStateRepository } from '../../daemon/native-evaluator-state.js';
import type { NativeOperationId } from '../../daemon/native-operation-identity.js';
import { NativeEvaluatorCoordinator } from '../../daemon/native-evaluator-coordinator.js';
import type { RunObservation } from '../observation.js';
import {
  DRILL_CLOCK,
  broadcastOnce,
  digestOf,
  observedMode,
  storePath,
  unreachableMember,
  unreachablePort,
  type ScenarioContext,
} from './support.js';

const EVALUATOR_ADDRESS = `0x${'2'.repeat(40)}` as const;
const SOLUTION_REQUEST_ID = `0x${'b'.repeat(64)}` as const;
const VERDICT_REQUEST_ID = `0x${'9'.repeat(64)}` as const;
const EVALUATION_CLAIM_TX = `0x${'a'.repeat(64)}` as const;
const VERDICT_BYTES = new TextEncoder().encode('drill-signed-verdict');
const DELIVERY_BYTES = new TextEncoder().encode('drill-evaluation-delivery');
const SOURCE_ENTRY = `sha256:${'7'.repeat(64)}` as const;

function evaluationMaterial() {
  const artifact = (name: string, value: string) => {
    const bytes = new TextEncoder().encode(value);
    return { name, bytes, digest: documentDigest(bytes) };
  };
  return {
    task: artifact('task', 'drill-subject-task'),
    submission: artifact('submission', 'drill-subject-submission'),
    requesterEnvelope: artifact('requester-envelope', 'drill-requester-envelope'),
    admissionReceipt: artifact('admission-receipt', 'drill-admission-receipt'),
    delivery: artifact('delivery', 'drill-solution-delivery'),
    deliveryEnvelope: artifact('delivery-envelope', 'drill-solution-delivery-envelope'),
    evidenceRecords: [artifact('solution-evidence', 'drill-solution-evidence')],
    results: [artifact('prediction', 'drill-prediction')],
    evaluationSpec: artifact('evaluation-spec', 'drill-evaluation-spec'),
  };
}

function opportunity() {
  const material = evaluationMaterial();
  return {
    opportunity: {
      source: 'https://solver.example/source',
      sourceSequence: '0000000000000001',
      sourceEntryDigest: SOURCE_ENTRY,
      canonical: true as const,
      finality: 'finalized' as const,
      chainId: 84532,
      taskId: 7n,
      attemptIndex: 1,
      solutionRequestId: SOLUTION_REQUEST_ID,
      operatorAddress: `0x${'1'.repeat(40)}` as const,
      deliveryCid: 'bafydrillsolution',
      advertisedDeliveryDigest: material.delivery.digest,
      blockHash: `0x${'c'.repeat(64)}` as const,
      blockNumber: 100n,
      transactionHash: `0x${'d'.repeat(64)}` as const,
      logIndex: 3,
      canonicalEventIdentity: `84532:0x${'c'.repeat(64)}:3`,
    },
    evaluatorAgent: 'https://agents.example/evaluator',
    coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
    material,
  };
}

/**
 * Seed the durable evaluator state up to a published verdict whose settlement has not begun —
 * the exact state the `verdict-settlement` boundary interrupts. Idempotent, so the resume process
 * re-opens the seeded state rather than rebuilding it.
 */
function seedPublishedVerdict(path: string): NativeOperationId {
  const store = new Store(path);
  try {
    const state = new NativeEvaluatorStateRepository(store, { now: () => DRILL_CLOCK });
    const existing = state.listEvaluations()[0];
    if (existing !== undefined) return existing.evaluationId;

    const admitted = state.admitOpportunity(opportunity());
    state.recordAdmissionVerified(admitted.evaluationId, {
      requester: { signerKey: 'did:key:requester', sealingTime: '2026-08-02T10:00:00Z' },
      admission: { signerKey: 'did:key:admission', effectiveTime: '2026-08-02T10:00:00Z' },
      executor: {
        signerKey: 'did:key:executor',
        agent: 'https://agents.example/solver',
        declarationKey: 'did:key:solver-declaration',
        effectiveTime: '2026-08-02T10:30:00Z',
        address: `0x${'1'.repeat(40)}`,
      },
      evaluator: {
        signerKey: 'did:key:evaluator',
        agent: 'https://agents.example/evaluator',
        declarationKey: 'did:key:evaluator-declaration',
        address: EVALUATOR_ADDRESS,
      },
      verificationDigest: `sha256:${'e'.repeat(64)}`,
    });
    const taskBytes = new TextEncoder().encode('drill-exact-evaluation-task');
    const taskDigest = documentDigest(taskBytes);
    const submissionUri = 'urn:uuid:00000000-0000-4000-8000-000000000020' as const;
    const submissionBytes = sealSubmission({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      submission: submissionUri,
      task: { digest: { sha256: taskDigest.slice(7) } },
      requester: 'https://agents.example/evaluator',
      idempotencyKey: admitted.evaluationId,
      nonce: admitted.evaluationId,
      deadline: '2026-08-03T00:00:00Z',
    });
    state.recordDerivedEvaluation(admitted.evaluationId, {
      taskBytes, taskDigest, submissionBytes,
      submissionDigest: documentDigest(submissionBytes),
      submissionUri,
    });
    const claim = state.beginEvaluationClaim(admitted.evaluationId, `0x${taskDigest.slice(7)}`);
    state.recordOperationBroadcast(claim.operationId, EVALUATION_CLAIM_TX);
    state.recordEvaluationClaimFinalized(claim.operationId, {
      txHash: EVALUATION_CLAIM_TX,
      blockHash: `0x${'4'.repeat(64)}`,
      blockNumber: 101n,
      requestId: VERDICT_REQUEST_ID,
      verdictIndex: 0,
      evaluatorAddress: EVALUATOR_ADDRESS,
    });
    const execution = state.beginEvaluationExecution(admitted.evaluationId);
    state.recordEvaluationBackendAccepted(execution.operationId);
    const derived = state.getDerivedEvaluation(admitted.evaluationId)!;
    const artifact = (role: string, bytes: Uint8Array) => ({
      role, name: role, mediaType: 'application/octet-stream', digest: documentDigest(bytes), bytes,
    });
    state.recordVerdictReady(admitted.evaluationId, {
      sourceId: 'urn:jinn:source:evaluator-records',
      verdictCode: 1,
      artifacts: [
        artifact('evaluation-task', derived.taskBytes),
        artifact('evaluation-submission', derived.submissionBytes),
        artifact('verdict', VERDICT_BYTES),
        artifact('evaluation-delivery', DELIVERY_BYTES),
        artifact('evaluation-delivery-envelope', new TextEncoder().encode('drill-delivery-envelope')),
      ],
    });
    for (const publication of state.listPendingEvaluationPublications()) {
      state.recordEvaluationPublicationPublished(publication.publicationKey, {
        location: `https://evaluator.example/${publication.recordDigest}`,
        sequence: publication.publicationKey,
        entryDigest: publication.recordDigest,
      });
    }
    return admitted.evaluationId;
  } finally {
    store.close();
  }
}

export async function runVerdictScenario(context: ScenarioContext): Promise<RunObservation | undefined> {
  const path = storePath(context, 'evaluator.sqlite');
  const evaluationId = seedPublishedVerdict(path);
  const deliveryKey = `${context.runId}:verdict-delivery`;
  const settlementKey = `${context.runId}:verdict-settlement`;
  const invocations = { marketplaceDeliver: 0, verdictClaim: 0, canonicalRead: 0 };

  const store = new Store(path);
  try {
    const state = new NativeEvaluatorStateRepository(store, { now: () => DRILL_CLOCK });

    const canonicalOf = async (key: string) => {
      invocations.canonicalRead += 1;
      const history = await context.chain.findByDigest(key);
      const first = history[0];
      if (first === undefined) return undefined;
      return context.chain.awaitFinalized(first.hash);
    };

    const verdictPorts: VerdictPorts = {
      // The drill seeds a finalized evaluation claim, so attempt-opening is already past.
      openVerdictAttempt: unreachableMember('openVerdictAttempt'),
      canOpenVerdictAttempt: unreachableMember('canOpenVerdictAttempt'),
      readCanonicalVerdictAttempt: unreachableMember('readCanonicalVerdictAttempt'),
      deliverVerdictToMarketplace: async ({ operationId }) => {
        const sent = await broadcastOnce(context, deliveryKey);
        if (sent.broadcast) invocations.marketplaceDeliver += 1;
        return { operationId, transaction: await context.chain.awaitFinalized(sent.txHash) };
      },
      readCanonicalVerdictDelivery: async () => {
        const canonical = await canonicalOf(deliveryKey);
        return canonical === undefined ? undefined : {
          requestId: VERDICT_REQUEST_ID,
          deliveryDigest: `0x${documentDigest(DELIVERY_BYTES).slice(7)}`,
          transaction: { ...canonical, logIndex: 1 },
        };
      },
      claimVerdictDelivery: async ({ operationId }) => {
        // The settlement transaction is on the node once the boundary fires; reconciling it into
        // the operation is what the injected boundary interrupts.
        const sent = await broadcastOnce(context, settlementKey, () => context.boundary());
        if (sent.broadcast) invocations.verdictClaim += 1;
        return {
          operationId,
          status: 'settled' as const,
          transaction: await context.chain.awaitFinalized(sent.txHash),
        };
      },
      readVerdictSettlement: async () => {
        const canonical = await canonicalOf(settlementKey);
        return canonical === undefined ? undefined : {
          requestId: VERDICT_REQUEST_ID,
          taskId: 7n,
          attemptIndex: 1,
          verdictIndex: 0,
          evaluator: EVALUATOR_ADDRESS,
          verdictCode: 1,
          verdictDigest: `0x${documentDigest(VERDICT_BYTES).slice(7)}`,
          transaction: { ...canonical, logIndex: 2 },
        };
      },
    };

    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: unreachablePort<TaskExecutionBackend>('evaluation backend'),
      authority: {
        claim: async () => {
          throw new Error('restart drill seeded the subject authority; it must not be re-claimed');
        },
        dependencies: unreachablePort('subject authority dependencies'),
      },
      deadline: () => '2026-08-03T00:00:00Z',
      evaluatorAddress: EVALUATOR_ADDRESS,
      verdictPorts,
      chain: {
        isFinalized: async () => true,
        transactionStatus: async () => ({ kind: 'canonical' }),
      },
      deliverySignature: { get: () => new TextEncoder().encode('drill-delivery-envelope') },
      evidence: unreachablePort('evaluation evidence'),
      publisher: unreachablePort('evaluator publisher'),
      verification: { verify: async () => ({ ok: true, verdictCode: 1 }) },
      retry: { now: () => DRILL_CLOCK, delayMs: 0, maxAttempts: 5 },
    });

    for (let pass = 0; pass < 8; pass += 1) {
      const result = await coordinator.reconcileEvaluation(evaluationId);
      if (result.kind === 'complete' || result.kind === 'failed') break;
    }

    const evaluation = state.getEvaluation(evaluationId)!;
    // The graph digest deliberately excludes transaction hashes. The oracle lane and the recovery
    // lane broadcast their own independent transactions, so their hashes differ by construction;
    // what must match is the record graph. The hashes themselves are retained in the report's
    // `transactionHashes`, and duplicate-freedom is asserted from canonical chain history.
    const operations = state.listEvaluationOperations(evaluationId).map((operation) => ({
      id: operation.operationId,
      kind: operation.kind,
      status: operation.status,
    }));
    const settlementHistory = await context.chain.findByDigest(settlementKey);
    const deliveryHistory = await context.chain.findByDigest(deliveryKey);

    return {
      checkpoint: 'verdict-settlement',
      seed: context.seed,
      mode: observedMode(context.mode),
      finalState: evaluation.state,
      graphDigest: digestOf({
        evaluation: { id: evaluationId, state: evaluation.state },
        operations,
      }),
      operationIds: operations.map(({ id }) => id),
      transactionHashes: [...deliveryHistory, ...settlementHistory].map(({ hash }) => hash),
      sourceHeads: [SOURCE_ENTRY],
      effects: {
        canonicalVerdictDeliveries: deliveryHistory.length === 0 ? 0 : 1,
        canonicalVerdictSettlements: settlementHistory.length === 0 ? 0 : 1,
        duplicateVerdictSettlements: Math.max(settlementHistory.length - 1, 0),
      },
      invocations,
      stateBefore: `evaluation ${evaluationId} with a published verdict and no settlement`,
      stateAfter: `state ${evaluation.state}; ${settlementHistory.length} canonical verdict `
        + 'settlement transaction(s)',
    };
  } finally {
    store.close();
  }
}
