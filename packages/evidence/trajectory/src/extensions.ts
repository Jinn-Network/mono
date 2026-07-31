// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;
const ABSOLUTE_URI_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

export function isNamespacedExtensionKey(key: string): boolean {
  return REVERSE_DNS_KEY_PATTERN.test(key) || ABSOLUTE_URI_KEY_PATTERN.test(key);
}

const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export type JsonExtensionValue =
  | string
  | number
  | boolean
  | null
  | JsonExtensionValue[]
  | { readonly [key: string]: JsonExtensionValue };

export const JsonExtensionValueSchema: z.ZodType<JsonExtensionValue> = z.lazy(() =>
  z.union([
    JsonScalarSchema,
    z.array(JsonExtensionValueSchema),
    z
      .record(z.string(), JsonExtensionValueSchema)
      .superRefine((value, ctx) => {
        for (const key of Object.keys(value)) {
          if (!isNamespacedExtensionKey(key)) {
            ctx.addIssue({
              code: "custom",
              path: [key],
              message: `Extension object key "${key}" must be namespaced.`,
            });
          }
        }
      }),
  ]),
);

/**
 * Closed object schema: known core keys only, plus optional namespaced extension keys
 * whose values must be valid JsonExtensionValue trees.
 */
export function closedObjectSchema<const Shape extends z.ZodRawShape>(shape: Shape) {
  const knownKeys = new Set(Object.keys(shape));
  return z.looseObject(shape).superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (knownKeys.has(key)) continue;
      if (!isNamespacedExtensionKey(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Unknown key "${key}" is not allowed.`,
        });
        continue;
      }
      const parsed = JsonExtensionValueSchema.safeParse(value[key]);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [key, ...issue.path] });
        }
      }
    }
  });
}

/**
 * Keeps top-level records open only to namespaced extension names: unknown keys survive
 * round-trips, but they can never shadow core fields.
 */
export function topLevelRecordSchema<const Shape extends z.ZodRawShape>(shape: Shape) {
  return closedObjectSchema(shape);
}
