// SPDX-License-Identifier: Apache-2.0

/** Coverage for the declared/all-slots denominator pair (issue #2977). */

import { describe, expect, test } from "vitest";
import type { MatrixRecord } from "@jinn-network/benchmarking-records";
import { armDenominators } from "./denominators.js";

/**
 * The full per-arm shape a sealed Matrix carries, not the narrow slice the derivation reads: the
 * caller passes a whole `attrition` block, so the tests must prove that block is what this accepts.
 * The return type is the Matrix record's own `attrition`, so the field names here are checked
 * against the sealed schema rather than merely happening to match it today.
 * Arm ids are opaque wire keys, so the map is prototype-free and written through
 * `Object.defineProperty` exactly as the Matrix schema builds it.
 */
function accounting(expectedByArm: Readonly<Record<string, number>>): MatrixRecord["attrition"] {
  const perArm = Object.create(null) as MatrixRecord["attrition"]["perArm"];
  for (const [armId, expected] of Object.entries(expectedByArm)) {
    // Named and typed before the descriptor, because `Object.defineProperty`'s `value` is untyped:
    // the field names are only checked against the sealed schema on the way into this binding.
    const counts: MatrixRecord["attrition"]["perArm"][string] = {
      expected, judged: expected, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0,
    };
    Object.defineProperty(perArm, armId, { enumerable: true, configurable: true, writable: true, value: counts });
  }
  return { perArm, asymmetryFlags: [] };
}

describe("armDenominators", () => {
  test("carries both numbers and a zero delta when the declared denominator kept every planned slot", () => {
    expect(armDenominators([{ armId: "baseline", n: 3 }], accounting({ baseline: 3 })))
      .toEqual([{ armId: "baseline", declared: 3, allSlots: 3, excludedFromDeclared: 0 }]);
  });

  test("states the delta when the declared denominator drops planned slots", () => {
    expect(armDenominators([{ armId: "candidate", n: 7 }], accounting({ candidate: 10 })))
      .toEqual([{ armId: "candidate", declared: 7, allSlots: 10, excludedFromDeclared: 3 }]);
  });

  test("keeps every arm in the order the report states them", () => {
    expect(armDenominators([{ armId: "b", n: 1 }, { armId: "a", n: 2 }], accounting({ a: 2, b: 4 }))
      .map((arm) => arm.armId)).toEqual(["b", "a"]);
  });

  test("withholds the all-slots number for an arm the Matrix carries no accounting for", () => {
    expect(armDenominators([{ armId: "baseline", n: 3 }], accounting({})))
      .toEqual([{ armId: "baseline", declared: 3, allSlots: undefined, excludedFromDeclared: undefined }]);
  });

  test("reads an arm named after an inherited object member from the record's own keys only", () => {
    expect(armDenominators(
      [{ armId: "constructor", n: 4 }, { armId: "toString", n: 1 }],
      accounting({ constructor: 5 }),
    )).toEqual([
      { armId: "constructor", declared: 4, allSlots: 5, excludedFromDeclared: 1 },
      { armId: "toString", declared: 1, allSlots: undefined, excludedFromDeclared: undefined },
    ]);
  });

  test("states a negative delta rather than hiding a declared denominator larger than the planned slots", () => {
    expect(armDenominators([{ armId: "baseline", n: 4 }], accounting({ baseline: 3 })))
      .toEqual([{ armId: "baseline", declared: 4, allSlots: 3, excludedFromDeclared: -1 }]);
  });
});
