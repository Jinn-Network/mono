/**
 * Shared recursive walker for structured (JSON-shaped) values (issue #3038).
 *
 * Two deep walkers existed independently — `redactValue`
 * (`observability/redact-secrets.ts`, debug-bundle secret redaction) and
 * `sanitizeStructuredValue` (`rpc/transport.ts`, host-only RPC masking on the
 * structured-event path). Their *traversal* was identical; only their
 * substitution vocabulary differed. This module owns the traversal:
 *
 *   - container classification (array vs plain record vs opaque leaf),
 *   - recursion into containers, producing a fresh copy (never mutating),
 *   - the container-scoped depth cap.
 *
 * Each caller keeps its own policy: `leaf` decides what a non-container
 * becomes, `entry` optionally overrides a record property by key. Neither
 * masking vocabulary moves here.
 *
 * Two behaviours the callers previously got wrong, fixed once here:
 *
 *   - **The depth cap applies to containers only.** Replacing a too-deep
 *     *number* or *boolean* with a truncation string changed its type for no
 *     benefit — the cap exists to bound recursion, and a primitive is not
 *     recursive. Only a container past `maxDepth` is replaced.
 *   - **A non-plain object is a leaf, not an empty record.** `Object.entries`
 *     on a `Map`, `Set`, `Date`, or class instance yields no own enumerable
 *     entries, so walking one collapsed it to `{}` — silently discarding the
 *     value and misreporting it as an empty object. Such values now reach the
 *     caller's `leaf` policy, which can represent them honestly.
 *
 * No cycle detection: both callers walk JSON-derived data. `maxDepth` bounds
 * the recursion for the one caller that accepts arbitrary caller-built
 * payloads.
 */

/** Default replacement for a container nested deeper than `maxDepth`. */
export const TRUNCATED_MARKER = '[truncated]';

export interface StructuredWalkPolicy {
  /**
   * Transform a leaf — anything that is neither an array nor a plain record.
   * Strings, numbers, booleans, `null`/`undefined`, `Date`s, `Map`s, class
   * instances, functions and symbols all arrive here.
   */
  leaf(value: unknown): unknown;
  /**
   * Optional per-key override for plain-record properties. Return a
   * `{ value }` box to substitute the property outright (no recursion into
   * it); return `undefined` to fall through to the ordinary walk. Array
   * elements have no key and never reach this hook.
   */
  entry?(key: string, value: unknown): { value: unknown } | undefined;
  /**
   * Container nesting depth beyond which a container is replaced by
   * `truncated`. The top-level value sits at depth 0. Unset means unbounded.
   */
  maxDepth?: number;
  /** Replacement for a container past `maxDepth`. Defaults to {@link TRUNCATED_MARKER}. */
  truncated?: unknown;
}

/**
 * True only for `{}`-shaped records — an object literal, a `JSON.parse`
 * result, or a null-prototype record. A `Map`, `Set`, `Date`, `Error` or class
 * instance is deliberately NOT one: its state does not live in own enumerable
 * string-keyed properties, so walking it loses the value.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-copy `value`, applying `policy` to every leaf and (inside records)
 * every keyed property. Pure — the input is never mutated.
 */
export function walkStructured(value: unknown, policy: StructuredWalkPolicy): unknown {
  const maxDepth = policy.maxDepth ?? Number.POSITIVE_INFINITY;
  const truncated = 'truncated' in policy ? policy.truncated : TRUNCATED_MARKER;

  const walk = (node: unknown, depth: number): unknown => {
    const isArray = Array.isArray(node);
    const isRecord = !isArray && isPlainRecord(node);
    if ((isArray || isRecord) && depth > maxDepth) return truncated;

    if (isArray) return (node as readonly unknown[]).map((entry) => walk(entry, depth + 1));

    if (isRecord) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        const override = policy.entry?.(key, entry);
        out[key] = override ? override.value : walk(entry, depth + 1);
      }
      return out;
    }

    return policy.leaf(node);
  };

  return walk(value, 0);
}
