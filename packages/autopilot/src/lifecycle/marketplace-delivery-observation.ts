/**
 * Port shapes for marketplace delivery observation.
 *
 * These are all that survives `marketplace-delivery-client.ts`, which one-swap
 * R3b (issue #2494, DR-2026-08-05 addendum 2026-08-10 Decision 2) retired along
 * with the `jinn tasks observe-autopilot-delivery` CLI verb it drove.
 *
 * Why the adapter went and the shapes stayed:
 *   - The verb was the marketplace execution backend's ONLY way to confirm a
 *     Solution or Verdict delivery, and it hard-required `discovery.mode:
 *     'http'` against the legacy Ponder indexer the D-wave deletes. It had no
 *     native replacement and no consumer outside this repo (the published
 *     `Jinn-Network/autopilot` engine never referenced it).
 *   - The observation types are the runtime's injected-port contract, exercised
 *     by the production recovery tests. Keeping them costs nothing and keeps
 *     `active-runtime-production.ts` and `marketplace-review-adoption-*.ts`
 *     honest about the shape a re-backed observer would have to satisfy.
 *
 * Selecting the marketplace execution backend is refused at configuration parse
 * (`autopilotExecutionBackend`) precisely so no run can post a Task, spend
 * escrow, and only then discover it has no way to observe the delivery.
 */

import type {
  AutopilotReviewResult,
  AutopilotSessionCapsule,
} from '@jinn-network/sdk/autopilot';
import type {
  MarketplaceMutationDeliveryReference,
  VerifiedMarketplaceSolutionDelivery,
} from './marketplace-mutation-adoption.js';

export type MarketplaceSolutionObservation =
  | {
      readonly status: 'pending';
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly status: 'contradiction';
      readonly reason: string;
      readonly detail: string;
    }
  | {
      readonly status: 'verified';
      readonly reference: MarketplaceMutationDeliveryReference;
      readonly delivery: VerifiedMarketplaceSolutionDelivery;
    };

export interface VerifiedMarketplaceVerdictDelivery {
  readonly schemaVersion: 'jinn-autopilot-verified-verdict-delivery.v1';
  readonly task: {
    readonly id: string;
    readonly creationTransactionHash: string;
    readonly creationBlockNumber: number;
    readonly solverNetManifestCid?: string;
  };
  readonly origin: {
    readonly v2AttemptId: string;
    readonly manifestPath: string;
  };
  readonly review: {
    readonly attemptId: string;
    readonly manifestPath: string;
    readonly head: string;
    readonly generation: string;
    readonly refOid: string;
    readonly reviewer: string;
  };
  readonly attempt: {
    readonly index: number;
    readonly requestId: string;
  };
  readonly solutionOperator: string;
  readonly evaluator: {
    readonly publisherAgentId: string;
    readonly address: string;
  };
  readonly envelope: {
    readonly cid: string;
    readonly author: string;
  };
  readonly transaction: {
    readonly hash: string;
    readonly blockNumber: number;
  };
  readonly result: AutopilotReviewResult;
  readonly session: AutopilotSessionCapsule;
}

export type MarketplaceVerdictObservation =
  | {
      readonly status: 'pending';
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly status: 'contradiction';
      readonly reason: string;
      readonly detail: string;
    }
  | {
      readonly status: 'verified';
      readonly delivery: VerifiedMarketplaceVerdictDelivery;
    };

export const MARKETPLACE_DELIVERY_OBSERVATION_RETIRED =
  'Marketplace delivery observation was retired with '
  + '`jinn tasks observe-autopilot-delivery` (one-swap R3b, issue #2494). '
  + 'Supply an observer explicitly, or run the local execution backend.';

/**
 * Placeholder for the removed production observer. Reaching it means the
 * marketplace backend was constructed directly (only production-recovery tests
 * do that) without supplying an observer — fail loud rather than return a
 * pending status that a caller would read as "not delivered yet".
 */
export function retiredDeliveryObserver(
  leg: 'Solution' | 'Verdict',
): () => never {
  return () => {
    throw new Error(`${leg} observation unavailable. ${MARKETPLACE_DELIVERY_OBSERVATION_RETIRED}`);
  };
}
