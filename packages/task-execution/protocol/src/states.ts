/** Derived Attempt states (§10.3). */
export const ATTEMPT_STATES = [
  "pending", "running", "delivered", "failed", "rejected", "cancelled",
  "expired", "lost",
] as const;

export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** Every state except the two non-terminal ones (§10.3). */
export const TERMINAL_STATES = ATTEMPT_STATES.filter(
  (state) => state !== "pending" && state !== "running",
);

/** The TES `EXECUTOR_ERROR`/`SYSTEM_ERROR` split on a `failed` terminal (§10.3). */
export type FailureBlame = "task" | "infrastructure";
