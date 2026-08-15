import { describe, expect, test } from "vitest";

import { GEN_AI_ATTRIBUTES, JINN_ATTRIBUTES } from "@jinn-network/evidence-trace";

import {
  ADMITTED_ATTRIBUTE_KEYS,
  DECODE_FAILURE_REASONS,
  DecoderContractError,
  SourceDigestMismatchError,
  TIMEBASES,
  UnsupportedFormatError,
  sortAttributes,
} from "./contract.js";

const attribute = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});

describe("decoder contract", () => {
  test("the admitted vocabulary is exactly C1's two attribute maps", () => {
    const expected = new Set([
      ...Object.values(GEN_AI_ATTRIBUTES),
      ...Object.values(JINN_ATTRIBUTES),
    ]);
    expect([...ADMITTED_ATTRIBUTE_KEYS].sort()).toEqual([...expected].sort());
  });

  test("the frozen parser's content-bearing keys are not admitted", () => {
    for (const key of ["message.content", "tool.args", "tool.result", "tool.name"]) {
      expect(ADMITTED_ATTRIBUTE_KEYS.has(key)).toBe(false);
    }
  });

  test("sortAttributes orders by UTF-16 code unit, not by locale", () => {
    const sorted = sortAttributes([
      attribute("gen_ai.usage.input_tokens", "1"),
      attribute("gen_ai.provider.name", "anthropic"),
      attribute("gen_ai.agent.name", "x"),
    ]);
    expect(sorted.map((entry) => entry.key)).toEqual([
      "gen_ai.agent.name",
      "gen_ai.provider.name",
      "gen_ai.usage.input_tokens",
    ]);
  });

  test("sortAttributes does not mutate its input", () => {
    const input = [
      attribute("gen_ai.provider.name", "1"),
      attribute("gen_ai.agent.name", "2"),
    ];
    sortAttributes(input);
    expect(input.map((entry) => entry.key)).toEqual([
      "gen_ai.provider.name",
      "gen_ai.agent.name",
    ]);
  });

  test("sortAttributes rejects duplicate keys", () => {
    expect(() => sortAttributes([attribute("a", "1"), attribute("a", "2")])).toThrow(
      DecoderContractError,
    );
  });

  test("sortAttributes rejects a key outside the admitted vocabulary", () => {
    expect(() => sortAttributes([attribute("message.content", "secret")])).toThrow(
      DecoderContractError,
    );
  });

  test("the timebase vocabulary is C1's first-class field", () => {
    expect([...TIMEBASES]).toEqual(["source-epoch-ns", "synthetic-ordinal"]);
  });

  test("failure reasons are the three the outcome union admits", () => {
    expect([...DECODE_FAILURE_REASONS]).toEqual([
      "unsupported-format",
      "source-digest-mismatch",
      "decoder-contract",
    ]);
  });

  test("errors carry a machine-readable category and their subject", () => {
    const unsupported = new UnsupportedFormatError("https://example.test/formats/x/v1");
    expect(unsupported.category).toBe("unsupported-format");
    expect(unsupported.formatIri).toBe("https://example.test/formats/x/v1");

    const mismatch = new SourceDigestMismatchError(`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`);
    expect(mismatch.category).toBe("source-digest-mismatch");
    expect(mismatch.message).toContain("b".repeat(64));

    const violation = new DecoderContractError(["spans must be sorted"]);
    expect(violation.category).toBe("decoder-contract");
    expect(violation.violations).toEqual(["spans must be sorted"]);
  });
});
