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
 * Strict decimal grammar (Global Constraints/§7.14 fractional-as-strings doctrine, composite
 * `weight` precedent in family-blocks.ts): optional leading `-`, one or more digits, an optional
 * `.` followed by one or more digits. No exponents, no leading `+`, no locale separators.
 */
export const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

const ORDERED_OPS: ReadonlySet<ComparisonOp> = new Set(["lt", "lte", "gt", "gte"]);

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

// A threshold's `value` MAY be a decimal string (the sealed-numbers I-JSON-integer rule in
// bytes.ts forces every fractional quantity to be a string, never a JSON number). For an ordered
// op (lt/lte/gt/gte) that string is meaningless unless it is a well-formed decimal — `compare()`
// below parses it as an exact decimal for those ops, so a malformed one must be rejected here, at
// parse time, rather than silently comparing as `false` forever.
const ThresholdSchema = z
  .object({
    measurement: z.string(),
    op: z.enum(COMPARISON_OPS),
    value: JsonScalarSchema,
  })
  .superRefine((threshold, ctx) => {
    if (
      ORDERED_OPS.has(threshold.op) &&
      typeof threshold.value === "string" &&
      !DECIMAL_STRING_PATTERN.test(threshold.value)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `Ordered comparison "${threshold.op}" requires a decimal-string value matching ${DECIMAL_STRING_PATTERN.source}; got ${JSON.stringify(threshold.value)}.`,
      });
    }
  });

export const VerdictRuleSchema: z.ZodType<VerdictRule> = z.lazy(() =>
  z.union([
    z.object({ threshold: ThresholdSchema }),
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

type DecimalParts = { negative: boolean; intDigits: string; fracDigits: string };

/**
 * Parses a `number` or a decimal-grammar `string` into its exact sign/integer/fraction digit
 * parts. Never routes through `Number()`/`parseFloat` — that would reintroduce the float-coercion
 * pitfall this function exists to avoid. Returns `undefined` for anything that isn't decimal
 * (booleans, `null`, non-decimal strings, non-finite numbers), so callers can fall back to a
 * non-numeric comparison.
 */
function toDecimalParts(operand: string | number | boolean | null): DecimalParts | undefined {
  let text: string;
  if (typeof operand === "number") {
    if (!Number.isFinite(operand)) return undefined;
    text = operand.toString();
  } else if (typeof operand === "string") {
    text = operand;
  } else {
    return undefined;
  }
  if (!DECIMAL_STRING_PATTERN.test(text)) return undefined;
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [intDigits, fracDigits = ""] = unsigned.split(".");
  return { negative, intDigits, fracDigits };
}

/**
 * Exact decimal comparison of two operands (each a measurement value or a threshold value),
 * via scaled-integer `BigInt` — no epsilon, no locale, no float coercion of the string operand.
 * Returns `-1 | 0 | 1` when both operands are decimal-parseable, `undefined` otherwise (a
 * measurement/threshold pairing that never was numeric — e.g. a boolean — is not a decimal
 * comparison at all, and callers fall back accordingly).
 */
function compareDecimal(
  actual: string | number | boolean,
  value: JsonScalar,
): -1 | 0 | 1 | undefined {
  const left = toDecimalParts(actual);
  const right = toDecimalParts(value);
  if (left === undefined || right === undefined) return undefined;
  const scale = Math.max(left.fracDigits.length, right.fracDigits.length);
  const leftScaled = BigInt((left.negative ? "-" : "") + left.intDigits + left.fracDigits.padEnd(scale, "0"));
  const rightScaled = BigInt((right.negative ? "-" : "") + right.intDigits + right.fracDigits.padEnd(scale, "0"));
  if (leftScaled < rightScaled) return -1;
  if (leftScaled > rightScaled) return 1;
  return 0;
}

function compare(op: ComparisonOp, actual: string | number | boolean, value: JsonScalar): boolean {
  // Decimal-aware for every op: eq/ne canonicalize scale before comparing (e.g. "0.50" equals
  // "0.5") whenever both operands are numeric (a `number` or a decimal-grammar string); when
  // either side isn't numeric (booleans, `null`, non-decimal strings), decimal comparison is
  // inapplicable and eq/ne fall back to the prior strict `===`/`!==` scalar comparison.
  const decimal = compareDecimal(actual, value);
  switch (op) {
    case "eq": return decimal !== undefined ? decimal === 0 : actual === value;
    case "ne": return decimal !== undefined ? decimal !== 0 : actual !== value;
    case "lt": return decimal !== undefined && decimal < 0;
    case "lte": return decimal !== undefined && decimal <= 0;
    case "gt": return decimal !== undefined && decimal > 0;
    case "gte": return decimal !== undefined && decimal >= 0;
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
