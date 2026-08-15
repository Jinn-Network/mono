// SPDX-License-Identifier: Apache-2.0

import { invalidInput } from "./errors.js";

export type RlpItem = Uint8Array | RlpItem[];

function readLength(input: Uint8Array, offset: number, lengthOfLength: number): number {
  let value = 0;
  for (let index = 0; index < lengthOfLength; index += 1) {
    const byte = input[offset + index];
    if (byte === undefined) invalidInput("RLP input is truncated inside a length prefix.");
    value = value * 256 + byte;
  }
  return value;
}

function decodeItem(input: Uint8Array, offset: number): { item: RlpItem; next: number } {
  const prefix = input[offset];
  if (prefix === undefined) invalidInput("RLP input is truncated.");

  const slice = (start: number, length: number): Uint8Array => {
    if (start + length > input.length) invalidInput("RLP input is truncated.");
    return input.slice(start, start + length);
  };

  if (prefix < 0x80) return { item: input.slice(offset, offset + 1), next: offset + 1 };
  if (prefix < 0xb8) {
    const length = prefix - 0x80;
    return { item: slice(offset + 1, length), next: offset + 1 + length };
  }
  if (prefix < 0xc0) {
    const lengthOfLength = prefix - 0xb7;
    const length = readLength(input, offset + 1, lengthOfLength);
    return {
      item: slice(offset + 1 + lengthOfLength, length),
      next: offset + 1 + lengthOfLength + length,
    };
  }

  const [payloadStart, payloadLength] = prefix < 0xf8
    ? [offset + 1, prefix - 0xc0]
    : (() => {
      const lengthOfLength = prefix - 0xf7;
      return [offset + 1 + lengthOfLength, readLength(input, offset + 1, lengthOfLength)] as const;
    })();

  const end = payloadStart + payloadLength;
  if (end > input.length) invalidInput("RLP input is truncated inside a list.");
  const items: RlpItem[] = [];
  let cursor = payloadStart;
  while (cursor < end) {
    const decoded = decodeItem(input, cursor);
    items.push(decoded.item);
    cursor = decoded.next;
  }
  if (cursor !== end) invalidInput("RLP list payload overruns its declared length.");
  return { item: items, next: end };
}

/** Decodes exactly one item and refuses trailing bytes: a proof node with slack in it is
 * not a node this package will walk. */
export function decodeRlp(input: Uint8Array): RlpItem {
  const { item, next } = decodeItem(input, 0);
  if (next !== input.length) invalidInput("RLP input carries trailing bytes.");
  return item;
}
