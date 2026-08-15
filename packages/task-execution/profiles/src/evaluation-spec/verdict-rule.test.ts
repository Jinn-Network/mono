import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../testing.js";
import { ProfilesError } from "../errors.js";
import { evaluateVerdictRule, VerdictRuleSchema, type MeasurementMap } from "./verdict-rule.js";

const familyDir = fileURLToPath(new URL("../../fixtures/verdict-rule", import.meta.url));

function checkVerdictRule(input: unknown) {
  const { rule, measurements } = input as { rule: unknown; measurements: MeasurementMap };
  const parsed = VerdictRuleSchema.safeParse(rule);
  if (!parsed.success) {
    throw new ProfilesError("invalid-document", "verdictRule failed schema validation");
  }
  return evaluateVerdictRule(parsed.data, measurements);
}

describe("closed-vocabulary verdict rule + evaluator", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, checkVerdictRule);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});
