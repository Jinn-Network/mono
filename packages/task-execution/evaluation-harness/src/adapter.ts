// SPDX-License-Identifier: Apache-2.0

import type { ResourceDescriptorSchema } from "@jinn-network/evidence-protocol";
import type { EvaluationSpec } from "@jinn-network/task-execution-profiles";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";

export type EvaluationVerdict = "pass" | "fail" | "inconclusive";

export type ResourceDescriptor = ReturnType<
  (typeof ResourceDescriptorSchema)["parse"]
>;

export type EvaluationMeasurementValue = string | number | boolean | null;

export interface EvaluationMeasurement {
  readonly name: string;
  readonly value: EvaluationMeasurementValue;
  readonly unit?: string;
}

export interface ExactEvaluationMaterial {
  readonly descriptor: ResourceDescriptor;
  readonly bytes: Uint8Array;
}

export type EvaluationContext = Readonly<Record<string, unknown>>;

export type ClaimEvidence =
  | {
      readonly kind: "content";
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly mediaType?: string;
    }
  | {
      readonly kind: "descriptor";
      readonly descriptor: ResourceDescriptor;
    };

/**
 * One evaluator conclusion. Authority-bearing bindings deliberately do not appear here:
 * subjects, specification, method, evaluator identity, and signer all remain registration- or
 * harness-owned.
 */
export interface CompletedEvaluation {
  readonly detailedOutcome: unknown;
  readonly verdict: EvaluationVerdict;
  readonly evaluatedAt: string;
  readonly measurements?: readonly EvaluationMeasurement[];
  readonly explanation?: string;
  readonly limitations?: readonly string[];
  readonly claimEvidence?: readonly ClaimEvidence[];
  readonly evaluatorExecution?: ResourceDescriptor;
  readonly authenticatedEvaluatorContext?: unknown;
}

export interface EvaluatorAdapter {
  evaluate(
    task: ExactEvaluationMaterial,
    results: readonly ExactEvaluationMaterial[],
    specification: EvaluationSpec,
    context: EvaluationContext,
    attempt: AttemptIdentity,
    deadlineSignal: AbortSignal,
  ): Promise<CompletedEvaluation>;
}

export const EVALUATION_FAILURE_CODES = [
  "INVALID_ARGUMENT",
  "FAILED_PRECONDITION",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "RESOURCE_EXHAUSTED",
  "ABORTED",
  "UNAVAILABLE",
  "INTERNAL",
  "DATA_LOSS",
] as const;

export type EvaluationFailureCode = (typeof EVALUATION_FAILURE_CODES)[number];

export const EVALUATION_FAILURE_REASONS = [
  "unknown-evaluator-registration",
  "unsupported-specification",
  "subject-not-found",
  "subject-digest-mismatch",
  "invalid-evaluator-output",
  "provider-unavailable",
  "signing-failed",
  "claim-conformance-failed",
] as const;

export type EvaluationFailureReason =
  (typeof EVALUATION_FAILURE_REASONS)[number];

export const EVALUATION_RECOVERY_ADVICE = [
  "retry-step",
  "resume-attempt",
  "new-attempt-required",
  "operator-action-required",
  "do-not-retry",
] as const;

export type EvaluationRecoveryAdvice =
  (typeof EVALUATION_RECOVERY_ADVICE)[number];

export interface EvaluationOperationalErrorOptions {
  readonly canonicalCode: EvaluationFailureCode;
  readonly reason: EvaluationFailureReason;
  readonly recoveryAdvice: EvaluationRecoveryAdvice;
  readonly safeDetail: string;
  readonly cause?: unknown;
}

/**
 * Registry-symbol brand for `EvaluationOperationalError`. `Symbol.for` resolves through the
 * cross-realm global symbol registry, so this key is identical no matter how many copies of this
 * package are loaded.
 *
 * It exists because `instanceof` is NOT a sound test for this error. A deployment module is
 * imported by absolute URL (`runtime.ts`'s `deploymentFromEnvironment`) and resolves its own
 * dependency graph, so the adapter that throws routinely holds a DIFFERENT class object than the
 * runtime that catches -- the classic dual-package hazard, and exactly how a live operator runs a
 * deployment module. Live evidence (native gate round 25, 2026-08-12): a prediction adapter threw
 * `EvaluationOperationalError{safeDetail:"the evaluation context carries no resolutionSnapshot"}`,
 * `runtime.ts`'s `instanceof` said no, and the operator's only record of the refusal was
 * `evaluation-harness: refused (evaluation-operational-failure)` -- the reason, which the error
 * was carrying the whole time, never reached the log line, the attempt journal, or the audit row.
 */
export const EVALUATION_OPERATIONAL_ERROR_BRAND: unique symbol = Symbol.for(
  "jinn.task-execution.evaluation-operational-error.v1",
);

/** Typed no-verdict path for provider failure, invalid output, timeout, cancellation, or crash. */
export class EvaluationOperationalError extends Error {
  readonly canonicalCode: EvaluationFailureCode;
  readonly reason: EvaluationFailureReason;
  readonly recoveryAdvice: EvaluationRecoveryAdvice;
  readonly safeDetail: string;
  readonly [EVALUATION_OPERATIONAL_ERROR_BRAND] = true;

  constructor(options: EvaluationOperationalErrorOptions) {
    super(options.safeDetail, { cause: options.cause });
    this.name = "EvaluationOperationalError";
    this.canonicalCode = options.canonicalCode;
    this.reason = options.reason;
    this.recoveryAdvice = options.recoveryAdvice;
    this.safeDetail = options.safeDetail;
  }
}

/**
 * Brand-based recognition that survives the dual-package hazard `instanceof` does not. Use this
 * anywhere a caught value's operational detail is about to be read; `instanceof` there silently
 * discards the detail of every error thrown by a separately-resolved copy of this package.
 */
export function isEvaluationOperationalError(
  value: unknown,
): value is EvaluationOperationalError {
  return typeof value === "object"
    && value !== null
    && (value as Record<PropertyKey, unknown>)[EVALUATION_OPERATIONAL_ERROR_BRAND] === true
    && typeof (value as { readonly safeDetail?: unknown }).safeDetail === "string";
}

const AUTHORITY_OVERRIDE_FIELDS = [
  "subjects",
  "taskSubject",
  "resultSubjects",
  "evaluationSpecification",
  "evaluationMethod",
  "signer",
  "signingCapability",
  "repository",
  "publicationDestination",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    /(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value);
}

/**
 * Validates the method-neutral envelope before any authority-bearing fields are composed.
 * Registration-specific validators may refine `detailedOutcome` after this common check.
 */
export function validateCompletedEvaluation(
  untrusted: unknown,
): CompletedEvaluation {
  if (!isObject(untrusted)) {
    throw new EvaluationOperationalError({
      canonicalCode: "FAILED_PRECONDITION",
      reason: "invalid-evaluator-output",
      recoveryAdvice: "new-attempt-required",
      safeDetail: "CompletedEvaluation must be an object",
    });
  }

  for (const field of AUTHORITY_OVERRIDE_FIELDS) {
    if (Object.hasOwn(untrusted, field)) {
      throw new EvaluationOperationalError({
        canonicalCode: "FAILED_PRECONDITION",
        reason: "invalid-evaluator-output",
        recoveryAdvice: "new-attempt-required",
        safeDetail: `CompletedEvaluation must not contain ${field}`,
      });
    }
  }

  if (
    untrusted.verdict !== "pass" &&
    untrusted.verdict !== "fail" &&
    untrusted.verdict !== "inconclusive"
  ) {
    throw new EvaluationOperationalError({
      canonicalCode: "FAILED_PRECONDITION",
      reason: "invalid-evaluator-output",
      recoveryAdvice: "new-attempt-required",
      safeDetail: "CompletedEvaluation verdict is invalid",
    });
  }
  if (!validTimestamp(untrusted.evaluatedAt)) {
    throw new EvaluationOperationalError({
      canonicalCode: "FAILED_PRECONDITION",
      reason: "invalid-evaluator-output",
      recoveryAdvice: "new-attempt-required",
      safeDetail: "CompletedEvaluation evaluatedAt is invalid",
    });
  }
  if (!Object.hasOwn(untrusted, "detailedOutcome")) {
    throw new EvaluationOperationalError({
      canonicalCode: "FAILED_PRECONDITION",
      reason: "invalid-evaluator-output",
      recoveryAdvice: "new-attempt-required",
      safeDetail: "CompletedEvaluation detailedOutcome is required",
    });
  }

  return untrusted as unknown as CompletedEvaluation;
}
