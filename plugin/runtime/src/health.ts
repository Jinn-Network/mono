// SPDX-License-Identifier: Apache-2.0

import { types } from "node:util";

import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";

/**
 * One doctor check. `remedy` is `null` when the state is not fixable from this machine —
 * a channel outage, for example — so the host adapter reports a known-outage state
 * instead of printing a remedy that would do nothing.
 */
export interface HealthCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly remedy: string | null;
}

export interface HealthReport {
  readonly ok: boolean;
  readonly version: string;
  readonly checks: readonly HealthCheck[];
}

function healthInvalid(message: string): never {
  throw new PluginRuntimeError(RUNTIME_ERROR_CODES.healthInvalid, message);
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

function isPlainDenseArray(value: unknown): value is unknown[] {
  if (types.isProxy(value)) {
    healthInvalid("health checks must not be a proxy array");
  }
  if (!Array.isArray(value)) {
    healthInvalid("health checks must be an array");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor?.get !== undefined || lengthDescriptor?.set !== undefined) {
    healthInvalid("health checks array must not use a length accessor");
  }
  const length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      healthInvalid("health checks array must not define symbol keys");
    }
    if (key === "length") continue;
    const numeric = Number(key);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric >= length) {
      healthInvalid("health checks array has non-index properties");
    }
  }
  for (let index = 0; index < length; index += 1) {
    if (!(index in value)) {
      healthInvalid("health checks array must be dense");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      healthInvalid("health checks array must not use index accessors");
    }
    if (descriptor !== undefined && !descriptor.enumerable) {
      healthInvalid("health checks array indices must be enumerable");
    }
  }
  return true;
}

function readOwnDataProperty(
  value: Record<string, unknown>,
  key: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(value, "toJSON")) {
    healthInvalid("a health check must not define toJSON");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    healthInvalid(`a health check is missing ${key}`);
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    healthInvalid(`a health check must not use accessors for ${key}`);
  }
  if (!descriptor.enumerable) {
    healthInvalid(`a health check field ${key} must be enumerable`);
  }
  return descriptor.value;
}

/** Descriptor-safe normalization for one capability-contributed health check. */
export function normalizeHealthCheck(input: unknown): HealthCheck {
  if (!isPlainDataObject(input)) {
    healthInvalid("a health check must be a plain object");
  }
  const keys = Object.keys(input).sort();
  const allowed = ["detail", "name", "ok", "remedy"];
  if (keys.length !== allowed.length || !allowed.every((key) => keys.includes(key))) {
    healthInvalid("a health check has unknown or missing fields");
  }

  const nameValue = readOwnDataProperty(input, "name");
  if (typeof nameValue !== "string" || nameValue.length === 0) {
    healthInvalid("a health check must have a name");
  }

  const okValue = readOwnDataProperty(input, "ok");
  if (typeof okValue !== "boolean") {
    healthInvalid("a health check ok field must be a boolean");
  }

  const detailValue = readOwnDataProperty(input, "detail");
  if (typeof detailValue !== "string" || detailValue.length === 0) {
    healthInvalid("a health check must have a detail");
  }

  const remedyValue = readOwnDataProperty(input, "remedy");
  if (remedyValue !== null && typeof remedyValue !== "string") {
    healthInvalid("a health check remedy must be a string or null");
  }

  return Object.freeze({
    name: nameValue,
    ok: okValue,
    detail: detailValue,
    remedy: remedyValue,
  });
}

export function normalizeHealthChecks(inputs: unknown): readonly HealthCheck[] {
  if (!isPlainDenseArray(inputs)) {
    healthInvalid("health checks must be an array");
  }
  const normalized = inputs.map((input) => normalizeHealthCheck(input));
  return Object.freeze(normalized);
}

/** Fold contributed checks into one report. Order is preserved; names must be unique. */
export function summarizeHealth(
  version: string,
  checks: readonly HealthCheck[],
): HealthReport {
  const seen = new Set<string>();
  const normalizedChecks: HealthCheck[] = [];
  for (const check of checks) {
    const normalized = normalizeHealthCheck(check);
    if (normalized.name.trim() === "") {
      healthInvalid("a health check must have a name");
    }
    if (normalized.detail.trim() === "") {
      healthInvalid(`health check ${normalized.name} must have a detail`);
    }
    if (seen.has(normalized.name)) {
      healthInvalid(`duplicate health check name: ${normalized.name}`);
    }
    seen.add(normalized.name);
    normalizedChecks.push(Object.freeze({ ...normalized }));
  }
  return Object.freeze({
    ok: normalizedChecks.every((check) => check.ok),
    version,
    checks: Object.freeze(normalizedChecks),
  });
}
