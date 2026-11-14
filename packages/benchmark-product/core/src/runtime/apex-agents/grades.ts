import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { archipelagoGradesPresent as archipelagoGradesPresentInTree } from "@colophon-claims/check";
import { suiteEvidenceTreeFromDirectory } from "../suite-protocol/run-complete.js";

export interface ArchipelagoGrade {
  readonly taskId: string;
  readonly passed: boolean;
}

/** Official layout: output/<task_id>/grades.json */
export function archipelagoGradePath(input: {
  readonly reportRoot: string;
  readonly taskId: string;
}): string {
  return join(input.reportRoot, "output", input.taskId, "grades.json");
}

export function readArchipelagoGrade(path: string): ArchipelagoGrade | undefined {
  if (!existsSync(path)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(readFileSync(path)));
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const record = json as Record<string, unknown>;
  const taskId = typeof record.task_id === "string" ? record.task_id : undefined;
  if (taskId === undefined) return undefined;
  const passed = record.passed === true
    || record.final_score === 1
    || record.final_score === 1.0;
  return { taskId, passed };
}

/** Every selected task has an Archipelago grade naming it. The predicate is the checker's, which
 * re-derives the flag from the grades a bundle declaring `suite-comparability` carries
 * (issue #4762); this hands it the report root on the producing machine. */
export function archipelagoGradesPresent(input: {
  readonly reportRoot: string;
  readonly taskIds: readonly string[];
}): boolean {
  return archipelagoGradesPresentInTree({ tree: suiteEvidenceTreeFromDirectory(input.reportRoot), taskIds: input.taskIds });
}
