// SPDX-License-Identifier: Apache-2.0
import {
  EvidenceRepositoryError,
  type RepositoryOperationOptions,
} from "@jinn-network/evidence-repository";

import {
  EvidencePublicationError,
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
        if (error instanceof EvidenceRepositoryError) {
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
