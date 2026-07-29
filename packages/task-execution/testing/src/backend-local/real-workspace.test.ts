import { makeDirProvisioner, makeWorktreeProvisioner } from "@jinn-network/task-execution-workspace";
import { describeWorkspaceContract } from "./workspace-contract.js";

describeWorkspaceContract(() => makeDirProvisioner({ runtime: { assertHarnessGroupEmpty: () => undefined } }));
// The exact-OID worktree implementation shares the same provisioner contract; git integration
// cases are driven by workspace's own isolated filesystem tests.
describeWorkspaceContract(() => makeWorktreeProvisioner({ referenceRepository: "/tmp/jinn-reference", oid: "0".repeat(40), runtime: { assertHarnessGroupEmpty: () => undefined } }));
