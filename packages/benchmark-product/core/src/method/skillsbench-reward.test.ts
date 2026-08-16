import { describe, expect, it } from "vitest";
import {
  SKILLSBENCH_REWARD_CONTRACT,
  judgeSkillsBenchControls,
  parseSkillsBenchCtrf,
  readSkillsBenchReward,
} from "./skillsbench-reward.js";

const CTRF = JSON.stringify({ results: { summary: { tests: 8, passed: 8, failed: 0 } } });

describe("reward normalization", () => {
  it("reads a full pass from the shipped reward.txt contract", () => {
    const reading = readSkillsBenchReward({ rewardTxt: "1\n", ctrfJson: CTRF });
    expect(reading.contract).toBe(SKILLSBENCH_REWARD_CONTRACT);
    expect(reading.outcome).toBe("full-pass");
    expect(reading.rawReward).toBe(1);
    expect(reading.ctrf).toEqual({ tests: 8, passed: 8, failed: 0 });
  });

  it("reads a fail", () => {
    expect(readSkillsBenchReward({ rewardTxt: "0\n" }).outcome).toBe("fail");
  });

  it("reads the canonical full-success value from the task, never assuming 1", () => {
    const reading = readSkillsBenchReward({ rewardTxt: "4", canonicalFullSuccess: 4 });
    expect(reading.outcome).toBe("full-pass");
    expect(reading.canonicalFullSuccess).toBe(4);
    // The same raw reward against a different canonical value is not a full pass.
    expect(readSkillsBenchReward({ rewardTxt: "4", canonicalFullSuccess: 8 }).outcome).toBe("partial");
  });

  it("retains a fractional reward as partial rather than coercing it", () => {
    const reading = readSkillsBenchReward({ rewardTxt: "0.5" });
    expect(reading.outcome).toBe("partial");
    expect(reading.rawReward).toBe(0.5);
  });

  describe("unscorable rather than coerced", () => {
    it("treats an absent reward file as unscorable, not a fail", () => {
      // Treating a missing file as a fail would convert infrastructure trouble into evidence.
      const reading = readSkillsBenchReward({ rewardTxt: null });
      expect(reading.outcome).toBe("unscorable");
      expect(reading.rawReward).toBeNull();
      expect(reading.detail).toMatch(/absent/u);
    });

    it.each([
      ["", /empty/u],
      ["   \n", /empty/u],
      ["PASS", /not a decimal/u],
      ["1; rm -rf /", /not a decimal/u],
      ["-1", /outside/u],
      ["2", /outside/u],
    ])("refuses reward.txt %j", (rewardTxt, pattern) => {
      const reading = readSkillsBenchReward({ rewardTxt });
      expect(reading.outcome).toBe("unscorable");
      expect(reading.detail).toMatch(pattern);
    });

    it("refuses a non-positive canonical full-success value", () => {
      expect(readSkillsBenchReward({ rewardTxt: "1", canonicalFullSuccess: 0 }).outcome).toBe("unscorable");
    });
  });

  describe("CTRF parsing", () => {
    it("returns null for absent or malformed CTRF without failing the reading", () => {
      expect(parseSkillsBenchCtrf(null)).toBeNull();
      expect(parseSkillsBenchCtrf("{not json")).toBeNull();
      expect(parseSkillsBenchCtrf("{}")).toBeNull();
      // reward.txt stays primary, so a broken CTRF does not lose a valid outcome.
      expect(readSkillsBenchReward({ rewardTxt: "1", ctrfJson: "{not json" }).outcome).toBe("full-pass");
    });

    it("extracts the summary counts", () => {
      expect(parseSkillsBenchCtrf(CTRF)).toEqual({ tests: 8, passed: 8, failed: 0 });
    });
  });
});

describe("no-model controls", () => {
  const pass = readSkillsBenchReward({ rewardTxt: "1" });
  const fail = readSkillsBenchReward({ rewardTxt: "0" });
  const missing = readSkillsBenchReward({ rewardTxt: null });

  it("admits a unit whose oracle passes and whose no-op fails", () => {
    expect(judgeSkillsBenchControls(pass, fail)).toEqual({ eligible: true, reasons: [] });
  });

  it("refuses when the oracle does not reach full success", () => {
    const judged = judgeSkillsBenchControls(fail, fail);
    expect(judged.eligible).toBe(false);
    expect(judged.reasons).toContain("oracle-did-not-reach-full-success:fail");
  });

  it("refuses when a blank submission reaches full success", () => {
    const judged = judgeSkillsBenchControls(pass, pass);
    expect(judged.eligible).toBe(false);
    expect(judged.reasons).toContain("no-op-submission-reached-full-success");
  });

  it("refuses when the no-op control is unscorable", () => {
    // A no-op that failed to produce an outcome proves nothing about answerability.
    const judged = judgeSkillsBenchControls(pass, missing);
    expect(judged.eligible).toBe(false);
    expect(judged.reasons).toContain("no-op-control-unscorable");
  });

  it("refuses when the two controls disagree on the canonical full-success value", () => {
    const judged = judgeSkillsBenchControls(pass, readSkillsBenchReward({ rewardTxt: "0", canonicalFullSuccess: 4 }));
    expect(judged.eligible).toBe(false);
    expect(judged.reasons).toContain("controls-disagree-on-canonical-full-success");
  });
});
