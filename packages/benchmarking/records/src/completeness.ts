import { z } from "zod";
import { exactDecimalInUnitInterval, meetsExactDecimalFloor } from "./decimal.js";

export const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export interface CompletenessFields {
  readonly expected: number;
  readonly judged: number;
  readonly floor: string;
  readonly runOutcome: "complete" | "partial" | "cancelled";
}

export interface AttritionForCompleteness {
  readonly perArm: Readonly<Record<string, { readonly excluded: number }>>;
}

/** Sum per-arm excluded counts with fail-closed safe-integer bounds. */
export function sumAttritionExcluded(
  attrition: AttritionForCompleteness,
  ctx?: z.RefinementCtx,
  attritionPath?: readonly (string | number)[],
): number | undefined {
  let sum = 0;
  for (const arm of Object.values(attrition.perArm)) {
    const next = sum + arm.excluded;
    if (!Number.isSafeInteger(next) || next < sum) {
      ctx?.addIssue({
        code: "custom",
        message: "attrition excluded counts must sum to a safe nonnegative integer (§8.1)",
        path: [...(attritionPath ?? ["attrition"])],
      });
      return undefined;
    }
    sum = next;
  }
  return sum;
}

/** Shared Matrix/Report completeness partition + floor semantics (§8.1, Addendum 2026-07-29-l ¶8). */
export function validateCompletenessOutcome(
  completeness: CompletenessFields,
  judged: number,
  excludedCount: number | undefined,
  ctx: z.RefinementCtx,
  completenessPath: readonly (string | number)[],
  attritionPath: readonly (string | number)[],
): void {
  if (excludedCount === undefined) return;

  if (excludedCount > completeness.expected) {
    ctx.addIssue({
      code: "custom",
      message: "attrition excluded count must not exceed completeness.expected (§8.1)",
      path: [...attritionPath],
    });
    return;
  }

  const eligible = completeness.expected - excludedCount;
  if (judged > eligible) {
    ctx.addIssue({
      code: "custom",
      message: "completeness.judged must not exceed the eligible cell count (expected minus excluded) (§8.1)",
      path: [...completenessPath, "judged"],
    });
  }

  if (!exactDecimalInUnitInterval(completeness.floor)) {
    ctx.addIssue({
      code: "custom",
      message: "completeness.floor must be in (0,1] (§8.1)",
      path: [...completenessPath, "floor"],
    });
    return;
  }
  if (completeness.runOutcome === "cancelled") return;

  const floorPassed = meetsExactDecimalFloor(judged, eligible, completeness.floor);
  if (completeness.runOutcome === "complete" && !floorPassed) {
    ctx.addIssue({
      code: "custom",
      message: "runOutcome complete requires the declared completeness floor to pass (§8.1)",
      path: [...completenessPath, "runOutcome"],
    });
  }
  if (completeness.runOutcome === "partial" && floorPassed) {
    ctx.addIssue({
      code: "custom",
      message: "runOutcome partial requires the declared completeness floor to be missed (§8.1)",
      path: [...completenessPath, "runOutcome"],
    });
  }
}
