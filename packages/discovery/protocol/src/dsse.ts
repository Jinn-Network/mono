// Ported verbatim from `packages/evidence/protocol/src/claims.ts`'s
// `dssePreAuthEncoding`, `concatenate`, and `ascii` helpers (also carried
// byte-identically by `trust-core`'s `dssePreAuthEncoding`, per program
// ruling §7.1 -- the stack has one DSSE pre-auth encoding, re-implemented
// per package).

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

export interface WireDsseEnvelopeSignature {
  readonly keyid?: string;
  readonly sig: string;
}

export interface WireDsseEnvelope {
  readonly payloadType: string;
  readonly payload: string;
  readonly signatures: readonly WireDsseEnvelopeSignature[];
}

export interface ParsedWireDsseEnvelope {
  readonly envelope: WireDsseEnvelope;
  readonly payloadBytes: Uint8Array;
  readonly signatures: readonly {
    readonly keyid?: string;
    readonly signatureBytes: Uint8Array;
  }[];
}

function canonicalStandardBase64(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${label} is not canonical standard base64`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`${label} is not canonical standard base64`);
  }
  let roundTrip = "";
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  for (const byte of bytes) roundTrip += String.fromCharCode(byte);
  if (btoa(roundTrip) !== value) throw new Error(`${label} is not canonical standard base64`);
  return bytes;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/** Strict parser for the one published discovery DSSE wire representation. */
export function parseWireDsseEnvelope(value: unknown): ParsedWireDsseEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["payload", "payloadType", "signatures"])) {
    throw new Error("wire DSSE envelope must contain exactly payload, payloadType, and signatures");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["payloadType"] !== "string" || raw["payloadType"].length === 0) {
    throw new Error("wire DSSE envelope payloadType must be a non-empty string");
  }
  const payloadBytes = canonicalStandardBase64(raw["payload"], "wire DSSE payload");
  if (!Array.isArray(raw["signatures"]) || raw["signatures"].length === 0) {
    throw new Error("wire DSSE envelope requires at least one signature");
  }
  const decoded = raw["signatures"].map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`wire DSSE signature ${index} must be an object`);
    }
    const signature = candidate as Record<string, unknown>;
    const expected = signature["keyid"] === undefined ? ["sig"] : ["keyid", "sig"];
    if (!exactKeys(signature, expected)) {
      throw new Error(`wire DSSE signature ${index} must contain exactly sig and optional keyid`);
    }
    if (signature["keyid"] !== undefined && typeof signature["keyid"] !== "string") {
      throw new Error(`wire DSSE signature ${index} keyid must be a string`);
    }
    return {
      ...(signature["keyid"] === undefined ? {} : { keyid: signature["keyid"] as string }),
      signatureBytes: canonicalStandardBase64(signature["sig"], `wire DSSE signature ${index}`),
    };
  });
  const envelope: WireDsseEnvelope = {
    payloadType: raw["payloadType"] as string,
    payload: raw["payload"] as string,
    signatures: (raw["signatures"] as Record<string, unknown>[]).map((signature) => ({
      ...(signature["keyid"] === undefined ? {} : { keyid: signature["keyid"] as string }),
      sig: signature["sig"] as string,
    })),
  };
  return { envelope, payloadBytes, signatures: decoded };
}
