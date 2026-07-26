import { isProxy } from "node:util/types";

import type {
  EvidenceRepositoryCapabilities,
} from "./types.js";

const MAX_OBJECT_BYTES = "maxObjectBytes";

export function assertEvidenceRepositoryCapabilities(
  value: unknown,
): asserts value is EvidenceRepositoryCapabilities {
  assertCapabilityContainer(value);
  assertMaxObjectBytesDescriptor(
    value,
    Reflect.getOwnPropertyDescriptor(value, MAX_OBJECT_BYTES),
  );
}

export function assertStableImmutableEvidenceRepositoryCapabilities(
  readCapabilities: () => unknown,
): EvidenceRepositoryCapabilities {
  const capabilities = readCapabilities();
  assertEvidenceRepositoryCapabilities(capabilities);

  const firstSnapshot = captureSnapshot(capabilities);
  const repeatedCapabilities = readCapabilities();
  if (repeatedCapabilities !== capabilities) {
    throw new TypeError(
      "EvidenceRepository.capabilities must expose a stable object reference.",
    );
  }
  const repeatedSnapshot = captureSnapshot(capabilities);

  if (firstSnapshot.prototype !== repeatedSnapshot.prototype) {
    throw new TypeError(
      "EvidenceRepository.capabilities must expose a stable prototype.",
    );
  }
  if (firstSnapshot.extensible !== repeatedSnapshot.extensible) {
    throw new TypeError(
      "EvidenceRepository.capabilities must expose stable extensibility.",
    );
  }
  if (
    !descriptorSnapshotsMatch(
      firstSnapshot.descriptors,
      repeatedSnapshot.descriptors,
    )
  ) {
    throw new TypeError(
      "EvidenceRepository.capabilities must expose stable own data descriptors.",
    );
  }

  assertMaxObjectBytesDescriptor(
    capabilities,
    firstSnapshot.descriptors.get(MAX_OBJECT_BYTES),
  );
  assertImmutableSnapshot(firstSnapshot);
  return capabilities;
}

export function assertEvidenceRepositoryCapabilitiesSlot(
  repository: unknown,
): EvidenceRepositoryCapabilities {
  assertRepositoryContainer(repository);
  const descriptor = Reflect.getOwnPropertyDescriptor(
    repository,
    "capabilities",
  );
  if (descriptor === undefined || !isDataDescriptor(descriptor)) {
    throw new TypeError(
      "EvidenceRepository.capabilities must be an own data property.",
    );
  }

  const capabilities =
    assertStableImmutableEvidenceRepositoryCapabilities(
      () => descriptor.value,
    );
  const repeatedDescriptor = Reflect.getOwnPropertyDescriptor(
    repository,
    "capabilities",
  );
  if (
    repeatedDescriptor === undefined ||
    !isDataDescriptor(repeatedDescriptor) ||
    !Object.is(repeatedDescriptor.value, capabilities)
  ) {
    throw new TypeError(
      "EvidenceRepository.capabilities must retain a stable own data property value.",
    );
  }

  return capabilities;
}

function assertRepositoryContainer(
  value: unknown,
): asserts value is object {
  if (isProxy(value)) {
    throw new TypeError("EvidenceRepository must not be a Proxy.");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      "EvidenceRepository must be a non-null, non-array object.",
    );
  }
}

function assertCapabilityContainer(
  value: unknown,
): asserts value is object {
  if (isProxy(value)) {
    throw new TypeError(
      "EvidenceRepository.capabilities must not be a Proxy.",
    );
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      "EvidenceRepository.capabilities must be a non-null, non-array object.",
    );
  }
}

function assertMaxObjectBytesDescriptor(
  capabilities: object,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    if (Reflect.has(capabilities, MAX_OBJECT_BYTES)) {
      throw new TypeError(
        "EvidenceRepository.capabilities.maxObjectBytes must be an own data property.",
      );
    }
    return;
  }

  if (!isDataDescriptor(descriptor)) {
    throw new TypeError(
      "EvidenceRepository.capabilities.maxObjectBytes must be an own data property.",
    );
  }

  const maxObjectBytes = descriptor.value as unknown;
  if (
    maxObjectBytes !== undefined &&
    (
      typeof maxObjectBytes !== "number" ||
      !Number.isSafeInteger(maxObjectBytes) ||
      maxObjectBytes <= 0
    )
  ) {
    throw new TypeError(
      "EvidenceRepository.capabilities.maxObjectBytes must be a positive safe integer when supplied.",
    );
  }
}

interface CapabilitySnapshot {
  readonly descriptors: DescriptorSnapshot;
  readonly extensible: boolean;
  readonly prototype: object | null;
}

type DescriptorSnapshot = ReadonlyMap<PropertyKey, PropertyDescriptor>;

function captureSnapshot(value: object): CapabilitySnapshot {
  const prototype = Reflect.getPrototypeOf(value);
  const extensible = Reflect.isExtensible(value);
  const descriptors = new Map<PropertyKey, PropertyDescriptor>();

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      throw new TypeError(
        "EvidenceRepository.capabilities must expose stable own data descriptors.",
      );
    }
    descriptors.set(key, descriptor);
  }

  return { descriptors, extensible, prototype };
}

function assertImmutableSnapshot(snapshot: CapabilitySnapshot): void {
  const problems: string[] = [];
  if (
    snapshot.prototype !== Object.prototype &&
    snapshot.prototype !== null
  ) {
    problems.push("must have a plain or null prototype");
  }
  if (snapshot.extensible) {
    problems.push(
      "must be non-extensible to prevent property addition and prototype mutation",
    );
  }

  for (const [key, descriptor] of snapshot.descriptors) {
    const label = formatPropertyKey(key);
    if (!isDataDescriptor(descriptor)) {
      problems.push(`${label} must be an own data descriptor`);
      continue;
    }
    if (descriptor.writable !== false) {
      problems.push(`${label} must be non-writable`);
    }
    if (descriptor.configurable !== false) {
      problems.push(
        `${label} must be non-configurable to prevent deletion and defineProperty mutation`,
      );
    }
  }

  if (problems.length > 0) {
    throw new TypeError(
      `EvidenceRepository.capabilities must be an immutable snapshot: ${problems.join("; ")}.`,
    );
  }
}

function isDataDescriptor(
  descriptor: PropertyDescriptor,
): descriptor is PropertyDescriptor & { readonly value: unknown } {
  return Object.hasOwn(descriptor, "value");
}

function descriptorSnapshotsMatch(
  left: DescriptorSnapshot,
  right: DescriptorSnapshot,
): boolean {
  if (left.size !== right.size) return false;

  for (const [key, leftDescriptor] of left) {
    const rightDescriptor = right.get(key);
    if (
      rightDescriptor === undefined ||
      !descriptorsMatch(leftDescriptor, rightDescriptor)
    ) {
      return false;
    }
  }
  return true;
}

function descriptorsMatch(
  left: PropertyDescriptor,
  right: PropertyDescriptor,
): boolean {
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    Object.is(left.value, right.value) &&
    left.get === right.get &&
    left.set === right.set
  );
}

function formatPropertyKey(key: PropertyKey): string {
  return String(key);
}
