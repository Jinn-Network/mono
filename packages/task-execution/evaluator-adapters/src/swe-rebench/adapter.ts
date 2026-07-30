// SPDX-License-Identifier: Apache-2.0

import {
  EvaluationOperationalError,
  type CompletedEvaluation,
  type EvaluationContext,
  type EvaluatorAdapter,
  type ExactEvaluationMaterial,
} from "@jinn-network/task-execution-evaluation-harness";
import type {
  DeterministicProcessBlock,
  EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { parseSweRebenchReport } from "./parse.js";

/** The one measurement the canonical swe-rebench EvaluationSpec declares (Finding D). */
export const SWE_REBENCH_MEASUREMENT_PASSED = "passed";

/** Legacy tail cap: the pytest summary and last failures live at the end of the log. */
const DEFAULT_MAX_TEST_LOG_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

export interface GraderReportRequest {
  readonly specification: EvaluationSpec;
  readonly task: ExactEvaluationMaterial;
  readonly results: readonly ExactEvaluationMaterial[];
  readonly context: EvaluationContext;
  readonly attempt: AttemptIdentity;
  readonly deadlineSignal: AbortSignal;
}

export interface RawGraderReport {
  readonly report: unknown;
  readonly log: string;
}

/**
 * The method-specific execution provider the adapter is constructed with (evaluation-runner
 * design §5.4/§11). This package ships only the hermetic context-backed implementation;
 * a container-executing source is host or separately-chartered work (Finding A).
 */
export interface GraderReportSource {
  read(request: GraderReportRequest): Promise<RawGraderReport>;
}

function unavailable(detail: string, cause?: unknown): never {
  throw new EvaluationOperationalError({
    canonicalCode: "UNAVAILABLE",
    reason: "provider-unavailable",
    recoveryAdvice: "new-attempt-required",
    safeDetail: detail,
    cause,
  });
}

/** Reads an already-produced grader report from the harness-supplied evaluation context. */
export function contextGraderReportSource(): GraderReportSource {
  return {
    async read({ context }) {
      const report = context["graderReport"];
      if (report === undefined) {
        unavailable(
          "the evaluation context carries no graderReport for the swe-rebench parser",
        );
      }
      const log = context["graderLog"];
      if (log !== undefined && typeof log !== "string") {
        unavailable("the evaluation context graderLog is not text");
      }
      return { report, log: typeof log === "string" ? log : "" };
    },
  };
}

export interface SweRebenchAdapterOptions {
  readonly graderReportSource: GraderReportSource;
  readonly now?: () => Date;
  readonly maxTestLogBytes?: number;
}

function tailCap(log: string, maxBytes: number): Uint8Array {
  const bytes = encoder.encode(log);
  if (bytes.byteLength <= maxBytes) return bytes;
  return bytes.slice(bytes.byteLength - maxBytes);
}

export function createSweRebenchEvaluatorAdapter(
  options: SweRebenchAdapterOptions,
): EvaluatorAdapter {
  const now = options.now ?? (() => new Date());
  const maxTestLogBytes = options.maxTestLogBytes ?? DEFAULT_MAX_TEST_LOG_BYTES;

  return {
    async evaluate(
      task,
      results,
      specification,
      context,
      attempt,
      deadlineSignal,
    ): Promise<CompletedEvaluation> {
      if (deadlineSignal.aborted) {
        throw new EvaluationOperationalError({
          canonicalCode: "CANCELLED",
          reason: "provider-unavailable",
          recoveryAdvice: "resume-attempt",
          safeDetail: "the evaluation deadline elapsed before grading began",
        });
      }
      if (specification.family !== "deterministic-process") {
        throw new EvaluationOperationalError({
          canonicalCode: "FAILED_PRECONDITION",
          reason: "unsupported-specification",
          recoveryAdvice: "do-not-retry",
          safeDetail:
            "the swe-rebench evaluator serves deterministic-process specifications only",
        });
      }
      const block = specification.familyBlock as DeterministicProcessBlock;
      const raw = await options.graderReportSource.read({
        specification,
        task,
        results,
        context,
        attempt,
        deadlineSignal,
      });
      const outcome = parseSweRebenchReport({
        report: raw.report,
        log: raw.log,
        transitions: {
          failToPass: block.transitions.failToPass,
          passToPass: block.transitions.passToPass,
        },
      });

      if (outcome.kind === "ungradeable") {
        // Never a failing verdict: nothing was learned about the solution.
        throw new EvaluationOperationalError({
          canonicalCode: "UNAVAILABLE",
          reason: "provider-unavailable",
          recoveryAdvice: "new-attempt-required",
          safeDetail:
            `the swe-rebench evaluation could not grade the solution (${outcome.ungradeableClass})`,
          cause: undefined,
        });
      }

      return {
        detailedOutcome: {
          instanceId: outcome.instanceId,
          checks: outcome.checks,
          failToPassExpected: outcome.failToPassExpected,
          failToPassSatisfied: outcome.failToPassSatisfied,
          passToPassExpected: outcome.passToPassExpected,
          passToPassBroken: outcome.passToPassBroken,
          containerExitCode: outcome.containerExitCode,
        },
        verdict: outcome.passed ? "pass" : "fail",
        evaluatedAt: now().toISOString(),
        measurements: [
          { name: SWE_REBENCH_MEASUREMENT_PASSED, value: outcome.passed },
        ],
        explanation: outcome.passed
          ? "Every declared fail-to-pass transition now passes and no declared pass-to-pass transition broke."
          : "At least one declared transition did not hold.",
        claimEvidence: [{
          kind: "content",
          name: "test-log.txt",
          bytes: tailCap(raw.log, maxTestLogBytes),
          mediaType: "text/plain; charset=utf-8",
        }],
      };
    },
  };
}
