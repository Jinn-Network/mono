/**
 * Shared attribute helpers for transcript-to-spans parsers (DR-2026-07-14,
 * issue #1473). Both in-repo parsers (claude-code-stream-json.ts,
 * codex-exec-json.ts) truncate string leaves the same way and stamp the same
 * jinn.transcript.* provenance triplet — factored out here so a third parser
 * reuses this instead of a third copy.
 */

/**
 * Cap on individual string-leaf attribute values (message.content, tool.args
 * leaves, tool.result) at parse time. The raw, untruncated transcript remains
 * available separately in system_snapshot (DR-2026-07-14 "Raw and typed") —
 * this cap only bounds what rides the typed trajectory span.
 */
const MAX_ATTR_LENGTH = 8000;

export function truncate(s: string): string {
  return s.length > MAX_ATTR_LENGTH ? s.slice(0, MAX_ATTR_LENGTH) : s;
}

/** Recursively truncate string leaves of an object/array value (for tool.args). */
export function truncateLeaves(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value);
  if (Array.isArray(value)) return value.map(truncateLeaves);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateLeaves(v);
    return out;
  }
  return value;
}

/** Builds the jinn.transcript.* provenance attribute triplet recorded on every span. */
export function makeProvenanceAttrs(
  sourceFormat: string,
  parserName: string,
  parserVersion: string,
): Record<string, unknown> {
  return {
    'jinn.transcript.sourceFormat': sourceFormat,
    'jinn.transcript.parser': parserName,
    'jinn.transcript.parserVersion': parserVersion,
  };
}
