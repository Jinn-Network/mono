import { rawCodecCidFromSha256Digest } from "@jinn-network/marketplace-binding";
import type { ObservationMarketplaceEvent } from "@jinn-network/marketplace-projector";
import {
  selfEvaluationSkip,
  type EvaluationSkipReason,
  type OperatorIdentity,
} from "./self-evaluation.js";

export interface FinalizedSolutionDeliveryObservation {
  /** Signed discovery source that supplied this exact chain observation. */
  readonly source: string;
  /** The caller must establish canonicality before the evaluator sees the observation. */
  readonly canonical: true;
  readonly event: Extract<ObservationMarketplaceEvent, { event: "SolutionDeliveryClaimed" }>;
}

export interface EvaluationOpportunity {
  readonly source: string;
  readonly canonical: true;
  readonly finality: "finalized";
  readonly chainId: number;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly solutionRequestId: `0x${string}`;
  readonly operatorAddress: string;
  /** Canonical raw-codec location for the externally advertised Delivery digest. */
  readonly deliveryCid: string;
  /** SHA-256 digest advertised by the finalized chain/projection correspondence. */
  readonly advertisedDeliveryDigest: `sha256:${string}`;
  readonly blockHash: `0x${string}`;
  readonly transactionHash: `0x${string}`;
  readonly logIndex: number;
}

export type EvaluationOpportunityMapping =
  | { readonly kind: "opportunity"; readonly opportunity: EvaluationOpportunity }
  | {
      readonly kind: "skipped";
      readonly reason: EvaluationSkipReason;
      readonly taskId: bigint;
      readonly attemptIndex: number;
    }
  | { readonly kind: "ignored"; readonly reason: "not-canonical" | "not-finalized" | "missing-delivery-digest" };

/**
 * Converts only a canonical, finalized solution-delivery observation into an inert evaluation
 * opportunity. It starts no loop, opens no venue, and performs no retrieval; later native
 * composition is responsible for subscribing and persisting this value.
 */
export function mapFinalizedSolutionDeliveryObservation(
  observation: FinalizedSolutionDeliveryObservation,
  identity: OperatorIdentity,
): EvaluationOpportunityMapping {
  if (!observation.canonical) return { kind: "ignored", reason: "not-canonical" };
  if (observation.event.derivation.finalityTier !== "finalized") {
    return { kind: "ignored", reason: "not-finalized" };
  }
  const facts = observation.event.facts as {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly requestId: `0x${string}`;
    readonly operator: string;
  };
  const skip = selfEvaluationSkip(identity, { operatorAddress: facts.operator });
  if (skip !== undefined) {
    return { kind: "skipped", reason: skip, taskId: facts.taskId, attemptIndex: facts.attemptIndex };
  }
  const advertisedDeliveryDigest = observation.event.projection.deliveryCorrespondence?.sha256Digest;
  if (advertisedDeliveryDigest === undefined) {
    return { kind: "ignored", reason: "missing-delivery-digest" };
  }
  const derivation = observation.event.derivation;
  return {
    kind: "opportunity",
    opportunity: {
      source: observation.source,
      canonical: true,
      finality: "finalized",
      chainId: derivation.chainId,
      taskId: facts.taskId,
      attemptIndex: facts.attemptIndex,
      solutionRequestId: facts.requestId,
      operatorAddress: facts.operator,
      deliveryCid: rawCodecCidFromSha256Digest(advertisedDeliveryDigest),
      advertisedDeliveryDigest,
      blockHash: derivation.blockHash,
      transactionHash: derivation.txHash,
      logIndex: derivation.logIndex,
    },
  };
}
