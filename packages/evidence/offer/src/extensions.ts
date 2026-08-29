// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

/**
 * Absolute URI with a real scheme and no whitespace. `new URL` alone accepts
 * `"http://a/b c"` by percent-encoding the space, which would let one producer seal a
 * spelling another implementation refuses; the whitespace rule closes that.
 */
export function isAbsoluteUri(value: string): boolean {
  if (/\s/u.test(value)) return false;
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

/** Extension names are reverse-DNS or absolute URIs (TEP §21.3); a bare key is neither. */
export function isNamespacedExtensionKey(key: string): boolean {
  return REVERSE_DNS_KEY_PATTERN.test(key) || isAbsoluteUri(key);
}

/**
 * Keeps an object open only to namespaced extension names: unknown namespaced keys survive
 * round-trips (they reach the sealed bytes and re-parse unchanged) but can never shadow a
 * core field, and a bare key is `invalid-document` rather than silently accepted.
 */
export function namespacedObject<const Shape extends z.ZodRawShape>(shape: Shape) {
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
