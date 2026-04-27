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

/**
 * Walk a flat attribute map and replace secret values with a marker.
 * Returns a new object plus the list of keys that were redacted.
 */
export function scrubAttributes<T extends Record<string, unknown>>(
  attrs: T,
): { scrubbed: Record<string, unknown>; redactedKeys: string[] } {
  const scrubbed: Record<string, unknown> = { ...attrs };
  const redactedKeys: string[] = [];
  for (const [k, _v] of Object.entries(attrs)) {
    if (isSecretKey(k)) {
      scrubbed[k] = `<redacted:${k}>`;
      redactedKeys.push(k);
    }
  }
  return { scrubbed, redactedKeys };
}

/**
 * Scrub MCP tool call arguments by argument name. V1 is top-level-only;
 * deep recursion is Plan F tightening.
 */
export function scrubMcpArgs(
  args: Record<string, unknown>,
): { scrubbed: Record<string, unknown>; redactedKeys: string[] } {
  return scrubAttributes(args);
}
