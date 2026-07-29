import { BENCHMARKING_METHOD_IDS, BENCHMARKING_METHOD_VERSION, compareCodeUnitStrings } from "@jinn-network/benchmarking-records";
import { filterByCutoff } from "./clean-subset.js";
import { selectScorableCells, type CellRef } from "./exclusion.js";
import type { Method, MethodComputeInput, MethodRegistry, VerdictOutcome } from "./method.js";
import { fitBradleyTerry } from "./stats/bradley-terry.js";
import { nonInferiorityIut, nonInferiorityVerdict, pairedCostVerdict, type NonInferiorityOptions } from "./stats/noninferiority.js";
import { pairedMcnemar } from "./stats/paired-mcnemar.js";
import { avgAtOne, passAtK } from "./stats/pass-at-k.js";
import { wilsonInterval } from "./stats/wilson.js";
import { reduceValidVerdicts, type VerdictReduction } from "./verdict-rule.js";

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
// Neither is exercised by the kit's fixture-pinned method-conformance driver in this wave (the
// former needs a deterministic bootstrap seed threaded through a fixture; the latter is
// registered-but-not-in-the-v1-reference-set by design). Both are real, working Method
// implementations composed directly from the stats library — never a throwing stub — and are
// covered by this package's own registry.test.ts. See the package README.

const nonInferiorityIutMethod: Method = {
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
  id: BENCHMARKING_METHOD_IDS.bradleyTerry,
  version: BENCHMARKING_METHOD_VERSION,
  versionRobust: false,
  compute(input) {
    const { decisive } = reduceScoredCells(input);
    const wins = decisive
      .filter((cell) => cell.value === "pass")
      .map((cell) => ({ winner: cell.armId, loser: "baseline" }));
    const result = fitBradleyTerry(wins);
    return {
      strengths: Object.fromEntries(Object.entries(result.strengths).map(([armId, strength]) => [armId, fixed4(strength)])),
      converged: result.converged,
      iterations: result.iterations,
    };
  },
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
