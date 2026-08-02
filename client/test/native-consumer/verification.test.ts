import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMISSION_RECEIPT_TRUST_SCOPE,
  VerdictCode,
  deriveMarketplaceAttemptUri,
} from '@jinn-network/marketplace-binding';
import {
  EVALUATION_SPEC_FORMAT_URI,
  RESULT_EVALUATION_PREDICATE_TYPE,
  deriveEvaluationTask,
  sealEvaluationSpec,
  type EvaluationSpec,
  type ResultEvaluationStatement,
} from '@jinn-network/task-execution-profiles';
import {
  DELIVERY_MEDIA_TYPE,
  SUBMISSION_MEDIA_TYPE,
  TASK_EXECUTION_PROTOCOL_URI,
  TASK_MEDIA_TYPE,
  DeliveryRecordSchema,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import {
  DSSE_ENVELOPE_MEDIA_TYPE,
  TRUST_KEY_BINDING_FORMAT,
  TRUST_REVOCATION_FORMAT,
  TRUST_REVOCATION_MEDIA_TYPE,
  canonicalJsonBytes,
  deriveStrength,
  dssePreAuthEncoding,
  parseExactDsseEnvelope,
  sealDsseEnvelope,
  type AnchorResolver,
  type DsseChainVerifier,
  type KeyBinding,
  type Revocation,
  type Sha256Digest,
} from '@jinn-network/trust-core';
import {
  createBindingResolver,
  type BindingStore,
  type SealedKeyBindingRecord,
  type SealedRevocationRecord,
} from '@jinn-network/trust-resolve';
import type { SourceIdentity } from '@jinn-network/record-discovery-protocol';
import { ConsumerState } from '../fixtures/native-vertical-consumer/src/state.js';
import type {
  ExactPublicArtifact,
  NativePublicGraph,
  NativeGraphRoots,
} from '../fixtures/native-vertical-consumer/src/graph.js';
import {
  NativeVerificationError,
  deriveConsumerSolutionSettlementId,
  deriveConsumerVerdictSettlementId,
  verifyNativeVertical,
  writeNativeVerticalVerificationReport,
  type ConsumerTrustPorts,
  type NativeRoleAuthority,
} from '../fixtures/native-vertical-consumer/src/verification.js';

const roots: string[] = [];
const NOW = '2026-08-02T12:00:00Z';
const EARLIER = '2026-08-02T10:00:00Z';
const REQUESTER_AGENT = 'https://agents.example/requester';
const ADMISSION_AGENT = 'https://agents.example/admission';
const SOLVER_AGENT = 'https://agents.example/solver';
const EVALUATOR_AGENT = 'https://agents.example/evaluator';
const SOLVER_ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const EVALUATOR_ADDRESS = '0x2222222222222222222222222222222222222222' as const;
const COORDINATOR = '0x3333333333333333333333333333333333333333' as const;
const CREATOR = '0x4444444444444444444444444444444444444444' as const;
const SOURCES = {
  requester: { agent: 'did:web:requester.example', name: 'requester' },
  solver: { agent: 'did:web:solver.example', name: 'solver' },
  evaluator: { agent: 'did:web:evaluator.example', name: 'evaluator' },
} satisfies Record<string, SourceIdentity>;

interface RoleKey { readonly id: string; readonly privateKey: KeyObject; readonly publicKey: KeyObject }

function roleKey(label: string): RoleKey {
  const pair = generateKeyPairSync('ed25519');
  return { id: `did:key:z6Mk${label}111111111111111111111111111111`, ...pair };
}

function envelope(payloadBytes: Uint8Array, payloadType: string, key: RoleKey): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes,
    payloadType,
    signatures: [{ keyid: key.id, signature: new Uint8Array(sign(null, dssePreAuthEncoding(payloadType, payloadBytes), key.privateKey)) }],
  });
}

function artifact(name: string, bytes: Uint8Array, mediaType: string): ExactPublicArtifact {
  return { name, bytes, mediaType, digest: documentDigest(bytes) };
}

function descriptor(value: ExactPublicArtifact, name = value.name) {
  return { name, digest: { sha256: value.digest.slice(7) }, mediaType: value.mediaType };
}

const SPEC: EvaluationSpec = {
  protocol: EVALUATION_SPEC_FORMAT_URI,
  semanticsVersion: '4',
  family: 'deterministic-process',
  grader: { uri: 'https://jinn.network/graders/prediction-golden' },
  familyBlock: {
    image: { uri: 'https://jinn.network/images/prediction-golden' },
    platform: 'linux/amd64', workspace: { root: '/workspace' }, testMaterial: [],
    parser: { id: 'jinn.parser.prediction', version: '1.0.0', digest: `sha256:${'9'.repeat(64)}` },
    transitions: { failToPass: [], passToPass: [] }, timeout: 60,
  },
  measurements: [{ name: 'passed', type: 'boolean', required: true }],
  verdictRule: { threshold: { measurement: 'passed', op: 'eq', value: true } },
  unscorable: [], evidenceConventions: { requiredRefs: [] },
};

function sourceRoot(source: SourceIdentity, publicBaseUrl: string) {
  return { source, publicBaseUrl };
}

function makeGraph(keys: Record<'requester' | 'admission' | 'executor' | 'evaluator', RoleKey>): NativePublicGraph {
  const sealedSpec = sealEvaluationSpec(SPEC);
  const evaluationSpec = artifact('evaluation-spec', sealedSpec.bytes, 'application/vnd.jinn.evaluation-spec.v1+json');
  const task = artifact('task', sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: { uri: 'https://jinn.network/task-profiles/prediction-forecast/1.0', digest: { sha256: '1'.repeat(64) } },
    instructions: 'Return the pinned prediction.',
    outputs: [{ name: 'result.txt', mediaType: 'text/plain', required: true }],
    evaluation: descriptor(evaluationSpec, 'evaluation-spec.json'),
  }), TASK_MEDIA_TYPE);
  const admissionStatement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [descriptor(task, 'task'), descriptor(evaluationSpec, 'evaluation-spec.json')],
    predicateType: 'https://jinn.network/attestations/admission-receipt/v1',
    predicate: { issuer: ADMISSION_AGENT },
  };
  const admissionReceipt = artifact('admission-receipt', envelope(
    canonicalJsonBytes(admissionStatement), 'application/vnd.in-toto+json', keys.admission,
  ), DSSE_ENVELOPE_MEDIA_TYPE);
  const submission = artifact('submission', sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: 'urn:uuid:50000000-0000-4000-8000-000000000005',
    task: descriptor(task, 'task'), requester: REQUESTER_AGENT,
    idempotencyKey: 'golden-run', nonce: 'golden-run', deadline: '2026-08-03T00:00:00Z',
    annotations: { 'https://jinn.network/annotations/admission-receipt/1.0': descriptor(admissionReceipt, 'admission-receipt') },
  }), SUBMISSION_MEDIA_TYPE);
  const requesterEnvelope = artifact(
    'requester-envelope', envelope(submission.bytes, SUBMISSION_MEDIA_TYPE, keys.requester), DSSE_ENVELOPE_MEDIA_TYPE,
  );
  const solutionAttempt = deriveMarketplaceAttemptUri({ chainId: 84532, coordinator: COORDINATOR, taskId: 7n, attemptIndex: 0 });
  const result = artifact('solution-output:result.txt', new TextEncoder().encode('pass\n'), 'text/plain');
  const solutionDelivery = artifact('solution-delivery', sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI, attempt: solutionAttempt, task: task.digest,
    outputs: [descriptor(result, 'result.txt')], outcome: 'fulfilled', createdAt: '2026-08-02T11:00:00Z',
  }), DELIVERY_MEDIA_TYPE);
  const solutionEnvelope = artifact(
    'solution-delivery-envelope', envelope(solutionDelivery.bytes, DELIVERY_MEDIA_TYPE, keys.executor), DSSE_ENVELOPE_MEDIA_TYPE,
  );
  const evaluationTask = artifact('evaluation-task', deriveEvaluationTask({
    subjectTask: { name: 'task', digest: task.digest },
    subjectDelivery: { name: 'delivery', digest: solutionDelivery.digest },
    subjectResults: [{ name: 'result.txt', digest: result.digest }],
    evaluationSpecDigest: evaluationSpec.digest,
    admissionReceipt: descriptor(admissionReceipt, 'admission-receipt'),
  }).bytes, TASK_MEDIA_TYPE);
  const evaluationId = documentDigest(serializeCanonicalJson({
    v: 1, kind: 'evaluation', subjectTaskDigest: task.digest,
    subjectDeliveryDigest: solutionDelivery.digest, evaluatorAgent: EVALUATOR_AGENT,
  }));
  const evaluationSubmission = artifact('evaluation-submission', sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: `urn:uuid:${evaluationId.slice(7, 15)}-${evaluationId.slice(15, 19)}-5${evaluationId.slice(20, 23)}-a${evaluationId.slice(24, 27)}-${evaluationId.slice(27, 39)}`,
    task: descriptor(evaluationTask, 'evaluation-task'), requester: EVALUATOR_AGENT,
    idempotencyKey: evaluationId, nonce: evaluationId, deadline: '2026-08-03T00:00:00Z',
  }), SUBMISSION_MEDIA_TYPE);
  const statement: ResultEvaluationStatement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [descriptor(task, 'task'), descriptor(result, 'result.txt')],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluatedAt: '2026-08-02T11:30:00Z', evaluator: { id: EVALUATOR_AGENT },
      evaluationSpecification: descriptor(evaluationSpec, 'evaluation-spec.json'),
      taskSubject: 'task', resultSubjects: ['result.txt'], verdict: 'pass',
      measurements: [{ name: 'passed', value: true }],
    },
  };
  const verdict = artifact('verdict', envelope(
    canonicalJsonBytes(statement), 'application/vnd.in-toto+json', keys.evaluator,
  ), 'application/vnd.in-toto+json');
  const evaluationAttempt = 'urn:uuid:60000000-0000-4000-8000-000000000006';
  const evaluationDelivery = artifact('evaluation-delivery', sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI, attempt: evaluationAttempt, task: evaluationTask.digest,
    outputs: [descriptor(verdict, 'verdict')], outcome: 'fulfilled', createdAt: '2026-08-02T11:35:00Z',
  }), DELIVERY_MEDIA_TYPE);
  const evaluationEnvelope = artifact(
    'evaluation-delivery-envelope', envelope(evaluationDelivery.bytes, DELIVERY_MEDIA_TYPE, keys.evaluator), DSSE_ENVELOPE_MEDIA_TYPE,
  );
  const roots: NativeGraphRoots = {
    runId: 'golden-run',
    requester: {
      source: sourceRoot(SOURCES.requester, 'https://requester.example'),
      submission: { digest: submission.digest, kind: 'submission', mediaType: submission.mediaType, locator: 'https://requester.example/record' },
      taskDigest: task.digest, requesterEnvelopeDigest: requesterEnvelope.digest, admissionReceiptDigest: admissionReceipt.digest,
      chain: { chainId: 84532, coordinator: COORDINATOR, taskId: '7' },
    },
    solution: {
      source: sourceRoot(SOURCES.solver, 'https://solver.example'), engagementId: `sha256:${'a'.repeat(64)}`,
      solverAgent: SOLVER_AGENT,
      delivery: { digest: solutionDelivery.digest, kind: 'delivery', mediaType: DELIVERY_MEDIA_TYPE, locator: 'https://solver.example/record' },
      deliveryEnvelope: { digest: solutionEnvelope.digest, kind: 'delivery-envelope', mediaType: DSSE_ENVELOPE_MEDIA_TYPE, locator: 'https://solver.example/envelope' },
    },
    evaluation: {
      source: sourceRoot(SOURCES.evaluator, 'https://evaluator.example'), evaluationId, evaluatorAgent: EVALUATOR_AGENT,
      task: { digest: evaluationTask.digest, kind: 'task', mediaType: TASK_MEDIA_TYPE, locator: 'https://evaluator.example/task' },
      submission: { digest: evaluationSubmission.digest, kind: 'submission', mediaType: SUBMISSION_MEDIA_TYPE, locator: 'https://evaluator.example/submission' },
      verdict: { digest: verdict.digest, kind: 'verdict', mediaType: verdict.mediaType, locator: 'https://evaluator.example/verdict' },
      delivery: { digest: evaluationDelivery.digest, kind: 'delivery', mediaType: DELIVERY_MEDIA_TYPE, locator: 'https://evaluator.example/delivery' },
      deliveryEnvelope: { digest: evaluationEnvelope.digest, kind: 'delivery-envelope', mediaType: DSSE_ENVELOPE_MEDIA_TYPE, locator: 'https://evaluator.example/envelope' },
      evidence: [],
    },
  };
  const all = [task, submission, evaluationSpec, admissionReceipt, requesterEnvelope, solutionDelivery,
    solutionEnvelope, result, evaluationTask, evaluationSubmission, verdict, evaluationDelivery, evaluationEnvelope];
  return {
    roots, task, submission, evaluationSpec, admissionReceipt, requesterEnvelope,
    solution: { delivery: solutionDelivery, deliveryEnvelope: solutionEnvelope, outputs: [result], evidence: [] },
    evaluation: { task: evaluationTask, submission: evaluationSubmission, verdict,
      delivery: evaluationDelivery, deliveryEnvelope: evaluationEnvelope, evidence: [] },
    all,
  };
}

function makeTrust(keys: Record<string, RoleKey>, input: { revokedRequester?: boolean; missingAnchors?: boolean } = {}): ConsumerTrustPorts {
  const records: SealedKeyBindingRecord[] = [];
  const anchors = new Map<Sha256Digest, string>();
  const binding = (agent: string, key: RoleKey, scope: string[], relationship: 'controls' | 'signs-for', order: number) => {
    const digest = `sha256:${order.toString(16).padStart(64, '0')}` as Sha256Digest;
    const anchor = `sha256:${(order + 100).toString(16).padStart(64, '0')}` as Sha256Digest;
    const value: KeyBinding = {
      protocol: TRUST_KEY_BINDING_FORMAT, agent,
      key: { publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), keyid: key.id, algorithm: 'ed25519', didKey: key.id },
      voucher: { kind: 'oidc-machine', subject: `machine:${agent}` },
      relationship, scope, validFrom: `2026-01-${String(order).padStart(2, '0')}T00:00:00Z`,
      ceremony: { type: 'oidc-machine', digest: `sha256:${'c'.repeat(64)}` }, strength: deriveStrength('oidc-machine'),
      anchors: [{ digest: anchor }],
    };
    records.push({ binding: value, bindingDigest: digest, envelopeBytes: envelope(canonicalJsonBytes(value), 'application/vnd.jinn.trust.key-binding.v1+json', key) });
    anchors.set(anchor, `2026-01-${String(order).padStart(2, '0')}T00:00:00Z`);
    return digest;
  };
  const requesterDigest = binding(REQUESTER_AGENT, keys.requester!, ['authorizations', 'bindings'], 'controls', 1);
  binding(ADMISSION_AGENT, keys.admission!, [ADMISSION_RECEIPT_TRUST_SCOPE], 'controls', 2);
  binding(SOLVER_AGENT, keys.solverDeclaration!, ['deliveries'], 'controls', 3);
  binding(SOLVER_AGENT, keys.executor!, ['deliveries'], 'signs-for', 4);
  binding(EVALUATOR_AGENT, keys.evaluatorDeclaration!, ['verdicts'], 'controls', 5);
  binding(EVALUATOR_AGENT, keys.evaluator!, ['deliveries', 'verdicts'], 'signs-for', 6);

  const revocations: SealedRevocationRecord[] = [];
  if (input.revokedRequester) {
    const anchor = `sha256:${'e'.repeat(64)}` as Sha256Digest;
    anchors.set(anchor, '2026-08-01T00:00:00Z');
    const revocation: Revocation = {
      protocol: TRUST_REVOCATION_FORMAT, target: requesterDigest, revokedBy: keys.requester!.id,
      effectiveFrom: '2026-08-01T00:00:00Z', anchors: [{ digest: anchor }],
    };
    revocations.push({ revocation, envelopeBytes: envelope(canonicalJsonBytes(revocation), TRUST_REVOCATION_MEDIA_TYPE, keys.requester!) });
  }
  const store: BindingStore = {
    async listBindingsForAgent(agent) { return records.filter(({ binding }) => binding.agent === agent); },
    async listRevocationsForTargets(targets) { return revocations.filter(({ revocation }) => targets.includes(revocation.target as Sha256Digest)); },
  };
  const anchorResolver: AnchorResolver = {
    async lookupAnchor(digest) {
      if (input.missingAnchors) return null;
      const anchorTime = anchors.get(digest);
      return anchorTime === undefined ? null : { digest, anchorTime };
    },
  };
  const resolver = createBindingResolver({ bindings: store, anchors: anchorResolver, requireAnchors: true });
  const keyMap = new Map(Object.values(keys).map((key) => [key.id, key.publicKey]));
  const dsseVerifier: DsseChainVerifier = (bytes) => {
    let parsed;
    try { parsed = parseExactDsseEnvelope(bytes); } catch { return { validSignerKeyids: [] }; }
    const pae = dssePreAuthEncoding(parsed.payloadType, parsed.payloadBytes);
    return { validSignerKeyids: parsed.signatures.flatMap((signature) => {
      if (signature.keyid === undefined) return [];
      const publicKey = keyMap.get(signature.keyid);
      const bytes = Buffer.from(signature.sig, 'base64');
      return publicKey !== undefined && verify(null, pae, publicKey, bytes) ? [signature.keyid] : [];
    }) };
  };
  return {
    bindingResolver: resolver,
    dsseVerifier,
    witnessVerifier: { async verify1271Witness() { return { verified: false, reason: 'no Safe witness configured' }; } },
    policies: {
      requester: { accepted: [REQUESTER_AGENT], requiredStrength: 'strong' },
      admission: { accepted: [ADMISSION_AGENT], requiredStrength: 'strong' },
      executor: { accepted: [SOLVER_AGENT], requiredStrength: 'strong' },
      evaluator: { accepted: [EVALUATOR_AGENT], requiredStrength: 'strong' },
    },
  };
}

async function fixture(options: { revokedRequester?: boolean; missingAnchors?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jinn-consumer-verification-'));
  roots.push(root);
  const state = await ConsumerState.open(root);
  for (const [index, source] of Object.values(SOURCES).entries()) {
    state.commitSource({
      source,
      head: { sequence: '0000000000000001', entry: `sha256:${String(index + 1).repeat(64)}` as Sha256Digest,
        issuedAt: NOW, refreshBy: '2026-08-03T00:00:00Z', envelope: '{}' }, entries: [],
    });
  }
  const keys = {
    requester: roleKey('Requester'), admission: roleKey('Admission'), executor: roleKey('Executor'),
    solverDeclaration: roleKey('SolverDeclaration'), evaluator: roleKey('Evaluator'),
    evaluatorDeclaration: roleKey('EvaluatorDeclaration'),
  };
  const graph = makeGraph(keys);
  const authority: NativeRoleAuthority = {
    requester: { key: keys.requester.id, sealingTime: NOW, address: CREATOR },
    admission: { key: keys.admission.id, effectiveTime: EARLIER },
    executor: { key: keys.executor.id, agent: SOLVER_AGENT, declarationKey: keys.solverDeclaration.id, address: SOLVER_ADDRESS },
    evaluator: { key: keys.evaluator.id, agent: EVALUATOR_AGENT, declarationKey: keys.evaluatorDeclaration.id, address: EVALUATOR_ADDRESS },
  };
  const solutionDelivery = DeliveryRecordSchema.parse(JSON.parse(new TextDecoder().decode(graph.solution.delivery.bytes)));
  const evaluationDelivery = DeliveryRecordSchema.parse(JSON.parse(new TextDecoder().decode(graph.evaluation.delivery.bytes)));
  const solutionOperation = deriveConsumerSolutionSettlementId({ attempt: solutionDelivery.attempt, deliveryDigest: graph.solution.delivery.digest });
  const verdictOperation = deriveConsumerVerdictSettlementId({
    evaluationAttempt: evaluationDelivery.attempt, evaluationDeliveryDigest: graph.evaluation.delivery.digest, verdictCode: VerdictCode.Pass,
  });
  const transaction = (digit: string, blockNumber: string) => ({
    hash: `0x${digit.repeat(64)}` as const, blockHash: `0x${digit.repeat(64)}` as const,
    blockNumber, finalizedBlock: '200', blockTime: '2026-08-02T11:40:00Z',
  });
  return {
    state, graph, authority, trust: makeTrust(keys, options),
    taskCreated: { chainId: 84532, coordinator: COORDINATOR, taskId: '7', creator: CREATOR,
      taskDigest: graph.task.digest, canonical: true as const, finalized: true as const, transaction: transaction('a', '100') },
    solutionSettlement: { operationId: solutionOperation, attemptIndex: 0, attempt: solutionDelivery.attempt,
      deliveryDigest: graph.solution.delivery.digest, canonical: true as const, finalized: true as const, transaction: transaction('b', '120') },
    verdictSettlement: { operationId: verdictOperation, evaluationAttempt: evaluationDelivery.attempt,
      evaluationDeliveryDigest: graph.evaluation.delivery.digest, verdictCode: VerdictCode.Pass, evaluator: EVALUATOR_ADDRESS,
      canonical: true as const, finalized: true as const, transaction: transaction('c', '140') },
    packages: [{ package: '@jinn-network/marketplace-binding', version: '0.1.0', tarballDigest: `sha256:${'f'.repeat(64)}` as const }],
  };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('independent native vertical verification', () => {
  it('runs real trust and named checks, binds all three finalized chain facts, and writes a deterministic report', async () => {
    const value = await fixture();
    const report = await verifyNativeVertical(value);
    expect(report.decisionGrade).toBe(true);
    expect(report.bindings.map(({ role }) => role)).toEqual(['admission', 'evaluator', 'executor', 'requester']);
    expect(report.settlements.taskCreated.taskDigest).toBe(value.graph.task.digest);
    expect(report.producerPrivatePaths).toEqual([]);
    const first = await writeNativeVerticalVerificationReport({ state: value.state, report });
    const firstBytes = await readFile(first.path);
    const second = await writeNativeVerticalVerificationReport({ state: value.state, report });
    expect(second.digest).toBe(first.digest);
    expect(await readFile(second.path)).toEqual(firstBytes);
    expect(firstBytes.toString()).not.toContain(value.state.rootDir);
    value.state.close();
  });

  it('fails when anchor-backed bindings are unavailable', async () => {
    const value = await fixture({ missingAnchors: true });
    await expect(verifyNativeVertical(value)).rejects.toMatchObject({ reason: 'requester-authentication-failed' });
    value.state.close();
  });

  it('fails an effective, cryptographically authorized revocation', async () => {
    const value = await fixture({ revokedRequester: true });
    await expect(verifyNativeVertical(value)).rejects.toMatchObject({ reason: 'requester-authentication-failed' });
    value.state.close();
  });

  it('fails missing policy authority and a non-finalized canonical root', async () => {
    const missingPolicy = await fixture();
    await expect(verifyNativeVertical({
      ...missingPolicy,
      trust: {
        ...missingPolicy.trust,
        policies: { ...missingPolicy.trust.policies, requester: { accepted: [], requiredStrength: 'strong' } },
      },
    })).rejects.toBeInstanceOf(NativeVerificationError);
    missingPolicy.state.close();

    const unfinalized = await fixture();
    const input = { ...unfinalized, taskCreated: { ...unfinalized.taskCreated, transaction: {
      ...unfinalized.taskCreated.transaction, finalizedBlock: '99',
    } } };
    await expect(verifyNativeVertical(input)).rejects.toMatchObject({ reason: 'settlement-not-finalized' });
    unfinalized.state.close();
  });

  it('fails fake DSSE signatures even when the key ID is present', async () => {
    const value = await fixture();
    const original = value.graph.requesterEnvelope;
    const parsed = parseExactDsseEnvelope(original.bytes);
    const forged = sealDsseEnvelope({ payloadType: parsed.payloadType, payloadBytes: parsed.payloadBytes,
      signatures: [{ keyid: parsed.signatures[0]!.keyid, signature: new Uint8Array([1, 2, 3]) }] });
    const graph = { ...value.graph, requesterEnvelope: artifact(original.name, forged, original.mediaType) };
    await expect(verifyNativeVertical({ ...value, graph })).rejects.toMatchObject({
      reason: 'requester-authentication-failed',
    });
    value.state.close();
  });
});
