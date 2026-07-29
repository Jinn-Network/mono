import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { materializeInput } from "./materialize.js";
import { harvest } from "./harvest.js";
import type { LaunchEnv, ProvisionerContract, WorkspacePaths } from "./contract.js";
import type { TaskView } from "./task-view.js";

export interface DirProvisionerOptions {
  readonly sealedTaskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly fetchInput?: (descriptor: ResourceDescriptor) => Promise<Uint8Array>;
  readonly quotaBytes?: number;
  readonly workTtlMs?: number;
  readonly diskFloorBytes?: number;
  readonly runtime: WorkspaceRuntimePorts;
}
export interface WorkspaceRuntimePorts {
  readonly assertHarnessGroupEmpty: (paths: WorkspacePaths) => Promise<void> | void;
  readonly ensureMetaReserve: (paths: WorkspacePaths) => Promise<void> | void;
  readonly startQuotaEnforcement?: (paths: WorkspacePaths, quotaBytes: number) => Promise<void> | void;
  readonly shouldEvictWork?: (paths: WorkspacePaths, policy: { workTtlMs: number; diskFloorBytes: number }) => Promise<boolean> | boolean;
}
export class ProvisioningRejectedError extends Error {
  readonly category = "rejected" as const;
  readonly neverExecuted = true as const;
  constructor(readonly reason: string, cause?: unknown) { super(`provisioning rejected: ${reason}`, { cause }); }
}

async function walkFiles(directory: string, prefix = ""): Promise<Array<{ path: string; digest: string }>> {
  const rows: Array<{ path: string; digest: string }> = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const child = join(directory, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(...await walkFiles(child, path));
    else if (entry.isFile()) rows.push({ path, digest: `sha256:${createHash("sha256").update(await readFile(child)).digest("hex")}` });
  }
  return rows;
}

async function sealInputAndSnapshot(paths: WorkspacePaths): Promise<void> {
  const rows = await walkFiles(paths.input);
  await writeFile(join(paths.meta, "input-manifest.json"), JSON.stringify(Object.fromEntries(rows.map((row) => [row.path, row.digest]))), { mode: 0o600 });
  async function lock(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) { await lock(child); await chmod(child, 0o500); }
      else await chmod(child, 0o400);
    }
  }
  await lock(paths.input);
  await chmod(paths.input, 0o500);
}

export function executionEnv(launch: LaunchEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set([
    "JINN_ATTEMPT_ID",
    "JINN_ATTEMPT_ROOT",
    "JINN_ATTEMPT_INPUT",
    "JINN_ATTEMPT_WORK",
    "JINN_ATTEMPT_OUT",
    "JINN_ATTEMPT_LOGS",
    "JINN_ATTEMPT_HARNESS_STATE",
    "JINN_ATTEMPT_SECRETS",
    "JINN_ATTEMPT_META",
    "JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE",
    "JINN_HARNESS_PIN_VERSION",
    "JINN_HARNESS_PIN_DIGEST",
    "JINN_LOADOUT_DIR",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HERMES_HOME",
    "TMPDIR",
    "OPENROUTER_API_KEY",
  ]);
  for (const [key, value] of Object.entries(launch.env)) {
    if (allowed.has(key)) result[key] = value;
  }
  return result;
}

export function makeDirProvisioner(options: DirProvisionerOptions): ProvisionerContract {
  return {
    workspaceKind: () => "dir",
    async setup(view: TaskView, paths: WorkspacePaths): Promise<void> {
      try {
        await mkdir(paths.root, { recursive: true });
        for (const path of [paths.input, paths.work, paths.out, paths.logs, paths.harnessState, paths.tmp, paths.meta]) await mkdir(path, { recursive: true });
        await mkdir(paths.secrets, { recursive: true, mode: 0o700 });
        await chmod(paths.secrets, 0o700);
        await options.runtime.ensureMetaReserve(paths);
        await writeFile(join(paths.input, "task.sealed"), options.sealedTaskBytes, { mode: 0o400 });
        await writeFile(join(paths.input, "dispatch-context.json"), options.dispatchContextBytes, { mode: 0o400 });
        for (const input of view.task.inputs ?? []) await materializeInput(input, paths.input, options.fetchInput ?? (async () => { throw new Error("input fetcher unavailable"); }));
        const loadout = ((view.effectiveRequirements ?? {}) as Record<string, unknown>).loadout;
        if (loadout !== undefined) await materializeInput(loadout as ResourceDescriptor, paths.input, options.fetchInput ?? (async () => { throw new Error("loadout fetcher unavailable"); }));
        await sealInputAndSnapshot(paths);
        if (options.quotaBytes !== undefined) {
          if (!options.runtime?.startQuotaEnforcement) throw new Error("quota requires startQuotaEnforcement runtime port");
          await options.runtime.startQuotaEnforcement(paths, options.quotaBytes);
        }
      } catch (error) {
        await rm(paths.secrets, { recursive: true, force: true }).catch(() => undefined);
        await rm(paths.tmp, { recursive: true, force: true }).catch(() => undefined);
        throw new ProvisioningRejectedError(error instanceof Error ? error.message : "setup-failed", error);
      }
    },
    executionEnv,
    async harvest(paths, outputs) {
      await options.runtime.assertHarnessGroupEmpty(paths);
      const result = await harvest(paths, outputs);
      await rm(paths.secrets, { recursive: true, force: true });
      await rm(paths.tmp, { recursive: true, force: true });
      const policy = { workTtlMs: options.workTtlMs ?? Number.MAX_SAFE_INTEGER, diskFloorBytes: options.diskFloorBytes ?? 0 };
      if (options.runtime.shouldEvictWork && await options.runtime.shouldEvictWork(paths, policy)) await rm(paths.work, { recursive: true, force: true });
      return result;
    },
  };
}
