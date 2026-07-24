const MAX_ATTR_LENGTH = 8000;

export function truncate(value: string): string {
  return value.length > MAX_ATTR_LENGTH ? value.slice(0, MAX_ATTR_LENGTH) : value;
}

export function truncateLeaves(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value);
  if (Array.isArray(value)) return value.map(truncateLeaves);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = truncateLeaves(child);
    }
    return result;
  }
  return value;
}

export function stringifyResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content) ?? String(content);
}

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
