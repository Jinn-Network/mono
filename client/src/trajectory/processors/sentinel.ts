/**
 * Sentinel pattern shared by scrub-aware processors (manifest-builder,
 * sqlite-exporter). Any string attribute value matching this pattern is
 * treated as a redaction placeholder produced upstream by an identity-,
 * path-, or credential-scrub processor.
 *
 * Recognised placeholders include `<USER>`, `<HOST>`, `<MACHINE>`,
 * `<EMAIL>`, `<AUTHOR>`, `<IPV4>`, `<REDACTED>` — the digit class is
 * required for `<IPV4>`.
 *
 * Both processors MUST use this constant rather than defining their own,
 * because they need to agree on what counts as redacted: manifest-builder
 * records the keys, sqlite-exporter increments redactedSpanCount, and a
 * silent disagreement between them would corrupt the audit trail.
 */
export const SENTINEL_PATTERN = /^<[A-Z0-9_]+>$/;
