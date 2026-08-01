import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../../testing.js";
import type { StatePredicateBlock } from "../family-blocks.js";
import type { CanonicalChainObservation } from "./observation.js";
import { evaluatePredicates } from "./evaluate.js";

const familyDir = fileURLToPath(new URL("../../../fixtures/state-predicate-evaluation", import.meta.url));

function checkEvaluation(input: unknown): unknown {
  const { block, observation } = input as {
    block: StatePredicateBlock;
    observation: CanonicalChainObservation;
  };
  return evaluatePredicates(observation, block);
}

describe("evaluatePredicates", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBe(6);
    const results = runStructuralCheck(cases, checkEvaluation);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});
