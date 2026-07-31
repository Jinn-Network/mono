// SPDX-License-Identifier: Apache-2.0

import type { CapabilityContext, RuntimeCapability } from "./capability.js";
import type { RuntimeConfig } from "./config.js";
import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import { type HealthCheck, type HealthReport, normalizeHealthChecks, summarizeHealth } from "./health.js";
import { type RuntimeLogger, createSilentLogger } from "./logger.js";
import { RUNTIME_VERSION } from "./version.js";

export interface PluginRuntimeOptions {
  readonly config: RuntimeConfig;
  readonly capabilities?: readonly RuntimeCapability[];
  readonly log?: RuntimeLogger;
}

export interface PluginRuntime {
  start(): Promise<void>;
  health(): Promise<HealthReport>;
  stop(): Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertUniqueNames(capabilities: readonly RuntimeCapability[]): void {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (seen.has(capability.name)) {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.capabilityStartFailed,
        `duplicate capability name: ${capability.name}`,
      );
    }
    seen.add(capability.name);
  }
}

/**
 * The capability container. It owns the lifecycle and nothing else: start in registration
 * order, stop in reverse, fold health checks in registration order.
 */
export function createPluginRuntime(options: PluginRuntimeOptions): PluginRuntime {
  const capabilities = [...(options.capabilities ?? [])];
  const log = options.log ?? createSilentLogger();
  const context: CapabilityContext = { config: options.config, log };

  let started = false;
  const running: RuntimeCapability[] = [];

  const stopRunning = async (): Promise<readonly string[]> => {
    const failures: string[] = [];
    while (running.length > 0) {
      const capability = running.pop() as RuntimeCapability;
      try {
        await capability.stop?.();
      } catch (error) {
        failures.push(`${capability.name}: ${describe(error)}`);
        log.error("capability failed to stop", {
          capability: capability.name,
          reason: describe(error),
        });
      }
    }
    return failures;
  };

  return {
    async start(): Promise<void> {
      if (started) {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.runtimeAlreadyStarted,
          "the runtime is already started",
        );
      }
      assertUniqueNames(capabilities);
      for (const capability of capabilities) {
        try {
          if (capability.start !== undefined) await capability.start(context);
        } catch (error) {
          await stopRunning();
          throw new PluginRuntimeError(
            RUNTIME_ERROR_CODES.capabilityStartFailed,
            `capability ${capability.name} failed to start: ${describe(error)}`,
            { cause: error },
          );
        }
        running.push(capability);
      }
      started = true;
      log.debug("runtime started", { capabilities: capabilities.length });
    },

    async health(): Promise<HealthReport> {
      if (!started) {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.runtimeNotStarted,
          "the runtime must be started before it can report health",
        );
      }
      const checks: HealthCheck[] = [];
      for (const capability of capabilities) {
        if (capability.healthChecks === undefined) continue;
        try {
          checks.push(...normalizeHealthChecks(await capability.healthChecks()));
        } catch (error) {
          if (error instanceof PluginRuntimeError && error.code === "health-invalid") {
            throw error;
          }
          checks.push({
            name: capability.name,
            ok: false,
            detail: `the capability could not report its health: ${describe(error)}`,
            remedy: null,
          });
        }
      }
      return summarizeHealth(RUNTIME_VERSION, checks);
    },

    async stop(): Promise<void> {
      if (!started) return;
      const failures = await stopRunning();
      started = false;
      log.debug("runtime stopped", {});
      if (failures.length > 0) {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.capabilityStopFailed,
          `capabilities failed to stop: ${failures.join("; ")}`,
        );
      }
    },
  };
}
