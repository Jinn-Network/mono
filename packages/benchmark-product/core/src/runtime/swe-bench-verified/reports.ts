import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SwebenchHarnessReport {
  readonly instanceId: string;
  readonly resolved: boolean;
}

/** Official layout: logs/run_evaluation/<run_id>/<model>/<instance_id>/report.json */
export function harnessReportPath(input: {
  readonly reportRoot: string;
  readonly runId: string;
  readonly modelNameOrPath: string;
  readonly instanceId: string;
}): string {
  return join(input.reportRoot, "logs", "run_evaluation", input.runId, input.modelNameOrPath, input.instanceId, "report.json");
}

export function readHarnessReport(path: string): SwebenchHarnessReport | undefined {
  if (!existsSync(path)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(readFileSync(path)));
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const record = json as Record<string, unknown>;
  const instanceId = typeof record.instance_id === "string" ? record.instance_id : undefined;
  const resolved = record.resolved === true || record.resolved === 1
    || (typeof record.resolved === "string" && record.resolved.toLowerCase() === "true");
  if (instanceId === undefined) return undefined;
  return { instanceId, resolved };
}

export function harnessReportsPresent(input: {
  readonly reportRoot: string;
  readonly runId: string;
  readonly modelNameOrPath: string;
  readonly instanceIds: readonly string[];
}): boolean {
  if (input.instanceIds.length === 0) return false;
  return input.instanceIds.every((instanceId) => {
    const path = harnessReportPath({ ...input, instanceId });
    const report = readHarnessReport(path);
    return report !== undefined && report.instanceId === instanceId;
  });
}
