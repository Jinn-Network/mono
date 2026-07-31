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

export function normalizeHealthChecks(inputs: readonly unknown[]): readonly HealthCheck[] {
  return Object.freeze(inputs.map((input) => normalizeHealthCheck(input)));
}

/** Fold contributed checks into one report. Order is preserved; names must be unique. */
export function summarizeHealth(
  version: string,
  checks: readonly HealthCheck[],
): HealthReport {
  const seen = new Set<string>();
  const normalizedChecks: HealthCheck[] = [];
  for (const check of checks) {
    if (check.name.trim() === "") {
      healthInvalid("a health check must have a name");
    }
    if (check.detail.trim() === "") {
      healthInvalid(`health check ${check.name} must have a detail`);
    }
    if (seen.has(check.name)) {
      healthInvalid(`duplicate health check name: ${check.name}`);
    }
    seen.add(check.name);
    normalizedChecks.push(Object.freeze({ ...check }));
  }
  return Object.freeze({
    ok: normalizedChecks.every((check) => check.ok),
    version,
    checks: Object.freeze(normalizedChecks),
  });
}
