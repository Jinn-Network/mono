/**
 * @jinn-network/client default-learner restorer impl.
 *
 * Bridges the engine's RestorerImpl interface to the default-learner
 * plugin shipped at client/plugins/default-learner/.
 *
 * Plan 2 ships shim + NoOp + Claude Code adapter. Not yet registered in
 * buildRestorerImpls — Plan 3 handles registry wiring.
 *
 * Spec: docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md (v1.1)
 */

export type {
  HarnessAdapter,
  IntentSessionInputs,
  DefaultLearningRestorerConfig,
} from './types.js';
export { DefaultLearningRestorerImpl } from './restorer.js';
export { resolvePluginRoot } from './plugin-path.js';
export { harvestOutput } from './harvest.js';
export { ClaudeCodeHarnessAdapter } from './adapters/claude-code.js';
export type { ClaudeCodeHarnessAdapterConfig } from './adapters/claude-code.js';
export { DefaultLearningWrapper, type DefaultLearningWrapperConfig } from './wrapper.js';
