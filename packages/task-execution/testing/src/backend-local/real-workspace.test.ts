import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enforceWorkspaceQuota, makeDirProvisioner, makeWorktreeProvisioner,
} from "@jinn-network/task-execution-workspace";
import {
  describeWorkspaceContract, type WorkspaceContractSubject, type WorkspaceScenarioOptions,
} from "./workspace-contract.js";

function runtime(options: WorkspaceScenarioOptions) {
  return {
    assertHarnessGroupEmpty: options.assertHarnessGroupEmpty,
    ensureMetaReserve: options.ensureMetaReserve ?? (() => undefined),
    startQuotaEnforcement: options.startQuotaEnforcement,
    shouldEvictWork: options.shouldEvictWork,
  };
}

const dir: WorkspaceContractSubject = {
  name: "plain-directory",
  kind: "dir",
  async make(options) {
    return {
      provisioner: makeDirProvisioner({
        ...options, runtime: runtime(options),
      }),
    };
  },
  enforceQuota: enforceWorkspaceQuota,
};

const worktree: WorkspaceContractSubject = {
  name: "detached-git-worktree",
  kind: "worktree",
  async make(options) {
    const repository = mkdtempSync(join(tmpdir(), "jinn-workspace-reference-"));
    execFileSync("git", ["init", "-q", repository]);
    writeFileSync(join(repository, "README.md"), "pinned\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=Jinn Test", "-c", "user.email=test@jinn.network", "commit", "-qm", "fixture"]);
    const oid = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return {
      provisioner: makeWorktreeProvisioner({
        ...options, runtime: runtime(options), referenceRepository: repository, oid,
      }),
      expectedOid: oid,
    };
  },
  enforceQuota: enforceWorkspaceQuota,
};

describeWorkspaceContract(dir);
describeWorkspaceContract(worktree);
