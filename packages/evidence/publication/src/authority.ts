// SPDX-License-Identifier: Apache-2.0
import {
  isAnyArrayBuffer,
  isProxy,
  isTypedArray,
} from "node:util/types";

import { snapshotExactBytes } from "./validation.js";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const maximumScanDepth = 64;
const maximumScannedValues = 10_000;
const intrinsicApply = Reflect.apply;
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;

function bindIntrinsicGetter<T>(
  prototype: object,
  key: PropertyKey,
): (value: object) => T {
  const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
  if (getter === undefined) {
    throw new TypeError(`Missing intrinsic getter for ${String(key)}.`);
  }
  return (value) => intrinsicApply(getter, value, []) as T;
}

const getTypedArrayBuffer = bindIntrinsicGetter<ArrayBufferLike>(
  typedArrayPrototype,
  "buffer",
);
const getTypedArrayByteOffset = bindIntrinsicGetter<number>(
  typedArrayPrototype,
  "byteOffset",
);
const getTypedArrayByteLength = bindIntrinsicGetter<number>(
  typedArrayPrototype,
  "byteLength",
);
const getTypedArrayLength = bindIntrinsicGetter<number>(
  typedArrayPrototype,
  "length",
);
const getDataViewBuffer = bindIntrinsicGetter<ArrayBufferLike>(
  DataView.prototype,
  "buffer",
);
const getDataViewByteOffset = bindIntrinsicGetter<number>(
  DataView.prototype,
  "byteOffset",
);
const getDataViewByteLength = bindIntrinsicGetter<number>(
  DataView.prototype,
  "byteLength",
);

export interface AuthorityMarkerPatterns {
  readonly bytePatterns: readonly Uint8Array[];
  readonly textPatterns: readonly string[];
}

function exactMarkerBytes(value: unknown): Uint8Array {
  if (isProxy(value) || !(value instanceof Uint8Array)) {
    throw new TypeError(
      "Authority markers must be non-proxy Uint8Array values.",
    );
  }
  const snapshot = snapshotExactBytes(value);
  if (snapshot === undefined) {
    throw new TypeError(
      "Authority markers must be non-proxy Uint8Array values.",
    );
  }
  if (snapshot.byteLength < 32) {
    throw new TypeError("Authority markers must contain at least 32 bytes.");
  }
  return snapshot;
}

function percentBytes(bytes: Uint8Array, uppercase: boolean): string {
  return [...bytes].map((byte) => {
    const hex = byte.toString(16).padStart(2, "0");
    return `%${uppercase ? hex.toUpperCase() : hex}`;
  }).join("");
}

function markerTextRepresentations(bytes: Uint8Array): readonly string[] {
  const buffer = Buffer.from(bytes);
  const values = new Set([
    buffer.toString("hex"),
    buffer.toString("base64"),
    buffer.toString("base64url"),
    percentBytes(bytes, true),
    percentBytes(bytes, false),
  ]);
  try {
    const text = fatalDecoder.decode(bytes);
    values.add(text);
    values.add(encodeURIComponent(text));
  } catch {
    // Binary markers have no canonical raw UTF-8 string representation.
  }
  return [...values].filter((value) => value.length > 0);
}

export function validateAuthorityMarkers(
  values: readonly Uint8Array[],
): AuthorityMarkerPatterns {
  if (!Array.isArray(values) || values.length < 2) {
    throw new TypeError(
      "Authority-marker fixtures require at least two markers.",
    );
  }
  const markers = values.map(exactMarkerBytes);
  const identities = markers.map((marker) =>
    Buffer.from(marker).toString("hex")
  );
  if (new Set(identities).size !== identities.length) {
    throw new TypeError("Authority-marker fixtures must be unique.");
  }
  const decoded = markers.map((marker) => {
    try {
      return fatalDecoder.decode(marker);
    } catch {
      return undefined;
    }
  });
  if (
    !decoded.some((value) =>
      value !== undefined && /^[\x20-\x7e]+$/u.test(value)
    ) ||
    !decoded.some((value) => value === undefined)
  ) {
    throw new TypeError(
      "Authority-marker fixtures require printable and non-UTF-8 data.",
    );
  }
  const textPatterns = [
    ...new Set(markers.flatMap(markerTextRepresentations)),
  ];
  const bytePatterns = [
    ...markers,
    ...textPatterns.map((value) => encoder.encode(value)),
  ];
  return Object.freeze({
    bytePatterns: Object.freeze(
      bytePatterns.map((value) => Uint8Array.from(value)),
    ),
    textPatterns: Object.freeze(textPatterns),
  });
}

function containsBytes(
  value: Uint8Array,
  pattern: Uint8Array,
): boolean {
  if (pattern.byteLength > value.byteLength) return false;
  outer:
  for (
    let offset = 0;
    offset <= value.byteLength - pattern.byteLength;
    offset += 1
  ) {
    for (let index = 0; index < pattern.byteLength; index += 1) {
      if (value[offset + index] !== pattern[index]) continue outer;
    }
    return true;
  }
  return false;
}

function leaked(): never {
  throw new Error(
    "An authority marker representation was found in publication output.",
  );
}

interface ArrayBufferViewMetadata {
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly length?: number;
}

function getArrayBufferViewMetadata(
  value: object,
): ArrayBufferViewMetadata {
  if (isTypedArray(value)) {
    return {
      buffer: getTypedArrayBuffer(value),
      byteOffset: getTypedArrayByteOffset(value),
      byteLength: getTypedArrayByteLength(value),
      length: getTypedArrayLength(value),
    };
  }
  return {
    buffer: getDataViewBuffer(value),
    byteOffset: getDataViewByteOffset(value),
    byteLength: getDataViewByteLength(value),
  };
}

function isTypedArrayIndex(
  metadata: ArrayBufferViewMetadata | undefined,
  key: PropertyKey,
): boolean {
  if (
    typeof key !== "string" ||
    metadata?.length === undefined ||
    !/^(?:0|[1-9][0-9]*)$/u.test(key)
  ) {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) &&
    index >= 0 &&
    index < metadata.length;
}

export function assertNoAuthorityMarkerLeaks(
  patterns: AuthorityMarkerPatterns,
  values: readonly unknown[],
): void {
  const seen = new WeakSet<object>();
  let scannedValues = 0;

  const visit = (value: unknown, depth: number): void => {
    scannedValues += 1;
    if (
      depth > maximumScanDepth ||
      scannedValues > maximumScannedValues
    ) {
      throw new Error("The authority-marker scan exceeded its safe bound.");
    }
    if (typeof value === "string") {
      if (patterns.textPatterns.some((pattern) => value.includes(pattern))) {
        leaked();
      }
      return;
    }
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    ) {
      return;
    }
    if (isProxy(value)) {
      throw new TypeError(
        "The authority-marker scanner cannot inspect proxy output safely.",
      );
    }
    if (seen.has(value)) return;
    seen.add(value);
    let exactBytes: Uint8Array | undefined;
    let viewMetadata: ArrayBufferViewMetadata | undefined;
    if (ArrayBuffer.isView(value)) {
      viewMetadata = getArrayBufferViewMetadata(value);
      exactBytes = new Uint8Array(
        viewMetadata.buffer,
        viewMetadata.byteOffset,
        viewMetadata.byteLength,
      );
    } else if (isAnyArrayBuffer(value)) {
      exactBytes = new Uint8Array(value);
    }
    if (exactBytes !== undefined) {
      if (
        patterns.bytePatterns.some((pattern) =>
          containsBytes(exactBytes, pattern)
        )
      ) {
        leaked();
      }
    }
    for (const key of Reflect.ownKeys(value)) {
      if (isTypedArrayIndex(viewMetadata, key)) continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      visit(descriptor.value, depth + 1);
    }
  };

  for (const value of values) visit(value, 0);
}
