// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  DECIMAL_SIGNED_PATTERN,
  DECIMAL_UNSIGNED_PATTERN,
  isValidDecimalInt64,
  isValidDecimalUint64,
} from "./otlp-bounds.js";
import { compareCodeUnitStrings } from "./order.js";
import { hardenedSchema } from "./schema-facade.js";
import { isAdmittedAttributeKey } from "./vocabulary.js";

/** OTLP `SpanKind` enum values; OTLP JSON encodes enums as integers. */
export const SPAN_KIND = Object.freeze({
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const);

/** OTLP `StatusCode` enum values. */
export const STATUS_CODE = Object.freeze({
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const);

const DecimalUnsigned = z
  .string()
  .regex(DECIMAL_UNSIGNED_PATTERN, "must be an unsigned decimal string")
  .refine(isValidDecimalUint64, {
    message: "must be a uint64 decimal in 0..18446744073709551615",
  });

const DecimalInt64 = z
  .string()
  .regex(DECIMAL_SIGNED_PATTERN, "must be a signed decimal string")
  .refine(isValidDecimalInt64, {
    message: "must be an int64 decimal in -9223372036854775808..9223372036854775807",
  });

const HexId = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`), `must be ${length} lowercase hex digits`);

/**
 * The OTLP AnyValue subset this profile admits. Exactly one variant must be present;
 * `bytesValue` is excluded because a trajectory span never carries opaque payloads.
 */
export const AnyValueCoreSchema = z
  .strictObject({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: DecimalInt64.optional(),
    doubleValue: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
  })
  .refine((value) => Object.values(value).filter((entry) => entry !== undefined).length === 1, {
    message: "an AnyValue must carry exactly one variant",
  });

export const AnyValueSchema = hardenedSchema(AnyValueCoreSchema);

export const AttributeCoreSchema = z.strictObject({
  key: z.string().min(1).refine(isAdmittedAttributeKey, {
    message: "attribute key is not admitted by the trajectory vocabulary profile",
  }),
  value: AnyValueCoreSchema,
});

export const AttributeSchema = hardenedSchema(AttributeCoreSchema);

const sortedUniqueByKey = (attributes: readonly { key: string }[]): boolean => {
  for (let index = 1; index < attributes.length; index += 1) {
    const previous = attributes[index - 1]!.key;
    const current = attributes[index]!.key;
    if (compareCodeUnitStrings(previous, current) >= 0) return false;
  }
  return true;
};

const AttributeListCoreSchema = z
  .array(AttributeCoreSchema)
  .refine(sortedUniqueByKey, {
    message: "attributes must be sorted by key and unique (OTLP defines no ordering; this profile fixes one)",
  });

export const SpanEventCoreSchema = z.strictObject({
  timeUnixNano: DecimalUnsigned,
  name: z.string().min(1),
  attributes: AttributeListCoreSchema,
});

export const SpanEventSchema = hardenedSchema(SpanEventCoreSchema);

export const SpanStatusCoreSchema = z.strictObject({
  code: z.union([
    z.literal(STATUS_CODE.UNSET),
    z.literal(STATUS_CODE.OK),
    z.literal(STATUS_CODE.ERROR),
  ]),
  message: z.string().optional(),
});

export const SpanStatusSchema = hardenedSchema(SpanStatusCoreSchema);

export const SpanCoreSchema = z
  .strictObject({
    spanId: HexId(16),
    parentSpanId: HexId(16).nullable(),
    name: z.string().min(1),
    kind: z.union([
      z.literal(SPAN_KIND.INTERNAL),
      z.literal(SPAN_KIND.SERVER),
      z.literal(SPAN_KIND.CLIENT),
      z.literal(SPAN_KIND.PRODUCER),
      z.literal(SPAN_KIND.CONSUMER),
    ]),
    startTimeUnixNano: DecimalUnsigned,
    endTimeUnixNano: DecimalUnsigned,
    attributes: AttributeListCoreSchema,
    events: z.array(SpanEventCoreSchema),
    status: SpanStatusCoreSchema,
  })
  .refine((span) => {
    const start = DecimalUnsigned.safeParse(span.startTimeUnixNano);
    const end = DecimalUnsigned.safeParse(span.endTimeUnixNano);
    if (!start.success || !end.success) return true;
    return BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano);
  }, {
    message: "endTimeUnixNano must not precede startTimeUnixNano",
    path: ["endTimeUnixNano"],
  });

export const SpanSchema = hardenedSchema(SpanCoreSchema);

export type AnyValue = z.infer<typeof AnyValueCoreSchema>;
export type Attribute = z.infer<typeof AttributeCoreSchema>;
export type SpanEvent = z.infer<typeof SpanEventCoreSchema>;
export type SpanStatus = z.infer<typeof SpanStatusCoreSchema>;
export type Span = z.infer<typeof SpanCoreSchema>;
