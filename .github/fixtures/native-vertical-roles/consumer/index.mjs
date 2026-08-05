import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { ExecutionEvidenceDocumentSchema } from '@jinn-network/evidence-protocol';
import {
  ADMISSION_RECEIPT_ANNOTATION_URI,
  ADMISSION_RECEIPT_TRUST_SCOPE,
  VerdictCode,
  deriveMarketplaceAttemptUri,
  gateVerdictObservation,
} from '@jinn-network/marketplace-binding';
import { decodeWireEnvelopeForVerification } from '@jinn-network/record-discovery-client';
import {
  RECORD_DISCOVERY_VERSION,
  parseAnnouncementEntry,
  sealJson,
} from '@jinn-network/record-discovery-protocol';
import {
  EVALUATION_SPEC_FORMAT_URI,
  RESULT_EVALUATION_PREDICATE_TYPE,
  deriveEvaluationTask,
  sealEvaluationSpec,
} from '@jinn-network/task-execution-profiles';
import {
  DELIVERY_MEDIA_TYPE,
  SUBMISSION_MEDIA_TYPE,
  TASK_EXECUTION_PROTOCOL_URI,
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import {
  TRUST_KEY_BINDING_FORMAT,
  TRUST_KEY_BINDING_MEDIA_TYPE,
  canonicalJsonBytes,
  dssePreAuthEncoding,
  parseDsseEnvelope,
  sealDsseEnvelope,
  verifyEnvelopeBinding,
} from '@jinn-network/trust-core';
import { createBindingResolver } from '@jinn-network/trust-resolve';

const REQUESTER_AGENT = 'https://agents.example/packed-requester';
const ADMISSION_AGENT = 'https://agents.example/packed-admission';
const SOLVER_AGENT = 'https://agents.example/packed-solver';
const EVALUATOR_AGENT = 'https://agents.example/packed-evaluator';
const COORDINATOR = '0x3333333333333333333333333333333333333333';
const SOLVER_ADDRESS = '0x1111111111111111111111111111111111111111';
const EVALUATOR_ADDRESS = '0x2222222222222222222222222222222222222222';
const SEALED_AT = '2026-08-02T10:00:00Z';
const EVALUATED_AT = '2026-08-02T10:30:00Z';
const CLAIM_TIME = '2026-08-02T10:35:00Z';

function roleKey(label) {
  const pair = generateKeyPairSync('ed25519');
  return {
    keyid: `did:key:z6MkPacked${label}111111111111111111111111`,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
}

const keys = {
  requester: roleKey('Requester'),
  admission: roleKey('Admission'),
  executor: roleKey('Executor'),
  solverSettlement: roleKey('SolverSettlement'),
  evaluator: roleKey('Evaluator'),
  evaluatorSettlement: roleKey('EvaluatorSettlement'),
  discovery: roleKey('Discovery'),
};
const keysById = new Map(Object.values(keys).map((key) => [key.keyid, key]));

function signedEnvelope(payloadBytes, payloadType, key) {
  return sealDsseEnvelope({
    payloadBytes,
    payloadType,
    signatures: [{
      keyid: key.keyid,
      signature: new Uint8Array(sign(null, dssePreAuthEncoding(payloadType, payloadBytes), key.privateKey)),
    }],
  });
}

function dsseVerifier(bytes) {
  let envelope;
  try {
    envelope = parseDsseEnvelope(bytes);
  } catch {
    return { validSignerKeyids: [] };
  }
  const pae = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
  return {
    validSignerKeyids: envelope.signatures.flatMap((signature) => {
      const key = signature.keyid === undefined ? undefined : keysById.get(signature.keyid);
      return key !== undefined && verify(null, pae, key.publicKey, Buffer.from(signature.sig, 'base64'))
        ? [key.keyid]
        : [];
    }),
  };
}

const records = [];
const anchors = new Map();
function addBinding(agent, key, scope, relationship, order) {
  const anchorDigest = `sha256:${(order + 100).toString(16).padStart(64, '0')}`;
  const binding = {
    protocol: TRUST_KEY_BINDING_FORMAT,
    agent,
    key: {
      publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      keyid: key.keyid,
      algorithm: 'ed25519',
      didKey: key.keyid,
    },
    voucher: { kind: 'oidc-machine', subject: `machine:${agent}` },
    relationship,
    scope,
    validFrom: `2026-01-${String(order).padStart(2, '0')}T00:00:00Z`,
    ceremony: { type: 'oidc-machine', digest: `sha256:${'c'.repeat(64)}` },
    strength: 'strong',
    anchors: [{ digest: anchorDigest }],
  };
  const payload = canonicalJsonBytes(binding);
  records.push({
    binding,
    bindingDigest: documentDigest(payload),
    envelopeBytes: signedEnvelope(payload, TRUST_KEY_BINDING_MEDIA_TYPE, key),
  });
  anchors.set(anchorDigest, binding.validFrom);
}

addBinding(REQUESTER_AGENT, keys.requester, ['authorizations'], 'controls', 1);
addBinding(ADMISSION_AGENT, keys.admission, [ADMISSION_RECEIPT_TRUST_SCOPE], 'controls', 2);
addBinding(SOLVER_AGENT, keys.executor, ['deliveries'], 'signs-for', 3);
addBinding(SOLVER_AGENT, keys.solverSettlement, ['settlements'], 'controls', 4);
addBinding(EVALUATOR_AGENT, keys.evaluator, ['deliveries', 'verdicts'], 'signs-for', 5);
addBinding(EVALUATOR_AGENT, keys.evaluatorSettlement, ['settlements'], 'controls', 6);

const bindingResolver = createBindingResolver({
  bindings: {
    async listBindingsForAgent(agent) { return records.filter(({ binding }) => binding.agent === agent); },
    async listRevocationsForTargets() { return []; },
  },
  anchors: {
    async lookupAnchor(digest) {
      const anchorTime = anchors.get(digest);
      return anchorTime === undefined ? null : { digest, anchorTime };
    },
  },
  requireAnchors: true,
});
const witnessVerifier = { async verify1271Witness() { return { verified: false, reason: 'not used' }; } };

const evaluationSpec = sealEvaluationSpec({
  protocol: EVALUATION_SPEC_FORMAT_URI,
  semanticsVersion: '4',
  family: 'deterministic-process',
  grader: { uri: 'https://spec.jinn.network/graders/prediction-packed' },
  familyBlock: {
    image: { uri: 'https://spec.jinn.network/images/prediction-packed' },
    platform: 'linux/amd64',
    workspace: { root: '/workspace' },
    testMaterial: [],
    parser: { id: 'jinn.parser.prediction', version: '1.0.0', digest: `sha256:${'9'.repeat(64)}` },
    transitions: { failToPass: [], passToPass: [] },
    timeout: 60,
  },
  measurements: [{ name: 'passed', type: 'boolean', required: true }],
  verdictRule: { threshold: { measurement: 'passed', op: 'eq', value: true } },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
});
const taskBytes = sealTask({
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  profile: {
    uri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0',
    digest: { sha256: '1'.repeat(64) },
  },
  instructions: 'Return the pinned forecast.',
  outputs: [{ name: 'prediction', mediaType: 'application/json', required: true }],
  evaluation: { name: 'evaluation-spec.json', digest: { sha256: evaluationSpec.digest.slice(7) } },
});
const taskDigest = documentDigest(taskBytes);
const admissionStatement = {
  _type: 'https://in-toto.io/Statement/v1',
  subject: [
    { name: 'task.json', digest: { sha256: taskDigest.slice(7) } },
    { name: 'evaluation-spec.json', digest: { sha256: evaluationSpec.digest.slice(7) } },
  ],
  predicateType: 'https://spec.jinn.network/attestations/admission-receipt/v1',
  predicate: { issuer: ADMISSION_AGENT },
};
const admissionReceiptBytes = signedEnvelope(
  canonicalJsonBytes(admissionStatement),
  'application/vnd.in-toto+json',
  keys.admission,
);
const admissionReceiptDigest = documentDigest(admissionReceiptBytes);
const admissionReceipt = {
  name: 'admission-receipt',
  digest: { sha256: admissionReceiptDigest.slice(7) },
  uri: 'https://records.example/admission-receipt',
  mediaType: 'application/vnd.in-toto+json',
};
const submissionBytes = sealSubmission({
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  submission: 'urn:uuid:50000000-0000-4000-8000-000000000005',
  task: { name: 'task.json', digest: { sha256: taskDigest.slice(7) } },
  requester: REQUESTER_AGENT,
  idempotencyKey: 'packed-native-vertical',
  nonce: 'packed-native-vertical',
  deadline: '2026-08-03T00:00:00Z',
  annotations: { [ADMISSION_RECEIPT_ANNOTATION_URI]: admissionReceipt },
});
const submission = SubmissionRecordSchema.parse(JSON.parse(new TextDecoder().decode(submissionBytes)));
if (submission.capabilityGrants !== undefined) throw new Error('packed evaluation fixture is not grant-free');
const requesterEnvelopeBytes = signedEnvelope(submissionBytes, SUBMISSION_MEDIA_TYPE, keys.requester);

const resultBytes = serializeCanonicalJson({ probabilityYes: '0.750000', submittedAt: '2026-08-02T10:10:00Z' });
const resultDigest = documentDigest(resultBytes);
const attempt = deriveMarketplaceAttemptUri({ chainId: 84532, coordinator: COORDINATOR, taskId: 7n, attemptIndex: 0 });
const evidenceBytes = canonicalJsonBytes({
  '@context': {},
  '@graph': [
    { '@id': './', '@type': 'Dataset', mentions: [{ '@id': attempt }] },
    { '@id': attempt, '@type': ['CreateAction', 'prov:Activity'] },
  ],
});
ExecutionEvidenceDocumentSchema.parse(JSON.parse(new TextDecoder().decode(evidenceBytes)));
const evidenceDigest = documentDigest(evidenceBytes);
const solutionDeliveryBytes = sealDelivery({
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  attempt,
  task: taskDigest,
  outputs: [{ name: 'prediction', mediaType: 'application/json', digest: { sha256: resultDigest.slice(7) } }],
  evidenceRecords: [{ family: 'execution-evidence', digest: evidenceDigest }],
  outcome: 'fulfilled',
  createdAt: '2026-08-02T10:20:00Z',
});
const solutionDeliveryDigest = documentDigest(solutionDeliveryBytes);
const solutionDeliveryEnvelopeBytes = signedEnvelope(solutionDeliveryBytes, DELIVERY_MEDIA_TYPE, keys.executor);
const evaluationTask = deriveEvaluationTask({
  subjectTask: { name: 'task.json', digest: taskDigest },
  subjectDelivery: { name: 'delivery.json', digest: solutionDeliveryDigest },
  subjectResults: [{ name: 'prediction', digest: resultDigest }],
  evaluationSpecDigest: evaluationSpec.digest,
  admissionReceipt,
});
const evaluationSubmissionBytes = sealSubmission({
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  submission: 'urn:uuid:60000000-0000-4000-8000-000000000006',
  task: { name: 'evaluation-task.json', digest: { sha256: evaluationTask.digest.slice(7) } },
  requester: EVALUATOR_AGENT,
  idempotencyKey: 'packed-native-evaluation',
  nonce: 'packed-native-evaluation',
  deadline: '2026-08-03T00:00:00Z',
});
const evaluationSubmission = SubmissionRecordSchema.parse(
  JSON.parse(new TextDecoder().decode(evaluationSubmissionBytes)),
);
if (evaluationSubmission.capabilityGrants !== undefined) throw new Error('evaluator Submission carries requester grants');

const verdictStatement = {
  _type: 'https://in-toto.io/Statement/v1',
  subject: [
    { name: 'task.json', digest: { sha256: taskDigest.slice(7) } },
    { name: 'prediction', digest: { sha256: resultDigest.slice(7) } },
  ],
  predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
  predicate: {
    evaluatedAt: EVALUATED_AT,
    evaluator: { id: EVALUATOR_AGENT },
    evaluationSpecification: {
      name: 'evaluation-spec.json',
      digest: { sha256: evaluationSpec.digest.slice(7) },
    },
    taskSubject: 'task.json',
    resultSubjects: ['prediction'],
    verdict: 'pass',
    measurements: [{ name: 'passed', value: true }],
  },
};
const verdictBytes = signedEnvelope(canonicalJsonBytes(verdictStatement), 'application/vnd.in-toto+json', keys.evaluator);
const verdictDigest = documentDigest(verdictBytes);
const evaluationAttempt = 'urn:uuid:70000000-0000-4000-8000-000000000007';
const evaluationDeliveryBytes = sealDelivery({
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  attempt: evaluationAttempt,
  task: evaluationTask.digest,
  outputs: [{ name: 'verdict', mediaType: 'application/vnd.in-toto+json', digest: { sha256: verdictDigest.slice(7) } }],
  outcome: 'fulfilled',
  createdAt: '2026-08-02T10:31:00Z',
});
const evaluationDeliveryDigest = documentDigest(evaluationDeliveryBytes);
const evaluationDeliveryEnvelopeBytes = signedEnvelope(evaluationDeliveryBytes, DELIVERY_MEDIA_TYPE, keys.evaluator);

const exactRecords = {
  task: taskBytes,
  evaluationSpec: evaluationSpec.bytes,
  admissionReceipt: admissionReceiptBytes,
  submission: submissionBytes,
  requesterEnvelope: requesterEnvelopeBytes,
  result: resultBytes,
  executionEvidence: evidenceBytes,
  solutionDelivery: solutionDeliveryBytes,
  solutionDeliveryEnvelope: solutionDeliveryEnvelopeBytes,
  evaluationTask: evaluationTask.bytes,
  evaluationSubmission: evaluationSubmissionBytes,
  verdict: verdictBytes,
  evaluationDelivery: evaluationDeliveryBytes,
  evaluationDeliveryEnvelope: evaluationDeliveryEnvelopeBytes,
};
const recordManifest = Object.entries(exactRecords).map(([name, bytes]) => ({
  name,
  digest: documentDigest(bytes),
  byteLength: bytes.length,
}));
if (new Set(recordManifest.map(({ digest }) => digest)).size !== recordManifest.length) {
  throw new Error('packed exact-record graph contains duplicate digest identities');
}

for (const [label, envelopeBytes, key, agent, family, atTime] of [
  ['requester', requesterEnvelopeBytes, keys.requester, REQUESTER_AGENT, 'authorizations', SEALED_AT],
  ['admission', admissionReceiptBytes, keys.admission, ADMISSION_AGENT, ADMISSION_RECEIPT_TRUST_SCOPE, SEALED_AT],
  ['executor', solutionDeliveryEnvelopeBytes, keys.executor, SOLVER_AGENT, 'deliveries', '2026-08-02T10:20:00Z'],
  ['evaluator-delivery', evaluationDeliveryEnvelopeBytes, keys.evaluator, EVALUATOR_AGENT, 'deliveries', '2026-08-02T10:31:00Z'],
]) {
  const outcome = await verifyEnvelopeBinding({ envelopeBytes, key: key.keyid, agent, family, atTime }, {
    bindingResolver,
    witnessVerifier,
    dsseVerifier,
    policy: { accepted: [agent], requiredStrength: 'strong' },
  });
  if (!outcome.ok) throw new Error(`${label} binding failed: ${outcome.reason ?? 'unknown'}`);
}

const gate = await gateVerdictObservation({
  settlement: {
    subjectTask: { name: 'task.json', digest: taskDigest, bytes: taskBytes },
    subjectDelivery: { name: 'delivery.json', digest: solutionDeliveryDigest, bytes: solutionDeliveryBytes },
    subjectResults: [{ name: 'prediction', digest: resultDigest, bytes: resultBytes }],
    subjectSubmissionBytes: submissionBytes,
    evaluationSpecBytes: evaluationSpec.bytes,
    evaluationTaskBytes: evaluationTask.bytes,
  },
  admissionReceipt: { envelopeBytes: admissionReceiptBytes, signerKey: keys.admission.keyid, effectiveTime: SEALED_AT },
  requesterAuthentication: { envelopeBytes: requesterEnvelopeBytes, signerKey: keys.requester.keyid, sealingTime: SEALED_AT },
  verdict: {
    envelopeBytes: verdictBytes,
    signerKey: keys.evaluator.keyid,
    settlementDeclarationKey: keys.evaluatorSettlement.keyid,
    claimBlockTime: CLAIM_TIME,
    onChainVerdictCode: VerdictCode.Pass,
    solver: {
      address: SOLVER_ADDRESS,
      claimedAgent: SOLVER_AGENT,
      declarationKey: keys.solverSettlement.keyid,
      effectiveTime: '2026-08-02T10:20:00Z',
    },
    evaluatorAddress: EVALUATOR_ADDRESS,
  },
}, {
  bindingResolver,
  witnessVerifier,
  dsseVerifier,
  admissionAgentPolicy: { accepted: [ADMISSION_AGENT], requiredStrength: 'strong' },
  requesterPolicy: { accepted: [REQUESTER_AGENT], requiredStrength: 'strong' },
  evaluatorPolicy: { accepted: [EVALUATOR_AGENT], requiredStrength: 'strong' },
});
if (!gate.decisionGrade) {
  throw new Error(`packed named verdict gate failed: ${gate.failures.map(({ check }) => check).join(',')}`);
}

const discoveryEntry = parseAnnouncementEntry({
  protocol: RECORD_DISCOVERY_VERSION,
  source: { agent: REQUESTER_AGENT, name: 'requester' },
  sequence: '0000000000000001',
  previous: null,
  timestamp: SEALED_AT,
  announcements: [{
    announcementId: 'packed-requester-submission',
    action: 'available',
    record: { kind: 'https://spec.jinn.network/records/submission/1.0', digest: documentDigest(submissionBytes) },
  }],
});
const discoveryBytes = sealJson(discoveryEntry).bytes;
const discoveryEnvelopeBytes = signedEnvelope(
  discoveryBytes,
  'application/vnd.jinn.record-discovery.entry.v1+json',
  keys.discovery,
);
const decodedDiscovery = decodeWireEnvelopeForVerification(
  JSON.parse(new TextDecoder().decode(discoveryEnvelopeBytes)),
);
if (documentDigest(decodedDiscovery.payloadBytes) !== documentDigest(discoveryBytes)
  || !dsseVerifier(discoveryEnvelopeBytes).validSignerKeyids.includes(keys.discovery.keyid)) {
  throw new Error('packed signed discovery entry did not verify');
}

const parsedSolution = DeliveryRecordSchema.parse(JSON.parse(new TextDecoder().decode(solutionDeliveryBytes)));
const parsedEvaluation = DeliveryRecordSchema.parse(JSON.parse(new TextDecoder().decode(evaluationDeliveryBytes)));
if (parsedSolution.task !== taskDigest
  || parsedSolution.attempt !== attempt
  || parsedSolution.outputs[0]?.digest.sha256 !== resultDigest.slice(7)
  || parsedSolution.evidenceRecords?.[0]?.digest !== evidenceDigest
  || parsedEvaluation.task !== evaluationTask.digest
  || parsedEvaluation.outputs[0]?.digest.sha256 !== verdictDigest.slice(7)) {
  throw new Error('packed Delivery graph correspondence failed');
}

const solutionSettlementId = documentDigest(serializeCanonicalJson({
  v: 1,
  kind: 'solution-settlement',
  attempt,
  deliveryDigest: solutionDeliveryDigest,
}));
const verdictSettlementId = documentDigest(serializeCanonicalJson({
  v: 1,
  kind: 'verdict-settlement',
  evaluationAttempt,
  evaluationDeliveryDigest,
  verdictCode: VerdictCode.Pass,
}));
const report = {
  schemaVersion: 1,
  decisionGrade: true,
  checks: [
    'exact-record-digests',
    'grant-free-evaluation-submission',
    'requester-admission-executor-evaluator-bindings',
    'execution-evidence-graph',
    'solution-delivery-graph',
    'pair-fixed-evaluation-task',
    'signed-result-evaluation-statement',
    'evaluation-delivery-verdict-join',
    'decision-grade-verdict-gate',
    'signed-discovery-entry',
  ],
  records: recordManifest,
  bindings: records.map(({ binding, bindingDigest }) => ({
    agent: binding.agent,
    keyid: binding.key.keyid,
    relationship: binding.relationship,
    scope: binding.scope,
    bindingDigest,
  })),
  operations: { solutionSettlementId, verdictSettlementId },
  sourceHead: { sequence: discoveryEntry.sequence, entry: documentDigest(discoveryBytes) },
  producerPrivatePaths: [],
};
writeFileSync('native-vertical-verification.json', `${JSON.stringify(report)}\n`, 'utf8');

export const role = 'consumer';
