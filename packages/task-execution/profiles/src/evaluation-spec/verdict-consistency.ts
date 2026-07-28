import { evaluateVerdictRule, type MeasurementMap, type VerdictOutcome, type VerdictRule } from "./verdict-rule.js";
import type { EvaluationSpec } from "./schema.js";
import type { UnscorableClass } from "./unscorable.js";

export type VerdictConsistencyResult =
  | { ok: true }
  | { ok: false; code: "invalid-document"; reason: string };

/**
 * The named verdict-consistency check (§7.3/§7.4): a delivered verdict MUST equal
 * `evaluateVerdictRule(spec.verdictRule, measurements)`. `inconclusive` is legal only under a
 * declared inconclusive-predicate (the recomputed outcome is itself `inconclusive`) or a
 * declared `recorded-inconclusive` class named in `spec.unscorable` — a delivery that laundered
 * a `fail` into `inconclusive` fails this check.
 */
export function checkVerdictConsistency(input: {
  spec: EvaluationSpec;
  delivered: VerdictOutcome;
  measurements: MeasurementMap;
  declaredUnscorableClass?: string;
}): VerdictConsistencyResult {
  const { spec, delivered, measurements, declaredUnscorableClass } = input;
  const recomputed = evaluateVerdictRule(spec.verdictRule as VerdictRule, measurements);

  if (delivered.verdict === "inconclusive") {
    if (recomputed.verdict === "inconclusive") return { ok: true };
    if (declaredUnscorableClass !== undefined) {
      const unscorable = (spec.unscorable as UnscorableClass[] | undefined) ?? [];
      const declared = unscorable.find((entry) => entry.name === declaredUnscorableClass);
      if (declared !== undefined && declared.disposition === "recorded-inconclusive") {
        return { ok: true };
      }
      return {
        ok: false,
        code: "invalid-document",
        reason:
          `declared unscorable class "${declaredUnscorableClass}" is not a recorded-inconclusive `
          + "class in spec.unscorable",
      };
    }
    return {
      ok: false,
      code: "invalid-document",
      reason:
        "delivered inconclusive verdict has no recomputed inconclusive predicate and no declared "
        + "unscorable class",
    };
  }

  if (delivered.verdict !== recomputed.verdict) {
    return {
      ok: false,
      code: "invalid-document",
      reason: `delivered verdict "${delivered.verdict}" does not match recomputed verdict "${recomputed.verdict}"`,
    };
  }
  return { ok: true };
}
