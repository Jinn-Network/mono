// SPDX-License-Identifier: Apache-2.0

import { types } from "node:util";

import { PluginRuntimeError } from "./errors.js";

function readOwnStringField(value: object, key: "message" | "code"): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return null;
  if (descriptor.get !== undefined || descriptor.set !== undefined) return null;
  return typeof descriptor.value === "string" ? descriptor.value : null;
}

function isGenuinePluginRuntimeError(value: unknown): value is PluginRuntimeError {
  if (!(value instanceof PluginRuntimeError) || types.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === PluginRuntimeError.prototype;
}

function isPlainError(value: unknown): value is Error {
  if (!(value instanceof Error) || types.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Error.prototype || prototype === null;
}

export function isHealthInvalidError(error: unknown): boolean {
  if (types.isProxy(error)) {
    return false;
  }
  if (!(error instanceof PluginRuntimeError)) {
    return false;
  }
  if (Object.getPrototypeOf(error) !== PluginRuntimeError.prototype) {
    return false;
  }
  return readOwnStringField(error, "code") === "health-invalid";
}

/**
 * Descriptor-safe normalization for unknown thrown values. Never calls String(),
 * toString, valueOf, toJSON, inspect, or arbitrary getters on hostile objects.
 */
export function describeUnknownError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error === null || error === undefined) {
    return "an unknown error occurred";
  }
  if (types.isProxy(error)) {
    return "an unknown error occurred";
  }
  if (isGenuinePluginRuntimeError(error)) {
    return readOwnStringField(error, "message") ?? "an error occurred";
  }
  if (isPlainError(error)) {
    return readOwnStringField(error, "message") ?? "an error occurred";
  }
  return "an unknown error occurred";
}
