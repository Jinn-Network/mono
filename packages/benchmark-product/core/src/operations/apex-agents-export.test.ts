import { describe, expect, test } from "vitest";
import { APEX_AGENTS_SUBMIT_CLOSED_SENTENCE } from "../runtime/suite-protocol/comparability.js";
import {
  apexAgentsExportInstructions,
  decideApexAgentsExportMode,
} from "./apex-agents-export.js";

describe("APEX-Agents inspection export decision", () => {
  test("decides inspection vs leaderboard vs refuse without claiming a Mercor row", () => {
    expect(decideApexAgentsExportMode({ executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false })).toBe("inspection-upload");
    expect(decideApexAgentsExportMode({ executionConformance: true, coverage: "ten_task", leaderboardSubmitReady: false })).toBe("inspection-upload");
    expect(decideApexAgentsExportMode({ executionConformance: true, coverage: "full", leaderboardSubmitReady: true })).toBe("leaderboard-submit");
    expect(decideApexAgentsExportMode({ executionConformance: true, coverage: "custom", leaderboardSubmitReady: false })).toBe("refused");
    expect(decideApexAgentsExportMode({ executionConformance: false, coverage: "full", leaderboardSubmitReady: false })).toBe("refused");
    // custom coverage never wears the suite name, even when everything else is ready
    expect(decideApexAgentsExportMode({ executionConformance: true, coverage: "custom", leaderboardSubmitReady: true })).toBe("refused");
  });

  test("both instruction modes carry the submit-closed sentence and never name a sibling suite", () => {
    const inspection = apexAgentsExportInstructions("inspection-upload", "/tmp/export");
    expect(inspection).toContain("/tmp/export");
    expect(inspection).toContain("not leaderboard_submit_ready");
    expect(inspection).toContain(APEX_AGENTS_SUBMIT_CLOSED_SENTENCE);
    expect(inspection).not.toMatch(/Terminal-Bench|SWE-bench/u);
    const ready = apexAgentsExportInstructions("leaderboard-submit", "/tmp/export");
    expect(ready).toContain("/tmp/export");
    expect(ready).toContain(APEX_AGENTS_SUBMIT_CLOSED_SENTENCE);
    expect(ready).not.toMatch(/Terminal-Bench|SWE-bench/u);
  });
});
