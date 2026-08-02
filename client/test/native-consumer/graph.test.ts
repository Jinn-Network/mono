import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Transport } from '@jinn-network/record-discovery-client';
import {
  EVALUATION_SPEC_FORMAT_URI,
  deriveEvaluationTask,
  sealEvaluationSpec,
  type EvaluationSpec,
} from '@jinn-network/task-execution-profiles';
import {
  DELIVERY_MEDIA_TYPE,
  SUBMISSION_MEDIA_TYPE,
  TASK_MEDIA_TYPE,
  TASK_EXECUTION_PROTOCOL_URI,
  DeliveryRecordSchema,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from '@jinn-network/task-execution-protocol';
import { EXECUTION_EVIDENCE_MEDIA_TYPE } from '@jinn-network/evidence-protocol';
import {
  DSSE_ENVELOPE_MEDIA_TYPE,
  sealDsseEnvelope,
} from '@jinn-network/trust-core';
import {
  LOCATION_PROFILE_HTTPS,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  formatOrigin,
  recordPath,
  sealJson,
  type AnnouncementEntry,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import { ConsumerState } from '../fixtures/native-vertical-consumer/src/state.js';
import {
  NativeGraphError,
  deriveConsumerEngagementId,
  deriveConsumerEvaluationId,
  discoverNativeGraphRoots,
  retrieveNativePublicGraph,
  verifyExecutionEvidenceJoin,
  type NativeGraphRoots,
} from '../fixtures/native-vertical-consumer/src/graph.js';

const roots: string[] = [];
const REQUESTER: SourceIdentity = { agent: 'did:web:requester.example', name: 'requester' };
const SOLVER: SourceIdentity = { agent: 'did:web:solver.example', name: 'solver-records' };
const EVALUATOR: SourceIdentity = { agent: 'did:web:evaluator.example', name: 'evaluator-records' };
const SOLVER_AGENT = 'https://agents.example/solver';
const EVALUATOR_AGENT = 'https://agents.example/evaluator';
const DIGESTS = Object.fromEntries([
  'task', 'submission', 'requesterEnvelope', 'receipt', 'solutionDelivery', 'solutionEnvelope',
  'evaluationTask', 'evaluationSubmission', 'verdict', 'evaluationDelivery', 'evaluationEnvelope',
  'evaluationEvidence', 'unrelatedSolutionDelivery', 'unrelatedSolutionEnvelope', 'unrelatedEvaluationDelivery',
].map((name, index) => [name, `sha256:${(index + 1).toString(16).repeat(64)}`])) as Record<string, `sha256:${string}`>;

const EXPECTED_ENGAGEMENT_ID = deriveConsumerEngagementId({
  chainId: 84532,
  coordinator: '0x1111111111111111111111111111111111111111',
  taskId: '7',
  solverAgent: SOLVER_AGENT,
});
const EXPECTED_EVALUATION_ID = deriveConsumerEvaluationId({
  taskDigest: DIGESTS.task!,
  solutionDeliveryDigest: DIGESTS.solutionDelivery!,
  evaluatorAgent: EVALUATOR_AGENT,
});
const require = createRequire(import.meta.url);
const VALID_EVIDENCE = new Uint8Array(readFileSync(require.resolve(
  '@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json',
)));

function envelope(payloadBytes: Uint8Array, payloadType: string): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes,
    payloadType,
    signatures: [{ keyid: 'did:key:z6MkConsumerFixture', signature: new Uint8Array([1, 2, 3]) }],
  });
}

function evaluationSubmissionUri(id: `sha256:${string}`): `urn:uuid:${string}` {
  const value = id.slice(7, 39).split('');
  value[12] = '5';
  value[16] = ((Number.parseInt(value[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = value.join('');
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function state(): Promise<ConsumerState> {
  const root = await mkdtemp(join(tmpdir(), 'jinn-native-consumer-graph-'));
  roots.push(root);
  return ConsumerState.open(root);
}

function available(input: {
  source: SourceIdentity;
  records: readonly { kind: string; digest: `sha256:${string}`; mediaType?: string; role?: string; facts?: Record<string, unknown> }[];
  missingLocation?: boolean;
}): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: input.source,
    sequence: '0000000000000001',
    previous: null,
    timestamp: '2026-08-02T12:00:00.000Z',
    announcements: input.records.map((record, index) => ({
      announcementId: `${input.source.name}-${index}`,
      action: 'available' as const,
      record: { kind: record.kind, digest: record.digest, mediaType: record.mediaType ?? 'application/json' },
      ...(input.missingLocation ? {} : {
        locations: [{
          profile: LOCATION_PROFILE_HTTPS,
          locator: `https://${input.source.agent.slice('did:web:'.length)}${recordPath(record.digest)}`,
        }],
      }),
      facts: { ...(record.role === undefined ? {} : { role: record.role }), ...(record.facts ?? {}) },
    })),
  };
}

function commit(state: ConsumerState, entry: AnnouncementEntry): void {
  const digest = sealJson(entry).digest;
  state.commitSource({
    source: entry.source,
    head: {
      sequence: entry.sequence,
      entry: digest,
      issuedAt: entry.timestamp,
      refreshBy: '2026-08-03T12:00:00.000Z',
      envelope: '{"signed":"head"}',
    },
    entries: [{
      sequence: entry.sequence,
      digest,
      entryJson: new TextDecoder().decode(sealJson(entry).bytes),
      signatureJson: '{"signed":"entry"}',
    }],
  });
}

function seed(
  state: ConsumerState,
  missingRequesterLocation = false,
  associationOverrides: Record<string, unknown> = {},
): void {
  commit(state, available({
    source: REQUESTER,
    missingLocation: missingRequesterLocation,
    records: [{
      kind: RECORD_KINDS.submission,
      digest: DIGESTS.submission!,
      mediaType: SUBMISSION_MEDIA_TYPE,
      facts: {
        'https://jinn.network/facts/native-requester-association/1.0': {
          runId: 'golden-run', chainId: 84532,
          coordinator: '0x1111111111111111111111111111111111111111', taskId: '7',
          taskDigest: DIGESTS.task,
          submission: 'urn:uuid:00000000-0000-4000-8000-000000000001',
          nonce: 'nonce',
          postingTerms: {
            solutionMaxDeliveryRateWei: '2',
            verdictMaxDeliveryRateWei: '3',
            responseTimeoutSeconds: '60',
            allowSolverSelfEvaluation: false,
          },
          intendedSpendWei: '5',
          requesterEnvelopeDigest: DIGESTS.requesterEnvelope,
          admissionReceiptDigest: DIGESTS.receipt,
          ...associationOverrides,
        },
      },
    }],
  }));
  commit(state, available({
    source: SOLVER,
    records: [
      { kind: RECORD_KINDS.delivery, digest: DIGESTS.unrelatedSolutionDelivery!, mediaType: DELIVERY_MEDIA_TYPE, role: 'delivery', facts: { engagementId: `sha256:${'f'.repeat(64)}` } },
      { kind: 'https://jinn.network/records/delivery-envelope/1.0', digest: DIGESTS.unrelatedSolutionEnvelope!, mediaType: DSSE_ENVELOPE_MEDIA_TYPE, role: 'delivery-envelope', facts: { engagementId: `sha256:${'f'.repeat(64)}` } },
      { kind: RECORD_KINDS.delivery, digest: DIGESTS.solutionDelivery!, mediaType: DELIVERY_MEDIA_TYPE, role: 'delivery', facts: { engagementId: EXPECTED_ENGAGEMENT_ID } },
      { kind: 'https://jinn.network/records/delivery-envelope/1.0', digest: DIGESTS.solutionEnvelope!, mediaType: DSSE_ENVELOPE_MEDIA_TYPE, role: 'delivery-envelope', facts: { engagementId: EXPECTED_ENGAGEMENT_ID } },
    ],
  }));
  commit(state, available({
    source: EVALUATOR,
    records: [
      { kind: RECORD_KINDS.delivery, digest: DIGESTS.unrelatedEvaluationDelivery!, mediaType: DELIVERY_MEDIA_TYPE, role: 'evaluation-delivery', facts: { evaluationId: `sha256:${'e'.repeat(64)}` } },
      { kind: RECORD_KINDS.task, digest: DIGESTS.evaluationTask!, mediaType: TASK_MEDIA_TYPE, role: 'evaluation-task', facts: { evaluationId: EXPECTED_EVALUATION_ID } },
      { kind: RECORD_KINDS.submission, digest: DIGESTS.evaluationSubmission!, mediaType: SUBMISSION_MEDIA_TYPE, role: 'evaluation-submission', facts: { evaluationId: EXPECTED_EVALUATION_ID } },
      { kind: RECORD_KINDS.resultEvaluation, digest: DIGESTS.verdict!, mediaType: 'application/vnd.in-toto+json', role: 'verdict', facts: { evaluationId: EXPECTED_EVALUATION_ID } },
      { kind: RECORD_KINDS.delivery, digest: DIGESTS.evaluationDelivery!, mediaType: DELIVERY_MEDIA_TYPE, role: 'evaluation-delivery', facts: { evaluationId: EXPECTED_EVALUATION_ID } },
      { kind: 'https://jinn.network/records/delivery-envelope/1.0', digest: DIGESTS.evaluationEnvelope!, mediaType: DSSE_ENVELOPE_MEDIA_TYPE, role: 'evaluation-delivery-envelope', facts: { evaluationId: EXPECTED_EVALUATION_ID } },
      { kind: RECORD_KINDS.executionEvidence, digest: DIGESTS.evaluationEvidence!, mediaType: EXECUTION_EVIDENCE_MEDIA_TYPE, role: 'evaluation-evidence', facts: { evaluationId: EXPECTED_EVALUATION_ID } },
    ],
  }));
}

describe('native public graph discovery', () => {
  it('joins array-form mentions across multiple exact execution evidence documents', () => {
    const executionIds = [
      'urn:uuid:11111111-1111-4111-8111-111111111111',
      'urn:uuid:22222222-2222-4222-8222-222222222222',
    ] as const;
    const evidence = executionIds.map((executionId, index) => {
      const bytes = new TextEncoder().encode(JSON.stringify({
        '@context': {},
        '@graph': [
          { '@id': './', '@type': 'Dataset', mentions: [{ '@id': executionId }] },
          { '@id': executionId, '@type': ['CreateAction', 'prov:Activity'] },
        ],
      }));
      return { name: `evidence-${index}`, bytes, digest: documentDigest(bytes), mediaType: EXECUTION_EVIDENCE_MEDIA_TYPE };
    });
    const delivery = DeliveryRecordSchema.parse({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      attempt: 'urn:uuid:33333333-3333-4333-8333-333333333333',
      task: `sha256:${'3'.repeat(64)}`,
      outputs: [], outcome: 'fulfilled', executionIds, createdAt: '2026-08-02T00:00:00Z',
    });
    expect(() => verifyExecutionEvidenceJoin({ delivery, evidence, label: 'multi' })).not.toThrow();
  });
  it('selects one requester association and joins solver/evaluator records only through signed announcement facts', async () => {
    const consumer = await state();
    seed(consumer);
    const graph = discoverNativeGraphRoots({
      state: consumer,
      runId: 'golden-run',
      sources: {
        requester: { source: REQUESTER, publicBaseUrl: 'https://requester.example' },
        solver: { source: SOLVER, publicBaseUrl: 'https://solver.example' },
        evaluator: { source: EVALUATOR, publicBaseUrl: 'https://evaluator.example' },
      },
      actors: { solverAgent: SOLVER_AGENT, evaluatorAgent: EVALUATOR_AGENT },
    });

    expect(graph.requester).toMatchObject({
      submission: { digest: DIGESTS.submission },
      taskDigest: DIGESTS.task,
      requesterEnvelopeDigest: DIGESTS.requesterEnvelope,
      admissionReceiptDigest: DIGESTS.receipt,
      submissionUri: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      nonce: 'nonce',
      postingTerms: {
        solutionMaxDeliveryRateWei: '2', verdictMaxDeliveryRateWei: '3',
        responseTimeoutSeconds: '60', allowSolverSelfEvaluation: false,
      },
      intendedSpendWei: '5',
      chain: { chainId: 84532, taskId: '7' },
    });
    expect(graph.solution).toMatchObject({
      engagementId: EXPECTED_ENGAGEMENT_ID,
      delivery: { digest: DIGESTS.solutionDelivery },
      deliveryEnvelope: { digest: DIGESTS.solutionEnvelope },
    });
    expect(graph.evaluation).toMatchObject({
      evaluationId: EXPECTED_EVALUATION_ID,
      task: { digest: DIGESTS.evaluationTask },
      submission: { digest: DIGESTS.evaluationSubmission },
      verdict: { digest: DIGESTS.verdict },
      delivery: { digest: DIGESTS.evaluationDelivery },
      deliveryEnvelope: { digest: DIGESTS.evaluationEnvelope },
      evidence: [{ digest: DIGESTS.evaluationEvidence }],
    });
    consumer.close();
  });

  it.each([
    [{ intendedSpendWei: '-1' }, 'negative spend'],
    [{ intendedSpendWei: '6' }, 'wrong spend sum'],
    [{ postingTerms: {
      solutionMaxDeliveryRateWei: '02', verdictMaxDeliveryRateWei: '3',
      responseTimeoutSeconds: '60', allowSolverSelfEvaluation: false,
    } }, 'noncanonical term'],
    [{ postingTerms: {
      solutionMaxDeliveryRateWei: '2', verdictMaxDeliveryRateWei: '3',
      responseTimeoutSeconds: '60', allowSolverSelfEvaluation: true,
    } }, 'self evaluation'],
    [{ intendedSpendWei: `${1n << 256n}` }, 'uint256 overflow'],
  ] as const)('rejects requester association wire values that are %s', async (override) => {
    const consumer = await state();
    seed(consumer, false, override as Record<string, unknown>);
    expect(() => discoverNativeGraphRoots({
      state: consumer,
      runId: 'golden-run',
      sources: {
        requester: { source: REQUESTER, publicBaseUrl: 'https://requester.example' },
        solver: { source: SOLVER, publicBaseUrl: 'https://solver.example' },
        evaluator: { source: EVALUATOR, publicBaseUrl: 'https://evaluator.example' },
      },
      actors: { solverAgent: SOLVER_AGENT, evaluatorAgent: EVALUATOR_AGENT },
    })).toThrow(expect.objectContaining<Partial<NativeGraphError>>({ reason: 'public-record-fact-invalid' }));
    consumer.close();
  });

  it('rejects a primary public record whose signed announcement omits its public location', async () => {
    const consumer = await state();
    seed(consumer, true);
    expect(() => discoverNativeGraphRoots({
      state: consumer,
      runId: 'golden-run',
      sources: {
        requester: { source: REQUESTER, publicBaseUrl: 'https://requester.example' },
        solver: { source: SOLVER, publicBaseUrl: 'https://solver.example' },
        evaluator: { source: EVALUATOR, publicBaseUrl: 'https://evaluator.example' },
      },
      actors: { solverAgent: SOLVER_AGENT, evaluatorAgent: EVALUATOR_AGENT },
    })).toThrow(expect.objectContaining<Partial<NativeGraphError>>({ reason: 'public-record-location-missing' }));
    consumer.close();
  });

  it('retrieves every exact referenced byte through public digest endpoints and caches it independently', async () => {
    const consumer = await state();
    const f = retrievalFixture();
    const graph = await retrieveNativePublicGraph({
      roots: f.roots,
      state: consumer,
      transports: f.transports,
    });
    expect(graph.task.bytes).toEqual(f.bytes.task);
    expect(graph.evaluationSpec.bytes).toEqual(f.bytes.evaluationSpec);
    expect(graph.admissionReceipt.bytes).toEqual(f.bytes.admissionReceipt);
    expect(graph.requesterEnvelope.bytes).toEqual(f.bytes.requesterEnvelope);
    expect(graph.solution.outputs.map(({ bytes }) => bytes)).toEqual([f.bytes.solutionOutput]);
    expect(graph.solution.evidence.map(({ bytes }) => bytes)).toEqual([f.bytes.solutionEvidence]);
    expect(graph.evaluation.evidence.map(({ bytes }) => bytes)).toEqual([f.bytes.evaluationEvidence]);
    for (const artifact of graph.all) expect(consumer.record(artifact.digest)).toEqual(artifact.bytes);
    consumer.close();
  });

  it('rejects a signed association whose Submission URI or nonce differs from the exact public Submission', async () => {
    const consumer = await state();
    const f = retrievalFixture();
    for (const requester of [
      { ...f.roots.requester, submissionUri: 'urn:uuid:00000000-0000-4000-8000-000000000099' as const },
      { ...f.roots.requester, nonce: 'different' },
    ]) {
      await expect(retrieveNativePublicGraph({
        roots: { ...f.roots, requester },
        state: consumer,
        transports: f.transports,
      })).rejects.toMatchObject<Partial<NativeGraphError>>({ reason: 'submission-association-graph-mismatch' });
    }
    consumer.close();
  });

  it.each([
    ['missing', 'public-record-unavailable'],
    ['tampered', 'public-record-digest-mismatch'],
  ] as const)('fails closed when a public exact record is %s', async (failure, reason) => {
    const consumer = await state();
    const f = retrievalFixture({ failure });
    await expect(retrieveNativePublicGraph({
      roots: f.roots,
      state: consumer,
      transports: f.transports,
    })).rejects.toMatchObject<Partial<NativeGraphError>>({ reason });
    consumer.close();
  });

  it.each([
    ['wrong-requester-payload', 'public-envelope-payload-mismatch'],
    ['invalid-evidence', 'execution-evidence-invalid'],
    ['evaluation-task-mismatch', 'evaluation-task-pair-mismatch'],
    ['grant-bearing-evaluation', 'evaluation-submission-not-pair-fixed-grant-free'],
  ] as const)('fails closed on the %s graph adversary', async (failure, reason) => {
    const consumer = await state();
    const f = retrievalFixture({ failure });
    await expect(retrieveNativePublicGraph({
      roots: f.roots,
      state: consumer,
      transports: f.transports,
    })).rejects.toMatchObject<Partial<NativeGraphError>>({ reason });
    consumer.close();
  });
});

const spec: EvaluationSpec = {
  protocol: EVALUATION_SPEC_FORMAT_URI,
  semanticsVersion: '4',
  family: 'deterministic-process',
  grader: { uri: 'https://jinn.network/graders/native-consumer-test' },
  familyBlock: {
    image: { uri: 'https://jinn.network/images/native-consumer-test' },
    platform: 'linux/amd64', workspace: { root: '/workspace' }, testMaterial: [],
    parser: { id: 'native.consumer', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
    transitions: { failToPass: [], passToPass: [] }, timeout: 30,
  },
  measurements: [{ name: 'passed', type: 'boolean', required: true }],
  verdictRule: { threshold: { measurement: 'passed', op: 'eq', value: true } },
  unscorable: [], evidenceConventions: { requiredRefs: [] },
};

function retrievalFixture(options: { failure?:
  | 'missing'
  | 'tampered'
  | 'wrong-requester-payload'
  | 'invalid-evidence'
  | 'evaluation-task-mismatch'
  | 'grant-bearing-evaluation'
} = {}) {
  const evaluationSpec = sealEvaluationSpec(spec).bytes;
  const solutionOutput = new TextEncoder().encode('{"probabilityYes":"0.75"}');
  const solutionEvidence = options.failure === 'invalid-evidence'
    ? new TextEncoder().encode('{"@context":{},"@graph":[]}')
    : VALID_EVIDENCE;
  const task = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: { uri: 'https://jinn.network/task-profiles/prediction-forecast/1.0', digest: { sha256: '1'.repeat(64) } },
    instructions: 'forecast', outputs: [{ name: 'prediction', mediaType: 'application/json', required: true }],
    evaluation: { name: 'evaluation-spec', digest: { sha256: documentDigest(evaluationSpec).slice(7) } },
  });
  const admissionReceipt = envelope(
    new TextEncoder().encode('{"receipt":"exact"}'),
    'application/vnd.in-toto+json',
  );
  const submission = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    task: { digest: { sha256: documentDigest(task).slice(7) } },
    requester: 'https://agents.example/requester', idempotencyKey: 'consumer-test', nonce: 'nonce',
    deadline: '2026-08-03T00:00:00Z',
    annotations: {
      'https://jinn.network/annotations/admission-receipt/1.0': {
        name: 'admission-receipt', digest: { sha256: documentDigest(admissionReceipt).slice(7) },
      },
    },
  });
  const requesterEnvelope = envelope(
    options.failure === 'wrong-requester-payload' ? new TextEncoder().encode('{}') : submission,
    SUBMISSION_MEDIA_TYPE,
  );
  const solutionDelivery = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: 'urn:uuid:00000000-0000-4000-8000-000000000002', task: documentDigest(task),
    outputs: [{ name: 'prediction', mediaType: 'application/json', digest: { sha256: documentDigest(solutionOutput).slice(7) } }],
    evidenceRecords: [{ family: 'execution-evidence', digest: documentDigest(solutionEvidence) }],
    executionIds: ['urn:uuid:22222222-2222-4222-8222-222222222222'],
    outcome: 'fulfilled', createdAt: '2026-08-02T10:00:00Z',
  });
  const solutionEnvelope = envelope(solutionDelivery, DELIVERY_MEDIA_TYPE);
  const derivedEvaluationTask = deriveEvaluationTask({
    subjectTask: { name: 'task', digest: documentDigest(task) },
    subjectDelivery: { name: 'delivery', digest: documentDigest(solutionDelivery) },
    subjectResults: [{ name: 'prediction', digest: documentDigest(solutionOutput) }],
    evaluationSpecDigest: documentDigest(evaluationSpec),
    admissionReceipt: {
      name: 'admission-receipt',
      digest: { sha256: documentDigest(admissionReceipt).slice(7) },
    },
  }).bytes;
  const evaluationTask = options.failure === 'evaluation-task-mismatch'
    ? sealTask({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: { uri: 'https://jinn.network/task-profiles/evaluation-task/1.0', digest: { sha256: '2'.repeat(64) } },
      instructions: 'wrong pair', outputs: [{ name: 'verdict', mediaType: 'application/vnd.in-toto+json', required: true }],
    })
    : derivedEvaluationTask;
  const evaluationSubmission = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: evaluationSubmissionUri(EXPECTED_EVALUATION_ID),
    task: { digest: { sha256: documentDigest(evaluationTask).slice(7) } },
    requester: EVALUATOR_AGENT,
    idempotencyKey: EXPECTED_EVALUATION_ID,
    nonce: EXPECTED_EVALUATION_ID,
    deadline: '2026-08-03T00:00:00Z',
    ...(options.failure === 'grant-bearing-evaluation'
      ? { capabilityGrants: { 'urn:jinn:test:grant': {} } }
      : {}),
  });
  const verdict = envelope(new TextEncoder().encode('{"verdict":"exact"}'), 'application/vnd.in-toto+json');
  const evaluationEvidence = VALID_EVIDENCE;
  const evaluationDelivery = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: 'urn:uuid:00000000-0000-4000-8000-000000000004', task: documentDigest(evaluationTask),
    outputs: [{ name: 'verdict', digest: { sha256: documentDigest(verdict).slice(7) } }],
    evidenceRecords: [{ family: 'execution-evidence', digest: documentDigest(evaluationEvidence) }],
    executionIds: ['urn:uuid:22222222-2222-4222-8222-222222222222'],
    outcome: 'fulfilled', createdAt: '2026-08-02T11:00:00Z',
  });
  const evaluationEnvelope = envelope(evaluationDelivery, DELIVERY_MEDIA_TYPE);
  const bytes = {
    task, evaluationSpec, admissionReceipt, submission, requesterEnvelope,
    solutionOutput, solutionEvidence, solutionDelivery, solutionEnvelope,
    evaluationTask, evaluationSubmission, verdict, evaluationEvidence, evaluationDelivery, evaluationEnvelope,
  };
  const requesterBase = 'https://requester.example';
  const solverBase = 'https://solver.example';
  const evaluatorBase = 'https://evaluator.example';
  const located = (base: string, value: Uint8Array, kind: string, mediaType: string) => ({
    digest: documentDigest(value), kind, mediaType, locator: `${base}${recordPath(documentDigest(value))}`,
  });
  const roots: NativeGraphRoots = {
    runId: 'golden-run',
    requester: {
      source: { source: REQUESTER, publicBaseUrl: requesterBase },
      submission: located(requesterBase, submission, RECORD_KINDS.submission, SUBMISSION_MEDIA_TYPE),
      taskDigest: documentDigest(task), requesterEnvelopeDigest: documentDigest(requesterEnvelope),
      admissionReceiptDigest: documentDigest(admissionReceipt),
      submissionUri: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      nonce: 'nonce',
      postingTerms: {
        solutionMaxDeliveryRateWei: '2', verdictMaxDeliveryRateWei: '3',
        responseTimeoutSeconds: '60', allowSolverSelfEvaluation: false,
      },
      intendedSpendWei: '5',
      chain: { chainId: 84532, coordinator: '0x1111111111111111111111111111111111111111', taskId: '7' },
    },
    solution: {
      source: { source: SOLVER, publicBaseUrl: solverBase },
      engagementId: EXPECTED_ENGAGEMENT_ID, solverAgent: SOLVER_AGENT,
      delivery: located(solverBase, solutionDelivery, RECORD_KINDS.delivery, DELIVERY_MEDIA_TYPE),
      deliveryEnvelope: located(solverBase, solutionEnvelope, 'https://jinn.network/records/delivery-envelope/1.0', DSSE_ENVELOPE_MEDIA_TYPE),
    },
    evaluation: {
      source: { source: EVALUATOR, publicBaseUrl: evaluatorBase },
      evaluationId: EXPECTED_EVALUATION_ID, evaluatorAgent: EVALUATOR_AGENT,
      task: located(evaluatorBase, evaluationTask, RECORD_KINDS.task, TASK_MEDIA_TYPE),
      submission: located(evaluatorBase, evaluationSubmission, RECORD_KINDS.submission, SUBMISSION_MEDIA_TYPE),
      verdict: located(evaluatorBase, verdict, RECORD_KINDS.resultEvaluation, 'application/vnd.in-toto+json'),
      delivery: located(evaluatorBase, evaluationDelivery, RECORD_KINDS.delivery, DELIVERY_MEDIA_TYPE),
      deliveryEnvelope: located(evaluatorBase, evaluationEnvelope, 'https://jinn.network/records/delivery-envelope/1.0', DSSE_ENVELOPE_MEDIA_TYPE),
      evidence: [located(evaluatorBase, evaluationEvidence, RECORD_KINDS.executionEvidence, EXECUTION_EVIDENCE_MEDIA_TYPE)],
    },
  };
  const routes = (base: string, values: readonly Uint8Array[]): Transport => ({
    async fetch(url) {
      const found = values.find((value) => `${base}${recordPath(documentDigest(value))}` === url);
      if (found === undefined) throw new Error('not found');
      if ((options.failure === 'missing' || options.failure === 'tampered') && found === solutionDelivery) {
        if (options.failure === 'missing') throw new Error('missing');
        return { status: 200, bytes: new TextEncoder().encode('tampered') };
      }
      return { status: 200, bytes: found };
    },
  });
  return {
    bytes,
    roots,
    transports: {
      requester: routes(requesterBase, [task, evaluationSpec, admissionReceipt, submission, requesterEnvelope]),
      solver: routes(solverBase, [solutionOutput, solutionEvidence, solutionDelivery, solutionEnvelope]),
      evaluator: routes(evaluatorBase, [evaluationTask, evaluationSubmission, verdict, evaluationEvidence, evaluationDelivery, evaluationEnvelope]),
    },
  };
}
