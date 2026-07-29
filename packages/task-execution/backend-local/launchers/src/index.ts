// @jinn-network/task-execution-launchers — public surface.
// Task A2: the `LaunchPlan`/`LauncherContract`/`LauncherCapabilities`/`BlameRule`/
// `ResultContract` contract types (design §8.1, frozen interfaces §14 items 8-9). The v1
// launchers (claude-code, codex, hermes, cursor) land in Milestone B.
export {
  INTERRUPTION_BEHAVIORS,
  RUN_PINNING_ENFORCEMENT_POSTURES,
} from "./contract.js";
export { claudeCodeLauncher } from "./claude-code.js";
export { codexLauncher } from "./codex.js";
export { hermesLauncher } from "./hermes.js";
export { cursorLauncher } from "./cursor.js";
export { interpretResult } from "./result.js";
export type { InterpretedResult } from "./result.js";
export type {
  BlameRule,
  InterruptionBehavior,
  LaunchPlan,
  LauncherCapabilities,
  LauncherContract,
  LauncherRunPinningKeySupport,
  ProbeResult,
  ResultContract,
  RunPinningEnforcementPosture,
} from "./contract.js";
