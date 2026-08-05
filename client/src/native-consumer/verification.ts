import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ADMISSION_RECEIPT_TRUST_SCOPE,
  VerdictCode,
  deriveMarketplaceAttemptUri,
  gateVerdictObservation,
  verdictCodeFromValue,
  type VerdictCode as VerdictCodeValue,
} from '@jinn-network/marketplace-binding';
import {
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  documentDigest,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import {
  ResultEvaluationStatementShape,
  type ResultEvaluationStatement,
} from '@jinn-network/task-execution-profiles';
import {
  authenticateRequester,
  parseExactDsseEnvelope,
  verifyEnvelopeBinding,
  type BindingResolver,
  type DsseChainVerifier,
  type PolicyCheckInput,
  type WitnessVerifier,
} from '@jinn-network/trust-core';
import type { NativePublicGraph } from './graph.js';
import type { ConsumerState } from './state.js';

type Digest = `sha256:${string}`;
type Hex = `0x${string}`;
const UINT256_MAX = (1n << 256n) - 1n;

export class NativeVerificationError extends Error {
  override readonly name = 'NativeVerificationError';
  constructor(readonly reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

export interface NativeRoleAuthority {
  readonly requester: { readonly key: string; readonly sealingTime: string; readonly address: Hex };
  readonly admission: { readonly key: string; readonly effectiveTime: string };
  readonly executor: {
    readonly key: string;
    readonly agent: string;
    readonly declarationKey: string;
    readonly address: Hex;
  };
  readonly evaluator: {
    readonly key: string;
    readonly agent: string;
    readonly declarationKey: string;
    readonly address: Hex;
  };
}

export interface FinalizedTransactionFact {
  readonly hash: Hex;
  readonly blockHash: Hex;
  readonly blockNumber: string;
  readonly finalizedBlock: string;
  readonly blockTime: string;
}

export interface TaskCreatedFact {
  readonly chainId: number;
  readonly coordinator: Hex;
  readonly taskId: string;
  readonly creator: Hex;
  readonly taskDigest: Digest;
  readonly maxClaims: 1;
  readonly postingTerms: NativePublicGraph['roots']['requester']['postingTerms'];
  readonly canonical: true;
  readonly finalized: true;
  readonly transaction: FinalizedTransactionFact;
}

export interface SolutionSettlementFact {
  readonly operationId: Digest;
  readonly attemptIndex: number;
  readonly attempt: string;
  readonly deliveryDigest: Digest;
  readonly canonical: true;
  readonly finalized: true;
  readonly transaction: FinalizedTransactionFact;
}

export interface VerdictSettlementFact {
  readonly operationId: Digest;
  readonly evaluationAttempt: string;
  readonly evaluationDeliveryDigest: Digest;
  readonly verdictCode: VerdictCodeValue;
  readonly evaluator: Hex;
  readonly canonical: true;
  readonly finalized: true;
  readonly transaction: FinalizedTransactionFact;
}

export interface ConsumerTrustPorts {
  readonly bindingResolver: BindingResolver;
  readonly witnessVerifier: WitnessVerifier;
  readonly dsseVerifier: DsseChainVerifier;
  readonly policies: {
    readonly requester: PolicyCheckInput;
    readonly admission: PolicyCheckInput;
    readonly executor: PolicyCheckInput;
    readonly evaluator: PolicyCheckInput;
  };
}

export interface PackageProvenance {
  readonly package: string;
  readonly version: string;
  readonly tarballDigest: Digest;
}

export interface NativeVerticalVerificationReport {
  readonly protocol: 'https://spec.jinn.network/reports/native-vertical-verification/v1';
  readonly runId: string;
  readonly decisionGrade: true;
  readonly sources: readonly {
    readonly agent: string;
    readonly name: string;
    readonly sequence: string;
    readonly entry: Digest;
  }[];
  readonly records: readonly { readonly name: string; readonly digest: Digest; readonly mediaType: string }[];
  readonly bindings: readonly {
    readonly role: 'requester' | 'admission' | 'executor' | 'evaluator';
    readonly key: string;
    readonly agent: string;
    readonly family: string;
    readonly effectiveTime: string;
    readonly bindingDigest: Digest;
  }[];
  readonly settlements: {
    readonly taskCreated: TaskCreatedFact;
    readonly solution: SolutionSettlementFact;
    readonly verdict: VerdictSettlementFact;
  };
  readonly packages: readonly PackageProvenance[];
  readonly producerPrivatePaths: readonly [];
}

type AuthorityTimeAnchor = NativePublicGraph['roots']['requester']['chain']['authorityTime'];

function authorityTimeAnchor(value: unknown, label: string): AuthorityTimeAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NativeVerificationError('authority-time-invalid', label);
  }
  const anchor = value as Record<string, unknown>;
  const members = ['blockHash', 'blockNumber', 'chainId', 'finalized', 'timestamp'];
  if (Object.keys(anchor).sort().join('|') !== members.join('|')
    || anchor.chainId !== 84532
    || anchor.finalized !== true
    || typeof anchor.blockNumber !== 'string'
    || !/^(?:0|[1-9][0-9]*)$/u.test(anchor.blockNumber)
    || typeof anchor.blockHash !== 'string'
    || !/^0x[a-fA-F0-9]{64}$/u.test(anchor.blockHash)
    || typeof anchor.timestamp !== 'string'
    || !Number.isFinite(Date.parse(anchor.timestamp))) {
    throw new NativeVerificationError('authority-time-invalid', label);
  }
  return anchor as unknown as AuthorityTimeAnchor;
}

function canonicalDigest(value: Parameters<typeof serializeCanonicalJson>[0]): Digest {
  return documentDigest(serializeCanonicalJson(value));
}

export function deriveConsumerSolutionSettlementId(input: {
  readonly attempt: string;
  readonly deliveryDigest: Digest;
}): Digest {
  return canonicalDigest({ v: 1, kind: 'solution-settlement', ...input });
}

export function deriveConsumerVerdictSettlementId(input: {
  readonly evaluationAttempt: string;
  readonly evaluationDeliveryDigest: Digest;
  readonly verdictCode: number;
}): Digest {
  if (!Number.isSafeInteger(input.verdictCode)) throw new NativeVerificationError('verdict-code-invalid');
  return canonicalDigest({
    v: 1,
    kind: 'verdict-settlement',
    evaluationAttempt: input.evaluationAttempt,
    evaluationDeliveryDigest: input.evaluationDeliveryDigest,
    verdictCode: input.verdictCode,
  });
}

function exactJson<T>(bytes: Uint8Array, parse: (value: unknown) => T, label: string): T {
  try {
    return parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (cause) {
    throw new NativeVerificationError('public-record-invalid', `${label}: ${String(cause)}`);
  }
}

function requireHex(value: string, label: string): void {
  if (!/^0x[a-fA-F0-9]{64}$/u.test(value)) throw new NativeVerificationError('chain-fact-invalid', label);
}

function requireAddress(value: string, label: string): void {
  if (!/^0x[a-fA-F0-9]{40}$/u.test(value)) throw new NativeVerificationError('chain-fact-invalid', label);
}

function requireFinalizedTransaction(fact: FinalizedTransactionFact, label: string): void {
  requireHex(fact.hash, `${label}.hash`);
  requireHex(fact.blockHash, `${label}.blockHash`);
  if (!/^\d+$/u.test(fact.blockNumber) || !/^\d+$/u.test(fact.finalizedBlock)
    || BigInt(fact.finalizedBlock) < BigInt(fact.blockNumber)) {
    throw new NativeVerificationError('settlement-not-finalized', label);
  }
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(fact.blockTime)) {
    throw new NativeVerificationError('chain-fact-invalid', `${label}.blockTime`);
  }
}

function canonicalPostingTermsSpend(
  value: NativePublicGraph['roots']['requester']['postingTerms'],
): bigint {
  const keys = [
    'allowSolverSelfEvaluation',
    'responseTimeoutSeconds',
    'solutionMaxDeliveryRateWei',
    'verdictMaxDeliveryRateWei',
  ];
  if (Object.keys(value).sort().join('|') !== keys.join('|') || value.allowSolverSelfEvaluation !== false) {
    throw new NativeVerificationError('task-created-correspondence-failed', 'posting terms');
  }
  const parse = (wire: string, label: string): bigint => {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(wire)) {
      throw new NativeVerificationError('task-created-correspondence-failed', label);
    }
    const parsed = BigInt(wire);
    if (parsed > UINT256_MAX) throw new NativeVerificationError('task-created-correspondence-failed', label);
    return parsed;
  };
  const solution = parse(value.solutionMaxDeliveryRateWei, 'solution rate');
  const verdict = parse(value.verdictMaxDeliveryRateWei, 'verdict rate');
  parse(value.responseTimeoutSeconds, 'response timeout');
  if (solution + verdict > UINT256_MAX) {
    throw new NativeVerificationError('task-created-correspondence-failed', 'intended spend overflow');
  }
  return solution + verdict;
}

function verdictStatement(bytes: Uint8Array): ResultEvaluationStatement {
  let envelope;
  try { envelope = parseExactDsseEnvelope(bytes); }
  catch (cause) { throw new NativeVerificationError('verdict-envelope-invalid', String(cause)); }
  try {
    return ResultEvaluationStatementShape.parse(JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(envelope.payloadBytes),
    ));
  } catch (cause) {
    throw new NativeVerificationError('verdict-statement-invalid', String(cause));
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireEnvelopePayload(envelopeBytes: Uint8Array, payloadBytes: Uint8Array, payloadType: string, label: string): void {
  let envelope;
  try { envelope = parseExactDsseEnvelope(envelopeBytes); }
  catch (cause) { throw new NativeVerificationError('public-envelope-invalid', `${label}: ${String(cause)}`); }
  if (envelope.payloadType !== payloadType || !equalBytes(envelope.payloadBytes, payloadBytes)) {
    throw new NativeVerificationError('public-envelope-payload-mismatch', label);
  }
}

function descriptorDigest(value: { readonly digest?: { readonly sha256?: string } }): Digest {
  const digest = value.digest?.sha256;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new NativeVerificationError('record-graph-digest-missing');
  }
  return `sha256:${digest}`;
}

function requireDeliveryGraph(input: {
  readonly delivery: ReturnType<typeof DeliveryRecordSchema.parse>;
  readonly outputs: readonly { readonly name: string; readonly digest: Digest }[];
  readonly evidence: readonly { readonly digest: Digest }[];
  readonly label: string;
}): void {
  const outputs = new Map(input.outputs.map(({ name, digest }) => [name.replace(/^solution-output:/u, ''), digest]));
  if (outputs.size !== input.delivery.outputs.length
    || input.delivery.outputs.some((value) => outputs.get(value.name) !== descriptorDigest(value))) {
    throw new NativeVerificationError('delivery-output-graph-mismatch', input.label);
  }
  const evidence = new Set(input.evidence.map(({ digest }) => digest));
  if (evidence.size !== (input.delivery.evidenceRecords?.length ?? 0)
    || (input.delivery.evidenceRecords ?? []).some(({ digest }) => !evidence.has(digest as Digest))) {
    throw new NativeVerificationError('delivery-evidence-graph-mismatch', input.label);
  }
}

async function requireBinding(input: {
  readonly role: 'requester' | 'admission' | 'executor' | 'evaluator';
  readonly key: string;
  readonly agent: string;
  readonly family: string;
  readonly effectiveTime: string;
  readonly ports: ConsumerTrustPorts;
}): Promise<NativeVerticalVerificationReport['bindings'][number]> {
  const resolved = await input.ports.bindingResolver.resolveBinding(
    { key: input.key, agent: input.agent }, input.effectiveTime,
  );
  if (resolved === null) throw new NativeVerificationError('binding-not-resolved', input.role);
  return {
    role: input.role,
    key: input.key,
    agent: input.agent,
    family: input.family,
    effectiveTime: input.effectiveTime,
    bindingDigest: resolved.bindingDigest,
  };
}

function packageProvenance(values: readonly PackageProvenance[]): readonly PackageProvenance[] {
  const names = new Set<string>();
  return [...values].sort((left, right) => left.package.localeCompare(right.package)).map((value) => {
    if (names.has(value.package) || !/^@jinn-network\/[a-z0-9-]+$/u.test(value.package)
      || value.version.length === 0 || !/^sha256:[a-f0-9]{64}$/u.test(value.tarballDigest)
      || /(?:file:|portal:|workspace:|\/Users\/|node_modules\/\.\.\/)/u.test(JSON.stringify(value))) {
      throw new NativeVerificationError('package-provenance-invalid', value.package);
    }
    names.add(value.package);
    return value;
  });
}

/** Independently verifies exact public bytes, time-scoped trust, the named gate, and both settlements. */
export async function verifyNativeVertical(input: {
  readonly graph: NativePublicGraph;
  readonly state: ConsumerState;
  readonly authority: NativeRoleAuthority;
  readonly trust: ConsumerTrustPorts;
  readonly taskCreated: TaskCreatedFact;
  readonly solutionSettlement: SolutionSettlementFact;
  readonly verdictSettlement: VerdictSettlementFact;
  readonly packages: readonly PackageProvenance[];
  readonly authorityTime: {
    verifyFinalized(anchor: AuthorityTimeAnchor): Promise<boolean>;
  };
}): Promise<NativeVerticalVerificationReport> {
  const submission = exactJson(input.graph.submission.bytes, (value) => SubmissionRecordSchema.parse(value), 'Submission');
  const solutionDelivery = exactJson(
    input.graph.solution.delivery.bytes, (value) => DeliveryRecordSchema.parse(value), 'solution Delivery',
  );
  const evaluationDelivery = exactJson(
    input.graph.evaluation.delivery.bytes, (value) => DeliveryRecordSchema.parse(value), 'evaluation Delivery',
  );
  const statement = verdictStatement(input.graph.evaluation.verdict.bytes);
  const verdictCode = verdictCodeFromValue(statement.predicate.verdict);
  const receiptEnvelope = parseExactDsseEnvelope(input.graph.admissionReceipt.bytes);
  const receiptStatement = exactJson(
    receiptEnvelope.payloadBytes,
    (value) => value as { predicate?: { authorityTime?: unknown } },
    'admission receipt',
  );
  const receiptAnchor = authorityTimeAnchor(receiptStatement.predicate?.authorityTime, 'admission receipt');
  const submissionAnchor = authorityTimeAnchor(
    submission.annotations?.['https://spec.jinn.network/annotations/authority-time/v1'],
    'Submission',
  );
  const sourceAnchor = input.graph.roots.requester.chain.authorityTime;
  const anchorDigest = (anchor: AuthorityTimeAnchor) => canonicalDigest(
    anchor as unknown as Parameters<typeof serializeCanonicalJson>[0],
  );
  if (anchorDigest(receiptAnchor) !== anchorDigest(sourceAnchor)
    || anchorDigest(submissionAnchor) !== anchorDigest(sourceAnchor)
    || Date.parse(sourceAnchor.timestamp) !== Date.parse(input.authority.requester.sealingTime)
    || Date.parse(sourceAnchor.timestamp) !== Date.parse(input.authority.admission.effectiveTime)) {
    throw new NativeVerificationError('authority-time-correspondence-failed');
  }
  if (!await input.authorityTime.verifyFinalized(sourceAnchor)) {
    throw new NativeVerificationError('authority-time-not-finalized');
  }

  for (const artifact of input.graph.all) {
    if (documentDigest(artifact.bytes) !== artifact.digest) {
      throw new NativeVerificationError('public-record-digest-mismatch', artifact.name);
    }
  }
  requireEnvelopePayload(
    input.graph.solution.deliveryEnvelope.bytes,
    input.graph.solution.delivery.bytes,
    'application/vnd.jinn.task-execution.delivery.v1+json',
    'solution Delivery',
  );
  requireEnvelopePayload(
    input.graph.evaluation.deliveryEnvelope.bytes,
    input.graph.evaluation.delivery.bytes,
    'application/vnd.jinn.task-execution.delivery.v1+json',
    'evaluation Delivery',
  );
  requireDeliveryGraph({
    delivery: solutionDelivery,
    outputs: input.graph.solution.outputs,
    evidence: input.graph.solution.evidence,
    label: 'solution',
  });
  requireDeliveryGraph({
    delivery: evaluationDelivery,
    outputs: [{ name: 'verdict', digest: input.graph.evaluation.verdict.digest }],
    evidence: input.graph.evaluation.evidence,
    label: 'evaluation',
  });

  const chainSpend = canonicalPostingTermsSpend(input.taskCreated.postingTerms);
  const signedSpend = canonicalPostingTermsSpend(input.graph.roots.requester.postingTerms);

  if (!input.taskCreated.canonical || !input.taskCreated.finalized
    || input.taskCreated.chainId !== input.graph.roots.requester.chain.chainId
    || input.taskCreated.coordinator.toLowerCase() !== input.graph.roots.requester.chain.coordinator.toLowerCase()
    || input.taskCreated.taskId !== input.graph.roots.requester.chain.taskId
    || input.taskCreated.taskDigest !== input.graph.task.digest
    || input.taskCreated.taskDigest !== input.graph.roots.requester.taskDigest
    || input.taskCreated.creator.toLowerCase() !== input.graph.roots.requester.chain.creator.toLowerCase()
    || input.taskCreated.creator.toLowerCase() !== input.authority.requester.address.toLowerCase()
    || input.taskCreated.transaction.hash.toLowerCase() !== input.graph.roots.requester.chain.transactionHash.toLowerCase()
    || Date.parse(input.graph.roots.requester.chain.sealedAt) !== Date.parse(input.authority.requester.sealingTime)
    || !/^\d+$/u.test(input.taskCreated.taskId)
    || input.taskCreated.maxClaims !== 1
    || input.taskCreated.postingTerms.solutionMaxDeliveryRateWei !== input.graph.roots.requester.postingTerms.solutionMaxDeliveryRateWei
    || input.taskCreated.postingTerms.verdictMaxDeliveryRateWei !== input.graph.roots.requester.postingTerms.verdictMaxDeliveryRateWei
    || input.taskCreated.postingTerms.responseTimeoutSeconds !== input.graph.roots.requester.postingTerms.responseTimeoutSeconds
    || input.taskCreated.postingTerms.allowSolverSelfEvaluation !== input.graph.roots.requester.postingTerms.allowSolverSelfEvaluation
    || chainSpend !== signedSpend
    || chainSpend.toString(10) !== input.graph.roots.requester.intendedSpendWei) {
    throw new NativeVerificationError('task-created-correspondence-failed');
  }
  requireAddress(input.taskCreated.coordinator, 'taskCreated.coordinator');
  requireAddress(input.taskCreated.creator, 'taskCreated.creator');
  requireFinalizedTransaction(input.taskCreated.transaction, 'taskCreated');

  const attempt = deriveMarketplaceAttemptUri({
    chainId: input.graph.roots.requester.chain.chainId,
    coordinator: input.graph.roots.requester.chain.coordinator,
    taskId: BigInt(input.graph.roots.requester.chain.taskId),
    attemptIndex: input.solutionSettlement.attemptIndex,
  });
  if (solutionDelivery.attempt !== attempt || input.solutionSettlement.attempt !== attempt
    || input.solutionSettlement.deliveryDigest !== input.graph.solution.delivery.digest
    || input.solutionSettlement.operationId !== deriveConsumerSolutionSettlementId({
      attempt, deliveryDigest: input.graph.solution.delivery.digest,
    })) {
    throw new NativeVerificationError('solution-settlement-correspondence-failed');
  }
  if (!input.solutionSettlement.canonical || !input.solutionSettlement.finalized) {
    throw new NativeVerificationError('settlement-not-finalized', 'solution');
  }
  requireFinalizedTransaction(input.solutionSettlement.transaction, 'solution');

  if (input.verdictSettlement.evaluationAttempt !== evaluationDelivery.attempt
    || input.verdictSettlement.evaluationDeliveryDigest !== input.graph.evaluation.delivery.digest
    || input.verdictSettlement.verdictCode !== verdictCode
    || input.verdictSettlement.evaluator.toLowerCase() !== input.authority.evaluator.address.toLowerCase()
    || input.verdictSettlement.operationId !== deriveConsumerVerdictSettlementId({
      evaluationAttempt: evaluationDelivery.attempt,
      evaluationDeliveryDigest: input.graph.evaluation.delivery.digest,
      verdictCode,
    })) {
    throw new NativeVerificationError('verdict-settlement-correspondence-failed');
  }
  if (!input.verdictSettlement.canonical || !input.verdictSettlement.finalized) {
    throw new NativeVerificationError('settlement-not-finalized', 'verdict');
  }
  requireFinalizedTransaction(input.verdictSettlement.transaction, 'verdict');

  const requester = await authenticateRequester({
    envelopeBytes: input.graph.requesterEnvelope.bytes,
    key: input.authority.requester.key,
    requesterAgent: submission.requester,
    sealingTime: input.authority.requester.sealingTime,
  }, {
    bindingResolver: input.trust.bindingResolver,
    witnessVerifier: input.trust.witnessVerifier,
    dsseVerifier: input.trust.dsseVerifier,
    policy: input.trust.policies.requester,
  });
  if (!requester.ok) throw new NativeVerificationError('requester-authentication-failed', requester.reason);

  const authorities = [
    {
      role: 'admission' as const,
      envelopeBytes: input.graph.admissionReceipt.bytes,
      key: input.authority.admission.key,
      agent: (() => {
        const envelope = parseExactDsseEnvelope(input.graph.admissionReceipt.bytes);
        const payload = exactJson(envelope.payloadBytes, (value) => value as { predicate?: { issuer?: unknown } }, 'receipt');
        if (typeof payload.predicate?.issuer !== 'string') throw new NativeVerificationError('admission-issuer-invalid');
        return payload.predicate.issuer;
      })(),
      family: ADMISSION_RECEIPT_TRUST_SCOPE,
      atTime: input.authority.admission.effectiveTime,
      policy: input.trust.policies.admission,
    },
    {
      role: 'executor' as const,
      envelopeBytes: input.graph.solution.deliveryEnvelope.bytes,
      key: input.authority.executor.key,
      agent: input.authority.executor.agent,
      family: 'deliveries',
      atTime: solutionDelivery.createdAt,
      policy: input.trust.policies.executor,
    },
    {
      role: 'evaluator' as const,
      envelopeBytes: input.graph.evaluation.deliveryEnvelope.bytes,
      key: input.authority.evaluator.key,
      agent: input.authority.evaluator.agent,
      family: 'deliveries',
      atTime: evaluationDelivery.createdAt,
      policy: input.trust.policies.evaluator,
    },
  ];
  for (const value of authorities) {
    const outcome = await verifyEnvelopeBinding({
      envelopeBytes: value.envelopeBytes,
      key: value.key,
      agent: value.agent,
      family: value.family,
      atTime: value.atTime,
    }, {
      bindingResolver: input.trust.bindingResolver,
      witnessVerifier: input.trust.witnessVerifier,
      dsseVerifier: input.trust.dsseVerifier,
      policy: value.policy,
    });
    if (!outcome.ok) throw new NativeVerificationError(`${value.role}-binding-failed`, outcome.reason);
  }

  const gate = await gateVerdictObservation({
    settlement: {
      subjectTask: { name: 'task', digest: input.graph.task.digest, bytes: input.graph.task.bytes },
      subjectDelivery: {
        name: 'delivery', digest: input.graph.solution.delivery.digest, bytes: input.graph.solution.delivery.bytes,
      },
      subjectResults: input.graph.solution.outputs.map((artifact) => ({
        name: artifact.name.replace(/^solution-output:/u, ''), digest: artifact.digest, bytes: artifact.bytes,
      })),
      subjectSubmissionBytes: input.graph.submission.bytes,
      evaluationSpecBytes: input.graph.evaluationSpec.bytes,
      evaluationTaskBytes: input.graph.evaluation.task.bytes,
    },
    admissionReceipt: {
      envelopeBytes: input.graph.admissionReceipt.bytes,
      signerKey: input.authority.admission.key,
      effectiveTime: input.authority.admission.effectiveTime,
    },
    requesterAuthentication: {
      envelopeBytes: input.graph.requesterEnvelope.bytes,
      signerKey: input.authority.requester.key,
      sealingTime: input.authority.requester.sealingTime,
    },
    verdict: {
      envelopeBytes: input.graph.evaluation.verdict.bytes,
      signerKey: input.authority.evaluator.key,
      settlementDeclarationKey: input.authority.evaluator.declarationKey,
      claimBlockTime: input.verdictSettlement.transaction.blockTime,
      onChainVerdictCode: input.verdictSettlement.verdictCode,
      solver: {
        address: input.authority.executor.address,
        claimedAgent: input.authority.executor.agent,
        declarationKey: input.authority.executor.declarationKey,
        effectiveTime: solutionDelivery.createdAt,
      },
      evaluatorAddress: input.verdictSettlement.evaluator,
    },
  }, {
    bindingResolver: input.trust.bindingResolver,
    witnessVerifier: input.trust.witnessVerifier,
    dsseVerifier: input.trust.dsseVerifier,
    admissionAgentPolicy: input.trust.policies.admission,
    evaluatorPolicy: input.trust.policies.evaluator,
    requesterPolicy: input.trust.policies.requester,
  });
  if (!gate.decisionGrade) {
    throw new NativeVerificationError('named-verdict-gate-failed', gate.failures.map(({ check }) => check).join(','));
  }

  const bindingInputs = [
    { role: 'requester' as const, key: input.authority.requester.key, agent: submission.requester,
      family: 'authorizations', effectiveTime: input.authority.requester.sealingTime },
    { role: 'admission' as const, key: input.authority.admission.key, agent: authorities[0]!.agent,
      family: ADMISSION_RECEIPT_TRUST_SCOPE, effectiveTime: input.authority.admission.effectiveTime },
    { role: 'executor' as const, key: input.authority.executor.key, agent: input.authority.executor.agent,
      family: 'deliveries', effectiveTime: solutionDelivery.createdAt },
    { role: 'evaluator' as const, key: input.authority.evaluator.key, agent: input.authority.evaluator.agent,
      family: 'verdicts', effectiveTime: statement.predicate.evaluatedAt },
  ];
  const bindings = await Promise.all(bindingInputs.map((value) => requireBinding({ ...value, ports: input.trust })));
  const sources = [
    input.graph.roots.requester.source.source,
    input.graph.roots.solution.source.source,
    input.graph.roots.evaluation.source.source,
  ].map((source) => {
    const checkpoint = input.state.checkpoint(source);
    if (checkpoint === undefined) throw new NativeVerificationError('source-not-synced', source.name);
    return { ...source, sequence: checkpoint.sequence, entry: checkpoint.entry };
  }).sort((left, right) => `${left.agent}\0${left.name}`.localeCompare(`${right.agent}\0${right.name}`));

  return {
    protocol: 'https://spec.jinn.network/reports/native-vertical-verification/v1',
    runId: input.graph.roots.runId,
    decisionGrade: true,
    sources,
    records: input.graph.all.map(({ name, digest, mediaType }) => ({ name, digest, mediaType }))
      .sort((left, right) => `${left.name}\0${left.digest}`.localeCompare(`${right.name}\0${right.digest}`)),
    bindings: bindings.sort((left, right) => left.role.localeCompare(right.role)),
    settlements: {
      taskCreated: input.taskCreated,
      solution: input.solutionSettlement,
      verdict: input.verdictSettlement,
    },
    packages: packageProvenance(input.packages),
    producerPrivatePaths: [],
  };
}

/** Writes the canonical deterministic report only inside the consumer-owned state directory. */
export async function writeNativeVerticalVerificationReport(input: {
  readonly state: ConsumerState;
  readonly report: NativeVerticalVerificationReport;
}): Promise<{ readonly path: string; readonly digest: Digest }> {
  const bytes = serializeCanonicalJson(input.report as unknown as Parameters<typeof serializeCanonicalJson>[0]);
  const path = join(input.state.rootDir, 'native-vertical-verification.json');
  const temporary = `${path}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'w', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
  return { path, digest: documentDigest(bytes) };
}

export { VerdictCode };
