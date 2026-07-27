// SPDX-License-Identifier: Apache-2.0
import { isProxy } from "node:util/types";

import {
  parseSha256Digest,
  type EvidenceRepository,
  type EvidenceRepositoryCapabilities,
  type RepositoryOperationOptions,
} from "@jinn-network/evidence-repository";

import { EvidencePublicationError } from "./errors.js";

export function snapshotPublicationOperationOptions(
  options?: RepositoryOperationOptions,
): Readonly<RepositoryOperationOptions> {
  const signal = options?.signal;
  return Object.freeze({ signal });
}

export function exactBytesLength(value: unknown): number | undefined {
  if (isProxy(value) || !(value instanceof Uint8Array)) return undefined;
  try {
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const lengthGetter = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "length",
    )?.get;
    return lengthGetter === undefined
      ? undefined
      : Reflect.apply(lengthGetter, value, []) as number;
  } catch {
    return undefined;
  }
}

export function snapshotExactBytes(value: unknown): Uint8Array | undefined {
  const length = exactBytesLength(value);
  if (length === undefined) return undefined;
  const bytes = value as Uint8Array;
  try {
    const snapshot = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      snapshot[index] = bytes[index]!;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

export function assertAbsoluteIri(value: unknown, role: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      `${role} must be an absolute IRI.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      `${role} must be an absolute IRI.`,
      { cause },
    );
  }
  if (
    parsed.protocol.length < 2 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      `${role} must be a credential-free absolute IRI.`,
    );
  }
  return value;
}

export function parsePublicationDigest(
  value: unknown,
  role: string,
): ReturnType<typeof parseSha256Digest> {
  try {
    return parseSha256Digest(value);
  } catch (cause) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      `${role} must be a canonical SHA-256 digest.`,
      { cause },
    );
  }
}

function invalidCapabilities(message: string): never {
  throw new EvidencePublicationError("INVALID_INPUT", message);
}

export function readRepositoryCapabilities(
  repository: EvidenceRepository,
): EvidenceRepositoryCapabilities {
  if (
    typeof repository !== "object" ||
    repository === null ||
    isProxy(repository) ||
    Array.isArray(repository)
  ) {
    return invalidCapabilities(
      "The repository must be a non-proxy object with inert capabilities.",
    );
  }
  const slot = Reflect.getOwnPropertyDescriptor(repository, "capabilities");
  if (slot === undefined || !Object.hasOwn(slot, "value")) {
    return invalidCapabilities(
      "The repository capabilities slot must be an own data property.",
    );
  }
  const capabilities = slot.value as unknown;
  if (
    typeof capabilities !== "object" ||
    capabilities === null ||
    isProxy(capabilities) ||
    Array.isArray(capabilities)
  ) {
    return invalidCapabilities(
      "Repository capabilities must be an inert non-proxy snapshot.",
    );
  }
  const prototype = Reflect.getPrototypeOf(capabilities);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.isExtensible(capabilities)
  ) {
    return invalidCapabilities(
      "Repository capabilities must be a non-extensible plain snapshot.",
    );
  }
  const descriptors = new Map<PropertyKey, PropertyDescriptor>();
  for (const name of Reflect.ownKeys(capabilities)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(capabilities, name);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.writable !== false ||
      descriptor.configurable !== false
    ) {
      return invalidCapabilities(
        `Repository capability ${String(name)} must be an immutable data property.`,
      );
    }
    descriptors.set(name, descriptor);
  }
  const limit = descriptors.get("maxObjectBytes");
  if (
    limit === undefined &&
    prototype === Object.prototype &&
    Reflect.getOwnPropertyDescriptor(
      Object.prototype,
      "maxObjectBytes",
    ) !== undefined
  ) {
    return invalidCapabilities(
      "Repository maxObjectBytes must be an own data property.",
    );
  }
  if (
    limit !== undefined &&
    (
      typeof limit.value !== "number" ||
      !Number.isSafeInteger(limit.value) ||
      limit.value <= 0
    )
  ) {
    return invalidCapabilities(
      "Repository maxObjectBytes must be a positive safe integer.",
    );
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  if (limit !== undefined) {
    Object.defineProperty(snapshot, "maxObjectBytes", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: limit.value,
    });
  }
  return Object.preventExtensions(
    snapshot,
  ) as EvidenceRepositoryCapabilities;
}
