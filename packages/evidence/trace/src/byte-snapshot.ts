// SPDX-License-Identifier: Apache-2.0

import { isProxy, isSharedArrayBuffer } from "node:util/types";

function trapMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "property-descriptor trap";
}

function readTypedArrayIntrinsic<T>(
  key: "buffer" | "byteOffset" | "byteLength",
  receiver: Uint8Array,
): T {
  let prototype: object | null = Uint8Array.prototype;
  let descriptor: PropertyDescriptor | undefined;
  while (prototype !== null) {
    descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor !== undefined) break;
    prototype = Object.getPrototypeOf(prototype);
  }
  if (descriptor?.get === undefined) {
    throw new TypeError(`Uint8Array ${key} getter is missing`);
  }
  try {
    return descriptor.get.call(receiver) as T;
  } catch (cause) {
    throw new TypeError(`Uint8Array.${key} getter failed: ${trapMessage(cause)}`);
  }
}

/** Intrinsic byte snapshot: proxy-first, rejects exotic views and SharedArrayBuffer backing. */
export function snapshotByteView(value: unknown, context: string): Uint8Array {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${context} must be a Uint8Array`);
  }
  if (isProxy(value)) {
    throw new TypeError(`${context} must not be a Proxy`);
  }

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TypeError(`${context} must not be a revoked Proxy`);
  }
  if (prototype !== Uint8Array.prototype) {
    throw new TypeError(`${context} must be a genuine Uint8Array`);
  }

  const view = value as Uint8Array;
  const buffer = readTypedArrayIntrinsic<ArrayBufferLike>("buffer", view);
  if (isSharedArrayBuffer(buffer)) {
    throw new TypeError(`${context} must not be backed by SharedArrayBuffer`);
  }
  const byteLength = readTypedArrayIntrinsic<number>("byteLength", view);

  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(view);
  } catch {
    throw new TypeError(`${context} failed ownKeys inspection`);
  }
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      throw new TypeError(`${context} must not have symbol own keys`);
    }
    const keyStr = String(key);
    if (!/^(?:0|[1-9]\d*)$/u.test(keyStr)) {
      throw new TypeError(`${context} has augmented property "${keyStr}"`);
    }
    const index = Number(keyStr);
    if (index >= byteLength) {
      throw new TypeError(`${context} has index ${keyStr} beyond length ${String(byteLength)}`);
    }
  }

  const copy = new Uint8Array(byteLength);
  const subarray = Reflect.apply(
    Uint8Array.prototype.subarray,
    view,
    [0, byteLength],
  ) as Uint8Array;
  Reflect.apply(Uint8Array.prototype.set, copy, [subarray, 0]);
  return copy;
}
