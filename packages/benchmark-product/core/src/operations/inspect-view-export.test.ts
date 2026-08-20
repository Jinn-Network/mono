import { describe, expect, test } from "vitest";
import {
  CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE,
  exportCompletenessCertification,
} from "../runtime/suite-protocol/comparability.js";
import {
  decideInspectViewExportMode,
  inspectViewExportInstructions,
} from "./inspect-view-export.js";

describe("Inspect View certification divergence (operator ruling of 2026-08-20, option c)", () => {
  const runSha256 = "c".repeat(64);
  const partial = { expected: 12, judged: 11, runOutcome: "partial" as const };
  const complete = { expected: 12, judged: 12, runOutcome: "complete" as const };

  test("the sentence appears only when suite-named and sealed outcome is not complete", () => {
    const divergent = exportCompletenessCertification({
      runSha256,
      completeness: partial,
      frameworkSubmitReady: true,
    });
    expect(divergent).toContain(CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE);
    expect(divergent.includes("\n")).toBe(false);
    const suiteNamed = inspectViewExportInstructions(divergent, "suite-named", "/tmp/view", "inspect-eval");
    expect(suiteNamed.split("\n")[0]).toBe(divergent);
    expect(suiteNamed).toContain(CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE);

    const completeReady = exportCompletenessCertification({
      runSha256,
      completeness: complete,
      frameworkSubmitReady: true,
    });
    expect(completeReady).not.toContain(CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE);
    expect(inspectViewExportInstructions(completeReady, "suite-named", "/tmp/view", "inspect-eval"))
      .not.toContain(CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE);

    const partialNotReady = exportCompletenessCertification({
      runSha256,
      completeness: partial,
      frameworkSubmitReady: false,
    });
    expect(partialNotReady).not.toContain(CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE);
    expect(inspectViewExportInstructions(partialNotReady, "inspection-upload", "/tmp/view", "inspect-eval"))
      .not.toContain(CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE);
  });

  test("the judge lane never carries the sentence: production mode is inspection-upload", () => {
    const production = exportCompletenessCertification({
      runSha256,
      completeness: partial,
      frameworkSubmitReady: false,
    });
    const judge = inspectViewExportInstructions(production, "inspection-upload", "/tmp/view", "inspect-binary-judge");
    expect(judge).not.toContain(CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE);
    expect(judge.split("\n")[0]).toBe(production);
  });

  test("the explanation gates no inspect-view instruction", () => {
    const plain = exportCompletenessCertification({ runSha256, completeness: partial });
    const explained = exportCompletenessCertification({
      runSha256,
      completeness: partial,
      frameworkSubmitReady: true,
    });
    for (const mode of ["suite-named", "inspection-upload"] as const) {
      for (const lane of ["inspect-eval", "inspect-binary-judge"] as const) {
        const before = inspectViewExportInstructions(plain, mode, "/tmp/view", lane).split("\n");
        const after = inspectViewExportInstructions(explained, mode, "/tmp/view", lane).split("\n");
        expect(after.slice(1)).toEqual(before.slice(1));
        expect(after[0]).toBe(explained);
      }
    }
    expect(decideInspectViewExportMode({
      executionConformance: true, coverage: "full", leaderboardSubmitReady: true,
    })).toBe("suite-named");
    expect(decideInspectViewExportMode({
      executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false,
    })).toBe("inspection-upload");
  });
});
