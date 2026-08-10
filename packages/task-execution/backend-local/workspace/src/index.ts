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
// #2538: the single source for the provisioned `input/` filenames. Launchers and every other
// reader of the staged Task import these instead of repeating a literal or globbing a pattern.
export {
  STAGED_DISPATCH_CONTEXT_FILENAME,
  STAGED_SEALED_TASK_FILENAME,
} from "./staged-input.js";
// #2538 F5: the backend's own capture of the harness's stdio — named here so the backend that
// writes it and the harvest that excludes it read the same two strings.
export {
  BACKEND_WRITTEN_LOG_FILENAMES,
  HARNESS_STDERR_LOG,
  HARNESS_STDOUT_LOG,
} from "./harness-logs.js";
export { makeDirProvisioner } from "./dir-provisioner.js";
export { ProvisioningRejectedError } from "./dir-provisioner.js";
export type { DirProvisionerOptions } from "./dir-provisioner.js";
export type { WorkspaceRuntimePorts } from "./dir-provisioner.js";
export { makeWorktreeProvisioner, selectProvisioner } from "./worktree-provisioner.js";
export { ContentCorruptionError, materializeInput, materializeLoadout } from "./materialize.js";
export { canonicalLoadoutPath, canonicalLoadoutPin, LOADOUT_KINDS } from "./loadout.js";
export type { CanonicalLoadoutPin, LoadoutKind } from "./loadout.js";
export {
  assertHarnessStatePackageMaterializable,
  hashHarnessStatePackage,
  hashMaterializedHarnessStateTree,
  HarnessStateHashProfileViolationError,
  HarnessStateMaterializationRefusedError,
  LEARNER_PUBLIC_V1_ALLOWED_DIRS,
  LEARNER_PUBLIC_V1_ALLOWED_FILES,
  LEARNER_PUBLIC_V1_EXCLUDED_ROOTS,
  writeHarnessStatePackage,
} from "./harness-state-package.js";
export type { HarnessStateTreeEntry } from "./harness-state-package.js";
export { toBareSha256Hex, toSha256Digest } from "./sha256-digest.js";
export { harvest } from "./harvest.js";
export { enforceWorkspaceQuota, WorkspaceQuotaExceededError } from "./quota.js";
