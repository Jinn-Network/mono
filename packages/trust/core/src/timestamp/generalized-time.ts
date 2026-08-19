// SPDX-License-Identifier: Apache-2.0

/**
 * DER GeneralizedTime validation and the pinned RFC 3339 transform
 * (anchor-evidence design §6.1 rule 11 and "Time semantics").
 *
 * Rule 11 requires `genTime` to be well-formed GeneralizedTime in Zulu form
 * with seconds, under DER's constraints: no trailing fractional zeros, no
 * timezone offsets. Where a fact derived from `genTime` enters byte-compared
 * content, the design pins exactly one rendering -- the DER string converted
 * **positionally** to RFC 3339 UTC, preserving the token's exact precision,
 * with no normalization:
 *
 *     YYYYMMDDHHMMSS[.f...]Z  ->  YYYY-MM-DDTHH:MM:SS[.f...]Z
 *
 * "Positional" is the whole point: no host date parsing, no millisecond
 * truncation, no zero padding, no re-rendering through a calendar library. The
 * digits the authority signed are the digits that reach sealed bytes. Calendar
 * strictness is then delegated to `rfc3339.ts`, so an authority time and a
 * `closeAt` instant are judged by one implementation rather than two.
 *
 * Second 60 is refused. DER GeneralizedTime carries no leap-second convention,
 * and admitting one here would put a value through the transform that the
 * calendar-strict RFC 3339 checker accepts only at true leap boundaries --
 * two rules disagreeing about one string.
 */

import { conformanceFailure, invalidInput } from "../errors.js";
import { compareCalendarStrictRfc3339Instants, isCalendarStrictRfc3339 } from "../rfc3339.js";
import { DER_TAG } from "./der.js";
import type { DerElement } from "./der.js";

const GENERALIZED_TIME_PATTERN =
  /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/;

function transform(value: string): string | undefined {
  const match = GENERALIZED_TIME_PATTERN.exec(value);
  if (match === null) return undefined;
  const fraction = match[7];
  // DER: a fractional part never ends in zero, and never encodes an all-zero
  // fraction at all (the seconds alone say that).
  if (fraction !== undefined && fraction.endsWith("0")) return undefined;
  // GeneralizedTime has no leap-second form.
  if (match[6] === "60") return undefined;
  const rendered = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`
    + (fraction === undefined ? "" : `.${fraction}`)
    + "Z";
  return isCalendarStrictRfc3339(rendered) ? rendered : undefined;
}

/** True when `value` is a DER-conformant GeneralizedTime string. */
export function isDerGeneralizedTime(value: unknown): value is string {
  return typeof value === "string" && transform(value) !== undefined;
}

/**
 * Applies the pinned positional transform, refusing anything rule 11 rejects.
 * The returned string is calendar-strict RFC 3339 UTC at the token's own
 * precision.
 */
export function derGeneralizedTimeToRfc3339(value: string): string {
  if (typeof value !== "string") invalidInput("A GeneralizedTime must be a string.");
  const rendered = transform(value);
  if (rendered === undefined) {
    conformanceFailure(
      `"${value}" is not a DER GeneralizedTime in Zulu form with seconds and no trailing fractional zeros.`,
    );
  }
  return rendered;
}

/** Reads a GeneralizedTime element, refusing any other tag, non-ASCII content,
 * or a value rule 11 rejects. */
export function readDerGeneralizedTime(element: DerElement): string {
  if (element.identifier !== DER_TAG.GENERALIZED_TIME) {
    conformanceFailure(
      `Expected a GeneralizedTime (0x18), found identifier 0x${element.identifier.toString(16)}.`,
    );
  }
  let value = "";
  for (let index = 0; index < element.content.length; index += 1) {
    const octet = element.content[index]!;
    if (octet < 0x20 || octet > 0x7e) {
      conformanceFailure(`GeneralizedTime content octet ${index} is not printable ASCII.`);
    }
    value += String.fromCharCode(octet);
  }
  derGeneralizedTimeToRfc3339(value);
  return value;
}

/**
 * Orders a token's `genTime` against a calendar-strict RFC 3339 instant --
 * the comparison design §8 step 4 makes (`genTime <= run.closeAt`) and the one
 * §6.1 rule 11 makes against a certificate validity window.
 *
 * Returns `undefined` when the RFC 3339 side is not calendar-strict; a
 * malformed `genTime` is a conformance refusal, never an ordering.
 */
export function compareDerGeneralizedTimeToRfc3339(
  genTime: string,
  instant: string,
): -1 | 0 | 1 | undefined {
  return compareCalendarStrictRfc3339Instants(derGeneralizedTimeToRfc3339(genTime), instant);
}
