import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../testing.js";
import { checkVerdictConsistency } from "./verdict-consistency.js";
import type { EvaluationSpec } from "./schema.js";
import type { MeasurementMap, VerdictOutcome } from "./verdict-rule.js";

const familyDir = fileURLToPath(new URL("../../fixtures/verdict-consistency", import.meta.url));

// Fixtures assert the `{ ok, code }` shape (the convention shared with a thrown-ProfilesError
// projection, Task 2); the human-readable `reason` string is a real part of the return type but
// not pinned by fixture equality, so it can be reworded without touching fixtures.
function checkConsistency(input: unknown) {
  const { spec, delivered, measurements, declaredUnscorableClass } = input as {
    spec: Pick<EvaluationSpec, "verdictRule" | "unscorable">;
    delivered: VerdictOutcome;
    measurements: MeasurementMap;
    declaredUnscorableClass?: string;
  };
  const result = checkVerdictConsistency({
    spec: spec as EvaluationSpec,
    delivered,
    measurements,
    declaredUnscorableClass,
  });
  return result.ok ? { ok: true as const } : { ok: false as const, code: result.code };
}

describe("verdict-consistency check", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, checkConsistency);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});
