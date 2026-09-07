import { BENCHMARKING_METHOD_IDS } from "@jinn-network/benchmarking-records";
import { describe, expect, it } from "vitest";
import { SKILLSBENCH_DEMO1_FINAL_DECLARATION, SKILLSBENCH_DEMO1_PILOT_DECLARATION } from "./skillsbench-demo1-current.js";
import { sealDemo1Manifest } from "./skillsbench-demo1-seal.js";
import { SKILLSBENCH_DEMO1_METHOD_IDS, SKILLSBENCH_DEMO1_METHOD_VERSION } from "./skillsbench-demo1-stats.js";

const STAGES = [
  ["pilot", SKILLSBENCH_DEMO1_PILOT_DECLARATION],
  ["final", SKILLSBENCH_DEMO1_FINAL_DECLARATION],
] as const;

function sealedAnalysisPlan(stage: "pilot" | "final"): { readonly id: string; readonly version: string }[] {
  const declaration = STAGES.find(([name]) => name === stage)![1];
  const manifest = JSON.parse(new TextDecoder().decode(sealDemo1Manifest(declaration, stage).bytes));
  return manifest.analysisPlan;
}

/**
 * Issue #2973. Demo-1's three analyses are computed locally by `skillsbench-demo1-stats.ts` —
 * a paired Student-t interval over continuous per-task reward deltas, a method-of-moments
 * variance split, and a control-arm uplift. None of them is a §9.2 registered method, so none
 * may be cited under a `BENCHMARKING_METHOD_IDS` identifier: a reader who resolves such an
 * identifier reaches `packages/benchmarking/aggregate`'s registered implementation, which for
 * `paired-delta@1` is a clustered BCa bootstrap over binary pass rates and did not produce
 * these numbers.
 */
describe("Demo-1 analysis plan method identifiers (#2973)", () => {
  const registered = new Set<string>(Object.values(BENCHMARKING_METHOD_IDS));

  for (const [stage] of STAGES) {
    it(`does not cite a registered method identifier it is not the implementation of (${stage})`, () => {
      const cited = sealedAnalysisPlan(stage).map((entry) => entry.id);
      expect(cited.filter((id) => registered.has(id))).toEqual([]);
    });

    it(`cites the identifiers owned by the module that computes the numbers (${stage})`, () => {
      expect(sealedAnalysisPlan(stage)).toEqual([
        { id: SKILLSBENCH_DEMO1_METHOD_IDS.manipulationCheck, version: SKILLSBENCH_DEMO1_METHOD_VERSION, parameters: expect.any(Object) },
        { id: SKILLSBENCH_DEMO1_METHOD_IDS.pairedMeanDelta, version: SKILLSBENCH_DEMO1_METHOD_VERSION, parameters: expect.any(Object) },
        { id: SKILLSBENCH_DEMO1_METHOD_IDS.varianceDecomposition, version: SKILLSBENCH_DEMO1_METHOD_VERSION, parameters: expect.any(Object) },
      ]);
    });
  }

  it("keeps every Demo-1 identifier out of the shared registry namespace", () => {
    for (const id of Object.values(SKILLSBENCH_DEMO1_METHOD_IDS)) {
      expect(id.startsWith("jinn.demo1.method/")).toBe(true);
      expect(registered.has(id)).toBe(false);
    }
  });
});
