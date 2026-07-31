import { z } from "zod";

const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

/**
 * Extension names are reverse-DNS or absolute URIs (TEP §21.3); a bare key is neither.
 *
 * The whitespace rule is parity, not taste: `new URL` accepts `"http://a/b c"` by
 * percent-encoding the space, while the published schema spells absolute URIs `[^\s]+`. A
 * key this package sealed and that schema refused would give a third party a different
 * verdict on the same record, so the looser surface is brought up to the stricter one.
 */
export function isNamespacedExtensionKey(key: string): boolean {
  if (REVERSE_DNS_KEY_PATTERN.test(key)) return true;
  if (/\s/u.test(key)) return false;
  try {
    return new URL(key).protocol.length > 1;
  } catch {
    return false;
  }
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
