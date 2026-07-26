import type {
  EvidenceRepositoryCapabilities,
} from "./types.js";

export function assertEvidenceRepositoryCapabilities(
  value: unknown,
): asserts value is EvidenceRepositoryCapabilities {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      "EvidenceRepository.capabilities must be a non-null, non-array object.",
    );
  }
  const maxObjectBytes = (
    value as { readonly maxObjectBytes?: unknown }
  ).maxObjectBytes;
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

export function assertStableImmutableEvidenceRepositoryCapabilities(
  readCapabilities: () => unknown,
): EvidenceRepositoryCapabilities {
  const capabilities = readCapabilities();
  assertEvidenceRepositoryCapabilities(capabilities);
  const maxObjectBytes = capabilities.maxObjectBytes;

  if (readCapabilities() !== capabilities) {
    throw new TypeError(
      "EvidenceRepository.capabilities must expose a stable object reference.",
    );
  }
  if (capabilities.maxObjectBytes !== maxObjectBytes) {
    throw new TypeError(
      "EvidenceRepository.capabilities must expose a stable maxObjectBytes value.",
    );
  }

  const snapshot = snapshotDescriptors(capabilities);
  const failures: string[] = [];
  const futureKeys = Reflect.ownKeys(capabilities).filter(
    (key) => key !== "maxObjectBytes",
  );

  probeMutation(
    "add future property",
    capabilities,
    readCapabilities,
    snapshot,
    maxObjectBytes,
    (value) => Reflect.set(value, Symbol("contractFutureCapability"), true),
    failures,
  );

  if (Object.hasOwn(capabilities, "maxObjectBytes")) {
    const attemptedValue = maxObjectBytes === 1 ? 2 : 1;
    probeMutation(
      "overwrite maxObjectBytes",
      capabilities,
      readCapabilities,
      snapshot,
      maxObjectBytes,
      (value) => Reflect.set(value, "maxObjectBytes", attemptedValue),
      failures,
    );
  }

  for (const futureKey of futureKeys) {
    probeMutation(
      `overwrite ${String(futureKey)}`,
      capabilities,
      readCapabilities,
      snapshot,
      maxObjectBytes,
      (value) => Reflect.set(value, futureKey, Symbol("changed")),
      failures,
    );
  }

  if (Object.hasOwn(capabilities, "maxObjectBytes")) {
    probeDelete(
      "delete maxObjectBytes",
      capabilities,
      readCapabilities,
      snapshot,
      maxObjectBytes,
      "maxObjectBytes",
      failures,
    );
  }

  for (const futureKey of futureKeys) {
    probeDelete(
      `delete ${String(futureKey)}`,
      capabilities,
      readCapabilities,
      snapshot,
      maxObjectBytes,
      futureKey,
      failures,
    );
  }

  if (failures.length > 0) {
    throw new TypeError(
      `EvidenceRepository.capabilities must be immutable: ${failures.join(", ")}.`,
    );
  }

  return capabilities;
}

type DescriptorSnapshot = ReadonlyMap<PropertyKey, PropertyDescriptor>;

function snapshotDescriptors(value: object): DescriptorSnapshot {
  return new Map(
    Reflect.ownKeys(value).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(value, key)!,
    ]),
  );
}

function descriptorsMatch(
  left: PropertyDescriptor,
  right: PropertyDescriptor,
): boolean {
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    left.value === right.value &&
    left.get === right.get &&
    left.set === right.set
  );
}

function matchesSnapshot(
  value: object,
  snapshot: DescriptorSnapshot,
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== snapshot.size) return false;

  return keys.every((key) => {
    const expected = snapshot.get(key);
    const actual = Object.getOwnPropertyDescriptor(value, key);
    return (
      expected !== undefined &&
      actual !== undefined &&
      descriptorsMatch(actual, expected)
    );
  });
}

function restoreSnapshot(
  value: object,
  snapshot: DescriptorSnapshot,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (!snapshot.has(key)) {
      try {
        Reflect.deleteProperty(value, key);
      } catch {
        // Best effort keeps a failing implementation available for diagnostics.
      }
    }
  }

  for (const [key, descriptor] of snapshot) {
    try {
      Object.defineProperty(value, key, descriptor);
    } catch {
      // Best effort keeps a failing implementation available for diagnostics.
    }
  }
}

function probeMutation(
  label: string,
  capabilities: EvidenceRepositoryCapabilities,
  readCapabilities: () => unknown,
  snapshot: DescriptorSnapshot,
  maxObjectBytes: number | undefined,
  mutate: (value: object) => boolean,
  failures: string[],
): void {
  try {
    mutate(capabilities);
    if (
      readCapabilities() !== capabilities ||
      capabilities.maxObjectBytes !== maxObjectBytes ||
      !matchesSnapshot(capabilities, snapshot)
    ) {
      failures.push(label);
    }
  } catch {
    if (
      readCapabilities() !== capabilities ||
      capabilities.maxObjectBytes !== maxObjectBytes ||
      !matchesSnapshot(capabilities, snapshot)
    ) {
      failures.push(label);
    }
  } finally {
    restoreSnapshot(capabilities, snapshot);
  }
}

function probeDelete(
  label: string,
  capabilities: EvidenceRepositoryCapabilities,
  readCapabilities: () => unknown,
  snapshot: DescriptorSnapshot,
  maxObjectBytes: number | undefined,
  key: PropertyKey,
  failures: string[],
): void {
  const descriptor = snapshot.get(key);
  if (
    descriptor?.configurable === true &&
    !Object.isExtensible(capabilities)
  ) {
    failures.push(label);
    return;
  }

  probeMutation(
    label,
    capabilities,
    readCapabilities,
    snapshot,
    maxObjectBytes,
    (value) => Reflect.deleteProperty(value, key),
    failures,
  );
}
