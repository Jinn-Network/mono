import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEMO1_ARMS,
  DEMO1_DESIGN_ARTIFACT_KIND,
  DEMO1_E2_DECISION_SCHEMA,
  DEMO1_HAIKU_MODEL,
  DEMO1_OFFICIAL_CELL_CEILING,
  DEMO1_REHEARSAL_PLAN_SCHEMA,
  assessDemo1HaikuSuitability,
  buildDemo1RehearsalPlan,
  demo1E2DesignDigest,
  demo1RehearsalPlanDigest,
  deriveDemo1E2Design,
  selectDemo1OfficialDesign,
  verifyDemo1E2Design,
  verifyDemo1HaikuSuitabilityAssessment,
  verifyDemo1RehearsalPlan,
  type Demo1DesignTask,
  type Demo1E2DesignDecision,
  type Demo1E2TaskResult,
  type Demo1EmptyLoadoutEvidence,
  type Demo1HaikuSuitabilityAssessment,
  type Demo1RehearsalPlan,
  type Demo1SimulatedDesignCandidate,
  type Demo1SuitabilityAttemptOutcome,
  type Demo1SuitabilityCellObservation,
} from "./demo1-e2-design.js";

interface SyntheticFixture {
  readonly schema: string;
  readonly notice: string;
  readonly results: readonly Demo1E2TaskResult[];
}

const fixture = JSON.parse(readFileSync(
  new URL("./__fixtures__/demo1-e2-rehearsal.synthetic.v1.json", import.meta.url),
  "utf8",
)) as SyntheticFixture;

interface SyntheticControlRoutingFixture {
  readonly schema: string;
  readonly notice: string;
  readonly overrides: readonly {
    readonly taskId: string;
    readonly outcomes: Readonly<Pick<Demo1E2TaskResult["outcomes"], "true-no-file" | "empty-loadout">>;
  }[];
}

const controlRoutingFixture = JSON.parse(readFileSync(
  new URL("./__fixtures__/demo1-e2-control-routing.synthetic.v1.json", import.meta.url),
  "utf8",
)) as SyntheticControlRoutingFixture;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tasks(prefix: string, count: number, repositories: number): Demo1DesignTask[] {
  return Array.from({ length: count }, (_, index) => ({
    taskId: `${prefix}-${index}`,
    repository: `${prefix}/repo-${index % repositories}`,
    taskSha256: digest(`${prefix}-${index}`),
  }));
}

function plan(overrides: Partial<{
  suitabilityTasks: readonly Demo1DesignTask[];
  e2Tasks: readonly Demo1DesignTask[];
  officialTaskOrder: readonly Demo1DesignTask[];
}> = {}): Demo1RehearsalPlan {
  return buildDemo1RehearsalPlan({
    preRunFreezeDigest: `sha256:${digest("pre-run")}`,
    selectionBasisSha256: digest("selection-basis"),
    suitabilityTasks: overrides.suitabilityTasks ?? tasks("suitability", 6, 6),
    e2Tasks: overrides.e2Tasks ?? tasks("e2", 10, 5),
    officialTaskOrder: overrides.officialTaskOrder ?? tasks("official", 30, 10),
  });
}

function suitability(
  rehearsalPlan: Demo1RehearsalPlan,
  outcomes: readonly Demo1SuitabilityAttemptOutcome[] = [
    "pass", "pass", "pass", "pass", "pass", "pass",
    "fail", "fail", "fail", "fail", "fail", "fail",
  ],
): Demo1HaikuSuitabilityAssessment {
  return assessDemo1HaikuSuitability(rehearsalPlan, rehearsalPlan.derived.suitabilityCells.map((cell, index) => ({
    cellId: cell.cellId,
    attempts: [{ attempt: 1, outcome: outcomes[index]! }],
  })));
}

function structural(status: "match" | "mismatch" | "unverifiable" = "match"): Demo1EmptyLoadoutEvidence {
  const check = (name: string) => ({
    status,
    evidence: status === "match" ? [{ uri: `urn:fixture:${name}`, sha256: digest(name) }] : [],
  });
  return { loaderBehavior: check("loader"), modelVisibleContext: check("context") };
}

function controlRoutingResults(): readonly Demo1E2TaskResult[] {
  const overrides = new Map(controlRoutingFixture.overrides.map((override) => [override.taskId, override.outcomes]));
  return fixture.results.map((result) => {
    const override = overrides.get(result.taskId);
    return override === undefined ? result : { ...result, outcomes: { ...result.outcomes, ...override } };
  });
}

function expectCoherentPrimaryPowerClassification(decision: Demo1E2DesignDecision): void {
  const design = decision.officialDesign;
  expect(design).not.toBeNull();
  const power = Number(design!.simulatedPowerAtTarget);
  expect(design!.primaryPowerCurve).toMatchObject({
    randomStream: "shared-across-target-power-and-mde",
    effectGrid: "0.0000-to-1.0000-by-0.0001",
  });
  expect(design!.primaryPowerCurve.seed).toBeGreaterThan(0);
  if (power >= 0.8) {
    expect(design).toMatchObject({ selection: "target-power", limitation: null });
    expect(design!.achievedMde).toMatch(/^0\.[0-9]{4}$|^1\.0000$/u);
    expect(Number(design!.achievedMde)).toBeLessThanOrEqual(0.21);
  } else {
    expect(design).toMatchObject({
      selection: "strongest-within-ceiling",
      limitation: "target-effect-unattainable-within-600-cells",
    });
    expect(design!.achievedMde === "greater-than-1.0000" || Number(design!.achievedMde) > 0.21).toBe(true);
  }
}

describe("Demo-1 deterministic rehearsal planning", () => {
  it("freezes the exact 12-cell suitability and 150+50-cell E2 plans without execution", () => {
    const first = plan();
    const second = plan();
    verifyDemo1RehearsalPlan(first);
    expect(first).toEqual(second);
    expect(first.schema).toBe(DEMO1_REHEARSAL_PLAN_SCHEMA);
    expect(first.artifactKind).toBe(DEMO1_DESIGN_ARTIFACT_KIND);
    expect(first.derived.suitabilityCells).toHaveLength(12);
    expect(first.derived.e2Cells).toHaveLength(200);
    expect(first.derived.e2Cells.filter((cell) => cell.arm === DEMO1_ARMS.emptyLoadout)).toHaveLength(50);
    expect(new Set(first.derived.suitabilityCells.map((cell) => cell.repository)).size).toBe(6);
    expect(new Set(first.inputs.e2Tasks.map((task) => task.repository)).size).toBeGreaterThanOrEqual(5);
    expect(Object.values(first.execution).every((count) => count === 0)).toBe(true);
    expect(Object.values(first.derived.seeds).filter((value): value is number => typeof value === "number")
      .every((seed) => Number.isSafeInteger(seed) && seed > 0)).toBe(true);
    expect(demo1RehearsalPlanDigest(first)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("refuses pool overlap, wrong pool shapes, and task identity reuse", () => {
    const suitabilityTasks = tasks("suitability", 6, 6);
    const overlapping = tasks("e2", 10, 5).map((task, index) =>
      index === 0 ? { ...task, repository: suitabilityTasks[0]!.repository } : task);
    expect(() => plan({ suitabilityTasks, e2Tasks: overlapping })).toThrow(/overlap/u);
    expect(() => plan({ suitabilityTasks: tasks("small", 5, 5) })).toThrow(/6 tasks from 6/u);
    expect(() => plan({ e2Tasks: tasks("few-repos", 10, 4) })).toThrow(/at least 5/u);
    const official = tasks("official", 5, 2);
    official[0] = { ...official[0]!, taskSha256: tasks("e2", 10, 5)[0]!.taskSha256 };
    expect(() => plan({ officialTaskOrder: official })).toThrow(/identities must be disjoint/u);
  });
});

describe("Demo-1 Haiku suitability gate", () => {
  it("passes only the true-no-file 6x2 gate with exact inclusive counts", () => {
    const rehearsalPlan = plan();
    const assessed = suitability(rehearsalPlan);
    expect(assessed).toMatchObject({
      model: DEMO1_HAIKU_MODEL,
      status: "pass",
      disposition: "proceed-to-e2",
      counts: { expectedCells: 12, validGraderOutcomes: 12, passes: 6, timeoutFails: 0 },
    });
    expect(new Set(rehearsalPlan.derived.suitabilityCells.map((cell) => cell.arm)))
      .toEqual(new Set(["true-no-file"]));
    verifyDemo1HaikuSuitabilityAssessment(rehearsalPlan, assessed);
    expect(() => verifyDemo1HaikuSuitabilityAssessment(rehearsalPlan, {
      ...assessed,
      status: "fail",
    })).toThrow(/does not recompute/u);
  });

  it("permits exactly one infrastructure-only retry and makes unresolved infrastructure inconclusive", () => {
    const rehearsalPlan = plan();
    const observations: Demo1SuitabilityCellObservation[] = rehearsalPlan.derived.suitabilityCells.map((cell, index) => ({
      cellId: cell.cellId,
      attempts: index === 0
        ? [{ attempt: 1 as const, outcome: "pre-dispatch-infrastructure-failure" as const }, { attempt: 2 as const, outcome: "pass" as const }]
        : [{ attempt: 1 as const, outcome: index < 6 ? "pass" as const : "fail" as const }],
    }));
    expect(assessDemo1HaikuSuitability(rehearsalPlan, observations).counts.infrastructureRetries).toBe(1);
    const unresolved = [...observations];
    unresolved[0] = { cellId: observations[0]!.cellId, attempts: [{ attempt: 1, outcome: "pre-dispatch-infrastructure-failure" }] };
    expect(assessDemo1HaikuSuitability(rehearsalPlan, unresolved)).toMatchObject({
      status: "inconclusive",
      disposition: "stop-with-measurements",
      reasons: expect.arrayContaining(["unresolved-infrastructure"]),
    });
    const illegal = [...observations];
    illegal[1] = { cellId: observations[1]!.cellId, attempts: [
      { attempt: 1, outcome: "fail" },
      { attempt: 2, outcome: "pass" },
    ] };
    expect(() => assessDemo1HaikuSuitability(rehearsalPlan, illegal)).toThrow(/only a first-attempt infrastructure/u);
    const invalid = [...observations];
    invalid[1] = { cellId: observations[1]!.cellId, attempts: [
      { attempt: 1, outcome: "unknown" as Demo1SuitabilityAttemptOutcome },
    ] };
    expect(() => assessDemo1HaikuSuitability(rehearsalPlan, invalid)).toThrow(/outcome is invalid/u);
  });

  it("stops on missing accounting, incompatibility, timeouts, or pass-count boundary failures", () => {
    const rehearsalPlan = plan();
    const missing = rehearsalPlan.derived.suitabilityCells.slice(1).map((cell, index) => ({
      cellId: cell.cellId,
      attempts: [{ attempt: 1 as const, outcome: index < 5 ? "pass" as const : "fail" as const }],
    }));
    expect(assessDemo1HaikuSuitability(rehearsalPlan, missing).status).toBe("inconclusive");
    expect(suitability(rehearsalPlan, [
      "model-incompatibility", "pass", "pass", "pass", "pass", "pass",
      "fail", "fail", "fail", "fail", "fail", "fail",
    ]).status).toBe("fail");
    expect(suitability(rehearsalPlan, [
      "timeout-fail", "timeout-fail", "timeout-fail", "pass", "pass", "pass",
      "fail", "fail", "fail", "fail", "fail", "fail",
    ]).reasons).toContain("more-than-2-timeout-fails");
    expect(suitability(rehearsalPlan, Array.from({ length: 12 }, () => "fail")).reasons)
      .toContain("pass-count-outside-inclusive-2-to-10-range");
  });
});

describe("Demo-1 E2 evidence and official sizing", () => {
  it("never emits a power claim without a passed gate and complete rehearsal input", () => {
    const rehearsalPlan = plan();
    const passed = suitability(rehearsalPlan);
    const absent = deriveDemo1E2Design(rehearsalPlan, passed);
    expect(absent).toMatchObject({
      schema: DEMO1_E2_DECISION_SCHEMA,
      status: "stop",
      stopReasons: ["e2-rehearsal-input-absent"],
      estimates: null,
      officialDesign: null,
      powerClaim: null,
    });
    const failed = suitability(rehearsalPlan, Array.from({ length: 12 }, () => "fail"));
    expect(deriveDemo1E2Design(rehearsalPlan, failed)).toMatchObject({
      status: "stop",
      stopReasons: ["haiku-suitability-fail"],
      powerClaim: null,
    });
  });

  it("accepts empty loadout only with structural matches and a wholly ±0.10 paired interval", () => {
    expect(fixture.schema).toBe("jinn.demo1.e2-rehearsal.synthetic.v1");
    expect(fixture.notice).toMatch(/Synthetic method fixture only/u);
    const rehearsalPlan = plan();
    const decision = deriveDemo1E2Design(rehearsalPlan, suitability(rehearsalPlan), {
      results: fixture.results,
      emptyLoadoutEvidence: structural("match"),
    });
    expect(decision.status).toBe("ready-for-lock");
    expect(decision.emptyLoadoutEquivalence).toMatchObject({
      accepted: true,
      primaryControl: "empty-loadout",
      loadoutAxis: "verified-equivalent",
      pairedInterval: {
        delta: "0.000000000000",
        low: "0.000000000000",
        high: "0.000000000000",
        margin: "0.1000",
      },
    });
    expect(decision.estimates?.repositoryClustering.repositoryCount).toBe(5);
    expect(decision.estimates?.timeoutBehavior[DEMO1_ARMS.skill])
      .toEqual({ timeoutFails: 0, cells: 50, rate: "0.000000000000" });
    expect(decision.estimates?.taskCorrelation).toHaveLength(6);
    expect(decision.officialDesign?.arms).toEqual(["skill", "claude-md", "empty-loadout"]);
    expect(decision.officialDesign?.cells).toBeLessThanOrEqual(DEMO1_OFFICIAL_CELL_CEILING);
    expect(decision.officialDesign?.cellsInSeededOrder).toHaveLength(decision.officialDesign?.cells ?? -1);
    expect(decision.officialDesign?.topUpPolicy).toBe("forbidden-after-lock");
    expect(decision.officialDesign?.secondaryManipulationSensitivity.mayAlterPrimarySizing).toBe(false);
    expectCoherentPrimaryPowerClassification(decision);
    expect(decision.powerClaim?.evaluatedDesigns).toBeGreaterThan(0);
    expect(demo1E2DesignDigest(decision)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    verifyDemo1E2Design(decision, rehearsalPlan, suitability(rehearsalPlan), {
      results: fixture.results,
      emptyLoadoutEvidence: structural("match"),
    });
    expect(() => verifyDemo1E2Design({
      ...decision,
      rehearsalInputSha256: digest("substituted"),
    }, rehearsalPlan, suitability(rehearsalPlan), {
      results: fixture.results,
      emptyLoadoutEvidence: structural("match"),
    })).toThrow(/does not recompute/u);
  }, 30_000);

  it("routes secondary variance and sensitivity through the accepted official control", () => {
    expect(controlRoutingFixture.schema).toBe("jinn.demo1.e2-control-routing.synthetic.v1");
    expect(controlRoutingFixture.notice).toMatch(/Synthetic routing fixture only/u);
    const rehearsalPlan = plan({ officialTaskOrder: tasks("official", 5, 2) });
    const results = controlRoutingResults();
    expect(results.some((result) =>
      JSON.stringify(result.outcomes[DEMO1_ARMS.trueNoFile])
      !== JSON.stringify(result.outcomes[DEMO1_ARMS.emptyLoadout]))).toBe(true);

    const accepted = deriveDemo1E2Design(rehearsalPlan, suitability(rehearsalPlan), {
      results,
      emptyLoadoutEvidence: structural("match"),
    });
    const fallback = deriveDemo1E2Design(rehearsalPlan, suitability(rehearsalPlan), {
      results,
      emptyLoadoutEvidence: structural("mismatch"),
    });

    expect(accepted.emptyLoadoutEquivalence).toMatchObject({ accepted: true, primaryControl: "empty-loadout" });
    expect(fallback.emptyLoadoutEquivalence).toMatchObject({ accepted: false, primaryControl: "true-no-file" });
    expect(accepted.estimates?.secondaryManipulationControl).toBe("empty-loadout");
    expect(fallback.estimates?.secondaryManipulationControl).toBe("true-no-file");
    expect(accepted.officialDesign?.secondaryManipulationSensitivity.control).toBe("empty-loadout");
    expect(fallback.officialDesign?.secondaryManipulationSensitivity.control).toBe("true-no-file");
    expect(accepted.estimates?.primaryVarianceModel).toEqual(fallback.estimates?.primaryVarianceModel);
    expect(accepted.estimates?.secondaryManipulationVarianceModel)
      .not.toEqual(fallback.estimates?.secondaryManipulationVarianceModel);
  }, 30_000);

  it("falls back to true no-file and marks the loadout axis unverifiable when structure fails", () => {
    const rehearsalPlan = plan({ officialTaskOrder: tasks("official", 5, 2) });
    const decision = deriveDemo1E2Design(rehearsalPlan, suitability(rehearsalPlan), {
      results: fixture.results,
      emptyLoadoutEvidence: structural("mismatch"),
    });
    expect(decision.emptyLoadoutEquivalence).toMatchObject({
      accepted: false,
      primaryControl: "true-no-file",
      loadoutAxis: "unverifiable",
      rejectionReasons: expect.arrayContaining([
        "loader-behavior-not-structurally-indistinguishable",
        "model-visible-context-not-structurally-indistinguishable",
      ]),
    });
    expect(decision.officialDesign?.arms).toEqual(["skill", "claude-md", "true-no-file"]);
  }, 30_000);

  it("rejects empty loadout when the paired interval escapes the ±0.10 margin", () => {
    const rehearsalPlan = plan({ officialTaskOrder: tasks("official", 5, 2) });
    const nonEquivalent: Demo1E2TaskResult[] = fixture.results.map((result) => ({
      ...result,
      outcomes: {
        ...result.outcomes,
        "true-no-file": Array.from({ length: 5 }, () => "fail" as const),
        "empty-loadout": Array.from({ length: 5 }, () => "pass" as const),
      },
    }));
    const decision = deriveDemo1E2Design(rehearsalPlan, suitability(rehearsalPlan), {
      results: nonEquivalent,
      emptyLoadoutEvidence: structural("match"),
    });
    expect(decision.emptyLoadoutEquivalence).toMatchObject({
      accepted: false,
      primaryControl: "true-no-file",
      loadoutAxis: "unverifiable",
      rejectionReasons: ["paired-interval-not-wholly-within-plus-or-minus-0.10"],
    });
    expect(Number(decision.emptyLoadoutEquivalence?.pairedInterval.low)).toBeGreaterThan(0.1);
  }, 30_000);

  it("stops rather than claims power when repository clustering is not estimable", () => {
    const rehearsalPlan = plan({ e2Tasks: tasks("e2", 10, 10) });
    const decision = deriveDemo1E2Design(rehearsalPlan, suitability(rehearsalPlan), {
      results: fixture.results,
      emptyLoadoutEvidence: structural("match"),
    });
    expect(decision).toMatchObject({
      status: "stop",
      stopReasons: ["repository-clustering-not-estimable"],
      officialDesign: null,
      powerClaim: null,
      estimates: { repositoryClustering: { reason: "all-repositories-are-singletons" } },
    });
  });

  it("stops without a power claim when the frozen official order has no feasible two-repository prefix", () => {
    const rehearsalPlan = plan({ officialTaskOrder: tasks("official", 5, 1) });
    const decision = deriveDemo1E2Design(rehearsalPlan, suitability(rehearsalPlan), {
      results: fixture.results,
      emptyLoadoutEvidence: structural("match"),
    });
    expect(decision).toMatchObject({
      status: "stop",
      stopReasons: ["no-feasible-official-design-within-600-cells"],
      officialDesign: null,
      powerClaim: null,
    });
  });

  it("seals an achieved-MDE limitation and forbids top-up when 0.21 is unattainable", () => {
    const rehearsalPlan = plan({ officialTaskOrder: tasks("official", 5, 2) });
    const highClusterVariance: Demo1E2TaskResult[] = fixture.results.map((result, index) => ({
      ...result,
      outcomes: {
        ...result.outcomes,
        skill: Array.from({ length: 5 }, () => index % 5 < 3 ? "pass" as const : "fail" as const),
        "claude-md": Array.from({ length: 5 }, () => index % 5 < 3 ? "fail" as const : "pass" as const),
      },
    }));
    const decision = deriveDemo1E2Design(rehearsalPlan, suitability(rehearsalPlan), {
      results: highClusterVariance,
      emptyLoadoutEvidence: structural("match"),
    });
    expect(decision.officialDesign).toMatchObject({
      selection: "strongest-within-ceiling",
      limitation: "target-effect-unattainable-within-600-cells",
      topUpPolicy: "forbidden-after-lock",
    });
    expect(decision.officialDesign?.achievedMde)
      .toMatch(/^0\.[0-9]{4}$|^1\.0000$|^greater-than-1\.0000$/u);
    expect(Number(decision.officialDesign?.simulatedPowerAtTarget)).toBeLessThan(0.8);
    expectCoherentPrimaryPowerClassification(decision);
  }, 30_000);
});

function candidate(
  tasksCount: number,
  repositories: number,
  replicates: number,
  simulatedPower: number,
): Demo1SimulatedDesignCandidate {
  return {
    tasks: tasksCount,
    repositories,
    replicates,
    arms: 3,
    cells: tasksCount * replicates * 3,
    simulatedPower,
  };
}

describe("Demo-1 exhaustive design selection rules", () => {
  it("selects the fewest qualifying cells, then more repositories/tasks, then fewer replicates", () => {
    expect(selectDemo1OfficialDesign([
      candidate(5, 5, 5, 0.95),
      candidate(5, 5, 4, 0.8),
      candidate(10, 6, 2, 0.8),
      candidate(12, 6, 2, 0.99),
    ])).toEqual({ selection: "target-power", candidate: candidate(10, 6, 2, 0.8) });
  });

  it("chooses strongest power within the ceiling when 0.21 is unattainable", () => {
    expect(selectDemo1OfficialDesign([
      candidate(5, 2, 1, 0.4),
      candidate(10, 5, 2, 0.79),
      candidate(20, 6, 1, 0.79),
    ])).toEqual({ selection: "strongest-within-ceiling", candidate: candidate(20, 6, 1, 0.79) });
  });

  it("rejects ceiling drift and returns no selection for an empty feasible space", () => {
    expect(selectDemo1OfficialDesign([])).toBeNull();
    expect(selectDemo1OfficialDesign([candidate(100, 20, 2, 0.8)]))
      .toEqual({ selection: "target-power", candidate: candidate(100, 20, 2, 0.8) });
    expect(() => selectDemo1OfficialDesign([candidate(67, 10, 3, 0.9)])).toThrow(/<=600-cell/u);
  });
});
