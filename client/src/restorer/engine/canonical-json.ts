/**
 * Canonical JSON serialisation — RFC 8785 JCS.
 *
 * Uses the `canonicalize` npm package (≈30 LOC, zero deps) so third-party
 * verifiers can reproduce our signing input with any standard JCS library.
 *
 * Rules per RFC 8785:
 * - Object keys sorted lexicographically by UTF-16 code-unit order.
 * - No insignificant whitespace.
 * - I-JSON number formatting (integer-preferred, scientific notation for
 *   values outside ±[1e-6, 1e21], -0 serialises as 0).
 * - String escape rules per JSON spec (control chars as \\uXXXX; only ", \
 *   and control chars must be escaped).
 * - `undefined` values in objects are dropped (matches JSON.stringify).
 * - `NaN` / `Infinity` serialise to `null` (matches JSON.stringify).
 *
 * BigInt is **not** supported — JCS is a canonicalization of standard JSON,
 * which has no BigInt type. Callers must convert BigInt to string or number
 * before calling. Passing BigInt throws.
 *
 * Used for manifest signing: produce a deterministic byte string that two
 * independent parties can reproduce from the same object graph.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const canonicalize = require('canonicalize') as (value: unknown) => string | undefined;

/**
 * Recursively replace NaN / ±Infinity with null so that canonicalize does not
 * throw — matching the JSON.stringify behaviour that the rest of the codebase
 * expects. BigInt is intentionally left unhandled so that canonicalize throws
 * a clear error when a caller passes one.
 */
function coerceNonFinite(value: unknown): unknown {
  if (typeof value === 'number' && !isFinite(value)) return null;
  if (Array.isArray(value)) return value.map(coerceNonFinite);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = coerceNonFinite(v);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const coerced = coerceNonFinite(value);

  const result = canonicalize(coerced);
  if (result === undefined) {
    // canonicalize returns undefined for top-level undefined input (matches
    // JSON.stringify). Match Jinn's previous behaviour: emit "null" so the
    // return type is always a string.
    return 'null';
  }
  return result;
}
