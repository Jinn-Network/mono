/** Shared per-arm Harbor Job directory, leadership, and observe-as-start mapping. */
import { existsSync, type Dirent, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cellKey } from "@jinn-network/benchmarking-records";
import { artifactsDir } from "../../workspace/layout.js";
import { recordHarborDispatchMapping } from "./dispatch-mapping.js";
import { harborTrialAttemptNumber, harborTrialTaskName } from "./manifest.js";
import {
  harborRetryGenerationTrialId,
  harborTrialRetryable,
  snapshotHarborTrial,
} from "./retry-bind.js";

export const HARBOR_ARM_WAIT_FILE = "harbor-arm-wait.json";

export type HarborArmWaitKind = "planned" | "follow-up" | "in-job-retry";

export interface HarborArmWait {
  readonly kind: HarborArmWaitKind;
  readonly jobRoot: string;
  readonly mappingPath: string;
  readonly snapshotRetryPath: string;
  readonly startedMarkerPath: string;
}

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

export async function waitForHarborArmReplacementGrain(input: {
  readonly plannedRoot: string;
  readonly mappingPath: string;
  readonly timeoutMs?: number;
}): Promise<"follow-up" | "in-job-retry"> {
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  for (;;) {
    if (existsSync(input.mappingPath)) return "in-job-retry";
    if (existsSync(join(input.plannedRoot, "result.json"))) return "follow-up";
    if (Date.now() >= deadline) throw new Error("timed out waiting to bind a Harbor replacement dispatch");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

async function harborJobFinished(jobRoot: string): Promise<boolean> {
  try {
    const result = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(join(jobRoot, "result.json")))) as {
      finished_at?: unknown;
    };
    return result.finished_at !== null;
  } catch {
    return false;
  }
}

async function jobMaxRetries(jobRoot: string): Promise<number> {
  try {
    const document = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(join(jobRoot, "config.json")))) as {
      retry?: { max_retries?: unknown };
    };
    return document.retry?.max_retries === 3 ? 3 : 0;
  } catch {
    return 0;
  }
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
  const presentMapped = new Map<string, { readonly slot: string; readonly generation: number; readonly cellKey: string; readonly configId: string }>();
  const slotGeneration = new Map<string, number>();
  const directoryAttempt = new Map<string, number>();
  const nextAttemptByTask = new Map<string, number>();
  const snapshotted = new Set<string>();
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  let jobResultSeen = false;
  while (Date.now() < deadline) {
    let entries: Dirent[] = [];
    try { entries = await readdir(input.jobRoot, { withFileTypes: true, encoding: "utf8" }); } catch { entries = []; }
    const present = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    for (const directory of [...presentMapped.keys()]) {
      if (!present.has(directory)) presentMapped.delete(directory);
    }
    const maxRetries = await jobMaxRetries(input.jobRoot);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const trialDir = join(input.jobRoot, entry.name);
      const configPath = join(trialDir, "config.json");
      if (!existsSync(configPath)) continue;
      let configId = "";
      try {
        const stats = statSync(configPath);
        configId = `${stats.ino}:${stats.mtimeMs}`;
      } catch { continue; }
      const previous = presentMapped.get(entry.name);
      if (previous !== undefined && previous.configId !== configId) presentMapped.delete(entry.name);
      let trial: Record<string, unknown>;
      try { trial = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(configPath))) as Record<string, unknown>; }
      catch { continue; }
      const name = harborTrialTaskName(trial);
      if (name.length === 0) continue;
      const explicitAttempt = harborTrialAttemptNumber(trial);
      let attempt: number;
      if (explicitAttempt !== undefined) attempt = explicitAttempt;
      else if (directoryAttempt.has(entry.name)) attempt = directoryAttempt.get(entry.name)!;
      else {
        attempt = (nextAttemptByTask.get(name) ?? 0) + 1;
        nextAttemptByTask.set(name, attempt);
        directoryAttempt.set(entry.name, attempt);
      }
      const slot = `${name}:${attempt}`;
      const mappedCellKey = cellKey(
        taskDigestForName(name, input.fallbackTaskDigest, input.taskNameByDigest),
        input.armId,
        attempt,
      );
      if (!presentMapped.has(entry.name)) {
        const generation = (slotGeneration.get(slot) ?? 0) + 1;
        slotGeneration.set(slot, generation);
        presentMapped.set(entry.name, { slot, generation, cellKey: mappedCellKey, configId });
        await recordHarborDispatchMapping(
          input.workspaceDir,
          harborArmMappingIdentity({
            selectionManifestSha256: input.selectionManifestSha256,
            runSha256: input.runSha256,
            cellKey: mappedCellKey,
            dispatch: generation,
          }),
          input.jobName,
          harborRetryGenerationTrialId(entry.name, generation),
        );
      }
      const mapped = presentMapped.get(entry.name);
      const resultPath = join(trialDir, "result.json");
      if (mapped !== undefined && existsSync(resultPath) && !snapshotted.has(`${mapped.slot}:${mapped.generation}`)) {
        try {
          const result = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(resultPath))) as Record<string, unknown>;
          if (harborTrialRetryable(result, maxRetries)) {
            await snapshotHarborTrial({
              workspaceDir: input.workspaceDir,
              runSha256: input.runSha256,
              cellKey: mapped.cellKey,
              dispatch: mapped.generation,
              trialDir,
              trialName: entry.name,
            });
            snapshotted.add(`${mapped.slot}:${mapped.generation}`);
          }
        } catch { /* result.json may still be mid-write */ }
      }
    }
    if (await harborJobFinished(input.jobRoot)) {
      if (jobResultSeen) return;
      jobResultSeen = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
