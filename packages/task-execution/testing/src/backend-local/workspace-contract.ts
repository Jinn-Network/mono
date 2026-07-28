// SPDX-License-Identifier: Apache-2.0

import type { ProvisionerContract, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { describe, expect, test } from "vitest";
import { loadWorkspaceFixture } from "./fixtures.js";
import { makeSampleLauncherInputs } from "./launcher-contract.js";

/**
 * The Workspace Provisioner conformance suite (design §7, frozen interface §14 item 7). Landed
 * as a skeleton in Milestone A (Task A3), asserting the fixtures parse and are well-formed;
 * `makeProvisioner` is typed against the real `ProvisionerContract` (A2) but never invoked here
 * — Milestone B (Task B1) supplies the plain-dir and git-worktree provisioners and drives this
 * suite for real (per-directory retention, secrets/tmp wipe, input immutability, rejected
 * never-executed, symlink-guarded harvest, quota, env discipline, no-secrets-in-meta).
 */
export function describeWorkspaceContract(makeProvisioner: () => ProvisionerContract): void {
  describe("ProvisionerContract conformance (design §7, frozen interface §14 item 7)", () => {
    test("the workspace fixture family is well-formed and covers every §16 scenario", async () => {
      const fixture = await loadWorkspaceFixture();
      const expectedScenarios = [
        "per-directory-retention",
        "secrets-and-tmp-wiped-at-terminal",
        "input-immutability-violation-detected",
        "rejected-never-executed-guarantee",
        "symlink-in-out-escaping-tree-rejected",
        "per-attempt-quota-breach",
        "spawn-time-env-discipline",
        "no-secrets-in-meta-grep",
      ];
      const names = fixture.scenarios.map((scenario) => scenario.name);
      for (const expected of expectedScenarios) {
        expect(names, `workspace fixture must cover "${expected}"`).toContain(expected);
      }
    });

    test("workspaceKind() is callable against a real TaskView shape (seam for Milestone B)", () => {
      const provisioner = makeProvisioner();
      const { view } = makeSampleLauncherInputs();
      const kind = provisioner.workspaceKind(view);
      expect(["dir", "worktree"]).toContain(kind);
    });

    test("executionEnv() derives a plain env record from a LaunchEnv-shaped input (seam for Milestone B)", () => {
      const provisioner = makeProvisioner();
      const paths: WorkspacePaths = makeSampleLauncherInputs().paths;
      const env = provisioner.executionEnv({ env: { FOO: "bar" }, cwd: paths.work });
      expect(typeof env).toBe("object");
    });
  });
}
