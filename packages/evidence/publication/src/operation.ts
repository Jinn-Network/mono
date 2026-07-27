// SPDX-License-Identifier: Apache-2.0
import { isProxy } from "node:util/types";

import {
  EvidenceRepositoryError,
  type RepositoryOperationOptions,
} from "@jinn-network/evidence-repository";

import {
  EvidencePublicationError,
  type EvidencePublicationErrorCode,
} from "./errors.js";

export interface PublicationOperation {
  readonly dependencyOptions: Readonly<RepositoryOperationOptions>;
  assertActive(): void;
  waitFor<T>(
    operation: () => Promise<T>,
  ): Promise<{ readonly value: T }>;
  close(): void;
}

const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;
const evidenceRepositoryErrorPrototype = EvidenceRepositoryError.prototype;
const evidencePublicationErrorPrototype = EvidencePublicationError.prototype;
const missingDataProperty = Symbol("missing data property");

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  );
}

function hasOrdinaryPrototype(
  value: unknown,
  expectedPrototype: object,
): boolean {
  if (!isObjectLike(value) || isProxy(value)) return false;
  let current: object | null;
  try {
    current = Reflect.getPrototypeOf(value);
  } catch {
    return false;
  }
  while (current !== null) {
    if (isProxy(current)) return false;
    if (current === expectedPrototype) return true;
    try {
      current = Reflect.getPrototypeOf(current);
    } catch {
      return false;
    }
  }
  return false;
}

function ownDataProperty(
  value: unknown,
  key: PropertyKey,
): unknown | typeof missingDataProperty {
  if (!isObjectLike(value) || isProxy(value)) return missingDataProperty;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : missingDataProperty;
  } catch {
    return missingDataProperty;
  }
}

function isEvidenceRepositoryError(value: unknown): boolean {
  return hasOrdinaryPrototype(value, evidenceRepositoryErrorPrototype);
}

export function isEvidencePublicationErrorCode(
  value: unknown,
  code: EvidencePublicationErrorCode,
): boolean {
  return (
    hasOrdinaryPrototype(value, evidencePublicationErrorPrototype) &&
    ownDataProperty(value, "code") === code
  );
}

function intrinsicSignalAborted(signal: AbortSignal): boolean {
  if (abortSignalAbortedGetter === undefined) {
    throw new TypeError("AbortSignal.prototype.aborted is unavailable.");
  }
  return Reflect.apply(
    abortSignalAbortedGetter,
    signal,
    [],
  ) as boolean;
}

export function createPublicationOperation(
  options?: RepositoryOperationOptions,
): PublicationOperation {
  const signal = options?.signal;
  const dependencyOptions = Object.freeze({ signal });
  let aborted = signal === undefined
    ? false
    : intrinsicSignalAborted(signal);
  let closed = false;
  let listening = false;
  const latchAbort = (): void => {
    aborted = true;
  };
  const removeAbortListener = (): void => {
    if (signal === undefined || !listening) return;
    listening = false;
    try {
      Reflect.apply(removeEventListener, signal, [
        "abort",
        latchAbort,
      ]);
    } catch {
      // Cleanup must never replace the operation's result or primary error.
    }
  };
  const assertActive = (): void => {
    if (closed) {
      throw new TypeError(
        "A closed publication operation cannot be continued.",
      );
    }
    if (aborted) {
      throw new EvidencePublicationError(
        "OPERATION_ABORTED",
        "The publication operation was aborted.",
      );
    }
  };

  if (signal !== undefined && !aborted) {
    try {
      Reflect.apply(addEventListener, signal, [
        "abort",
        latchAbort,
        { once: true },
      ]);
      listening = true;
      if (intrinsicSignalAborted(signal)) {
        aborted = true;
      }
    } catch (error) {
      removeAbortListener();
      throw error;
    }
  }

  return Object.freeze({
    dependencyOptions,
    assertActive,
    async waitFor<T>(
      operation: () => Promise<T>,
    ): Promise<{ readonly value: T }> {
      assertActive();
      let result: T;
      try {
        result = await operation();
      } catch (error) {
        if (isEvidenceRepositoryError(error)) {
          throw error;
        }
        assertActive();
        throw error;
      }
      assertActive();
      return { value: result };
    },
    close(): void {
      if (closed) return;
      closed = true;
      removeAbortListener();
    },
  });
}
