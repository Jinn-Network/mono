// SPDX-License-Identifier: Apache-2.0

import {
  EvaluationOperationalError,
  type CompletedEvaluation,
  type EvaluationContext,
  type EvaluationMeasurement,
  type EvaluatorAdapter,
  type ExactEvaluationMaterial,
} from "@jinn-network/task-execution-evaluation-harness";
import type { EvaluationSpec } from "@jinn-network/task-execution-profiles";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { parsePredictionResult } from "./parse.js";

export const PREDICTION_MEASUREMENTS = Object.freeze({
  integrity: "integrity",
  resolved: "resolved",
  outcomeYes: "outcomeYes",
  solverBrier: "solverBrier",
  consensusBrier: "consensusBrier",
  brierSpread: "brierSpread",
} as const);

/**
 * The measurement vocabulary this adapter delivers. A specification that declares anything
 * else makes the harness runtime reject the evaluation, so the spec author consumes this.
 */
export function predictionEvaluationSpecMeasurements(): EvaluationSpec["measurements"] {
  return [
    { name: PREDICTION_MEASUREMENTS.integrity, type: "boolean", required: true },
    { name: PREDICTION_MEASUREMENTS.resolved, type: "boolean", required: true },
    { name: PREDICTION_MEASUREMENTS.outcomeYes, type: "boolean", required: false },
    { name: PREDICTION_MEASUREMENTS.solverBrier, type: "string", direction: "lower-better", required: false },
    { name: PREDICTION_MEASUREMENTS.consensusBrier, type: "string", required: false },
    { name: PREDICTION_MEASUREMENTS.brierSpread, type: "string", direction: "lower-better", required: false },
  ];
}

/**
 * The verdict rule the delivered measurements satisfy. The `inconclusiveWhen` predicate is
 * load-bearing: the harness runtime recomputes the rule and never forwards a declared
 * unscorable class (Finding C), so an unresolved market is expressible only this way.
 */
export function predictionEvaluationSpecVerdictRule(): EvaluationSpec["verdictRule"] {
  return {
    all: [
      { threshold: { measurement: PREDICTION_MEASUREMENTS.integrity, op: "eq", value: true } },
      {
        inconclusiveWhen: {
          threshold: { measurement: PREDICTION_MEASUREMENTS.resolved, op: "eq", value: false },
        },
        class: "market-unresolved",
      },
    ],
  };
}

export interface ResolutionSnapshotRequest {
  readonly specification: EvaluationSpec;
  readonly task: ExactEvaluationMaterial;
  readonly results: readonly ExactEvaluationMaterial[];
  readonly context: EvaluationContext;
  readonly attempt: AttemptIdentity;
  readonly deadlineSignal: AbortSignal;
}

export interface PredictionEvaluationInputs {
  readonly snapshot: unknown;
  readonly market: { readonly marketId: string; readonly conditionId: string };
  readonly window: { readonly startTs: number; readonly endTs: number };
  readonly consensusProbabilityYes: string;
}

/** The injected execution provider (evaluation-runner design §5.4). See Finding B. */
export interface ResolutionSnapshotSource {
  read(request: ResolutionSnapshotRequest): Promise<PredictionEvaluationInputs>;
}

function unavailable(detail: string): never {
  throw new EvaluationOperationalError({
    canonicalCode: "UNAVAILABLE",
    reason: "provider-unavailable",
    recoveryAdvice: "new-attempt-required",
    safeDetail: detail,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function contextResolutionSnapshotSource(): ResolutionSnapshotSource {
  return {
    async read({ context }) {
      const snapshot = context["resolutionSnapshot"];
      const market = context["market"];
      const window = context["window"];
      const consensusProbabilityYes = context["consensusProbabilityYes"];
      if (snapshot === undefined) {
        unavailable("the evaluation context carries no resolutionSnapshot");
      }
      if (
        !isObject(market) ||
        typeof market["marketId"] !== "string" ||
        typeof market["conditionId"] !== "string"
      ) {
        unavailable("the evaluation context carries no market identity");
      }
      if (
        !isObject(window) ||
        typeof window["startTs"] !== "number" ||
        typeof window["endTs"] !== "number"
      ) {
        unavailable("the evaluation context carries no submission window");
      }
      if (typeof consensusProbabilityYes !== "string") {
        unavailable("the evaluation context carries no consensus probability");
      }
      return {
        snapshot,
        market: {
          marketId: market["marketId"],
          conditionId: market["conditionId"],
        },
        window: { startTs: window["startTs"], endTs: window["endTs"] },
        consensusProbabilityYes,
      };
    },
  };
}

export interface PredictionAdapterOptions {
  readonly resolutionSnapshotSource: ResolutionSnapshotSource;
  readonly now?: () => Date;
}

export function createPredictionEvaluatorAdapter(
  options: PredictionAdapterOptions,
): EvaluatorAdapter {
  const now = options.now ?? (() => new Date());

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
          safeDetail: "the evaluation deadline elapsed before scoring began",
        });
      }
      if (specification.family !== "deterministic-process") {
        throw new EvaluationOperationalError({
          canonicalCode: "FAILED_PRECONDITION",
          reason: "unsupported-specification",
          recoveryAdvice: "do-not-retry",
          safeDetail:
            "the prediction evaluator serves deterministic-process specifications only",
        });
      }
      const [subject] = results;
      if (subject === undefined || results.length !== 1) {
        throw new EvaluationOperationalError({
          canonicalCode: "INVALID_ARGUMENT",
          reason: "subject-not-found",
          recoveryAdvice: "do-not-retry",
          safeDetail: "the prediction evaluator requires exactly one Result subject",
        });
      }

      const inputs = await options.resolutionSnapshotSource.read({
        specification,
        task,
        results,
        context,
        attempt,
        deadlineSignal,
      });
      const outcome = parsePredictionResult({
        resultBytes: subject.bytes,
        snapshot: inputs.snapshot,
        market: inputs.market,
        window: inputs.window,
        consensusProbabilityYes: inputs.consensusProbabilityYes,
      });

      const measurements: EvaluationMeasurement[] = [
        { name: PREDICTION_MEASUREMENTS.integrity, value: outcome.integrity },
        { name: PREDICTION_MEASUREMENTS.resolved, value: outcome.resolved },
      ];
      if (outcome.outcomeYes !== undefined) {
        measurements.push({
          name: PREDICTION_MEASUREMENTS.outcomeYes,
          value: outcome.outcomeYes,
        });
      }
      if (outcome.scores !== undefined) {
        measurements.push(
          { name: PREDICTION_MEASUREMENTS.solverBrier, value: outcome.scores.solverBrier },
          { name: PREDICTION_MEASUREMENTS.consensusBrier, value: outcome.scores.consensusBrier },
          { name: PREDICTION_MEASUREMENTS.brierSpread, value: outcome.scores.brierSpread },
        );
      }

      return {
        detailedOutcome: {
          checks: outcome.checks,
          ...(outcome.scores === undefined ? {} : { scores: outcome.scores }),
        },
        verdict: outcome.verdict,
        evaluatedAt: now().toISOString(),
        measurements,
        explanation: outcome.verdict === "inconclusive"
          ? "The market had not resolved when the evaluation ran."
          : outcome.verdict === "pass"
          ? "Every integrity check passed and the market resolved."
          : "At least one integrity check failed.",
        ...(outcome.verdict === "inconclusive"
          ? { limitations: ["market-unresolved"] }
          : {}),
      };
    },
  };
}
