/**
 * Assembles the `NativeRoleAuthority` and the three settlement facts `verifyNativeVertical` needs,
 * entirely from (a) bytes already fetched into the public graph, (b) fresh Base Sepolia reads, and
 * (c) the public trust catalog. No role identifier is taken on faith from configuration: the four
 * signing keys come straight out of the DSSE envelopes the consumer already fetched and hashed;
 * the two settlement addresses come straight out of the chain observation; and both settlement
 * addresses are independently re-bound to their claimed agent via the trust catalog's ceremony
 * evidence (fail-closed) before being trusted anywhere in the report.
 */
import {
  deriveMarketplaceAttemptUri,
  type MarketplaceChainConfig,
} from '@jinn-network/marketplace-binding';
import { DeliveryRecordSchema } from '@jinn-network/task-execution-protocol';
import { parseExactDsseEnvelope } from '@jinn-network/trust-core';
import type { NativeTrustAuthority } from '../daemon/native-trust-catalog.js';
import type {
  ChainSolutionSettlementObservation,
  ChainVerdictSettlementObservation,
  NativeConsumerChainReader,
} from './chain-facts.js';
import type { NativePublicGraph } from './graph.js';
import { resolveSettlementAuthority } from './trust.js';
import {
  deriveConsumerSolutionSettlementId,
  deriveConsumerVerdictSettlementId,
  type NativeRoleAuthority,
  type SolutionSettlementFact,
  type TaskCreatedFact,
  type VerdictSettlementFact,
} from './verification.js';

export class NativeConsumerAuthorityError extends Error {
  override readonly name = 'NativeConsumerAuthorityError';
}

function envelopeSignerKeyId(bytes: Uint8Array, label: string): string {
  const envelope = parseExactDsseEnvelope(bytes);
  const signature = envelope.signatures[0];
  if (envelope.signatures.length !== 1 || signature?.keyid === undefined) {
    throw new NativeConsumerAuthorityError(`${label} envelope must carry exactly one keyed signature`);
  }
  return signature.keyid;
}

export interface NativeConsumerVerificationInputs {
  readonly authority: NativeRoleAuthority;
  readonly taskCreated: TaskCreatedFact;
  readonly solutionSettlement: SolutionSettlementFact;
  readonly verdictSettlement: VerdictSettlementFact;
}

/** With `maxClaims === 1` (canonical posting terms), exactly one attempt is ever settled. */
const SINGLE_ATTEMPT_INDEX = 0;

export async function deriveNativeConsumerVerificationInputs(input: {
  readonly graph: NativePublicGraph;
  readonly trust: NativeTrustAuthority;
  readonly chain: NativeConsumerChainReader;
  readonly chainConfig: MarketplaceChainConfig;
  readonly actors: {
    readonly solverAgent: string;
    readonly evaluatorAgent: string;
    readonly executorDeclarationKey: string;
    readonly evaluatorDeclarationKey: string;
  };
}): Promise<NativeConsumerVerificationInputs> {
  const { graph, trust, chain, chainConfig, actors } = input;
  const taskId = BigInt(graph.roots.requester.chain.taskId);

  const taskCreatedObservation = await chain.observeTaskCreated({
    coordinator: chainConfig.taskCoordinator,
    router: chainConfig.jinnRouter,
    taskId,
    transactionHash: graph.roots.requester.chain.transactionHash,
  });
  if (taskCreatedObservation.maxClaims !== 1) {
    throw new NativeConsumerAuthorityError('on-chain task does not carry canonical maxClaims=1');
  }
  const taskCreated: TaskCreatedFact = {
    chainId: chainConfig.chainId as 84532,
    coordinator: chainConfig.taskCoordinator,
    taskId: graph.roots.requester.chain.taskId,
    creator: taskCreatedObservation.creator,
    taskDigest: taskCreatedObservation.taskDigest,
    maxClaims: 1,
    postingTerms: taskCreatedObservation.postingTerms,
    canonical: true,
    finalized: true,
    transaction: taskCreatedObservation.transaction,
  };

  const solutionObservation = await chain.observeSolutionSettlement({
    router: chainConfig.jinnRouter,
    mechMarketplace: chainConfig.mechMarketplace,
    taskId,
    expectedAttemptIndex: SINGLE_ATTEMPT_INDEX,
  });
  // Fails closed unless the trust catalog independently binds this on-chain settlement address to
  // the solver agent -- the important side effect is the throw, not the returned digest.
  await resolveSettlementAuthority({
    trust,
    agent: actors.solverAgent,
    declarationKey: actors.executorDeclarationKey,
    address: solutionObservation.operator,
    atTime: solutionObservation.transaction.blockTime,
    purpose: 'native:solver-settlement',
  });
  const solutionAttempt = deriveMarketplaceAttemptUri({
    chainId: chainConfig.chainId, coordinator: chainConfig.taskCoordinator, taskId, attemptIndex: SINGLE_ATTEMPT_INDEX,
  });
  const solutionSettlement = solutionSettlementFact(solutionAttempt, solutionObservation);

  const verdictObservation = await chain.observeVerdictSettlement({
    router: chainConfig.jinnRouter,
    mechMarketplace: chainConfig.mechMarketplace,
    taskId,
    expectedAttemptIndex: SINGLE_ATTEMPT_INDEX,
  });
  await resolveSettlementAuthority({
    trust,
    agent: actors.evaluatorAgent,
    declarationKey: actors.evaluatorDeclarationKey,
    address: verdictObservation.evaluator,
    atTime: verdictObservation.transaction.blockTime,
    purpose: 'native:evaluator-settlement',
  });
  // The evaluation "attempt" is the evaluator's own idempotency key on the evaluation Delivery
  // record, not a marketplace-derived attempt URI -- read it straight from the already
  // digest-verified evaluation Delivery bytes the consumer fetched.
  const evaluationAttempt = DeliveryRecordSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(graph.evaluation.delivery.bytes)),
  ).attempt;
  const verdictSettlement = verdictSettlementFact(evaluationAttempt, verdictObservation);

  const authority: NativeRoleAuthority = {
    requester: {
      key: envelopeSignerKeyId(graph.requesterEnvelope.bytes, 'requester'),
      sealingTime: graph.roots.requester.chain.sealedAt,
      address: graph.roots.requester.chain.creator,
    },
    admission: {
      key: envelopeSignerKeyId(graph.admissionReceipt.bytes, 'admission receipt'),
      effectiveTime: graph.roots.requester.chain.sealedAt,
    },
    executor: {
      key: envelopeSignerKeyId(graph.solution.deliveryEnvelope.bytes, 'solution delivery'),
      agent: actors.solverAgent,
      declarationKey: actors.executorDeclarationKey,
      address: solutionObservation.operator,
    },
    evaluator: {
      key: envelopeSignerKeyId(graph.evaluation.deliveryEnvelope.bytes, 'evaluation delivery'),
      agent: actors.evaluatorAgent,
      declarationKey: actors.evaluatorDeclarationKey,
      address: verdictObservation.evaluator,
    },
  };

  return { authority, taskCreated, solutionSettlement, verdictSettlement };
}

function solutionSettlementFact(
  attempt: string,
  observation: ChainSolutionSettlementObservation,
): SolutionSettlementFact {
  return {
    operationId: deriveConsumerSolutionSettlementId({ attempt, deliveryDigest: observation.deliveryDigest }),
    attemptIndex: observation.attemptIndex,
    attempt,
    deliveryDigest: observation.deliveryDigest,
    canonical: true,
    finalized: true,
    transaction: observation.transaction,
  };
}

function verdictSettlementFact(
  evaluationAttempt: string,
  observation: ChainVerdictSettlementObservation,
): VerdictSettlementFact {
  return {
    operationId: deriveConsumerVerdictSettlementId({
      evaluationAttempt, evaluationDeliveryDigest: observation.evaluationDeliveryDigest, verdictCode: observation.verdictCode,
    }),
    evaluationAttempt,
    evaluationDeliveryDigest: observation.evaluationDeliveryDigest,
    verdictCode: observation.verdictCode as VerdictSettlementFact['verdictCode'],
    evaluator: observation.evaluator,
    canonical: true,
    finalized: true,
    transaction: observation.transaction,
  };
}
