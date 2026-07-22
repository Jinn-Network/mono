/**
 * Parses the exact UTC shape used by persisted Autopilot evidence. Offsets,
 * permissive Date.parse variants, impossible calendar values, and fractional
 * precision other than milliseconds fail closed.
 */
export function exactUtcTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/
    .exec(value);
  if (match === null) return null;
  const parts = match.slice(1).map((part) => Number(part ?? '0'));
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) return null;
  const parsed = new Date(parsedMs);
  return parsed.getUTCFullYear() === parts[0]
    && parsed.getUTCMonth() + 1 === parts[1]
    && parsed.getUTCDate() === parts[2]
    && parsed.getUTCHours() === parts[3]
    && parsed.getUTCMinutes() === parts[4]
    && parsed.getUTCSeconds() === parts[5]
    && parsed.getUTCMilliseconds() === parts[6]
    ? parsedMs
    : null;
}
