// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

function trapMessage(cause: unknown): string {
  if (typeof cause !== "object" || cause === null || isProxy(cause)) {
    return "property-descriptor trap";
  }
  const descriptor = Object.getOwnPropertyDescriptor(cause, "message");
  if (
    descriptor !== undefined &&
    descriptor.get === undefined &&
    Object.hasOwn(descriptor, "value") &&
    typeof descriptor.value === "string"
  ) {
    return descriptor.value;
  }
  return "property-descriptor trap";
}

export function rejectIfProxy(value: unknown, context: string): void {
  if (typeof value === "object" && value !== null && isProxy(value)) {
    throw new Error(`${context} must not be a Proxy`);
  }
}

export function safeGetPrototypeOf(value: object): object | null {
  rejectIfProxy(value, "value");
  try {
    return Object.getPrototypeOf(value);
  } catch (cause) {
    throw new Error(`prototype inspection failed: ${trapMessage(cause)}`);
  }
}

export function isPlainOrdinaryObject(value: object): boolean {
  if (isProxy(value)) return false;
  const prototype = safeGetPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isGenuineUint8Array(value: unknown): value is Uint8Array {
  if (typeof value !== "object" || value === null) return false;
  if (isProxy(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Uint8Array.prototype;
  } catch {
    return false;
  }
}

export function isGenuineAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) return false;
  if (isProxy(value)) return false;
  try {
    return Object.getPrototypeOf(value) === AbortSignal.prototype;
  } catch {
    return false;
  }
}

/** Read cancellation via the built-in AbortSignal.prototype getter only. */
export function readAbortSignalAborted(signal: AbortSignal): boolean {
  if (!isGenuineAbortSignal(signal)) {
    throw new Error("signal must be a genuine AbortSignal");
  }
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
  if (descriptor?.get === undefined) {
    throw new Error("AbortSignal.prototype.aborted getter is missing");
  }
  try {
    return Boolean(descriptor.get.call(signal));
  } catch (cause) {
    throw new Error(`signal.aborted getter failed: ${trapMessage(cause)}`);
  }
}

function readOwnDataStringProperty(error: object, key: "name" | "message"): string | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, key);
  } catch {
    return undefined;
  }
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "string"
  ) {
    return undefined;
  }
  return descriptor.value;
}

/** Trap-safe AbortError detection for authority throws; never reflects on Proxy targets. */
export function isAbortLikeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || isProxy(error)) {
    return false;
  }
  if (readOwnDataStringProperty(error, "name") === "AbortError") {
    return true;
  }
  try {
    if (Object.getPrototypeOf(error) === DOMException.prototype) {
      const nameDescriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, "name");
      if (nameDescriptor?.get !== undefined) {
        return nameDescriptor.get.call(error) === "AbortError";
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function normalizeThrownError(error: unknown): string {
  if (typeof error !== "object" || error === null || isProxy(error)) {
    return "authority verifier threw";
  }
  const name = readOwnDataStringProperty(error, "name") ?? "Error";
  const message = readOwnDataStringProperty(error, "message") ?? "authority verifier threw";
  if (name === "AbortError") return message;
  return message.length > 0 ? message : "authority verifier threw";
}
