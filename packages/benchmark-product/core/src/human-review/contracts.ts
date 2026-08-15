// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import {
  BinaryJudgmentPayloadSchema,
  BinaryJudgmentStratumSchema,
  BinaryJudgmentTruthLabelSchema,
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
} from "@jinn-network/task-execution-profiles";
import { refuse, refuseWithIssues } from "../errors.js";

export const HUMAN_REVIEW_PACKET_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/human-review-packet/v1" as const;
export const HUMAN_REVIEW_RESPONSE_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/human-review-response/v1" as const;
export const HUMAN_REVIEW_VISIBILITY_RECEIPT_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/visibility-receipt/v1" as const;
export const HUMAN_REVIEW_ROSTER_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/reviewer-roster/v1" as const;
export const HUMAN_REVIEW_REVEAL_RECEIPT_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/reveal-receipt/v1" as const;
export const HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/replacement-ledger/v1" as const;
export const HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/operator-truth-assertion/v1" as const;
export const BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/admission-manifest/v1" as const;

export const HUMAN_REVIEW_PACKET_MEDIA_TYPE =
  "application/vnd.jinn.binary-judgment.human-review-packet.v1+json" as const;
export const HUMAN_REVIEW_RESPONSE_MEDIA_TYPE =
  "application/vnd.jinn.binary-judgment.human-review-response.v1+json" as const;
export const HUMAN_REVIEW_VISIBILITY_RECEIPT_MEDIA_TYPE =
  "application/vnd.jinn.binary-judgment.visibility-receipt.v1+json" as const;
export const HUMAN_REVIEW_ROSTER_MEDIA_TYPE =
  "application/vnd.jinn.binary-judgment.reviewer-roster.v1+json" as const;
export const HUMAN_REVIEW_REVEAL_RECEIPT_MEDIA_TYPE =
  "application/vnd.jinn.binary-judgment.reveal-receipt.v1+json" as const;
export const HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE =
  "application/vnd.jinn.binary-judgment.operator-truth-assertion.v1+json" as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const TimestampSchema = z.string().datetime({ offset: true });
const IdentitySchema = z.string().min(1).max(256);
const EvaluatorIdentitySchema = IdentitySchema.regex(/^(?:https?:\/\/|urn:)[^\s]+$/u);
const CandidateClassSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u);
const ConflictListSchema = z.array(z.string().min(1)).superRefine((values, ctx) => {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodeUnitStrings(values[index - 1]!, values[index]!) >= 0) {
      ctx.addIssue({ code: "custom", message: "conflicts must be sorted and unique" });
      return;
    }
  }
});
const SortedUniqueDigestListSchema = z.array(DigestSchema).superRefine((values, ctx) => {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodeUnitStrings(values[index - 1]!, values[index]!) >= 0) {
      ctx.addIssue({ code: "custom", message: "digest references must be sorted and unique" });
      return;
    }
  }
});
const SortedUniqueDigestPairSchema = z.tuple([DigestSchema, DigestSchema]).superRefine((values, ctx) => {
  if (compareCodeUnitStrings(values[0], values[1]) >= 0) {
    ctx.addIssue({ code: "custom", message: "digest references must be sorted and unique" });
  }
});

export const HUMAN_REVIEW_OMITTED_FIELDS = [
  "instrumentIdentity",
  "candidateClass",
  "stratum",
  "otherReview",
  "postRunOutcomes",
] as const;

export const HumanReviewPacketSchema = z.strictObject({
  protocol: z.literal(HUMAN_REVIEW_PACKET_PROTOCOL),
  itemSha256: DigestSchema,
  item: BinaryJudgmentPayloadSchema,
  evaluationSpecSha256: DigestSchema,
  reviewerId: EvaluatorIdentitySchema,
  form: z.strictObject({
    question: z.literal("Is the candidate answer correct relative to the question and reference answer?"),
    labels: z.tuple([z.literal("CORRECT"), z.literal("WRONG"), z.literal("indeterminate")]),
    completeReviewRequired: z.literal(true),
  }),
});
export type HumanReviewPacket = z.infer<typeof HumanReviewPacketSchema>;

export const HumanReviewVisibilityReceiptSchema = z.strictObject({
  protocol: z.literal(HUMAN_REVIEW_VISIBILITY_RECEIPT_PROTOCOL),
  packetSha256: DigestSchema,
  itemSha256: DigestSchema,
  reviewerId: EvaluatorIdentitySchema,
  omittedFields: z.tuple(HUMAN_REVIEW_OMITTED_FIELDS.map((value) => z.literal(value)) as [
    z.ZodLiteral<"instrumentIdentity">,
    z.ZodLiteral<"candidateClass">,
    z.ZodLiteral<"stratum">,
    z.ZodLiteral<"otherReview">,
    z.ZodLiteral<"postRunOutcomes">,
  ]),
  issuedAt: TimestampSchema,
});
export type HumanReviewVisibilityReceipt = z.infer<typeof HumanReviewVisibilityReceiptSchema>;

export const HumanReviewResponseSchema = z.strictObject({
  protocol: z.literal(HUMAN_REVIEW_RESPONSE_PROTOCOL),
  packetSha256: DigestSchema,
  visibilityReceiptSha256: DigestSchema,
  itemSha256: DigestSchema,
  evaluatorId: EvaluatorIdentitySchema,
  label: z.union([BinaryJudgmentTruthLabelSchema, z.literal("indeterminate")]),
  complete: z.boolean(),
  completedAt: TimestampSchema,
});
export type HumanReviewResponse = z.infer<typeof HumanReviewResponseSchema>;

export const ReviewerDeclarationSchema = z.strictObject({
  evaluatorId: EvaluatorIdentitySchema,
  keyId: IdentitySchema,
  personId: IdentitySchema,
  role: IdentitySchema,
  conflicts: ConflictListSchema,
});

export const HumanReviewRosterSchema = z.strictObject({
  protocol: z.literal(HUMAN_REVIEW_ROSTER_PROTOCOL),
  itemSha256: DigestSchema,
  reviewers: z.tuple([ReviewerDeclarationSchema, ReviewerDeclarationSchema]),
  attestedBy: IdentitySchema,
  attestorKeyId: IdentitySchema,
  attestorRole: z.literal("roster-attestor"),
  attestedAt: TimestampSchema,
});
export type HumanReviewRoster = z.infer<typeof HumanReviewRosterSchema>;

export const HumanReviewRevealReceiptSchema = z.strictObject({
  protocol: z.literal(HUMAN_REVIEW_REVEAL_RECEIPT_PROTOCOL),
  draftId: IdentitySchema,
  itemSha256: DigestSchema,
  truthFrozenAt: TimestampSchema,
  judgeExecutionState: z.literal("not-started"),
  attestedBy: IdentitySchema,
  attestorKeyId: IdentitySchema,
  attestorRole: z.literal("truth-reveal-attestor"),
});
export type HumanReviewRevealReceipt = z.infer<typeof HumanReviewRevealReceiptSchema>;

export const HumanReviewReplacementLedgerEntrySchema = z.strictObject({
  excludedItemSha256: DigestSchema,
  replacementItemSha256: DigestSchema,
  candidateClass: CandidateClassSchema,
  stratum: BinaryJudgmentStratumSchema,
  excludedPoolPosition: z.number().int().positive(),
  replacementPoolPosition: z.number().int().positive(),
  reason: z.enum(["review-disagreement", "review-indeterminate", "review-incomplete"]),
  reviewVerdictSha256s: SortedUniqueDigestPairSchema,
  visibilityReceiptSha256s: SortedUniqueDigestPairSchema,
  reviewerRosterSha256: DigestSchema,
  revealReceiptSha256: DigestSchema,
});

export const HumanReviewReplacementLedgerSchema = z.strictObject({
  protocol: z.literal(HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL),
  draftId: IdentitySchema,
  entries: z.array(HumanReviewReplacementLedgerEntrySchema),
  sealedAt: TimestampSchema,
});
export type HumanReviewReplacementLedger = z.infer<typeof HumanReviewReplacementLedgerSchema>;

export const HumanReviewOperatorAssertionSchema = z.strictObject({
  protocol: z.literal(HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL),
  itemSha256: DigestSchema,
  truthLabel: BinaryJudgmentTruthLabelSchema,
  assertedBy: IdentitySchema,
  assertedAt: TimestampSchema,
  attestorKeyId: IdentitySchema,
  attestorRole: z.literal("operator-truth-attestor"),
  limitation: z.literal("operator-only-not-publication-grade"),
});
export type HumanReviewOperatorAssertion = z.infer<typeof HumanReviewOperatorAssertionSchema>;

export const BinaryJudgmentAdmissionManifestSchema = z.strictObject({
  protocol: z.literal(BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL),
  draftId: IdentitySchema,
  truthAdmission: z.enum(["two-human-unanimous", "operator-only"]),
  labelResolutionSha256s: SortedUniqueDigestListSchema,
  analysisContextSha256s: SortedUniqueDigestListSchema,
  excludedItemSha256s: SortedUniqueDigestListSchema,
  replacementLedgerSha256: DigestSchema,
  admittedAt: TimestampSchema,
});
export type BinaryJudgmentAdmissionManifest = z.infer<
  typeof BinaryJudgmentAdmissionManifestSchema
>;

function issues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

export function parseHumanReviewDocument<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) refuseWithIssues("validation", issues(parsed.error));
  return parsed.data;
}

export function parseCanonicalHumanReviewBytes<T>(
  schema: z.ZodType<T>,
  bytes: Uint8Array,
  label: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("validation", label, `${label} is not valid UTF-8 JSON`);
  }
  const parsed = parseHumanReviewDocument(schema, value, label);
  const expected = canonicalJsonBytes(parsed);
  if (expected.byteLength !== bytes.byteLength || expected.some((byte, index) => byte !== bytes[index])) {
    refuse("validation", label, `${label} is not in canonical JSON encoding`);
  }
  return parsed;
}

export function sealHumanReviewDocument<T>(schema: z.ZodType<T>, input: unknown, label: string) {
  const value = parseHumanReviewDocument(schema, input, label);
  const bytes = canonicalJsonBytes(value);
  return { value, bytes, digest: recordDigest(bytes) } as const;
}
