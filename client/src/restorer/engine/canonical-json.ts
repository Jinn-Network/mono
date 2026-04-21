/**
 * Canonical JSON serialisation — sorted keys, no whitespace.
 *
 * Used for manifest signing: produce a deterministic byte string that two
 * independent parties can reproduce from the same object graph.
 *
 * Rules:
 * - Object keys are sorted lexicographically (UTF-16 code-unit order, same as
 *   Array.prototype.sort() on strings — matches JSON.stringify key insertion
 *   order when we control insertion).
 * - Arrays preserve element order.
 * - Numbers: JS default toString (no special formatting).
 * - null, boolean, string: standard JSON encoding.
 * - undefined values in objects are dropped (same as JSON.stringify).
 * - NaN and Infinity are not valid JSON; this function will produce "null" for
 *   those values, matching JSON.stringify behaviour.
 */

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    // NaN / Infinity → null, matching JSON.stringify
    if (!isFinite(value)) return 'null';
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalJson(v)).join(',');
    return `[${items}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const pairs = Object.keys(obj)
      .sort()
      .flatMap((key) => {
        const v = obj[key];
        if (v === undefined) return []; // drop undefined (matches JSON.stringify)
        return [`${JSON.stringify(key)}:${canonicalJson(v)}`];
      });
    return `{${pairs.join(',')}}`;
  }
  // Bigint: emit raw decimal digits WITHOUT quotes, matching RFC 8785 and other
  // canonical-JSON libs. JSON.stringify would throw; converting through String()
  // would produce a quoted "12345" instead of the unquoted integer 12345.
  // We do NOT convert through Number() because bigints can exceed JS number precision.
  if (typeof value === 'bigint') return value.toString();
  // Fallback: other exotic types — JSON.stringify would throw;
  // we convert to string to avoid hard failures.
  return JSON.stringify(String(value));
}
