import { z } from "zod";
import { ProfilesError } from "../errors.js";

/** Threshold comparison operators (closed vocabulary, §7.3). */
export const COMPARISON_OPS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];

export type JsonScalar = string | number | boolean | null;
const JsonScalarSchema: z.ZodType<JsonScalar> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * `verdictRule` is a declarative structure in a closed vocabulary over declared measurement
 * names — threshold comparisons, boolean combinators, explicit inconclusive-predicates. No
 * executable code, no external refs, reads nothing outside delivered measurements (§7.3).
 */
export type VerdictRule =
  | { threshold: { measurement: string; op: ComparisonOp; value: JsonScalar } }
  | { all: VerdictRule[] }
  | { any: VerdictRule[] }
  | { not: VerdictRule }
  | { inconclusiveWhen: VerdictRule; class: string }
  | { pass: true }
  | { fail: true };

export const VerdictRuleSchema: z.ZodType<VerdictRule> = z.lazy(() =>
  z.union([
    z.object({
      threshold: z.object({
        measurement: z.string(),
        op: z.enum(COMPARISON_OPS),
        value: JsonScalarSchema,
      }),
    }),
    z.object({ all: z.array(VerdictRuleSchema) }),
    z.object({ any: z.array(VerdictRuleSchema) }),
    z.object({ not: VerdictRuleSchema }),
    z.object({ inconclusiveWhen: VerdictRuleSchema, class: z.string() }),
    z.object({ pass: z.literal(true) }),
    z.object({ fail: z.literal(true) }),
  ]),
);

export type MeasurementMap = Record<string, string | number | boolean>;
export type VerdictOutcome = { verdict: "pass" | "fail" | "inconclusive"; inconclusiveClass?: string };

type InnerResult = { kind: "bool"; value: boolean } | { kind: "inconclusive"; inconclusiveClass: string };

function lookupMeasurement(measurements: MeasurementMap, name: string): string | number | boolean {
  if (!Object.hasOwn(measurements, name)) {
    throw new ProfilesError(
      "invalid-document",
      `verdictRule references a measurement not present in the delivered set: "${name}"`,
    );
  }
  return measurements[name];
}

function compare(op: ComparisonOp, actual: string | number | boolean, value: JsonScalar): boolean {
  switch (op) {
    case "eq": return actual === value;
    case "ne": return actual !== value;
    case "lt": return typeof actual === "number" && typeof value === "number" && actual < value;
    case "lte": return typeof actual === "number" && typeof value === "number" && actual <= value;
    case "gt": return typeof actual === "number" && typeof value === "number" && actual > value;
    case "gte": return typeof actual === "number" && typeof value === "number" && actual >= value;
  }
}

function evaluateInner(rule: VerdictRule, measurements: MeasurementMap): InnerResult {
  if ("pass" in rule) return { kind: "bool", value: true };
  if ("fail" in rule) return { kind: "bool", value: false };
  if ("not" in rule) {
    const inner = evaluateInner(rule.not, measurements);
    return inner.kind === "inconclusive" ? inner : { kind: "bool", value: !inner.value };
  }
  if ("threshold" in rule) {
    const { measurement, op, value } = rule.threshold;
    const actual = lookupMeasurement(measurements, measurement);
    return { kind: "bool", value: compare(op, actual, value) };
  }
  if ("all" in rule) {
    for (const sub of rule.all) {
      const inner = evaluateInner(sub, measurements);
      if (inner.kind === "inconclusive") return inner;
      if (!inner.value) return { kind: "bool", value: false };
    }
    return { kind: "bool", value: true };
  }
  if ("any" in rule) {
    for (const sub of rule.any) {
      const inner = evaluateInner(sub, measurements);
      if (inner.kind === "inconclusive") return inner;
      if (inner.value) return { kind: "bool", value: true };
    }
    return { kind: "bool", value: false };
  }
  // inconclusiveWhen: evaluate the predicate first; if true, this node is decisively
  // inconclusive with its declared class. If false, the predicate raised no objection — this
  // node contributes a neutral `true` and evaluation falls through to whatever encloses it (an
  // `all`/`any` combinator, or — when it is the sole top-level rule — the default pass
  // resolution), per plan Task 4 Step 3.
  const predicate = evaluateInner(rule.inconclusiveWhen, measurements);
  if (predicate.kind === "inconclusive") return predicate;
  if (predicate.value) return { kind: "inconclusive", inconclusiveClass: rule.class };
  return { kind: "bool", value: true };
}

/**
 * Evaluates a `VerdictRule` over a delivered measurement map. A `threshold` referencing a
 * measurement absent from `measurements` throws `ProfilesError('invalid-document')` — the rule
 * may reference only declared measurement names (cross-checked against the spec by Task 5's
 * coverage check).
 */
export function evaluateVerdictRule(rule: VerdictRule, measurements: MeasurementMap): VerdictOutcome {
  const result = evaluateInner(rule, measurements);
  if (result.kind === "inconclusive") {
    return { verdict: "inconclusive", inconclusiveClass: result.inconclusiveClass };
  }
  return { verdict: result.value ? "pass" : "fail" };
}
