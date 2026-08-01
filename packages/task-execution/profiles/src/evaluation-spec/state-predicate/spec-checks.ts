import type { EvaluationSpec } from "../schema.js";
import type { VerdictRule } from "../verdict-rule.js";
import type { UnscorableClass } from "../unscorable.js";
import { ProfilesError } from "../../errors.js";
import { STATE_PREDICATE_FAMILY, StatePredicateBlockSchema } from "../family-blocks.js";
import {
  STATE_PREDICATE_RESERVED_MEASUREMENTS,
} from "./vocabulary.js";

export const STATE_PREDICATE_UNEVALUABLE_CLASS = "state-predicate-unevaluable" as const;

/**
 * Design §6.2's verdict rule, expressed in the package's existing declarative vocabulary
 * (§7.3) rather than as a second verdict path: all success predicates satisfied AND no safety
 * constraint violated; an unevaluable run resolves `inconclusive` under a declared
 * `recorded-inconclusive` class, never `fail`. A `state-predicate` spec MUST carry this rule
 * verbatim — otherwise an author could write a rule that reads `successPredicatesSatisfied`
 * and quietly ignores `safetyConstraintsViolated`.
 */
export const STATE_PREDICATE_VERDICT_RULE: VerdictRule = {
  all: [
    {
      inconclusiveWhen: { threshold: { measurement: "statePredicateUnevaluable", op: "eq", value: true } },
      class: STATE_PREDICATE_UNEVALUABLE_CLASS,
    },
    { threshold: { measurement: "successPredicatesSatisfied", op: "eq", value: true } },
    { not: { threshold: { measurement: "safetyConstraintsViolated", op: "eq", value: true } } },
  ],
};

export type StatePredicateSpecCheckResult =
  | { ok: true }
  | { ok: false; code: "invalid-document"; reason: string };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]));
}

/** Structural check for the `state-predicate-block` fixture family: parses a
 * `{family, block}` case and throws `ProfilesError("invalid-document")` on any violation, so
 * `runStructuralCheck` can project it to `{ok:false, code}`. */
export function checkStatePredicateBlock(input: unknown): unknown {
  const { family, block } = input as { family: string; block: unknown };
  if (family !== STATE_PREDICATE_FAMILY) {
    throw new ProfilesError("invalid-document", `expected family "${STATE_PREDICATE_FAMILY}"`);
  }
  const parsed = StatePredicateBlockSchema.safeParse(block);
  if (!parsed.success) {
    throw new ProfilesError("invalid-document", "state-predicate block failed schema validation");
  }
  return parsed.data;
}

/** Validates that a `state-predicate` EvaluationSpec carries the canonical verdict rule,
 * reserved measurements, unscorable class, and measurement coverage the family requires. */
export function checkStatePredicateSpec(spec: EvaluationSpec): StatePredicateSpecCheckResult {
  if (spec.family !== STATE_PREDICATE_FAMILY) {
    return {
      ok: false,
      code: "invalid-document",
      reason: `expected family "${STATE_PREDICATE_FAMILY}"`,
    };
  }

  const blockResult = StatePredicateBlockSchema.safeParse(spec.familyBlock);
  if (!blockResult.success) {
    return {
      ok: false,
      code: "invalid-document",
      reason: "state-predicate block failed schema validation",
    };
  }
  const block = blockResult.data;

  if (!deepEqual(spec.verdictRule, STATE_PREDICATE_VERDICT_RULE)) {
    return {
      ok: false,
      code: "invalid-document",
      reason: "verdictRule must equal STATE_PREDICATE_VERDICT_RULE verbatim",
    };
  }

  for (const name of STATE_PREDICATE_RESERVED_MEASUREMENTS) {
    const declaration = spec.measurements.find((measurement) => measurement.name === name);
    if (declaration === undefined) {
      return {
        ok: false,
        code: "invalid-document",
        reason: `missing reserved measurement declaration "${name}"`,
      };
    }
    if (declaration.type !== "boolean" || declaration.required !== true) {
      return {
        ok: false,
        code: "invalid-document",
        reason: `reserved measurement "${name}" must be type boolean and required: true`,
      };
    }
  }

  const declaredNames = new Set(spec.measurements.map((measurement) => measurement.name));
  for (const measurement of block.measurements) {
    if (!declaredNames.has(measurement.name)) {
      return {
        ok: false,
        code: "invalid-document",
        reason: `block measurement "${measurement.name}" is not declared in spec.measurements`,
      };
    }
  }

  const unscorable = (spec.unscorable as UnscorableClass[] | undefined) ?? [];
  const unevaluableClass = unscorable.find((entry) => entry.name === STATE_PREDICATE_UNEVALUABLE_CLASS);
  if (unevaluableClass === undefined || unevaluableClass.disposition !== "recorded-inconclusive") {
    return {
      ok: false,
      code: "invalid-document",
      reason:
        `unscorable must declare {name: "${STATE_PREDICATE_UNEVALUABLE_CLASS}", `
        + 'disposition: "recorded-inconclusive"}',
    };
  }

  return { ok: true };
}
