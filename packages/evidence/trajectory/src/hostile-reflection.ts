// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

function trapMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "property-descriptor trap";
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

/** Read cancellation state from a verified native AbortSignal via prototype accessor. */
export function readAbortSignalAborted(signal: AbortSignal): boolean {
  if (!isGenuineAbortSignal(signal)) {
    throw new Error("signal must be a genuine AbortSignal");
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor =
      Object.getOwnPropertyDescriptor(signal, "aborted") ??
      Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
  } catch (cause) {
    throw new Error(`signal.aborted inspection failed: ${trapMessage(cause)}`);
  }
  if (descriptor === undefined) {
    throw new Error("signal.aborted is not readable");
  }
  if (descriptor.get !== undefined) {
    try {
      return Boolean(descriptor.get.call(signal));
    } catch (cause) {
      throw new Error(`signal.aborted getter failed: ${trapMessage(cause)}`);
    }
  }
  if (
    descriptor.set !== undefined ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "boolean"
  ) {
    throw new Error("signal.aborted must be a boolean accessor or data property");
  }
  return descriptor.value;
}

export function normalizeThrownError(error: unknown): string {
  if (typeof error !== "object" || error === null || isProxy(error)) {
    return "authority verifier threw";
  }
  let name = "Error";
  let message = "authority verifier threw";
  try {
    const nameDescriptor = Object.getOwnPropertyDescriptor(error, "name");
    if (
      nameDescriptor !== undefined &&
      nameDescriptor.get === undefined &&
      Object.hasOwn(nameDescriptor, "value") &&
      typeof nameDescriptor.value === "string"
    ) {
      name = nameDescriptor.value;
    }
    const messageDescriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (
      messageDescriptor !== undefined &&
      messageDescriptor.get === undefined &&
      Object.hasOwn(messageDescriptor, "value") &&
      typeof messageDescriptor.value === "string" &&
      messageDescriptor.value.length > 0
    ) {
      message = messageDescriptor.value;
    }
  } catch {
    return message;
  }
  if (name === "AbortError") return message;
  return message;
}
