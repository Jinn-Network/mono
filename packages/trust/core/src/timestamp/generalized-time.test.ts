import { describe, expect, test } from "vitest";

import { TrustCoreError } from "../errors.js";
import { DER_TAG, decodeDer } from "./der.js";
import {
  compareDerGeneralizedTimeToRfc3339,
  derGeneralizedTimeToRfc3339,
  isDerGeneralizedTime,
  readDerGeneralizedTime,
} from "./generalized-time.js";

function timeElement(value: string): Uint8Array {
  const ascii = Uint8Array.from(value, (character) => character.charCodeAt(0));
  return Uint8Array.from([DER_TAG.GENERALIZED_TIME, ascii.length, ...ascii]);
}

function code(run: () => unknown): string {
  try {
    run();
  } catch (cause) {
    return cause instanceof TrustCoreError ? cause.code : `not-a-TrustCoreError:${String(cause)}`;
  }
  return "no-throw";
}

describe("DER GeneralizedTime validation (design §6.1 rule 11)", () => {
  test.each([
    "20260817120000Z",
    "19991231235959Z",
    "20260817120000.5Z",
    "20260817120000.123456Z",
    "20240229000000.000001Z",
  ])("accepts %s", (value) => {
    expect(isDerGeneralizedTime(value)).toBe(true);
  });

  test.each([
    ["20260817120000.100Z", "trailing fractional zero"],
    ["20260817120000.0Z", "a fraction that is only a zero"],
    ["20260817120000.Z", "an empty fraction"],
    ["20260817120000", "a missing Zulu designator"],
    ["20260817120000+0100", "a numeric offset"],
    ["20260817120000-0100Z", "an offset before the designator"],
    ["202608171200Z", "missing seconds"],
    ["2026081712Z", "missing minutes and seconds"],
    ["20260817120000z", "a lowercase designator"],
    ["2026081712000AZ", "a non-digit in the time"],
    ["20261317120000Z", "month 13"],
    ["20260230120000Z", "30 February"],
    ["20260817240000Z", "hour 24"],
    ["20260817126000Z", "minute 60"],
    ["20260817125960Z", "second 60"],
    ["", "an empty string"],
  ])("refuses %s (%s)", (value) => {
    expect(isDerGeneralizedTime(value)).toBe(false);
    expect(code(() => derGeneralizedTimeToRfc3339(value))).toBe("CONFORMANCE_FAILURE");
  });

  test("refuses non-string input as caller error", () => {
    expect(isDerGeneralizedTime(20260817120000)).toBe(false);
    expect(code(() => derGeneralizedTimeToRfc3339(undefined as unknown as string)))
      .toBe("INVALID_INPUT");
  });
});

describe("the pinned GeneralizedTime -> RFC 3339 transform (design §6.1 Time semantics)", () => {
  test.each([
    ["20260817120000Z", "2026-08-17T12:00:00Z"],
    ["19991231235959Z", "1999-12-31T23:59:59Z"],
    ["20260817120000.5Z", "2026-08-17T12:00:00.5Z"],
    ["20260817120000.123456Z", "2026-08-17T12:00:00.123456Z"],
    ["20260817120000.000001Z", "2026-08-17T12:00:00.000001Z"],
    ["20260817120000.123456789123456789Z", "2026-08-17T12:00:00.123456789123456789Z"],
  ])("renders %s as %s", (genTime, expected) => {
    expect(derGeneralizedTimeToRfc3339(genTime)).toBe(expected);
  });

  test("preserves precision without normalization", () => {
    // Neither padded nor truncated to milliseconds: the token's own digits survive.
    expect(derGeneralizedTimeToRfc3339("20260817120000.1Z")).toBe("2026-08-17T12:00:00.1Z");
    expect(derGeneralizedTimeToRfc3339("20260817120000.1234567891Z"))
      .toBe("2026-08-17T12:00:00.1234567891Z");
  });
});

describe("reading a GeneralizedTime element", () => {
  test("decodes the ASCII content and validates it", () => {
    expect(readDerGeneralizedTime(decodeDer(timeElement("20260817120000Z"))))
      .toBe("20260817120000Z");
  });

  test("refuses another tag", () => {
    expect(() => readDerGeneralizedTime(decodeDer(Uint8Array.from([DER_TAG.NULL, 0x00]))))
      .toThrow(/GeneralizedTime/);
  });

  test("refuses non-ASCII content and malformed values", () => {
    expect(() => readDerGeneralizedTime(decodeDer(
      Uint8Array.from([DER_TAG.GENERALIZED_TIME, 0x02, 0xc3, 0xa9]),
    ))).toThrow(/ASCII/i);
    expect(() => readDerGeneralizedTime(decodeDer(timeElement("20260817120000+0100"))))
      .toThrow(/GeneralizedTime/);
  });
});

describe("comparison against calendar-strict RFC 3339 instants (design §8 step 4)", () => {
  test("compares equal, earlier, and later instants", () => {
    expect(compareDerGeneralizedTimeToRfc3339("20260817120000Z", "2026-08-17T12:00:00Z")).toBe(0);
    expect(compareDerGeneralizedTimeToRfc3339("20260817120000Z", "2026-08-17T12:00:01Z")).toBe(-1);
    expect(compareDerGeneralizedTimeToRfc3339("20260817120002Z", "2026-08-17T12:00:01Z")).toBe(1);
  });

  test("compares across offsets and arbitrary fractional tails", () => {
    expect(compareDerGeneralizedTimeToRfc3339("20260817120000Z", "2026-08-17T14:00:00+02:00"))
      .toBe(0);
    expect(compareDerGeneralizedTimeToRfc3339(
      "20260817120000.100000000000000001Z",
      "2026-08-17T12:00:00.100000000000000002Z",
    )).toBe(-1);
    // Trailing zeros on the RFC 3339 side do not change the instant.
    expect(compareDerGeneralizedTimeToRfc3339("20260817120000.5Z", "2026-08-17T12:00:00.500Z"))
      .toBe(0);
  });

  test("returns undefined when the RFC 3339 side is not calendar-strict", () => {
    expect(compareDerGeneralizedTimeToRfc3339("20260817120000Z", "2026-02-30T00:00:00Z"))
      .toBeUndefined();
    expect(compareDerGeneralizedTimeToRfc3339("20260817120000Z", "not-a-time")).toBeUndefined();
  });

  test("refuses a malformed GeneralizedTime rather than reporting an order", () => {
    expect(code(() => compareDerGeneralizedTimeToRfc3339(
      "20260817120000.100Z",
      "2026-08-17T12:00:00Z",
    ))).toBe("CONFORMANCE_FAILURE");
  });
});
