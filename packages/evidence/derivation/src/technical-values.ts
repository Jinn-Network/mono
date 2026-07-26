// SPDX-License-Identifier: Apache-2.0

export type TechnicalValueClass =
  | "digest"
  | "transaction-digest"
  | "cid"
  | "dsse-material"
  | "public-key"
  | "version"
  | "model-id";

const CREDENTIAL = /(?:sk-|ghp_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{4,}/;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function decodeBase32(value: string): Uint8Array | null {
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    accumulator = accumulator * 32 + digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push(Math.floor(accumulator / 2 ** bits) & 0xff);
      accumulator %= 2 ** bits;
    }
  }
  if (bits > 0 && accumulator !== 0) return null;
  return Uint8Array.from(bytes);
}

function readVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly next: number } | null {
  let value = 0;
  let multiplier = 1;
  for (let index = offset; index < bytes.length && index < offset + 9; index += 1) {
    const byte = bytes[index]!;
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) return null;
    if ((byte & 0x80) === 0) {
      if (index > offset && byte === 0) return null;
      return { value, next: index + 1 };
    }
    multiplier *= 128;
  }
  return null;
}

function isCidV1(value: string): boolean {
  if (!/^b[a-z2-7]+$/u.test(value)) return false;
  const bytes = decodeBase32(value.slice(1));
  if (!bytes) return false;
  const version = readVarint(bytes, 0);
  const codec = version && readVarint(bytes, version.next);
  const multihash = codec && readVarint(bytes, codec.next);
  const length = multihash && readVarint(bytes, multihash.next);
  return Boolean(
    version?.value === 1 &&
      codec &&
      codec.value > 0 &&
      multihash &&
      multihash.value > 0 &&
      length &&
      length.value > 0 &&
      length.next + length.value === bytes.length,
  );
}

function isCompletePemPublicKey(value: string): boolean {
  const match = value.match(
    /^-----BEGIN PUBLIC KEY-----\r?\n([\s\S]+)\r?\n-----END PUBLIC KEY-----\r?\n?$/u,
  );
  if (!match) return false;
  const body = match[1]!.replace(/\r?\n/gu, "");
  return (
    body.length > 0 &&
    body.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      body,
    )
  );
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  );
}

export function classifyTechnicalValue(
  value: string,
  context: { readonly field?: string },
): TechnicalValueClass | null {
  if (CREDENTIAL.test(value)) return null;
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return "digest";
  if (/^0x[a-fA-F0-9]{64}$/.test(value)) return "transaction-digest";
  if (isCidV1(value)) return "cid";
  if (isCompletePemPublicKey(value)) {
    return "public-key";
  }
  if (
    context.field === "payload" ||
    context.field === "sig" ||
    context.field === "signature"
  ) {
    return isCanonicalBase64(value) ? "dsse-material" : null;
  }
  if (
    context.field?.includes("version") ||
    context.field === "version" ||
    context.field === "packageVersion"
  ) {
    if (/^(?:v)?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)) {
      return "version";
    }
  }
  if (
    (context.field === "model" || context.field === "modelId") &&
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
  ) {
    return "model-id";
  }
  return null;
}
