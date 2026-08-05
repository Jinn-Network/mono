// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { hardenedSchema } from "./schema-facade.js";

const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;
const ABSOLUTE_URI_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

export function isNamespacedExtensionKey(key: string): boolean {
  return REVERSE_DNS_KEY_PATTERN.test(key) || ABSOLUTE_URI_KEY_PATTERN.test(key);
}

const IJsonSafeIntegerSchema = z
  .number()
  .refine((value) => Number.isInteger(value) && Number.isSafeInteger(value), {
    message: "extension number must be an I-JSON safe integer",
  });

const JsonScalarSchema = z.union([z.string(), IJsonSafeIntegerSchema, z.boolean(), z.null()]);

export type JsonExtensionValue =
  | string
  | number
  | boolean
  | null
  | JsonExtensionValue[]
  | { readonly [key: string]: JsonExtensionValue };

export const JsonExtensionValueCoreSchema: z.ZodType<JsonExtensionValue> = z.lazy(() =>
  z.union([
    JsonScalarSchema,
    z.array(JsonExtensionValueCoreSchema),
    z
      .record(z.string(), JsonExtensionValueCoreSchema)
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

/** Public facade: descriptor preflight before extension-tree traversal. */
export const JsonExtensionValueSchema = hardenedSchema(JsonExtensionValueCoreSchema);

/**
 * Closed object schema: known core keys only, plus optional namespaced extension keys
 * whose values must be valid JsonExtensionValue trees.
 */
export function closedObjectCoreSchema<const Shape extends z.ZodRawShape>(shape: Shape) {
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
      const parsed = JsonExtensionValueCoreSchema.safeParse(value[key]);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [key, ...issue.path] });
        }
      }
    }
  });
}

/** Public facade over {@link closedObjectCoreSchema}. */
export function closedObjectSchema<const Shape extends z.ZodRawShape>(shape: Shape) {
  return hardenedSchema(closedObjectCoreSchema(shape));
}

/**
 * Keeps top-level records open only to namespaced extension names: unknown keys survive
 * round-trips, but they can never shadow core fields.
 */
export function topLevelRecordCoreSchema<const Shape extends z.ZodRawShape>(shape: Shape) {
  return closedObjectCoreSchema(shape);
}

/** Public facade over {@link topLevelRecordCoreSchema}. */
export function topLevelRecordSchema<const Shape extends z.ZodRawShape>(shape: Shape) {
  return hardenedSchema(closedObjectCoreSchema(shape));
}
