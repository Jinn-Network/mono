// SPDX-License-Identifier: MIT

import type { ContractGeneration } from "@jinn-network/marketplace-binding";
import type { InScopeCell } from "@jinn-network/benchmarking-run";
import type { AuthorityProjection } from "./authority-projection.js";
import {
  indexAttemptCreations,
  indexAttemptObservations,
  indexDeliveryPreparations,
  indexDeliveryObservations,
  indexSolutionSettlements,
} from "./authority-projection.js";

export interface DerivedSettledFee {
  readonly value: string;
  readonly unit: string;
  readonly paymentAsset: string;
}

function paymentAssetFor(generation: ContractGeneration): string {
  return generation === "revised" ? "olas" : "native-eth";
}

/**
 * Derive settled cost from eligible projector facts (program §7.139). Returns undefined when
 * the accounted Attempt lacks a successful solution settlement joined to its creation deliveryRate.
 */
export function deriveSettledFeeForCell(input: {
  cell: InScopeCell;
  projection: AuthorityProjection;
  generation: ContractGeneration;
  budgetUnit: string;
}): DerivedSettledFee | undefined {
  const { cell, projection, generation, budgetUnit } = input;
  if (cell.attempt === undefined) return undefined;

  const engaged = indexAttemptObservations(projection.observations).get(cell.attempt);
  if (engaged === undefined) return undefined;

  const creation = indexAttemptCreations(projection.events).get(cell.attempt);
  if (creation === undefined) return undefined;
  if (creation.generation !== generation) return undefined;

  const settlement = indexSolutionSettlements(projection.events).get(cell.attempt);
  if (settlement === undefined || settlement.attemptUrn !== cell.attempt) return undefined;
  if (generation === "today") {
    if (
      creation.requestId === undefined
      || engaged.requestId === undefined
      || creation.requestId !== engaged.requestId
      || settlement.requestId !== creation.requestId
    ) {
      return undefined;
    }
  } else {
    if (creation.requestId !== undefined || engaged.requestId !== undefined) return undefined;
    const preparation = indexDeliveryPreparations(projection.events).get(cell.attempt);
    if (
      preparation === undefined
      || preparation.kind !== "solution"
      || preparation.requestId !== settlement.requestId
    ) {
      return undefined;
    }
  }

  const deliveryObserved = indexDeliveryObservations(projection.observations).get(cell.attempt);
  if (deliveryObserved === undefined) return undefined;
  if (cell.deliveryDigest !== undefined && cell.deliveryDigest !== deliveryObserved.digest) {
    return undefined;
  }
  if (
    settlement.deliveryDigest !== undefined
    && settlement.deliveryDigest !== deliveryObserved.digest
  ) {
    return undefined;
  }

  return {
    value: creation.deliveryRate.toString(),
    unit: budgetUnit,
    paymentAsset: paymentAssetFor(generation),
  };
}
