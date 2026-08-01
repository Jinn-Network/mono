// SPDX-License-Identifier: Apache-2.0

export type { CapabilityContext, RuntimeCapability } from "./capability.js";
export {
  ENVIRONMENT_KEYS,
  RuntimeConfigFileSchema,
  resolveRuntimeConfig,
} from "./config.js";
export type { RuntimeConfig, RuntimeConfigFile, RuntimeConfigSource } from "./config.js";
export { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
export type { RuntimeErrorCode } from "./errors.js";
export { summarizeHealth } from "./health.js";
export type { HealthCheck, HealthReport } from "./health.js";
export { createLineLogger, createSilentLogger } from "./logger.js";
export type { LogLevel, RuntimeLogger } from "./logger.js";
export { createPluginRuntime } from "./runtime.js";
export type { PluginRuntime, PluginRuntimeOptions } from "./runtime.js";
export { RUNTIME_VERSION } from "./version.js";

// `bin.ts` is deliberately NOT re-exported: it reads the ambient environment, installs
// signal handlers, and runs on import as a process entry point. Re-exporting it would
// pull all three into every consumer.
