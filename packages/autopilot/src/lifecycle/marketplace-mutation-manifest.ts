import { isDeepStrictEqual } from 'node:util';
import {
  AutopilotAdoptionReceiptSchema,
  type AutopilotAdoptionReceipt,
} from '../../../sdk/src/autopilot-session.js';
import {
  updateAttemptManifest,
  type AttemptManifest,
  type MarketplaceAdoptionReceiptState,
  type MarketplaceTaskProvenance,
} from './attempt-workspace.js';
import type {
  MarketplaceMutationManifestReceiptPort,
} from './marketplace-mutation-adoption.js';
import { gitOid, isoTimestamp } from './types.js';

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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
