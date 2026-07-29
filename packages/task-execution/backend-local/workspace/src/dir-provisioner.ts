import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { resolveGrantsToSecrets } from "./grants.js";
import { materializeInput } from "./materialize.js";
import { harvest } from "./harvest.js";
import type { CapabilityGrant, LaunchEnv, ProvisionerContract, WorkspacePaths } from "./contract.js";
import type { TaskView } from "./task-view.js";

export interface DirProvisionerOptions {
  readonly sealedTaskBytes?: Uint8Array;
  readonly dispatchContextBytes?: Uint8Array;
  readonly fetchInput?: (descriptor: ResourceDescriptor) => Promise<Uint8Array>;
}

export function makeDirProvisioner(options: DirProvisionerOptions = {}): ProvisionerContract {
  return {
    workspaceKind: () => "dir",
    async setup(view: TaskView, paths: WorkspacePaths, grants: readonly CapabilityGrant[]): Promise<void> {
      await mkdir(paths.root, { recursive: true });
      for (const path of [paths.input, paths.work, paths.out, paths.logs, paths.harnessState, paths.tmp, paths.meta]) await mkdir(path, { recursive: true });
      await mkdir(paths.secrets, { recursive: true, mode: 0o700 });
      await chmod(paths.secrets, 0o700);
      if (options.sealedTaskBytes) await writeFile(join(paths.input, "task.sealed"), options.sealedTaskBytes, { mode: 0o400 });
      if (options.dispatchContextBytes) await writeFile(join(paths.input, "dispatch-context.json"), options.dispatchContextBytes, { mode: 0o400 });
      for (const input of view.task.inputs ?? []) await materializeInput(input, paths.input, options.fetchInput ?? (async () => { throw new Error("input fetcher unavailable"); }));
      await resolveGrantsToSecrets(grants, paths.secrets);
    },
    executionEnv(launch: LaunchEnv): Record<string, string> { return { ...launch.env }; },
    harvest,
  };
}
