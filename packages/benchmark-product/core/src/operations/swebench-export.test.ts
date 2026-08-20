import { describe, expect, test } from "vitest";
import { SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE } from "../runtime/suite-protocol/comparability.js";
import {
  decideSwebenchPredictionsExportMode,
  swebenchPredictionsExportInstructions,
} from "./swebench-export.js";

describe("SWE-bench Verified predictions export decision", () => {
  test("decides inspection vs leaderboard vs refuse without claiming a swebench.com row", () => {
    expect(decideSwebenchPredictionsExportMode({ executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false })).toBe("inspection-upload");
    expect(decideSwebenchPredictionsExportMode({ executionConformance: true, coverage: "ten_task", leaderboardSubmitReady: false })).toBe("inspection-upload");
    expect(decideSwebenchPredictionsExportMode({ executionConformance: true, coverage: "full", leaderboardSubmitReady: true })).toBe("leaderboard-submit");
    expect(decideSwebenchPredictionsExportMode({ executionConformance: true, coverage: "custom", leaderboardSubmitReady: false })).toBe("refused");
    expect(decideSwebenchPredictionsExportMode({ executionConformance: false, coverage: "full", leaderboardSubmitReady: false })).toBe("refused");
    // custom coverage never wears the suite name, even when everything else is ready
    expect(decideSwebenchPredictionsExportMode({ executionConformance: true, coverage: "custom", leaderboardSubmitReady: true })).toBe("refused");
  });

  test("both instruction modes carry the submit-closed sentence and the right sb-submit posture", () => {
    const certification = "complete run of the selection sealed at lock aaaa: 1 of 1 cells judged.";
    const inspection = swebenchPredictionsExportInstructions(certification, "inspection-upload", "/tmp/export");
    expect(inspection.split("\n")[0]).toBe(certification);
    expect(inspection).toContain("/tmp/export");
    expect(inspection).toContain("Do not run `sb submit`");
    expect(inspection).toContain(SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE);
    expect(inspection).not.toMatch(/Terminal-Bench|APEX-Agents/u);
    const ready = swebenchPredictionsExportInstructions(certification, "leaderboard-submit", "/tmp/export");
    expect(ready.split("\n")[0]).toBe(certification);
    expect(ready).toContain("python -m swebench.harness.run_evaluation");
    expect(ready).toContain("sb submit /tmp/export/predictions.jsonl");
    expect(ready).toContain(SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE);
    expect(ready).not.toMatch(/Terminal-Bench|APEX-Agents/u);
  });
});
