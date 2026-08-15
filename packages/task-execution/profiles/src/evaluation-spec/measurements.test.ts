import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../testing.js";
import { checkMeasurementCoverage } from "./measurements.js";
import type { EvaluationSpec } from "./schema.js";
import type { MeasurementMap } from "./verdict-rule.js";

const familyDir = fileURLToPath(new URL("../../fixtures/measurements-coverage", import.meta.url));

function checkCoverage(input: unknown) {
  const { spec, delivered } = input as { spec: Pick<EvaluationSpec, "measurements">; delivered: MeasurementMap };
  return checkMeasurementCoverage(spec as EvaluationSpec, delivered);
}

describe("required-measurement coverage", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, checkCoverage);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});
