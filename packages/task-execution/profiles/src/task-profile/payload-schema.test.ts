import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../testing.js";
import { canonicalJsonBytes } from "../bytes.js";
import { compilePayloadValidator, type RegExpEngine } from "./payload-schema.js";

const familyDir = fileURLToPath(new URL("../../fixtures/schema-hardening", import.meta.url));

interface HardeningInput {
  schema?: unknown;
  payload?: unknown;
  byteLengthOverride?: number;
  nestDepth?: number;
  patternLength?: number;
}

function buildSchema(input: HardeningInput): unknown {
  if (input.nestDepth !== undefined) {
    let node: unknown = { type: "string" };
    for (let i = 0; i < input.nestDepth; i++) {
      node = { type: "object", properties: { child: node } };
    }
    return node;
  }
  if (input.patternLength !== undefined) {
    return { type: "string", pattern: "a".repeat(input.patternLength) };
  }
  return input.schema;
}

function checkHardening(raw: unknown) {
  const input = raw as HardeningInput;
  const schema = buildSchema(input);
  const bytes = input.byteLengthOverride !== undefined
    ? new Uint8Array(input.byteLengthOverride)
    : canonicalJsonBytes(schema);
  const validator = compilePayloadValidator(schema, bytes);
  const result = validator(input.payload);
  return { ok: result.ok };
}

describe("payload-schema hardening (admission-time static pre-filter)", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, checkHardening);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});

describe("injectable regExp engine (program §7.17)", () => {
  it("uses native RegExp by default", () => {
    const schema = { type: "string", pattern: "^[a-z]+$" };
    const bytes = canonicalJsonBytes(schema);
    const validator = compilePayloadValidator(schema, bytes);
    expect(validator("abc")).toEqual({ ok: true });
    expect(validator("ABC").ok).toBe(false);
  });

  it("compiles with an injected RE2-shaped engine instead of native RegExp", () => {
    let constructedCount = 0;
    class InstrumentedRegExp {
      private readonly inner: RegExp;
      constructor(pattern: string, flags?: string) {
        constructedCount += 1;
        this.inner = new RegExp(pattern, flags);
      }
      test(value: string): boolean {
        return this.inner.test(value);
      }
    }
    const engine: RegExpEngine = InstrumentedRegExp;
    const schema = { type: "string", pattern: "^[a-z]+$" };
    const bytes = canonicalJsonBytes(schema);
    const validator = compilePayloadValidator(schema, bytes, { regExp: engine });
    expect(validator("abc")).toEqual({ ok: true });
    expect(validator("ABC").ok).toBe(false);
    expect(constructedCount).toBeGreaterThan(0);
  });
});
