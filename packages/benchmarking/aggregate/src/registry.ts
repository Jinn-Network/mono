import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  compareCodeUnitStrings,
  isCalendarStrictRfc3339,
  parseExactDecimal,
  meetsExactDecimalFloor,
  scaleDecimal,
  sealMatrix,
  type MatrixRecord,
} from "@jinn-network/benchmarking-records";
import { filterByCutoff } from "./clean-subset.js";
import { selectScorableCells, type CellRef } from "./exclusion.js";
import type { Method, MethodComputeInput, MethodRegistry } from "./method.js";
import {
  MethodInputError,
  matrixRunDigest,
  resolveAnchoredAnnouncementTime,
  resolveRun,
  resolveTaskProvenance,
  resolveVerdictOutcome,
} from "./resolved-inputs.js";
import { clusteredPairedRateDiffBca, MAX_NONINFERIORITY_RESAMPLES_V1, nonInferiorityIut, nonInferiorityVerdict, pairedCostVerdict, type ExactCostDifference, type NonInferiorityOptions } from "./stats/noninferiority.js";
import { pairedMcnemar } from "./stats/paired-mcnemar.js";
import { avgAtOne, passAtK } from "./stats/pass-at-k.js";
import { wilsonInterval } from "./stats/wilson.js";
import { reduceValidVerdicts, type VerdictReduction } from "./verdict-rule.js";

type MethodMetadata = Omit<Method, "id" | "version" | "versionRobust" | "compute">;
type SingleSubjectComputeInput = Omit<MethodComputeInput, "subjects"> & {
  readonly subjectSha256: string;
  readonly matrices: readonly [MatrixRecord];
};
type SingleSubjectMethod = Omit<Method, "compute"> & {
  readonly compute?: (input: SingleSubjectComputeInput) => unknown;
};

function sourceClusterManifest(rates: readonly {
  readonly taskDigest: string;
  readonly cluster: readonly ["source" | "sourceCommitment", string];
}[]): readonly { readonly key: readonly ["source" | "sourceCommitment", string]; readonly members: readonly string[] }[] {
  const groups = new Map<string, { key: ["source" | "sourceCommitment", string]; members: string[] }>();
  for (const rate of rates) {
    const id = JSON.stringify(rate.cluster);
    const group = groups.get(id) ?? { key: [rate.cluster[0], rate.cluster[1]], members: [] };
    group.members.push(rate.taskDigest);
    groups.set(id, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, members: group.members.sort(compareCodeUnitStrings) }))
    .sort((left, right) => {
      const byTag = compareCodeUnitStrings(left.key[0], right.key[0]);
      return byTag === 0 ? compareCodeUnitStrings(left.key[1], right.key[1]) : byTag;
    });
}

function validateParameters(
  schema: Method["parameterSchema"],
  parameters: Readonly<Record<string, unknown>>,
): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  for (const required of schema.required) {
    if (!Object.hasOwn(parameters, required)) issues.push(`missing required parameter "${required}"`);
  }
  if (!schema.additionalProperties) {
    for (const key of Object.keys(parameters)) {
      if (!Object.hasOwn(schema.properties, key)) issues.push(`unknown parameter "${key}"`);
    }
  }
  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = parameters[key];
    if (value === undefined) continue;
    if (Array.isArray(rule["enum"]) && !(rule["enum"] as unknown[]).includes(value)) {
      issues.push(`parameter "${key}" is outside its enum`);
    }
    if (rule["type"] === "string" && typeof value !== "string") issues.push(`parameter "${key}" must be a string`);
    if (rule["type"] === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
      issues.push(`parameter "${key}" must be an integer`);
    }
    if (rule["type"] === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
      issues.push(`parameter "${key}" must be an object`);
    }
    if (typeof rule["minimum"] === "number" && typeof value === "number" && value < rule["minimum"]) {
      issues.push(`parameter "${key}" must be >= ${rule["minimum"]}`);
    }
    if (typeof rule["maximum"] === "number" && typeof value === "number" && value > rule["maximum"]) {
      issues.push(`parameter "${key}" must be <= ${rule["maximum"]}`);
    }
    if (
      rule["format"] === "date-time"
      && typeof value === "string"
      && !isCalendarStrictRfc3339(value)
    ) {
      issues.push(`parameter "${key}" must be an RFC 3339 date-time`);
    }
  }
  const baseline = parameters["baseline"];
  const candidate = parameters["candidate"];
  if (
    typeof baseline === "string"
    && typeof candidate === "string"
    && baseline === candidate
  ) {
    issues.push('parameters "baseline" and "candidate" must name distinct arms');
  }
  const delegate = parameters["delegate"];
  if (delegate !== undefined) {
    if (typeof delegate !== "object" || delegate === null || Array.isArray(delegate)) {
      issues.push('parameter "delegate" must be an object');
    } else {
      const value = delegate as Record<string, unknown>;
      for (const key of ["id", "version", "parameters"]) {
        if (!Object.hasOwn(value, key)) issues.push(`parameter "delegate" is missing "${key}"`);
      }
      for (const key of Object.keys(value)) {
        if (!["id", "version", "parameters"].includes(key)) {
          issues.push(`parameter "delegate" has unknown property "${key}"`);
        }
      }
      if (typeof value["id"] !== "string" || value["id"].length === 0) {
        issues.push('parameter "delegate.id" must be a non-empty string');
      }
      if (typeof value["version"] !== "string" || value["version"].length === 0) {
        issues.push('parameter "delegate.version" must be a non-empty string');
      }
      if (
        typeof value["parameters"] !== "object"
        || value["parameters"] === null
        || Array.isArray(value["parameters"])
      ) {
        issues.push('parameter "delegate.parameters" must be an object');
      }
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function metadata(input: Omit<MethodMetadata, "validateParameters">): MethodMetadata {
  return {
    ...input,
    validateParameters(parameters) {
      return validateParameters(input.parameterSchema, parameters);
    },
  };
}

const VERDICT_RULE_PROPERTY = { enum: ["sole", "unanimous", "any-pass", "majority"] };
const METHOD_METADATA = {
  wilson: metadata({
    requiredInputs: ["matrix.cells", "referenced-verdicts"],
    parameterSchema: { type: "object", required: ["verdictRule"], properties: { verdictRule: VERDICT_RULE_PROPERTY }, additionalProperties: false },
    outputShape: "per-arm pass rate + Wilson interval + conflicted cells",
    exclusionRule: "judged-only; conflicted dropped-with-report",
    clusteringRule: "none",
    referenceSet: "v1-reference",
    deterministic: true,
    computeAvailability: "available",
  }),
  avgAtK: metadata({
    requiredInputs: ["matrix.cells", "referenced-verdicts"],
    parameterSchema: { type: "object", required: ["verdictRule"], properties: { verdictRule: VERDICT_RULE_PROPERTY }, additionalProperties: false },
    outputShape: "per-arm per-task repetition rate + arm mean + conflicted cells",
    exclusionRule: "judged-only; preserve arm identity",
    clusteringRule: "none",
    referenceSet: "v1-reference",
    deterministic: true,
    computeAvailability: "available",
  }),
  passAtK: metadata({
    requiredInputs: ["matrix.cells", "referenced-verdicts"],
    parameterSchema: { type: "object", required: ["verdictRule", "k"], properties: { verdictRule: VERDICT_RULE_PROPERTY, k: { type: "integer", minimum: 1 } }, additionalProperties: false },
    outputShape: "per-arm per-task unbiased pass@k + arm mean + conflicted cells",
    exclusionRule: "judged-only; preserve arm identity",
    clusteringRule: "none",
    referenceSet: "v1-reference",
    deterministic: true,
    computeAvailability: "available",
  }),
  pairedMcnemar: metadata({
    requiredInputs: ["matrix.cells", "referenced-verdicts", "task-provenance-source"],
    parameterSchema: { type: "object", required: ["verdictRule", "baseline", "candidate"], properties: { verdictRule: VERDICT_RULE_PROPERTY, baseline: { type: "string" }, candidate: { type: "string" } }, additionalProperties: false },
    outputShape: "paired exact McNemar + provenance-cluster correction + excluded cells",
    exclusionRule: "pair shared task digests judged in both arms; report full remainder",
    clusteringRule: "task-provenance-source",
    referenceSet: "v1-reference",
    deterministic: true,
    computeAvailability: "available",
  }),
  noninferiorityIut: metadata({
    requiredInputs: ["matrix.cells", "matrix.cost", "referenced-verdicts", "exact-task-bytes", "task-provenance-source-family"],
    parameterSchema: { type: "object", required: ["verdictRule", "baseline", "candidate", "seed", "resamples"], properties: { verdictRule: VERDICT_RULE_PROPERTY, baseline: { type: "string" }, candidate: { type: "string" }, seed: { type: "integer", minimum: 1, maximum: 4_294_967_295 }, resamples: { type: "integer", minimum: 1, maximum: MAX_NONINFERIORITY_RESAMPLES_V1 } }, additionalProperties: false },
    outputShape: "BCa quality lower bound AND one-sided paired-cost Wilcoxon + exclusions + conflicted cells",
    exclusionRule: "paired both-arm judged cells; cost only both-solve pairs; report remainder",
    clusteringRule: "task-provenance-source",
    referenceSet: "v1-reference",
    deterministic: true,
    resamplingProcedure: "xorshift32-v1; sample whole source clusters with replacement; one uint32 draw per cluster position; cluster jackknife acceleration",
    computeAvailability: "available",
  }),
  cleanSubset: metadata({
    requiredInputs: ["matrix.cells", "referenced-verdicts", "exact-task-bytes-or-anchored-benchmark-announcement"],
    parameterSchema: { type: "object", required: ["verdictRule", "basis", "cutoff", "delegate"], properties: { verdictRule: VERDICT_RULE_PROPERTY, basis: { enum: ["self-declared", "announcement-anchored"] }, cutoff: { type: "string", format: "date-time" }, delegate: { type: "object" } }, additionalProperties: false },
    outputShape: "named contamination subset + delegated results + conflicted cells",
    exclusionRule: "predicate exclusions reported before delegate exclusions",
    clusteringRule: "delegate-defined",
    referenceSet: "v1-reference",
    deterministic: true,
    computeAvailability: "available",
  }),
  bradleyTerry: metadata({
    requiredInputs: ["pairwise-judgment-records (not frozen in v1)"],
    parameterSchema: { type: "object", required: [], properties: {}, additionalProperties: false },
    outputShape: "unavailable until genuine pairwise judgment input is frozen",
    exclusionRule: "unavailable",
    clusteringRule: "unavailable",
    referenceSet: "registered-non-reference",
    deterministic: true,
    computeAvailability: "unavailable",
  }),
} as const;

function fixed4(x: number): string {
  return x.toFixed(4);
}

function requireStringParam(parameters: Readonly<Record<string, unknown>>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string") throw new Error(`method parameter "${key}" must be a string`);
  return value;
}

function requireIntegerParam(parameters: Readonly<Record<string, unknown>>, key: string): number {
  const value = parameters[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`method parameter "${key}" must be an integer`);
  }
  return value;
}

/** Every scored cell in one exact subject Matrix, reduced to a decisive value (or dropped as
 * `conflicted`). Shared by every per-cell scoring method (§9.3 exclusion discipline, §9.2
 * verdictRule reduction). Public methods apply this independently to each ordered subject. */
function reduceScoredCells(input: SingleSubjectComputeInput): { decisive: (CellRef & { value: "pass" | "fail" })[]; conflictedCellKeys: string[] } {
  const decisive: (CellRef & { value: "pass" | "fail" })[] = [];
  const conflictedCellKeys: string[] = [];
  for (const matrix of input.matrices) {
    const { scored } = selectScorableCells(matrix);
    for (const ref of scored) {
      const outcomes = ref.validVerdicts
        .map((digest) => resolveVerdictOutcome(digest, input));
      const reduction: VerdictReduction = reduceValidVerdicts(outcomes, input.verdictRule);
      if ("conflicted" in reduction) conflictedCellKeys.push(ref.cellKey);
      else decisive.push({ ...ref, value: reduction.value });
    }
  }
  conflictedCellKeys.sort(compareCodeUnitStrings);
  return { decisive, conflictedCellKeys };
}

/** Every arm represented by the exact subject Matrix, including arms with no decisive cells. */
function subjectArmIds(input: SingleSubjectComputeInput): string[] {
  return [...new Set(input.matrices.flatMap((matrix) => matrix.cells.map((cell) => cell.armId)))]
    .sort(compareCodeUnitStrings);
}

// --- wilson@1 (design §9.2) ------------------------------------------------------------------

const wilsonMethod: SingleSubjectMethod = {
  ...METHOD_METADATA.wilson,
  id: BENCHMARKING_METHOD_IDS.wilson,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
  compute(input) {
    const armIds = subjectArmIds(input);
    const { decisive, conflictedCellKeys } = reduceScoredCells(input);
    const perArm = new Map<string, { passed: number; scorable: number }>();
    for (const armId of armIds) perArm.set(armId, { passed: 0, scorable: 0 });
    for (const cell of decisive) {
      const bucket = perArm.get(cell.armId) ?? { passed: 0, scorable: 0 };
      bucket.scorable += 1;
      if (cell.value === "pass") bucket.passed += 1;
      perArm.set(cell.armId, bucket);
    }
    const arms: Record<string, unknown> = {};
    for (const armId of armIds) {
      const { passed, scorable } = perArm.get(armId)!;
      const { p, lo, hi } = wilsonInterval(passed, scorable);
      arms[armId] = { n: scorable, passRate: fixed4(p), wilsonInterval: { low: fixed4(lo), high: fixed4(hi) } };
    }
    return {
      verdictRule: input.verdictRule,
      arms,
      conflicted: { count: conflictedCellKeys.length, cellKeys: conflictedCellKeys },
    };
  },
};

// --- avg-at-k@1 / pass-at-k@1 (design §9.2) --------------------------------------------------

function perArmTaskReplicateCounts(input: SingleSubjectComputeInput): {
  perArmTask: Map<string, Map<string, { n: number; c: number; cellKeys: string[] }>>;
  armIds: string[];
  taskDigests: string[];
  conflictedCellKeys: string[];
} {
  const armIds = subjectArmIds(input);
  const { decisive, conflictedCellKeys } = reduceScoredCells(input);
  const perArmTask = new Map<string, Map<string, { n: number; c: number; cellKeys: string[] }>>();
  for (const armId of armIds) perArmTask.set(armId, new Map());
  for (const cell of decisive) {
    const perTask = perArmTask.get(cell.armId) ?? new Map<string, { n: number; c: number; cellKeys: string[] }>();
    const bucket = perTask.get(cell.taskDigest) ?? { n: 0, c: 0, cellKeys: [] };
    bucket.n += 1;
    if (cell.value === "pass") bucket.c += 1;
    bucket.cellKeys.push(cell.cellKey);
    perTask.set(cell.taskDigest, bucket);
    perArmTask.set(cell.armId, perTask);
  }
  const taskDigests = [...new Set(
    input.matrices.flatMap((matrix) => matrix.cells.map((cell) => cell.taskDigest)),
  )].sort(compareCodeUnitStrings);
  return { perArmTask, armIds, taskDigests, conflictedCellKeys };
}

const avgAtKMethod: SingleSubjectMethod = {
  ...METHOD_METADATA.avgAtK,
  id: BENCHMARKING_METHOD_IDS.avgAtK,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
  compute(input) {
    const { perArmTask, armIds, taskDigests, conflictedCellKeys } = perArmTaskReplicateCounts(input);
    const arms: Record<string, unknown> = {};
    for (const armId of armIds) {
      const perTask = perArmTask.get(armId)!;
      const perTaskResults: Record<string, unknown> = {};
      let sum = 0;
      for (const taskDigest of [...perTask.keys()].sort(compareCodeUnitStrings)) {
        const { n, c } = perTask.get(taskDigest)!;
        const rate = avgAtOne(n, c);
        sum += rate;
        perTaskResults[taskDigest] = { n, c, avgRate: fixed4(rate) };
      }
      arms[armId] = {
        perTask: perTaskResults,
        mean: fixed4(perTask.size > 0 ? sum / perTask.size : 0),
        missingTaskDigests: taskDigests.filter((digest) => !perTask.has(digest)),
      };
    }
    return {
      verdictRule: input.verdictRule,
      arms,
      conflicted: { count: conflictedCellKeys.length, cellKeys: conflictedCellKeys },
    };
  },
};

const passAtKMethod: SingleSubjectMethod = {
  ...METHOD_METADATA.passAtK,
  id: BENCHMARKING_METHOD_IDS.passAtK,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
  compute(input) {
    const k = requireIntegerParam(input.parameters, "k");
    const { perArmTask, armIds, taskDigests, conflictedCellKeys } = perArmTaskReplicateCounts(input);
    const arms: Record<string, unknown> = {};
    const incompatibleTasks: {
      armId: string;
      taskDigest: string;
      n: number;
      k: number;
      reason: "k-exceeds-observed-replicates";
      cellKeys: string[];
    }[] = [];
    for (const armId of armIds) {
      const perTask = perArmTask.get(armId)!;
      const perTaskResults: Record<string, unknown> = {};
      let sum = 0;
      let compatibleTaskCount = 0;
      for (const taskDigest of [...perTask.keys()].sort(compareCodeUnitStrings)) {
        const { n, c, cellKeys } = perTask.get(taskDigest)!;
        if (k > n) {
          incompatibleTasks.push({
            armId,
            taskDigest,
            n,
            k,
            reason: "k-exceeds-observed-replicates",
            cellKeys: [...cellKeys].sort(compareCodeUnitStrings),
          });
          continue;
        }
        const value = passAtK(n, c, k);
        sum += value;
        compatibleTaskCount += 1;
        perTaskResults[taskDigest] = { n, c, passAtK: fixed4(value) };
      }
      arms[armId] = {
        perTask: perTaskResults,
        mean: fixed4(compatibleTaskCount > 0 ? sum / compatibleTaskCount : 0),
        missingTaskDigests: taskDigests.filter((digest) => !perTask.has(digest)),
      };
    }
    return {
      verdictRule: input.verdictRule,
      k,
      arms,
      incompatible: { count: incompatibleTasks.length, tasks: incompatibleTasks },
      conflicted: { count: conflictedCellKeys.length, cellKeys: conflictedCellKeys },
    };
  },
};

// --- paired-mcnemar@1 (design §9.2) ------------------------------------------------------------

const pairedMcnemarMethod: SingleSubjectMethod = {
  ...METHOD_METADATA.pairedMcnemar,
  id: BENCHMARKING_METHOD_IDS.pairedMcnemar,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: true,
  compute(input) {
    const baseline = requireStringParam(input.parameters, "baseline");
    const candidate = requireStringParam(input.parameters, "candidate");
    for (const matrix of input.matrices) {
      const runDigest = matrixRunDigest(matrix);
      const run = resolveRun(runDigest, input);
      if (run.replicates !== 1) {
        throw new MethodInputError(
          "incompatible-run-replicates",
          runDigest,
          `paired-mcnemar@1 requires Run.replicates === 1; got ${run.replicates}`,
        );
      }
    }

    type RelevantCell = {
      readonly cellKey: string;
      readonly taskDigest: string;
      readonly armId: string;
      readonly value?: "pass" | "fail";
      readonly conflicted: boolean;
    };
    const relevant: RelevantCell[] = [];
    const conflictedCellKeys: string[] = [];
    for (const matrix of input.matrices) {
      for (const cell of matrix.cells) {
        if (cell.armId !== baseline && cell.armId !== candidate) continue;
        if (cell.outcome !== "judged") {
          relevant.push({
            cellKey: cell.cellKey,
            taskDigest: cell.taskDigest,
            armId: cell.armId,
            conflicted: false,
          });
          continue;
        }
        const reduction = reduceValidVerdicts(
          cell.validVerdicts.map((digest) => resolveVerdictOutcome(digest, input)),
          input.verdictRule,
        );
        if ("conflicted" in reduction) {
          conflictedCellKeys.push(cell.cellKey);
          relevant.push({
            cellKey: cell.cellKey,
            taskDigest: cell.taskDigest,
            armId: cell.armId,
            conflicted: true,
          });
        } else {
          relevant.push({
            cellKey: cell.cellKey,
            taskDigest: cell.taskDigest,
            armId: cell.armId,
            value: reduction.value,
            conflicted: false,
          });
        }
      }
    }

    const byTask = new Map<string, RelevantCell[]>();
    for (const cell of relevant) {
      const cells = byTask.get(cell.taskDigest) ?? [];
      cells.push(cell);
      byTask.set(cell.taskDigest, cells);
    }
    const outcomes: {
      taskDigest: string;
      baseline: "pass" | "fail";
      candidate: "pass" | "fail";
    }[] = [];
    const excludedCellKeys: string[] = [];
    const clusterKeys = new Map<string, string>();
    for (const taskDigest of [...byTask.keys()].sort(compareCodeUnitStrings)) {
      const cells = byTask.get(taskDigest)!;
      const baselineCells = cells.filter((cell) => cell.armId === baseline && cell.value !== undefined);
      const candidateCells = cells.filter((cell) => cell.armId === candidate && cell.value !== undefined);
      if (baselineCells.length === 1 && candidateCells.length === 1) {
        outcomes.push({
          taskDigest,
          baseline: baselineCells[0]!.value!,
          candidate: candidateCells[0]!.value!,
        });
        const provenance = resolveTaskProvenance(taskDigest, input);
        clusterKeys.set(taskDigest, JSON.stringify([provenance.cluster.tag, provenance.cluster.value]));
      } else {
        excludedCellKeys.push(...cells.map((cell) => cell.cellKey));
      }
      for (const cell of cells) {
        if (cell.value === undefined && !excludedCellKeys.includes(cell.cellKey)) {
          excludedCellKeys.push(cell.cellKey);
        }
      }
    }
    excludedCellKeys.sort(compareCodeUnitStrings);
    conflictedCellKeys.sort(compareCodeUnitStrings);

    const result = pairedMcnemar(outcomes, (taskDigest) => clusterKeys.get(taskDigest));
    return {
      verdictRule: input.verdictRule,
      baseline,
      candidate,
      pairs: result.pairs,
      improved: result.improved,
      regressed: result.regressed,
      concordantPass: result.concordantPass,
      concordantFail: result.concordantFail,
      pairing: { taskDigests: outcomes.map((outcome) => outcome.taskDigest) },
      excluded: { count: excludedCellKeys.length, cellKeys: excludedCellKeys },
      pValue: fixed4(result.pValue),
      clustering: result.clustering,
      ...(result.clusteredPValue === undefined ? {} : { clusteredPValue: fixed4(result.clusteredPValue) }),
      ...(result.designEffect === undefined ? {} : { designEffect: fixed4(result.designEffect) }),
      conflicted: { count: conflictedCellKeys.length, cellKeys: conflictedCellKeys },
    };
  },
};

// --- clean-subset@1 (design §9.2) --------------------------------------------------------------

function restrictMatrixToTasks(matrix: MatrixRecord, keptTaskDigests: ReadonlySet<string>): MatrixRecord {
  const cells = matrix.cells.filter((cell) => keptTaskDigests.has(cell.taskDigest));
  const keptCellKeys = new Set(cells.map((cell) => cell.cellKey));
  const exclusions = matrix.exclusions.filter((entry) => keptCellKeys.has(entry.cellKey));
  const perArm: MatrixRecord["attrition"]["perArm"] = {};
  for (const cell of cells) {
    const counts = perArm[cell.armId] ?? {
      expected: 0,
      judged: 0,
      unjudged: 0,
      unscorable: 0,
      expired: 0,
      invalidated: 0,
      excluded: 0,
      replacements: 0,
    };
    counts.expected += 1;
    counts[cell.outcome] += 1;
    counts.replacements += Math.max(0, cell.dispatches - 1);
    perArm[cell.armId] = counts;
  }
  const judged = cells.filter((cell) => cell.outcome === "judged").length;
  const denominator = cells.length - exclusions.length;
  const floorPassed = meetsExactDecimalFloor(judged, denominator, matrix.completeness.floor);
  return {
    ...matrix,
    cells,
    exclusions,
    attrition: {
      perArm,
      // Predicate restriction can remove one side of a declared flag. The delegate receives the
      // exact restricted population, so no original whole-Matrix asymmetry claim is carried over.
      asymmetryFlags: [],
    },
    completeness: {
      ...matrix.completeness,
      expected: cells.length,
      judged,
      ...(matrix.completeness.runOutcome === "cancelled"
        ? {}
        : { runOutcome: floorPassed ? "complete" as const : "partial" as const }),
    },
  };
}

const cleanSubsetMethod: SingleSubjectMethod = {
  ...METHOD_METADATA.cleanSubset,
  id: BENCHMARKING_METHOD_IDS.cleanSubset,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
  compute(input) {
    const cutoff = requireStringParam(input.parameters, "cutoff");
    const basis = requireStringParam(input.parameters, "basis");
    const delegateParam = input.parameters["delegate"];
    if (typeof delegateParam !== "object" || delegateParam === null) {
      throw new Error('method parameter "delegate" must be an object');
    }
    const delegate = delegateParam as { id: string; version: string; parameters?: Record<string, unknown> };
    if (input.registry === undefined) throw new Error("clean-subset@1 requires MethodComputeInput.registry to resolve its delegate");
    const delegateMethod = input.registry.get(delegate.id, delegate.version);
    if (delegateMethod === undefined) throw new Error(`clean-subset@1: delegate ${delegate.id}@${delegate.version} is not registered`);
    if (delegateMethod.computeAvailability !== "available" || delegateMethod.compute === undefined) {
      throw new Error(`clean-subset@1: delegate ${delegate.id}@${delegate.version} is unavailable`);
    }
    const delegateParameters = {
      ...(delegate.parameters ?? {}),
      verdictRule: input.verdictRule,
    };
    const delegateValidation = delegateMethod.validateParameters(delegateParameters);
    if (!delegateValidation.ok) {
      throw new Error(
        `clean-subset@1: invalid delegate parameters: ${delegateValidation.issues.join("; ")}`,
      );
    }

    const allTaskDigests = [...new Set(
      input.matrices.flatMap((matrix) => matrix.cells.map((cell) => cell.taskDigest)),
    )].sort(compareCodeUnitStrings);
    const timestamps = new Map<string, string>();
    if (basis === "self-declared") {
      for (const taskDigest of allTaskDigests) {
        timestamps.set(taskDigest, resolveTaskProvenance(taskDigest, input).timestamp);
      }
    } else if (basis === "announcement-anchored") {
      for (const matrix of input.matrices) {
        const run = resolveRun(matrixRunDigest(matrix), input);
        const benchmarkDigest = `sha256:${run.benchmark.digest.sha256}`;
        const timestamp = resolveAnchoredAnnouncementTime(
          benchmarkDigest,
          input.resolveAnchoredBenchmarkAnnouncement?.(benchmarkDigest),
          input.verifyAnchoredBenchmarkAnnouncement,
        );
        for (const taskDigest of new Set(matrix.cells.map((cell) => cell.taskDigest))) {
          const existing = timestamps.get(taskDigest);
          if (existing === undefined || timestamp < existing) timestamps.set(taskDigest, timestamp);
        }
      }
    } else {
      throw new Error(`clean-subset@1: unsupported basis "${basis}"`);
    }
    const { kept, excludedByPredicate } = filterByCutoff(
      allTaskDigests,
      cutoff,
      (taskDigest) => timestamps.get(taskDigest),
    );
    const keptSet = new Set(kept);
    const excludedSet = new Set(excludedByPredicate);

    const filteredMatrix = restrictMatrixToTasks(input.matrices[0], keptSet);
    const filteredSubjectSha256 = sealMatrix(filteredMatrix).digest.slice("sha256:".length);
    const delegateEnvelope = delegateMethod.compute({
      subjects: [{ subjectSha256: filteredSubjectSha256, matrix: filteredMatrix }],
      parameters: delegateParameters,
      verdictRule: input.verdictRule,
      resolveVerdictBytes: input.resolveVerdictBytes,
      resolveRunBytes: input.resolveRunBytes,
      resolveTaskBytes: input.resolveTaskBytes,
      registry: input.registry,
      ...(input.resolveAnchoredBenchmarkAnnouncement === undefined
        ? {}
        : { resolveAnchoredBenchmarkAnnouncement: input.resolveAnchoredBenchmarkAnnouncement }),
      ...(input.verifyAnchoredBenchmarkAnnouncement === undefined
        ? {}
        : { verifyAnchoredBenchmarkAnnouncement: input.verifyAnchoredBenchmarkAnnouncement }),
    });
    if (
      delegateEnvelope.perSubject.length !== 1
      || delegateEnvelope.perSubject[0]?.subjectSha256 !== filteredSubjectSha256
    ) {
      throw new Error("clean-subset@1: delegate did not preserve the restricted subject identity");
    }
    const delegateResults = delegateEnvelope.perSubject[0].results;
    const excludedCellKeys = input.matrices
      .flatMap((matrix) => matrix.cells)
      .filter((cell) => excludedSet.has(cell.taskDigest))
      .map((cell) => cell.cellKey)
      .sort(compareCodeUnitStrings);
    const delegateConflicted = (
      typeof delegateResults === "object"
      && delegateResults !== null
      && "conflicted" in delegateResults
    )
      ? (delegateResults as { conflicted: unknown }).conflicted
      : { count: 0, cellKeys: [] };

    return {
      basis,
      cutoff,
      keptTaskDigests: kept,
      excludedByPredicate: { count: excludedCellKeys.length, cellKeys: excludedCellKeys },
      delegate: delegateResults,
      conflicted: delegateConflicted,
    };
  },
};

// --- noninferiority-iut@1 and bradley-terry@1 (design §9.2) -----------------------------------
// noninferiority-iut is a v1 reference method. Bradley–Terry is registered for identity and
// discovery only: v1 has no frozen pairwise-judgment input record, so its declarative metadata
// truthfully marks compute unavailable.

const nonInferiorityIutMethod: SingleSubjectMethod = {
  ...METHOD_METADATA.noninferiorityIut,
  id: BENCHMARKING_METHOD_IDS.noninferiorityIut,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: true,
  compute(input) {
    const baseline = requireStringParam(input.parameters, "baseline");
    const candidate = requireStringParam(input.parameters, "candidate");
    const seed = requireIntegerParam(input.parameters, "seed");
    const resamples = requireIntegerParam(input.parameters, "resamples");
    if (resamples <= 0 || resamples > MAX_NONINFERIORITY_RESAMPLES_V1) {
      throw new MethodInputError("method-incompatible-cost-unit", "resamples", `resamples must be in 1..${MAX_NONINFERIORITY_RESAMPLES_V1}`);
    }

    type RelevantCell = {
      readonly cellKey: string;
      readonly taskDigest: string;
      readonly armId: string;
      readonly replicate: number;
      readonly value?: "pass" | "fail";
      readonly cost?: { readonly value: string; readonly unit: string };
    };
    const relevant: RelevantCell[] = [];
    const conflictedCellKeys: string[] = [];
    for (const matrix of input.matrices) {
      for (const cell of matrix.cells) {
        if (cell.armId !== baseline && cell.armId !== candidate) continue;
        let value: "pass" | "fail" | undefined;
        if (cell.outcome === "judged") {
          const reduction = reduceValidVerdicts(
            cell.validVerdicts.map((digest) => resolveVerdictOutcome(digest, input)),
            input.verdictRule,
          );
          if ("conflicted" in reduction) conflictedCellKeys.push(cell.cellKey);
          else value = reduction.value;
        }
        relevant.push({
          cellKey: cell.cellKey,
          taskDigest: cell.taskDigest,
          armId: cell.armId,
          replicate: cell.replicate,
          ...(value === undefined ? {} : { value }),
          ...(cell.cost === undefined
            ? {}
            : { cost: { value: cell.cost.value, unit: cell.cost.unit } }),
        });
      }
    }

    const byTask = new Map<string, RelevantCell[]>();
    for (const cell of relevant) {
      const cells = byTask.get(cell.taskDigest) ?? [];
      cells.push(cell);
      byTask.set(cell.taskDigest, cells);
    }
    const rates: { pA: number; pB: number }[] = [];
    const pairedTaskDigests: string[] = [];
    const qualityExcludedCellKeys: string[] = [];
    const qualityIncludedCellKeys = new Set<string>();
    for (const taskDigest of [...byTask.keys()].sort(compareCodeUnitStrings)) {
      const cells = byTask.get(taskDigest)!;
      const baselineCells = cells.filter((cell) => cell.armId === baseline && cell.value !== undefined);
      const candidateCells = cells.filter((cell) => cell.armId === candidate && cell.value !== undefined);
      if (baselineCells.length > 0 && candidateCells.length > 0) {
        rates.push({
          pA: baselineCells.filter((cell) => cell.value === "pass").length / baselineCells.length,
          pB: candidateCells.filter((cell) => cell.value === "pass").length / candidateCells.length,
        });
        pairedTaskDigests.push(taskDigest);
        for (const cell of [...baselineCells, ...candidateCells]) qualityIncludedCellKeys.add(cell.cellKey);
      }
      for (const cell of cells) {
        if (!qualityIncludedCellKeys.has(cell.cellKey)) qualityExcludedCellKeys.push(cell.cellKey);
      }
    }
    qualityExcludedCellKeys.sort(compareCodeUnitStrings);

    const costDiffs: ExactCostDifference[] = [];
    const costIncludedCellKeys = new Set<string>();
    let costUnit: string | undefined;
    for (const cells of byTask.values()) {
      const coordinates = new Map<number, RelevantCell[]>();
      for (const cell of cells) {
        const bucket = coordinates.get(cell.replicate) ?? [];
        bucket.push(cell);
        coordinates.set(cell.replicate, bucket);
      }
      for (const bucket of coordinates.values()) {
        const baselineCells = bucket.filter((cell) => cell.armId === baseline);
        const candidateCells = bucket.filter((cell) => cell.armId === candidate);
        if (baselineCells.length !== 1 || candidateCells.length !== 1) continue;
        const a = baselineCells[0]!;
        const b = candidateCells[0]!;
        if (a.value !== "pass" || b.value !== "pass" || a.cost === undefined || b.cost === undefined) {
          continue;
        }
        if (a.cost.unit !== b.cost.unit) {
          throw new MethodInputError("method-incompatible-cost-unit", a.cellKey, "both-solve pair uses different cost units");
        }
        if (costUnit !== undefined && costUnit !== a.cost.unit) {
          throw new MethodInputError("method-incompatible-cost-unit", a.cellKey, "included both-solve pairs must share one cost unit");
        }
        const aCost = parseExactDecimal(a.cost.value);
        const bCost = parseExactDecimal(b.cost.value);
        if (aCost === undefined || bCost === undefined) {
          throw new MethodInputError("method-incompatible-cost-unit", a.cellKey, "cost value is not an exact decimal");
        }
        costUnit = a.cost.unit;
        // Do not normalize within a pair. Equivalent decimal spellings must share the one
        // comparison-wide scale selected by pairedCostVerdict before ranks/ties are computed.
        const scale = aCost.scale > bCost.scale ? aCost.scale : bCost.scale;
        costDiffs.push({
          coefficient: scaleDecimal(bCost, scale) - scaleDecimal(aCost, scale),
          scale,
        });
        costIncludedCellKeys.add(a.cellKey);
        costIncludedCellKeys.add(b.cellKey);
      }
    }
    const costExcludedCellKeys = relevant
      .filter((cell) => !costIncludedCellKeys.has(cell.cellKey))
      .map((cell) => cell.cellKey)
      .sort(compareCodeUnitStrings);

    const clusteredRates = rates.map((rate, index) => {
        const provenance = resolveTaskProvenance(pairedTaskDigests[index]!, input);
        return {
          ...rate,
          taskDigest: pairedTaskDigests[index]!,
          cluster: [provenance.cluster.tag, provenance.cluster.value] as const,
        };
      });
    const clusterCount = new Set(clusteredRates.map((rate) => JSON.stringify(rate.cluster))).size;
    const clusterManifest = sourceClusterManifest(clusteredRates);
    const clusterBootstrap = clusteredRates.length > 0 && clusterCount >= 2
      ? clusteredPairedRateDiffBca(clusteredRates, { seed, resamples })
      : undefined;
    const options: NonInferiorityOptions = { seed, resamples, ...(clusterBootstrap === undefined ? {} : { lowerBound: clusterBootstrap.lowerBound }) };
    const quality = clusteredRates.length > 0 && clusterCount >= 2
      ? nonInferiorityVerdict(rates, options)
      : { verdict: "inconclusive" as const, lowerBound: null, deltaAbs: 0.05, relativeRegression: null, reasons: [clusteredRates.length === 0 ? "no paired tasks" : `fewer than two source clusters (got ${clusterCount})`] };
    const cost = pairedCostVerdict(costDiffs);
    return {
      verdictRule: input.verdictRule,
      baseline,
      candidate,
      verdict: nonInferiorityIut(quality, cost),
      pairing: { taskDigests: pairedTaskDigests },
      quality: {
        verdict: quality.verdict,
        lowerBound: quality.lowerBound === null ? null : fixed4(quality.lowerBound),
        relativeRegression: quality.relativeRegression === null ? null : fixed4(quality.relativeRegression),
        reasons: quality.reasons,
      },
      cost: {
        verdict: cost.verdict,
        pValue: cost.pValue === null ? null : fixed4(cost.pValue),
        n: cost.n,
        ...(cost.scale === undefined || cost.scale === 0n ? {} : { replay: {
          scale: cost.scale.toString(),
          differences: cost.differences!.map((difference) => difference.toString()),
        } }),
        excluded: { count: costExcludedCellKeys.length, cellKeys: costExcludedCellKeys },
      },
      excluded: {
        count: qualityExcludedCellKeys.length,
        cellKeys: qualityExcludedCellKeys,
      },
      conflicted: {
        count: conflictedCellKeys.length,
        cellKeys: conflictedCellKeys.sort(compareCodeUnitStrings),
      },
      bootstrap: clusterBootstrap === undefined
        ? {
            procedure: "xorshift32-v1", seed, resamples, basis: "task-provenance-source-family",
            count: clusterManifest.length, unit: "source-cluster", draws: 0, clusters: clusterManifest,
          }
        : {
            procedure: "xorshift32-v1", seed, resamples, basis: "task-provenance-source-family",
            count: clusterManifest.length, unit: clusterBootstrap.unit,
            draws: clusterBootstrap.draws, clusters: clusterManifest,
          },
    };
  },
};

const bradleyTerryMethod: SingleSubjectMethod = {
  ...METHOD_METADATA.bradleyTerry,
  id: BENCHMARKING_METHOD_IDS.bradleyTerry,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
};

// --- the registry -------------------------------------------------------------------------------

const SINGLE_SUBJECT_METHODS: readonly SingleSubjectMethod[] = [
  wilsonMethod,
  avgAtKMethod,
  passAtKMethod,
  pairedMcnemarMethod,
  nonInferiorityIutMethod,
  cleanSubsetMethod,
  bradleyTerryMethod,
];

function subjectScopedMethod(method: SingleSubjectMethod): Method {
  if (method.compute === undefined) {
    const { compute: _compute, ...declarativeMethod } = method;
    return declarativeMethod;
  }
  const compute = method.compute;
  return {
    ...method,
    compute(input) {
      const seen = new Set<string>();
      for (const subject of input.subjects) {
        if (!/^[a-f0-9]{64}$/.test(subject.subjectSha256)) {
          throw new Error(`method subjectSha256 is not an exact lowercase sha256: ${subject.subjectSha256}`);
        }
        const exactSha256 = sealMatrix(subject.matrix).digest.slice("sha256:".length);
        if (subject.subjectSha256 !== exactSha256) {
          throw new Error(
            `method subjectSha256 ${subject.subjectSha256} does not match canonical Matrix digest ${exactSha256}`,
          );
        }
        if (seen.has(subject.subjectSha256)) {
          throw new Error(`method subject identity is duplicated: ${subject.subjectSha256}`);
        }
        seen.add(subject.subjectSha256);
      }
      return {
        perSubject: input.subjects.map((subject) => {
          return {
            subjectSha256: subject.subjectSha256,
            results: compute({
              ...input,
              subjectSha256: subject.subjectSha256,
              matrices: [subject.matrix],
            }),
          };
        }),
      };
    },
  };
}

const METHODS: readonly Method[] = SINGLE_SUBJECT_METHODS.map(subjectScopedMethod);

/** The §9.2 method registry: URI + version identification over the seven registered methods
 * (six in the v1 reference set; `bradley-terry@1` registered but not part of it, §9.2). */
export function createMethodRegistry(): MethodRegistry {
  const byKey = new Map(METHODS.map((method) => [`${method.id}@${method.version}`, method]));
  return {
    get(id, version) {
      return byKey.get(`${id}@${version}`);
    },
  };
}

/** The complete v1 registry exposed to package consumers and packed integrations. */
export const BENCHMARKING_METHOD_REGISTRY: MethodRegistry = createMethodRegistry();
