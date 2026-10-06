import { ProfilesError } from "../../errors.js";
import { EXTERNAL_VERIFIER_HARNESSES, type ExternalVerifierHarness } from "../family-blocks.js";
import type { MeasurementDeclaration } from "../schema.js";
import type { MeasurementMap } from "../verdict-rule.js";

export interface ExternalVerifierMeasurementsInput {
  /** The harness whose reward map this is. */
  harness: ExternalVerifierHarness;
  /** The measurements the specification declares. */
  measurements: readonly MeasurementDeclaration[];
  /** The harness's reward map for one trial. For `harbor`, the object at
   * `verifier_result.rewards` in the trial's `result.json`. */
  rewards: unknown;
}

function invalid(message: string): never {
  throw new ProfilesError("invalid-document", message);
}

/**
 * The shortest decimal string that reads back as the same binary64 value, written without an
 * exponent.
 *
 * The digits are the ones ECMAScript's `Number::toString` gives: the fewest significant digits
 * that read back as the same value and, where more than one such digit string exists, the one
 * nearest the value. `String(value)` yields exactly those; it switches to exponent form below
 * 1e-6 and from 1e21 up, so those two forms are written out positionally here, padded with
 * zeros. The digits themselves are never recomputed. A whole number past 2^53 is therefore
 * written with its significant digits and then zeros, not with the exact integer value of the
 * binary64: 2^60 + 256 is "1152921504606847200", which reads back as the same value.
 */
function decimalStringWithoutExponent(value: number): string {
  const text = String(value);
  const exponentForm = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (exponentForm === null) return text;
  const [, sign, lead, fraction = "", exponentText] = exponentForm;
  const digits = `${lead}${fraction}`;
  const exponent = Number(exponentText);
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  return `${sign}${digits}${"0".repeat(exponent - fraction.length)}`;
}

/** A whole number that is a safe integer is carried as a number. Any other number is carried
 * as a decimal string, because sealed bytes admit only I-JSON safe integers (bytes.ts). */
function carry(value: number): string | number {
  if (Number.isSafeInteger(value)) return value === 0 ? 0 : value;
  return decimalStringWithoutExponent(value);
}

/**
 * Reads one trial's reward map into the measurements an `external-verifier` specification
 * declares (proposal 0002, section 4).
 *
 * - Each declared measurement is the value of the same-named key, unchanged in name and value.
 * - A key the specification does not declare is not a measurement, and is not inspected.
 * - A declared measurement whose key is absent has no value. No default is supplied, whether or
 *   not the measurement is required: `checkMeasurementCoverage` is what reports it missing.
 *
 * For `harbor` every reward is a number, so every declaration must have type `number` and every
 * declared key that is present must hold a finite number. Anything else, and a reward map that
 * is absent or is not an object, is refused with `ProfilesError("invalid-document")`.
 */
export function readExternalVerifierMeasurements(input: ExternalVerifierMeasurementsInput): MeasurementMap {
  const { harness, measurements, rewards } = input;
  if (!(EXTERNAL_VERIFIER_HARNESSES as readonly string[]).includes(harness)) {
    invalid(`No reward-map rule is defined for harness "${String(harness)}".`);
  }
  if (typeof rewards !== "object" || rewards === null || Array.isArray(rewards)) {
    invalid("The reward map is absent or is not an object.");
  }
  const entries: Array<[string, string | number]> = [];
  for (const declaration of measurements) {
    if (declaration.type !== "number") {
      invalid(`A ${harness} reward is a number; measurement "${declaration.name}" is declared with type "${declaration.type}".`);
    }
    if (!Object.hasOwn(rewards, declaration.name)) continue;
    const value = (rewards as Record<string, unknown>)[declaration.name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      invalid(`The ${harness} reward "${declaration.name}" is not a finite number.`);
    }
    entries.push([declaration.name, carry(value)]);
  }
  return Object.fromEntries(entries);
}
