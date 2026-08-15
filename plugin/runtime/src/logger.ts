// SPDX-License-Identifier: Apache-2.0

import { types } from "node:util";

import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import { isCanonicalArrayIndexKey } from "./hostile-array.js";

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

const LOG_LEVELS = new Set<LogLevel>(["silent", "error", "warn", "info", "debug"]);

const DANGEROUS_FIELD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const LOG_MAX_DEPTH = 64;
const LOG_MAX_NODES = 10_000;

type EmittedLevel = Exclude<LogLevel, "silent">;

const RESERVED_FIELD_KEYS = new Set(["toJSON"]);

function logInvalid(message: string): never {
  throw new PluginRuntimeError(RUNTIME_ERROR_CODES.logInvalid, message);
}

function rejectIfProxy(value: unknown, message: string): void {
  try {
    if (types.isProxy(value)) {
      logInvalid(message);
    }
  } catch {
    logInvalid(message);
  }
}

function directPrototype(value: object): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return null;
  }
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  rejectIfProxy(value, "log fields must not use proxy objects");
  const prototype = directPrototype(value);
  return prototype === Object.prototype || prototype === null;
}

function isPlainDenseArray(value: unknown[]): void {
  rejectIfProxy(value, "log fields cannot use proxy arrays");
  if (directPrototype(value) !== Array.prototype) {
    logInvalid("log fields cannot use nonstandard arrays");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor?.get !== undefined || lengthDescriptor?.set !== undefined) {
    logInvalid("log fields cannot use array length accessors");
  }
  const length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      logInvalid("log fields cannot use symbol array keys");
    }
    if (key === "length") continue;
    if (!isCanonicalArrayIndexKey(key, length)) {
      logInvalid("log fields cannot use non-canonical array index keys");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      logInvalid("log fields cannot use sparse arrays");
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      logInvalid("log fields cannot use index accessors");
    }
    if (!descriptor.enumerable) {
      logInvalid("log fields cannot use non-enumerable indices");
    }
  }
}

function normalizeLogValue(
  value: unknown,
  activePath: Set<object>,
  stripEnvelopeKeys: boolean,
  depth: number,
  budget: { remaining: number },
): unknown {
  if (budget.remaining <= 0) {
    logInvalid("log fields exceed the node budget");
  }
  budget.remaining -= 1;
  if (depth > LOG_MAX_DEPTH) {
    logInvalid("log fields exceed the maximum nesting depth");
  }
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
  rejectIfProxy(value, "log fields cannot use proxy values");
  if (Array.isArray(value)) {
    isPlainDenseArray(value);
    if (activePath.has(value)) {
      logInvalid("log fields cannot contain cycles");
    }
    activePath.add(value);
    const normalized: unknown[] = [];
    try {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined) {
          logInvalid("log fields cannot use sparse arrays");
        }
        normalized.push(normalizeLogValue(descriptor.value, activePath, false, depth + 1, budget));
      }
      return normalized;
    } finally {
      activePath.delete(value);
    }
  }
  if (!isPlainDataObject(value)) {
    logInvalid("log fields must be plain objects");
  }
  if (Object.prototype.hasOwnProperty.call(value, "toJSON")) {
    logInvalid("log fields must not define toJSON");
  }
  if (activePath.has(value)) {
    logInvalid("log fields cannot contain cycles");
  }
  activePath.add(value);
  const normalized: Record<string, unknown> = {};
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        logInvalid("log fields cannot use symbol keys");
      }
      if (stripEnvelopeKeys && (key === "level" || key === "message")) continue;
      if (DANGEROUS_FIELD_KEYS.has(key)) {
        logInvalid(`log fields cannot use dangerous key ${key}`);
      }
      if (RESERVED_FIELD_KEYS.has(key)) {
        logInvalid(`log fields cannot use reserved key ${key}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        logInvalid(`log field ${key} must be an own property`);
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        logInvalid(`log fields must not use accessors for ${key}`);
      }
      if (!descriptor.enumerable) {
        logInvalid(`log field ${key} must be enumerable`);
      }
      normalized[key] = normalizeLogValue(descriptor.value, activePath, false, depth + 1, budget);
    }
    return normalized;
  } finally {
    activePath.delete(value);
  }
}

export function normalizeLogFields(fields: unknown): Readonly<Record<string, unknown>> {
  if (fields === undefined) return Object.freeze({});
  rejectIfProxy(fields, "log fields cannot use proxy values");
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    logInvalid("log fields must be a plain object");
  }
  if (!isPlainDataObject(fields)) {
    logInvalid("log fields must be a plain object");
  }
  return Object.freeze(normalizeLogValue(fields, new Set(), true, 0, { remaining: LOG_MAX_NODES }) as Record<string, unknown>);
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
  if (typeof level !== "string" || !LOG_LEVELS.has(level)) {
    logInvalid("log level must be one of silent, error, warn, info, debug");
  }
  const threshold = SEVERITY[level];

  const emit = (
    entryLevel: EmittedLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    if (typeof message !== "string") {
      logInvalid("log message must be a primitive string");
    }
    const normalized = normalizeLogFields(fields);
    if (SEVERITY[entryLevel] > threshold) return;
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
