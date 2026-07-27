// SPDX-License-Identifier: Apache-2.0

import { isProxy, isUint8Array } from "node:util/types";

import { copyBytes } from "./bytes.js";
import { EvidenceDerivationError } from "./errors.js";

function invalid(message: string): never {
  throw new EvidenceDerivationError("INVALID_DERIVATION_INPUT", message);
}

export function assertNotProxy(value: unknown, message: string): void {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    if (isProxy(value)) invalid(message);
  }
}

export function snapshotInertData<T>(value: T, label = "input"): T {
  assertNotProxy(value, `${label} must not be a Proxy.`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (isUint8Array(value)) {
    try {
      return copyBytes(value) as T;
    } catch {
      invalid(`${label} must be an attached Uint8Array.`);
    }
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (
      keys.length !== value.length ||
      keys.some(
        (key) =>
          !/^(?:0|[1-9]\d*)$/u.test(key) ||
          Number(key) >= value.length ||
          !("value" in descriptors[key]!),
      )
    ) {
      invalid(`${label} must be a dense data-property array.`);
    }
    return keys
      .sort((left, right) => Number(left) - Number(right))
      .map((key) =>
        snapshotInertData(
          (descriptors[key] as PropertyDescriptor & { value: unknown }).value,
          `${label}[${key}]`,
        ),
      ) as T;
  }
  if (typeof value !== "object") {
    invalid(`${label} must contain data values only.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must use a plain or null prototype.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const clone: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") invalid(`${label} must not contain symbol keys.`);
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      invalid(`${label}.${key} must be an enumerable own data property.`);
    }
    clone[key] = snapshotInertData(descriptor.value, `${label}.${key}`);
  }
  return clone as T;
}

export function ownDataProperty(
  value: object,
  key: string,
  label: string,
): unknown {
  assertNotProxy(value, `${label} must not be a Proxy.`);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    invalid(`${label}.${key} must be an own data property.`);
  }
  return descriptor.value;
}
