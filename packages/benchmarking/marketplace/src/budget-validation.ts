// SPDX-License-Identifier: MIT

import {
  expectedCellCount,
  parseExactDecimal,
  scaleDecimal,
  type BenchmarkRecord,
  type ExactDecimal,
  type RunRecord,
} from "@jinn-network/benchmarking-records";

export class MarketplaceCompositionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceCompositionValidationError";
  }
}

function addExactDecimals(left: string, right: string): ExactDecimal | undefined {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  if (a === undefined || b === undefined) return undefined;
  const scale = a.scale > b.scale ? a.scale : b.scale;
  return {
    coefficient: scaleDecimal(a, scale) + scaleDecimal(b, scale),
    scale,
  };
}

function exactDecimalGte(left: ExactDecimal, right: ExactDecimal): boolean {
  const scale = left.scale > right.scale ? left.scale : right.scale;
  return scaleDecimal(left, scale) >= scaleDecimal(right, scale);
}

function isPositiveExactDecimal(value: string): boolean {
  const parsed = parseExactDecimal(value);
  return parsed !== undefined && parsed.coefficient > 0n;
}

/**
 * Exact budget gate for open-competition marketplace composition (program §7.136).
 * Uses records exact-decimal/BigInt helpers — never JS Number for monetary comparisons.
 */
export function validateMarketplaceBudget(
  bench: BenchmarkRecord,
  run: RunRecord,
): void {
  const budget = run.budget;
  if (budget === undefined) {
    throw new MarketplaceCompositionValidationError(
      "budget is required for open-competition marketplace composition",
    );
  }
  if (typeof budget.unit !== "string" || budget.unit.length === 0) {
    throw new MarketplaceCompositionValidationError(
      "budget.unit must be a non-empty string",
    );
  }
  if (!isPositiveExactDecimal(budget.perCell.solve)) {
    throw new MarketplaceCompositionValidationError(
      "budget.perCell.solve must be a positive exact decimal string",
    );
  }
  if (!isPositiveExactDecimal(budget.perCell.evaluate)) {
    throw new MarketplaceCompositionValidationError(
      "budget.perCell.evaluate must be a positive exact decimal string",
    );
  }
  if (!isPositiveExactDecimal(budget.hardCap)) {
    throw new MarketplaceCompositionValidationError(
      "budget.hardCap must be a positive exact decimal string",
    );
  }

  let cells: number;
  try {
    cells = expectedCellCount(bench, run);
  } catch (cause) {
    throw new MarketplaceCompositionValidationError(
      cause instanceof Error ? cause.message : "expected cell count overflow",
    );
  }
  if (cells === 0) {
    throw new MarketplaceCompositionValidationError(
      "expected cell count must be positive for marketplace composition",
    );
  }

  const perCellTotal = addExactDecimals(budget.perCell.solve, budget.perCell.evaluate);
  if (perCellTotal === undefined) {
    throw new MarketplaceCompositionValidationError(
      "budget.perCell.solve and budget.perCell.evaluate must be exact decimal strings",
    );
  }
  const minRequired: ExactDecimal = {
    coefficient: perCellTotal.coefficient * BigInt(cells),
    scale: perCellTotal.scale,
  };

  const hardCap = parseExactDecimal(budget.hardCap);
  if (hardCap === undefined) {
    throw new MarketplaceCompositionValidationError(
      "budget.hardCap must be an exact decimal string",
    );
  }
  if (!exactDecimalGte(hardCap, minRequired)) {
    throw new MarketplaceCompositionValidationError(
      "budget.hardCap must be >= expectedCellCount × (perCell.solve + perCell.evaluate)",
    );
  }
}
