import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../testing.js";
import { ProfilesError } from "../errors.js";
import { FAMILY_BLOCK_SCHEMAS } from "./family-blocks.js";
import type { GraderFamily } from "./schema.js";
import { parserAllowlistKey } from "./parser-registry.js";

const familyDir = fileURLToPath(new URL("../../fixtures/family-blocks", import.meta.url));

function checkFamilyBlock(input: unknown) {
  const { family, block } = input as { family: GraderFamily; block: unknown };
  const schema = FAMILY_BLOCK_SCHEMAS[family];
  const parsed = schema.safeParse(block);
  if (!parsed.success) {
    throw new ProfilesError("invalid-document", "family block failed schema validation");
  }
  return parsed.data;
}

describe("grader family blocks", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, checkFamilyBlock);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});

describe("parser allowlist registry (advisory, never a document-validity gate)", () => {
  it("is a pure string projection that never executes anything", () => {
    const parser = {
      id: "jinn.parser.pytest-json-report",
      version: "1.0.0",
      digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const,
    };
    const key = parserAllowlistKey(parser);
    expect(typeof key).toBe("string");
    expect(parserAllowlistKey(parser)).toBe(key); // pure: identical input -> identical output
  });
});
