// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import {
  BINARY_JUDGMENT_TIMESTAMP_PATTERN,
  compareCodeUnitStrings,
} from "@jinn-network/task-execution-profiles";

export const HUMAN_REVIEW_PACKET_PROTOCOL = "https://spec.jinn.network/binary-judgment/human-review-packet/v1" as const;
export const HUMAN_REVIEW_RESPONSE_PROTOCOL = "https://spec.jinn.network/binary-judgment/human-review-response/v1" as const;
export const HUMAN_REVIEW_VISIBILITY_RECEIPT_PROTOCOL = "https://spec.jinn.network/binary-judgment/visibility-receipt/v1" as const;
export const HUMAN_REVIEW_ROSTER_PROTOCOL = "https://spec.jinn.network/binary-judgment/reviewer-roster/v1" as const;
export const HUMAN_REVIEW_REVEAL_RECEIPT_PROTOCOL = "https://spec.jinn.network/binary-judgment/reveal-receipt/v1" as const;
export const HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL = "https://spec.jinn.network/binary-judgment/replacement-ledger/v1" as const;
export const HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL = "https://spec.jinn.network/binary-judgment/operator-truth-assertion/v1" as const;
export const BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL = "https://spec.jinn.network/binary-judgment/admission-manifest/v1" as const;
// screened-operator-sampled admission branch (spec §6.1, §6.3, §6.6; packet P6).
export const SCREENING_TABLE_PROTOCOL = "https://spec.jinn.network/binary-judgment/screening-table/v1" as const;
export const PROMPTED_SCREENING_PROCEDURE_PROTOCOL = "https://spec.jinn.network/binary-judgment/prompted-screening-procedure/v1" as const;
export const SCREENING_POOL_PROTOCOL = "https://spec.jinn.network/binary-judgment/screening-pool/v1" as const;
export const SCREENING_POOL_V2_PROTOCOL = "https://spec.jinn.network/binary-judgment/screening-pool/v2" as const;
export const SCREENING_POOL_V2_RESERVE_SELECTION_PROTOCOL = "shared-slice-first-admissible/1" as const;
export const SCREENING_SAMPLE_COMMITMENT_PROTOCOL = "https://spec.jinn.network/binary-judgment/screening-sample-commitment/v1" as const;
export const SCREENING_TABLE_V2_PROTOCOL = "https://spec.jinn.network/binary-judgment/screening-table/v2" as const;
export const SCREENING_REVEAL_RECEIPT_PROTOCOL = "https://spec.jinn.network/binary-judgment/screening-reveal-receipt/v1" as const;

export const HUMAN_REVIEW_PACKET_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.human-review-packet.v1+json" as const;
export const HUMAN_REVIEW_RESPONSE_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.human-review-response.v1+json" as const;
export const HUMAN_REVIEW_VISIBILITY_RECEIPT_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.visibility-receipt.v1+json" as const;
export const HUMAN_REVIEW_ROSTER_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.reviewer-roster.v1+json" as const;
export const HUMAN_REVIEW_REVEAL_RECEIPT_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.reveal-receipt.v1+json" as const;
export const HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.operator-truth-assertion.v1+json" as const;
// screened-operator-sampled admission branch (spec §6.3, §6.6; packet P6).
export const SCREENING_TABLE_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.screening-table.v1+json" as const;
export const SCREENING_TABLE_V2_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.screening-table.v2+json" as const;
export const SCREENING_REVEAL_RECEIPT_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.screening-reveal-receipt.v1+json" as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const TimestampSchema = z.string().datetime({ offset: true });
const IdentitySchema = z.string().min(1).max(256);
const EvaluatorIdentitySchema = IdentitySchema.regex(/^(?:https?:\/\/|urn:)[^\s]+$/u);
// §3.1 rule 1: one identifier dialect, not two. Shared shape with `candidateClass`.
const IDENTIFIER_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const CandidateClassSchema = z.string().regex(IDENTIFIER_NAME);
const BinaryJudgmentTruthLabelSchema = z.enum(["CORRECT", "WRONG"]);
const BinaryJudgmentStratumSchema = z.string().regex(IDENTIFIER_NAME);
/**
 * RFC 3339 instant SHAPE, seconds precision, no fractional part. The pattern is imported from the
 * profiles package rather than restated, so this mirrored payload copy cannot drift from the
 * canonical one it mirrors.
 */
const BinaryJudgmentTimestampShapeSchema = z.string().regex(new RegExp(BINARY_JUDGMENT_TIMESTAMP_PATTERN, "u"));
const BinaryJudgmentPayloadSchema = z.strictObject({
  itemId: z.string().regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
  question: z.string(),
  referenceAnswer: z.string(),
  candidateAnswer: z.string(),
  evidence: z.string().optional(),
  provenance: z.strictObject({
    sourceCommitment: DigestSchema,
    timestamp: BinaryJudgmentTimestampShapeSchema,
  }),
  sources: z.array(z.strictObject({
    digest: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/u) }),
  })).min(1),
});
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
  if (compareCodeUnitStrings(values[0], values[1]) >= 0) ctx.addIssue({ code: "custom", message: "digest references must be sorted and unique" });
});

export const HUMAN_REVIEW_OMITTED_FIELDS = [
  "instrumentIdentity", "candidateClass", "stratum", "otherReview", "postRunOutcomes",
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
    z.ZodLiteral<"instrumentIdentity">, z.ZodLiteral<"candidateClass">,
    z.ZodLiteral<"stratum">, z.ZodLiteral<"otherReview">,
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

/**
 * `screening-reveal-receipt/v1` (spec §6.6): a bank-scoped sibling of `HumanReviewRevealReceiptSchema`
 * above. Same ordering primitive, same attestor role, same `judgeExecutionState: "not-started"`
 * gate — differing only in subject: the bank (`screeningTableSha256`), not an item (`itemSha256`).
 * `AdmissionAuthorityRole` (`verify/src/admission/verification.ts`) is deliberately unchanged: this
 * reuses `truth-reveal-attestor` rather than minting a new role.
 */
export const ScreeningRevealReceiptSchema = z.strictObject({
  protocol: z.literal(SCREENING_REVEAL_RECEIPT_PROTOCOL),
  draftId: IdentitySchema,
  screeningTableSha256: DigestSchema,
  truthFrozenAt: TimestampSchema,
  judgeExecutionState: z.literal("not-started"),
  attestedBy: IdentitySchema,
  attestorKeyId: IdentitySchema,
  attestorRole: z.literal("truth-reveal-attestor"),
});
export type ScreeningRevealReceipt = z.infer<typeof ScreeningRevealReceiptSchema>;

/**
 * One row of the `screening-table/v1` record (spec §6.3). `handVerdict` is present if and only if
 * `handChecked === true`; both directions refuse. `handVerdict` deliberately does not reuse
 * `BinaryJudgmentTruthLabelSchema` — the hand-check outcome space is confirm-or-exclude only, with
 * no label corrections.
 */
export const ScreeningRowSchema = z.strictObject({
  itemSha256: DigestSchema,
  intendedLabel: BinaryJudgmentTruthLabelSchema,
  screeningVerdict: z.union([BinaryJudgmentTruthLabelSchema, z.literal("indeterminate")]),
  handChecked: z.boolean(),
  handVerdict: z.enum(["confirm", "exclude"]).optional(),
}).superRefine((row, ctx) => {
  if (row.handChecked && row.handVerdict === undefined) {
    ctx.addIssue({ code: "custom", path: ["handVerdict"], message: "handVerdict is required when handChecked is true" });
  }
  if (!row.handChecked && row.handVerdict !== undefined) {
    ctx.addIssue({ code: "custom", path: ["handVerdict"], message: "handVerdict must be absent when handChecked is false" });
  }
});
export type ScreeningRow = z.infer<typeof ScreeningRowSchema>;

/**
 * `screening-table/v1` (spec §6.3): one signed record per bank. Every derived quantity (the
 * flagged set, the sample, the exclusions, the agreement rate) is a *view* of this table, never a
 * stored field that can disagree with it — those recomputations live in `screening-sample.ts` and
 * its siblings, not here. `screeningModel` is deliberately absent: it is derivable from
 * `screeningInstrumentSha256`, and a second copy is a second thing to drift. The table is signed
 * once, over the whole record, on the existing DSSE signing path used by the other admission
 * records (`sealRoleEvidence`), not the ledger's non-DSSE path.
 */
export const ScreeningTableSchema = z.strictObject({
  protocol: z.literal(SCREENING_TABLE_PROTOCOL),
  draftId: IdentitySchema,
  screeningInstrumentSha256: DigestSchema,
  sampleSeed: z.string().min(1),
  // Positive integer, `1 <= sampleSize`. The `<= rows.length` half is a verifier recomputation
  // (spec §6.5 check (0)) owned elsewhere; this schema owns only the positivity.
  sampleSize: z.number().int().positive(),
  samplingScriptSha256: DigestSchema,
  // Digest-bound opaque sidecar; the verifier resolves and hashes its exact bytes but never parses
  // or interprets their content (spec §6.5).
  rawOutputsSha256: DigestSchema,
  rows: z.array(ScreeningRowSchema),
  sealedAt: TimestampSchema,
}).superRefine((table, ctx) => {
  if (table.rows.length === 0) {
    ctx.addIssue({ code: "custom", path: ["rows"], message: "rows must be non-empty" });
    return;
  }
  for (let index = 1; index < table.rows.length; index += 1) {
    if (compareCodeUnitStrings(table.rows[index - 1]!.itemSha256, table.rows[index]!.itemSha256) >= 0) {
      ctx.addIssue({ code: "custom", path: ["rows"], message: "rows must be sorted by itemSha256 and unique" });
      return;
    }
  }
});
export type ScreeningTable = z.infer<typeof ScreeningTableSchema>;

export const PROMPTED_SCREENING_PROFILE = "prompted-codex-screening/v1" as const;
export const PROMPTED_SCREENING_LIMITATIONS = [
  "prompt-compliance-not-machine-verified",
  "provider-execution-not-machine-verified",
  "transcript-provenance-not-machine-verified",
  "mutable-model-alias-weights-not-machine-verified",
] as const;

const PromptedAgentSchema = <Alias extends "Luna" | "Terra" | "Sol", Model extends string, Batch extends number>(
  alias: Alias,
  model: Model,
  reasoningEffort: "medium" | "high",
  maxBatchSize: Batch,
) => z.strictObject({
  alias: z.literal(alias),
  model: z.literal(model),
  reasoningEffort: z.literal(reasoningEffort),
  maxBatchSize: z.literal(maxBatchSize),
});

/** Closed, machine-checkable orchestration metadata. Prompt and transcript bytes stay opaque. */
export const PromptedScreeningProcedureV1Schema = z.strictObject({
  protocol: z.literal(PROMPTED_SCREENING_PROCEDURE_PROTOCOL),
  procedureId: z.literal(PROMPTED_SCREENING_PROFILE),
  coordinatorPromptSha256: DigestSchema,
  coordinator: z.strictObject({
    alias: z.literal("Sol"),
    model: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.literal("high"),
    mayOrchestrate: z.literal(true),
  }),
  judgmentAgents: z.tuple([
    PromptedAgentSchema("Luna", "gpt-5.6-luna", "medium", 32),
    PromptedAgentSchema("Terra", "gpt-5.6-terra", "high", 16),
    PromptedAgentSchema("Sol", "gpt-5.6-sol", "high", 8),
  ]),
  toolPolicy: z.strictObject({
    coordinator: z.literal("orchestration-only"),
    judgmentAgents: z.strictObject({
      web: z.literal(false),
      shell: z.literal(false),
      repository: z.literal(false),
      search: z.literal(false),
    }),
  }),
  output: z.strictObject({
    alphabet: z.tuple([z.literal("CORRECT"), z.literal("WRONG"), z.literal("UNSURE")]),
    invalidOutputDecision: z.literal("UNSURE"),
  }),
  retry: z.strictObject({
    maxRetries: z.literal(1),
    onlyWhen: z.literal("infrastructure-failure-with-no-model-output"),
    prompt: z.literal("identical"),
  }),
  transcriptSha256: DigestSchema,
  sealedAt: TimestampSchema,
});
export type PromptedScreeningProcedureV1 = z.infer<typeof PromptedScreeningProcedureV1Schema>;

export const SCREENING_POOL_CANDIDATE_CLASSES = ["correct", "specific-wrong", "vague-topical-wrong"] as const;
export const SCREENING_POOL_STRATA = ["category-1", "category-2", "category-3", "category-4"] as const;
const ScreeningPoolCommonItemSchema = z.strictObject({
  itemSha256: DigestSchema,
  intendedLabel: BinaryJudgmentTruthLabelSchema,
  candidateClass: z.enum(SCREENING_POOL_CANDIDATE_CLASSES),
  stratum: z.enum(SCREENING_POOL_STRATA),
  poolPosition: z.number().int().positive(),
  slotId: z.string().regex(/^slot-[0-9]{3}$/u),
});
export const ScreeningPoolItemSchema = z.discriminatedUnion("poolKind", [
  ScreeningPoolCommonItemSchema.extend({ poolKind: z.literal("main") }),
  ScreeningPoolCommonItemSchema.extend({ poolKind: z.literal("reserve"), reserveOrder: z.number().int().positive() }),
]);
export type ScreeningPoolItem = z.infer<typeof ScreeningPoolItemSchema>;

/** The complete, ordered 240-main plus 424-reserve candidate universe. */
export const ScreeningPoolV1Schema = z.strictObject({
  protocol: z.literal(SCREENING_POOL_PROTOCOL),
  draftId: IdentitySchema,
  identityCommitmentSha256: DigestSchema,
  items: z.array(ScreeningPoolItemSchema).length(664),
  sealedAt: TimestampSchema,
}).superRefine((pool, ctx) => {
  const slots = new Map<string, ScreeningPoolItem[]>();
  const identities = new Set<string>();
  for (const [index, item] of pool.items.entries()) {
    if (item.poolPosition !== index + 1) ctx.addIssue({ code: "custom", path: ["items", index, "poolPosition"], message: "poolPosition must be contiguous and match array order" });
    if (identities.has(item.itemSha256)) ctx.addIssue({ code: "custom", path: ["items", index, "itemSha256"], message: "itemSha256 must be unique" });
    identities.add(item.itemSha256);
    const expectedLabel = item.candidateClass === "correct" ? "CORRECT" : "WRONG";
    if (item.intendedLabel !== expectedLabel) ctx.addIssue({ code: "custom", path: ["items", index, "intendedLabel"], message: "intendedLabel does not derive from candidateClass" });
    slots.set(item.slotId, [...(slots.get(item.slotId) ?? []), item]);
  }
  const mains = pool.items.filter((item) => item.poolKind === "main");
  if (mains.length !== 240 || slots.size !== 240) ctx.addIssue({ code: "custom", path: ["items"], message: "pool must contain exactly 240 main slots" });
  const expectedSlotIds = Array.from({ length: 240 }, (_, index) => `slot-${(index + 1).toString().padStart(3, "0")}`);
  const actualSlotIds = [...slots.keys()].sort(compareCodeUnitStrings);
  if (actualSlotIds.length !== expectedSlotIds.length || actualSlotIds.some((value, index) => value !== expectedSlotIds[index])) ctx.addIssue({ code: "custom", path: ["items"], message: "slot lineage must be exactly slot-001 through slot-240" });
  for (const [slotId, items] of slots) {
    const main = items.filter((item) => item.poolKind === "main");
    if (main.length !== 1) { ctx.addIssue({ code: "custom", path: ["items"], message: `${slotId} must contain exactly one main item` }); continue; }
    const reserves = items.filter((item): item is Extract<ScreeningPoolItem, { poolKind: "reserve" }> => item.poolKind === "reserve").sort((a, b) => a.reserveOrder - b.reserveOrder);
    for (const [index, reserve] of reserves.entries()) {
      if (reserve.reserveOrder !== index + 1) ctx.addIssue({ code: "custom", path: ["items"], message: `${slotId} reserveOrder must be contiguous` });
      if (reserve.poolPosition <= main[0]!.poolPosition) ctx.addIssue({ code: "custom", path: ["items"], message: `${slotId} reserves must follow their main item in pool order` });
      if (reserve.candidateClass !== main[0]!.candidateClass || reserve.stratum !== main[0]!.stratum || reserve.intendedLabel !== main[0]!.intendedLabel) ctx.addIssue({ code: "custom", path: ["items"], message: `${slotId} reserves must preserve class, stratum, and intended label` });
    }
  }
  for (const candidateClass of SCREENING_POOL_CANDIDATE_CLASSES) for (const stratum of SCREENING_POOL_STRATA) {
    if (mains.filter((item) => item.candidateClass === candidateClass && item.stratum === stratum).length !== 20) ctx.addIssue({ code: "custom", path: ["items"], message: `main pool must contain 20 ${candidateClass}/${stratum} items` });
  }
});
export type ScreeningPoolV1 = z.infer<typeof ScreeningPoolV1Schema>;

const ScreeningPoolV2CommonItemSchema = z.strictObject({
  /** Privacy-preserving identity committed before screening outcomes were observed. */
  screeningIdentitySha256: DigestSchema,
  /** Digest of the exact later Colophon F0 item bytes. */
  itemSha256: DigestSchema,
  intendedLabel: BinaryJudgmentTruthLabelSchema,
  candidateClass: z.enum(SCREENING_POOL_CANDIDATE_CLASSES),
  stratum: z.enum(SCREENING_POOL_STRATA),
  poolPosition: z.number().int().positive(),
  sourceQuestionLineageId: IdentitySchema,
});
export const ScreeningPoolV2ItemSchema = z.discriminatedUnion("poolKind", [
  ScreeningPoolV2CommonItemSchema.extend({
    poolKind: z.literal("main"),
    slotId: z.string().regex(/^slot-[0-9]{3}$/u),
  }),
  ScreeningPoolV2CommonItemSchema.extend({
    poolKind: z.literal("reserve"),
    reserveOrder: z.number().int().positive(),
  }),
]);
export type ScreeningPoolV2Item = z.infer<typeof ScreeningPoolV2ItemSchema>;

/** A 240-main pool whose reserves are ordered shared slices within each class/stratum cell. */
export const ScreeningPoolV2Schema = z.strictObject({
  protocol: z.literal(SCREENING_POOL_V2_PROTOCOL),
  reserveSelectionProtocol: z.literal(SCREENING_POOL_V2_RESERVE_SELECTION_PROTOCOL),
  draftId: IdentitySchema,
  identityCommitmentSha256: DigestSchema,
  items: z.array(ScreeningPoolV2ItemSchema).length(664),
  sealedAt: TimestampSchema,
}).superRefine((pool, ctx) => {
  const identities = new Set<string>();
  const itemDigests = new Set<string>();
  const mains = pool.items.filter((item): item is Extract<ScreeningPoolV2Item, { poolKind: "main" }> => item.poolKind === "main");
  const mainSlots = new Set<string>();
  const mainLineages = new Set<string>();
  for (const [index, item] of pool.items.entries()) {
    if (item.poolPosition !== index + 1) ctx.addIssue({ code: "custom", path: ["items", index, "poolPosition"], message: "poolPosition must be contiguous and match array order" });
    if (identities.has(item.screeningIdentitySha256)) ctx.addIssue({ code: "custom", path: ["items", index, "screeningIdentitySha256"], message: "screeningIdentitySha256 must be unique" });
    identities.add(item.screeningIdentitySha256);
    if (itemDigests.has(item.itemSha256)) ctx.addIssue({ code: "custom", path: ["items", index, "itemSha256"], message: "itemSha256 must be unique" });
    itemDigests.add(item.itemSha256);
    const expectedLabel = item.candidateClass === "correct" ? "CORRECT" : "WRONG";
    if (item.intendedLabel !== expectedLabel) ctx.addIssue({ code: "custom", path: ["items", index, "intendedLabel"], message: "intendedLabel does not derive from candidateClass" });
    if (item.poolKind === "main") {
      if (mainSlots.has(item.slotId)) ctx.addIssue({ code: "custom", path: ["items", index, "slotId"], message: "main slotId must be unique" });
      mainSlots.add(item.slotId);
      if (mainLineages.has(item.sourceQuestionLineageId)) ctx.addIssue({ code: "custom", path: ["items", index, "sourceQuestionLineageId"], message: "main sourceQuestionLineageId must be unique" });
      mainLineages.add(item.sourceQuestionLineageId);
    }
  }
  if (mains.length !== 240) ctx.addIssue({ code: "custom", path: ["items"], message: "pool must contain exactly 240 main items" });
  const lastMainPosition = Math.max(...mains.map((item) => item.poolPosition));
  for (const [index, item] of pool.items.entries()) {
    if (item.poolKind === "reserve" && item.poolPosition <= lastMainPosition) ctx.addIssue({ code: "custom", path: ["items", index, "poolPosition"], message: "all shared reserves must follow all main items in pool order" });
  }
  const expectedSlotIds = Array.from({ length: 240 }, (_, index) => `slot-${(index + 1).toString().padStart(3, "0")}`);
  const actualSlotIds = [...mainSlots].sort(compareCodeUnitStrings);
  if (actualSlotIds.length !== expectedSlotIds.length || actualSlotIds.some((value, index) => value !== expectedSlotIds[index])) ctx.addIssue({ code: "custom", path: ["items"], message: "main slots must be exactly slot-001 through slot-240" });
  for (const candidateClass of SCREENING_POOL_CANDIDATE_CLASSES) for (const stratum of SCREENING_POOL_STRATA) {
    if (mains.filter((item) => item.candidateClass === candidateClass && item.stratum === stratum).length !== 20) ctx.addIssue({ code: "custom", path: ["items"], message: `main pool must contain 20 ${candidateClass}/${stratum} items` });
    const reserves = pool.items
      .filter((item): item is Extract<ScreeningPoolV2Item, { poolKind: "reserve" }> => item.poolKind === "reserve" && item.candidateClass === candidateClass && item.stratum === stratum)
      .sort((left, right) => left.reserveOrder - right.reserveOrder);
    for (const [index, reserve] of reserves.entries()) {
      if (reserve.reserveOrder !== index + 1) ctx.addIssue({ code: "custom", path: ["items"], message: `${candidateClass}/${stratum} reserveOrder must be contiguous and unique` });
    }
  }
});
export type ScreeningPoolV2 = z.infer<typeof ScreeningPoolV2Schema>;

export const ScreeningPoolSchema = z.discriminatedUnion("protocol", [
  ScreeningPoolV1Schema,
  ScreeningPoolV2Schema,
]);
export type ScreeningPool = z.infer<typeof ScreeningPoolSchema>;

export const ScreeningSampleCommitmentV1Schema = z.strictObject({
  protocol: z.literal(SCREENING_SAMPLE_COMMITMENT_PROTOCOL),
  draftId: IdentitySchema,
  poolSha256: DigestSchema,
  poolIdentityCommitmentSha256: DigestSchema,
  samplingProcedure: z.literal("screening-sample/1"),
  sampleSeed: z.string().min(1),
  sampleSize: z.literal(72),
  sampleItemSha256s: z.array(DigestSchema).length(72).superRefine((values, ctx) => {
    for (let index = 1; index < values.length; index += 1) {
      if (compareCodeUnitStrings(values[index - 1]!, values[index]!) >= 0) ctx.addIssue({ code: "custom", message: "sample identities must be sorted and unique" });
    }
  }),
  committedAt: TimestampSchema,
});
export type ScreeningSampleCommitmentV1 = z.infer<typeof ScreeningSampleCommitmentV1Schema>;

/**
 * Exact public identity-only commitments made by an external registration repository. Unlike the
 * internal v1 envelope, this record deliberately does not claim that the later label-bearing pool
 * bridge existed at registration time. Its sorted identities, product-defined pool digest, seed,
 * sample size, script digest, and timestamp are sufficient to replay the committed sample.
 */
export const RegisteredScreeningSampleCommitmentV1Schema = z.strictObject({
  schema: z.string().url(),
  candidateItemDigests: z.array(DigestSchema).length(664),
  committedAt: TimestampSchema,
  poolDigest: DigestSchema,
  sampleSeed: z.string().min(1),
  sampleSize: z.literal(72),
  samplingScriptSha256: DigestSchema,
}).superRefine((commitment, ctx) => {
  for (let index = 1; index < commitment.candidateItemDigests.length; index += 1) {
    if (compareCodeUnitStrings(commitment.candidateItemDigests[index - 1]!, commitment.candidateItemDigests[index]!) >= 0) {
      ctx.addIssue({ code: "custom", path: ["candidateItemDigests"], message: "registered identities must be sorted and unique" });
      return;
    }
  }
});
export type RegisteredScreeningSampleCommitmentV1 = z.infer<typeof RegisteredScreeningSampleCommitmentV1Schema>;

export const ScreeningSampleCommitmentSchema = z.union([
  ScreeningSampleCommitmentV1Schema,
  RegisteredScreeningSampleCommitmentV1Schema,
]);
export type ScreeningSampleCommitment = z.infer<typeof ScreeningSampleCommitmentSchema>;

const ScreeningDecisionSchema = z.enum(["CORRECT", "WRONG", "UNSURE"]);
const RitsuScreeningDecisionSchema = z.discriminatedUnion("checked", [
  z.strictObject({ checked: z.literal(false) }),
  z.strictObject({ checked: z.literal(true), verdict: z.enum(["confirm", "exclude"]), decidedAt: TimestampSchema }),
]);
export const PromptedScreeningRowV2Schema = z.strictObject({
  itemSha256: DigestSchema,
  intendedLabel: BinaryJudgmentTruthLabelSchema,
  screeningVerdict: ScreeningDecisionSchema,
  terraReviewVerdict: ScreeningDecisionSchema.optional(),
  solReviewVerdict: ScreeningDecisionSchema.optional(),
  ritsuDecision: RitsuScreeningDecisionSchema,
});
export type PromptedScreeningRowV2 = z.infer<typeof PromptedScreeningRowV2Schema>;

/** Signed authority decision table for the prompted Codex procedure. */
export const ScreeningTableV2Schema = z.strictObject({
  protocol: z.literal(SCREENING_TABLE_V2_PROTOCOL),
  draftId: IdentitySchema,
  procedureSha256: DigestSchema,
  coordinatorPromptSha256: DigestSchema,
  poolSha256: DigestSchema,
  sampleCommitmentSha256: DigestSchema,
  samplingScriptSha256: DigestSchema,
  transcriptSha256: DigestSchema,
  operator: z.literal("Ritsu"),
  rows: z.array(PromptedScreeningRowV2Schema).length(664),
  sealedAt: TimestampSchema,
}).superRefine((table, ctx) => {
  for (let index = 1; index < table.rows.length; index += 1) {
    if (compareCodeUnitStrings(table.rows[index - 1]!.itemSha256, table.rows[index]!.itemSha256) >= 0) {
      ctx.addIssue({ code: "custom", path: ["rows"], message: "rows must be sorted by itemSha256 and unique" });
      return;
    }
  }
});
export type ScreeningTableV2 = z.infer<typeof ScreeningTableV2Schema>;

// The two-human-review reasons (unchanged) and the screened-branch reasons this packet adds
// (spec §6.4; packet P6). This is one of four widened copies of the closed reason vocabulary
// (the other three: verify/src/schema.ts's exclusions[].reason, verify/src/admission/
// verification.ts's VerifiedBinaryJudgmentAdmissionExclusion.reason, and
// core/src/operations/human-review.ts's HumanAdmissionExclusionSummary.reason) — duplicated
// with a comment at each site rather than imported, matching this package's existing pattern for
// shared closed vocabularies (e.g. IDENTIFIER_NAME above) and its standalone-verifier posture.
// Two further sites carry the vocabulary but are deliberately left narrow: human-review.ts's
// exclusion-reason derivation ternary and its downstream type guard structurally cannot produce
// a screening-* value without the screened branch's own construction logic (out of scope, see
// this packet's report), so widening their literal sets would be inert. A seventh site,
// verification.ts's `expectedExclusionReason` (recomputation logic, S3's), is out of scope too.
const HUMAN_REVIEW_LEDGER_REASONS = ["review-disagreement", "review-indeterminate", "review-incomplete"] as const;
// Derived from §6.4's admission rule (`admitted := handChecked ? (handVerdict === "confirm") :
// agreed`): a row is excluded because the screen disagreed with the intended label, because the
// screen's verdict was indeterminate, or because the operator's hand check excluded it (including
// the R-3 tie-break: a screen-agreed row the hand check overrode).
const SCREENING_LEDGER_REASONS = ["screening-disagreement", "screening-indeterminate", "screening-hand-excluded"] as const;
export const HumanReviewReplacementLedgerEntrySchema = z.strictObject({
  excludedItemSha256: DigestSchema,
  replacementItemSha256: DigestSchema,
  candidateClass: CandidateClassSchema,
  stratum: BinaryJudgmentStratumSchema,
  excludedPoolPosition: z.number().int().positive(),
  replacementPoolPosition: z.number().int().positive(),
  reason: z.enum([...HUMAN_REVIEW_LEDGER_REASONS, ...SCREENING_LEDGER_REASONS]),
  // Required by closure replay for shared-slice pool/v2 replacements. It names the main slot that
  // receives the reserve; the reserve itself carries no static slot ownership.
  receivingSlotId: z.string().regex(/^slot-[0-9]{3}$/u).optional(),
  // Per-item two-human apparatus (spec §6.9 deliberately drops it for the screened branch):
  // present if and only if `reason` is one of the three two-human reasons above.
  reviewVerdictSha256s: SortedUniqueDigestPairSchema.optional(),
  visibilityReceiptSha256s: SortedUniqueDigestPairSchema.optional(),
  reviewerRosterSha256: DigestSchema.optional(),
  revealReceiptSha256: DigestSchema.optional(),
}).superRefine((entry, ctx) => {
  const isTwoHuman = (HUMAN_REVIEW_LEDGER_REASONS as readonly string[]).includes(entry.reason);
  const twoHumanFields = [
    ["reviewVerdictSha256s", entry.reviewVerdictSha256s],
    ["visibilityReceiptSha256s", entry.visibilityReceiptSha256s],
    ["reviewerRosterSha256", entry.reviewerRosterSha256],
    ["revealReceiptSha256", entry.revealReceiptSha256],
  ] as const;
  for (const [field, value] of twoHumanFields) {
    if (isTwoHuman && value === undefined) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} is required for a two-human-review reason` });
    }
    if (!isTwoHuman && value !== undefined) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} must be absent for a screening reason` });
    }
  }
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
  truthAdmission: z.enum(["two-human-unanimous", "operator-only", "screened-operator-sampled"]),
  labelResolutionSha256s: SortedUniqueDigestListSchema,
  analysisContextSha256s: SortedUniqueDigestListSchema,
  excludedItemSha256s: SortedUniqueDigestListSchema,
  replacementLedgerSha256: DigestSchema,
  // Present if and only if truthAdmission === "screened-operator-sampled" (spec §6.8). Existing
  // two-human-unanimous and operator-only manifests stay byte-identical: this key is absent for
  // both, exactly as it is today.
  screeningTableSha256: DigestSchema.optional(),
  admittedAt: TimestampSchema,
}).superRefine((manifest, ctx) => {
  const isScreened = manifest.truthAdmission === "screened-operator-sampled";
  if (isScreened && manifest.screeningTableSha256 === undefined) {
    ctx.addIssue({ code: "custom", path: ["screeningTableSha256"], message: "screeningTableSha256 is required for screened-operator-sampled admission" });
  }
  if (!isScreened && manifest.screeningTableSha256 !== undefined) {
    ctx.addIssue({ code: "custom", path: ["screeningTableSha256"], message: "screeningTableSha256 must be absent outside screened-operator-sampled admission" });
  }
});
export type BinaryJudgmentAdmissionManifest = z.infer<typeof BinaryJudgmentAdmissionManifestSchema>;
