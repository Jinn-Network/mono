import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseBenchmark, sealBenchmark } from "./benchmark/schema.js";
import { parseMatrix, sealMatrix } from "./matrix/schema.js";
import { parseReport, sealReport } from "./report/schema.js";
import { parseRun, sealRun } from "./run/schema.js";
import { InvalidDocumentError } from "./sealing.js";

interface ExactFamily {
  readonly name: string;
  readonly fixture: string;
  readonly parse: (bytes: Uint8Array) => unknown;
  readonly seal: (document: unknown) => { readonly bytes: Uint8Array };
}

const families: readonly ExactFamily[] = [
  { name: "Benchmark", fixture: "../fixtures/benchmark/minimal.json", parse: parseBenchmark, seal: sealBenchmark },
  { name: "Run", fixture: "../fixtures/run/minimal.json", parse: parseRun, seal: sealRun },
  { name: "Matrix", fixture: "../fixtures/matrix/minimal.json", parse: parseMatrix, seal: sealMatrix },
  { name: "Report", fixture: "../fixtures/report/minimal.json", parse: parseReport, seal: sealReport },
];

function fixtureDocument(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as Record<string, unknown>;
}

function withExtension(family: ExactFamily, value: unknown): Uint8Array {
  return family.seal({
    ...fixtureDocument(family.fixture),
    "test.example.note": value,
  }).bytes;
}

function replaceNeedleByte(bytes: Uint8Array, needle: string): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const encoded = new TextEncoder().encode(needle);
  const start = copy.findIndex((_, index) =>
    encoded.every((byte, offset) => copy[index + offset] === byte),
  );
  if (start < 0) throw new Error(`fixture did not contain ${needle}`);
  copy[start] = 0xff;
  return copy;
}

describe.each(families)("$name exact public parser", (family) => {
  test("rejects a bare unknown top-level field", () => {
    expect(() => family.seal({
      ...fixtureDocument(family.fixture),
      bareUnknown: true,
    })).toThrow(InvalidDocumentError);
  });

  test.each([
    ["reverse-DNS", "org.example.benchmarking.note"],
    ["absolute-URI", "https://example.test/extensions/benchmarking-note"],
  ])("preserves a %s top-level extension", (_kind, key) => {
    const extension = { scalar: "rocket-\u{1f680}" };
    const parsed = family.parse(family.seal({
      ...fixtureDocument(family.fixture),
      [key]: extension,
    }).bytes) as Record<string, unknown>;
    expect(parsed[key]).toEqual(extension);
  });

  test("accepts exact canonical bytes containing a supplementary Unicode scalar", () => {
    expect(() => family.parse(withExtension(family, "rocket-\u{1f680}"))).not.toThrow();
  });

  test.each([
    ["pretty JSON", (text: string) => `${JSON.stringify(JSON.parse(text), null, 2)}\n`],
    ["reordered JSON", (text: string) => JSON.stringify(Object.fromEntries(
      Object.entries(JSON.parse(text) as Record<string, unknown>).reverse(),
    ))],
    ["trailing whitespace", (text: string) => `${text}\n`],
    ["duplicate top-level key", (text: string) => `{"protocol":"wrong",${text.slice(1)}`],
  ])("rejects %s rather than accepting semantic equivalence", (_label, mutate) => {
    const exact = withExtension(family, "ok");
    const noncanonical = new TextEncoder().encode(mutate(new TextDecoder().decode(exact)));
    expect(() => family.parse(noncanonical)).toThrow();
  });

  test("uses fatal UTF-8 decoding", () => {
    expect(() => family.parse(replaceNeedleByte(withExtension(family, "ok"), "ok"))).toThrow();
  });
});

describe("Report reserved-looking unknown fields", () => {
  test.each(["createdAt", "timestamp"])("rejects bare unknown top-level field %s", (key) => {
    expect(() => sealReport({
      ...fixtureDocument("../fixtures/report/minimal.json"),
      [key]: "2026-07-29T00:00:00Z",
    })).toThrow(InvalidDocumentError);
  });
});
