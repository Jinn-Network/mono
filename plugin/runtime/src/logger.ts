// SPDX-License-Identifier: Apache-2.0

import { types } from "node:util";

import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface RuntimeLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

type EmittedLevel = Exclude<LogLevel, "silent">;

const RESERVED_FIELD_KEYS = new Set(["toJSON"]);

function logInvalid(message: string): never {
  throw new PluginRuntimeError(RUNTIME_ERROR_CODES.logInvalid, message);
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (types.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeLogValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return value;
  if (valueType === "number") {
    if (!Number.isFinite(value as number)) {
      logInvalid("log fields must use finite numbers");
    }
    return value;
  }
  if (valueType === "bigint" || valueType === "function" || valueType === "symbol" || valueType === "undefined") {
    logInvalid(`log fields cannot contain ${valueType}`);
  }
  if (Array.isArray(value)) {
    const normalized: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        logInvalid("log fields cannot use sparse arrays");
      }
      normalized.push(normalizeLogValue(value[index], seen));
    }
    return normalized;
  }
  if (!isPlainDataObject(value)) {
    logInvalid("log fields must be plain objects");
  }
  if (Object.prototype.hasOwnProperty.call(value, "toJSON")) {
    logInvalid("log fields must not define toJSON");
  }
  if (seen.has(value)) {
    logInvalid("log fields cannot contain cycles");
  }
  seen.add(value);
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === "level" || key === "message") continue;
    if (RESERVED_FIELD_KEYS.has(key)) {
      logInvalid(`log fields cannot use reserved key ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      logInvalid(`log fields must not use accessors for ${key}`);
    }
    if (descriptor !== undefined && !descriptor.enumerable) {
      logInvalid(`log field ${key} must be enumerable`);
    }
    normalized[key] = normalizeLogValue(value[key], seen);
  }
  return normalized;
}

export function normalizeLogFields(fields: unknown): Readonly<Record<string, unknown>> {
  if (fields === undefined) return Object.freeze({});
  if (!isPlainDataObject(fields)) {
    logInvalid("log fields must be a plain object");
  }
  return Object.freeze(normalizeLogValue(fields, new WeakSet()) as Record<string, unknown>);
}

/**
 * A structured line logger over an injected sink. The sink is injected so nothing in this
 * package reaches for a real stream: the binary owns stderr, and stdout stays reserved
 * for the MCP stdio transport.
 */
export function createLineLogger(
  level: LogLevel,
  write: (line: string) => void,
): RuntimeLogger {
  const threshold = SEVERITY[level];

  const emit = (
    entryLevel: EmittedLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    if (SEVERITY[entryLevel] > threshold) return;
    const normalized = normalizeLogFields(fields);
    const record: Record<string, unknown> = { ...normalized };
    record.level = entryLevel;
    record.message = message;
    write(JSON.stringify(record));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/** A logger that discards every record. Useful as a default and in tests. */
export function createSilentLogger(): RuntimeLogger {
  return createLineLogger("silent", () => {});
}
