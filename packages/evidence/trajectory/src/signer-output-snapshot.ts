// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

import type { DsseProducedSignature } from "@jinn-network/trust-core";

import { snapshotByteView } from "./byte-snapshot.js";
import {
  inspectDenseArrayDescriptors,
  readDenseArrayElement,
} from "./dense-array.js";
import { TrajectoryDerivationSigningError } from "./derivation-errors.js";
import { safeGetPrototypeOf } from "./hostile-reflection.js";

const SIGNATURE_ALLOWED_KEYS = new Set(["signature", "keyid"]);

function signingError(): never {
  throw new TrajectoryDerivationSigningError();
}

function trapMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "property-descriptor trap";
}

function snapshotSignatureObject(
  value: unknown,
  path: string,
): DsseProducedSignature {
  if (typeof value !== "object" || value === null) {
    signingError();
  }
  if (isProxy(value)) {
    signingError();
  }
  if (Array.isArray(value)) {
    signingError();
  }
  const prototype = safeGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    signingError();
  }

  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    signingError();
  }

  let keyid: string | undefined;
  let signatureBytes: Uint8Array | undefined;

  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      signingError();
    }
    const keyStr = String(key);
    if (!SIGNATURE_ALLOWED_KEYS.has(keyStr)) {
      signingError();
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      signingError();
    }
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      signingError();
    }
    if (!Object.hasOwn(descriptor, "value")) {
      signingError();
    }
    if (!descriptor.enumerable) {
      signingError();
    }
    if (keyStr === "keyid") {
      if (typeof descriptor.value !== "string") {
        signingError();
      }
      keyid = descriptor.value;
    } else {
      try {
        signatureBytes = snapshotByteView(descriptor.value, `${path}.signature`);
      } catch {
        signingError();
      }
    }
  }

  if (signatureBytes === undefined || signatureBytes.length === 0) {
    signingError();
  }

  return keyid === undefined
    ? { signature: signatureBytes }
    : { signature: signatureBytes, keyid };
}

/** Descriptor-safe snapshot of hostile signer output before trust-core consumes it. */
export function snapshotSignerOutput(
  value: unknown,
): readonly [DsseProducedSignature, ...DsseProducedSignature[]] {
  const inspected = inspectDenseArrayDescriptors(value, "signer output");
  if (!inspected.ok) {
    signingError();
  }
  if (inspected.length === 0) {
    signingError();
  }

  const signatures: DsseProducedSignature[] = [];
  for (let index = 0; index < inspected.length; index += 1) {
    try {
      const element = readDenseArrayElement(value as unknown[], index);
      signatures.push(snapshotSignatureObject(element, `signer output[${String(index)}]`));
    } catch (error) {
      if (error instanceof TrajectoryDerivationSigningError) {
        throw error;
      }
      signingError();
    }
  }

  return signatures as [DsseProducedSignature, ...DsseProducedSignature[]];
}
