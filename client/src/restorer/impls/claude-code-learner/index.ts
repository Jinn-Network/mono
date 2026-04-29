/**
 * @jinn-network/client claude-code-learner restorer impl.
 *
 * Bridges the engine's RestorerImpl interface to the claude-code-learner
 * plugin shipped at client/plugins/claude-code-learner/.
 *
 * Spec: docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md (v1.1)
 */

export type {
  HarnessAdapter,
  IntentSessionInputs,
  ClaudeCodeLearnerConfig,
} from './types.js';
export { ClaudeCodeLearnerImpl } from './restorer.js';
export { resolvePluginRoot } from './plugin-path.js';
export { harvestOutput } from './harvest.js';
export { ClaudeCodeHarnessAdapter } from './adapters/claude-code.js';
export type { ClaudeCodeHarnessAdapterConfig } from './adapters/claude-code.js';
export { ClaudeCodeLearnerWrapper, type ClaudeCodeLearnerWrapperConfig } from './wrapper.js';
