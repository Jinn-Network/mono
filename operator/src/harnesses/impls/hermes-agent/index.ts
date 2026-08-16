// operator/src/harnesses/impls/hermes-agent/index.ts
export { HermesHarness } from './harness.js';
export { HermesHarnessAdapter } from './adapter.js';
export {
  hermesConfigFromSolverPlugins,
  type HermesConfigSnippet,
  type ConfigBuilderEnv,
  type McpServer,
} from './config-builder.js';
export { buildInitialPrompt } from './prompt.js';
export { writePerTaskHermesConfig } from './bootstrap.js';
