import type {
  SettlementGradeVerification,
  SettlementPorts,
} from '@jinn-network/marketplace-binding';
import {
  DeliveryRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
} from '@jinn-network/task-execution-protocol';
import type { NativeOperatorStateRepository } from './native-operator-state.js';
import type { NativeSolutionVerificationPort } from './native-solution-coordinator.js';

function refused(detail: string): SettlementGradeVerification {
  return {
    executorBinding: { status: 'invalid', detail },
    dispatchBinding: { status: 'failed', detail },
    evaluationSpecification: { status: 'failed', detail },
  };
}

function parse(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Adapts the exact B6 graph verifier to venue-base's three-check settlement contract. */
export function buildNativeSettlementGrade(input: {
  readonly state: NativeOperatorStateRepository;
  readonly verification: NativeSolutionVerificationPort;
}): SettlementPorts['verifySettlementGrade'] {
  return async (candidate) => {
    const engagement = input.state.listEngagements().find((row) =>
      candidate.attempt.requestId !== undefined
        ? row.requestId?.toLowerCase() === candidate.attempt.requestId.toLowerCase()
        : row.taskId === candidate.attempt.taskId && row.attemptIndex === candidate.attempt.attemptIndex);
    if (engagement === undefined) return refused('no durable native engagement matches the settlement Attempt');
    const execution = input.state.getSolutionExecution(engagement.engagementId);
    if (execution === undefined
      || execution.dispatchContextDigest !== candidate.attempt.expectedDispatchContextDigest) {
      return refused('settlement Attempt does not bind the durable exact DispatchContext');
    }
    const artifacts = input.state.listSolutionArtifacts(engagement.engagementId);
    const one = (role: string) => {
      const rows = artifacts.filter((artifact) => artifact.role === role);
      return rows.length === 1 ? rows[0] : undefined;
    };
    const delivery = one('delivery');
    const envelope = one('delivery-envelope');
    if (delivery === undefined || envelope === undefined
      || delivery.digest !== candidate.deliveryDigest
      || documentDigest(candidate.deliveryBytes) !== candidate.deliveryDigest
      || !Buffer.from(delivery.bytes).equals(Buffer.from(candidate.deliveryBytes))) {
      return refused('settlement Delivery does not equal the durable exact Delivery graph');
    }
    let deliveryRecord;
    let task;
    try {
      deliveryRecord = DeliveryRecordSchema.parse(parse(delivery.bytes));
      task = TaskSpecificationSchema.parse(parse(execution.taskBytes));
    } catch (cause) {
      return refused(`durable settlement graph is invalid: ${String(cause)}`);
    }
    const evaluationDigest = task.evaluation?.digest?.sha256 === undefined
      ? undefined
      : `sha256:${task.evaluation.digest.sha256}` as const;
    if (candidate.attempt.taskEvaluationDigest !== evaluationDigest) {
      return refused('settlement EvaluationSpec digest does not equal the exact Task');
    }
    const decision = await input.verification.verify({
      engagement,
      effectiveTime: deliveryRecord.createdAt,
      taskBytes: execution.taskBytes,
      submissionBytes: execution.submissionBytes,
      dispatchContextBytes: execution.dispatchContextBytes,
      delivery: deliveryRecord,
      deliveryBytes: delivery.bytes,
      deliveryEnvelopeBytes: envelope.bytes,
      outputs: artifacts.filter((artifact) => artifact.role === 'output'),
      evidence: artifacts.filter((artifact) => artifact.role === 'evidence'),
    });
    if (!decision.ok) return refused(`native solution verification refused: ${decision.reason}`);
    return {
      executorBinding: { status: 'verified' },
      dispatchBinding: { status: 'verified' },
      evaluationSpecification: evaluationDigest === undefined
        ? { status: 'not-applicable' }
        : { status: 'verified' },
    };
  };
}
