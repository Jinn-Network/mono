// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes } from "./canonical-json.js";
import { invalidInput } from "./errors.js";
import { DSSE_PAYLOAD_TYPE } from "./identifiers.js";

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/**
 * DSSE v1 pre-authentication encoding (PAE) -- the bytes actually signed for
 * a DSSE envelope. Ported verbatim from
 * `packages/evidence/protocol/src/claims.ts`.
 */
export function dssePreAuthEncoding(
  payloadType: string,
  payloadBytes: Uint8Array,
): Uint8Array {
  const typeBytes = new TextEncoder().encode(payloadType);
  return concatenate([
    ascii("DSSEv1 "),
    ascii(String(typeBytes.length)),
    ascii(" "),
    typeBytes,
    ascii(" "),
    ascii(String(payloadBytes.length)),
    ascii(" "),
    payloadBytes,
  ]);
}

// trust-core is I/O-free and imports nothing beyond @noble/hashes,
// @noble/curves, and zod (no node:buffer) -- base64 (de)coding uses only the
// `btoa`/`atob` globals, which are available in both Node and browsers.
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Strict base64 decode -- accepts only well-formed standard or URL-safe
 * base64 (not a mixture of both alphabets, correctly padded), rejecting
 * loose inputs `atob` alone would otherwise accept. Ported verbatim from
 * `packages/evidence/protocol/src/claims.ts`.
 */
function decodeBase64Strict(value: string): Uint8Array | undefined {
  if (value.length === 0 || /\s/.test(value)) return undefined;
  const hasStandard = /[+/]/.test(value);
  const hasUrlSafe = /[-_]/.test(value);
  if (hasStandard && hasUrlSafe) return undefined;
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) return undefined;
  const firstPadding = value.indexOf("=");
  if (firstPadding >= 0 && firstPadding < value.length - 2) return undefined;
  if (firstPadding >= 0 && value.length % 4 !== 0) return undefined;

  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return undefined;
  const normalized = unpadded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export interface DsseEnvelopeSignature {
  readonly keyid?: string;
  readonly sig: string;
}

export interface DsseEnvelope {
  readonly payloadType: string;
  readonly payload: string;
  readonly signatures: readonly DsseEnvelopeSignature[];
}

export interface DsseProducedSignature {
  readonly signature: Uint8Array;
  readonly keyid?: string;
}

export interface SealDsseEnvelopeInput {
  readonly payloadBytes: Uint8Array;
  readonly signatures: readonly [DsseProducedSignature, ...DsseProducedSignature[]];
}

/**
 * Seals a DSSE envelope over already-serialized payload bytes: canonicalizes
 * `{ payloadType, payload: base64(payloadBytes), signatures }` via
 * `canonicalJsonBytes`. Callers sign
 * `dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes)` to produce each
 * signature before calling this.
 */
export function sealDsseEnvelope(input: SealDsseEnvelopeInput): Uint8Array {
  if (input.signatures.length === 0) {
    invalidInput("A DSSE envelope requires at least one signature.");
  }
  const envelope: DsseEnvelope = {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: encodeBase64(input.payloadBytes),
    signatures: input.signatures.map((signature) => ({
      ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
      sig: encodeBase64(signature.signature),
    })),
  };
  return canonicalJsonBytes(envelope);
}

export interface ParsedDsseEnvelope {
  readonly payloadType: string;
  readonly payloadBytes: Uint8Array;
  readonly signatures: readonly DsseEnvelopeSignature[];
}

/** Parses and strictly base64-decodes a sealed DSSE envelope's bytes. */
export function parseDsseEnvelope(bytes: Uint8Array): ParsedDsseEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    invalidInput("DSSE envelope bytes are not valid UTF-8 JSON.", cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalidInput("DSSE envelope must be a JSON object.");
  }
  const envelope = parsed as Record<string, unknown>;

  if (typeof envelope["payloadType"] !== "string") {
    invalidInput("DSSE envelope payloadType must be a string.");
  }
  if (typeof envelope["payload"] !== "string") {
    invalidInput("DSSE envelope payload must be a string.");
  }
  const payloadBytes = decodeBase64Strict(envelope["payload"] as string);
  if (!payloadBytes) {
    invalidInput("DSSE envelope payload is not strict standard or URL-safe base64.");
  }
  if (!Array.isArray(envelope["signatures"]) || envelope["signatures"].length === 0) {
    invalidInput("DSSE envelope requires at least one signature.");
  }
  const signatures = (envelope["signatures"] as unknown[]).map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      invalidInput(`DSSE envelope signature ${index} must be an object.`);
    }
    const signature = raw as Record<string, unknown>;
    if (typeof signature["sig"] !== "string" || !decodeBase64Strict(signature["sig"])) {
      invalidInput(`DSSE envelope signature ${index} is not strict standard or URL-safe base64.`);
    }
    if (signature["keyid"] !== undefined && typeof signature["keyid"] !== "string") {
      invalidInput(`DSSE envelope signature ${index} keyid must be a string.`);
    }
    return {
      ...(signature["keyid"] === undefined ? {} : { keyid: signature["keyid"] as string }),
      sig: signature["sig"] as string,
    };
  });

  return {
    payloadType: envelope["payloadType"] as string,
    payloadBytes,
    signatures,
  };
}
