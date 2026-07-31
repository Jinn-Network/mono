// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

import { UndefinedArrayElementError } from "./canonical.js";

export type DenseArrayFailure = {
  readonly ok: false;
  readonly message: string;
  readonly undefinedElement?: boolean;
};

export type DenseArraySuccess = { readonly ok: true; readonly length: number };

export type DenseArrayResult = DenseArraySuccess | DenseArrayFailure;

function trapMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "property-descriptor trap";
}

/** Descriptor-only dense-array validation before length or element reads. */
export function inspectDenseArrayDescriptors(
  value: unknown,
  path: string,
): DenseArrayResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, message: `${path} must be an array` };
  }
  if (isProxy(value)) {
    return { ok: false, message: `${path} must be a plain array` };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: `${path} must be an array` };
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch (cause) {
    return { ok: false, message: `${path} failed descriptor inspection: ${trapMessage(cause)}` };
  }

  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined) {
    return { ok: false, message: `${path}.length must exist` };
  }
  if (lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined) {
    return { ok: false, message: `${path}.length must be a data property` };
  }
  if (lengthDescriptor.enumerable) {
    return { ok: false, message: `${path}.length must be non-enumerable` };
  }
  if (!Object.hasOwn(lengthDescriptor, "value")) {
    return { ok: false, message: `${path}.length must be a data property` };
  }
  const length = lengthDescriptor.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
    return { ok: false, message: `${path}.length must be a non-negative integer` };
  }

  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(descriptors);
  } catch (cause) {
    return { ok: false, message: `${path} failed ownKeys inspection: ${trapMessage(cause)}` };
  }

  for (const key of ownKeys) {
    if (key === "length") continue;
    if (typeof key === "symbol") {
      return { ok: false, message: `${path} must not contain symbol keys` };
    }
    const keyStr = String(key);
    if (!/^(?:0|[1-9]\d*)$/u.test(keyStr)) {
      return { ok: false, message: `${path} has augmented array key "${keyStr}"` };
    }
    const index = Number(keyStr);
    if (index >= length) {
      return {
        ok: false,
        message: `${path} has index ${keyStr} beyond length ${String(length)}`,
      };
    }
  }

  for (let index = 0; index < length; index += 1) {
    const childPath = `${path}[${String(index)}]`;
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined) {
      return { ok: false, message: `${childPath} is a sparse hole`, undefinedElement: true };
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { ok: false, message: `${childPath} must be a data property` };
    }
    if (!Object.hasOwn(descriptor, "value")) {
      return { ok: false, message: `${childPath} must be a data property` };
    }
    if (!descriptor.enumerable) {
      return { ok: false, message: `${childPath} must be enumerable` };
    }
    if (descriptor.value === undefined) {
      return { ok: false, message: `${childPath} is undefined`, undefinedElement: true };
    }
  }

  return { ok: true, length };
}

export function readDenseArrayElement(array: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, index)!;
  return descriptor.value;
}

export function assertDenseArrayPreflight(value: unknown[], path: string): number {
  const inspected = inspectDenseArrayDescriptors(value, path);
  if (!inspected.ok) {
    if (inspected.undefinedElement) {
      throw new UndefinedArrayElementError();
    }
    throw new Error(inspected.message);
  }
  return inspected.length;
}
