import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXECUTION_EVIDENCE_MEDIA_TYPE } from '@jinn-network/evidence-protocol';
import { createHttpTransport } from '@jinn-network/record-discovery-transport-http';
import {
  DISCOVERY_SIGNING_SCOPE,
  archivePagePath,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import {
  DELIVERY_MEDIA_TYPE,
  SUBMISSION_MEDIA_TYPE,
  TASK_MEDIA_TYPE,
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
  sealDelivery,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import {
  EVALUATION_SPEC_MEDIA_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  canonicalJsonBytes,
  type ResultEvaluationStatement,
} from '@jinn-network/task-execution-profiles';
import { DSSE_ENVELOPE_MEDIA_TYPE } from '@jinn-network/trust-core';
import { ADMISSION_RECEIPT_TRUST_SCOPE, VerdictCode, deriveMarketplaceAttemptUri } from '@jinn-network/marketplace-binding';
import { createNativeRequester, type NativeRequesterRoles } from '../../src/native-requester/requester.js';
import { openNativeSolutionPublisher } from '../../src/daemon/native-solution-publisher.js';
import { openNativeEvaluatorPublisher } from '../../src/daemon/native-evaluator-publisher.js';
import { deriveNativeEvaluation } from '../../src/evaluator/native-evaluation-derivation.js';
import { publicationKey } from '../../src/daemon/native-operation-identity.js';
import type { NativePublicationRow, NativeSolutionArtifactRow } from '../../src/daemon/native-operator-state.js';
import type { NativeEvaluationArtifactRow, NativeEvaluationPublicationRow } from '../../src/daemon/native-evaluator-state.js';
import { ConsumerState } from '../fixtures/native-vertical-consumer/src/state.js';
import { createProtocolSourceVerifier, syncPublicSource } from '../fixtures/native-vertical-consumer/src/sync.js';
import {
  deriveConsumerEngagementId,
  deriveConsumerEvaluationId,
  discoverNativeGraphRoots,
  retrieveNativePublicGraph,
} from '../fixtures/native-vertical-consumer/src/graph.js';
import {
  deriveConsumerSolutionSettlementId,
  deriveConsumerVerdictSettlementId,
  verifyNativeVertical,
  writeNativeVerticalVerificationReport,
} from '../fixtures/native-vertical-consumer/src/verification.js';
import {
  createRealTrustFixture,
  realIdentity,
  signedEnvelope,
  type RealIdentity,
} from './_real-identity.js';

const CHAIN = {
  chainId: 84532,
  taskCoordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98' as const,
  jinnRouter: '0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247',
  mechMarketplace: '0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7',
  activityChecker: '0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70',
  generation: 'today' as const,
};
const REQUESTER_AGENT = 'https://agents.example/requester';
const SOLVER_AGENT = 'https://agents.example/solver';
const EVALUATOR_AGENT = 'https://agents.example/evaluator';
const ADMISSION_AGENT = `${REQUESTER_AGENT}/admission/public-golden-run`;
const REQUESTER_ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const SOLVER_ADDRESS = '0x2222222222222222222222222222222222222222' as const;
const EVALUATOR_ADDRESS = '0x3333333333333333333333333333333333333333' as const;
const TASK_ID = 7n;
const RUN_ID = 'public-golden-run';
const REQUESTER_BASE = 'https://requester.example';
const SOLVER_BASE = 'https://solver.example';
const EVALUATOR_BASE = 'https://evaluator.example';
const REQUESTER_TERMS = {
  solutionMaxDeliveryRateWei: 2n,
  verdictMaxDeliveryRateWei: 3n,
  responseTimeoutSeconds: 60n,
  allowSolverSelfEvaluation: false,
} as const;
const SOURCES = {
  requester: { agent: REQUESTER_AGENT, name: 'requester' },
  solver: { agent: SOLVER_AGENT, name: 'solver-records' },
  evaluator: { agent: EVALUATOR_AGENT, name: 'evaluator-records' },
} satisfies Record<string, SourceIdentity>;
const require = createRequire(import.meta.url);
const EVIDENCE_FIXTURE = JSON.parse(readFileSync(require.resolve(
  '@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json',
), 'utf8')) as Record<string, unknown>;

function roles(identities: Record<'requester' | 'admission' | 'source', RealIdentity>): NativeRequesterRoles {
  return {
    get(role) {
      if (role === 'requester-submission') return identities.requester;
      if (role === 'admission') return identities.admission;
      return identities.source;
    },
  };
}

async function exact(handler: (request: Request) => Promise<Response>, base: string, path: string): Promise<Uint8Array> {
  const response = await handler(new Request(`${base}${path}`));
  if (!response.ok) throw new Error(`public handler returned ${response.status} for ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

function replaceValue(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((item) => replaceValue(item, from, to));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceValue(item, from, to)]));
  }
  return value;
}

function executionEvidence(input: {
  attempt: string;
  taskDigest: `sha256:${string}`;
  resultDigest: `sha256:${string}`;
  agent: string;
}): Uint8Array {
  let document = structuredClone(EVIDENCE_FIXTURE);
  document = replaceValue(document, 'urn:uuid:22222222-2222-4222-8222-222222222222', input.attempt) as Record<string, unknown>;
  document = replaceValue(document, 'urn:uuid:33333333-3333-4333-8333-333333333333', input.agent) as Record<string, unknown>;
  const graph = document['@graph'] as Array<Record<string, unknown>>;
  graph.find((entity) => entity['@id'] === 'task/task.md')!.sha256 = input.taskDigest.slice(7);
  graph.find((entity) => entity['@id'] === 'results/slug-normalization.patch')!.sha256 = input.resultDigest.slice(7);
  return serializeCanonicalJson(document as Parameters<typeof serializeCanonicalJson>[0]);
}

function transport(base: string, handler: (request: Request) => Promise<Response>) {
  return createHttpTransport(base, async (url, init) => handler(new Request(url, init)));
}

function endpoint(source: SourceIdentity, base: string, latestPage: number) {
  return {
    agent: source.agent,
    name: source.name,
    servingRoot: base,
    archiveRootUrl: `${base}${archivePagePath(source.name, String(latestPage).padStart(16, '0'))}`,
  };
}

describe('native public vertical consumer', () => {
  it('cold-syncs real requester/solver/evaluator publishers and independently verifies the complete graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jinn-public-native-vertical-'));
    const producer = {
      requester: join(root, 'requester-private'),
      solver: join(root, 'solver-private'),
      evaluator: join(root, 'evaluator-private'),
    };
    const consumerRoot = join(root, 'consumer-only');
    const requesterKeys = { requester: realIdentity('RequesterRecord'), admission: realIdentity('AdmissionRecord'), source: realIdentity('RequesterSource') };
    const executor = realIdentity('ExecutorRecord');
    const solverDeclaration = realIdentity('SolverDeclaration');
    const solverSource = realIdentity('SolverSource');
    const evaluator = realIdentity('EvaluatorRecord');
    const evaluatorDeclaration = realIdentity('EvaluatorDeclaration');
    const evaluatorSource = realIdentity('EvaluatorSource');
    const requester = createNativeRequester({
      stateDir: producer.requester,
      requesterAgent: REQUESTER_AGENT,
      publicBaseUrl: REQUESTER_BASE,
      readChain: async () => CHAIN,
      loadRoles: async () => roles(requesterKeys),
      creatorSafe: REQUESTER_ADDRESS,
      posting: {
        terms: REQUESTER_TERMS,
        post: async () => ({ taskId: TASK_ID, txHash: `0x${'a'.repeat(64)}` }),
        recover: async () => null,
        canonicalTaskCreated: async (expected) => ({ canonical: true as const, ...expected }),
      },
      now: () => new Date('2026-08-02T12:00:00Z'),
    });
    const requested = await requester.request({ network: 'base-sepolia', fixture: 'prediction-snapshot-v1', runId: RUN_ID });
    const association = requested.association;
    const [taskBytes, submissionBytes, specBytes, receiptBytes, requesterEnvelopeBytes] = await Promise.all([
      exact(requester.handleDiscoveryRequest, REQUESTER_BASE, association.task.path),
      exact(requester.handleDiscoveryRequest, REQUESTER_BASE, association.submission.path),
      exact(requester.handleDiscoveryRequest, REQUESTER_BASE, association.evaluationSpec.path),
      exact(requester.handleDiscoveryRequest, REQUESTER_BASE, association.admissionReceipt.path),
      exact(requester.handleDiscoveryRequest, REQUESTER_BASE, association.requesterEnvelope.path),
    ]);
    const task = TaskSpecificationSchema.parse(JSON.parse(new TextDecoder().decode(taskBytes)));
    const submission = SubmissionRecordSchema.parse(JSON.parse(new TextDecoder().decode(submissionBytes)));
    expect(submission.capabilityGrants).toBeUndefined();

    const solutionPublisher = await openNativeSolutionPublisher({
      rootDir: producer.solver, publicBaseUrl: SOLVER_BASE, source: SOURCES.solver, signer: solverSource,
    });
    const evaluatorPublisher = await openNativeEvaluatorPublisher({
      rootDir: producer.evaluator, publicBaseUrl: EVALUATOR_BASE, source: SOURCES.evaluator, signer: evaluatorSource,
    });
    try {
      const attempt = deriveMarketplaceAttemptUri({ chainId: 84532, coordinator: CHAIN.taskCoordinator, taskId: TASK_ID, attemptIndex: 0 });
      const outputName = task.outputs[0]!.name;
      const outputBytes = serializeCanonicalJson({ probabilityYes: '0.750000', submittedAt: '2026-08-02T12:10:00Z' });
      const outputDigest = documentDigest(outputBytes);
      const solutionEvidenceBytes = executionEvidence({ attempt, taskDigest: documentDigest(taskBytes), resultDigest: outputDigest, agent: SOLVER_AGENT });
      const solutionEvidenceDigest = documentDigest(solutionEvidenceBytes);
      const solutionDeliveryBytes = sealDelivery({
        protocol: task.protocol,
        attempt,
        task: documentDigest(taskBytes),
        outputs: [{ name: outputName, mediaType: task.outputs[0]!.mediaType, digest: { sha256: outputDigest.slice(7) } }],
        executionIds: [attempt],
        evidenceRecords: [{ family: 'execution-evidence', digest: solutionEvidenceDigest }],
        outcome: 'fulfilled', createdAt: '2026-08-02T12:20:00Z',
      });
      const solutionDeliveryDigest = documentDigest(solutionDeliveryBytes);
      const solutionEnvelopeBytes = signedEnvelope(solutionDeliveryBytes, DELIVERY_MEDIA_TYPE, executor);
      const engagementId = deriveConsumerEngagementId({
        chainId: 84532, coordinator: CHAIN.taskCoordinator, taskId: TASK_ID.toString(), solverAgent: SOLVER_AGENT,
      });
      let sequence = 0;
      const publishSolution = async (role: NativeSolutionArtifactRow['role'], bytes: Uint8Array, mediaType: string, name: string | null, family: string) => {
        sequence += 1;
        const digest = documentDigest(bytes);
        const createdAt = `2026-08-02T12:2${sequence}:00Z`;
        const artifact: NativeSolutionArtifactRow = { engagementId, role, family, mediaType, name, digest, bytes, createdAt };
        const publication: NativePublicationRow = {
          publicationKey: publicationKey({ sourceId: solutionPublisher.sourceId, role, recordDigest: digest, availabilityState: 'available' }),
          engagementId, sourceId: solutionPublisher.sourceId, role, recordDigest: digest,
          availability: 'available', status: 'intent', detail: {}, createdAt, updatedAt: createdAt,
        };
        await solutionPublisher.publish({ publication, artifact, bytes });
      };
      await publishSolution('output', outputBytes, task.outputs[0]!.mediaType ?? 'application/json', outputName, 'output');
      await publishSolution('evidence', solutionEvidenceBytes, EXECUTION_EVIDENCE_MEDIA_TYPE, 'solution-evidence', 'execution-evidence');
      await publishSolution('delivery', solutionDeliveryBytes, DELIVERY_MEDIA_TYPE, null, 'delivery');
      await publishSolution('delivery-envelope', solutionEnvelopeBytes, DSSE_ENVELOPE_MEDIA_TYPE, null, 'delivery-envelope');

      const evaluationId = deriveConsumerEvaluationId({ taskDigest: documentDigest(taskBytes), solutionDeliveryDigest, evaluatorAgent: EVALUATOR_AGENT });
      const material = {
        task: { name: 'task', digest: documentDigest(taskBytes), bytes: taskBytes },
        submission: { name: 'submission', digest: documentDigest(submissionBytes), bytes: submissionBytes },
        requesterEnvelope: { name: 'requester-envelope', digest: documentDigest(requesterEnvelopeBytes), bytes: requesterEnvelopeBytes },
        admissionReceipt: { name: 'admission-receipt', digest: documentDigest(receiptBytes), bytes: receiptBytes },
        delivery: { name: 'delivery', digest: solutionDeliveryDigest, bytes: solutionDeliveryBytes },
        deliveryEnvelope: { name: 'delivery-envelope', digest: documentDigest(solutionEnvelopeBytes), bytes: solutionEnvelopeBytes },
        evidenceRecords: [{ name: 'solution-evidence', digest: solutionEvidenceDigest, bytes: solutionEvidenceBytes }],
        results: [{ name: outputName, digest: outputDigest, bytes: outputBytes }],
        evaluationSpec: { name: 'evaluation-spec', digest: documentDigest(specBytes), bytes: specBytes },
      };
      const derived = deriveNativeEvaluation({ evaluationId, evaluatorAgent: EVALUATOR_AGENT, material, deadline: '2026-08-03T00:00:00Z' });
      const verdictStatement: ResultEvaluationStatement = {
        _type: 'https://in-toto.io/Statement/v1',
        subject: [
          { name: 'task', digest: { sha256: documentDigest(taskBytes).slice(7) } },
          { name: outputName, digest: { sha256: outputDigest.slice(7) } },
        ],
        predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
        predicate: {
          evaluatedAt: '2026-08-02T12:40:00Z', evaluator: { id: EVALUATOR_AGENT },
          evaluationSpecification: { name: 'evaluation-spec', digest: { sha256: documentDigest(specBytes).slice(7) } },
          taskSubject: 'task', resultSubjects: [outputName], verdict: 'pass',
          measurements: [{ name: 'integrity', value: true }, { name: 'resolved', value: true }],
        },
      };
      const verdictBytes = signedEnvelope(canonicalJsonBytes(verdictStatement), 'application/vnd.in-toto+json', evaluator);
      const verdictDigest = documentDigest(verdictBytes);
      const evaluationAttempt = 'urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as const;
      const evaluationEvidenceBytes = executionEvidence({
        attempt: evaluationAttempt, taskDigest: derived.taskDigest, resultDigest: verdictDigest, agent: EVALUATOR_AGENT,
      });
      const evaluationEvidenceDigest = documentDigest(evaluationEvidenceBytes);
      const evaluationDeliveryBytes = sealDelivery({
        protocol: task.protocol, attempt: evaluationAttempt, task: derived.taskDigest,
        outputs: [{ name: 'verdict', mediaType: 'application/vnd.in-toto+json', digest: { sha256: verdictDigest.slice(7) } }],
        executionIds: [evaluationAttempt],
        evidenceRecords: [{ family: 'execution-evidence', digest: evaluationEvidenceDigest }],
        outcome: 'fulfilled', createdAt: '2026-08-02T12:45:00Z',
      });
      const evaluationDeliveryDigest = documentDigest(evaluationDeliveryBytes);
      const evaluationEnvelopeBytes = signedEnvelope(evaluationDeliveryBytes, DELIVERY_MEDIA_TYPE, evaluator);
      let evaluationSequence = 0;
      const publishEvaluation = async (role: string, name: string, bytes: Uint8Array, mediaType: string) => {
        evaluationSequence += 1;
        const digest = documentDigest(bytes);
        const createdAt = `2026-08-02T12:${String(45 + evaluationSequence).padStart(2, '0')}:00Z`;
        const artifact: NativeEvaluationArtifactRow = { evaluationId, role, name, digest, bytes, mediaType, createdAt };
        const publication: NativeEvaluationPublicationRow = {
          publicationKey: publicationKey({ sourceId: evaluatorPublisher.sourceId, role, recordDigest: digest, availabilityState: 'available' }),
          evaluationId, sourceId: evaluatorPublisher.sourceId, role, recordDigest: digest, status: 'intent', detail: {}, createdAt,
        };
        await evaluatorPublisher.publish({ publication, artifact });
      };
      await publishEvaluation('evaluation-task', 'evaluation-task', derived.taskBytes, TASK_MEDIA_TYPE);
      await publishEvaluation('evaluation-submission', 'evaluation-submission', derived.submissionBytes, SUBMISSION_MEDIA_TYPE);
      await publishEvaluation('verdict', 'verdict', verdictBytes, 'application/vnd.in-toto+json');
      await publishEvaluation('evaluation-evidence', 'evaluation-evidence', evaluationEvidenceBytes, EXECUTION_EVIDENCE_MEDIA_TYPE);
      await publishEvaluation('evaluation-delivery', 'evaluation-delivery', evaluationDeliveryBytes, DELIVERY_MEDIA_TYPE);
      await publishEvaluation('evaluation-delivery-envelope', 'evaluation-delivery-envelope', evaluationEnvelopeBytes, DSSE_ENVELOPE_MEDIA_TYPE);

      const identities = {
        requester: requesterKeys.requester, admission: requesterKeys.admission, requesterSource: requesterKeys.source,
        executor, solverDeclaration, solverSource, evaluator, evaluatorDeclaration, evaluatorSource,
      };
      const trustFixture = createRealTrustFixture({
        bindings: [
          { agent: REQUESTER_AGENT, identity: identities.requester, scope: ['authorizations'], relationship: 'controls', voucher: 'requester', order: 1 },
          { agent: REQUESTER_AGENT, identity: identities.requesterSource, scope: [DISCOVERY_SIGNING_SCOPE], relationship: 'signs-for', voucher: 'requester', order: 2 },
          { agent: ADMISSION_AGENT, identity: identities.admission, scope: [ADMISSION_RECEIPT_TRUST_SCOPE], relationship: 'controls', voucher: 'admission', order: 3 },
          { agent: SOLVER_AGENT, identity: identities.solverDeclaration, scope: ['deliveries'], relationship: 'controls', voucher: 'solver', order: 4 },
          { agent: SOLVER_AGENT, identity: identities.executor, scope: ['deliveries'], relationship: 'signs-for', voucher: 'solver', order: 5 },
          { agent: SOLVER_AGENT, identity: identities.solverSource, scope: [DISCOVERY_SIGNING_SCOPE], relationship: 'signs-for', voucher: 'solver', order: 6 },
          { agent: EVALUATOR_AGENT, identity: identities.evaluatorDeclaration, scope: ['verdicts'], relationship: 'controls', voucher: 'evaluator', order: 7 },
          { agent: EVALUATOR_AGENT, identity: identities.evaluator, scope: ['deliveries', 'verdicts'], relationship: 'signs-for', voucher: 'evaluator', order: 8 },
          { agent: EVALUATOR_AGENT, identity: identities.evaluatorSource, scope: [DISCOVERY_SIGNING_SCOPE], relationship: 'signs-for', voucher: 'evaluator', order: 9 },
        ],
        sourceKeys: [
          { agent: REQUESTER_AGENT, identity: identities.requesterSource },
          { agent: SOLVER_AGENT, identity: identities.solverSource },
          { agent: EVALUATOR_AGENT, identity: identities.evaluatorSource },
        ],
        policies: {
          requester: { accepted: [REQUESTER_AGENT], requiredStrength: 'strong' },
          admission: { accepted: [ADMISSION_AGENT], requiredStrength: 'strong' },
          executor: { accepted: [SOLVER_AGENT], requiredStrength: 'strong' },
          evaluator: { accepted: [EVALUATOR_AGENT], requiredStrength: 'strong' },
        },
      });
      const transports = {
        requester: transport(REQUESTER_BASE, requester.handleDiscoveryRequest),
        solver: transport(SOLVER_BASE, solutionPublisher.handler),
        evaluator: transport(EVALUATOR_BASE, evaluatorPublisher.handler),
      };
      let consumer = await ConsumerState.open(consumerRoot);
      const verifier = createProtocolSourceVerifier({
        state: consumer, keys: trustFixture.keys, sigs: trustFixture.sigs,
        fresh: { isFresh: (refreshBy, now) => Date.parse(refreshBy) >= now.getTime() },
        now: () => new Date('2026-08-02T13:00:00Z'),
      });
      const syncInputs = [
        { endpoint: endpoint(SOURCES.requester, REQUESTER_BASE, 1), transport: transports.requester },
        { endpoint: endpoint(SOURCES.solver, SOLVER_BASE, 4), transport: transports.solver },
        { endpoint: endpoint(SOURCES.evaluator, EVALUATOR_BASE, 6), transport: transports.evaluator },
      ];
      for (const value of syncInputs) expect((await syncPublicSource({ ...value, state: consumer, verifier })).mode).toBe('cold');
      const roots = discoverNativeGraphRoots({
        state: consumer, runId: RUN_ID,
        sources: {
          requester: { source: SOURCES.requester, publicBaseUrl: REQUESTER_BASE },
          solver: { source: SOURCES.solver, publicBaseUrl: SOLVER_BASE },
          evaluator: { source: SOURCES.evaluator, publicBaseUrl: EVALUATOR_BASE },
        },
        actors: { solverAgent: SOLVER_AGENT, evaluatorAgent: EVALUATOR_AGENT },
      });
      const graph = await retrieveNativePublicGraph({ roots, state: consumer, transports });
      expect(graph.solution.evidence).toHaveLength(1);
      expect(graph.evaluation.evidence).toHaveLength(1);
      expect(submission.requester).toBe(REQUESTER_AGENT);
      expect(await trustFixture.trust.bindingResolver.resolveBinding(
        { key: identities.requester.keyId, agent: submission.requester },
        '2026-08-02T12:00:00Z',
      )).not.toBeNull();
      const transaction = (digit: string, blockNumber: string, blockTime: string) => ({
        hash: `0x${digit.repeat(64)}` as const, blockHash: `0x${digit.repeat(64)}` as const,
        blockNumber, finalizedBlock: '200', blockTime,
      });
      const report = await verifyNativeVertical({
        graph, state: consumer,
        authority: {
          requester: { key: identities.requester.keyId, sealingTime: '2026-08-02T12:00:00Z', address: REQUESTER_ADDRESS },
          admission: { key: identities.admission.keyId, effectiveTime: '2026-08-02T12:00:00Z' },
          executor: { key: identities.executor.keyId, agent: SOLVER_AGENT, declarationKey: identities.solverDeclaration.keyId, address: SOLVER_ADDRESS },
          evaluator: { key: identities.evaluator.keyId, agent: EVALUATOR_AGENT, declarationKey: identities.evaluatorDeclaration.keyId, address: EVALUATOR_ADDRESS },
        },
        trust: trustFixture.trust,
        taskCreated: {
          chainId: 84532, coordinator: CHAIN.taskCoordinator, taskId: TASK_ID.toString(), creator: REQUESTER_ADDRESS,
          taskDigest: documentDigest(taskBytes), canonical: true, finalized: true,
          maxClaims: 1, postingTerms: association.postingTerms,
          transaction: transaction('a', '100', '2026-08-02T12:05:00Z'),
        },
        solutionSettlement: {
          operationId: deriveConsumerSolutionSettlementId({ attempt, deliveryDigest: solutionDeliveryDigest }),
          attemptIndex: 0, attempt, deliveryDigest: solutionDeliveryDigest, canonical: true, finalized: true,
          transaction: transaction('b', '120', '2026-08-02T12:30:00Z'),
        },
        verdictSettlement: {
          operationId: deriveConsumerVerdictSettlementId({ evaluationAttempt, evaluationDeliveryDigest, verdictCode: VerdictCode.Pass }),
          evaluationAttempt, evaluationDeliveryDigest, verdictCode: VerdictCode.Pass, evaluator: EVALUATOR_ADDRESS,
          canonical: true, finalized: true, transaction: transaction('c', '140', '2026-08-02T12:50:00Z'),
        },
        packages: [{ package: '@jinn-network/record-discovery-client', version: '0.1.0', tarballDigest: `sha256:${'f'.repeat(64)}` }],
      });
      const written = await writeNativeVerticalVerificationReport({ state: consumer, report });
      expect(report.decisionGrade).toBe(true);
      expect(report.producerPrivatePaths).toEqual([]);
      expect(JSON.stringify(report)).not.toContain(producer.requester);
      expect(written.path.startsWith(consumerRoot)).toBe(true);
      consumer.close();

      consumer = await ConsumerState.open(consumerRoot);
      const returningVerifier = createProtocolSourceVerifier({
        state: consumer, keys: trustFixture.keys, sigs: trustFixture.sigs,
        fresh: { isFresh: (refreshBy, now) => Date.parse(refreshBy) >= now.getTime() },
        now: () => new Date('2026-08-02T13:01:00Z'),
      });
      for (const value of syncInputs) expect((await syncPublicSource({ ...value, state: consumer, verifier: returningVerifier })).mode).toBe('unchanged');
      consumer.close();
    } finally {
      await evaluatorPublisher.close();
      await solutionPublisher.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
