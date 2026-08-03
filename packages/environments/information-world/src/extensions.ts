import { z } from "zod";

/**
 * Extension names are either reverse-DNS names or URI-shaped names. A URI-shaped name has a
 * non-empty scheme-specific part; a `//` hierarchical form additionally needs an authority.
 * This source is also embedded in the published JSON Schema, so its grammar is one explicit,
 * shared contract rather than a host URL parser on one side and a regex on the other.
 */
export const NAMESPACED_EXTENSION_KEY_PATTERN =
  "^(?:[A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+|[A-Za-z][A-Za-z0-9+.-]*:(?:\\/\\/[^\\s\\/?#][^\\s]*|(?!\\/\\/)[^\\s]+))$";

const namespacedExtensionKey = new RegExp(NAMESPACED_EXTENSION_KEY_PATTERN);

/**
 * Extension names are reverse-DNS or URI-shaped (TEP §21.3); a bare key is neither. The
 * published JSON Schema consumes the same pattern source, so schema and runtime validators
 * reach the same verdict without relying on `new URL`'s host-specific URL normalization.
 */
export function isNamespacedExtensionKey(key: string): boolean {
  return namespacedExtensionKey.test(key);
}

/**
 * Keeps a record open only to namespaced extension names: unknown namespaced keys survive
 * round-trips (they reach the sealed bytes and re-parse unchanged), but they can never
 * shadow a core field, and a bare key is `invalid-document` rather than silently accepted.
 */
export function topLevelRecordSchema<const Shape extends z.ZodRawShape>(shape: Shape) {
  const knownKeys = new Set(Object.keys(shape));
  return z.looseObject(shape).superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (knownKeys.has(key) || isNamespacedExtensionKey(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `Extension key "${key}" must be namespaced (reverse-DNS or absolute URI, TEP §21.3).`,
      });
    }
  });
}
