/**
 * V1 minimum secret-scrub conformance.
 *
 * Scope: §4.3 bullet — "attribute-name allowlist drops values for known
 * credential fields (*.authorization, *.apiKey, *.bearer, *.password,
 * *.secret, *.token, *.privateKey, plus MCP tool args matching these
 * patterns). Scrubbed attributes are replaced with <redacted:name>
 * markers; a run-level redaction manifest records *which* fields were
 * scrubbed (not values) and is signed alongside spans."
 *
 * This is safety, not access control. IP-protection redaction lives in
 * the deferred gating epic per scope §5.
 */

/** V1 pattern set. Case-insensitive; matches at end-of-key or after a dot. */
export const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /(^|\.)authorization$/i,
  /(^|\.)apikey$/i,
  /(^|\.)api[_-]?key$/i,
  /(^|\.)bearer$/i,
  /(^|\.)password$/i,
  /(^|\.)secret$/i,
  /(^|\.)token$/i,
  /(^|\.)privatekey$/i,
  /(^|\.)private[_-]?key$/i,
];

export function isSecretKey(key: string): boolean {
  return SECRET_NAME_PATTERNS.some((p) => p.test(key));
}

/** True for a plain `{}` object (not null, not an array, not a class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively scrub a single (path, value) pair. `path` is the dotted key
 * path from the root (e.g. `tool.args.apiKey`) and is what gets matched
 * against SECRET_NAME_PATTERNS and recorded in redactedKeys — this is what
 * lets a nested secret-named key (`tool.args: { apiKey: ... }`) be caught
 * even though the top-level attribute key (`tool.args`) is not itself
 * secret-named (#1473 finding 2). Arrays reuse the parent path for their
 * items (mirrors scrub/pipeline.ts's scrubNested) since array indices carry
 * no key-name information to classify against. Non-plain objects (class
 * instances, Buffers, etc.) pass through untouched.
 */
function scrubValue(path: string, value: unknown): { value: unknown; redactedKeys: string[] } {
  if (isSecretKey(path)) {
    return { value: `<redacted:${path}>`, redactedKeys: [path] };
  }
  if (Array.isArray(value)) {
    const redactedKeys: string[] = [];
    const out = value.map((item) => {
      const res = scrubValue(path, item);
      redactedKeys.push(...res.redactedKeys);
      return res.value;
    });
    return { value: out, redactedKeys };
  }
  if (isPlainObject(value)) {
    const redactedKeys: string[] = [];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const res = scrubValue(`${path}.${k}`, v);
      redactedKeys.push(...res.redactedKeys);
      out[k] = res.value;
    }
    return { value: out, redactedKeys };
  }
  return { value, redactedKeys: [] };
}

/**
 * Walk an attribute map — including nested objects/arrays — and replace
 * secret-named-key values with a marker. Returns a new object plus the list
 * of dotted key paths that were redacted.
 */
export function scrubAttributes<T extends Record<string, unknown>>(
  attrs: T,
): { scrubbed: Record<string, unknown>; redactedKeys: string[] } {
  const scrubbed: Record<string, unknown> = {};
  const redactedKeys: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    const res = scrubValue(k, v);
    scrubbed[k] = res.value;
    redactedKeys.push(...res.redactedKeys);
  }
  return { scrubbed, redactedKeys };
}

/** Scrub MCP tool call arguments by argument name, recursively (#1473 finding 2). */
export function scrubMcpArgs(
  args: Record<string, unknown>,
): { scrubbed: Record<string, unknown>; redactedKeys: string[] } {
  return scrubAttributes(args);
}
