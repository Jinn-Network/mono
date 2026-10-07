import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProfilesError } from "../../errors.js";
import { loadFixtureFamily, runStructuralCheck } from "../../testing.js";
import {
  EXTERNAL_VERIFIER_FAMILY,
  EXTERNAL_VERIFIER_HARNESSES,
  EXTERNAL_VERIFIER_SEMANTICS_VERSION,
  ExternalVerifierBlockSchema,
  FAMILY_BLOCK_SCHEMAS,
} from "../family-blocks.js";
import { checkExternalVerifierBlock } from "./spec-checks.js";

const familyDir = fileURLToPath(new URL("../../../fixtures/external-verifier-block", import.meta.url));

const entry = (name: string, digit: string, extra: Record<string, unknown> = {}) => ({
  name,
  digest: { sha256: digit.repeat(64) },
  ...extra,
});

const block = (testMaterial: unknown[]) => ({
  harness: "harbor",
  verifierSemanticsVersion: "1",
  testMaterial,
  timeout: 900,
});

/** Adds an own key named `__proto__`, the way JSON text carries one. The key comes from
 * `JSON.parse` because a literal `{ __proto__: ... }` sets the prototype and adds no key. */
function withOwnProtoKey(value: Record<string, unknown>): Record<string, unknown> {
  const carrier = JSON.parse('{"__proto__": {"platform": "linux/amd64"}}') as Record<string, unknown>;
  return { ...carrier, ...value };
}

describe("external-verifier family block", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBe(19);
    const results = runStructuralCheck(cases, checkExternalVerifierBlock);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });

  it("names the family, one block version and one harness", () => {
    expect(EXTERNAL_VERIFIER_FAMILY).toBe("external-verifier");
    expect(EXTERNAL_VERIFIER_SEMANTICS_VERSION).toBe("1");
    expect(EXTERNAL_VERIFIER_HARNESSES).toEqual(["harbor"]);
    expect(FAMILY_BLOCK_SCHEMAS[EXTERNAL_VERIFIER_FAMILY]).toBe(ExternalVerifierBlockSchema);
  });

  it("accepts several entries whose names ascend, with or without an access class", () => {
    const parsed = ExternalVerifierBlockSchema.safeParse(
      block([
        entry("tests/fixtures/expected.json", "c", { accessClass: "private" }),
        entry("tests/test.sh", "b", { accessClass: "public" }),
        entry("tests/test_outputs.py", "d"),
      ]),
    );
    expect(parsed.success).toBe(true);
  });

  it("orders names by Unicode code point, not by UTF-16 code unit", () => {
    // U+FF21 is one code unit (ff21). U+10400 is two (d801 dc00). By code point U+FF21 comes
    // first; by code unit the surrogate d801 would.
    const basicPlane = entry("tests/Ａ.txt", "a");
    const supplementary = entry("tests/\u{10400}.txt", "b");
    expect(ExternalVerifierBlockSchema.safeParse(block([basicPlane, supplementary])).success).toBe(true);
    expect(ExternalVerifierBlockSchema.safeParse(block([supplementary, basicPlane])).success).toBe(false);
  });

  it("refuses an entry whose name is the empty string", () => {
    expect(ExternalVerifierBlockSchema.safeParse(block([entry("", "b")])).success).toBe(false);
  });

  it("refuses an entry whose digest is not 64 lowercase hexadecimal digits", () => {
    for (const sha256 of ["B".repeat(64), "b".repeat(63), "b".repeat(65), ""]) {
      const parsed = ExternalVerifierBlockSchema.safeParse(block([{ name: "tests/test.sh", digest: { sha256 } }]));
      expect(parsed.success, JSON.stringify(sha256)).toBe(false);
    }
  });

  it("refuses the keys of a deterministic-process block", () => {
    for (const key of ["image", "platform", "workspace", "parser", "transitions", "setupPolicy"]) {
      const parsed = ExternalVerifierBlockSchema.safeParse({ ...block([entry("tests/test.sh", "b")]), [key]: {} });
      expect(parsed.success, key).toBe(false);
    }
  });

  it("refuses a bare own key named __proto__, like any other bare extra key", () => {
    const input = withOwnProtoKey(block([entry("tests/test.sh", "b")]));
    // The input is the case under test only if the key is its own and its prototype is untouched.
    expect(Object.hasOwn(input, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    expect(JSON.stringify(input)).toContain('"__proto__":{"platform":"linux/amd64"}');

    const parsed = ExternalVerifierBlockSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([["__proto__"]]);
    expect(FAMILY_BLOCK_SCHEMAS[EXTERNAL_VERIFIER_FAMILY].safeParse(input).success).toBe(false);
    expect(() => checkExternalVerifierBlock({ family: EXTERNAL_VERIFIER_FAMILY, block: input })).toThrow(ProfilesError);
  });

  it("keeps a namespaced extra key, and returns a plain block as it was given", () => {
    const plain = block([entry("tests/test.sh", "b")]);
    expect(checkExternalVerifierBlock({ family: EXTERNAL_VERIFIER_FAMILY, block: plain })).toEqual(plain);
    const namespaced = { ...plain, "org.example.note": { platform: "linux/amd64" } };
    expect(checkExternalVerifierBlock({ family: EXTERNAL_VERIFIER_FAMILY, block: namespaced })).toEqual(namespaced);
  });

  it("the fixture check refuses a block offered under another family name", () => {
    const input = { family: "deterministic-process", block: block([entry("tests/test.sh", "b")]) };
    expect(() => checkExternalVerifierBlock(input)).toThrow(ProfilesError);
  });
});
