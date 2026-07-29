// SPDX-License-Identifier: MIT

import type { ContractGeneration } from "@jinn-network/marketplace-binding";
import type { CostSource, InScopeCell } from "@jinn-network/benchmarking-run";
import type { AuthorityProjection } from "./authority-projection.js";
import { deriveSettledFeeForCell } from "./settlement-authority.js";

/** Payment asset pinned for today-mode native ETH settlement (program §7.131). */
export const TODAY_SETTLEMENT_PAYMENT_ASSET = "native-eth";

/** Payment asset pinned for revised-mode OLAS settlement (program §7.131). */
export const REVISED_SETTLEMENT_PAYMENT_ASSET = "olas";

export interface SettledCostPorts {
  readonly generation: ContractGeneration;
  /** Exact sealed `Run.budget.unit` — settled quotes must match. */
  readonly budgetUnit: string;
  /** Eligible projector authority facts indexed by the package (program §7.139). */
  readonly projection?: AuthorityProjection;
  readonly resolveProjection?: () => Promise<AuthorityProjection>;
  reportedCostFor?(cell: InScopeCell): Promise<{ value: string; unit: string } | undefined>;
  reportedLatencyFor?(cell: InScopeCell): Promise<number | undefined>;
}

export class SettledCostValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettledCostValidationError";
  }
}

function expectedPaymentAsset(generation: ContractGeneration): string {
  return generation === "revised"
    ? REVISED_SETTLEMENT_PAYMENT_ASSET
    : TODAY_SETTLEMENT_PAYMENT_ASSET;
}

/**
 * Settled/reported cost sourcing (design §8.3 / §13 / program §7.139).
 * Settled value is the authoritative creation deliveryRate — never budget/reservation.
 */
export function settledCostSource(ports: SettledCostPorts): CostSource {
  return {
    async costFor(cell) {
      const projection = ports.projection
        ?? (ports.resolveProjection !== undefined ? await ports.resolveProjection() : undefined);
      if (projection === undefined) {
        const reported = await ports.reportedCostFor?.(cell);
        if (reported !== undefined) {
          return { value: reported.value, unit: reported.unit, source: "reported" };
        }
        return undefined;
      }
      const settled = deriveSettledFeeForCell({
        cell,
        projection,
        generation: ports.generation,
        budgetUnit: ports.budgetUnit,
      });
      if (settled !== undefined) {
        const expectedAsset = expectedPaymentAsset(ports.generation);
        if (settled.unit !== ports.budgetUnit) {
          throw new SettledCostValidationError(
            `settled cost unit ${settled.unit} does not match Run.budget.unit ${ports.budgetUnit}`,
          );
        }
        if (settled.paymentAsset !== expectedAsset) {
          throw new SettledCostValidationError(
            `settled payment asset ${settled.paymentAsset} does not match generation ${ports.generation}`,
          );
        }
        return {
          value: settled.value,
          unit: settled.unit,
          source: "settled",
        };
      }
      const reported = await ports.reportedCostFor?.(cell);
      if (reported !== undefined) {
        return {
          value: reported.value,
          unit: reported.unit,
          source: "reported",
        };
      }
      return undefined;
    },
    async latencyFor(cell) {
      return ports.reportedLatencyFor?.(cell);
    },
  };
}
