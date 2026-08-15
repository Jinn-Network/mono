// SPDX-License-Identifier: Apache-2.0

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

import { invalidInput } from "./errors.js";

const UINT_BITS = new Set([8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224, 232, 240, 248, 256]);
const WORD = 32;

const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/u, "must be a lowercase 0x address");
const HexBytesSchema = z.string().regex(/^0x(?:[0-9a-f]{2})*$/u, "must be lowercase 0x bytes");

const AbiScalarTypeSchema = z.union([
  z.literal("address"),
  z.literal("bool"),
  z.literal("bytes"),
  z.literal("string"),
  z.string().regex(/^bytes([1-9]|[12][0-9]|3[0-2])$/u),
  z.string().regex(/^u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)$/u),
]);

const AbiValueTypeSchema = z.string().superRefine((type, ctx) => {
  if (!isAbiValueType(type)) {
    ctx.addIssue({ code: "custom", message: `unsupported ABI type: ${type}` });
  }
});

export { AbiValueTypeSchema };

export type AbiValue = string | readonly AbiValue[];

type ParsedType =
  | { kind: "scalar"; type: string }
  | { kind: "dynamic-array"; element: string }
  | { kind: "static-array"; element: string; length: number };

function isAbiValueType(type: string): boolean {
  const staticMatch = /^(.+)\[(\d+)\]$/.exec(type);
  if (staticMatch) return isAbiValueType(staticMatch[1]!);
  if (type.endsWith("[]")) return isAbiValueType(type.slice(0, -2));
  return AbiScalarTypeSchema.safeParse(type).success;
}

function parseElementType(type: string): string {
  const staticMatch = /^(.+)\[(\d+)\]$/.exec(type);
  if (staticMatch) return staticMatch[1]!;
  if (type.endsWith("[]")) return type.slice(0, -2);
  return type;
}

function parseAbiType(type: string): ParsedType {
  if (!isAbiValueType(type)) invalidInput(`unsupported ABI type: ${type}`);
  const staticMatch = /^(.+)\[(\d+)\]$/.exec(type);
  if (staticMatch) {
    return {
      kind: "static-array",
      element: staticMatch[1]!,
      length: Number(staticMatch[2]),
    };
  }
  if (type.endsWith("[]")) {
    return { kind: "dynamic-array", element: type.slice(0, -2) };
  }
  return { kind: "scalar", type };
}

function isDynamicType(parsed: ParsedType): boolean {
  if (parsed.kind === "dynamic-array") return true;
  if (parsed.kind === "static-array") return isDynamicType(parseAbiType(parsed.element));
  return parsed.type === "bytes" || parsed.type === "string";
}

function parseSignatureParams(signature: string): readonly string[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close < open) invalidInput(`invalid function signature: ${signature}`);
  const inner = signature.slice(open + 1, close);
  if (inner.length === 0) return [];
  return inner.split(",");
}

function assertArgCount(signature: string, types: readonly string[], values: readonly AbiValue[]): void {
  const params = parseSignatureParams(signature);
  if (params.length !== types.length) {
    invalidInput(`signature "${signature}" declares ${params.length} parameter(s); ${types.length} type(s) supplied.`);
  }
  if (types.length !== values.length) {
    invalidInput(`expected ${types.length} argument value(s); received ${values.length}.`);
  }
  for (let i = 0; i < types.length; i++) {
    if (params[i] !== types[i]) {
      invalidInput(`argument ${i} type "${types[i]}" does not match signature parameter "${params[i]}".`);
    }
  }
}

function encodeSelector(signature: string): Uint8Array {
  const hash = keccak_256(new TextEncoder().encode(signature));
  return hash.slice(0, 4);
}

function wordFromBigInt(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) invalidInput(`uint256 out of range: ${value}`);
  const out = new Uint8Array(WORD);
  let v = value;
  for (let i = WORD - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function wordFromSigned(value: bigint, bits: number): Uint8Array {
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (value < min || value > max) invalidInput(`int${bits} out of range: ${value}`);
  const mask = (1n << 256n) - 1n;
  const encoded = value < 0n ? ((1n << 256n) + value) & mask : value;
  return wordFromBigInt(encoded);
}

function parseUintBits(type: string): number {
  const match = /^uint(\d+)$/.exec(type);
  if (!match) invalidInput(`expected unsigned integer type, got ${type}`);
  const bits = Number(match[1]);
  if (!UINT_BITS.has(bits)) invalidInput(`unsupported uint width: ${type}`);
  return bits;
}

function parseIntBits(type: string): number {
  const match = /^int(\d+)$/.exec(type);
  if (!match) invalidInput(`expected signed integer type, got ${type}`);
  const bits = Number(match[1]);
  if (!UINT_BITS.has(bits)) invalidInput(`unsupported int width: ${type}`);
  return bits;
}

function parseDecimal(value: string, type: string): bigint {
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) invalidInput(`invalid decimal for ${type}: ${value}`);
  return BigInt(value);
}

function parseHexBytes(value: string): Uint8Array {
  if (!HexBytesSchema.safeParse(value).success) invalidInput(`invalid hex bytes: ${value}`);
  return hexToBytes(value.slice(2));
}

function parseAddress(value: string): Uint8Array {
  if (!AddressSchema.safeParse(value).success) invalidInput(`invalid address: ${value}`);
  const out = new Uint8Array(WORD);
  out.set(hexToBytes(value.slice(2)), WORD - 20);
  return out;
}

function parseBool(value: string): Uint8Array {
  if (value !== "true" && value !== "false") invalidInput(`invalid bool: ${value}`);
  return wordFromBigInt(value === "true" ? 1n : 0n);
}

function parseBytesN(type: string, value: string): Uint8Array {
  const match = /^bytes(\d+)$/.exec(type);
  if (!match) invalidInput(`expected bytesN type, got ${type}`);
  const width = Number(match[1]);
  const bytes = parseHexBytes(value);
  if (bytes.length !== width) invalidInput(`${type} expects ${width} byte(s); got ${bytes.length}`);
  const out = new Uint8Array(WORD);
  out.set(bytes, 0);
  return out;
}

function encodeDynamicBytes(value: string): Uint8Array {
  const bytes = parseHexBytes(value);
  const lengthWord = wordFromBigInt(BigInt(bytes.length));
  const paddedLength = Math.ceil(bytes.length / WORD) * WORD;
  const body = new Uint8Array(paddedLength);
  body.set(bytes, 0);
  return concatBytes(lengthWord, body);
}

function encodeDynamicString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const lengthWord = wordFromBigInt(BigInt(bytes.length));
  const paddedLength = Math.ceil(bytes.length / WORD) * WORD;
  const body = new Uint8Array(paddedLength);
  body.set(bytes, 0);
  return concatBytes(lengthWord, body);
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeScalarWord(type: string, value: AbiValue): Uint8Array {
  if (typeof value !== "string") invalidInput(`${type} expects a scalar value`);
  if (type === "address") return parseAddress(value);
  if (type === "bool") return parseBool(value);
  if (type === "bytes") invalidInput("dynamic bytes must be encoded through the tuple encoder");
  if (type === "string") invalidInput("string must be encoded through the tuple encoder");
  if (type.startsWith("bytes")) return parseBytesN(type, value);
  if (type.startsWith("uint")) {
    const bits = parseUintBits(type);
    const numeric = parseDecimal(value, type);
    const max = (1n << BigInt(bits)) - 1n;
    if (numeric < 0n || numeric > max) invalidInput(`${type} out of range: ${value}`);
    return wordFromBigInt(numeric);
  }
  if (type.startsWith("int")) {
    const bits = parseIntBits(type);
    return wordFromSigned(parseDecimal(value, type), bits);
  }
  invalidInput(`unsupported scalar type: ${type}`);
}

function encodeStaticArray(type: string, value: AbiValue): Uint8Array[] {
  const parsed = parseAbiType(type);
  if (parsed.kind !== "static-array") invalidInput(`expected static array type: ${type}`);
  if (!Array.isArray(value) || value.length !== parsed.length) {
    invalidInput(`${type} expects ${parsed.length} element(s)`);
  }
  const words: Uint8Array[] = [];
  for (const element of value) {
    if (isDynamicType(parseAbiType(parsed.element))) {
      invalidInput(`static array of dynamic element is not supported: ${type}`);
    }
    const elementParsed = parseAbiType(parsed.element);
    if (elementParsed.kind === "static-array") {
      words.push(...encodeStaticArray(parsed.element, element));
    } else {
      words.push(encodeScalarWord(parsed.element, element));
    }
  }
  return words;
}

function encodeDynamicArray(type: string, value: AbiValue): Uint8Array {
  const parsed = parseAbiType(type);
  if (parsed.kind !== "dynamic-array") invalidInput(`expected dynamic array type: ${type}`);
  if (!Array.isArray(value)) invalidInput(`${type} expects an array value`);
  const elementType = parseAbiType(parsed.element);
  const lengthWord = wordFromBigInt(BigInt(value.length));
  if (!isDynamicType(elementType)) {
    const words: Uint8Array[] = [lengthWord];
    for (const element of value) {
      if (elementType.kind === "static-array") {
        words.push(...encodeStaticArray(parsed.element, element));
      } else {
        words.push(encodeScalarWord(parsed.element, element));
      }
    }
    return concatBytes(...words);
  }

  const head: Uint8Array[] = [lengthWord];
  const tail: Uint8Array[] = [];
  let dataCursor = value.length * WORD;
  for (const element of value) {
    head.push(wordFromBigInt(BigInt(dataCursor)));
    const encoded = encodeValue(parsed.element, element);
    tail.push(encoded);
    dataCursor += encoded.length;
  }
  return concatBytes(...head, ...tail);
}

function encodeValue(type: string, value: AbiValue): Uint8Array {
  const parsed = parseAbiType(type);
  if (parsed.kind === "static-array") return concatBytes(...encodeStaticArray(type, value));
  if (parsed.kind === "dynamic-array") return encodeDynamicArray(type, value);
  if (parsed.type === "bytes") return encodeDynamicBytes(value as string);
  if (parsed.type === "string") return encodeDynamicString(value as string);
  return encodeScalarWord(parsed.type, value);
}

function tupleHeadByteLength(types: readonly string[]): number {
  let words = 0;
  for (const type of types) {
    const parsed = parseAbiType(type);
    if (isDynamicType(parsed)) {
      words += 1;
      continue;
    }
    if (parsed.kind === "static-array") {
      const elementParsed = parseAbiType(parsed.element);
      if (isDynamicType(elementParsed)) invalidInput(`static array of dynamic element is not supported: ${type}`);
      words += parsed.length * (elementParsed.kind === "static-array" ? tupleHeadByteLength([parsed.element]) / WORD : 1);
      continue;
    }
    words += 1;
  }
  return words * WORD;
}

function encodeTuple(types: readonly string[], values: readonly AbiValue[]): Uint8Array {
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  const headBytes = tupleHeadByteLength(types);
  let tailBytes = 0;
  for (let i = 0; i < types.length; i++) {
    const type = types[i]!;
    const value = values[i]!;
    const parsed = parseAbiType(type);
    if (isDynamicType(parsed)) {
      head.push(wordFromBigInt(BigInt(headBytes + tailBytes)));
      const encoded = encodeValue(type, value);
      tail.push(encoded);
      tailBytes += encoded.length;
      continue;
    }
    if (parsed.kind === "static-array") {
      head.push(...encodeStaticArray(type, value));
      continue;
    }
    if (parsed.kind === "scalar") {
      head.push(encodeScalarWord(parsed.type, value));
      continue;
    }
    invalidInput(`unsupported tuple element type: ${type}`);
  }
  return concatBytes(...head, ...tail);
}

export function encodeAbiCall(
  signature: string,
  types: readonly string[],
  values: readonly AbiValue[],
): string {
  assertArgCount(signature, types, values);
  const selector = encodeSelector(signature);
  const args = types.length === 0 ? new Uint8Array(0) : encodeTuple(types, values);
  return `0x${bytesToHex(concatBytes(selector, args))}`;
}

function readWord(data: Uint8Array, offset: number): Uint8Array {
  if (offset + WORD > data.length) invalidInput("return data truncated");
  return data.slice(offset, offset + WORD);
}

function wordToBigInt(word: Uint8Array): bigint {
  let value = 0n;
  for (const byte of word) value = (value << 8n) + BigInt(byte);
  return value;
}

function wordToSigned(word: Uint8Array, bits: number): bigint {
  const value = wordToBigInt(word);
  const signBit = 1n << BigInt(bits - 1);
  const mask = (1n << BigInt(bits)) - 1n;
  const truncated = value & mask;
  if (truncated >= signBit) return truncated - (1n << BigInt(bits));
  return truncated;
}

function formatUint(value: bigint): string {
  return value.toString(10);
}

function formatInt(value: bigint): string {
  return value.toString(10);
}

function formatAddress(word: Uint8Array): string {
  return `0x${bytesToHex(word.slice(WORD - 20))}`;
}

function formatBool(word: Uint8Array): string {
  return wordToBigInt(word) === 0n ? "false" : "true";
}

function formatBytesN(type: string, word: Uint8Array): string {
  const width = Number(/^bytes(\d+)$/.exec(type)![1]);
  return `0x${bytesToHex(word.slice(0, width))}`;
}

function decodeScalar(type: string, word: Uint8Array): string {
  if (type === "address") return formatAddress(word);
  if (type === "bool") return formatBool(word);
  if (type.startsWith("bytes")) return formatBytesN(type, word);
  if (type.startsWith("uint")) return formatUint(wordToBigInt(word));
  if (type.startsWith("int")) return formatInt(wordToSigned(word, parseIntBits(type)));
  invalidInput(`unsupported scalar return type: ${type}`);
}


function decodeValue(
  type: string,
  data: Uint8Array,
  offset: number,
  absolute = false,
): { value: string | string[]; next: number } {
  const parsed = parseAbiType(type);
  if (parsed.kind === "scalar" && !isDynamicType(parsed)) {
    const word = readWord(data, offset);
    return { value: decodeScalar(parsed.type, word), next: offset + WORD };
  }

  if (parsed.kind === "static-array") {
    const values: string[] = [];
    let cursor = offset;
    for (let i = 0; i < parsed.length; i++) {
      const decoded = decodeValue(parsed.element, data, cursor, true);
      if (Array.isArray(decoded.value)) {
        values.push(...decoded.value);
      } else {
        values.push(decoded.value);
      }
      cursor = decoded.next;
    }
    return { value: values, next: cursor };
  }

  let cursor = offset;
  if (!absolute) {
    const base = Number(wordToBigInt(readWord(data, offset)));
    if (base + WORD > data.length) invalidInput("return offset out of range");
    cursor = base;
  }

  if (parsed.kind === "dynamic-array") {
    const length = Number(wordToBigInt(readWord(data, cursor)));
    cursor += WORD;
    const values: string[] = [];
    const elementParsed = parseAbiType(parsed.element);
    if (!isDynamicType(elementParsed)) {
      for (let i = 0; i < length; i++) {
        const decoded = decodeValue(parsed.element, data, cursor, true);
        values.push(decoded.value as string);
        cursor = decoded.next;
      }
      return { value: values, next: absolute ? cursor : offset + WORD };
    }
    const offsets: number[] = [];
    const offsetRegion = cursor;
    for (let i = 0; i < length; i++) {
      offsets.push(offsetRegion + Number(wordToBigInt(readWord(data, offsetRegion + i * WORD))));
    }
    for (const elementOffset of offsets) {
      const decoded = decodeValue(parsed.element, data, elementOffset, true);
      values.push(decoded.value as string);
    }
    return { value: values, next: absolute ? cursor + length * WORD : offset + WORD };
  }

  if (parsed.type === "bytes" || parsed.type === "string") {
    const length = Number(wordToBigInt(readWord(data, cursor)));
    cursor += WORD;
    const bytes = data.slice(cursor, cursor + length);
    const paddedLength = Math.ceil(length / WORD) * WORD;
    if (parsed.type === "bytes") {
      return {
        value: `0x${bytesToHex(bytes)}`,
        next: absolute ? cursor + paddedLength : offset + WORD,
      };
    }
    return {
      value: new TextDecoder().decode(bytes),
      next: absolute ? cursor + paddedLength : offset + WORD,
    };
  }

  invalidInput(`cannot decode type: ${type}`);
}

export function decodeAbiReturn(types: readonly string[], returnData: string): readonly string[] {
  if (returnData === "0x" || returnData.length === 2) {
    if (types.length === 0) return [];
    invalidInput("empty return data");
  }
  if (!HexBytesSchema.safeParse(returnData).success) invalidInput(`invalid return data: ${returnData}`);
  const data = hexToBytes(returnData.slice(2));
  if (data.length % WORD !== 0) invalidInput("return data length is not word-aligned");
  if (data.length >= 4 && data[0] === 0x08 && data[1] === 0xc3 && data[2] === 0x79 && data[3] === 0xa0) {
    invalidInput("call reverted");
  }

  const values: string[] = [];
  let headOffset = 0;
  for (const type of types) {
    const parsed = parseAbiType(type);
    if (isDynamicType(parsed)) {
      const decoded = decodeValue(type, data, headOffset);
      values.push(Array.isArray(decoded.value) ? JSON.stringify(decoded.value) : decoded.value);
      headOffset += WORD;
      continue;
    }
    const decoded = decodeValue(type, data, headOffset);
    values.push(Array.isArray(decoded.value) ? JSON.stringify(decoded.value) : decoded.value);
    headOffset = decoded.next;
  }
  return values;
}
