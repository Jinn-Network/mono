// SPDX-License-Identifier: Apache-2.0

const Uint8ArrayConstructor = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8ArrayConstructor.prototype,
);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const typedArraySet = Uint8ArrayConstructor.prototype.set;

export function intrinsicUint8ArrayByteLength(
  value: Uint8Array,
): number {
  return Reflect.apply(typedArrayByteLength, value, []) as number;
}

export function copyIntrinsicUint8Array(
  value: Uint8Array,
  byteLength: number,
): Uint8Array {
  const copy = new Uint8ArrayConstructor(byteLength);
  setIntrinsicUint8Array(copy, value);
  return copy;
}

export function setIntrinsicUint8Array(
  target: Uint8Array,
  source: Uint8Array,
  offset = 0,
): void {
  Reflect.apply(typedArraySet, target, [source, offset]);
}
