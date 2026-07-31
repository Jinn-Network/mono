// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

import {
  inspectDenseArrayDescriptors,
  readDenseArrayElement,
} from "./dense-array.js";
import { safeGetPrototypeOf } from "./hostile-reflection.js";

type TrajectoryDerivationAuthorityVerifierResult =
  | { readonly verified: true; readonly signerKeyIds: readonly string[]; readonly detail?: string }
  | {
      readonly verified: false;
      readonly signerKeyIds?: readonly string[];
      readonly reason: string;
      readonly detail?: string;
    };

type ValidationFailure = { readonly ok: false; readonly message: string };
type ValidationSuccess = {
  readonly ok: true;
  readonly value: TrajectoryDerivationAuthorityVerifierResult;
};

function fail(message: string): ValidationFailure {
  return { ok: false, message };
}

function trapMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "property-descriptor trap";
}

function isPlainOrdinaryObject(value: object): boolean {
  if (isProxy(value)) return false;
  const prototype = safeGetPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidationFailure(value: unknown): value is ValidationFailure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function readStringArray(
  value: unknown,
  path: string,
  allowEmptyStrings: boolean,
): readonly string[] | ValidationFailure {
  const inspected = inspectDenseArrayDescriptors(value, path);
  if (!inspected.ok) {
    if (inspected.undefinedElement) {
      return fail(`${path} must be a dense array`);
    }
    return fail(inspected.message);
  }

  const entries: string[] = [];
  for (let index = 0; index < inspected.length; index += 1) {
    const entry = readDenseArrayElement(value as unknown[], index);
    if (typeof entry !== "string" || (!allowEmptyStrings && entry.length === 0)) {
      return fail(`${path} must contain only${allowEmptyStrings ? "" : " non-empty"} strings`);
    }
    entries.push(entry);
  }
  return entries;
}

function readOwnStringField(
  value: object,
  key: string,
  required: boolean,
): string | undefined | ValidationFailure {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch (cause) {
    return fail(`authority result key "${key}" failed descriptor inspection: ${trapMessage(cause)}`);
  }
  if (descriptor === undefined) {
    return required ? fail(`authority result missing required key "${key}"`) : undefined;
  }
  if (typeof key !== "string") {
    return fail("authority result keys must be strings");
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    return fail(`authority result key "${key}" must be a data property`);
  }
  if (!Object.hasOwn(descriptor, "value")) {
    return fail(`authority result key "${key}" must be a data property`);
  }
  if (!descriptor.enumerable) {
    return fail(`authority result key "${key}" must be enumerable`);
  }
  const fieldValue = descriptor.value;
  if (typeof fieldValue !== "string") {
    return fail(`authority result ${key} must be a string`);
  }
  if (required && fieldValue.length === 0) {
    return fail(`authority result ${key} must be a non-empty string`);
  }
  return fieldValue;
}

function readOwnBooleanField(value: object, key: string): boolean | ValidationFailure {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch (cause) {
    return fail(`authority result key "${key}" failed descriptor inspection: ${trapMessage(cause)}`);
  }
  if (descriptor === undefined) {
    return fail("authority result verified must be a boolean");
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    return fail(`authority result key "${key}" must be a data property`);
  }
  if (!Object.hasOwn(descriptor, "value")) {
    return fail(`authority result key "${key}" must be a data property`);
  }
  if (!descriptor.enumerable) {
    return fail(`authority result key "${key}" must be enumerable`);
  }
  if (typeof descriptor.value !== "boolean") {
    return fail("authority result verified must be a boolean");
  }
  return descriptor.value;
}

/** Descriptor-safe closed validation for authority callback results. */
export function validateAuthorityResult(
  result: unknown,
  envelopeKeyIds: readonly string[],
): ValidationSuccess | ValidationFailure {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return fail("authority result must be a plain object");
  }
  if (!isPlainOrdinaryObject(result)) {
    return fail("authority result must be a plain object");
  }

  const allowed = new Set(["verified", "signerKeyIds", "reason", "detail"]);
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(result);
  } catch (cause) {
    return fail(`authority result failed ownKeys inspection: ${trapMessage(cause)}`);
  }

  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      return fail("authority result must not contain symbol keys");
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(result, key);
    } catch (cause) {
      return fail(`authority result key "${String(key)}" failed descriptor inspection: ${trapMessage(cause)}`);
    }
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return fail(`authority result key "${String(key)}" must be a data property`);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      return fail(`authority result key "${String(key)}" must be a data property`);
    }
    if (!descriptor.enumerable) {
      return fail(`authority result key "${String(key)}" must be enumerable`);
    }
    if (!allowed.has(String(key))) {
      return fail(`authority result has unknown key "${String(key)}"`);
    }
  }

  const verified = readOwnBooleanField(result, "verified");
  if (typeof verified !== "boolean") return verified;

  if (verified === true) {
    let signerDescriptor: PropertyDescriptor | undefined;
    try {
      signerDescriptor = Object.getOwnPropertyDescriptor(result, "signerKeyIds");
    } catch (cause) {
      return fail(`authority result signerKeyIds failed descriptor inspection: ${trapMessage(cause)}`);
    }
    if (signerDescriptor === undefined) {
      return fail("authority result signerKeyIds must be an array");
    }
    const signerKeyIds = readStringArray(signerDescriptor.value, "authority result signerKeyIds", false);
    if (isValidationFailure(signerKeyIds)) return signerKeyIds;

    if (envelopeKeyIds.length === 0) {
      return fail("authority result signerKeyIds incompatible with envelope key IDs");
    }
    for (const keyId of signerKeyIds) {
      if (!envelopeKeyIds.includes(keyId)) {
        return fail("authority result signerKeyIds must match envelope key IDs");
      }
    }

    const detail = readOwnStringField(result, "detail", false);
    if (isValidationFailure(detail)) return detail;

    return {
      ok: true,
      value: {
        verified: true,
        signerKeyIds,
        ...(detail === undefined ? {} : { detail }),
      },
    };
  }

  const reasonField = readOwnStringField(result, "reason", true);
  if (isValidationFailure(reasonField)) return reasonField;
  const reason = reasonField as string;

  let signerKeyIds: readonly string[] | undefined;
  let signerDescriptor: PropertyDescriptor | undefined;
  try {
    signerDescriptor = Object.getOwnPropertyDescriptor(result, "signerKeyIds");
  } catch (cause) {
    return fail(`authority result signerKeyIds failed descriptor inspection: ${trapMessage(cause)}`);
  }
  if (signerDescriptor !== undefined) {
    const parsed = readStringArray(signerDescriptor.value, "authority result signerKeyIds", true);
    if (isValidationFailure(parsed)) return parsed;
    signerKeyIds = parsed;
  }

  const detail = readOwnStringField(result, "detail", false);
  if (isValidationFailure(detail)) return detail;

  return {
    ok: true,
    value: {
      verified: false,
      reason,
      ...(signerKeyIds === undefined ? {} : { signerKeyIds }),
      ...(detail === undefined ? {} : { detail }),
    },
  };
}
