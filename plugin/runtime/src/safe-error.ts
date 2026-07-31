// SPDX-License-Identifier: Apache-2.0

import { types } from "node:util";

import { PluginRuntimeError } from "./errors.js";

function isPlainError(value: unknown): value is Error {
  if (!(value instanceof Error) || types.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Error.prototype || prototype === null;
}

function readErrorMessage(error: Error): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  if (descriptor === undefined) return null;
  if (descriptor.get !== undefined || descriptor.set !== undefined) return null;
  return typeof descriptor.value === "string" ? descriptor.value : null;
}

/**
 * Descriptor-safe normalization for unknown thrown values. Never calls String(),
 * toString, valueOf, toJSON, inspect, or arbitrary getters on hostile objects.
 */
export function describeUnknownError(error: unknown): string {
  if (error instanceof PluginRuntimeError) {
    return error.message;
  }
  if (isPlainError(error)) {
    return readErrorMessage(error) ?? "an error occurred";
  }
  if (typeof error === "string") {
    return error;
  }
  return "an unknown error occurred";
}
