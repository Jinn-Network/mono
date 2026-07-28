export const TASK_EXECUTION_ERROR_CATEGORIES = [
  "invalid-document", "unsupported-profile", "unsupported-requirement",
  "unsupported-capability", "invalid-reference", "content-corruption",
  "access-denied", "submission-conflict", "attempt-not-found",
  "dependency-unavailable", "backend-unavailable", "operation-aborted",
  "deadline-exceeded", "transport-failure", "result-unavailable",
  "protocol-violation",
] as const;

export type TaskExecutionErrorCategory =
  (typeof TASK_EXECUTION_ERROR_CATEGORIES)[number];

// retryable defaults (§13 says each category carries a machine-readable flag;
// the flags themselves are a field-level refinement — pinned by errors.test.ts).
export const ERROR_RETRYABLE: Record<TaskExecutionErrorCategory, boolean> = {
  "invalid-document": false, "unsupported-profile": false,
  "unsupported-requirement": false, "unsupported-capability": false,
  "invalid-reference": false, "content-corruption": false,
  "access-denied": false, "submission-conflict": false,
  "attempt-not-found": false, "dependency-unavailable": true,
  "backend-unavailable": true, "operation-aborted": true,
  "deadline-exceeded": true, "transport-failure": true,
  "result-unavailable": false, "protocol-violation": false,
};

export function isRetryable(category: TaskExecutionErrorCategory): boolean {
  return ERROR_RETRYABLE[category];
}
