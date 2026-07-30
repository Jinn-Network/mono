import { sha1 } from "@noble/hashes/legacy.js"; // @noble/hashes v2 exposes sha1 here; verified at install
import { compareCodeUnitStrings } from "./order.js";

// Fixed TEP Attempt-URI namespace: a v5 UUID over the RFC 4122 "URL" namespace
// (6ba7b811-9dad-11d1-80b4-00c04fd430c8) and the name "jinn.network/task-execution/attempt".
// EXPORTED (program §7.2): the marketplace binding consumes this constant; it never re-derives
// its own. Computed once and frozen; pinned by identifiers.test.ts.
export const TEP_ATTEMPT_NAMESPACE = "158601b2-0cad-5f8b-89f2-c4a36f79fc78";

// Frozen name-construction delimiter (program §7.2): the ASCII unit separator (U+001F), a
// control char that cannot appear in the parts, so variable-length parts never concatenate
// ambiguously.
const NAME_UNIT_SEPARATOR = "\u001f";

const UUID_RE =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidUrnUuid(uri: string): boolean {
  return UUID_RE.test(uri);
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function formatUuid(b: Uint8Array): string {
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function deriveAttemptUri(
  bindingName: string,
  correlationTuple: readonly (string | number)[],
): `urn:uuid:${string}` {
  // Frozen deterministic name (§7.2): bindingName + tuple parts, unit-separator-delimited so
  // variable-length parts never concatenate ambiguously.
  const name = [bindingName, ...correlationTuple.map(String)].join(NAME_UNIT_SEPARATOR);
  const input = new Uint8Array([...uuidBytes(TEP_ATTEMPT_NAMESPACE), ...new TextEncoder().encode(name)]);
  const hash = sha1(input).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  return `urn:uuid:${formatUuid(hash)}`;
}

// compareCodeUnitStrings re-exported for callers assembling deterministic tuples.
export { compareCodeUnitStrings };
