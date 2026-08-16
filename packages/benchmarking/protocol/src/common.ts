// SPDX-License-Identifier: Apache-2.0

import { ResourceDescriptorSchema } from "@jinn-network/evidence-protocol";
import { z } from "zod";

import { compareCodeUnitStrings } from "./order.js";

export const LowercaseSha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const AbsoluteIriSchema = z.string().refine(
  (value) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value),
  "must be an absolute IRI",
);
export const TimestampSchema = z.string().datetime({ offset: true });
export const SemVerSchema = z.string().regex(
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u,
);
export const DecimalStringSchema = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u);
export const NonEmptyStringSchema = z.string().min(1);

export const DigestBearingResourceDescriptorSchema =
  ResourceDescriptorSchema.and(
    z.looseObject({
      digest: z.looseObject({ sha256: LowercaseSha256HexSchema }),
    }),
  );

export const TypedRecordReferenceSchema = z.strictObject({
  recordKind: AbsoluteIriSchema,
  record: DigestBearingResourceDescriptorSchema,
});

export const EvidenceRecordFamilySchema = z.enum([
  "execution-evidence",
  "result-evaluation",
  "execution-verification",
  "human-label-resolution",
]);

export const EvidenceRecordReferenceSchema = z.strictObject({
  family: EvidenceRecordFamilySchema,
  record: DigestBearingResourceDescriptorSchema,
});

export const NativeIdentifierSchema = z.strictObject({
  scheme: AbsoluteIriSchema,
  value: NonEmptyStringSchema,
});

export const CaptureAssuranceSchema = z.strictObject({
  origin: z.enum([
    "native-direct",
    "aggregate-lossless-derived",
    "historical-sparse-import",
  ]),
  timing: z.enum([
    "prospective-controlled",
    "prospective-native-observed",
    "retrospective-artifacts-only",
    "unverifiable",
  ]),
  closure: z.enum([
    "complete-relative-to-sealed-source",
    "partial",
    "indeterminate",
  ]),
  availability: z.enum([
    "public-exact",
    "digest-only",
    "scrub-derived",
    "source-absent",
    "collection-failed",
  ]),
  limitations: z.array(NonEmptyStringSchema),
});

export const JsonScalarSchema = z.union([
  z.string(),
  z.number().int(),
  z.boolean(),
  z.null(),
]);

const REVERSE_DNS_KEY =
  /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/u;

function namespaced(key: string): boolean {
  if (REVERSE_DNS_KEY.test(key)) return true;
  try {
    return new URL(key).protocol.length > 1;
  } catch {
    return false;
  }
}

export function topLevelRecordSchema<const Shape extends z.ZodRawShape>(
  shape: Shape,
) {
  const known = new Set(Object.keys(shape));
  return z.looseObject(shape).superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (known.has(key) || namespaced(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `extension key ${key} must be namespaced`,
      });
    }
  });
}

export function descriptorDigest(
  value: z.infer<typeof DigestBearingResourceDescriptorSchema>,
): string {
  return value.digest.sha256;
}

export function evidenceReferenceKey(
  value: z.infer<typeof EvidenceRecordReferenceSchema>,
): string {
  return `${value.family}\u0000${descriptorDigest(value.record)}`;
}

export function typedReferenceKey(
  value: z.infer<typeof TypedRecordReferenceSchema>,
): string {
  return `${value.recordKind}\u0000${descriptorDigest(value.record)}`;
}

export function isSortedUniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  return values.every(
    (value, index) =>
      index === 0 ||
      compareCodeUnitStrings(key(values[index - 1]!), key(value)) < 0,
  );
}

export type DigestBearingResourceDescriptor = z.infer<
  typeof DigestBearingResourceDescriptorSchema
>;
export type TypedRecordReference = z.infer<typeof TypedRecordReferenceSchema>;
export type EvidenceRecordReference = z.infer<
  typeof EvidenceRecordReferenceSchema
>;
