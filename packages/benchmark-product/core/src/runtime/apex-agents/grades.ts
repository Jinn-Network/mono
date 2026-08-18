import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

export function archipelagoGradesPresent(input: {
  readonly reportRoot: string;
  readonly taskIds: readonly string[];
}): boolean {
  if (input.taskIds.length === 0) return false;
  return input.taskIds.every((taskId) => {
    const report = readArchipelagoGrade(archipelagoGradePath({ reportRoot: input.reportRoot, taskId }));
    return report !== undefined && report.taskId === taskId;
  });
}
