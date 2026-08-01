import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../../testing.js";
import { checkStatePredicateBlock } from "./spec-checks.js";

const familyDir = fileURLToPath(new URL("../../../fixtures/state-predicate-block", import.meta.url));

describe("state-predicate family block", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBe(12);
    const results = runStructuralCheck(cases, checkStatePredicateBlock);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});
