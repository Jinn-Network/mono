import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import {
  appendSignedReorgCorrections,
  signAnnouncementEntry,
  type ProjectedAnnouncement,
} from '@jinn-network/marketplace-projector';
import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_ENTRY,
  MEDIA_HEAD,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  archivePagePath,
  dssePreAuthEncoding,
  formatOrigin,
  headPath,
  sealJson,
  type AnnouncementEntry,
  type SourceHead,
} from '@jinn-network/record-discovery-protocol';
import { createFsBlobStore } from '@jinn-network/record-discovery-transport-http';
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import type { TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import { Store } from '../../src/store/store.js';
import {
  createNativeRequester,
  type NativeRequesterRoles,
} from '../../src/native-requester/requester.js';
import type { NativeDiscoveryQueuedCard } from '../../src/daemon/native-discovery.js';
import type { NativeClaimDecision } from '../../src/daemon/native-claim-policy.js';
import {
  NativeClaimCoordinator,
  type NativeClaimCanonicalFact,
} from '../../src/daemon/native-claim-coordinator.js';
import {
  NativeOperatorStateRepository,
  NativeWorkerLeaseError,
} from '../../src/daemon/native-operator-state.js';
import { openNativeSolutionPublisher } from '../../src/daemon/native-solution-publisher.js';
import { publicationKey } from '../../src/daemon/native-operation-identity.js';
import { NativeSolutionCoordinator } from '../../src/daemon/native-solution-coordinator.js';
import { NativeEvaluatorStateRepository } from '../../src/daemon/native-evaluator-state.js';
import { NativeEvaluatorCoordinator } from '../../src/daemon/native-evaluator-coordinator.js';

const CREATOR = '0x1111111111111111111111111111111111111111' as const;
const TX = `0x${'3'.repeat(64)}` as const;
const BLOCK = `0x${'4'.repeat(64)}` as const;
const REQUEST = `0x${'5'.repeat(64)}` as const;
const TASK_DIGEST = `sha256:${'1'.repeat(64)}` as const;
const SUBMISSION_DIGEST = `sha256:${'2'.repeat(64)}` as const;
const SOURCE_ENTRY = `sha256:${'6'.repeat(64)}` as const;
const OPERATOR = 'urn:jinn:operator:solver-a';
const REQUESTER_TERMS = {
  solutionMaxDeliveryRateWei: 2n,
  verdictMaxDeliveryRateWei: 3n,
  responseTimeoutSeconds: 60n,
  allowSolverSelfEvaluation: false,
} as const;

interface MatrixResult {
  readonly seed: string;
  readonly finalState: string;
  readonly graphRoot: `sha256:${string}`;
  readonly operationIds: readonly string[];
  readonly sourceHead?: `sha256:${string}`;
  readonly invocations: Readonly<Record<string, number>>;
  readonly effects: Readonly<Record<string, number>>;
}

function root(value: unknown): `sha256:${string}` {
  return documentDigest(serializeCanonicalJson(value as Parameters<typeof serializeCanonicalJson>[0]));
}

function requesterRoles(): NativeRequesterRoles {
  const identities = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  for (const role of ['requester-submission', 'admission', 'requester-discovery']) {
    identities.set(role, generateKeyPairSync('ed25519'));
  }
  return {
    get(role) {
      const identity = identities.get(role)!;
      return {
        keyId: `did:key:${role}:B800`,
        publicKey: identity.publicKey,
        sign: (payload) => new Uint8Array(cryptoSign(null, payload, identity.privateKey)),
      };
    },
  };
}

async function requesterRun(input: {
  readonly stateDir: string;
  readonly roles: NativeRequesterRoles;
  readonly recover: boolean;
}): Promise<MatrixResult> {
  let invoked = false;
  let posts = 0;
  let recoveries = 0;
  const deps = {
    stateDir: input.stateDir,
    requesterAgent: 'urn:jinn:requester:B800',
    admissionAgent: 'urn:jinn:admission:B800',
    publicBaseUrl: 'https://requester.example',
    readChain: async () => BASE_SEPOLIA_TODAY,
    authorityTime: async () => ({
      chainId: 84532 as const,
      blockNumber: '100',
      blockHash: `0x${'cd'.repeat(32)}` as const,
      timestamp: '2026-08-02T11:59:00.000Z',
      finalized: true as const,
    }),
    loadRoles: async () => input.roles,
    creatorSafe: CREATOR,
    posting: {
      terms: REQUESTER_TERMS,
      post: async () => {
        posts += 1;
        invoked = true;
        if (input.recover) throw new Error('wallet response lost');
        return { taskId: 17n, txHash: TX };
      },
      recover: async () => {
        recoveries += 1;
        return invoked ? { taskId: 17n, txHash: TX } : null;
      },
      canonicalTaskCreated: async (expected: {
        chainId: number; coordinator: string; creator: string; taskId: bigint;
        taskDigest: `sha256:${string}`; txHash: `0x${string}`;
        terms: typeof REQUESTER_TERMS; maxClaims: 1;
      }) => ({ canonical: true as const, ...expected }),
    },
    now: () => new Date('2026-08-02T12:00:00.000Z'),
  };
  let requester = createNativeRequester(deps);
  if (input.recover) {
    await expect(requester.request({
      network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'B800',
    })).rejects.toThrow(/wallet response lost/u);
    requester = createNativeRequester(deps);
  }
  const outcome = await requester.request({
    network: 'base-sepolia', fixture: 'prediction-forecast-golden.json', runId: 'B800',
  });
  const association = outcome.association;
  return {
    seed: 'B800',
    finalState: 'published',
    graphRoot: root({
      task: association.taskDigest,
      submission: association.submissionDigest,
      envelope: association.requesterEnvelopeDigest,
      receipt: association.admissionReceiptDigest,
      taskId: association.taskId.toString(10),
      submissionUri: association.submissionUri,
      nonce: association.nonce,
      postingTerms: association.postingTerms,
      intendedSpendWei: association.intendedSpendWei,
      source: {
        sequence: association.publication.sequence,
        entry: association.publication.entryDigest,
      },
    }),
    operationIds: [`post:${association.taskDigest}:${association.submissionDigest}`],
    sourceHead: association.publication.entryDigest,
    invocations: { post: posts, recover: recoveries },
    effects: { posting: 1, signedSourceEntries: 1 },
  };
}

function queued(): NativeDiscoveryQueuedCard {
  return {
    id: 1,
    announcementId: 'announcement-B801',
    card: {
      record: { kind: 'https://jinn.network/records/task-execution/submission/1.0', digest: SUBMISSION_DIGEST },
      facts: {
        taskDigest: TASK_DIGEST,
        taskProfileUri: 'https://jinn.network/task-profiles/prediction-forecast/1.0',
      },
      chain: {
        taskId: 7n,
        submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
        nonce: 'B801',
        intendedSpendWei: 2n,
      },
      discovery: {
        source: { agent: 'urn:jinn:requester:B800', name: 'requester' },
        sequence: '0000000000000001',
        entryDigest: SOURCE_ENTRY,
        signedHighWater: {
          sequence: '0000000000000001',
          entry: SOURCE_ENTRY,
          issuedAt: '2026-08-02T00:00:00.000Z',
          refreshBy: '2026-08-03T00:00:00.000Z',
          signature: {},
        },
      },
    },
  };
}

function accepted(): NativeClaimDecision {
  return {
    ok: true,
    facts: {
      taskId: 7n,
      taskDigest: TASK_DIGEST,
      submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      nonce: 'B801',
      profileUri: 'https://jinn.network/task-profiles/prediction-forecast/1.0',
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

function enqueue(store: Store): void {
  const item = queued();
  store.db.prepare(
    `INSERT OR IGNORE INTO native_discovery_cards
      (id, source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', '2026-08-02T00:00:00.000Z')`,
  ).run(
    item.id,
    item.card.discovery!.source.agent,
    item.card.discovery!.source.name,
    item.card.discovery!.sequence,
    item.card.discovery!.entryDigest,
    item.announcementId,
  );
}

async function claimRun(input: { readonly path: string; readonly recover: boolean }): Promise<MatrixResult> {
  let calls = 0;
  let canonical: NativeClaimCanonicalFact = { kind: 'absent', checkedAtBlock: 9n };
  const make = (store: Store) => {
    const state = new NativeOperatorStateRepository(store, { now: () => new Date('2026-08-02T00:00:00Z') });
    const coordinator = new NativeClaimCoordinator({
      state,
      chain: BASE_SEPOLIA_TODAY,
      operatorAgent: OPERATOR,
      admission: { evaluate: async () => accepted() },
      claim: {
        priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace,
        broadcast: async () => {
          calls += 1;
          canonical = {
            kind: 'finalized', txHash: TX, blockHash: BLOCK, blockNumber: 10n,
            attemptIndex: 0, requestId: REQUEST,
          };
          if (input.recover) throw new Error('wallet response lost');
          return { txHash: TX, attemptIndex: 0, requestId: REQUEST };
        },
      },
      canonical: { read: async () => canonical },
      worker: { ownerId: 'B801-worker', ttlMs: 60_000 },
    });
    coordinator.startWorker();
    return { state, coordinator };
  };
  let store = new Store(input.path);
  enqueue(store);
  let runtime = make(store);
  await runtime.coordinator.process(queued(), {
    taskBytes: new Uint8Array([1]), submissionBytes: new Uint8Array([2]),
  });
  if (input.recover) {
    store.close();
    store = new Store(input.path);
    runtime = make(store);
    await runtime.coordinator.reconcileStartup();
  }
  const engagements = runtime.state.listEngagements().map((value) => ({
    id: value.engagementId, state: value.state, attempt: value.attemptUri,
  }));
  const operations = runtime.state.listOperations().map((value) => ({
    id: value.operationId, kind: value.kind, status: value.status, tx: value.txHash,
  }));
  store.close();
  return {
    seed: 'B801',
    finalState: engagements[0]?.state ?? 'missing',
    graphRoot: root({ engagements, operations }),
    operationIds: operations.map(({ id }) => id),
    invocations: { claim: calls },
    effects: { claims: 1 },
  };
}

const SOLUTION_OUTPUT_BYTES = new TextEncoder().encode('{"probability":0.62}');
const SOLUTION_EVIDENCE_BYTES = serializeCanonicalJson({
  '@context': 'https://jinn.network/evidence/context/1.0',
  '@graph': [{
    '@id': 'urn:uuid:55555555-5555-4555-8555-555555555555',
    '@type': 'https://jinn.network/evidence/Execution',
  }],
});
const SOLUTION_ENVELOPE_BYTES = new TextEncoder().encode(
  '{"payloadType":"application/vnd.jinn.marketplace.executor-binding.v1+json"}',
);

function solutionDocuments() {
  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: 'https://jinn.network/task-profiles/prediction-forecast/1.0',
      digest: { sha256: '1'.repeat(64) },
    },
    instructions: 'Return a deterministic prediction.',
    outputs: [{ name: 'prediction', mediaType: 'application/json', required: true }],
  });
  const submissionBytes = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: 'urn:uuid:33333333-3333-4333-8333-333333333333',
    task: { digest: { sha256: documentDigest(taskBytes).slice(7) } },
    requester: 'urn:uuid:44444444-4444-4444-8444-444444444444',
    idempotencyKey: 'B802',
    nonce: 'B802',
    deadline: '2026-08-03T00:00:00Z',
  });
  return { taskBytes, submissionBytes };
}

function initializeSolutionClaim(path: string, now: () => Date): string {
  const store = new Store(path);
  enqueue(store);
  const state = new NativeOperatorStateRepository(store, { now });
  const documents = solutionDocuments();
  const admitted = state.recordDecision({
    chainId: 84532,
    coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
    taskId: 7n,
    operatorAgent: OPERATOR,
    taskDigest: documentDigest(documents.taskBytes),
    submissionUri: 'urn:uuid:33333333-3333-4333-8333-333333333333',
    submissionDigest: documentDigest(documents.submissionBytes),
    source: {
      cardId: 1,
      agent: queued().card.discovery!.source.agent,
      name: queued().card.discovery!.source.name,
      sequence: queued().card.discovery!.sequence,
      entryDigest: queued().card.discovery!.entryDigest,
      announcementId: queued().announcementId,
    },
    decision: { ok: true, capability: { ok: true }, policy: { ok: true } },
  });
  if (admitted.kind !== 'admitted') throw new Error('B802 claim was not admitted');
  state.recordClaimBroadcast(admitted.claimOperationId, TX);
  state.recordClaimFinalized(admitted.claimOperationId, {
    txHash: TX,
    blockHash: BLOCK,
    blockNumber: 100n,
    attemptIndex: 0,
    requestId: REQUEST,
  });
  store.close();
  return admitted.engagementId;
}

async function solutionRun(input: { readonly path: string; readonly restart: boolean }): Promise<MatrixResult> {
  let nowMs = Date.parse('2026-08-02T00:00:00Z');
  const now = () => new Date(nowMs);
  const engagementId = initializeSolutionClaim(input.path, now);
  const documents = solutionDocuments();
  let submitted = false;
  let evidenceFailures = 1;
  let settlementBroadcast = false;
  const publishedEffects = new Set<string>();
  const invocations = {
    backendRecover: 0,
    backendSubmit: 0,
    evidenceRead: 0,
    publish: 0,
    settlement: 0,
  };

  const make = (store: Store) => {
    const state = new NativeOperatorStateRepository(store, { now });
    const engagement = state.getEngagement(engagementId)!;
    const deliveryBytes = sealDelivery({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      attempt: engagement.attemptUri!,
      task: documentDigest(documents.taskBytes),
      outputs: [{
        name: 'prediction',
        mediaType: 'application/json',
        digest: { sha256: documentDigest(SOLUTION_OUTPUT_BYTES).slice(7) },
      }],
      evidenceRecords: [{ family: 'execution-evidence', digest: documentDigest(SOLUTION_EVIDENCE_BYTES) }],
      executionIds: ['urn:uuid:55555555-5555-4555-8555-555555555555'],
      outcome: 'fulfilled',
      createdAt: '2026-08-02T00:05:00.000Z',
    });
    const backend: TaskExecutionBackend = {
      capabilities: async () => ({
        taskProfiles: [], inputMediaTypes: [], outputMediaTypes: [], workspaceKinds: [], isolation: [],
        watch: false, cancel: false, fetchArtifact: true, signedDeliveries: true,
        runPinning: { posture: 'none', keys: [] },
      }),
      recover: async () => {
        invocations.backendRecover += 1;
        return { classification: submitted ? 'matching' as const : 'absent' as const };
      },
      submit: async () => {
        invocations.backendSubmit += 1;
        submitted = true;
        return {
          accepted: true as const,
          submission: 'urn:uuid:33333333-3333-4333-8333-333333333333',
          digest: documentDigest(documents.submissionBytes),
        };
      },
      observe: async () => ({
        descriptor: {
          protocol: TASK_EXECUTION_PROTOCOL_URI,
          attempt: engagement.attemptUri!,
          task: documentDigest(documents.taskBytes),
          submission: 'urn:uuid:33333333-3333-4333-8333-333333333333',
          derived: { state: 'delivered', terminal: true },
        },
        cursor: { sequence: '0000000000000010' },
        observations: [],
      }),
      deliveries: async () => [{ attempt: engagement.attemptUri!, digest: documentDigest(deliveryBytes) }],
      fetchDelivery: async () => deliveryBytes,
      fetchArtifact: async () => SOLUTION_OUTPUT_BYTES,
    };
    const coordinator = new NativeSolutionCoordinator({
      state,
      backend,
      documents: { resolve: async () => documents },
      deliverySignature: { get: () => SOLUTION_ENVELOPE_BYTES },
      evidence: {
        awaitIndexed: async (reference) => ({ status: 'indexed', reference }),
        getRecord: async () => {
          invocations.evidenceRead += 1;
          if (evidenceFailures > 0) {
            evidenceFailures -= 1;
            throw new Error('B802 evidence temporarily unavailable');
          }
          return SOLUTION_EVIDENCE_BYTES;
        },
      },
      verification: { verify: async () => ({ ok: true }) },
      publisher: {
        sourceId: 'urn:jinn:source:solver-records',
        publish: async ({ publication }) => {
          invocations.publish += 1;
          publishedEffects.add(publication.publicationKey);
          return {
            location: `https://solver.example/records/${publication.recordDigest.slice(7)}`,
            sequence: String(publishedEffects.size),
            entryDigest: publication.recordDigest,
          };
        },
      },
      settlement: {
        broadcast: async () => {
          invocations.settlement += 1;
          settlementBroadcast = true;
          return { txHash: `0x${'7'.repeat(64)}` };
        },
        readCanonical: async () => settlementBroadcast
          ? {
              kind: 'finalized' as const,
              txHash: `0x${'7'.repeat(64)}` as const,
              blockHash: `0x${'8'.repeat(64)}` as const,
              blockNumber: 120n,
            }
          : { kind: 'absent' as const, checkedAtBlock: 119n },
      },
      retry: {
        now,
        delayMs: 1_000,
        maxAttempts: 3,
        deadline: () => '2026-08-03T00:00:00.000Z',
      },
    });
    return { state, coordinator };
  };

  let store = new Store(input.path);
  let runtime = make(store);
  await expect(runtime.coordinator.reconcileEngagement(engagementId)).resolves.toMatchObject({
    kind: 'paused',
    reason: 'solution-dependency-failed',
  });
  nowMs += 1_001;
  if (input.restart) {
    store.close();
    store = new Store(input.path);
    runtime = make(store);
  }
  await expect(runtime.coordinator.reconcileStartup()).resolves.toEqual([
    expect.objectContaining({ kind: 'solution-settled' }),
  ]);
  const engagement = runtime.state.getEngagement(engagementId)!;
  const operations = runtime.state.listOperations(engagementId).map((operation) => ({
    id: operation.operationId,
    kind: operation.kind,
    status: operation.status,
    tx: operation.txHash,
  }));
  const artifacts = runtime.state.listSolutionArtifacts(engagementId).map((artifact) => ({
    role: artifact.role,
    name: artifact.name,
    digest: artifact.digest,
  }));
  const publications = store.db.prepare(
    'SELECT publication_key, status FROM native_publication_outbox WHERE engagement_id = ? ORDER BY publication_key',
  ).all(engagementId) as Array<{ publication_key: string; status: string }>;
  store.close();
  return {
    seed: 'B802',
    finalState: engagement.state,
    graphRoot: root({ engagement: { id: engagement.engagementId, state: engagement.state }, operations, artifacts, publications }),
    operationIds: operations.map(({ id }) => id),
    invocations,
    effects: {
      backendSubmissions: submitted ? 1 : 0,
      publishedRecords: publishedEffects.size,
      settlements: settlementBroadcast ? 1 : 0,
    },
  };
}

function evaluationMaterial() {
  const artifact = (name: string, value: string) => {
    const bytes = new TextEncoder().encode(value);
    return { name, bytes, digest: documentDigest(bytes) };
  };
  return {
    task: artifact('task', 'B804-subject-task'),
    submission: artifact('submission', 'B804-subject-submission'),
    requesterEnvelope: artifact('requester-envelope', 'B804-requester-envelope'),
    admissionReceipt: artifact('admission-receipt', 'B804-admission-receipt'),
    delivery: artifact('delivery', 'B804-solution-delivery'),
    deliveryEnvelope: artifact('delivery-envelope', 'B804-solution-delivery-envelope'),
    evidenceRecords: [artifact('solution-evidence', 'B804-solution-evidence')],
    results: [artifact('prediction', 'B804-prediction')],
    evaluationSpec: artifact('evaluation-spec', 'B804-evaluation-spec'),
  };
}

const EVALUATOR_ADDRESS = `0x${'2'.repeat(40)}` as const;
const EVALUATION_REQUEST = `0x${'9'.repeat(64)}` as const;
const EVALUATION_CLAIM_TX = `0x${'a'.repeat(64)}` as const;

function evaluationOpportunity(sequence = '0000000000000001') {
  const material = evaluationMaterial();
  return {
    opportunity: {
      source: 'https://solver.example/source',
      sourceSequence: sequence,
      sourceEntryDigest: `sha256:${sequence.padStart(64, '0')}` as const,
      canonical: true as const,
      finality: 'finalized' as const,
      chainId: 84532,
      taskId: 7n,
      attemptIndex: 1,
      solutionRequestId: `0x${'b'.repeat(64)}` as const,
      operatorAddress: `0x${'1'.repeat(40)}` as const,
      deliveryCid: 'bafysolution',
      advertisedDeliveryDigest: material.delivery.digest,
      blockHash: `0x${'c'.repeat(64)}` as const,
      blockNumber: 100n,
      transactionHash: `0x${'d'.repeat(64)}` as const,
      logIndex: 3,
      canonicalEventIdentity: `84532:0x${'c'.repeat(64)}:3`,
    },
    evaluatorAgent: 'https://agents.example/evaluator',
    coordinator: `0x${'f'.repeat(40)}` as const,
    material,
  };
}

function initializeEvaluation(path: string, now: () => Date, stage: 'derived' | 'claim-broadcast' | 'finalized'): string {
  const store = new Store(path);
  const state = new NativeEvaluatorStateRepository(store, { now });
  const admitted = state.admitOpportunity(evaluationOpportunity());
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
  const taskBytes = new TextEncoder().encode('B804-exact-evaluation-task');
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
    taskBytes,
    taskDigest,
    submissionBytes,
    submissionDigest: documentDigest(submissionBytes),
    submissionUri,
  });
  if (stage !== 'derived') {
    const claim = state.beginEvaluationClaim(admitted.evaluationId, `0x${taskDigest.slice(7)}`);
    state.recordOperationBroadcast(claim.operationId, EVALUATION_CLAIM_TX);
    if (stage === 'finalized') {
      state.recordEvaluationClaimFinalized(claim.operationId, {
        txHash: EVALUATION_CLAIM_TX,
        blockHash: `0x${'4'.repeat(64)}`,
        blockNumber: 101n,
        requestId: EVALUATION_REQUEST,
        verdictIndex: 0,
        evaluatorAddress: EVALUATOR_ADDRESS,
      });
    }
  }
  store.close();
  return admitted.evaluationId;
}

async function evaluatorRetryRun(input: { readonly path: string; readonly restart: boolean }): Promise<MatrixResult> {
  let nowMs = Date.parse('2026-08-02T12:00:00Z');
  const now = () => new Date(nowMs);
  const id = initializeEvaluation(input.path, now, 'finalized');
  let failures = 1;
  let submitted = false;
  const invocations = { backendRecover: 0, backendSubmit: 0 };
  const make = (store: Store) => {
    const state = new NativeEvaluatorStateRepository(store, { now });
    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {
        recover: async () => {
          invocations.backendRecover += 1;
          if (failures > 0) {
            failures -= 1;
            throw new Error('B804 backend temporarily unavailable');
          }
          return { classification: submitted ? 'matching' as const : 'absent' as const };
        },
        submit: async () => {
          invocations.backendSubmit += 1;
          submitted = true;
          return { accepted: true } as never;
        },
        observe: async () => ({ descriptor: { derived: { terminal: false, state: 'running' } } }) as never,
        capabilities: async () => ({}) as never,
        deliveries: async () => [],
        fetchDelivery: async () => new Uint8Array(),
      },
      authority: { claim: async () => { throw new Error('authority already persisted'); }, dependencies: {} as never },
      deadline: () => '2026-08-03T00:00:00Z',
      evaluatorAddress: EVALUATOR_ADDRESS,
      verdictPorts: {} as never,
      chain: {} as never,
      deliverySignature: {} as never,
      evidence: {} as never,
      publisher: {} as never,
      verification: {} as never,
      retry: { now, delayMs: 1_000, maxAttempts: 3 },
    });
    return { state, coordinator };
  };
  let store = new Store(input.path);
  let runtime = make(store);
  await expect(runtime.coordinator.reconcileEvaluation(id)).resolves.toEqual({
    kind: 'paused', reason: 'evaluator-dependency-failed',
  });
  nowMs += 1_001;
  if (input.restart) {
    store.close();
    store = new Store(input.path);
    runtime = make(store);
  }
  await expect(runtime.coordinator.reconcileStartup()).resolves.toEqual([{ kind: 'evaluating' }]);
  const evaluation = runtime.state.getEvaluation(id)!;
  const operations = runtime.state.listEvaluationOperations(id).map((operation) => ({
    id: operation.operationId,
    kind: operation.kind,
    status: operation.status,
    tx: operation.txHash,
  }));
  const derived = runtime.state.getDerivedEvaluation(id)!;
  store.close();
  return {
    seed: 'B804',
    finalState: evaluation.state,
    graphRoot: root({
      evaluation: { id, state: evaluation.state, attempt: evaluation.evaluationAttemptUri },
      operations,
      dispatch: derived.dispatchContextDigest,
    }),
    operationIds: operations.map(({ id: operationId }) => operationId),
    invocations,
    effects: { backendSubmissions: submitted ? 1 : 0 },
  };
}

const B805_DELIVERY_OLD = `0x${'1'.repeat(64)}` as const;
const B805_DELIVERY_REPLACED = `0x${'2'.repeat(64)}` as const;
const B805_DELIVERY_RETRY = `0x${'3'.repeat(64)}` as const;
const B805_SETTLEMENT_OLD = `0x${'4'.repeat(64)}` as const;
const B805_SETTLEMENT_REPLACED = `0x${'5'.repeat(64)}` as const;
const B805_SETTLEMENT_RETRY = `0x${'6'.repeat(64)}` as const;
const B805_VERDICT_BYTES = new TextEncoder().encode('B805-signed-verdict');
const B805_DELIVERY_BYTES = new TextEncoder().encode('B805-evaluation-delivery');

function initializeVerdictPublished(path: string, now: () => Date): string {
  const id = initializeEvaluation(path, now, 'finalized');
  const store = new Store(path);
  const state = new NativeEvaluatorStateRepository(store, { now });
  const execution = state.beginEvaluationExecution(id);
  state.recordEvaluationBackendAccepted(execution.operationId);
  const derived = state.getDerivedEvaluation(id)!;
  const artifact = (role: string, bytes: Uint8Array) => ({
    role,
    name: role,
    mediaType: 'application/octet-stream',
    digest: documentDigest(bytes),
    bytes,
  });
  state.recordVerdictReady(id, {
    sourceId: 'urn:jinn:source:evaluator-records',
    verdictCode: 1,
    artifacts: [
      artifact('evaluation-task', derived.taskBytes),
      artifact('evaluation-submission', derived.submissionBytes),
      artifact('verdict', B805_VERDICT_BYTES),
      artifact('evaluation-delivery', B805_DELIVERY_BYTES),
      artifact('evaluation-delivery-envelope', new TextEncoder().encode('B805-delivery-envelope')),
    ],
  });
  for (const publication of state.listPendingEvaluationPublications()) {
    state.recordEvaluationPublicationPublished(publication.publicationKey, {
      location: `https://evaluator.example/${publication.recordDigest}`,
      sequence: publication.publicationKey,
      entryDigest: publication.recordDigest,
    });
  }
  store.close();
  return id;
}

async function evaluatorReplacementRun(input: { readonly path: string; readonly restart: boolean }): Promise<MatrixResult> {
  const now = () => new Date('2026-08-02T12:00:00Z');
  const id = initializeVerdictPublished(input.path, now);
  let deliveryFinal = false;
  let settlementFinal = false;
  const invocations = { transactionStatus: 0, marketplaceDeliver: 0, verdictClaim: 0 };
  const make = (store: Store) => {
    const state = new NativeEvaluatorStateRepository(store, { now });
    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {} as never,
      authority: { claim: async () => { throw new Error('authority already persisted'); }, dependencies: {} as never },
      deadline: () => '2026-08-03T00:00:00Z',
      evaluatorAddress: EVALUATOR_ADDRESS,
      verdictPorts: {
        readCanonicalVerdictDelivery: async () => deliveryFinal ? ({
          requestId: EVALUATION_REQUEST,
          deliveryDigest: `0x${documentDigest(B805_DELIVERY_BYTES).slice(7)}`,
          transaction: {
            hash: B805_DELIVERY_RETRY,
            blockNumber: 110n,
            blockHash: `0x${'7'.repeat(64)}`,
            logIndex: 1,
          },
        }) : undefined,
        deliverVerdictToMarketplace: async ({ operationId }) => {
          invocations.marketplaceDeliver += 1;
          const hash = invocations.marketplaceDeliver === 1 ? B805_DELIVERY_OLD : B805_DELIVERY_RETRY;
          if (invocations.marketplaceDeliver === 2) deliveryFinal = true;
          return {
            operationId,
            transaction: { hash, blockNumber: 101n, blockHash: `0x${'8'.repeat(64)}` },
          };
        },
        readVerdictSettlement: async () => settlementFinal ? ({
          requestId: EVALUATION_REQUEST,
          taskId: 7n,
          attemptIndex: 1,
          verdictIndex: 0,
          evaluator: EVALUATOR_ADDRESS,
          verdictCode: 1,
          verdictDigest: `0x${documentDigest(B805_VERDICT_BYTES).slice(7)}`,
          transaction: {
            hash: B805_SETTLEMENT_RETRY,
            blockNumber: 120n,
            blockHash: `0x${'9'.repeat(64)}`,
            logIndex: 2,
          },
        }) : undefined,
        claimVerdictDelivery: async ({ operationId }) => {
          invocations.verdictClaim += 1;
          const hash = invocations.verdictClaim === 1 ? B805_SETTLEMENT_OLD : B805_SETTLEMENT_RETRY;
          if (invocations.verdictClaim === 2) settlementFinal = true;
          return {
            operationId,
            status: 'settled' as const,
            transaction: { hash, blockNumber: 111n, blockHash: `0x${'a'.repeat(64)}` },
          };
        },
      } as never,
      chain: {
        isFinalized: async () => true,
        transactionStatus: async (txHash) => {
          invocations.transactionStatus += 1;
          if (txHash === B805_DELIVERY_OLD) return { kind: 'replaced', txHash: B805_DELIVERY_REPLACED };
          if (txHash === B805_DELIVERY_REPLACED) return { kind: 'orphaned', reason: 'B805 Deliver reorg' };
          if (txHash === B805_SETTLEMENT_OLD) return { kind: 'replaced', txHash: B805_SETTLEMENT_REPLACED };
          if (txHash === B805_SETTLEMENT_REPLACED) return { kind: 'orphaned', reason: 'B805 settlement reorg' };
          return { kind: 'canonical' };
        },
      },
      deliverySignature: {} as never,
      evidence: {} as never,
      publisher: {} as never,
      verification: { verify: async () => ({ ok: true, verdictCode: 1 }) },
    });
    return { state, coordinator };
  };
  let store = new Store(input.path);
  let runtime = make(store);
  await expect(runtime.coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: 'verdict-published' });
  if (input.restart) {
    store.close();
    store = new Store(input.path);
    runtime = make(store);
  }
  await expect(runtime.coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: 'verdict-published' });
  await expect(runtime.coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: 'verdict-settlement-pending' });
  await expect(runtime.coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: 'verdict-settlement-pending' });
  if (input.restart) {
    store.close();
    store = new Store(input.path);
    runtime = make(store);
  }
  await expect(runtime.coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: 'verdict-settlement-pending' });
  await expect(runtime.coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: 'complete' });
  const evaluation = runtime.state.getEvaluation(id)!;
  const operations = runtime.state.listEvaluationOperations(id).map((operation) => ({
    id: operation.operationId,
    kind: operation.kind,
    status: operation.status,
    tx: operation.txHash,
    prior: operation.priorTxHash,
  }));
  store.close();
  return {
    seed: 'B805',
    finalState: evaluation.state,
    graphRoot: root({ evaluation: { id, state: evaluation.state }, operations }),
    operationIds: operations.map(({ id: operationId }) => operationId),
    invocations,
    effects: {
      replacements: 2,
      orphanRetractions: 2,
      canonicalMarketplaceDeliveries: deliveryFinal ? 1 : 0,
      canonicalVerdictSettlements: settlementFinal ? 1 : 0,
    },
  };
}

async function signedReorgCorrection(
  restart: boolean,
  signerKey: ReturnType<typeof generateKeyPairSync>,
  archiveRoot: string,
) {
  const source = { agent: 'urn:jinn:operator:B806', name: 'solver-reorg' };
  const prior = {
    announcementId: 'B806-availability',
    action: 'available',
    record: { kind: RECORD_KINDS.submission, digest: `sha256:${'1'.repeat(64)}` },
    facts: { taskDigest: `sha256:${'2'.repeat(64)}` },
    derivation: {
      chainId: 84532,
      contract: BASE_SEPOLIA_TODAY.jinnRouter,
      event: 'TaskCreated',
      blockNumber: 100,
      blockHash: `0x${'3'.repeat(64)}`,
      txHash: `0x${'4'.repeat(64)}`,
      logIndex: 1,
      finalityTier: 'safe',
      contractGeneration: 'today',
    },
  } satisfies Extract<ProjectedAnnouncement, { action: 'available' }>;
  const priorEntry: AnnouncementEntry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source,
    sequence: '0000000000000001',
    previous: null,
    timestamp: '2026-08-02T11:00:00.000Z',
    announcements: [prior],
  };
  const priorDigest = sealJson(priorEntry).digest;
  const priorHead: SourceHead = {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: formatOrigin(source.agent, source.name),
    sequence: priorEntry.sequence,
    entry: priorDigest,
    issuedAt: '2026-08-02T11:00:00.000Z',
    refreshBy: '2026-08-03T11:00:00.000Z',
  };
  const archiveStore = createFsBlobStore(archiveRoot);
  const priorPagePath = archivePagePath(source.name, '0000000000000001');
  const { privateKey, publicKey } = signerKey;
  const signedPayloads: Array<{ payload: Uint8Array; signature: Uint8Array }> = [];
  const signer = {
    scope: DISCOVERY_SIGNING_SCOPE,
    sign: async (payload: Uint8Array) => {
      const signature = new Uint8Array(cryptoSign(null, payload, privateKey));
      signedPayloads.push({ payload: payload.slice(), signature });
      return [{ keyid: 'did:key:B806', sig: signature }];
    },
  } as const;
  const priorSignature = await signAnnouncementEntry(priorEntry, signer);
  const priorPageBytes = sealJson({
    protocol: RECORD_DISCOVERY_VERSION,
    source: source.name,
    page: '0000000000000001',
    prevArchive: null,
    entries: [{ entry: priorEntry, signature: priorSignature }],
  }).bytes;
  await archiveStore.put(priorPagePath, priorPageBytes, 'application/json');
  let appendedPages = 0;
  const ports: Parameters<typeof appendSignedReorgCorrections>[0]['ports'] = {
      source,
      signer,
      store: archiveStore,
      clock: { now: () => new Date('2026-08-02T12:00:00.000Z') },
      factsRecompute: {} as never,
      referencedBytes: {} as never,
      resolveRecord: async () => { throw new Error('B806 correction resolves no new record'); },
      verifyVerdictObservation: async () => { throw new Error('B806 correction has no verdict'); },
      previousHead: priorHead,
      previousEntryDigest: priorDigest,
      initialSequence: 2n,
      appendArchiveEntries: async ({ entries }) => {
        appendedPages += 1;
        const page = '0000000000000002';
        await archiveStore.put(archivePagePath(source.name, page), sealJson({
          protocol: RECORD_DISCOVERY_VERSION,
          source: source.name,
          page,
          prevArchive: '0000000000000001',
          entries,
        }).bytes, 'application/json');
        return { pages: [page] };
      },
  };
  const result = await appendSignedReorgCorrections({ priors: [prior], ports });
  expect((await archiveStore.get(priorPagePath))!.bytes).toEqual(priorPageBytes);
  expect(result.announcements).toEqual([
    expect.objectContaining({ action: 'withdrawn', retracts: prior.announcementId, reason: 'reorged' }),
  ]);
  expect(result.entries[0]!.entry).toMatchObject({ sequence: '0000000000000002', previous: priorDigest });
  expect(signedPayloads.every(({ payload, signature }) => cryptoVerify(null, payload, publicKey, signature))).toBe(true);
  const reopenedStore = createFsBlobStore(archiveRoot);
  const correctionStored = (await reopenedStore.get(archivePagePath(source.name, '0000000000000002')))!;
  const correctionPage = JSON.parse(new TextDecoder().decode(correctionStored.bytes)) as {
    entries: Array<{
      entry: AnnouncementEntry;
      signature: { payloadType: string; payload: string; signatures: Array<{ sig: string }> };
    }>;
  };
  const signedEntry = correctionPage.entries[0]!;
  const entryPayload = new Uint8Array(Buffer.from(signedEntry.signature.payload, 'base64'));
  expect(entryPayload).toEqual(sealJson(signedEntry.entry).bytes);
  expect(cryptoVerify(
    null,
    dssePreAuthEncoding(MEDIA_ENTRY, entryPayload),
    publicKey,
    Buffer.from(signedEntry.signature.signatures[0]!.sig, 'base64'),
  )).toBe(true);
  const storedHeadBytes = (await reopenedStore.get(headPath(source.name)))!.bytes;
  const headEnvelope = JSON.parse(new TextDecoder().decode(storedHeadBytes)) as {
    payloadType: string;
    payload: string;
    signatures: Array<{ sig: string }>;
  };
  const headPayload = new Uint8Array(Buffer.from(headEnvelope.payload, 'base64'));
  const recoveredHead = JSON.parse(new TextDecoder().decode(headPayload)) as SourceHead;
  expect(recoveredHead).toEqual(result.head);
  expect(recoveredHead).toMatchObject({ sequence: '0000000000000002', entry: sealJson(signedEntry.entry).digest });
  expect(cryptoVerify(
    null,
    dssePreAuthEncoding(MEDIA_HEAD, headPayload),
    publicKey,
    Buffer.from(headEnvelope.signatures[0]!.sig, 'base64'),
  )).toBe(true);
  if (restart) {
    expect(correctionPage.entries).toHaveLength(1);
    expect(correctionPage.entries[0]!.entry.previous).toBe(priorDigest);
    const readbackReplay = await appendSignedReorgCorrections({ priors: [], ports: {
      ...ports,
      store: reopenedStore,
      previousHead: result.head,
      previousEntryDigest: result.head!.entry,
      initialSequence: 3n,
    } });
    expect(readbackReplay.entries).toEqual([]);
    expect(appendedPages).toBe(1);
  }
  return {
    root: root({
      priorPage: documentDigest(priorPageBytes),
      correctionPage: documentDigest(correctionStored.bytes),
      head: result.head,
    }),
    signedWithdrawals: result.announcements.length,
    appendedPages,
    signingInvocations: signedPayloads.length,
  };
}

async function reorgAndFinalityRun(input: {
  readonly rootDir: string;
  readonly restart: boolean;
  readonly signerKey: ReturnType<typeof generateKeyPairSync>;
}): Promise<MatrixResult> {
  const now = () => new Date('2026-08-02T12:00:00Z');
  const evaluatorPath = join(input.rootDir, 'evaluator.sqlite');
  let store = new Store(evaluatorPath);
  let evaluatorState = new NativeEvaluatorStateRepository(store, { now });
  const initial = evaluationOpportunity('0000000000000001');
  const admitted = evaluatorState.admitOpportunity(initial);
  evaluatorState.retractOpportunity({
    source: initial.opportunity.source,
    sourceSequence: '0000000000000002',
    sourceEntryDigest: `sha256:${'2'.padStart(64, '0')}`,
    canonicalEventIdentity: initial.opportunity.canonicalEventIdentity,
    reason: 'B806 safe-chain replacement',
  });
  if (input.restart) {
    store.close();
    store = new Store(evaluatorPath);
    evaluatorState = new NativeEvaluatorStateRepository(store, { now });
  }
  const replacementBase = evaluationOpportunity('0000000000000003');
  const replacement = evaluatorState.admitOpportunity({
    ...replacementBase,
    opportunity: {
      ...replacementBase.opportunity,
      blockHash: `0x${'e'.repeat(64)}`,
      blockNumber: 101n,
      transactionHash: `0x${'f'.repeat(64)}`,
      logIndex: 4,
      canonicalEventIdentity: `84532:0x${'e'.repeat(64)}:4`,
    },
    reopenWithdrawn: true,
  });
  expect(replacement).toEqual({ kind: 'reopened', evaluationId: admitted.evaluationId });
  const evaluation = evaluatorState.getEvaluation(admitted.evaluationId)!;
  const checkpoint = evaluatorState.sourceCheckpoint(initial.opportunity.source)!;
  const reorgGraph = {
    evaluation: {
      id: evaluation.evaluationId,
      state: evaluation.state,
      event: evaluation.canonicalEventIdentity,
      block: evaluation.blockHash,
    },
    checkpoint,
  };
  store.close();

  const solutionPath = join(input.rootDir, 'operator.sqlite');
  const finalized = await solutionRun({ path: solutionPath, restart: input.restart });
  const solutionStore = new Store(solutionPath);
  const solutionState = new NativeOperatorStateRepository(solutionStore, { now });
  const settlement = solutionState.listOperations()
    .find(({ kind }) => kind === 'solution-settlement')!;
  let blockedContradictions = 0;
  expect(() => solutionState.recordSolutionSettlementOrphaned(settlement.operationId, {
    txHash: settlement.txHash as `0x${string}`,
    reason: 'B806 attempted finalized reversal',
  })).toThrow(/cannot orphan a finalized solution settlement/u);
  blockedContradictions += 1;
  const preserved = solutionState.getOperation(settlement.operationId)!;
  const preservedEngagement = solutionState.getEngagement(settlement.engagementId)!;
  solutionStore.close();
  const signedCorrection = await signedReorgCorrection(
    input.restart,
    input.signerKey,
    join(input.rootDir, 'signed-source'),
  );

  return {
    seed: 'B806',
    finalState: `${evaluation.state}/${preservedEngagement.state}`,
    graphRoot: root({
      reorgGraph,
      signedCorrection: signedCorrection.root,
      solutionGraph: finalized.graphRoot,
      finalized: { id: preserved.operationId, status: preserved.status, tx: preserved.txHash },
    }),
    operationIds: finalized.operationIds,
    invocations: {
      ...finalized.invocations,
      consumerRetractions: 1,
      replacementAdmissions: 1,
      correctionSignatures: signedCorrection.signingInvocations,
    },
    effects: {
      ...finalized.effects,
      consumerRetractions: 1,
      signedWithdrawals: signedCorrection.signedWithdrawals,
      appendOnlyCorrectionPages: signedCorrection.appendedPages,
      canonicalReopens: 1,
      blockedFinalizedContradictions: blockedContradictions,
    },
  };
}

function solutionValue(bytes: Uint8Array) {
  const digest = documentDigest(bytes);
  const engagementId = `sha256:${'a'.repeat(64)}` as const;
  const sourceId = 'urn:jinn:operator:solver-a/solver-records';
  return {
    publication: {
      publicationKey: publicationKey({ sourceId, role: 'delivery', recordDigest: digest, availabilityState: 'available' }),
      engagementId,
      sourceId,
      role: 'delivery' as const,
      recordDigest: digest,
      availability: 'available',
      status: 'intent' as const,
      detail: {},
      createdAt: '2026-08-02T00:00:01.000Z',
      updatedAt: '2026-08-02T00:00:01.000Z',
    },
    artifact: {
      engagementId,
      role: 'delivery' as const,
      family: 'delivery',
      mediaType: 'application/vnd.jinn.task-execution.delivery.v1+json',
      name: null,
      digest,
      bytes,
      createdAt: '2026-08-02T00:00:01.000Z',
    },
    bytes,
  };
}

async function publisherRun(input: {
  readonly rootDir: string;
  readonly recover: boolean;
  readonly signer: ReturnType<typeof signedSourceKey>;
}): Promise<MatrixResult> {
  let failed = false;
  let publisher = await openNativeSolutionPublisher({
    rootDir: input.rootDir,
    publicBaseUrl: 'https://operator.example/native',
    source: { agent: OPERATOR, name: 'solver-records' },
    signer: input.signer,
    settlementDeclarationKey: input.signer.keyId,
    ...(input.recover ? {
      faults: {
        afterHeadBeforeState: () => {
          if (!failed) { failed = true; throw new Error('B803'); }
        },
      },
    } : {}),
  });
  const value = solutionValue(new TextEncoder().encode('{"delivery":"B803"}'));
  if (input.recover) {
    await expect(publisher.publish(value)).rejects.toThrow('B803');
    await publisher.close();
    publisher = await openNativeSolutionPublisher({
      rootDir: input.rootDir,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: OPERATOR, name: 'solver-records' },
      signer: input.signer,
      settlementDeclarationKey: input.signer.keyId,
    });
  }
  const receipt = await publisher.publish(value);
  const head = await publisher.handler(new Request('https://operator.example/native/sources/solver-records/head'));
  const headBytes = new Uint8Array(await head.arrayBuffer());
  await publisher.close();
  return {
    seed: 'B803',
    finalState: 'published',
    graphRoot: root({ receipt, head: documentDigest(headBytes) }),
    operationIds: [value.publication.publicationKey],
    sourceHead: receipt.entryDigest,
    invocations: { publish: input.recover ? 2 : 1 },
    effects: { signedSourceEntries: 1 },
  };
}

function signedSourceKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyId: 'did:key:B803',
    sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, privateKey)),
    verify: (payload: Uint8Array, signature: Uint8Array) => cryptoVerify(null, payload, publicKey, signature),
  };
}

async function workerProcessContention(path: string): Promise<MatrixResult> {
  const child = spawn(process.execPath, [
    join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
    join(process.cwd(), 'test/fixtures/native-worker-lease-holder.ts'),
    path,
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`B807 child startup timeout: ${stderr}`)), 10_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`B807 child exited ${code}: ${stderr}`));
      }
    });
    child.stdout!.setEncoding('utf8');
    child.stdout!.once('data', (chunk: string) => {
      clearTimeout(timeout);
      if (!chunk.includes('{"ready":true}')) reject(new Error(`unexpected B807 child output: ${chunk}`));
      else resolve();
    });
  });
  try {
    await ready;
    const loserStore = new Store(path);
    const loser = new NativeOperatorStateRepository(loserStore, {
      now: () => new Date('2026-08-02T00:00:00Z'),
    });
    expect(() => loser.acquireLease({
      role: 'solver',
      chainId: 84532,
      coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
      operatorAgent: OPERATOR,
      ownerId: 'B807-parent-loser',
      ttlMs: 60_000,
    })).toThrow(NativeWorkerLeaseError);
    const operations = loser.listOperations();
    const cards = loserStore.db.prepare('SELECT COUNT(*) AS count FROM native_discovery_cards').get() as { count: number };
    loserStore.close();
    return {
      seed: 'B807',
      finalState: 'one-worker',
      graphRoot: root({ winner: 'B807-child', loserOperations: operations.length, loserCards: cards.count }),
      operationIds: [],
      invocations: { workerProcesses: 2 },
      effects: { activeWorkers: 1, loserDiscoveryReads: cards.count, loserOperations: operations.length },
    };
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
}

describe('Phase B seeded native recovery matrix', () => {
  it('emits machine-readable recovered results equivalent to uninterrupted roots and call counts', async () => {
    const fixture = JSON.parse(await readFile(
      new URL('../fixtures/native-recovery-matrix.v1.json', import.meta.url),
      'utf8',
    )) as { seeds: Array<{
      seed: string;
      expected: {
        finalState: string;
        operationCount: number;
        root: string;
        permittedInvocations: Record<string, number[]>;
        effects: Record<string, number>;
      };
    }> };
    expect(fixture.seeds.map(({ seed }) => seed)).toEqual([
      'B800', 'B801', 'B802', 'B803', 'B804', 'B805', 'B806', 'B807',
    ]);
    const roots: string[] = [];
    const results: MatrixResult[] = [];
    try {
      const roles = requesterRoles();
      const requesterOracleRoot = await mkdtemp(join(tmpdir(), 'B800-oracle-')); roots.push(requesterOracleRoot);
      const requesterRecoveryRoot = await mkdtemp(join(tmpdir(), 'B800-recovery-')); roots.push(requesterRecoveryRoot);
      const requesterOracle = await requesterRun({ stateDir: requesterOracleRoot, roles, recover: false });
      const requesterRecovered = await requesterRun({ stateDir: requesterRecoveryRoot, roles, recover: true });
      expect(requesterRecovered.graphRoot).toBe(requesterOracle.graphRoot);
      expect(requesterRecovered.operationIds).toEqual(requesterOracle.operationIds);
      expect(requesterRecovered.invocations.post).toBe(requesterOracle.invocations.post);
      expect(requesterRecovered.effects).toEqual(requesterOracle.effects);
      results.push(requesterRecovered);

      const claimOracleRoot = await mkdtemp(join(tmpdir(), 'B801-oracle-')); roots.push(claimOracleRoot);
      const claimRecoveryRoot = await mkdtemp(join(tmpdir(), 'B801-recovery-')); roots.push(claimRecoveryRoot);
      const claimOracle = await claimRun({ path: join(claimOracleRoot, 'operator.sqlite'), recover: false });
      const claimRecovered = await claimRun({ path: join(claimRecoveryRoot, 'operator.sqlite'), recover: true });
      expect(claimRecovered).toEqual(claimOracle);
      results.push(claimRecovered);

      const solutionOracleRoot = await mkdtemp(join(tmpdir(), 'B802-oracle-')); roots.push(solutionOracleRoot);
      const solutionRecoveryRoot = await mkdtemp(join(tmpdir(), 'B802-recovery-')); roots.push(solutionRecoveryRoot);
      const solutionOracle = await solutionRun({ path: join(solutionOracleRoot, 'operator.sqlite'), restart: false });
      const solutionRecovered = await solutionRun({ path: join(solutionRecoveryRoot, 'operator.sqlite'), restart: true });
      expect(solutionRecovered).toEqual(solutionOracle);
      results.push(solutionRecovered);

      const signer = signedSourceKey();
      const publisherOracleRoot = await mkdtemp(join(tmpdir(), 'B803-oracle-')); roots.push(publisherOracleRoot);
      const publisherRecoveryRoot = await mkdtemp(join(tmpdir(), 'B803-recovery-')); roots.push(publisherRecoveryRoot);
      const publisherOracle = await publisherRun({ rootDir: publisherOracleRoot, recover: false, signer });
      const publisherRecovered = await publisherRun({ rootDir: publisherRecoveryRoot, recover: true, signer });
      expect(publisherRecovered.graphRoot).toBe(publisherOracle.graphRoot);
      expect(publisherRecovered.operationIds).toEqual(publisherOracle.operationIds);
      expect(publisherRecovered.effects).toEqual(publisherOracle.effects);
      expect(publisherRecovered.invocations.publish).toBe(2);
      results.push(publisherRecovered);

      const evaluatorOracleRoot = await mkdtemp(join(tmpdir(), 'B804-oracle-')); roots.push(evaluatorOracleRoot);
      const evaluatorRecoveryRoot = await mkdtemp(join(tmpdir(), 'B804-recovery-')); roots.push(evaluatorRecoveryRoot);
      const evaluatorOracle = await evaluatorRetryRun({
        path: join(evaluatorOracleRoot, 'evaluator.sqlite'), restart: false,
      });
      const evaluatorRecovered = await evaluatorRetryRun({
        path: join(evaluatorRecoveryRoot, 'evaluator.sqlite'), restart: true,
      });
      expect(evaluatorRecovered).toEqual(evaluatorOracle);
      results.push(evaluatorRecovered);

      const replacementOracleRoot = await mkdtemp(join(tmpdir(), 'B805-oracle-')); roots.push(replacementOracleRoot);
      const replacementRecoveryRoot = await mkdtemp(join(tmpdir(), 'B805-recovery-')); roots.push(replacementRecoveryRoot);
      const replacementOracle = await evaluatorReplacementRun({
        path: join(replacementOracleRoot, 'evaluator.sqlite'), restart: false,
      });
      const replacementRecovered = await evaluatorReplacementRun({
        path: join(replacementRecoveryRoot, 'evaluator.sqlite'), restart: true,
      });
      expect(replacementRecovered).toEqual(replacementOracle);
      results.push(replacementRecovered);

      const reorgOracleRoot = await mkdtemp(join(tmpdir(), 'B806-oracle-')); roots.push(reorgOracleRoot);
      const reorgRecoveryRoot = await mkdtemp(join(tmpdir(), 'B806-recovery-')); roots.push(reorgRecoveryRoot);
      const reorgSigner = generateKeyPairSync('ed25519');
      const reorgOracle = await reorgAndFinalityRun({
        rootDir: reorgOracleRoot, restart: false, signerKey: reorgSigner,
      });
      const reorgRecovered = await reorgAndFinalityRun({
        rootDir: reorgRecoveryRoot, restart: true, signerKey: reorgSigner,
      });
      expect(reorgRecovered).toEqual(reorgOracle);
      results.push(reorgRecovered);

      const leaseRoot = await mkdtemp(join(tmpdir(), 'B807-')); roots.push(leaseRoot);
      const processContention = await workerProcessContention(join(leaseRoot, 'process.sqlite'));
      expect(processContention).toMatchObject({
        seed: 'B807',
        finalState: 'one-worker',
        effects: { activeWorkers: 1, loserDiscoveryReads: 0, loserOperations: 0 },
      });
      results.push(processContention);
      const path = join(leaseRoot, 'connection.sqlite');
      const firstStore = new Store(path);
      const secondStore = new Store(path);
      const first = new NativeOperatorStateRepository(firstStore, { now: () => new Date('2026-08-02T00:00:00Z') });
      const second = new NativeOperatorStateRepository(secondStore, { now: () => new Date('2026-08-02T00:00:00Z') });
      first.acquireLease({
        role: 'solver', chainId: 84532, coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
        operatorAgent: OPERATOR, ownerId: 'B807-A', ttlMs: 60_000,
      });
      expect(() => second.acquireLease({
        role: 'solver', chainId: 84532, coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
        operatorAgent: OPERATOR, ownerId: 'B807-B', ttlMs: 60_000,
      })).toThrow(NativeWorkerLeaseError);
      expect(second.listOperations()).toEqual([]);
      firstStore.close();
      secondStore.close();

      expect(results.map(({ seed }) => seed)).toEqual(fixture.seeds.map(({ seed }) => seed));
      for (const expected of fixture.seeds) {
        const actual = results.find(({ seed }) => seed === expected.seed)!;
        expect(actual.finalState, `${expected.seed} final state`).toBe(expected.expected.finalState);
        expect(actual.operationIds, `${expected.seed} logical operations`)
          .toHaveLength(expected.expected.operationCount);
        expect(actual.graphRoot, `${expected.seed} graph root`).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(actual.effects, `${expected.seed} effects`).toEqual(expected.expected.effects);
        expect(Object.keys(actual.invocations).sort(), `${expected.seed} invocation names`)
          .toEqual(Object.keys(expected.expected.permittedInvocations).sort());
        for (const [name, permitted] of Object.entries(expected.expected.permittedInvocations)) {
          expect(permitted, `${expected.seed} ${name} invocation count`)
            .toContain(actual.invocations[name]);
        }
      }
    } finally {
      await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
    }
  }, 30_000);
});
