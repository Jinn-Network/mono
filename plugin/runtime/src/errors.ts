// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime's error base. `code` is a plain string on purpose: components register
 * their own codes by subclassing, without editing a shared closed union.
 */
export class PluginRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PluginRuntimeError";
    this.code = code;
  }
}

/** The codes the runtime container itself raises. */
export const RUNTIME_ERROR_CODES = Object.freeze({
  configInvalid: "config-invalid",
  runtimeAlreadyStarted: "runtime-already-started",
  runtimeNotStarted: "runtime-not-started",
  capabilityStartFailed: "capability-start-failed",
  capabilityStopFailed: "capability-stop-failed",
} as const);

export type RuntimeErrorCode =
  (typeof RUNTIME_ERROR_CODES)[keyof typeof RUNTIME_ERROR_CODES];
