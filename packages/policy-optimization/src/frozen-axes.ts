// SPDX-License-Identifier: MIT

/**
 * The two axis-value rules the campaign document rests on (product design §5.1):
 *
 * 1. **Exact pins, never constraint-shaped.** Frozen and mutable axes both name points, not
 *    families. A campaign whose `model` axis says `{provider: "anthropic"}` has not fixed the
 *    treatment — it has fixed a set of treatments, and every comparison drawn across it is
 *    between two things that may have differed on the axis the campaign claims to control.
 * 2. **Byte-sharing.** "All seeds and every admitted candidate MUST byte-share these values" is a
 *    statement about canonical bytes, not about JavaScript object identity or key order. The
 *    comparison therefore runs through the same canonicalizer that produces the sealed bytes.
 *
 * Substrate §4.1 rule 4 is the upstream statement of (1): "Campaigns that compare treatments pin
 * exact values on every compared axis."
 */

import { canonicalJsonText } from "@jinn-network/policy-identity";
import { refuse } from "./errors.js";
import type { JsonValue } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Is this a point value for `axis`?
 *
 * The general rule is byte-equality: for every axis the effective-requirements merge compares by
 * canonical bytes, any non-null value already names exactly one treatment, so it is a pin. The one
 * exception is the one axis the stack registers a *constraint-membership* test for — `model`,
 * where `{provider}` legally admits a whole provider's catalogue. That asymmetry is not an
 * accident of this package: it is `@jinn-network/policy-identity`'s `CONSTRAINT_MEMBERSHIP_KEYS`,
 * and a tripwire test fails the day that set grows (FINDING F-C7a-2).
 *
 * `null` is refused on every axis. In a tuple `null` means "the effective requirements do not
 * constrain this axis" (substrate §4.1 step 2) — the opposite of a pin, and a campaign that froze
 * an axis to "unconstrained" would be claiming control it does not have.
 */
export function isExactPin(axis: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (axis !== "model") return true;
  // A model value names a point only when it carries the identifier the membership test compares:
  // `modelConstraintAdmits` resolves `{provider}` by *inference over ids*, so a provider-only value
  // is satisfied by any id that infers to it.
  return isPlainObject(value) && typeof value["id"] === "string" && value["id"] !== "";
}

/** `isExactPin`, as a fail-closed refusal that names the member. */
export function assertExactPin(axis: string, value: unknown, path: string): void {
  if (isExactPin(axis, value)) return;
  refuse(
    "constraint-shaped-pin",
    path,
    value === null || value === undefined
      ? `axis ${axis} must carry an exact pin; an unconstrained axis is not a pin`
      : `axis ${axis} must carry an exact pin, never a constraint-shaped value`,
  );
}

/**
 * Do two axis values seal to the same bytes?
 *
 * `undefined` is not a JSON value and never byte-shares anything, which is what makes "the seed
 * omits the frozen axis entirely" a disagreement rather than a vacuous pass.
 */
export function axisValuesByteShare(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return false;
  return canonicalJsonText(left as JsonValue) === canonicalJsonText(right as JsonValue);
}
