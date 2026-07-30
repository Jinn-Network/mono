// SPDX-License-Identifier: MIT

import type { OperatorCaps } from "./types.js";

export type { OperatorCaps };

/** Self-protection guard: intended spend and AI units must fit under the operator caps (§7). */
export function checkCaps(
  intendedSpendWei: bigint,
  intendedAiUnits: number,
  caps: OperatorCaps,
): boolean {
  if (intendedSpendWei > caps.spendCapWei) return false;
  if (intendedAiUnits > caps.aiUnitCap) return false;
  return true;
}
