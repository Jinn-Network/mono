// @jinn-network/task-execution-workspace — public surface.
// Task A2: the `TaskView`/`WorkspacePaths`/`ProvisionerContract`/`WorkspaceKind` contract types
// (design §7/§8.1, frozen interfaces §14 items 7-8). The plain-dir and git-worktree
// provisioners, input materialization, harvest, and grant resolution land in Milestone B.
export type { TaskView } from "./task-view.js";
export {
  WORKSPACE_KINDS,
} from "./contract.js";
export type {
  CapabilityGrant,
  DeclaredOutputSlot,
  HarvestResult,
  IntegrityViolation,
  LaunchEnv,
  OutputArtifact,
  ProvisionerContract,
  WorkspaceKind,
  WorkspacePaths,
} from "./contract.js";
export { makeDirProvisioner } from "./dir-provisioner.js";
export { makeWorktreeProvisioner, selectProvisioner } from "./worktree-provisioner.js";
export { resolveGrantsToSecrets } from "./grants.js";
export { ContentCorruptionError, materializeInput } from "./materialize.js";
export { harvest } from "./harvest.js";
