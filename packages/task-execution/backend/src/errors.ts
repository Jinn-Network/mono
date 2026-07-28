import {
  isRetryable,
  type TaskExecutionErrorCategory,
} from "@jinn-network/task-execution-protocol";

/**
 * Operational errors are strictly disjoint from work outcomes (§13): a failed Attempt is a
 * *successful* `observe()` returning a terminal state; a `TaskExecutionError` is the operation
 * itself failing. The category vocabulary lives in `@jinn-network/task-execution-protocol`
 * (Global Constraints — no duplicate source of the enum); this class is the one place bindings
 * surface it.
 */
export class TaskExecutionError extends Error {
  readonly category: TaskExecutionErrorCategory;
  readonly retryable: boolean;
  readonly detail?: string;
  /** namespaced native annotations (binding-native identifiers ride here, §6.4/§13). */
  readonly annotations?: Readonly<Record<string, unknown>>;

  constructor(
    category: TaskExecutionErrorCategory,
    options?: { message?: string; detail?: string; retryable?: boolean; annotations?: Record<string, unknown> },
  ) {
    super(options?.message ?? category);
    this.name = "TaskExecutionError";
    this.category = category;
    this.retryable = options?.retryable ?? isRetryable(category);
    this.detail = options?.detail;
    this.annotations = options?.annotations;
  }
}
