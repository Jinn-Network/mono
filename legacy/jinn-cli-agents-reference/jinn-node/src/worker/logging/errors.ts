/**
 * Error serialization and logging utilities
 */

/**
 * Truncate long string fields to prevent log bloat
 */
function sanitizeForLogging(obj: any, maxFieldLength = 500): any {
  if (typeof obj !== 'object' || obj === null) return obj;

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.length > maxFieldLength) {
      result[key] = value.slice(0, maxFieldLength) + `... [truncated, ${value.length} chars total]`;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeForLogging(value, maxFieldLength);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Serialize an error to a string representation.
 * Extracts the most useful message and avoids dumping huge stderr/telemetry blobs.
 */
export function serializeError(e: any): string {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;

  // Handle Error instances
  if (e instanceof Error) {
    return e.message || e.toString();
  }

  // Handle wrapped error objects { error: Error, telemetry: ... }
  if (e?.error instanceof Error) {
    return e.error.message || e.error.toString();
  }

  // Handle objects with message property
  if (e?.message) return e.message;
  if (e?.error?.message) return e.error.message;

  // Fallback: stringify but truncate large fields (like stderr)
  try {
    const sanitized = sanitizeForLogging(e);
    return JSON.stringify(sanitized);
  } catch {
    return String(e);
  }
}

