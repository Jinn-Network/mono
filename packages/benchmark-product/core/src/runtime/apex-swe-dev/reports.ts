import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApexSweDevTaskType } from "./manifest.js";

export interface ApexSweDevHarnessReport {
  readonly taskId: string;
  readonly taskType: ApexSweDevTaskType;
  readonly passed: boolean;
}

export function integrationReportPath(reportRoot: string, taskId: string): string {
  return join(reportRoot, "integration", taskId, "results.json");
}

export function observabilityReportPath(reportRoot: string, taskId: string): string {
  return join(reportRoot, "observability", taskId, "results.json");
}

export function harnessReportPath(input: {
  readonly reportRoot: string;
  readonly taskId: string;
  readonly taskType: ApexSweDevTaskType;
}): string {
  return input.taskType === "integration"
    ? integrationReportPath(input.reportRoot, input.taskId)
    : observabilityReportPath(input.reportRoot, input.taskId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function booleanPassed(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return undefined;
}

function extractPassed(json: unknown, taskId: string): boolean | undefined {
  const record = asRecord(json);
  if (record === undefined) return undefined;
  const direct = booleanPassed(record.passed);
  if (direct !== undefined) return direct;
  const results = asRecord(record.results);
  if (results !== undefined) {
    const nested = booleanPassed(results.passed);
    if (nested !== undefined) return nested;
  }
  const score = asRecord(record.score);
  if (score !== undefined) {
    const nested = booleanPassed(score.passed);
    if (nested !== undefined) return nested;
  }
  const tasks = asRecord(record.tasks);
  if (tasks !== undefined) {
    const task = asRecord(tasks[taskId]);
    if (task !== undefined) {
      const nested = booleanPassed(task.passed);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function readHarnessReport(path: string, taskId: string, taskType: ApexSweDevTaskType): ApexSweDevHarnessReport | undefined {
  if (!existsSync(path)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(readFileSync(path)));
  } catch {
    return undefined;
  }
  const passed = extractPassed(json, taskId);
  if (passed === undefined) return undefined;
  return { taskId, taskType, passed };
}

export function harnessReportsPresent(input: {
  readonly reportRoot: string;
  readonly tasks: readonly { readonly taskId: string; readonly taskType: ApexSweDevTaskType }[];
}): boolean {
  if (input.tasks.length === 0) return false;
  return input.tasks.every((task) => {
    const path = harnessReportPath({ reportRoot: input.reportRoot, taskId: task.taskId, taskType: task.taskType });
    const report = readHarnessReport(path, task.taskId, task.taskType);
    return report !== undefined && report.taskId === task.taskId;
  });
}

export function mapHarnessReportToOutcome(path: string, taskId: string, taskType: ApexSweDevTaskType): "judged" | "unscorable" {
  return readHarnessReport(path, taskId, taskType) === undefined ? "unscorable" : "judged";
}
