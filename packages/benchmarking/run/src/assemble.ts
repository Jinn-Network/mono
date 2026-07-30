import {
  ASSEMBLY_PROCEDURE,
  ASSEMBLY_PROCEDURE_VERSION,
  BENCHMARKING_PROTOCOL,
  compareCodeUnitStrings,
  expectedCellSet,
  meetsExactDecimalFloor,
  parseMatrix,
  sealMatrix,
  sealRun,
  type BenchmarkRecord,
  type MatrixCell,
  type Outcome,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import {
  checkEvaluatorIndependence,
  checkPinningObservation,
  checkVerdictRuleConsistency,
  checkVerdictSpecMatch,
} from "./checks.js";
import type { AssemblyPorts, AssemblyProcedure, InScopeCell, InScopeVerdict } from "./ports.js";

export type AssembledMatrix = {
  record: ReturnType<typeof parseMatrix>;
  bytes: Uint8Array;
  digest: `sha256:${string}`;
};

function sortDigests(values: readonly string[]): string[] {
  return [...values].sort(compareCodeUnitStrings);
}

async function classifyVerdict(input: {
  verdict: InScopeVerdict;
  cell: InScopeCell;
  solver: string | "unresolved";
  evaluator: string | "unresolved";
  independence: "gating" | "disclosed";
}): Promise<{ valid: boolean; checksFailed: string[] }> {
  const checksFailed: string[] = [];
  const specMatch = checkVerdictSpecMatch({
    verdictEvaluationSpecification: input.verdict.record.evaluationSpecification,
    taskEvaluationSpecDigest: input.cell.evaluationSpecDigest,
  });
  if (!specMatch.ok) checksFailed.push(specMatch.check);

  // Fail-closed: every in-scope verdict considered for judged must structurally run
  // profiles checkVerdictConsistency. Missing EvaluationSpec or measurements ⇒ invalid.
  const consistency = checkVerdictRuleConsistency({
    spec: input.verdict.evaluationSpec ?? input.cell.evaluationSpec,
    delivered: input.verdict.delivered
      ?? (typeof input.verdict.record.verdict === "string"
        ? { verdict: input.verdict.record.verdict as "pass" | "fail" | "inconclusive" }
        : undefined),
    measurements: input.verdict.measurements,
    ...(input.verdict.declaredUnscorableClass === undefined
      ? {}
      : { declaredUnscorableClass: input.verdict.declaredUnscorableClass }),
  });
  if (!consistency.ok) checksFailed.push(consistency.check);

  const independence = checkEvaluatorIndependence({
    solver: input.solver,
    evaluator: input.evaluator,
  });
  if (!independence.ok) checksFailed.push(independence.check);

  const specOrConsistencyFailed = checksFailed.some(
    (check) => check === "verdict-spec-match" || check === "verdict-consistency",
  );
  const gatingBlocks = input.independence === "gating" && !independence.ok;
  return {
    valid: !specOrConsistencyFailed && !gatingBlocks,
    checksFailed,
  };
}

/**
 * Run-policy participant exclusion (program §7.4). Never trusts join-supplied exclusion flags.
 */
export function deriveParticipantExclusion(input: {
  run: RunRecord;
  arm: RunRecord["arms"][number];
  solver: string | "unresolved" | undefined;
}): { hit: boolean; reason: string } {
  const { run, arm, solver } = input;
  if (solver === undefined || solver === "unresolved") {
    return { hit: false, reason: "" };
  }
  const exclusions = run.policy.participantExclusions ?? [];
  if (exclusions.includes(solver)) {
    return { hit: true, reason: "policy.participantExclusions" };
  }
  const allowlist = arm.execution?.allowlist;
  if (allowlist !== undefined && allowlist.length > 0 && !allowlist.includes(solver)) {
    return { hit: true, reason: "arm.execution.allowlist" };
  }
  return { hit: false, reason: "" };
}

/**
 * Outcome derivation (§8.2). Precedence is exclusive: exclusion-hit → pinning mismatch →
 * ≥1 valid verdict → unscorable → delivery-without-valid-verdict → expired (incl. never-dispatched).
 */
export function deriveOutcome(input: {
  cell: InScopeCell;
  pinningFailed: boolean;
  validVerdicts: string[];
  exclusionHit?: boolean;
}): Outcome {
  const { cell, pinningFailed, validVerdicts, exclusionHit = false } = input;
  if (exclusionHit) return "excluded";
  if (pinningFailed) return "invalidated";
  if (validVerdicts.length > 0) return "judged";
  if (cell.evaluationTerminal === "could-not-grade") return "unscorable";
  if (cell.deliveryDigest !== undefined) return "unjudged";
  return "expired";
}

function emptyArmAttrition(expected: number) {
  return {
    expected,
    judged: 0,
    unjudged: 0,
    unscorable: 0,
    expired: 0,
    invalidated: 0,
    excluded: 0,
    replacements: 0,
  };
}

/**
 * Deterministic Matrix assembly (§8.3). Attempt URIs are read from in-scope cells — never
 * re-derived. Aggregation is out of scope (tenet 3).
 */
export async function assembleMatrix(
  bench: BenchmarkRecord,
  run: RunRecord,
  ports: AssemblyPorts,
  procedure: AssemblyProcedure = {
    procedure: ASSEMBLY_PROCEDURE,
    version: ASSEMBLY_PROCEDURE_VERSION,
  },
): Promise<AssembledMatrix> {
  const closeBoundary = await ports.closeBoundary.resolve(run);
  const effectiveTime = new Date(closeBoundary.at);
  const sealedRun = sealRun(run);
  const runDigest = sealedRun.digest;
  const expected = expectedCellSet(bench, run);
  const inScope = new Map<string, InScopeCell>();
  for await (const cell of ports.inputScope.submissionsForRun(runDigest)) {
    inScope.set(cell.cellKey, cell);
  }

  const cells: MatrixCell[] = [];
  const exclusions: { cellKey: string; reason: string }[] = [];
  const perArm: Record<string, ReturnType<typeof emptyArmAttrition>> = {};
  for (const arm of run.arms) {
    perArm[arm.armId] = emptyArmAttrition(bench.items.length * run.replicates);
  }

  for (const coord of expected) {
    const scoped = inScope.get(coord.cellKey);
    const cell: InScopeCell = scoped ?? {
      cellKey: coord.cellKey,
      armId: coord.armId,
      replicate: coord.replicate,
      taskDigest: coord.taskDigest,
      dispatches: 0,
      verdicts: [],
    };
    const arm = run.arms.find((candidate) => candidate.armId === coord.armId)!;
    const pinning = await ports.pinning.observe(
      cell.deliveryDigest ?? null,
      { cellKey: cell.cellKey, arm },
    );
    const pinningCheck = checkPinningObservation(pinning);
    const integrityTier = await ports.admission.tierFor(cell);
    const solverAtClose = cell.dispatches > 0
      ? await ports.trust.resolveAgent(
        { cellKey: cell.cellKey, role: "solver" },
        effectiveTime,
      )
      : undefined;
    const exclusion = deriveParticipantExclusion({ run, arm, solver: solverAtClose });
    const solver = solverAtClose === "unresolved" ? undefined : solverAtClose;

    const checksFailed = new Set<string>();
    if (!pinningCheck.ok) checksFailed.add(pinningCheck.check);

    const validVerdicts: string[] = [];
    let cellEvaluator: string | "unresolved" | undefined;
    for (const verdict of cell.verdicts) {
      const evaluator = await ports.trust.resolveAgent(
        {
          cellKey: cell.cellKey,
          role: "evaluator",
          claim: verdict.record.evaluator,
          verdictDigest: verdict.digest,
        },
        effectiveTime,
      );
      // Persist the first trust-resolved evaluator identity (or unresolved) on the cell.
      if (cellEvaluator === undefined) cellEvaluator = evaluator;
      const result = await classifyVerdict({
        verdict,
        cell,
        solver: solver ?? "unresolved",
        evaluator,
        independence: run.policy.independence,
      });
      for (const check of result.checksFailed) {
        if (check === "evaluator-independence") {
          if (run.policy.independence === "disclosed") checksFailed.add(check);
          continue;
        }
        checksFailed.add(check);
      }
      if (result.valid) validVerdicts.push(verdict.digest);
    }
    // Delivery without verdicts still surfaces canonical unresolved evaluator beside solver.
    if (cellEvaluator === undefined && solver !== undefined) {
      cellEvaluator = "unresolved";
    }

    const outcome = deriveOutcome({
      cell,
      pinningFailed: !pinningCheck.ok,
      validVerdicts,
      exclusionHit: exclusion.hit,
    });
    const cost = await ports.cost.costFor(cell);
    const latencyMs = await ports.cost.latencyFor(cell);
    const matrixCell: MatrixCell = {
      cellKey: cell.cellKey,
      taskDigest: cell.taskDigest,
      armId: cell.armId,
      replicate: cell.replicate,
      dispatches: cell.dispatches,
      ...(cell.dispatches > 0 ? { accounted: cell.accounted ?? cell.dispatches } : {}),
      ...(cell.submissionDigest !== undefined ? { submission: cell.submissionDigest } : {}),
      ...(cell.attempt !== undefined ? { attempt: cell.attempt } : {}),
      ...(cell.deliveryDigest !== undefined ? { delivery: cell.deliveryDigest } : {}),
      verdicts: sortDigests(cell.verdicts.map((verdict) => verdict.digest)),
      validVerdicts: sortDigests(validVerdicts),
      outcome,
      verification: {
        harness: pinning.harness,
        model: pinning.model,
        loadout: pinning.loadout,
        isolation: pinning.isolation,
        checksFailed: [...checksFailed].sort(compareCodeUnitStrings),
      },
      integrityTier,
      ...(solver !== undefined ? { solver } : {}),
      ...(cellEvaluator !== undefined ? { evaluator: cellEvaluator } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    };
    cells.push(matrixCell);
    const armStats = perArm[coord.armId]!;
    armStats[outcome] += 1;
    armStats.replacements += Math.max(0, cell.dispatches - 1);
    if (outcome === "excluded") {
      exclusions.push({
        cellKey: cell.cellKey,
        reason: exclusion.reason || "participant-exclusion",
      });
    }
  }

  const asymmetryFlags: string[] = [];
  const armIds = Object.keys(perArm).sort(compareCodeUnitStrings);
  if (armIds.length >= 2) {
    const nonJudged = armIds.map((armId) => {
      const stats = perArm[armId]!;
      return stats.unjudged + stats.unscorable + stats.expired + stats.invalidated + stats.excluded;
    });
    const replacements = armIds.map((armId) => perArm[armId]!.replacements);
    if (
      nonJudged.some((count) => count !== nonJudged[0])
      || replacements.some((count) => count !== replacements[0])
    ) {
      asymmetryFlags.push("nonjudged-arm-imbalance");
    }
  }

  const judged = cells.filter((cell) => cell.outcome === "judged").length;
  const excludedCount = cells.filter((cell) => cell.outcome === "excluded").length;
  const floorMet = meetsExactDecimalFloor(
    judged,
    cells.length - excludedCount,
    run.policy.completenessFloor,
  );
  const runCancelled = ports.inputScope.runCancelled === true;

  const sealed = sealMatrix({
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: runDigest.slice("sha256:".length) } },
    closeBoundary,
    cells,
    exclusions: exclusions.sort((left, right) => compareCodeUnitStrings(left.cellKey, right.cellKey)),
    attrition: {
      perArm,
      asymmetryFlags: asymmetryFlags.sort(compareCodeUnitStrings),
    },
    completeness: {
      expected: cells.length,
      judged,
      floor: run.policy.completenessFloor,
      runOutcome: runCancelled ? "cancelled" : floorMet ? "complete" : "partial",
    },
    assembly: procedure,
  });

  return {
    record: parseMatrix(sealed.bytes),
    bytes: sealed.bytes,
    digest: sealed.digest,
  };
}
