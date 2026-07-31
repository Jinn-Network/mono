// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
  decodeUtf8Lossy,
  extractArtifactText,
  parseNdjsonLines,
  textBearingStrings,
} from "./text.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("text extraction", () => {
  test("decodes UTF-8 and survives invalid bytes", () => {
    expect(decodeUtf8Lossy(encode("héllo"))).toBe("héllo");
    expect(decodeUtf8Lossy(new Uint8Array([0xff, 0xfe, 0x41]))).toContain("A");
  });

  test("collects text-bearing keys in object order", () => {
    expect(
      textBearingStrings({ command: "yarn test", exitCode: 1, result: "FAIL", ignored: "x" }),
    ).toEqual(["yarn test", "FAIL"]);
  });

  test("descends into nested objects and arrays within the depth budget", () => {
    expect(textBearingStrings({ args: { command: "ls -la" }, output: ["a", "b"] })).toEqual([
      "ls -la",
      "a",
      "b",
    ]);
  });

  test("stops at the depth budget rather than walking an adversarial structure", () => {
    let deep: unknown = { text: "buried" };
    for (let level = 0; level < 12; level += 1) deep = { args: deep };
    expect(textBearingStrings(deep)).toEqual([]);
  });

  test("numbers and booleans under a text-bearing key are stringified", () => {
    expect(textBearingStrings({ result: 0, output: true })).toEqual(["0", "true"]);
  });

  test("a plain-text artifact is returned as-is", () => {
    expect(extractArtifactText(encode("just some prose"), "text/plain")).toBe("just some prose");
  });

  test("a JSON artifact yields its text-bearing values", () => {
    expect(
      extractArtifactText(encode('{"summary":"do the thing","noise":1}'), "application/json"),
    ).toBe("do the thing");
  });

  test("an NDJSON artifact yields each line's text-bearing values", () => {
    const ndjson = '{"text":"first"}\n{"text":"second"}\n';
    expect(extractArtifactText(encode(ndjson), "application/x-ndjson")).toBe("first\nsecond");
  });

  test("undeclared media types are sniffed, and unparseable content falls back to raw text", () => {
    expect(extractArtifactText(encode('{"text":"sniffed"}'))).toBe("sniffed");
    expect(extractArtifactText(encode("{not json at all"))).toBe("{not json at all");
  });

  test("NDJSON parsing skips blank and malformed lines instead of failing", () => {
    expect(parseNdjsonLines('{"a":1}\n\nnot json\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
