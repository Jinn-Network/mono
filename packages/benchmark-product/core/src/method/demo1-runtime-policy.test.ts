import { describe, expect, it } from "vitest";
import {
  DEMO1_PROVIDER_CALL_LIMITS,
  DEMO1_RUNTIME_CANDIDATES,
  buildDemo1RuntimeSelection,
  decideDemo1Runtime,
  demo1RuntimePolicyDecisionDigest,
  verifyDemo1RuntimeSelection,
  type Demo1RuntimeSuitabilitySummary,
} from "./demo1-runtime-policy.js";

const informative: Demo1RuntimeSuitabilitySummary = {
  expectedCells: 12,
  accountedCells: 12,
  validGraderOutcomes: 12,
  passes: 5,
  timeoutFails: 0,
  unresolvedInfrastructure: 0,
  incompatibilities: 0,
  skillLoaderCanary: "pass",
};

describe("Demo-1 cheapest-capable runtime policy", () => {
  it("starts with pinned Haiku low and selects it when the task band is informative", () => {
    const decision = decideDemo1Runtime(0, informative);
    expect(decision.candidate).toEqual({
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      modelClass: "haiku",
    });
    expect(decision.disposition).toBe("select-runtime");
    expect(decision.nextCandidate).toBeNull();
  });

  it("escalates effort before model class, and model class only after measured floor effects", () => {
    const floor = { ...informative, passes: 1 };
    expect(decideDemo1Runtime(0, floor).nextCandidate).toEqual(DEMO1_RUNTIME_CANDIDATES[1]);
    expect(decideDemo1Runtime(1, floor).nextCandidate).toEqual(DEMO1_RUNTIME_CANDIDATES[2]);
    expect(decideDemo1Runtime(2, floor).nextCandidate).toEqual(DEMO1_RUNTIME_CANDIDATES[3]);
    expect(decideDemo1Runtime(3, floor)).toMatchObject({
      disposition: "stop-inconclusive",
      reasons: ["floor-effect-runtime-ladder-exhausted"],
    });
  });

  it("changes an easy task band instead of buying a stronger model", () => {
    expect(decideDemo1Runtime(0, { ...informative, passes: 11 })).toMatchObject({
      disposition: "change-task-band",
      nextCandidate: null,
      reasons: ["ceiling-effect-task-band-too-easy"],
    });
  });

  it.each([
    ["missing loader canary", { ...informative, skillLoaderCanary: "not-run" as const }],
    ["failed loader canary", { ...informative, skillLoaderCanary: "fail" as const }],
    ["provider incompatibility", { ...informative, validGraderOutcomes: 11, incompatibilities: 1 }],
    ["unresolved infrastructure", { ...informative, validGraderOutcomes: 11, unresolvedInfrastructure: 1 }],
    ["incomplete cells", { ...informative, accountedCells: 11, validGraderOutcomes: 11 }],
    ["excess timeouts", { ...informative, timeoutFails: 3, validGraderOutcomes: 9 }],
  ])("stops on %s instead of laundering it into model escalation", (_name, summary) => {
    expect(decideDemo1Runtime(0, summary)).toMatchObject({
      disposition: "stop-inconclusive",
      nextCandidate: null,
    });
  });

  it("freezes exact runtime, harness, skill and task identities only after selection", () => {
    const decision = decideDemo1Runtime(0, informative);
    const selection = buildDemo1RuntimeSelection({
      decision,
      harnessVersion: "2.1.222",
      executableSha256: "a".repeat(64),
      skillSha256: "b".repeat(64),
      taskPoolSha256: "c".repeat(64),
    });
    expect(selection.policyDecisionSha256).toBe(demo1RuntimePolicyDecisionDigest(decision));
    expect(selection.selected).toEqual(decision.candidate);
    expect(() => verifyDemo1RuntimeSelection(selection, decision)).not.toThrow();
    expect(() => verifyDemo1RuntimeSelection({
      ...selection,
      selected: DEMO1_RUNTIME_CANDIDATES[1],
    }, decision)).toThrow(/does not recompute/u);
    expect(() => buildDemo1RuntimeSelection({
      decision: decideDemo1Runtime(0, { ...informative, passes: 1 }),
      harnessVersion: "2.1.222",
      executableSha256: "a".repeat(64),
      skillSha256: "b".repeat(64),
      taskPoolSha256: "c".repeat(64),
    })).toThrow(/selected cheapest-capable/u);
  });

  it("keeps paid call ceilings explicit and reviewable", () => {
    expect(DEMO1_PROVIDER_CALL_LIMITS).toEqual({
      providerPathSmoke: 6,
      suitabilityPerCandidate: 12,
      qualificationBeforeHumanReview: 48,
      e2Rehearsal: 200,
      official: 600,
    });
  });
});
