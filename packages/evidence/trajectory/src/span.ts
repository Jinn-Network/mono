// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { compareCodeUnitStrings } from "./order.js";
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
  .regex(/^(0|[1-9]\d*)$/, "must be an unsigned decimal string");

const HexId = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`), `must be ${length} lowercase hex digits`);

/**
 * The OTLP AnyValue subset this profile admits. Exactly one variant must be present;
 * `bytesValue` is excluded because a trajectory span never carries opaque payloads.
 */
export const AnyValueSchema = z
  .strictObject({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: z.string().regex(/^-?(0|[1-9]\d*)$/).optional(),
    doubleValue: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
  })
  .refine((value) => Object.values(value).filter((entry) => entry !== undefined).length === 1, {
    message: "an AnyValue must carry exactly one variant",
  });

export const AttributeSchema = z.strictObject({
  key: z.string().min(1).refine(isAdmittedAttributeKey, {
    message: "attribute key is not admitted by the trajectory vocabulary profile",
  }),
  value: AnyValueSchema,
});

const sortedUniqueByKey = (attributes: readonly { key: string }[]): boolean => {
  for (let index = 1; index < attributes.length; index += 1) {
    const previous = attributes[index - 1]!.key;
    const current = attributes[index]!.key;
    if (compareCodeUnitStrings(previous, current) >= 0) return false;
  }
  return true;
};

const AttributeListSchema = z
  .array(AttributeSchema)
  .refine(sortedUniqueByKey, {
    message: "attributes must be sorted by key and unique (OTLP defines no ordering; this profile fixes one)",
  });

export const SpanEventSchema = z.strictObject({
  timeUnixNano: DecimalUnsigned,
  name: z.string().min(1),
  attributes: AttributeListSchema,
});

export const SpanStatusSchema = z.strictObject({
  code: z.union([
    z.literal(STATUS_CODE.UNSET),
    z.literal(STATUS_CODE.OK),
    z.literal(STATUS_CODE.ERROR),
  ]),
  message: z.string().optional(),
});

export const SpanSchema = z
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
    attributes: AttributeListSchema,
    events: z.array(SpanEventSchema),
    status: SpanStatusSchema,
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

export type AnyValue = z.infer<typeof AnyValueSchema>;
export type Attribute = z.infer<typeof AttributeSchema>;
export type SpanEvent = z.infer<typeof SpanEventSchema>;
export type SpanStatus = z.infer<typeof SpanStatusSchema>;
export type Span = z.infer<typeof SpanSchema>;
