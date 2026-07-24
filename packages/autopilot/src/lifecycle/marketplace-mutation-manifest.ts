import { isDeepStrictEqual } from 'node:util';
import {
  AutopilotAdoptionReceiptSchema,
  type AutopilotAdoptionReceipt,
} from '@jinn-network/sdk/autopilot';
import {
  readAttemptManifest,
  updateAttemptManifest,
  type AttemptManifest,
  type MarketplaceAdoptionReceiptState,
  type MarketplaceTaskProvenance,
} from './attempt-workspace.js';
import type {
  MarketplaceMutationManifestReceiptPort,
} from './marketplace-mutation-adoption.js';
import { gitOid, isoTimestamp } from './types.js';

export interface RecordMarketplaceSolutionDeliveryInput {
  readonly manifestPath: string;
  readonly taskId: string;
  readonly taskCid: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
  readonly deliveryTransactionHash: string;
  readonly deliveryBlockNumber: number;
  readonly solutionOperatorAddress: string;
  readonly solutionPublisherAgentId: string;
  readonly taskProvenance: MarketplaceTaskProvenance;
  readonly now?: () => Date;
}

export interface MarketplaceAdoptedReviewClaimIdentity {
  readonly attemptId: string;
  readonly manifestPath: string;
  readonly head: string;
  readonly generation: string;
  readonly refOid: string;
}

export interface RecordMarketplaceMutationAdoptionReceiptInput {
  readonly manifestPath: string;
  readonly receipt: AutopilotAdoptionReceipt;
  readonly commentId: number;
  readonly taskProvenance: MarketplaceTaskProvenance;
  readonly reviewClaim?: MarketplaceAdoptedReviewClaimIdentity;
  readonly now?: () => Date;
}

export interface LinkMarketplaceReviewAttemptInput {
  readonly originManifestPath: string;
  readonly reviewManifestPath: string;
  readonly reviewAttemptId: string;
  readonly expectedHead: string;
  readonly reviewGeneration: string;
  readonly reviewRefOid: string;
  readonly now?: () => Date;
}

export interface RecordMarketplaceVerdictDeliveryInput {
  readonly reviewManifestPath: string;
  readonly taskId: string;
  readonly taskCid: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
  readonly deliveryTransactionHash: string;
  readonly deliveryBlockNumber: number;
  readonly evaluatorOperatorAddress: string;
  readonly evaluatorPublisherAgentId: string;
  readonly taskProvenance: MarketplaceTaskProvenance;
  readonly now?: () => Date;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRANSACTION_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function recordMarketplaceSolutionDelivery(
  input: RecordMarketplaceSolutionDeliveryInput,
): AttemptManifest {
  if (
    input.taskId.length === 0
    || input.taskCid.length === 0
    || !Number.isSafeInteger(input.attemptIndex)
    || input.attemptIndex < 0
    || input.requestId.length === 0
    || input.deliveryEnvelopeCid.length === 0
    || !TRANSACTION_PATTERN.test(input.deliveryTransactionHash)
    || !Number.isSafeInteger(input.deliveryBlockNumber)
    || input.deliveryBlockNumber < 0
    || !/^0x[0-9a-fA-F]{40}$/.test(input.solutionOperatorAddress)
    || !/^[1-9][0-9]*$/.test(input.solutionPublisherAgentId)
    || !TRANSACTION_PATTERN.test(input.taskProvenance.creationTransactionHash)
    || !Number.isSafeInteger(input.taskProvenance.creationBlockNumber)
    || input.taskProvenance.creationBlockNumber < 0
    || input.deliveryBlockNumber < input.taskProvenance.creationBlockNumber
  ) {
    throw new Error('Marketplace Solution delivery provenance is invalid');
  }
  const timestamp = isoTimestamp(
    (input.now ?? (() => new Date()))().toISOString(),
  );
  return updateAttemptManifest(input.manifestPath, (manifest) => {
    const execution = manifest.execution;
    if (
      execution.backend !== 'marketplace'
      || manifest.processState !== 'running'
      || execution.taskId !== input.taskId
      || execution.taskCid !== input.taskCid
      || (
        execution.creationTransactionHash !== undefined
        && execution.creationTransactionHash
          !== input.taskProvenance.creationTransactionHash
      )
      || (
        execution.creationBlockNumber !== undefined
        && execution.creationBlockNumber
          !== input.taskProvenance.creationBlockNumber
      )
      || (
        execution.solverNetManifestCid !== undefined
        && execution.solverNetManifestCid
          !== input.taskProvenance.solverNetManifestCid
      )
    ) {
      throw new Error('Solution delivery does not match the marketplace attempt');
    }
    const current = {
      attemptIndex: execution.attemptIndex,
      requestId: execution.requestId,
      deliveryTx: execution.deliveryTx,
      deliveryBlockNumber: execution.deliveryBlockNumber,
      deliveryEnvelopeCid: execution.deliveryEnvelopeCid,
      solutionOperatorAddress: execution.solutionOperatorAddress,
      solutionPublisherAgentId: execution.solutionPublisherAgentId,
    };
    const next = {
      attemptIndex: input.attemptIndex,
      requestId: input.requestId,
      deliveryTx: input.deliveryTransactionHash,
      deliveryBlockNumber: input.deliveryBlockNumber,
      deliveryEnvelopeCid: input.deliveryEnvelopeCid,
      solutionOperatorAddress: input.solutionOperatorAddress,
      solutionPublisherAgentId: input.solutionPublisherAgentId,
    };
    const hasCurrent = Object.values(current).some(
      (value) => value !== undefined,
    );
    if (hasCurrent) {
      if (isDeepStrictEqual(current, next)) return manifest;
      throw new Error(
        'Attempt manifest already records a different marketplace delivery',
      );
    }
    return {
      ...manifest,
      execution: {
        ...execution,
        ...input.taskProvenance,
        ...next,
        solutionOperatorAddress: input.solutionOperatorAddress,
        solutionPublisherAgentId: input.solutionPublisherAgentId,
      },
      timestamps: {
        ...manifest.timestamps,
        updatedAt: timestamp,
      },
    };
  });
}

export function linkMarketplaceReviewAttemptToOriginTask(
  input: LinkMarketplaceReviewAttemptInput,
): AttemptManifest {
  const origin = readAttemptManifest(input.originManifestPath);
  const execution = origin.execution;
  if (
    origin.phase !== 'implement'
    || execution.backend !== 'marketplace'
    || execution.taskId === undefined
    || execution.taskCid === undefined
    || execution.deadline === undefined
    || execution.requestFile === undefined
    || execution.creationTransactionHash === undefined
    || execution.creationBlockNumber === undefined
    || execution.solutionOperatorAddress === undefined
    || execution.solutionPublisherAgentId === undefined
  ) {
    throw new Error('Origin marketplace Task is incomplete');
  }
  const timestamp = isoTimestamp(
    (input.now ?? (() => new Date()))().toISOString(),
  );
  return updateAttemptManifest(input.reviewManifestPath, (review) => {
    if (
      review.phase !== 'review'
      || review.attemptId !== input.reviewAttemptId
      || review.expectedHead !== input.expectedHead
      || review.reviewGeneration !== input.reviewGeneration
      || review.reviewRefOid !== input.reviewRefOid
      || review.processState === 'exited'
      || review.execution.backend !== 'marketplace'
    ) {
      throw new Error('Anchored review attempt does not match the origin Task');
    }
    const linkedExecution = {
      backend: 'marketplace' as const,
      taskId: execution.taskId,
      taskCid: execution.taskCid,
      deadline: execution.deadline,
      requestFile: execution.requestFile,
      creationTransactionHash: execution.creationTransactionHash,
      creationBlockNumber: execution.creationBlockNumber,
      ...(execution.solverNetManifestCid === undefined
        ? {}
        : { solverNetManifestCid: execution.solverNetManifestCid }),
      originManifestPath: input.originManifestPath,
      solutionOperatorAddress: execution.solutionOperatorAddress,
      solutionPublisherAgentId: execution.solutionPublisherAgentId,
    };
    if (review.processState === 'running') {
      if (!isDeepStrictEqual(review.execution, linkedExecution)) {
        throw new Error('Anchored review attempt already links a different Task');
      }
      return review;
    }
    return {
      ...review,
      execution: linkedExecution,
      processState: 'running',
      pid: null,
      timestamps: {
        ...review.timestamps,
        updatedAt: timestamp,
        childStartedAt: timestamp,
      },
    };
  });
}

export function recordMarketplaceVerdictDelivery(
  input: RecordMarketplaceVerdictDeliveryInput,
): AttemptManifest {
  if (
    input.taskId.length === 0
    || input.taskCid.length === 0
    || !Number.isSafeInteger(input.attemptIndex)
    || input.attemptIndex < 0
    || input.requestId.length === 0
    || input.deliveryEnvelopeCid.length === 0
    || !TRANSACTION_PATTERN.test(input.deliveryTransactionHash)
    || !Number.isSafeInteger(input.deliveryBlockNumber)
    || input.deliveryBlockNumber < input.taskProvenance.creationBlockNumber
    || !ADDRESS_PATTERN.test(input.evaluatorOperatorAddress)
    || !/^[1-9][0-9]*$/.test(input.evaluatorPublisherAgentId)
  ) {
    throw new Error('Marketplace Verdict delivery provenance is invalid');
  }
  const timestamp = isoTimestamp(
    (input.now ?? (() => new Date()))().toISOString(),
  );
  return updateAttemptManifest(input.reviewManifestPath, (manifest) => {
    const execution = manifest.execution;
    if (
      manifest.phase !== 'review'
      || manifest.processState !== 'running'
      || execution.backend !== 'marketplace'
      || execution.originManifestPath === undefined
      || execution.solutionOperatorAddress === undefined
      || execution.solutionPublisherAgentId === undefined
      || execution.taskId !== input.taskId
      || execution.taskCid !== input.taskCid
      || execution.creationTransactionHash
        !== input.taskProvenance.creationTransactionHash
      || execution.creationBlockNumber
        !== input.taskProvenance.creationBlockNumber
      || execution.solverNetManifestCid
        !== input.taskProvenance.solverNetManifestCid
      || execution.solutionOperatorAddress.toLowerCase()
        === input.evaluatorOperatorAddress.toLowerCase()
    ) {
      throw new Error('Verdict delivery does not match the anchored review Task');
    }
    const current = {
      attemptIndex: execution.attemptIndex,
      requestId: execution.requestId,
      deliveryTx: execution.deliveryTx,
      deliveryBlockNumber: execution.deliveryBlockNumber,
      deliveryEnvelopeCid: execution.deliveryEnvelopeCid,
    };
    const next = {
      attemptIndex: input.attemptIndex,
      requestId: input.requestId,
      deliveryTx: input.deliveryTransactionHash,
      deliveryBlockNumber: input.deliveryBlockNumber,
      deliveryEnvelopeCid: input.deliveryEnvelopeCid,
    };
    if (Object.values(current).some((value) => value !== undefined)) {
      if (isDeepStrictEqual(current, next)) return manifest;
      throw new Error('Review manifest already records a different Verdict delivery');
    }
    return {
      ...manifest,
      execution: {
        ...execution,
        ...next,
      },
      timestamps: {
        ...manifest.timestamps,
        updatedAt: timestamp,
      },
    };
  });
}

function receiptMatchesAttempt(
  receipt: AutopilotAdoptionReceipt,
  manifest: AttemptManifest,
): boolean {
  const execution = manifest.execution;
  return receipt.role === 'solution'
    && execution.backend === 'marketplace'
    && execution.taskId === receipt.taskId
    && execution.attemptIndex === receipt.attemptIndex
    && execution.requestId === receipt.requestId
    && execution.deliveryEnvelopeCid === receipt.deliveryEnvelopeCid
    && manifest.attemptId === receipt.v2AttemptId
    && manifest.claimOid === receipt.claimOid
    && manifest.prNumber === receipt.prNumber;
}

function validateReviewClaim(
  receipt: AutopilotAdoptionReceipt,
  reviewClaim: MarketplaceAdoptedReviewClaimIdentity | undefined,
): MarketplaceAdoptedReviewClaimIdentity | undefined {
  const receiptHasReview = receipt.reviewGeneration !== undefined
    || receipt.reviewRefOid !== undefined;
  if (
    receipt.disposition === 'accepted'
      ? reviewClaim === undefined
      : receiptHasReview !== (reviewClaim !== undefined)
  ) {
    throw new Error('Receipt review claim identity is missing or unexpected');
  }
  if (reviewClaim === undefined) return undefined;
  if (
    !UUID_PATTERN.test(reviewClaim.attemptId)
    || reviewClaim.attemptId === receipt.v2AttemptId
    || !reviewClaim.manifestPath.startsWith('/')
    || /[\u0000\r\n]/.test(reviewClaim.manifestPath)
    || reviewClaim.head !== receipt.resultingHead
    || reviewClaim.generation !== receipt.reviewGeneration
    || reviewClaim.refOid !== receipt.reviewRefOid
  ) {
    throw new Error('Receipt review claim identity does not match the receipt');
  }
  gitOid(reviewClaim.head);
  gitOid(reviewClaim.refOid);
  return reviewClaim;
}

function receiptState(
  receipt: AutopilotAdoptionReceipt,
  commentId: number,
  reviewClaim: MarketplaceAdoptedReviewClaimIdentity | undefined,
  taskProvenance: MarketplaceTaskProvenance,
  recordedAt: string,
): MarketplaceAdoptionReceiptState {
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    throw new Error('Receipt comment ID must be a positive integer');
  }
  return {
    schemaVersion: 'jinn-autopilot-marketplace-adoption-state.v1',
    role: 'solution',
    taskId: receipt.taskId,
    attemptIndex: receipt.attemptIndex,
    requestId: receipt.requestId,
    deliveryEnvelopeCid: receipt.deliveryEnvelopeCid,
    ...taskProvenance,
    disposition: receipt.disposition,
    commentId,
    ...(receipt.resultingHead === undefined
      ? {}
      : { resultingHead: receipt.resultingHead }),
    ...(reviewClaim === undefined
      ? {}
      : {
          reviewAttemptId: reviewClaim.attemptId,
          reviewManifestPath: reviewClaim.manifestPath,
          reviewGeneration: reviewClaim.generation,
          reviewRefOid: reviewClaim.refOid,
        }),
    recordedAt,
  };
}

export function recordMarketplaceMutationAdoptionReceipt(
  input: RecordMarketplaceMutationAdoptionReceiptInput,
): AttemptManifest {
  const parsed = AutopilotAdoptionReceiptSchema.parse(input.receipt);
  if (parsed.role !== 'solution') {
    throw new Error('Only a Solution adoption receipt belongs on a mutation attempt');
  }
  const reviewClaim = validateReviewClaim(parsed, input.reviewClaim);
  const canonicalReceipt = JSON.stringify(parsed);
  const timestamp = isoTimestamp((input.now ?? (() => new Date()))().toISOString());

  return updateAttemptManifest(input.manifestPath, (manifest) => {
    if (!receiptMatchesAttempt(parsed, manifest)) {
      throw new Error('Receipt does not match the marketplace attempt');
    }
    if (
      manifest.execution.backend !== 'marketplace'
      || manifest.execution.adoptionReceipt !== undefined
        && manifest.execution.adoptionReceipt !== canonicalReceipt
    ) {
      throw new Error('Attempt manifest already records a different adoption receipt');
    }
    const nextState = receiptState(
      parsed,
      input.commentId,
      reviewClaim,
      input.taskProvenance,
      timestamp,
    );
    if (manifest.execution.adoptionReceiptState !== undefined) {
      if (
        manifest.execution.adoptionReceipt === canonicalReceipt
        && isDeepStrictEqual(manifest.execution.adoptionReceiptState, {
          ...nextState,
          recordedAt: manifest.execution.adoptionReceiptState.recordedAt,
        })
      ) {
        return manifest;
      }
      throw new Error('Attempt manifest already records a different adoption receipt');
    }
    return {
      ...manifest,
      execution: {
        ...manifest.execution,
        ...input.taskProvenance,
        adoptionReceipt: canonicalReceipt,
        adoptionReceiptState: nextState,
      },
      timestamps: {
        ...manifest.timestamps,
        updatedAt: timestamp,
      },
    };
  });
}

export function makeMarketplaceMutationManifestReceiptPort(): MarketplaceMutationManifestReceiptPort {
  return {
    record(input) {
      recordMarketplaceMutationAdoptionReceipt({
        manifestPath: input.manifestPath,
        receipt: input.receipt,
        commentId: input.commentId,
        taskProvenance: input.taskProvenance,
        ...(input.reviewClaim === undefined
          ? {}
          : {
              reviewClaim: {
                attemptId: input.reviewClaim.attemptId,
                manifestPath: input.reviewClaim.manifest.paths.manifest,
                head: input.reviewClaim.head,
                generation: input.reviewClaim.generation,
                refOid: input.reviewClaim.refOid,
              },
            }),
      });
    },
  };
}
