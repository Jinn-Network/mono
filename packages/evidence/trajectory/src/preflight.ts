// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

import { isNamespacedExtensionKey } from "./extensions.js";
import { UndefinedArrayElementError, UnsupportedCanonicalValueError } from "./canonical.js";

function unsupported(valueType: string, path: string): never {
  throw new UnsupportedCanonicalValueError(valueType, path);
}

function trapMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "property-descriptor trap";
}

function isPlainDataObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inspectOwnProperties(value: object, path: string, seen: WeakSet<object>): void {
  if (seen.has(value)) unsupported("cycle", path);
  seen.add(value);

  if (isProxy(value)) unsupported("proxy", path);
  if (!isPlainDataObject(value)) unsupported("non-plain object", path);

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (cause) {
    unsupported(
      cause instanceof Error ? `property-descriptor trap: ${cause.message}` : "property-descriptor trap",
      path,
    );
  }

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") unsupported("symbol key", path ? `${path}.${String(key)}` : String(key));
    const descriptor = descriptors[key as string]!;
    const childPath = path ? `${path}.${key}` : String(key);

    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      unsupported("accessor property", childPath);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      unsupported("non-data property", childPath);
    }
    if (!descriptor.enumerable) {
      unsupported("non-enumerable property", childPath);
    }

    const nested = descriptor.value;
    if (nested === undefined) continue;

    if (
      isNamespacedExtensionKey(String(key)) &&
      nested !== null &&
      typeof nested === "object" &&
      !Array.isArray(nested)
    ) {
      inspectExtensionObject(nested, childPath, seen);
      continue;
    }

    inspectValue(nested, childPath, seen);
  }
}

function inspectExtensionObject(value: object, path: string, seen: WeakSet<object>): void {
  if (seen.has(value)) unsupported("cycle", path);
  if (isProxy(value)) unsupported("proxy", path);
  if (!isPlainDataObject(value)) unsupported("non-plain object", path);

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (cause) {
    unsupported(
      cause instanceof Error ? `property-descriptor trap: ${cause.message}` : "property-descriptor trap",
      path,
    );
  }

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") unsupported("symbol key", `${path}.${String(key)}`);
    const descriptor = descriptors[key as string]!;
    const childPath = `${path}.${String(key)}`;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      unsupported("accessor property", childPath);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      unsupported("non-data property", childPath);
    }
    if (!descriptor.enumerable) {
      unsupported("non-enumerable property", childPath);
    }
    if (!isNamespacedExtensionKey(String(key))) {
      unsupported(`non-namespaced extension key "${String(key)}"`, childPath);
    }
    inspectValue(descriptor.value, childPath, seen);
  }
}

function inspectArray(value: unknown[], path: string, seen: WeakSet<object>): void {
  if (seen.has(value)) unsupported("cycle", path);
  seen.add(value);
  if (isProxy(value)) unsupported("proxy", path);

  let length = 0;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor?.get !== undefined || lengthDescriptor?.set !== undefined) {
      unsupported("accessor property", `${path}.length`);
    }
    length = value.length;
  } catch (cause) {
    unsupported(`property-descriptor trap: ${trapMessage(cause)}`, `${path}.length`);
  }

  for (let index = 0; index < length; index += 1) {
    const childPath = `${path}[${String(index)}]`;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, index);
    } catch (cause) {
      unsupported(`property-descriptor trap: ${trapMessage(cause)}`, childPath);
    }
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      unsupported("accessor property", childPath);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      unsupported("non-data property", childPath);
    }
    if (!descriptor.enumerable) {
      unsupported("non-enumerable property", childPath);
    }
    const element = descriptor.value;
    if (element === undefined) throw new UndefinedArrayElementError();
    inspectValue(element, childPath, seen);
  }
}

function inspectValue(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === undefined) {
    if (path === "") unsupported("undefined", path);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string" || typeof value === "number") return;
  if (typeof value === "bigint") unsupported("bigint", path);
  if (typeof value === "function" || typeof value === "symbol") unsupported(typeof value, path);
  if (value instanceof Date) unsupported("Date", path);
  if (value instanceof Map || value instanceof Set) unsupported(value.constructor.name, path);
  if (Array.isArray(value)) {
    inspectArray(value, path, seen);
    return;
  }
  if (typeof value === "object") {
    inspectOwnProperties(value, path, seen);
  }
}

/** Descriptor-based, cycle-aware preflight before schema parsing or canonical serialization. */
export function preflightCanonicalInput(value: unknown): void {
  inspectValue(value, "", new WeakSet());
}
