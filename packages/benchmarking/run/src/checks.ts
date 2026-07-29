import {
  compareCalendarStrictRfc3339Instants,
  serializeCanonicalJson,
  submissionExtensionBlock,
} from "@jinn-network/benchmarking-records";
import {
  checkVerdictConsistency,
  type EvaluationSpec,
  type MeasurementMap,
  type VerdictOutcome,
} from "@jinn-network/task-execution-profiles";
import type { JsonValue } from "@jinn-network/task-execution-protocol";
import type { PinningObservation } from "./ports.js";

export class CellCorrespondenceError extends Error {
  readonly check = "cell-correspondence" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "CellCorrespondenceError";
  }
}

/**
 * Byte-level map equality after JCS (§7.3 cell-correspondence / plan Task 4.3).
 * A tightened or loosened requirements map MUST be rejected before dispatch.
 */
export function assertCellCorrespondence(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): void {
  const expectedBytes = serializeCanonicalJson(expected as JsonValue);
  const actualBytes = serializeCanonicalJson(actual as JsonValue);
  if (expectedBytes.length !== actualBytes.length) {
    throw new CellCorrespondenceError(
      "cell-correspondence: requirements map byte length diverges from arm.pinning ∪ policy.submissionBaseline",
    );
  }
  for (let i = 0; i < expectedBytes.length; i += 1) {
    if (expectedBytes[i] !== actualBytes[i]) {
      throw new CellCorrespondenceError(
        "cell-correspondence: requirements map bytes diverge from arm.pinning ∪ policy.submissionBaseline",
      );
    }
  }
}

export function cellCorrespondenceHolds(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean {
  try {
    assertCellCorrespondence(expected, actual);
    return true;
  } catch {
    return false;
  }
}

/** Leg (a): structural — extension block commits to the preregistered Run digest. */
export function checkPreregistrationPrecedesDispatchLegA(input: {
  preregisteredRunDigest: `sha256:${string}`;
  cellKey: string;
  armId: string;
  extension: ReturnType<typeof submissionExtensionBlock>;
}): { ok: true } | { ok: false; check: "preregistration-precedes-dispatch"; detail: string } {
  const expected = submissionExtensionBlock(
    input.preregisteredRunDigest,
    input.cellKey,
    input.armId,
  );
  if (
    input.extension.run !== expected.run
    || input.extension.cellKey !== expected.cellKey
    || input.extension.armId !== expected.armId
  ) {
    return {
      ok: false,
      check: "preregistration-precedes-dispatch",
      detail: "leg (a): jinn.benchmarking/cell extension does not commit to the preregistered Run",
    };
  }
  return { ok: true };
}

/**
 * Leg (c): local append-order-only — Run appended before cells. Labeled non-decision-grade
 * (§12.2); still a named check surface for self-run venues.
 */
export function checkPreregistrationPrecedesDispatchLegC(input: {
  runAppendedBeforeCells: boolean;
}): { ok: true; decisionGrade: false } | { ok: false; check: "preregistration-precedes-dispatch"; detail: string; decisionGrade: false } {
  if (!input.runAppendedBeforeCells) {
    return {
      ok: false,
      check: "preregistration-precedes-dispatch",
      detail: "leg (c): Run was not appended before its cells in local append order",
      decisionGrade: false,
    };
  }
  return { ok: true, decisionGrade: false };
}

/** Anchored ordering helper used by leg (b) consumers (marketplace) and unit tests. */
export function checkPreregistrationAnchoredOrder(input: {
  runAnnouncedAt: string;
  earliestCellPostAt: string;
}): { ok: true } | { ok: false; check: "preregistration-precedes-dispatch"; detail: string } {
  const order = compareCalendarStrictRfc3339Instants(
    input.runAnnouncedAt,
    input.earliestCellPostAt,
  );
  if (order === undefined || order > 0) {
    return {
      ok: false,
      check: "preregistration-precedes-dispatch",
      detail: "anchored: Run announcement was not observed at/before earliest cell post",
    };
  }
  return { ok: true };
}

/** Pinning-observation: any mismatch axis fails the named check (§8.1 / §12.1). */
export function checkPinningObservation(
  observation: PinningObservation,
): { ok: true } | { ok: false; check: "pinning-observation"; detail: string } {
  const axes = ["harness", "model", "loadout", "isolation"] as const;
  const mismatched = axes.filter((axis) => observation[axis] === "mismatch");
  if (mismatched.length > 0) {
    return {
      ok: false,
      check: "pinning-observation",
      detail: `mismatch on ${mismatched.join(",")}`,
    };
  }
  return { ok: true };
}

/** Verdict-spec-match: exact evaluation-spec digest equality (profiles §7.7). */
export function checkVerdictSpecMatch(input: {
  verdictEvaluationSpecification: string | undefined;
  taskEvaluationSpecDigest: string | undefined;
}): { ok: true } | { ok: false; check: "verdict-spec-match"; detail: string } {
  const claimed = input.verdictEvaluationSpecification;
  const expected = input.taskEvaluationSpecDigest;
  if (expected === undefined) {
    if (claimed === undefined || !/^sha256:[a-f0-9]{64}$/.test(claimed)) {
      return {
        ok: false,
        check: "verdict-spec-match",
        detail: "verdict lacks a digest-shaped evaluationSpecification and task has no pinned digest",
      };
    }
    return { ok: true };
  }
  if (claimed !== expected) {
    return {
      ok: false,
      check: "verdict-spec-match",
      detail: `evaluationSpecification ${claimed ?? "<missing>"} !== task evaluation ${expected}`,
    };
  }
  return { ok: true };
}

/**
 * Profiles verdict consistency (checkVerdictConsistency / evaluateVerdictRule) when the host
 * supplies the EvaluationSpec body + measurements. Absent material fails closed.
 */
export function checkVerdictRuleConsistency(input: {
  spec: EvaluationSpec | undefined;
  delivered: VerdictOutcome | undefined;
  measurements: MeasurementMap | undefined;
  declaredUnscorableClass?: string;
}): { ok: true } | { ok: false; check: "verdict-consistency"; detail: string } {
  if (input.spec === undefined || input.delivered === undefined || input.measurements === undefined) {
    return {
      ok: false,
      check: "verdict-consistency",
      detail: "missing EvaluationSpec body, delivered verdict, or measurements for consistency",
    };
  }
  const result = checkVerdictConsistency({
    spec: input.spec,
    delivered: input.delivered,
    measurements: input.measurements,
    ...(input.declaredUnscorableClass === undefined
      ? {}
      : { declaredUnscorableClass: input.declaredUnscorableClass }),
  });
  if (!result.ok) {
    return { ok: false, check: "verdict-consistency", detail: result.reason };
  }
  return { ok: true };
}

/**
 * Evaluator-independence: both identities resolve through trust to Agent IRIs; fail-closed on
 * unresolved; distinct under gating (caller decides gating vs disclosed recording).
 */
export function checkEvaluatorIndependence(input: {
  solver: string | "unresolved";
  evaluator: string | "unresolved";
}): { ok: true } | { ok: false; check: "evaluator-independence"; detail: string } {
  if (input.solver === "unresolved" || input.evaluator === "unresolved") {
    return {
      ok: false,
      check: "evaluator-independence",
      detail: "solver or evaluator unresolved (fail-closed)",
    };
  }
  if (input.solver === input.evaluator) {
    return {
      ok: false,
      check: "evaluator-independence",
      detail: "evaluator Agent IRI is not distinct from solver",
    };
  }
  return { ok: true };
}
