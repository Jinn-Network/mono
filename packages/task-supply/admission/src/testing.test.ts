import { describe, expect, it } from "vitest";
import { admitCandidate } from "./admit.js";
import { ADMISSION_REFUSAL_CODES } from "./refusals.js";
import {
  describeTaskAdmissionConformance,
  goldenCandidate,
  goldenEnvironmentRecordBytes,
  mismatchedImageCandidate,
  scriptedRunner,
} from "./testing.js";

describeTaskAdmissionConformance("in-package", {
  admitCandidate,
  goldenCandidate,
  goldenEnvironmentRecordBytes,
  mismatchedImageCandidate,
  scriptedRunner,
});

describe("the kit reaches every refusal code", () => {
  it("covers the closed taxonomy", async () => {
    const reached = new Set<string>();
    for (const scenario of Object.values(scriptedRunner.refusalScenarios)) {
      const result = await admitCandidate(
        { runInEnvironment: scenario.runner, issuer: "https://jinn.network/agents/kit" },
        scenario.candidate(),
        scenario.recordBytes(),
      );
      if ("refusal" in result) reached.add(result.refusal.code);
    }
    expect([...reached].sort()).toStrictEqual([...ADMISSION_REFUSAL_CODES]);
  });
});
