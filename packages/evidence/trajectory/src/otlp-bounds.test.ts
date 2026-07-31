// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import {
  INT64_MAX,
  INT64_MIN,
  UINT64_MAX,
  buildCanonicalUnsignedDecimalJsonSchemaPattern,
  int64DecimalJsonSchemaNode,
  isValidDecimalInt64,
  isValidDecimalUint64,
  jsonSchemaPatternToRegExp,
  uint64DecimalJsonSchemaPattern,
} from "./otlp-bounds.js";
import { SPAN_KIND, STATUS_CODE, SpanSchema } from "./span.js";

function uint64SchemaAccepts(value: string): boolean {
  return jsonSchemaPatternToRegExp(uint64DecimalJsonSchemaPattern()).test(value);
}

function int64SchemaAccepts(value: string): boolean {
  const node = int64DecimalJsonSchemaNode();
  return node.anyOf.some((branch) => jsonSchemaPatternToRegExp(branch.pattern).test(value));
}

function assertParity(value: string, kind: "uint64" | "int64"): void {
  if (value.length === 0) return;
  const schemaAccepts = kind === "uint64" ? uint64SchemaAccepts(value) : int64SchemaAccepts(value);
  const runtimeAccepts =
    kind === "uint64" ? isValidDecimalUint64(value) : isValidDecimalInt64(value);
  expect(schemaAccepts).toBe(runtimeAccepts);
}

function* prefixProbeValues(max: bigint): Generator<string> {
  const maxStr = max.toString();
  yield maxStr;
  yield (max + 1n).toString();
  yield (max - 1n).toString();
  for (let length = 0; length <= maxStr.length + 3; length += 1) {
    yield "0".repeat(length);
    yield "9".repeat(length);
  }
  for (let index = 0; index < maxStr.length; index += 1) {
    const prefix = maxStr.slice(0, index);
    const maxDigit = Number(maxStr[index]);
    for (const delta of [-1, 0, 1]) {
      const digit = maxDigit + delta;
      if (digit < 0) continue;
      yield `${prefix}${String(digit)}${"0".repeat(maxStr.length - index - 1)}`;
      yield `${prefix}${String(digit)}${"9".repeat(maxStr.length - index - 1)}`;
    }
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDecimalCorpus(rng: () => number, count: number): string[] {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = 1 + Math.floor(rng() * 22);
    let digits = String(1 + Math.floor(rng() * 9));
    for (let digit = 1; digit < length; digit += 1) {
      digits += String(Math.floor(rng() * 10));
    }
    if (rng() < 0.2) digits = "0";
    if (rng() < 0.15) digits = `-${digits === "0" ? "0" : digits}`;
    out.push(digits);
  }
  return out;
}

describe("OTLP decimal bounds generator", () => {
  test("uint64 pattern rejects max+1 and accepts max", () => {
    expect(uint64SchemaAccepts(UINT64_MAX.toString())).toBe(true);
    expect(uint64SchemaAccepts((UINT64_MAX + 1n).toString())).toBe(false);
    expect(isValidDecimalUint64((UINT64_MAX + 1n).toString())).toBe(false);
  });

  test("int64 pattern rejects 9464152666223001936 overflow", () => {
    expect(int64SchemaAccepts("9464152666223001936")).toBe(false);
    expect(isValidDecimalInt64("9464152666223001936")).toBe(false);
  });

  test("int64 preserves -0 law", () => {
    expect(int64SchemaAccepts("-0")).toBe(true);
    expect(isValidDecimalInt64("-0")).toBe(true);
  });

  test("differential parity for uint64 boundary corpus", () => {
    for (const value of prefixProbeValues(UINT64_MAX)) {
      assertParity(value, "uint64");
    }
    const rng = mulberry32(0xc157);
    for (const value of randomDecimalCorpus(rng, 512)) {
      if (value.startsWith("-")) continue;
      assertParity(value, "uint64");
    }
  });

  test("differential parity for int64 boundary corpus", () => {
    for (const value of prefixProbeValues(INT64_MAX)) {
      assertParity(value, "int64");
    }
    for (const value of prefixProbeValues(-INT64_MIN)) {
      assertParity(`-${value === "0" ? "1" : value}`, "int64");
    }
    assertParity("-0", "int64");
    assertParity("0", "int64");
    assertParity(INT64_MIN.toString(), "int64");
    assertParity(INT64_MAX.toString(), "int64");
    const rng = mulberry32(0xc158);
    for (const value of randomDecimalCorpus(rng, 512)) {
      assertParity(value, "int64");
    }
  });

  test("published trajectory schema uses generated uint64 and int64 law", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../schemas/trajectory.schema.json", import.meta.url), "utf8"),
    );
    const uint64Pattern = uint64DecimalJsonSchemaPattern();
    const int64Node = int64DecimalJsonSchemaNode();
    const violations: string[] = [];

    function walk(node: unknown, path: string): void {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.properties && typeof record.properties === "object") {
        const props = record.properties as Record<string, unknown>;
        if (props.intValue) {
          const actual = JSON.stringify(props.intValue);
          const expected = JSON.stringify({ $ref: "#/$defs/Int64DecimalString" });
          if (actual !== expected && actual !== JSON.stringify(int64Node)) {
            violations.push(`${path}.properties.intValue`);
          }
        }
      }
      if (record.type === "string" && typeof record.pattern === "string") {
        const pattern = record.pattern;
        if (pattern === uint64Pattern) return;
        if (pattern === "^(0|[1-9]\\d*)$" || pattern.includes("UnixNano") || pattern.includes("18446744073709551615")) {
          violations.push(`${path}.pattern`);
        }
      }
      if (record.$ref === "#/$defs/Int64DecimalString") return;
      for (const [key, value] of Object.entries(record)) {
        if (Array.isArray(value)) {
          value.forEach((entry, index) => walk(entry, `${path}/${key}[${index}]`));
        } else if (value && typeof value === "object") {
          walk(value, `${path}/${key}`);
        }
      }
    }

    walk(schema, "");
    expect(schema.$defs?.Int64DecimalString).toEqual(int64Node);
    expect(violations).toEqual([]);
  });

  test("AJV rejects uint64 max+1 at span timestamp and int64 overflow at attribute", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../schemas/trajectory.schema.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const overflowSpan = {
      spanId: "0123456789abcdef",
      parentSpanId: null,
      name: "x",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "18446744073709551616",
      endTimeUnixNano: "1",
      attributes: [],
      events: [],
      status: { code: STATUS_CODE.OK },
    };
    expect(validate({
      protocol: "https://jinn.network/protocols/trajectory/1.0",
      source: { nativeTrace: { digest: { sha256: "a".repeat(64) }, name: "n" }, formatIri: "https://example.com/f" },
      derivation: { decoderId: "d", decoderVersion: "1", vocabularyProfile: "claude-code-stream-json/v1" },
      timebase: "synthetic-ordinal",
      traceId: "a".repeat(32),
      spans: [overflowSpan],
      completeness: { decoded: "full" },
    })).toBe(false);
    expect(SpanSchema.safeParse(overflowSpan).success).toBe(false);

    const int64Span = {
      spanId: "0123456789abcdef",
      parentSpanId: null,
      name: "x",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "0",
      endTimeUnixNano: "1",
      attributes: [{ key: "gen_ai.provider.name", value: { intValue: "9464152666223001936" } }],
      events: [],
      status: { code: STATUS_CODE.OK },
    };
    expect(validate({
      protocol: "https://jinn.network/protocols/trajectory/1.0",
      source: { nativeTrace: { digest: { sha256: "a".repeat(64) }, name: "n" }, formatIri: "https://example.com/f" },
      derivation: { decoderId: "d", decoderVersion: "1", vocabularyProfile: "claude-code-stream-json/v1" },
      timebase: "synthetic-ordinal",
      traceId: "a".repeat(32),
      spans: [int64Span],
      completeness: { decoded: "full" },
    })).toBe(false);
    expect(SpanSchema.safeParse(int64Span).success).toBe(false);
  });

  test("generator branches cover exact MAX string", () => {
    expect(buildCanonicalUnsignedDecimalJsonSchemaPattern(UINT64_MAX)).toContain(
      UINT64_MAX.toString(),
    );
  });
});
