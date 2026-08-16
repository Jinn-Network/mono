// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  parseBinaryJudgmentResponse,
  trimBinaryJudgmentResponseEdges,
} from "./parse.js";

const encoder = new TextEncoder();

describe("parseBinaryJudgmentResponse", () => {
  test.each([
    ["ACCEPT", "ACCEPT"],
    ["REJECT", "REJECT"],
    [" \t\r\nACCEPT\n\t ", "ACCEPT"],
    ["\nREJECT\r", "REJECT"],
  ] as const)("accepts the exact token in %j", (input, decision) => {
    expect(parseBinaryJudgmentResponse(encoder.encode(input))).toEqual({
      decision,
      parseValid: true,
    });
  });

  test.each([
    "",
    "accept",
    "Reject",
    "ACCEPT.",
    "ACCEPT REJECT",
    "ACCEPT\u000b",
    "\u00a0ACCEPT\u00a0",
    "\ufeffACCEPT",
    "ＡＣＣＥＰＴ",
    "A\u0301CCEPT",
    "ACCEPT\u0000",
  ])("maps the unexpected token %j to an invalid REJECT", (input) => {
    expect(parseBinaryJudgmentResponse(encoder.encode(input))).toEqual({
      decision: "REJECT",
      parseValid: false,
      invalidReason: "unexpected-token",
    });
  });

  test.each([
    new Uint8Array([0xff]),
    new Uint8Array([0xc3, 0x28]),
    new Uint8Array([0xed, 0xa0, 0x80]),
    new Uint8Array([0x41, 0x43, 0x43, 0x45, 0x50, 0x54, 0x80]),
  ])("maps malformed UTF-8 to an invalid REJECT", (input) => {
    expect(parseBinaryJudgmentResponse(input)).toEqual({
      decision: "REJECT",
      parseValid: false,
      invalidReason: "invalid-utf8",
    });
  });

  test("does not mutate the caller's byte buffer", () => {
    const bytes = encoder.encode("\tACCEPT\n");
    const before = new Uint8Array(bytes);
    parseBinaryJudgmentResponse(bytes);
    expect(bytes).toEqual(before);
  });
});

describe("trimBinaryJudgmentResponseEdges", () => {
  test("only trims the four sealed ASCII edge code points", () => {
    expect(trimBinaryJudgmentResponseEdges("\u00a0 \tACCEPT\r\n \u00a0"))
      .toBe("\u00a0 \tACCEPT\r\n \u00a0");
    expect(trimBinaryJudgmentResponseEdges(" \t\r\nACCEPT\n\r\t ")).toBe("ACCEPT");
  });
});
