import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../testing.js";
import { ProfilesError } from "../errors.js";
import { UnscorableClassSchema } from "./unscorable.js";

const familyDir = fileURLToPath(new URL("../../fixtures/unscorable", import.meta.url));

function checkUnscorableClass(input: unknown) {
  const parsed = UnscorableClassSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProfilesError("invalid-document", "unscorable class failed schema validation");
  }
  return parsed.data;
}

describe("unscorable taxonomy (2 dispositions, §7.4)", () => {
  it("classifies retryable-infrastructure (never FAIL, never inconclusive) and recorded-inconclusive (verdict IS inconclusive)", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, checkUnscorableClass);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});
