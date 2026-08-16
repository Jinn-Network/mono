/**
 * @jinn-network/client learner harness impl.
 *
 * Bridges the engine's Harness interface to the learner
 * plugin shipped at operator/plugins/learner/.
 *
 * Spec: docs/superpowers/specs/2026-04-23-default-learning-harness-design.md (v1.1)
 */

export type {
  HarnessAdapter,
  TaskSessionInputs,
  LearnerHarnessConfig,
} from './types.js';
export { LearnerHarness } from './harness.js';
export { resolvePluginRoot } from './plugin-path.js';
export { harvestOutput } from './harvest.js';
export { ClaudeCodeHarnessAdapter } from './adapters/claude-code.js';
export type { ClaudeCodeHarnessAdapterConfig } from './adapters/claude-code.js';
export { CodexCodeHarnessAdapter } from './adapters/codex-code.js';
export type { CodexCodeHarnessAdapterConfig } from './adapters/codex-code.js';
export {
  prepareCodexPluginWorkspace,
} from './adapters/codex-workspace.js';
export type {
  CodexMcpServerConfig,
  PreparedCodexWorkspace,
  PrepareCodexWorkspaceInput,
} from './adapters/codex-workspace.js';
