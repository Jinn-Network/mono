import { BENCHMARKING_METHOD_IDS, BENCHMARKING_METHOD_VERSION, compareCodeUnitStrings } from "@jinn-network/benchmarking-records";
import { filterByCutoff } from "./clean-subset.js";
import { selectScorableCells, type CellRef } from "./exclusion.js";
import type { Method, MethodComputeInput, MethodRegistry, VerdictOutcome } from "./method.js";
import { nonInferiorityIut, nonInferiorityVerdict, pairedCostVerdict, type NonInferiorityOptions } from "./stats/noninferiority.js";
import { pairedMcnemar } from "./stats/paired-mcnemar.js";
import { avgAtOne, passAtK } from "./stats/pass-at-k.js";
import { wilsonInterval } from "./stats/wilson.js";
import { reduceValidVerdicts, type VerdictReduction } from "./verdict-rule.js";

type MethodMetadata = Omit<Method, "id" | "version" | "versionRobust" | "compute">;

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
    requiredInputs: ["matrix.cells", "matrix.cost", "referenced-verdicts"],
    parameterSchema: { type: "object", required: ["verdictRule", "baseline", "candidate", "seed", "resamples"], properties: { verdictRule: VERDICT_RULE_PROPERTY, baseline: { type: "string" }, candidate: { type: "string" }, seed: { type: "integer", minimum: 1 }, resamples: { type: "integer", minimum: 100 } }, additionalProperties: false },
    outputShape: "BCa quality lower bound AND one-sided paired-cost Wilcoxon + exclusions + conflicted cells",
    exclusionRule: "paired both-arm judged cells; cost only both-solve pairs; report remainder",
    clusteringRule: "task-provenance-source",
    referenceSet: "v1-reference",
    deterministic: true,
    resamplingProcedure: "xorshift32-v1; sample paired tasks with replacement; one uint32 draw per position; index=floor(uint32/2^32*n); BCa uses jackknife acceleration",
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

/** Every scored cell across all subject matrices, reduced to a decisive value (or dropped as
 * `conflicted`). Shared by every per-cell scoring method (§9.3 exclusion discipline, §9.2
 * verdictRule reduction). */
function reduceScoredCells(input: MethodComputeInput): { decisive: (CellRef & { value: "pass" | "fail" })[]; conflictedCellKeys: string[] } {
  const decisive: (CellRef & { value: "pass" | "fail" })[] = [];
  const conflictedCellKeys: string[] = [];
  for (const matrix of input.matrices) {
    const { scored } = selectScorableCells(matrix);
    for (const ref of scored) {
      const outcomes = ref.validVerdicts
        .map((digest) => input.resolveVerdict(digest))
        .filter((outcome): outcome is VerdictOutcome => outcome !== undefined);
      const reduction: VerdictReduction = reduceValidVerdicts(outcomes, input.verdictRule);
      if ("conflicted" in reduction) conflictedCellKeys.push(ref.cellKey);
      else decisive.push({ ...ref, value: reduction.value });
    }
  }
  conflictedCellKeys.sort(compareCodeUnitStrings);
  return { decisive, conflictedCellKeys };
}

// --- wilson@1 (design §9.2) ------------------------------------------------------------------

const wilsonMethod: Method = {
  ...METHOD_METADATA.wilson,
  id: BENCHMARKING_METHOD_IDS.wilson,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
  compute(input) {
    const { decisive, conflictedCellKeys } = reduceScoredCells(input);
    const perArm = new Map<string, { passed: number; scorable: number }>();
    for (const cell of decisive) {
      const bucket = perArm.get(cell.armId) ?? { passed: 0, scorable: 0 };
      bucket.scorable += 1;
      if (cell.value === "pass") bucket.passed += 1;
      perArm.set(cell.armId, bucket);
    }
    const arms: Record<string, unknown> = {};
    for (const armId of [...perArm.keys()].sort(compareCodeUnitStrings)) {
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

function perTaskReplicateCounts(input: MethodComputeInput): Map<string, { n: number; c: number }> {
  const { decisive } = reduceScoredCells(input);
  const perTask = new Map<string, { n: number; c: number }>();
  for (const cell of decisive) {
    const bucket = perTask.get(cell.taskDigest) ?? { n: 0, c: 0 };
    bucket.n += 1;
    if (cell.value === "pass") bucket.c += 1;
    perTask.set(cell.taskDigest, bucket);
  }
  return perTask;
}

const avgAtKMethod: Method = {
  ...METHOD_METADATA.avgAtK,
  id: BENCHMARKING_METHOD_IDS.avgAtK,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
  compute(input) {
    const perTask = perTaskReplicateCounts(input);
    const perTaskResults: Record<string, unknown> = {};
    let sum = 0;
    for (const taskDigest of [...perTask.keys()].sort(compareCodeUnitStrings)) {
      const { n, c } = perTask.get(taskDigest)!;
      const rate = avgAtOne(n, c);
      sum += rate;
      perTaskResults[taskDigest] = { n, c, avgRate: fixed4(rate) };
    }
    return {
      verdictRule: input.verdictRule,
      perTask: perTaskResults,
      mean: fixed4(perTask.size > 0 ? sum / perTask.size : 0),
    };
  },
};

const passAtKMethod: Method = {
  ...METHOD_METADATA.passAtK,
  id: BENCHMARKING_METHOD_IDS.passAtK,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
  compute(input) {
    const k = requireIntegerParam(input.parameters, "k");
    const perTask = perTaskReplicateCounts(input);
    const perTaskResults: Record<string, unknown> = {};
    let sum = 0;
    for (const taskDigest of [...perTask.keys()].sort(compareCodeUnitStrings)) {
      const { n, c } = perTask.get(taskDigest)!;
      const value = passAtK(n, c, k);
      sum += value;
      perTaskResults[taskDigest] = { n, c, passAtK: fixed4(value) };
    }
    return {
      verdictRule: input.verdictRule,
      k,
      perTask: perTaskResults,
      mean: fixed4(perTask.size > 0 ? sum / perTask.size : 0),
    };
  },
};

// --- paired-mcnemar@1 (design §9.2) ------------------------------------------------------------

const pairedMcnemarMethod: Method = {
  ...METHOD_METADATA.pairedMcnemar,
  id: BENCHMARKING_METHOD_IDS.pairedMcnemar,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: true,
  compute(input) {
    const baseline = requireStringParam(input.parameters, "baseline");
    const candidate = requireStringParam(input.parameters, "candidate");
    const { decisive, conflictedCellKeys } = reduceScoredCells(input);

    const byTaskArm = new Map<string, Map<string, { value: "pass" | "fail"; cellKey: string }>>();
    for (const cell of decisive) {
      if (cell.armId !== baseline && cell.armId !== candidate) continue;
      const perArm = byTaskArm.get(cell.taskDigest) ?? new Map();
      perArm.set(cell.armId, { value: cell.value, cellKey: cell.cellKey });
      byTaskArm.set(cell.taskDigest, perArm);
    }

    const outcomes: { taskDigest: string; baseline: "pass" | "fail"; candidate: "pass" | "fail" }[] = [];
    const excludedCellKeys: string[] = [...conflictedCellKeys];
    for (const taskDigest of [...byTaskArm.keys()].sort(compareCodeUnitStrings)) {
      const perArm = byTaskArm.get(taskDigest)!;
      const baselineCell = perArm.get(baseline);
      const candidateCell = perArm.get(candidate);
      if (baselineCell && candidateCell) {
        outcomes.push({ taskDigest, baseline: baselineCell.value, candidate: candidateCell.value });
      } else {
        if (baselineCell) excludedCellKeys.push(baselineCell.cellKey);
        if (candidateCell) excludedCellKeys.push(candidateCell.cellKey);
      }
    }
    excludedCellKeys.sort(compareCodeUnitStrings);

    const resolveClusterKey = input.resolveClusterKey;
    const result = pairedMcnemar(outcomes, resolveClusterKey);
    return {
      verdictRule: input.verdictRule,
      baseline,
      candidate,
      pairs: result.pairs,
      improved: result.improved,
      regressed: result.regressed,
      concordantPass: result.concordantPass,
      concordantFail: result.concordantFail,
      excluded: { count: excludedCellKeys.length, cellKeys: excludedCellKeys },
      pValue: fixed4(result.pValue),
      clustering: result.clustering,
      ...(result.clusteredPValue === undefined ? {} : { clusteredPValue: fixed4(result.clusteredPValue) }),
      ...(result.designEffect === undefined ? {} : { designEffect: fixed4(result.designEffect) }),
    };
  },
};

// --- clean-subset@1 (design §9.2) --------------------------------------------------------------

const cleanSubsetMethod: Method = {
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

    const allTaskDigests = [...new Set(input.matrices.flatMap((matrix) => matrix.cells.map((cell) => cell.taskDigest)))];
    const resolveTimestamp = input.resolveTaskTimestamp ?? (() => undefined);
    const { kept, excludedByPredicate } = filterByCutoff(allTaskDigests, cutoff, resolveTimestamp);
    const keptSet = new Set(kept);

    const filteredMatrices = input.matrices.map((matrix) => ({
      ...matrix,
      cells: matrix.cells.filter((cell) => keptSet.has(cell.taskDigest)),
    }));

    const delegateResults = delegateMethod.compute({
      ...input,
      matrices: filteredMatrices as typeof input.matrices,
      parameters: delegate.parameters ?? {},
    });

    return { basis, cutoff, kept: kept.length, excludedByPredicate: excludedByPredicate.length, delegate: delegateResults };
  },
};

// --- noninferiority-iut@1 and bradley-terry@1 (design §9.2) -----------------------------------
// noninferiority-iut is a v1 reference method. Bradley–Terry is registered for identity and
// discovery only: v1 has no frozen pairwise-judgment input record, so its declarative metadata
// truthfully marks compute unavailable.

const nonInferiorityIutMethod: Method = {
  ...METHOD_METADATA.noninferiorityIut,
  id: BENCHMARKING_METHOD_IDS.noninferiorityIut,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
  compute(input) {
    const baseline = requireStringParam(input.parameters, "baseline");
    const candidate = requireStringParam(input.parameters, "candidate");
    const stockBaseRate = input.parameters["stockBaseRate"];
    if (typeof stockBaseRate !== "number") throw new Error('method parameter "stockBaseRate" must be a number');
    if (input.rng === undefined) throw new Error("noninferiority-iut@1 requires MethodComputeInput.rng (bootstrap)");

    const { decisive } = reduceScoredCells(input);
    const byTaskArm = new Map<string, Map<string, "pass" | "fail">>();
    for (const cell of decisive) {
      if (cell.armId !== baseline && cell.armId !== candidate) continue;
      const perArm = byTaskArm.get(cell.taskDigest) ?? new Map();
      perArm.set(cell.armId, cell.value);
      byTaskArm.set(cell.taskDigest, perArm);
    }
    const rates: { pA: number; pB: number }[] = [];
    const costDiffs: number[] = [];
    for (const perArm of byTaskArm.values()) {
      const a = perArm.get(baseline);
      const b = perArm.get(candidate);
      if (a === undefined || b === undefined) continue;
      rates.push({ pA: a === "pass" ? 1 : 0, pB: b === "pass" ? 1 : 0 });
    }
    const costsParam = input.parameters["costDiffs"];
    if (Array.isArray(costsParam)) {
      for (const value of costsParam) if (typeof value === "number") costDiffs.push(value);
    }

    const options: NonInferiorityOptions = { rng: input.rng, stockBaseRate };
    const quality = rates.length > 0
      ? nonInferiorityVerdict(rates, options)
      : { verdict: "inconclusive" as const, lowerBound: null, deltaAbs: 0.05, relativeRegression: null, reasons: ["no paired tasks"] };
    const cost = pairedCostVerdict(costDiffs);
    return {
      verdict: nonInferiorityIut(quality, cost),
      quality: {
        verdict: quality.verdict,
        lowerBound: quality.lowerBound === null ? null : fixed4(quality.lowerBound),
        relativeRegression: quality.relativeRegression === null ? null : fixed4(quality.relativeRegression),
        reasons: quality.reasons,
      },
      cost: { verdict: cost.verdict, pValue: cost.pValue === null ? null : fixed4(cost.pValue), n: cost.n },
    };
  },
};

const bradleyTerryMethod: Method = {
  ...METHOD_METADATA.bradleyTerry,
  id: BENCHMARKING_METHOD_IDS.bradleyTerry,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
};

// --- the registry -------------------------------------------------------------------------------

const METHODS: readonly Method[] = [
  wilsonMethod,
  avgAtKMethod,
  passAtKMethod,
  pairedMcnemarMethod,
  nonInferiorityIutMethod,
  cleanSubsetMethod,
  bradleyTerryMethod,
];

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
