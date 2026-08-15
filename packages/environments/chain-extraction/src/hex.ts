// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { invalidInput } from "./errors.js";

/** 20-byte account address, lowercase, always 0x-prefixed. */
export type HexAddress = string;
/** 32-byte value: storage slot key, storage value, hash, state root. */
export type Hex32 = string;
/** A quantity in minimal hex form (`0x0`, `0xde0b6b3a7640000`) -- never padded. */
export type HexQuantity = string;
/** Arbitrary-length byte string (contract code, a proof node). */
export type HexBytes = string;

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u;
const HEX32_PATTERN = /^0x[0-9a-f]{64}$/u;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-f][0-9a-f]*)$/u;
const BYTES_PATTERN = /^0x(?:[0-9a-f]{2})*$/u;

export const HexAddressSchema = z.string().regex(ADDRESS_PATTERN);
export const Hex32Schema = z.string().regex(HEX32_PATTERN);
export const HexQuantitySchema = z.string().regex(QUANTITY_PATTERN);
export const HexBytesSchema = z.string().regex(BYTES_PATTERN);

function body(value: string, label: string): string {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    invalidInput(`${label} must be a 0x-prefixed hex string; received "${String(value)}".`);
  }
  const rest = value.slice(2);
  if (!/^[0-9a-fA-F]*$/u.test(rest)) {
    invalidInput(`${label} contains a non-hex character: "${value}".`);
  }
  return rest.toLowerCase();
}

export function normalizeAddress(value: string): HexAddress {
  const hex = body(value, "An address");
  if (hex.length !== 40) invalidInput(`An address must be 20 bytes; received "${value}".`);
  return `0x${hex}`;
}

/**
 * Storage keys are left-padded to 32 bytes. Providers are inconsistent about this
 * (`eth_getProof` echoes what it was given, `anvil_dumpState` pads), and one unpadded
 * key silently splits a slot into two keys -- which reads as "missing state" forever.
 */
export function normalizeSlot(value: string): Hex32 {
  const hex = body(value, "A storage key");
  if (hex.length > 64) invalidInput(`A storage key must be at most 32 bytes; received "${value}".`);
  return `0x${hex.padStart(64, "0")}`;
}

/** 32-byte values (hashes, roots, storage values) keep their full width. */
export function normalizeHex32(value: string): Hex32 {
  const hex = body(value, "A 32-byte value");
  if (hex.length > 64) invalidInput(`A 32-byte value is too wide; received "${value}".`);
  return `0x${hex.padStart(64, "0")}`;
}

/** Quantities are minimal: no leading zeros, `0x0` for zero. */
export function normalizeQuantity(value: string): HexQuantity {
  const hex = body(value, "A quantity");
  if (hex.length === 0) invalidInput(`A quantity must have at least one digit; received "${value}".`);
  const trimmed = hex.replace(/^0+/u, "");
  return `0x${trimmed === "" ? "0" : trimmed}`;
}

export function normalizeBytes(value: string): HexBytes {
  const hex = body(value, "A byte string");
  if (hex.length % 2 !== 0) invalidInput(`A byte string must have whole bytes; received "${value}".`);
  return `0x${hex}`;
}

export function isEmptyBytes(value: HexBytes): boolean {
  return value === "0x";
}
