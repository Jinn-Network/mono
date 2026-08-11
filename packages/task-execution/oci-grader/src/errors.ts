// SPDX-License-Identifier: Apache-2.0

import { EvaluationOperationalError } from "@jinn-network/task-execution-evaluation-harness";

/**
 * A refusal: the specification, or the material it points at, cannot be graded by this source and
 * retrying will not change that. `do-not-retry` keeps a malformed specification out of the retry
 * loop, which is what makes the ungradeable classification honest.
 */
export function refuse(detail: string): never {
  throw new EvaluationOperationalError({
    canonicalCode: "FAILED_PRECONDITION",
    reason: "unsupported-specification",
    recoveryAdvice: "do-not-retry",
    safeDetail: `oci grader refusal: ${detail}`,
  });
}

/** The host or its container runtime could not serve this attempt. A fresh attempt may succeed. */
export function unavailable(detail: string, cause?: unknown): never {
  throw new EvaluationOperationalError({
    canonicalCode: "UNAVAILABLE",
    reason: "provider-unavailable",
    recoveryAdvice: "new-attempt-required",
    safeDetail: `oci grader unavailable: ${detail}`,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The specification's own timeout elapsed while the grader ran. */
export function deadlineExceeded(detail: string, cause?: unknown): never {
  throw new EvaluationOperationalError({
    canonicalCode: "DEADLINE_EXCEEDED",
    reason: "provider-unavailable",
    recoveryAdvice: "new-attempt-required",
    safeDetail: `oci grader deadline: ${detail}`,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** A declared subject's bytes do not match the digest the specification sealed. */
export function refuseSubjectDigest(detail: string): never {
  throw new EvaluationOperationalError({
    canonicalCode: "INVALID_ARGUMENT",
    reason: "subject-digest-mismatch",
    recoveryAdvice: "do-not-retry",
    safeDetail: `oci grader subject refusal: ${detail}`,
  });
}

/** The attempt's own deadline signal aborted before grading could run. A fresh attempt may work. */
export function cancelled(detail: string, cause?: unknown): never {
  throw new EvaluationOperationalError({
    canonicalCode: "CANCELLED",
    reason: "provider-unavailable",
    recoveryAdvice: "resume-attempt",
    safeDetail: `oci grader cancelled: ${detail}`,
    ...(cause === undefined ? {} : { cause }),
  });
}
