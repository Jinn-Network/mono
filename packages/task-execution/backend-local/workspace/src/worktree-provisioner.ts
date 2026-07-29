import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import type { ProvisionerContract } from "./contract.js";
import { makeDirProvisioner, type DirProvisionerOptions } from "./dir-provisioner.js";

export interface WorktreeProvisionerOptions extends DirProvisionerOptions { readonly referenceRepository: string; readonly oid: string; }
export function makeWorktreeProvisioner(options: WorktreeProvisionerOptions): ProvisionerContract {
  if (!/^[0-9a-f]{40}$/u.test(options.oid)) throw new TypeError("worktree oid must be exactly 40 lowercase hex characters");
  const base = makeDirProvisioner(options);
  return { ...base, workspaceKind: () => "worktree", async setup(view, paths, grants) {
    await base.setup(view, paths, grants);
    // base setup establishes the common directory contract, but git requires its worktree
    // destination not to exist; only the executor cwd is removed and recreated by git.
    await rm(paths.work, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["-C", options.referenceRepository, "worktree", "add", "--detach", paths.work, options.oid]);
      child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`git worktree add exited ${code}`)));
    });
  }};
}

export function selectProvisioner(view: { profile: { profile: string } }, options: DirProvisionerOptions & Partial<WorktreeProvisionerOptions>): ProvisionerContract {
  return /repository|session/u.test(view.profile.profile) && options.referenceRepository && options.oid
    ? makeWorktreeProvisioner(options as WorktreeProvisionerOptions) : makeDirProvisioner(options);
}
