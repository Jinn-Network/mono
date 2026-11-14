// SPDX-License-Identifier: Apache-2.0

/**
 * Which task and attempt a Harbor 0.21 trial directory holds, read from its `config.json`.
 *
 * One rule, read by `run import --from harbor`, by the product core's orchestrated observer, and by
 * the `suite-comparability` re-derivation, which finds each judged cell's trial in an arm's
 * retained job by it (issue #5245). It moved here from the product core, which re-exports it,
 * because a reader re-derives the flag with it and this package cannot take an edge on core.
 */

function lastPathComponent(value: string): string {
  const trimmed = value.replace(/\/+$/u, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** Harbor 0.21 persists Trial config with exclude_defaults: no task.name, only path + trial_name. */
export function harborTrialTaskName(trial: Readonly<Record<string, unknown>>): string {
  const task = trial.task;
  if (typeof task === "object" && task !== null) {
    if ("name" in task && typeof task.name === "string" && task.name.length > 0) return lastPathComponent(task.name);
    if ("path" in task && typeof task.path === "string" && task.path.length > 0) return lastPathComponent(task.path);
  }
  if (typeof trial.task_name === "string" && trial.task_name.length > 0) return lastPathComponent(trial.task_name);
  if (typeof trial.trial_name === "string" && trial.trial_name.length > 0) {
    const cut = trial.trial_name.indexOf("__");
    return cut > 0 ? trial.trial_name.slice(0, cut) : trial.trial_name;
  }
  return "";
}

export function harborTrialAttemptNumber(trial: Readonly<Record<string, unknown>>): number | undefined {
  const value = trial.attempt_number ?? trial.attempt;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Harbor 0.21 often omits `attempt_number` (`exclude_defaults`). The orchestrated observer
 * (`arm-job.ts`) assigns the next per-task attempt on first sight of a trial directory and
 * reuses that assignment if the same directory is seen again. Import of a finished jobs dir
 * uses this same rule, meeting the directories in code-point order; it is not a second mapper.
 */
export function assignHarborTrialAttempt(input: {
  readonly trial: Readonly<Record<string, unknown>>;
  readonly directory: string;
  readonly nextAttemptByTask: Map<string, number>;
  readonly directoryAttempt: Map<string, number>;
}): { readonly taskName: string; readonly attempt: number } | undefined {
  const taskName = harborTrialTaskName(input.trial);
  if (taskName.length === 0) return undefined;
  const explicitAttempt = harborTrialAttemptNumber(input.trial);
  let attempt: number;
  if (explicitAttempt !== undefined) {
    attempt = explicitAttempt;
  } else if (input.directoryAttempt.has(input.directory)) {
    attempt = input.directoryAttempt.get(input.directory)!;
  } else {
    attempt = (input.nextAttemptByTask.get(taskName) ?? 0) + 1;
    input.nextAttemptByTask.set(taskName, attempt);
    input.directoryAttempt.set(input.directory, attempt);
  }
  return { taskName, attempt };
}
