/**
 * The `task-selection/v1` Run extension (issue #2980).
 *
 * Who chose the tasks changes what a headline number means as much as the number itself, and
 * before this declaration existed the answer lived in prose — where it appeared at all. The
 * declaration is a closed vocabulary sealed into the Run record, alongside the analysis plan it
 * qualifies, so it is fixed at the lock and cannot be chosen after the results are known.
 *
 * Two design constraints shaped the carrier, and both are worth stating because the obvious
 * alternative fails on them:
 *
 * - **Not the analysis plan's method `parameters`.** `benchmarking-aggregate`'s `produceReport`
 *   derives `preregistered` by exact-JSON equality between a method's own parameters tuple and the
 *   sealed plan entry, and each registered method refuses parameter keys outside its schema. A
 *   cross-method provenance field carried there would either break that equality or have to be
 *   admitted into every method's parameter schema — turning a fact about the run into part of
 *   every method's identity.
 * - **Namespaced, so it is additive.** `topLevelRecordSchema` admits reverse-DNS/absolute-URI keys,
 *   which is how `anchor-intent/v1` and `benchmark-publication/v1` already extend the Run without a
 *   protocol bump. A Run that declares nothing seals byte-identical bytes to before this existed.
 *
 * Absence stays legal, and readers are expected to say so out loud rather than omit the line:
 * silence is exactly how selection provenance used to hide.
 */

import { z } from "zod";
import { TASK_SELECTION_EXTENSION } from "./identifiers.js";

/**
 * The three answers, and deliberately only three.
 *
 * - `claimant-chosen` — the claimant picked the tasks. The blunt value; it carries no structural
 *   obligation precisely because obligations here would push claimants toward a stronger label.
 * - `fixed-public-set` — the tasks are a complete set that was already public before the lock.
 * - `drawn-post-lock` — the tasks were fixed by rule only after the run was locked.
 */
export const TASK_SELECTION_MODES = ["claimant-chosen", "fixed-public-set", "drawn-post-lock"] as const;

export type TaskSelectionMode = (typeof TASK_SELECTION_MODES)[number];

export const TaskSelectionModeSchema = z.enum(TASK_SELECTION_MODES);

/**
 * Strict on purpose, unlike `anchor-intent/v1`'s own plain object. Sealing preserves the raw
 * document, so an unrecognized key inside the declaration would ride in the sealed bytes while
 * every reader ignored it — two records claiming one declaration, which is the drift the
 * sealed-bytes discipline exists to prevent. An unknown key inside a namespaced extension is not
 * itself namespaced and has nowhere to acquire meaning, so refusing it costs nothing real.
 */
export const RunTaskSelectionExtensionSchema = z.strictObject({
  /** Who chose the tasks this run evaluates. */
  mode: TaskSelectionModeSchema,
});

export type RunTaskSelectionExtension = z.infer<typeof RunTaskSelectionExtensionSchema>;

type ExtensibleRecord = Record<string, unknown>;

/** Construct the typed namespaced Run extension. Throws on a declaration this schema refuses. */
export function runTaskSelectionExtension(value: unknown): RunTaskSelectionExtension {
  return RunTaskSelectionExtensionSchema.parse(value);
}

export function withRunTaskSelectionExtension<T extends ExtensibleRecord>(
  record: T,
  extension: RunTaskSelectionExtension,
): T & { [TASK_SELECTION_EXTENSION]: RunTaskSelectionExtension } {
  return {
    ...record,
    [TASK_SELECTION_EXTENSION]: runTaskSelectionExtension(extension),
  } as T & { [TASK_SELECTION_EXTENSION]: RunTaskSelectionExtension };
}

export function readRunTaskSelectionExtension(record: ExtensibleRecord): RunTaskSelectionExtension | undefined {
  const value = record[TASK_SELECTION_EXTENSION];
  return value === undefined ? undefined : runTaskSelectionExtension(value);
}

/** The declared mode, or `undefined` when the Run carries no declaration. */
export function readTaskSelectionMode(record: ExtensibleRecord): TaskSelectionMode | undefined {
  return readRunTaskSelectionExtension(record)?.mode;
}
