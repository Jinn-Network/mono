// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

export const BINARY_ITEM_BANK_ENTRY_PROTOCOL = "https://spec.jinn.network/binary-judgment/item-bank-entry/v1" as const;
export const BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL = "https://spec.jinn.network/binary-judgment/source-manifest-entry/v1" as const;
export const BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL = "https://spec.jinn.network/binary-judgment/admission-index-entry/v1" as const;
export const BINARY_ITEM_BANK_INTAKE_EXTENSION = "https://product.jinn.network/extensions/binary-judgment-intake/v1" as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u).transform((value) => value as `sha256:${string}`);
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const ItemPayloadSchema = z.strictObject({
  itemId: z.string().regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
  question: z.string(),
  referenceAnswer: z.string(),
  candidateAnswer: z.string(),
  provenance: z.array(z.strictObject({ digest: z.strictObject({ sha256: Sha256HexSchema }) })).min(1),
});
const SourceDescriptorSchema = z.strictObject({
  name: z.string().min(1).optional(),
  uri: z.string().min(1),
  digest: z.strictObject({ sha256: Sha256HexSchema }),
  mediaType: z.string().min(1).optional(),
  downloadLocation: z.string().min(1).optional(),
});

export const BinaryItemBankEntrySchema = z.strictObject({
  protocol: z.literal(BINARY_ITEM_BANK_ENTRY_PROTOCOL),
  item: ItemPayloadSchema,
});
export type BinaryItemBankEntry = z.infer<typeof BinaryItemBankEntrySchema>;

export const BinarySourceManifestEntrySchema = z.strictObject({
  protocol: z.literal(BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL),
  provenanceSha256: DigestSchema,
  source: SourceDescriptorSchema,
  license: SourceDescriptorSchema,
  attribution: SourceDescriptorSchema,
}).superRefine((entry, ctx) => {
  if (`sha256:${entry.source.digest.sha256}` !== entry.provenanceSha256) {
    ctx.addIssue({ code: "custom", path: ["source", "digest", "sha256"], message: "source digest must equal provenanceSha256" });
  }
});
export type BinarySourceManifestEntry = z.infer<typeof BinarySourceManifestEntrySchema>;

export const BinaryAdmissionIndexEntrySchema = z.strictObject({
  protocol: z.literal(BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL),
  admissionManifestSha256: DigestSchema,
  itemSha256: DigestSchema,
  labelResolutionSha256: DigestSchema,
  analysisContextSha256: DigestSchema,
});
export type BinaryAdmissionIndexEntry = z.infer<typeof BinaryAdmissionIndexEntrySchema>;

export const BinaryItemBankIntakeExtensionSchema = z.strictObject({
  profile: z.literal("https://spec.jinn.network/task-profiles/binary-judgment/1.0"),
  itemBankSha256: DigestSchema,
  sourceManifestSha256: DigestSchema,
  admissionIndexSha256: DigestSchema,
  admissionManifestSha256: DigestSchema,
  replacementLedgerSha256: DigestSchema,
});
export type BinaryItemBankIntakeExtension = z.infer<typeof BinaryItemBankIntakeExtensionSchema>;
