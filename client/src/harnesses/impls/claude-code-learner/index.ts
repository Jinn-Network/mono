/**
 * @jinn-network/client claude-code-learner harness impl.
 *
 * Bridges the engine's Harness interface to the claude-code-learner
 * plugin shipped at client/plugins/claude-code-learner/.
 *
 * Spec: docs/superpowers/specs/2026-04-23-default-learning-harness-design.md (v1.1)
 */

export type {
  HarnessAdapter,
  TaskSessionInputs,
  ClaudeCodeLearnerConfig,
} from './types.js';
export { ClaudeCodeLearnerImpl } from './harness.js';
export { resolvePluginRoot } from './plugin-path.js';
export { harvestOutput } from './harvest.js';
export { ClaudeCodeHarnessAdapter } from './adapters/claude-code.js';
export type { ClaudeCodeHarnessAdapterConfig } from './adapters/claude-code.js';
