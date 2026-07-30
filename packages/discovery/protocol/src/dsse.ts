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
