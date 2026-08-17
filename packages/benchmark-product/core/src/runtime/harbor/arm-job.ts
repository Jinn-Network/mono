/** Shared per-arm Harbor Job directory, leadership, and observe-as-start mapping. */
import { existsSync, type Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cellKey } from "@jinn-network/benchmarking-records";
import { artifactsDir } from "../../workspace/layout.js";
import { recordHarborDispatchMapping } from "./dispatch-mapping.js";

export function harborArmJobsDir(workspaceDir: string, runSha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(runSha256)) throw new TypeError("Harbor per-arm jobs directory requires a Run digest");
  return join(artifactsDir(workspaceDir), "harbor", "jobs", runSha256);
}

export function harborArmMappingIdentity(input: {
  readonly selectionManifestSha256: string;
  readonly runSha256: string;
  readonly cellKey: string;
  readonly dispatch: number;
}): string {
  if (!Number.isInteger(input.dispatch) || input.dispatch < 1) throw new TypeError("Harbor per-arm mapping requires a positive dispatch index");
  return `${input.selectionManifestSha256}:${input.runSha256}:${input.cellKey}:${input.dispatch}`;
}

export async function claimHarborArmJobLeadership(jobsDir: string, jobName: string): Promise<boolean> {
  await mkdir(jobsDir, { recursive: true });
  try {
    await writeFile(join(jobsDir, `${jobName}.leader`), "leader\n", { flag: "wx", mode: 0o600 });
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    return false;
  }
}

function trialTaskName(trial: Readonly<Record<string, unknown>>): string {
  const task = trial.task;
  if (typeof task === "object" && task !== null && "name" in task && typeof task.name === "string") return task.name;
  if (typeof trial.task_name === "string") return trial.task_name;
  return "";
}

function trialAttempt(trial: Readonly<Record<string, unknown>>): number {
  const value = trial.attempt_number ?? trial.attempt;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

function taskDigestForName(
  name: string,
  fallbackDigest: string,
  taskNameByDigest: Readonly<Record<string, string>> | undefined,
): string {
  if (taskNameByDigest !== undefined) {
    const match = Object.entries(taskNameByDigest).find(([, taskName]) => taskName === name);
    if (match !== undefined) return match[0]!;
  }
  return fallbackDigest;
}

export async function observeHarborArmTrials(input: {
  readonly workspaceDir: string;
  readonly selectionManifestSha256: string;
  readonly runSha256: string;
  readonly armId: string;
  readonly jobName: string;
  readonly jobRoot: string;
  readonly fallbackTaskDigest: string;
  readonly taskNameByDigest?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}): Promise<void> {
  const seen = new Set<string>();
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    let entries: Dirent[] = [];
    try { entries = await readdir(input.jobRoot, { withFileTypes: true, encoding: "utf8" }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const configPath = join(input.jobRoot, entry.name, "config.json");
      if (!existsSync(configPath)) continue;
      let trial: Record<string, unknown>;
      try { trial = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(configPath))) as Record<string, unknown>; }
      catch { continue; }
      const name = trialTaskName(trial);
      if (name.length === 0) continue;
      const mappedCellKey = cellKey(
        taskDigestForName(name, input.fallbackTaskDigest, input.taskNameByDigest),
        input.armId,
        trialAttempt(trial),
      );
      await recordHarborDispatchMapping(
        input.workspaceDir,
        harborArmMappingIdentity({
          selectionManifestSha256: input.selectionManifestSha256,
          runSha256: input.runSha256,
          cellKey: mappedCellKey,
          dispatch: 1,
        }),
        input.jobName,
        entry.name,
      );
      seen.add(entry.name);
    }
    if (existsSync(join(input.jobRoot, "result.json"))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
