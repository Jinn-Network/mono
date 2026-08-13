import { createHash } from "node:crypto";
import {
  clusteredPairedDeltaInterval,
  xorshift32,
} from "@jinn-network/benchmarking-aggregate";
import {
  compareCodeUnitStrings,
  serializeCanonicalJson,
  type JsonValue,
} from "@jinn-network/benchmarking-records";
import {
  demo1PreRunFreezeDigest,
  verifyDemo1PreRunFreeze,
  type Demo1EvidenceCheck,
  type Demo1EvidenceRef,
  type Demo1PreRunFreeze,
} from "./demo1-prerun.js";

/** Local method artifacts only: these are not benchmarking/evidence record kinds. */
export const DEMO1_REHEARSAL_PLAN_SCHEMA = "jinn.demo1.rehearsal-plan.v1" as const;
export const DEMO1_E2_DECISION_SCHEMA = "jinn.demo1.e2-design-decision.v1" as const;
export const DEMO1_DESIGN_ARTIFACT_KIND = "local-method-artifact-not-evidence-record" as const;
export const DEMO1_HAIKU_MODEL = "claude-haiku-4-5-20251001" as const;
export const DEMO1_HAIKU_EFFORT = "high" as const;
export const DEMO1_SUITABILITY_TASKS = 6 as const;
export const DEMO1_SUITABILITY_REPLICATES = 2 as const;
export const DEMO1_E2_TASKS = 10 as const;
export const DEMO1_E2_MIN_REPOSITORIES = 5 as const;
export const DEMO1_E2_REPLICATES = 5 as const;
export const DEMO1_OFFICIAL_ARMS = 3 as const;
export const DEMO1_OFFICIAL_CELL_CEILING = 600 as const;
export const DEMO1_TARGET_POWER = 0.8 as const;
export const DEMO1_TARGET_EFFECT = 0.21 as const;
export const DEMO1_EQUIVALENCE_MARGIN = 0.1 as const;
export const DEMO1_POWER_SIMULATIONS = 2_000 as const;
export const DEMO1_EQUIVALENCE_RESAMPLES = 20_000 as const;

export const DEMO1_ARMS = {
  skill: "skill",
  claudeMd: "claude-md",
  trueNoFile: "true-no-file",
  emptyLoadout: "empty-loadout",
} as const;

type Demo1Arm = typeof DEMO1_ARMS[keyof typeof DEMO1_ARMS];
type Demo1E2Arm = Demo1Arm;
type Demo1SuitabilityArm = typeof DEMO1_ARMS.trueNoFile;
type Demo1OfficialControl = typeof DEMO1_ARMS.trueNoFile | typeof DEMO1_ARMS.emptyLoadout;
type Demo1ScoredOutcome = "pass" | "fail" | "timeout-fail";

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const Z_975 = 1.959963984540054;

export interface Demo1DesignTask {
  readonly taskId: string;
  readonly repository: string;
  readonly taskSha256: string;
}

export interface Demo1RehearsalPlanInput {
  readonly preRunFreezeDigest: string;
  readonly selectionBasisSha256: string;
  readonly suitabilityTasks: readonly Demo1DesignTask[];
  readonly e2Tasks: readonly Demo1DesignTask[];
  /** The already-frozen order from the pre-run winner; this method never selects or reranks it. */
  readonly officialTaskOrder: readonly Demo1DesignTask[];
}

export interface Demo1PlannedCell {
  readonly cellId: string;
  readonly phase: "haiku-suitability" | "e2-rehearsal" | "e2-empty-loadout-diagnostic" | "official";
  readonly taskId: string;
  readonly repository: string;
  readonly taskSha256: string;
  readonly arm: Demo1Arm;
  readonly replicate: number;
  readonly scheduleRankSha256: string;
  readonly scheduleIndex: number;
}

export interface Demo1RehearsalPlan {
  readonly schema: typeof DEMO1_REHEARSAL_PLAN_SCHEMA;
  readonly artifactKind: typeof DEMO1_DESIGN_ARTIFACT_KIND;
  readonly inputs: Demo1RehearsalPlanInput;
  readonly derived: {
    readonly basisSha256: string;
    readonly seeds: {
      readonly procedure: "sha256-first-u32be-nonzero@1";
      readonly suitabilityScheduling: number;
      readonly e2Scheduling: number;
      readonly emptyLoadoutInterval: number;
      readonly powerSimulation: number;
      readonly officialScheduling: number;
      readonly secondarySensitivity: number;
    };
    readonly constraints: {
      readonly suitability: {
        readonly tasks: 6;
        readonly repositories: 6;
        readonly replicates: 2;
        readonly cells: 12;
        readonly arm: Demo1SuitabilityArm;
      };
      readonly e2: {
        readonly tasks: 10;
        readonly minimumRepositories: 5;
        readonly replicates: 5;
        readonly primaryArms: readonly ["skill", "claude-md", "true-no-file"];
        readonly diagnosticArm: "empty-loadout";
        readonly primaryCells: 150;
        readonly diagnosticCells: 50;
      };
      readonly official: {
        readonly arms: 3;
        readonly cellCeiling: 600;
        readonly targetPower: "0.80";
        readonly targetEffect: "0.21";
        readonly topUpPolicy: "forbidden-after-lock";
      };
      readonly repositoryPoolsAreDisjoint: true;
    };
    readonly suitabilityCells: readonly Demo1PlannedCell[];
    readonly e2Cells: readonly Demo1PlannedCell[];
  };
  readonly execution: {
    readonly modelCells: 0;
    readonly dockerCells: 0;
    readonly officialCells: 0;
  };
}

export type Demo1SuitabilityAttemptOutcome = Demo1ScoredOutcome
  | "pre-dispatch-infrastructure-failure"
  | "model-incompatibility"
  | "authentication-incompatibility"
  | "launcher-incompatibility";

export interface Demo1SuitabilityCellObservation {
  readonly cellId: string;
  readonly attempts: readonly {
    readonly attempt: 1 | 2;
    readonly outcome: Demo1SuitabilityAttemptOutcome;
  }[];
}

export interface Demo1HaikuSuitabilityAssessment {
  readonly planBasisSha256: string;
  readonly model: typeof DEMO1_HAIKU_MODEL;
  readonly effort: typeof DEMO1_HAIKU_EFFORT;
  readonly status: "pass" | "fail" | "inconclusive";
  readonly disposition: "proceed-to-e2" | "stop-with-measurements";
  readonly counts: {
    readonly expectedCells: 12;
    readonly accountedCells: number;
    readonly terminalCells: number;
    readonly validGraderOutcomes: number;
    readonly passes: number;
    readonly timeoutFails: number;
    readonly infrastructureRetries: number;
    readonly unresolvedInfrastructure: number;
    readonly incompatibilities: number;
  };
  readonly reasons: readonly string[];
  /** Canonical cell-order observations from which every assessment field recomputes. */
  readonly observations: readonly Demo1SuitabilityCellObservation[];
}

export interface Demo1E2TaskResult {
  readonly taskId: string;
  readonly outcomes: Readonly<Record<Demo1E2Arm, readonly Demo1ScoredOutcome[]>>;
}

export interface Demo1EmptyLoadoutEvidence {
  readonly loaderBehavior: Demo1EvidenceCheck;
  readonly modelVisibleContext: Demo1EvidenceCheck;
}

export interface Demo1E2RehearsalInput {
  readonly results: readonly Demo1E2TaskResult[];
  readonly emptyLoadoutEvidence: Demo1EmptyLoadoutEvidence;
}

interface Demo1VarianceModel {
  readonly observedTaskVariance: string;
  readonly measurementVarianceAtFiveReplicates: string;
  readonly latentTaskVariance: string;
  readonly repositoryIcc: string | null;
  readonly repositoryIccReason: null | string;
  readonly replicateVarianceCoefficient: string;
}

interface NumericVarianceModel {
  readonly observedTaskVariance: number;
  readonly measurementVarianceAtFiveReplicates: number;
  readonly latentTaskVariance: number;
  readonly repositoryIcc: number | null;
  readonly repositoryIccReason: null | string;
  readonly replicateVarianceCoefficient: number;
}

export interface Demo1E2Estimates {
  readonly withinTaskVariance: Readonly<Record<Demo1E2Arm, string>>;
  readonly repositoryClustering: {
    readonly primaryDifferenceIccAnova: string | null;
    readonly reason: string | null;
    readonly repositoryCount: number;
    readonly tasksPerRepository: readonly { readonly repository: string; readonly tasks: number }[];
  };
  readonly timeoutBehavior: Readonly<Record<Demo1E2Arm, {
    readonly timeoutFails: number;
    readonly cells: number;
    readonly rate: string;
  }>>;
  readonly taskCorrelation: readonly {
    readonly arms: readonly [Demo1E2Arm, Demo1E2Arm];
    readonly pearson: string | null;
    readonly reason: string | null;
  }[];
  readonly primaryVarianceModel: Demo1VarianceModel;
  readonly secondaryManipulationControl: Demo1OfficialControl;
  readonly secondaryManipulationVarianceModel: Demo1VarianceModel;
}

interface NumericE2Estimates {
  readonly withinTaskVariance: Readonly<Record<Demo1E2Arm, number>>;
  readonly repositoryClustering: {
    readonly primaryDifferenceIccAnova: number | null;
    readonly reason: string | null;
    readonly repositoryCount: number;
    readonly tasksPerRepository: readonly { readonly repository: string; readonly tasks: number }[];
  };
  readonly timeoutBehavior: Readonly<Record<Demo1E2Arm, {
    readonly timeoutFails: number;
    readonly cells: number;
    readonly rate: number;
  }>>;
  readonly taskCorrelation: readonly {
    readonly arms: readonly [Demo1E2Arm, Demo1E2Arm];
    readonly pearson: number | null;
    readonly reason: string | null;
  }[];
  readonly primaryVarianceModel: NumericVarianceModel;
  readonly secondaryManipulationControl: Demo1OfficialControl;
  readonly secondaryManipulationVarianceModel: NumericVarianceModel;
}

export interface Demo1SimulatedDesignCandidate {
  readonly tasks: number;
  readonly repositories: number;
  readonly replicates: number;
  readonly arms: 3;
  readonly cells: number;
  readonly simulatedPower: number;
}

export interface Demo1SelectedDesign {
  readonly selection: "target-power" | "strongest-within-ceiling";
  readonly candidate: Demo1SimulatedDesignCandidate;
}

export interface Demo1E2DesignDecision {
  readonly schema: typeof DEMO1_E2_DECISION_SCHEMA;
  readonly artifactKind: typeof DEMO1_DESIGN_ARTIFACT_KIND;
  readonly planBasisSha256: string;
  readonly planSha256: string;
  readonly rehearsalInputSha256: string | null;
  readonly status: "ready-for-lock" | "stop";
  readonly stopReasons: readonly string[];
  readonly suitability: Demo1HaikuSuitabilityAssessment;
  readonly emptyLoadoutEquivalence: null | {
    readonly accepted: boolean;
    readonly primaryControl: "empty-loadout" | "true-no-file";
    readonly loadoutAxis: "verified-equivalent" | "unverifiable";
    readonly structural: {
      readonly loaderBehavior: Demo1EvidenceCheck;
      readonly modelVisibleContext: Demo1EvidenceCheck;
    };
    readonly pairedInterval: {
      readonly delta: string;
      readonly low: string;
      readonly high: string;
      readonly margin: "0.1000";
      readonly alpha: "0.0500";
      readonly seed: number;
      readonly resamples: 20_000;
      readonly unit: "source-cluster";
    };
    readonly rejectionReasons: readonly string[];
  };
  readonly estimates: Demo1E2Estimates | null;
  readonly officialDesign: null | {
    readonly selection: Demo1SelectedDesign["selection"];
    readonly tasks: readonly Demo1DesignTask[];
    readonly arms: readonly ["skill", "claude-md", "empty-loadout" | "true-no-file"];
    readonly replicates: number;
    readonly repositories: number;
    readonly cells: number;
    readonly cellCeiling: 600;
    readonly targetEffect: "0.21";
    readonly targetPower: "0.80";
    readonly simulatedPowerAtTarget: string;
    readonly achievedMde: string | null;
    readonly primaryPowerCurve: {
      readonly seed: number;
      readonly randomStream: "shared-across-target-power-and-mde";
      readonly effectGrid: "0.0000-to-1.0000-by-0.0001";
    };
    readonly limitation: null | "target-effect-unattainable-within-600-cells";
    readonly topUpPolicy: "forbidden-after-lock";
    readonly selectionInputs: readonly [
      "primary-variance-model",
      "target-effect",
      "target-power",
      "frozen-official-task-order",
      "cell-ceiling",
    ];
    readonly excludedSelectionInputs: readonly ["secondary-manipulation-sensitivity"];
    readonly secondaryManipulationSensitivity: {
      readonly control: Demo1OfficialControl;
      readonly achievedMde: string | null;
      readonly mayAlterPrimarySizing: false;
    };
    readonly cellsInSeededOrder: readonly Demo1PlannedCell[];
  };
  readonly powerClaim: null | {
    readonly procedure: "demo1-gaussian-cluster-monte-carlo@1";
    readonly simulationsPerDesign: 2_000;
    readonly alpha: "0.0500";
    readonly evaluatedDesigns: number;
  };
}

function canonicalBytes(value: unknown): Uint8Array {
  return serializeCanonicalJson(value as JsonValue);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decimal(value: number, places = 12): string {
  if (!Number.isFinite(value)) throw new TypeError("method decimal must be finite");
  return value.toFixed(places);
}

function renderVarianceModel(model: NumericVarianceModel): Demo1VarianceModel {
  return {
    observedTaskVariance: decimal(model.observedTaskVariance),
    measurementVarianceAtFiveReplicates: decimal(model.measurementVarianceAtFiveReplicates),
    latentTaskVariance: decimal(model.latentTaskVariance),
    repositoryIcc: model.repositoryIcc === null ? null : decimal(model.repositoryIcc),
    repositoryIccReason: model.repositoryIccReason,
    replicateVarianceCoefficient: decimal(model.replicateVarianceCoefficient),
  };
}

function exactKeys(value: object, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort(compareCodeUnitStrings);
  const expected = [...keys].sort(compareCodeUnitStrings);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new TypeError(`${field} has unknown or missing fields`);
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\u0000]/u.test(value)) {
    throw new TypeError(`${field} must be non-empty single-line text`);
  }
  return value;
}

function normalizeTask(task: Demo1DesignTask, field: string): Demo1DesignTask {
  exactKeys(task, ["taskId", "repository", "taskSha256"], field);
  const normalized = {
    taskId: nonEmpty(task.taskId, `${field} taskId`),
    repository: nonEmpty(task.repository, `${field} repository`),
    taskSha256: task.taskSha256,
  };
  if (!SHA256.test(normalized.taskSha256)) throw new TypeError(`${field} taskSha256 must be 64 lowercase hex`);
  return normalized;
}

function normalizeTaskList(tasks: readonly Demo1DesignTask[], field: string): Demo1DesignTask[] {
  const normalized = tasks.map((task) => normalizeTask(task, field));
  const ids = normalized.map((task) => task.taskId);
  const digests = normalized.map((task) => task.taskSha256);
  if (new Set(ids).size !== ids.length || new Set(digests).size !== digests.length) {
    throw new TypeError(`${field} task identities must be unique`);
  }
  return normalized;
}

function resolvedSeed(basisSha256: string, purpose: string): number {
  const bytes = createHash("sha256")
    .update(`jinn.demo1.e2-design-seed@1\u0000${purpose}\u0000${basisSha256}`, "utf8")
    .digest();
  const seed = bytes.readUInt32BE(0);
  return seed === 0 ? 1 : seed;
}

function rank(seed: number, phase: string, taskId: string, arm: string, replicate: number): string {
  return sha256(`jinn.demo1.e2-cell-order@1\u0000${seed}\u0000${phase}\u0000${taskId}\u0000${arm}\u0000${replicate}`);
}

function scheduledCells(
  phase: Demo1PlannedCell["phase"],
  tasks: readonly Demo1DesignTask[],
  arms: readonly Demo1Arm[],
  replicates: number,
  seed: number,
): Demo1PlannedCell[] {
  return tasks.flatMap((task) => arms.flatMap((arm) =>
    Array.from({ length: replicates }, (_, index) => {
      const replicate = index + 1;
      return {
        cellId: `${phase}:${task.taskId}:${arm}:r${replicate}`,
        phase,
        ...task,
        arm,
        replicate,
        scheduleRankSha256: rank(seed, phase, task.taskId, arm, replicate),
        scheduleIndex: 0,
      };
    })))
    .sort((left, right) => compareCodeUnitStrings(left.scheduleRankSha256, right.scheduleRankSha256)
      || compareCodeUnitStrings(left.cellId, right.cellId))
    .map((cell, scheduleIndex) => ({ ...cell, scheduleIndex }));
}

function repositorySet(tasks: readonly Demo1DesignTask[]): Set<string> {
  return new Set(tasks.map((task) => task.repository));
}

function assertDisjoint(left: Set<string>, right: Set<string>, field: string): void {
  const overlap = [...left].filter((repository) => right.has(repository)).sort(compareCodeUnitStrings);
  if (overlap.length > 0) throw new TypeError(`${field} repository pools overlap: ${overlap.join(", ")}`);
}

export function buildDemo1RehearsalPlan(input: Demo1RehearsalPlanInput): Demo1RehearsalPlan {
  exactKeys(input, ["preRunFreezeDigest", "selectionBasisSha256", "suitabilityTasks", "e2Tasks", "officialTaskOrder"], "rehearsal plan input");
  if (!SHA256_DIGEST.test(input.preRunFreezeDigest)) throw new TypeError("preRunFreezeDigest must be sha256:<64 lowercase hex>");
  if (!SHA256.test(input.selectionBasisSha256)) throw new TypeError("selectionBasisSha256 must be 64 lowercase hex");
  const suitabilityTasks = normalizeTaskList(input.suitabilityTasks, "suitability");
  const e2Tasks = normalizeTaskList(input.e2Tasks, "E2");
  const officialTaskOrder = normalizeTaskList(input.officialTaskOrder, "official");
  if (suitabilityTasks.length !== DEMO1_SUITABILITY_TASKS
    || repositorySet(suitabilityTasks).size !== DEMO1_SUITABILITY_TASKS) {
    throw new TypeError("Haiku suitability requires exactly 6 tasks from 6 repositories");
  }
  if (e2Tasks.length !== DEMO1_E2_TASKS || repositorySet(e2Tasks).size < DEMO1_E2_MIN_REPOSITORIES) {
    throw new TypeError("E2 requires exactly 10 tasks from at least 5 repositories");
  }
  if (officialTaskOrder.length < 5) throw new TypeError("official frozen order requires at least 5 tasks");
  const suitabilityRepositories = repositorySet(suitabilityTasks);
  const e2Repositories = repositorySet(e2Tasks);
  const officialRepositories = repositorySet(officialTaskOrder);
  assertDisjoint(suitabilityRepositories, e2Repositories, "suitability/E2");
  assertDisjoint(suitabilityRepositories, officialRepositories, "suitability/official");
  assertDisjoint(e2Repositories, officialRepositories, "E2/official");
  const allIds = [...suitabilityTasks, ...e2Tasks, ...officialTaskOrder].map((task) => task.taskId);
  const allDigests = [...suitabilityTasks, ...e2Tasks, ...officialTaskOrder].map((task) => task.taskSha256);
  if (new Set(allIds).size !== allIds.length || new Set(allDigests).size !== allDigests.length) {
    throw new TypeError("task identities must be disjoint across suitability, E2, and official pools");
  }
  const inputs = {
    preRunFreezeDigest: input.preRunFreezeDigest,
    selectionBasisSha256: input.selectionBasisSha256,
    suitabilityTasks,
    e2Tasks,
    officialTaskOrder,
  };
  const basisSha256 = sha256(canonicalBytes(inputs));
  const seeds = {
    procedure: "sha256-first-u32be-nonzero@1" as const,
    suitabilityScheduling: resolvedSeed(basisSha256, "suitability-scheduling"),
    e2Scheduling: resolvedSeed(basisSha256, "e2-scheduling"),
    emptyLoadoutInterval: resolvedSeed(basisSha256, "empty-loadout-interval"),
    powerSimulation: resolvedSeed(basisSha256, "power-simulation"),
    officialScheduling: resolvedSeed(basisSha256, "official-scheduling"),
    secondarySensitivity: resolvedSeed(basisSha256, "secondary-sensitivity"),
  };
  const suitabilityCells = scheduledCells(
    "haiku-suitability",
    suitabilityTasks,
    [DEMO1_ARMS.trueNoFile],
    DEMO1_SUITABILITY_REPLICATES,
    seeds.suitabilityScheduling,
  );
  const e2Primary = scheduledCells(
    "e2-rehearsal",
    e2Tasks,
    [DEMO1_ARMS.skill, DEMO1_ARMS.claudeMd, DEMO1_ARMS.trueNoFile],
    DEMO1_E2_REPLICATES,
    seeds.e2Scheduling,
  );
  const diagnostic = scheduledCells(
    "e2-empty-loadout-diagnostic",
    e2Tasks,
    [DEMO1_ARMS.emptyLoadout],
    DEMO1_E2_REPLICATES,
    seeds.e2Scheduling,
  );
  const e2Cells = [...e2Primary, ...diagnostic]
    .sort((left, right) => compareCodeUnitStrings(left.scheduleRankSha256, right.scheduleRankSha256)
      || compareCodeUnitStrings(left.cellId, right.cellId))
    .map((cell, scheduleIndex) => ({ ...cell, scheduleIndex }));
  return {
    schema: DEMO1_REHEARSAL_PLAN_SCHEMA,
    artifactKind: DEMO1_DESIGN_ARTIFACT_KIND,
    inputs,
    derived: {
      basisSha256,
      seeds,
      constraints: {
        suitability: { tasks: 6, repositories: 6, replicates: 2, cells: 12, arm: "true-no-file" },
        e2: {
          tasks: 10,
          minimumRepositories: 5,
          replicates: 5,
          primaryArms: ["skill", "claude-md", "true-no-file"],
          diagnosticArm: "empty-loadout",
          primaryCells: 150,
          diagnosticCells: 50,
        },
        official: { arms: 3, cellCeiling: 600, targetPower: "0.80", targetEffect: "0.21", topUpPolicy: "forbidden-after-lock" },
        repositoryPoolsAreDisjoint: true,
      },
      suitabilityCells,
      e2Cells,
    },
    execution: { modelCells: 0, dockerCells: 0, officialCells: 0 },
  };
}

export function buildDemo1RehearsalPlanFromFreeze(freeze: Demo1PreRunFreeze): Demo1RehearsalPlan {
  verifyDemo1PreRunFreeze(freeze);
  const winner = freeze.derived.winner;
  if (freeze.derived.status !== "ready" || winner === null) {
    throw new TypeError("pre-run freeze stopped and cannot produce a rehearsal plan");
  }
  return buildDemo1RehearsalPlan({
    preRunFreezeDigest: demo1PreRunFreezeDigest(freeze),
    selectionBasisSha256: freeze.derived.selectionBasisSha256,
    suitabilityTasks: winner.selectedPools.suitability,
    e2Tasks: winner.selectedPools.rehearsal,
    officialTaskOrder: winner.officialTaskOrder,
  });
}

export function verifyDemo1RehearsalPlan(plan: Demo1RehearsalPlan): void {
  const rebuilt = buildDemo1RehearsalPlan(plan.inputs);
  if (!Buffer.from(canonicalBytes(rebuilt)).equals(Buffer.from(canonicalBytes(plan)))) {
    throw new TypeError("rehearsal plan does not recompute from canonical inputs");
  }
}

export function demo1RehearsalPlanDigest(plan: Demo1RehearsalPlan): string {
  verifyDemo1RehearsalPlan(plan);
  return `sha256:${sha256(canonicalBytes(plan))}`;
}

export function assessDemo1HaikuSuitability(
  plan: Demo1RehearsalPlan,
  observations: readonly Demo1SuitabilityCellObservation[],
): Demo1HaikuSuitabilityAssessment {
  verifyDemo1RehearsalPlan(plan);
  const expected = new Set(plan.derived.suitabilityCells.map((cell) => cell.cellId));
  const byCell = new Map<string, Demo1SuitabilityCellObservation>();
  const allowedOutcomes: readonly Demo1SuitabilityAttemptOutcome[] = [
    "pass",
    "fail",
    "timeout-fail",
    "pre-dispatch-infrastructure-failure",
    "model-incompatibility",
    "authentication-incompatibility",
    "launcher-incompatibility",
  ];
  for (const observation of observations) {
    exactKeys(observation, ["cellId", "attempts"], "suitability observation");
    if (!expected.has(observation.cellId)) throw new TypeError(`unknown suitability cell ${observation.cellId}`);
    if (byCell.has(observation.cellId)) throw new TypeError(`duplicate suitability cell ${observation.cellId}`);
    if (observation.attempts.length < 1 || observation.attempts.length > 2) {
      throw new TypeError("suitability cells require one attempt and permit at most one retry");
    }
    observation.attempts.forEach((attempt, index) => {
      exactKeys(attempt, ["attempt", "outcome"], "suitability attempt");
      if (attempt.attempt !== index + 1) throw new TypeError("suitability attempt numbers must be contiguous from one");
      if (!allowedOutcomes.includes(attempt.outcome)) throw new TypeError("suitability attempt outcome is invalid");
    });
    if (observation.attempts.length === 2
      && observation.attempts[0]!.outcome !== "pre-dispatch-infrastructure-failure") {
      throw new TypeError("only a first-attempt infrastructure failure may receive one retry");
    }
    byCell.set(observation.cellId, {
      cellId: observation.cellId,
      attempts: observation.attempts.map((attempt) => ({ ...attempt })),
    });
  }
  let terminalCells = 0;
  let validGraderOutcomes = 0;
  let passes = 0;
  let timeoutFails = 0;
  let infrastructureRetries = 0;
  let unresolvedInfrastructure = 0;
  let incompatibilities = 0;
  for (const observation of byCell.values()) {
    if (observation.attempts.length === 2) infrastructureRetries += 1;
    const final = observation.attempts.at(-1)!.outcome;
    if (final === "pre-dispatch-infrastructure-failure") {
      unresolvedInfrastructure += 1;
      continue;
    }
    terminalCells += 1;
    if (final === "pass" || final === "fail") {
      validGraderOutcomes += 1;
      if (final === "pass") passes += 1;
    } else if (final === "timeout-fail") {
      timeoutFails += 1;
    } else {
      incompatibilities += 1;
    }
  }
  const accountedCells = byCell.size;
  const reasons: string[] = [];
  if (accountedCells !== 12) reasons.push("not-all-12-cells-accounted");
  if (unresolvedInfrastructure > 0) reasons.push("unresolved-infrastructure");
  if (incompatibilities > 0) reasons.push("model-authentication-or-launcher-incompatibility");
  if (validGraderOutcomes < 10) reasons.push("fewer-than-10-valid-grader-outcomes");
  if (timeoutFails > 2) reasons.push("more-than-2-timeout-fails");
  if (passes < 2 || passes > 10) reasons.push("pass-count-outside-inclusive-2-to-10-range");
  const status = incompatibilities > 0
    ? "fail"
    : (accountedCells !== 12 || unresolvedInfrastructure > 0)
      ? "inconclusive"
      : reasons.length === 0 ? "pass" : "fail";
  return {
    planBasisSha256: plan.derived.basisSha256,
    model: DEMO1_HAIKU_MODEL,
    effort: DEMO1_HAIKU_EFFORT,
    status,
    disposition: status === "pass" ? "proceed-to-e2" : "stop-with-measurements",
    counts: {
      expectedCells: 12,
      accountedCells,
      terminalCells,
      validGraderOutcomes,
      passes,
      timeoutFails,
      infrastructureRetries,
      unresolvedInfrastructure,
      incompatibilities,
    },
    reasons,
    observations: plan.derived.suitabilityCells
      .flatMap((cell) => byCell.has(cell.cellId) ? [byCell.get(cell.cellId)!] : []),
  };
}

export function verifyDemo1HaikuSuitabilityAssessment(
  plan: Demo1RehearsalPlan,
  assessment: Demo1HaikuSuitabilityAssessment,
): void {
  const rebuilt = assessDemo1HaikuSuitability(plan, assessment.observations);
  if (!Buffer.from(canonicalBytes(rebuilt)).equals(Buffer.from(canonicalBytes(assessment)))) {
    throw new TypeError("Haiku suitability assessment does not recompute from canonical observations");
  }
}

function normalizeEvidenceRefs(refs: readonly Demo1EvidenceRef[], field: string): Demo1EvidenceRef[] {
  return refs.map((ref) => {
    exactKeys(ref, ["uri", "sha256"], `${field} reference`);
    nonEmpty(ref.uri, `${field} URI`);
    if (!SHA256.test(ref.sha256)) throw new TypeError(`${field} sha256 must be 64 lowercase hex`);
    return { uri: ref.uri, sha256: ref.sha256 };
  }).sort((left, right) => compareCodeUnitStrings(left.uri, right.uri)
    || compareCodeUnitStrings(left.sha256, right.sha256));
}

function normalizeEvidenceCheck(check: Demo1EvidenceCheck, field: string): Demo1EvidenceCheck {
  exactKeys(check, check.detail === undefined ? ["status", "evidence"] : ["status", "detail", "evidence"], field);
  if (!["match", "mismatch", "unverifiable"].includes(check.status)) throw new TypeError(`${field} status is invalid`);
  const evidence = normalizeEvidenceRefs(check.evidence, field);
  if (check.status === "match" && evidence.length === 0) throw new TypeError(`${field} cannot match without evidence`);
  return { status: check.status, ...(check.detail === undefined ? {} : { detail: nonEmpty(check.detail, `${field} detail`) }), evidence };
}

function scoredValue(outcome: Demo1ScoredOutcome): 0 | 1 {
  if (!["pass", "fail", "timeout-fail"].includes(outcome)) throw new TypeError(`invalid E2 outcome ${String(outcome)}`);
  return outcome === "pass" ? 1 : 0;
}

function normalizeE2Results(plan: Demo1RehearsalPlan, results: readonly Demo1E2TaskResult[]): Demo1E2TaskResult[] {
  const expected = new Map(plan.inputs.e2Tasks.map((task) => [task.taskId, task]));
  const byTask = new Map<string, Demo1E2TaskResult>();
  for (const result of results) {
    exactKeys(result, ["taskId", "outcomes"], "E2 task result");
    if (!expected.has(result.taskId)) throw new TypeError(`unknown E2 task ${result.taskId}`);
    if (byTask.has(result.taskId)) throw new TypeError(`duplicate E2 task ${result.taskId}`);
    exactKeys(result.outcomes, Object.values(DEMO1_ARMS), `${result.taskId} outcomes`);
    const outcomes = Object.fromEntries(Object.values(DEMO1_ARMS).map((arm) => {
      const values = result.outcomes[arm];
      if (values.length !== DEMO1_E2_REPLICATES) throw new TypeError(`${result.taskId}/${arm} requires exactly 5 outcomes`);
      values.forEach(scoredValue);
      return [arm, [...values]];
    })) as unknown as Demo1E2TaskResult["outcomes"];
    byTask.set(result.taskId, { taskId: result.taskId, outcomes });
  }
  if (byTask.size !== DEMO1_E2_TASKS) throw new TypeError("E2 rehearsal input must account for all 10 tasks");
  return plan.inputs.e2Tasks.map((task) => byTask.get(task.taskId)!);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
}

function pearson(left: readonly number[], right: readonly number[]): number | null {
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index]! - rightMean), 0);
  const denominator = Math.sqrt(
    left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0)
    * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0),
  );
  return denominator === 0 ? null : numerator / denominator;
}

function anovaIcc(values: readonly { readonly repository: string; readonly value: number }[]): { value: number | null; reason: string | null } {
  const groups = new Map<string, number[]>();
  for (const entry of values) groups.set(entry.repository, [...(groups.get(entry.repository) ?? []), entry.value]);
  if (groups.size < 2) return { value: null, reason: "fewer-than-two-repositories" };
  if (groups.size === values.length) return { value: null, reason: "all-repositories-are-singletons" };
  const arrays = [...groups.values()];
  const grand = mean(values.map((entry) => entry.value));
  const between = arrays.reduce((sum, group) => sum + group.length * (mean(group) - grand) ** 2, 0);
  const within = arrays.reduce((sum, group) => sum + group.reduce((inner, value) => inner + (value - mean(group)) ** 2, 0), 0);
  const meanBetween = between / (arrays.length - 1);
  const meanWithin = within / (values.length - arrays.length);
  const effectiveSize = (
    values.length - arrays.reduce((sum, group) => sum + group.length ** 2, 0) / values.length
  ) / (arrays.length - 1);
  const denominator = meanBetween + (effectiveSize - 1) * meanWithin;
  if (denominator === 0) return { value: 0, reason: null };
  return { value: Math.max(0, Math.min(1, (meanBetween - meanWithin) / denominator)), reason: null };
}

function varianceModel(
  repositories: readonly string[],
  taskValues: readonly number[],
  replicateVarianceCoefficients: readonly number[],
): NumericVarianceModel {
  const observedTaskVariance = sampleVariance(taskValues);
  const replicateVarianceCoefficient = mean(replicateVarianceCoefficients);
  const measurementVarianceAtFiveReplicates = replicateVarianceCoefficient / DEMO1_E2_REPLICATES;
  const latentTaskVariance = Math.max(0, observedTaskVariance - measurementVarianceAtFiveReplicates);
  const icc = anovaIcc(taskValues.map((value, index) => ({ repository: repositories[index]!, value })));
  return {
    observedTaskVariance,
    measurementVarianceAtFiveReplicates,
    latentTaskVariance,
    repositoryIcc: icc.value,
    repositoryIccReason: icc.reason,
    replicateVarianceCoefficient,
  };
}

function estimateE2(
  plan: Demo1RehearsalPlan,
  results: readonly Demo1E2TaskResult[],
  secondaryManipulationControl: Demo1OfficialControl,
): NumericE2Estimates {
  const tasks = plan.inputs.e2Tasks;
  const rates = results.map((result) => Object.fromEntries(Object.values(DEMO1_ARMS).map((arm) => [
    arm,
    mean(result.outcomes[arm].map(scoredValue)),
  ])) as Readonly<Record<Demo1E2Arm, number>>);
  const variances = results.map((result) => Object.fromEntries(Object.values(DEMO1_ARMS).map((arm) => [
    arm,
    sampleVariance(result.outcomes[arm].map(scoredValue)),
  ])) as Readonly<Record<Demo1E2Arm, number>>);
  const withinTaskVariance = Object.fromEntries(Object.values(DEMO1_ARMS).map((arm) => [
    arm,
    mean(variances.map((entry) => entry[arm])),
  ])) as unknown as Readonly<Record<Demo1E2Arm, number>>;
  const primaryTaskValues = rates.map((entry) => entry[DEMO1_ARMS.skill] - entry[DEMO1_ARMS.claudeMd]);
  const primaryCoefficients = variances.map((entry) => entry[DEMO1_ARMS.skill] + entry[DEMO1_ARMS.claudeMd]);
  const secondaryTaskValues = rates.map((entry) =>
    (entry[DEMO1_ARMS.skill] + entry[DEMO1_ARMS.claudeMd]) / 2 - entry[secondaryManipulationControl]);
  const secondaryCoefficients = variances.map((entry) =>
    (entry[DEMO1_ARMS.skill] + entry[DEMO1_ARMS.claudeMd]) / 4 + entry[secondaryManipulationControl]);
  const repositories = tasks.map((task) => task.repository);
  const primaryVarianceModel = varianceModel(repositories, primaryTaskValues, primaryCoefficients);
  const secondaryManipulationVarianceModel = varianceModel(repositories, secondaryTaskValues, secondaryCoefficients);
  const repositoryCounts = [...new Set(repositories)].sort(compareCodeUnitStrings).map((repository) => ({
    repository,
    tasks: repositories.filter((entry) => entry === repository).length,
  }));
  const timeoutBehavior = Object.fromEntries(Object.values(DEMO1_ARMS).map((arm) => {
    const timeoutFails = results.reduce((sum, result) =>
      sum + result.outcomes[arm].filter((outcome) => outcome === "timeout-fail").length, 0);
    return [arm, { timeoutFails, cells: DEMO1_E2_TASKS * DEMO1_E2_REPLICATES, rate: timeoutFails / 50 }];
  })) as unknown as NumericE2Estimates["timeoutBehavior"];
  const correlations: Array<NumericE2Estimates["taskCorrelation"][number]> = [];
  const arms = Object.values(DEMO1_ARMS);
  for (let left = 0; left < arms.length; left += 1) {
    for (let right = left + 1; right < arms.length; right += 1) {
      const leftArm = arms[left]!;
      const rightArm = arms[right]!;
      const value = pearson(rates.map((entry) => entry[leftArm]), rates.map((entry) => entry[rightArm]));
      correlations.push({
        arms: [leftArm, rightArm],
        pearson: value,
        reason: value === null ? "zero-task-rate-variance" : null,
      });
    }
  }
  return {
    withinTaskVariance,
    repositoryClustering: {
      primaryDifferenceIccAnova: primaryVarianceModel.repositoryIcc,
      reason: primaryVarianceModel.repositoryIccReason,
      repositoryCount: repositoryCounts.length,
      tasksPerRepository: repositoryCounts,
    },
    timeoutBehavior,
    taskCorrelation: correlations,
    primaryVarianceModel,
    secondaryManipulationControl,
    secondaryManipulationVarianceModel,
  };
}

function renderE2Estimates(estimates: NumericE2Estimates): Demo1E2Estimates {
  return {
    withinTaskVariance: Object.fromEntries(Object.values(DEMO1_ARMS).map((arm) => [
      arm,
      decimal(estimates.withinTaskVariance[arm]),
    ])) as unknown as Demo1E2Estimates["withinTaskVariance"],
    repositoryClustering: {
      primaryDifferenceIccAnova: estimates.repositoryClustering.primaryDifferenceIccAnova === null
        ? null
        : decimal(estimates.repositoryClustering.primaryDifferenceIccAnova),
      reason: estimates.repositoryClustering.reason,
      repositoryCount: estimates.repositoryClustering.repositoryCount,
      tasksPerRepository: estimates.repositoryClustering.tasksPerRepository,
    },
    timeoutBehavior: Object.fromEntries(Object.values(DEMO1_ARMS).map((arm) => {
      const behavior = estimates.timeoutBehavior[arm];
      return [arm, { ...behavior, rate: decimal(behavior.rate) }];
    })) as unknown as Demo1E2Estimates["timeoutBehavior"],
    taskCorrelation: estimates.taskCorrelation.map((entry) => ({
      ...entry,
      pearson: entry.pearson === null ? null : decimal(entry.pearson),
    })),
    primaryVarianceModel: renderVarianceModel(estimates.primaryVarianceModel),
    secondaryManipulationControl: estimates.secondaryManipulationControl,
    secondaryManipulationVarianceModel: renderVarianceModel(estimates.secondaryManipulationVarianceModel),
  };
}

function emptyLoadoutEquivalence(
  plan: Demo1RehearsalPlan,
  results: readonly Demo1E2TaskResult[],
  evidence: Demo1EmptyLoadoutEvidence,
): NonNullable<Demo1E2DesignDecision["emptyLoadoutEquivalence"]> {
  exactKeys(evidence, ["loaderBehavior", "modelVisibleContext"], "empty-loadout evidence");
  const loaderBehavior = normalizeEvidenceCheck(evidence.loaderBehavior, "loader behavior");
  const modelVisibleContext = normalizeEvidenceCheck(evidence.modelVisibleContext, "model-visible context");
  const byTask = new Map(results.map((result) => [result.taskId, result]));
  const rates = plan.inputs.e2Tasks.map((task) => {
    const result = byTask.get(task.taskId)!;
    return {
      taskDigest: task.taskSha256,
      cluster: ["source" as const, task.repository] as const,
      pA: mean(result.outcomes[DEMO1_ARMS.trueNoFile].map(scoredValue)),
      pB: mean(result.outcomes[DEMO1_ARMS.emptyLoadout].map(scoredValue)),
    };
  });
  const interval = clusteredPairedDeltaInterval(rates, {
    seed: plan.derived.seeds.emptyLoadoutInterval,
    resamples: DEMO1_EQUIVALENCE_RESAMPLES,
    alpha: 0.05,
  });
  const rejectionReasons = [
    ...(loaderBehavior.status === "match" ? [] : ["loader-behavior-not-structurally-indistinguishable"]),
    ...(modelVisibleContext.status === "match" ? [] : ["model-visible-context-not-structurally-indistinguishable"]),
    ...(interval.low >= -DEMO1_EQUIVALENCE_MARGIN && interval.high <= DEMO1_EQUIVALENCE_MARGIN
      ? [] : ["paired-interval-not-wholly-within-plus-or-minus-0.10"]),
  ];
  const accepted = rejectionReasons.length === 0;
  return {
    accepted,
    primaryControl: accepted ? "empty-loadout" : "true-no-file",
    loadoutAxis: accepted ? "verified-equivalent" : "unverifiable",
    structural: { loaderBehavior, modelVisibleContext },
    pairedInterval: {
      delta: decimal(interval.delta),
      low: decimal(interval.low),
      high: decimal(interval.high),
      margin: "0.1000",
      alpha: "0.0500",
      seed: plan.derived.seeds.emptyLoadoutInterval,
      resamples: 20_000,
      unit: "source-cluster",
    },
    rejectionReasons,
  };
}

function normal(next: () => number): number {
  const u1 = Math.max((next() + 1) / 4_294_967_297, Number.EPSILON);
  const u2 = (next() + 1) / 4_294_967_297;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function simulatedPower(
  model: NumericVarianceModel,
  tasks: readonly Demo1DesignTask[],
  replicates: number,
  effect: number,
  seed: number,
): number {
  if (model.repositoryIcc === null) throw new TypeError("repository clustering must be estimable before power simulation");
  const betweenVariance = model.latentTaskVariance * model.repositoryIcc;
  const taskVariance = model.latentTaskVariance * (1 - model.repositoryIcc);
  const replicateVariance = model.replicateVarianceCoefficient / replicates;
  const repositories = [...new Set(tasks.map((task) => task.repository))];
  const next = xorshift32(seed);
  let significant = 0;
  for (let simulation = 0; simulation < DEMO1_POWER_SIMULATIONS; simulation += 1) {
    const repositoryEffects = new Map(repositories.map((repository) => [
      repository,
      normal(next) * Math.sqrt(betweenVariance),
    ]));
    const deltas = tasks.map((task) => effect
      + repositoryEffects.get(task.repository)!
      + normal(next) * Math.sqrt(taskVariance)
      + normal(next) * Math.sqrt(replicateVariance));
    const observed = mean(deltas);
    const scores = repositories.map((repository) => tasks.reduce((sum, task, index) =>
      task.repository === repository ? sum + deltas[index]! - observed : sum, 0));
    const variance = repositories.length / (repositories.length - 1)
      * scores.reduce((sum, score) => sum + score ** 2, 0) / (tasks.length ** 2);
    const standardError = Math.sqrt(Math.max(0, variance));
    if (standardError === 0 ? observed > 0 : observed - Z_975 * standardError > 0) significant += 1;
  }
  return significant / DEMO1_POWER_SIMULATIONS;
}

function designSeed(seed: number, tasks: number, replicates: number, purpose: string): number {
  return resolvedSeed(sha256(`${seed}\u0000${tasks}\u0000${replicates}`), purpose);
}

function powerCurveSeed(seed: number, tasks: number, replicates: number, comparison: "primary" | "secondary"): number {
  return designSeed(seed, tasks, replicates, `${comparison}-power-curve`);
}

export function selectDemo1OfficialDesign(
  candidates: readonly Demo1SimulatedDesignCandidate[],
): Demo1SelectedDesign | null {
  const valid = candidates.map((candidate) => {
    exactKeys(candidate, ["tasks", "repositories", "replicates", "arms", "cells", "simulatedPower"], "simulated design");
    if (!Number.isSafeInteger(candidate.tasks) || candidate.tasks < 5
      || !Number.isSafeInteger(candidate.repositories) || candidate.repositories < 2
      || !Number.isSafeInteger(candidate.replicates) || candidate.replicates < 1
      || candidate.arms !== 3 || candidate.cells !== candidate.tasks * candidate.replicates * candidate.arms
      || candidate.cells > DEMO1_OFFICIAL_CELL_CEILING
      || !(candidate.simulatedPower >= 0 && candidate.simulatedPower <= 1)) {
      throw new TypeError("simulated design violates the feasible three-arm <=600-cell space");
    }
    return candidate;
  });
  if (valid.length === 0) return null;
  const tieRules = (left: Demo1SimulatedDesignCandidate, right: Demo1SimulatedDesignCandidate) =>
    right.repositories - left.repositories
    || right.tasks - left.tasks
    || left.replicates - right.replicates;
  const qualified = valid.filter((candidate) => candidate.simulatedPower >= DEMO1_TARGET_POWER)
    .sort((left, right) => left.cells - right.cells || tieRules(left, right));
  if (qualified[0] !== undefined) return { selection: "target-power", candidate: qualified[0] };
  const strongest = [...valid].sort((left, right) =>
    right.simulatedPower - left.simulatedPower || tieRules(left, right) || right.cells - left.cells)[0]!;
  return { selection: "strongest-within-ceiling", candidate: strongest };
}

function exhaustiveDesigns(
  model: NumericVarianceModel,
  officialOrder: readonly Demo1DesignTask[],
  seed: number,
): Demo1SimulatedDesignCandidate[] {
  const candidates: Demo1SimulatedDesignCandidate[] = [];
  const maximumTasks = Math.min(officialOrder.length, Math.floor(DEMO1_OFFICIAL_CELL_CEILING / DEMO1_OFFICIAL_ARMS));
  for (let tasks = 5; tasks <= maximumTasks; tasks += 1) {
    const selected = officialOrder.slice(0, tasks);
    const repositories = repositorySet(selected).size;
    if (repositories < 2) continue;
    const maximumReplicates = Math.floor(DEMO1_OFFICIAL_CELL_CEILING / (tasks * DEMO1_OFFICIAL_ARMS));
    for (let replicates = 1; replicates <= maximumReplicates; replicates += 1) {
      candidates.push({
        tasks,
        repositories,
        replicates,
        arms: 3,
        cells: tasks * replicates * 3,
        simulatedPower: simulatedPower(
          model,
          selected,
          replicates,
          DEMO1_TARGET_EFFECT,
          powerCurveSeed(seed, tasks, replicates, "primary"),
        ),
      });
    }
  }
  return candidates;
}

function achievedMde(
  model: NumericVarianceModel,
  tasks: readonly Demo1DesignTask[],
  replicates: number,
  seed: number,
): number | "greater-than-1.0000" {
  const powerAtOne = simulatedPower(model, tasks, replicates, 1, seed);
  if (powerAtOne < DEMO1_TARGET_POWER) return "greater-than-1.0000";
  let lowGridPoint = 0;
  let highGridPoint = 10_000;
  while (lowGridPoint < highGridPoint) {
    const midpoint = Math.floor((lowGridPoint + highGridPoint) / 2);
    if (simulatedPower(model, tasks, replicates, midpoint / 10_000, seed) >= DEMO1_TARGET_POWER) {
      highGridPoint = midpoint;
    } else {
      lowGridPoint = midpoint + 1;
    }
  }
  return highGridPoint / 10_000;
}

function stoppedDecision(
  plan: Demo1RehearsalPlan,
  suitability: Demo1HaikuSuitabilityAssessment,
  stopReasons: readonly string[],
): Demo1E2DesignDecision {
  return {
    schema: DEMO1_E2_DECISION_SCHEMA,
    artifactKind: DEMO1_DESIGN_ARTIFACT_KIND,
    planBasisSha256: plan.derived.basisSha256,
    planSha256: demo1RehearsalPlanDigest(plan),
    rehearsalInputSha256: null,
    status: "stop",
    stopReasons,
    suitability,
    emptyLoadoutEquivalence: null,
    estimates: null,
    officialDesign: null,
    powerClaim: null,
  };
}

export function deriveDemo1E2Design(
  plan: Demo1RehearsalPlan,
  suitability: Demo1HaikuSuitabilityAssessment,
  rehearsal?: Demo1E2RehearsalInput,
): Demo1E2DesignDecision {
  verifyDemo1RehearsalPlan(plan);
  verifyDemo1HaikuSuitabilityAssessment(plan, suitability);
  if (suitability.planBasisSha256 !== plan.derived.basisSha256) throw new TypeError("suitability assessment belongs to another plan");
  if (suitability.status !== "pass") return stoppedDecision(plan, suitability, [`haiku-suitability-${suitability.status}`]);
  if (rehearsal === undefined) return stoppedDecision(plan, suitability, ["e2-rehearsal-input-absent"]);
  const results = normalizeE2Results(plan, rehearsal.results);
  const equivalence = emptyLoadoutEquivalence(plan, results, rehearsal.emptyLoadoutEvidence);
  const rehearsalInputSha256 = sha256(canonicalBytes({
    results,
    emptyLoadoutEvidence: equivalence.structural,
  }));
  const control = equivalence.primaryControl;
  const numericEstimates = estimateE2(plan, results, control);
  const estimates = renderE2Estimates(numericEstimates);
  if (numericEstimates.primaryVarianceModel.repositoryIcc === null) {
    return {
      ...stoppedDecision(plan, suitability, ["repository-clustering-not-estimable"]),
      rehearsalInputSha256,
      emptyLoadoutEquivalence: equivalence,
      estimates,
    };
  }
  const candidates = exhaustiveDesigns(numericEstimates.primaryVarianceModel, plan.inputs.officialTaskOrder, plan.derived.seeds.powerSimulation);
  const selected = selectDemo1OfficialDesign(candidates);
  if (selected === null) {
    return {
      ...stoppedDecision(plan, suitability, ["no-feasible-official-design-within-600-cells"]),
      rehearsalInputSha256,
      emptyLoadoutEquivalence: equivalence,
      estimates,
    };
  }
  const chosenTasks = plan.inputs.officialTaskOrder.slice(0, selected.candidate.tasks);
  const primaryCurveSeed = powerCurveSeed(
    plan.derived.seeds.powerSimulation,
    selected.candidate.tasks,
    selected.candidate.replicates,
    "primary",
  );
  const primaryMde = achievedMde(
    numericEstimates.primaryVarianceModel,
    chosenTasks,
    selected.candidate.replicates,
    primaryCurveSeed,
  );
  const targetEffectAttainable = selected.candidate.simulatedPower >= DEMO1_TARGET_POWER;
  const mdeClassifiesTargetAttainable = typeof primaryMde !== "string" && primaryMde <= DEMO1_TARGET_EFFECT;
  if ((selected.selection === "target-power") !== targetEffectAttainable
    || mdeClassifiesTargetAttainable !== targetEffectAttainable) {
    throw new TypeError("selected design target-power and achieved-MDE classifications disagree");
  }
  const secondaryMde = numericEstimates.secondaryManipulationVarianceModel.repositoryIcc === null
    ? null
    : achievedMde(
        numericEstimates.secondaryManipulationVarianceModel,
        chosenTasks,
        selected.candidate.replicates,
        powerCurveSeed(plan.derived.seeds.secondarySensitivity, selected.candidate.tasks, selected.candidate.replicates, "secondary"),
      );
  const officialCells = scheduledCells(
    "official",
    chosenTasks,
    [DEMO1_ARMS.skill, DEMO1_ARMS.claudeMd, control],
    selected.candidate.replicates,
    plan.derived.seeds.officialScheduling,
  );
  return {
    schema: DEMO1_E2_DECISION_SCHEMA,
    artifactKind: DEMO1_DESIGN_ARTIFACT_KIND,
    planBasisSha256: plan.derived.basisSha256,
    planSha256: demo1RehearsalPlanDigest(plan),
    rehearsalInputSha256,
    status: "ready-for-lock",
    stopReasons: [],
    suitability,
    emptyLoadoutEquivalence: equivalence,
    estimates,
    officialDesign: {
      selection: selected.selection,
      tasks: chosenTasks,
      arms: ["skill", "claude-md", control],
      replicates: selected.candidate.replicates,
      repositories: selected.candidate.repositories,
      cells: selected.candidate.cells,
      cellCeiling: 600,
      targetEffect: "0.21",
      targetPower: "0.80",
      simulatedPowerAtTarget: decimal(selected.candidate.simulatedPower, 4),
      achievedMde: typeof primaryMde === "string" ? primaryMde : decimal(primaryMde, 4),
      primaryPowerCurve: {
        seed: primaryCurveSeed,
        randomStream: "shared-across-target-power-and-mde",
        effectGrid: "0.0000-to-1.0000-by-0.0001",
      },
      limitation: targetEffectAttainable ? null : "target-effect-unattainable-within-600-cells",
      topUpPolicy: "forbidden-after-lock",
      selectionInputs: ["primary-variance-model", "target-effect", "target-power", "frozen-official-task-order", "cell-ceiling"],
      excludedSelectionInputs: ["secondary-manipulation-sensitivity"],
      secondaryManipulationSensitivity: {
        control,
        achievedMde: secondaryMde === null
          ? null
          : typeof secondaryMde === "string" ? secondaryMde : decimal(secondaryMde, 4),
        mayAlterPrimarySizing: false,
      },
      cellsInSeededOrder: officialCells,
    },
    powerClaim: {
      procedure: "demo1-gaussian-cluster-monte-carlo@1",
      simulationsPerDesign: 2_000,
      alpha: "0.0500",
      evaluatedDesigns: candidates.length,
    },
  };
}

export function canonicalDemo1E2DesignBytes(decision: Demo1E2DesignDecision): Uint8Array {
  return canonicalBytes(decision);
}

export function verifyDemo1E2Design(
  decision: Demo1E2DesignDecision,
  plan: Demo1RehearsalPlan,
  suitability: Demo1HaikuSuitabilityAssessment,
  rehearsal?: Demo1E2RehearsalInput,
): void {
  const rebuilt = deriveDemo1E2Design(plan, suitability, rehearsal);
  if (!Buffer.from(canonicalDemo1E2DesignBytes(rebuilt)).equals(Buffer.from(canonicalDemo1E2DesignBytes(decision)))) {
    throw new TypeError("E2 design decision does not recompute from its frozen plan and rehearsal inputs");
  }
}

export function demo1E2DesignDigest(decision: Demo1E2DesignDecision): string {
  return `sha256:${sha256(canonicalDemo1E2DesignBytes(decision))}`;
}
