import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import type { ProvisionerContract } from "./contract.js";
import { makeDirProvisioner, ProvisioningRejectedError, type DirProvisionerOptions } from "./dir-provisioner.js";

export interface WorktreeProvisionerOptions extends DirProvisionerOptions { readonly referenceRepository: string; readonly oid: string; }
async function git(args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`git ${args[0]} exited ${code}: ${stderr.trim()}`)));
  });
}
export function makeWorktreeProvisioner(options: WorktreeProvisionerOptions): ProvisionerContract {
  if (!/^[0-9a-f]{40}$/u.test(options.oid)) throw new TypeError("worktree oid must be exactly 40 lowercase hex characters");
  const base = makeDirProvisioner(options);
  return { ...base, workspaceKind: () => "worktree", async setup(view, paths, grants) {
    try {
      await base.setup(view, paths, grants);
      // Git requires a worktree destination that does not exist.
      await rm(paths.work, { recursive: true, force: true });
      await git(["-C", options.referenceRepository, "worktree", "add", "--detach", paths.work, options.oid]);
      const actual = await git(["-C", paths.work, "rev-parse", "HEAD"]);
      if (actual !== options.oid) throw new Error(`worktree resolved ${actual}, expected ${options.oid}`);
      const branch = await git(["-C", paths.work, "symbolic-ref", "-q", "HEAD"]).catch(() => "");
      if (branch !== "") throw new Error(`worktree is attached to ${branch}`);
    } catch (error) {
      await rm(paths.secrets, { recursive: true, force: true }).catch(() => undefined);
      await rm(paths.tmp, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ProvisioningRejectedError) throw error;
      throw new ProvisioningRejectedError(error instanceof Error ? error.message : "worktree-setup-failed", error);
    }
  }};
}

export function selectProvisioner(view: { profile: { profile: string } }, options: DirProvisionerOptions & Partial<Pick<WorktreeProvisionerOptions, "referenceRepository" | "oid">>): ProvisionerContract {
  return /repository|session/u.test(view.profile.profile) && options.referenceRepository && options.oid
    ? makeWorktreeProvisioner(options as WorktreeProvisionerOptions) : makeDirProvisioner(options);
}
