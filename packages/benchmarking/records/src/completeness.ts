import type { z } from "zod";
import { exactDecimalInUnitInterval, meetsExactDecimalFloor } from "./decimal.js";

export interface CompletenessFields {
  readonly expected: number;
  readonly judged: number;
  readonly floor: string;
  readonly runOutcome: "complete" | "partial" | "cancelled";
}

export interface AttritionForCompleteness {
  readonly perArm: Readonly<Record<string, { readonly excluded: number }>>;
}

export function sumAttritionExcluded(attrition: AttritionForCompleteness): number {
  return Object.values(attrition.perArm).reduce((sum, arm) => sum + arm.excluded, 0);
}

/** Shared Matrix/Report completeness floor semantics (§8.1, Addendum 2026-07-29-l ¶8). */
export function validateCompletenessOutcome(
  completeness: CompletenessFields,
  judged: number,
  excludedCount: number,
  ctx: z.RefinementCtx,
  basePath: readonly (string | number)[],
): void {
  if (!exactDecimalInUnitInterval(completeness.floor)) {
    ctx.addIssue({
      code: "custom",
      message: "completeness.floor must be in (0,1] (§8.1)",
      path: [...basePath, "floor"],
    });
    return;
  }
  if (completeness.runOutcome === "cancelled") return;
  const denominator = completeness.expected - excludedCount;
  const floorPassed = meetsExactDecimalFloor(judged, denominator, completeness.floor);
  if (completeness.runOutcome === "complete" && !floorPassed) {
    ctx.addIssue({
      code: "custom",
      message: "runOutcome complete requires the declared completeness floor to pass (§8.1)",
      path: [...basePath, "runOutcome"],
    });
  }
  if (completeness.runOutcome === "partial" && floorPassed) {
    ctx.addIssue({
      code: "custom",
      message: "runOutcome partial requires the declared completeness floor to be missed (§8.1)",
      path: [...basePath, "runOutcome"],
    });
  }
}
