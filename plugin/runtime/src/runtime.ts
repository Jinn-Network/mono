// SPDX-License-Identifier: Apache-2.0

import type { CapabilityContext, RuntimeCapability } from "./capability.js";
import type { RuntimeConfig } from "./config.js";
import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import { type HealthCheck, type HealthReport, normalizeHealthChecks, summarizeHealth } from "./health.js";
import { type RuntimeLogger, createSilentLogger } from "./logger.js";
import { describeUnknownError, isHealthInvalidError } from "./safe-error.js";
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

type RuntimeState = "idle" | "starting" | "running" | "stopping" | "cleanup-required";

function validateCapabilityConfiguration(capabilities: readonly RuntimeCapability[]): void {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability.name !== "string" || capability.name.trim() === "") {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.capabilityConfigurationInvalid,
        "capability name must be a non-empty string",
      );
    }
    if (seen.has(capability.name)) {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.capabilityConfigurationInvalid,
        `duplicate capability name: ${capability.name}`,
      );
    }
    seen.add(capability.name);
  }
}

function safeLogError(log: RuntimeLogger, message: string, fields: Record<string, unknown>): void {
  try {
    log.error(message, fields);
  } catch {
    // Diagnostic logging must never abort cleanup.
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

  let state: RuntimeState = "idle";
  const activeCapabilities: RuntimeCapability[] = [];
  let pendingCleanup: RuntimeCapability[] = [];
  const inFlightHealth = new Set<Promise<unknown>>();

  const registerHealthOperation = <T>(operation: Promise<T>): Promise<T> => {
    inFlightHealth.add(operation);
    return operation.finally(() => {
      inFlightHealth.delete(operation);
    });
  };

  const drainInFlightHealth = async (): Promise<void> => {
    while (inFlightHealth.size > 0) {
      await Promise.allSettled([...inFlightHealth]);
    }
  };

  const stopTargetsInReverse = async (targets: readonly RuntimeCapability[]): Promise<readonly string[]> => {
    const failures: string[] = [];
    for (let index = targets.length - 1; index >= 0; index -= 1) {
      const capability = targets[index] as RuntimeCapability;
      try {
        await capability.stop?.();
        const activeIndex = activeCapabilities.indexOf(capability);
        if (activeIndex >= 0) {
          activeCapabilities.splice(activeIndex, 1);
        }
        pendingCleanup = pendingCleanup.filter((entry) => entry !== capability);
      } catch (error) {
        failures.push(`${capability.name}: ${describeUnknownError(error)}`);
        safeLogError(log, "capability failed to stop", {
          capability: capability.name,
          reason: describeUnknownError(error),
        });
      }
    }
    return failures;
  };

  const enterCleanupRequired = (): void => {
    pendingCleanup = activeCapabilities.slice();
    state = "cleanup-required";
  };

  const failStart = async (
    capabilityName: string,
    error: unknown,
  ): Promise<never> => {
    const rollbackFailures = await stopTargetsInReverse(activeCapabilities.slice());
    if (rollbackFailures.length > 0 || activeCapabilities.length > 0) {
      enterCleanupRequired();
      const parts = [`capability ${capabilityName} failed to start: ${describeUnknownError(error)}`];
      if (rollbackFailures.length > 0) {
        parts.push(`rollback failures: ${rollbackFailures.join("; ")}`);
      }
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.capabilityStartFailed,
        parts.join("; "),
        { cause: error },
      );
    }
    state = "idle";
    throw new PluginRuntimeError(
      RUNTIME_ERROR_CODES.capabilityStartFailed,
      `capability ${capabilityName} failed to start: ${describeUnknownError(error)}`,
      { cause: error },
    );
  };

  return {
    async start(): Promise<void> {
      if (state === "running") {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.runtimeAlreadyStarted,
          "the runtime is already started",
        );
      }
      if (state === "cleanup-required") {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.runtimeCleanupRequired,
          "the runtime requires cleanup before it can start again",
        );
      }
      if (state === "starting" || state === "stopping") {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.runtimeBusy,
          "the runtime is busy with another lifecycle transition",
        );
      }

      validateCapabilityConfiguration(capabilities);
      state = "starting";

      try {
        for (const capability of capabilities) {
          try {
            if (capability.start !== undefined) await capability.start(context);
          } catch (error) {
            await failStart(capability.name, error);
          }
          activeCapabilities.push(capability);
        }

        try {
          log.debug("runtime started", { capabilities: capabilities.length });
        } catch (error) {
          await failStart("runtime", error);
        }

        state = "running";
      } catch (error) {
        if (state === "starting" && activeCapabilities.length > 0) {
          enterCleanupRequired();
        } else if (state === "starting") {
          state = "idle";
        }
        throw error;
      }
    },

    async health(): Promise<HealthReport> {
      if (state !== "running") {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.runtimeNotStarted,
          "the runtime must be started before it can report health",
        );
      }

      return registerHealthOperation((async () => {
        const checks: HealthCheck[] = [];
        for (const capability of capabilities) {
          if (capability.healthChecks === undefined) continue;
          try {
            checks.push(...normalizeHealthChecks(await capability.healthChecks()));
          } catch (error) {
            if (isHealthInvalidError(error)) {
              throw error;
            }
            checks.push({
              name: capability.name,
              ok: false,
              detail: `the capability could not report its health: ${describeUnknownError(error)}`,
              remedy: null,
            });
          }
        }
        return summarizeHealth(RUNTIME_VERSION, checks);
      })());
    },

    async stop(): Promise<void> {
      if (state === "idle") return;
      if (state === "starting" || state === "stopping") {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.runtimeBusy,
          "the runtime is busy with another lifecycle transition",
        );
      }

      const wasCleanupRequired = state === "cleanup-required";
      state = "stopping";
      await drainInFlightHealth();

      const targets = wasCleanupRequired
        ? pendingCleanup.slice()
        : activeCapabilities.slice();
      const failures = await stopTargetsInReverse(targets);

      try {
        log.debug("runtime stopped", {});
      } catch {
        // Diagnostic logging must never abort stop reporting.
      }

      if (failures.length > 0 || activeCapabilities.length > 0) {
        enterCleanupRequired();
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.capabilityStopFailed,
          failures.length > 0
            ? `capabilities failed to stop: ${failures.join("; ")}`
            : "capabilities remain active after stop",
        );
      }

      pendingCleanup = [];
      state = "idle";
    },
  };
}
