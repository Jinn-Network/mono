import canonicalize from "canonicalize";
import { recordDigest } from "./hashing.js";

const encoder = new TextEncoder();

// Program ruling §7.14: every sealer rejects numbers that are not exactly
// representable I-JSON integers -- fractional or non-safe-integer quantities
// must be encoded as strings by the caller instead. `canonicalize` (RFC 8785
// JCS) already builds its object-key order via an explicit `Array#sort()`
// (UTF-16 code-unit order -- the same order `compareCodeUnitStrings` returns
// -- rather than relying on JS's own property-enumeration order, so integer-
// like keys like "10"/"2" already come out correctly ordered), but it does
// not itself reject fractional or unsafe numbers; that check is layered on
// top here.
function assertIJsonIntegers(value: unknown, path = "$"): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Value at ${path} must be a finite number.`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Value at ${path} must be an exact I-JSON safe integer -- fractional or ` +
          "non-safe-integer quantities must be encoded as strings (§7.14).",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => assertIJsonIntegers(element, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, member] of Object.entries(value)) {
      assertIJsonIntegers(member, `${path}.${key}`);
    }
  }
}

export function sealJson(value: unknown): { bytes: Uint8Array; digest: `sha256:${string}` } {
  assertIJsonIntegers(value);
  const encoded = canonicalize(value);
  if (encoded === undefined) {
    throw new Error("Value cannot be serialized as canonical JSON.");
  }
  const bytes = encoder.encode(encoded);
  return { bytes, digest: recordDigest(bytes) };
}
