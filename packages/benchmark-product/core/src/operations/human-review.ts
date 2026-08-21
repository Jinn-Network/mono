// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
  BinaryJudgmentItemIdSchema,
  BinaryJudgmentPayloadSchema,
  BinaryJudgmentStratumSchema,
  BinaryJudgmentTruthLabelSchema,
  canonicalJsonBytes,
  compareCodeUnitStrings,
  parseBinaryJudgmentInstrument,
  parseBinaryJudgmentPayload,
  recordDigest,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentLabelResolution,
  type BinaryJudgmentLabelResolution,
} from "@jinn-network/task-execution-profiles";
import { buildResultEvaluationPayload } from "@jinn-network/attestation-issuer";
import { dssePreAuthEncoding, parseExactDsseEnvelope, sealDsseEnvelope } from "@jinn-network/trust-core";
import { BenchmarkProductError, refuse, refuseWithIssues } from "../errors.js";
import {
  BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED,
  HUMAN_REVIEW_FORM,
  HUMAN_REVIEW_FORM_SEALED,
  binaryJudgmentItemBytes,
} from "../human-review/application.js";
import {
  BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
  BinaryJudgmentAdmissionManifestSchema,
  HUMAN_REVIEW_OMITTED_FIELDS,
  HUMAN_REVIEW_PACKET_MEDIA_TYPE,
  HUMAN_REVIEW_PACKET_PROTOCOL,
  HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL,
  HUMAN_REVIEW_REVEAL_RECEIPT_MEDIA_TYPE,
  HUMAN_REVIEW_RESPONSE_MEDIA_TYPE,
  HUMAN_REVIEW_RESPONSE_PROTOCOL,
  HUMAN_REVIEW_REVEAL_RECEIPT_PROTOCOL,
  HUMAN_REVIEW_ROSTER_PROTOCOL,
  HUMAN_REVIEW_ROSTER_MEDIA_TYPE,
  HUMAN_REVIEW_VISIBILITY_RECEIPT_MEDIA_TYPE,
  HUMAN_REVIEW_VISIBILITY_RECEIPT_PROTOCOL,
  HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL,
  HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE,
  SCREENING_TABLE_PROTOCOL,
  SCREENING_TABLE_MEDIA_TYPE,
  SCREENING_REVEAL_RECEIPT_PROTOCOL,
  SCREENING_REVEAL_RECEIPT_MEDIA_TYPE,
  HumanReviewOperatorAssertionSchema,
  HumanReviewPacketSchema,
  HumanReviewReplacementLedgerSchema,
  HumanReviewResponseSchema,
  HumanReviewRevealReceiptSchema,
  HumanReviewRosterSchema,
  HumanReviewVisibilityReceiptSchema,
  ScreeningRowSchema,
  ScreeningTableSchema,
  ScreeningRevealReceiptSchema,
  parseCanonicalHumanReviewBytes,
  sealHumanReviewDocument,
  type ScreeningRow,
} from "../human-review/contracts.js";
import {
  BinaryJudgmentAdmissionClosureError,
  verifyBinaryJudgmentAdmissionClosure,
  verifyBinaryJudgmentReviewerResult,
} from "../human-review/verification.js";
import { buildBinaryJudgmentAdmissionClosureWorkspacePorts } from "../human-review/verification-workspace.js";
import {
  createVerdictDsseSigner,
  loadOrCreateEvaluatorSigningKeys,
  sealVerdictStatement,
} from "../venue/signing.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import { operateAsync } from "./operate-async.js";
import type { OperationContext } from "./context.js";
import type { OperationResult } from "./result.js";

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
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
const ReviewerInputSchema = z.strictObject({
  evaluatorId: EvaluatorIdentitySchema,
  personId: IdentitySchema,
  role: IdentitySchema,
  conflicts: ConflictListSchema,
});

export interface CreateHumanReviewPacketsInput {
  readonly draftId: string;
  readonly item: unknown;
  readonly evaluatorIds: readonly [string, string];
}

export interface HumanReviewPacketSummary {
  readonly reviewerId: string;
  readonly packetSha256: string;
  readonly visibilityReceiptSha256: string;
}

export interface CreateHumanReviewPacketsResult {
  readonly itemSha256: string;
  readonly humanReviewEvaluationSpecSha256: string;
  readonly packets: readonly HumanReviewPacketSummary[];
}

export interface SignHumanReviewResponseInput {
  readonly draftId: string;
  /** Complete, stable signer inventory; keys are loaded from existing evaluator-key custody. */
  readonly configuredEvaluatorIds: readonly string[];
  readonly activeEvaluatorId: string;
  readonly packetSha256: string;
  readonly visibilityReceiptSha256: string;
  readonly label: "CORRECT" | "WRONG" | "indeterminate";
  readonly complete: boolean;
  readonly completedAt: string;
}

export interface SignHumanReviewResponseResult {
  readonly evaluatorId: string;
  readonly responseSha256: string;
  readonly verdictSha256: string;
  readonly envelopeBase64: string;
}

export interface HumanAdmissionCandidateInput {
  readonly itemSha256: string;
  readonly itemId: string;
  readonly humanReviewEvaluationSpecSha256: string;
  readonly candidateClass: string;
  readonly stratum: string;
  readonly poolPosition: number;
  readonly reviewVerdictSha256s?: readonly [string, string];
  readonly reviewers?: readonly [
    { readonly evaluatorId: string; readonly personId: string; readonly role: string; readonly conflicts: readonly string[] },
    { readonly evaluatorId: string; readonly personId: string; readonly role: string; readonly conflicts: readonly string[] },
  ];
  readonly operatorTruthLabel?: "CORRECT" | "WRONG";
  readonly replacesItemSha256?: string;
}

/** One row of the caller-supplied screening table (spec §6.3). Identical shape to the frozen
 * `ScreeningRowSchema` wire record — reused directly at parse time, not duplicated. */
export interface AdmitHumanTruthScreeningRowInput {
  readonly itemSha256: string;
  readonly intendedLabel: "CORRECT" | "WRONG";
  readonly screeningVerdict: "CORRECT" | "WRONG" | "indeterminate";
  readonly handChecked: boolean;
  readonly handVerdict?: "confirm" | "exclude";
}

/** Bank-scoped screening-table content (spec §6.3), required if and only if `truthAdmission` is
 * `"screened-operator-sampled"`. One table, not one per candidate: RULING C-4. */
export interface AdmitHumanTruthScreeningInput {
  readonly screeningInstrumentSha256: string;
  readonly screeningInstrumentBase64: string;
  readonly sampleSeed: string;
  readonly sampleSize: number;
  readonly samplingScriptSha256: string;
  readonly samplingScriptBase64: string;
  readonly rawOutputsSha256: string;
  readonly rawOutputsBase64: string;
  readonly rows: readonly AdmitHumanTruthScreeningRowInput[];
}

export interface AdmitHumanTruthInput {
  readonly draftId: string;
  readonly truthAdmission: "two-human-unanimous" | "operator-only" | "screened-operator-sampled";
  readonly candidates: readonly HumanAdmissionCandidateInput[];
  /** Optional compact Result Evaluation envelopes imported from the file manifest. */
  readonly evidenceEnvelopesBase64?: readonly string[];
  /** Bank-scoped, not per-candidate (spec §6.3, §6.9): the caller supplies the table's rows and
   * parameters, and this operation validates, canonicalizes, DSSE-signs under the existing single
   * authoritySigner, and stores (RULING C-4) — mirroring how the reviewer roster is sealed today. */
  readonly screening?: AdmitHumanTruthScreeningInput;
}

export interface HumanAdmissionResolutionSummary {
  readonly itemSha256: string;
  readonly labelResolutionSha256: string;
  readonly analysisContextSha256: string;
}

export interface HumanAdmissionExclusionSummary {
  readonly itemSha256: string;
  // Widened spec §6.4 (packet P6). This function's own construction path (below) does not yet
  // produce the three screening-* values — that is the screened admission's own construction
  // logic, out of this packet's scope — but the public result type stays forward-compatible with
  // the wider sealed-ledger vocabulary a caller may read via a different path.
  readonly reason:
    | "review-disagreement" | "review-indeterminate" | "review-incomplete"
    | "screening-disagreement" | "screening-indeterminate" | "screening-hand-excluded";
  readonly replacementItemSha256: string;
}

export interface AdmitHumanTruthResult {
  readonly admissionManifestSha256: string;
  readonly replacementLedgerSha256: string;
  readonly resolutions: readonly HumanAdmissionResolutionSummary[];
  readonly exclusions: readonly HumanAdmissionExclusionSummary[];
  readonly publicationGrade: boolean;
}

const CandidateSchema = z.strictObject({
  itemSha256: DigestSchema,
  itemId: BinaryJudgmentItemIdSchema,
  humanReviewEvaluationSpecSha256: DigestSchema,
  candidateClass: CandidateClassSchema,
  stratum: BinaryJudgmentStratumSchema,
  poolPosition: z.number().int().positive(),
  reviewVerdictSha256s: z.tuple([DigestSchema, DigestSchema]).optional(),
  reviewers: z.tuple([ReviewerInputSchema, ReviewerInputSchema]).optional(),
  operatorTruthLabel: BinaryJudgmentTruthLabelSchema.optional(),
  replacesItemSha256: DigestSchema.optional(),
});

// Bank-scoped screening-table input (spec §6.3; packet P6). `rows` reuses S1's frozen
// `ScreeningRowSchema` directly rather than duplicating its shape or refinement (handVerdict
// present iff handChecked) — the wire row and the input row are the identical shape.
const ScreeningInputSchema = z.strictObject({
  screeningInstrumentSha256: DigestSchema,
  screeningInstrumentBase64: z.string(),
  sampleSeed: z.string().min(1),
  sampleSize: z.number().int().positive(),
  samplingScriptSha256: DigestSchema,
  samplingScriptBase64: z.string(),
  rawOutputsSha256: DigestSchema,
  rawOutputsBase64: z.string(),
  rows: z.array(ScreeningRowSchema),
});

// Widened spec §6.7 (packet P6): a third admission mode. `screening` present-iff is enforced at
// runtime inside `admitHumanTruth` (spec §6.9's cross-field rule), matching how the existing two
// modes' per-candidate requirements (`operatorTruthLabel` vs. `reviewVerdictSha256s`/`reviewers`)
// are already enforced at runtime rather than in this schema.
const AdmitInputSchema = z.strictObject({
  draftId: IdentitySchema,
  truthAdmission: z.enum(["two-human-unanimous", "operator-only", "screened-operator-sampled"]),
  candidates: z.array(CandidateSchema).min(1),
  evidenceEnvelopesBase64: z.array(z.string().min(1)).optional(),
  screening: ScreeningInputSchema.optional(),
});

function prefixed(value: string): `sha256:${string}` {
  return (value.startsWith("sha256:") ? value : `sha256:${value}`) as `sha256:${string}`;
}

function bare(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function sortedPair(values: readonly [string, string]): [`sha256:${string}`, `sha256:${string}`] {
  const sorted = values.map(prefixed).sort(compareCodeUnitStrings);
  if (sorted[0] === sorted[1]) refuse("validation", "reviewVerdictSha256s", "review verdict digests must be distinct");
  return [sorted[0]!, sorted[1]!];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function decodeCanonicalBase64(value: string, path: string): Uint8Array {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    refuse("validation", path, "record bytes must use canonical RFC 4648 base64");
  }
  return new Uint8Array(decoded);
}

function sealRoleEvidence(
  workspaceDir: string,
  payload: { readonly bytes: Uint8Array },
  payloadType: string,
  signer: ReturnType<typeof loadOrCreateReportSigningKey>,
): `sha256:${string}` {
  const envelopeBytes = sealDsseEnvelope({
    payloadType,
    payloadBytes: payload.bytes,
    signatures: [{
      keyid: signer.keyId,
      signature: signer.sign(dssePreAuthEncoding(payloadType, payload.bytes)),
    }],
  });
  putSealedBytes(workspaceDir, payload.bytes);
  return prefixed(putSealedBytes(workspaceDir, envelopeBytes));
}

function assertPreRunDraft(context: OperationContext, draftId: string): void {
  const draft = readDraftDocument(context.workspaceDir, draftId);
  if (draft.state !== "draft" && draft.state !== "quoted") {
    refuse(
      "illegal-transition",
      `drafts.${draftId}.state`,
      "human truth must be frozen before judge run lock or execution",
    );
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    refuseWithIssues("validation", parsed.error.issues.map((issue) => ({
      path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
      message: issue.message,
    })));
  }
  return parsed.data;
}

export function createHumanReviewPackets(
  context: OperationContext,
  input: CreateHumanReviewPacketsInput,
): OperationResult<CreateHumanReviewPacketsResult> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operate({
    context: clocked,
    action: "human-review.packet.create",
    subject: input.draftId,
    inputs: input,
    run: () => {
      assertPreRunDraft(clocked, input.draftId);
      const item = parseInput(BinaryJudgmentPayloadSchema, input.item);
      if (
        input.evaluatorIds.length !== 2
        || input.evaluatorIds[0] === input.evaluatorIds[1]
        || input.evaluatorIds.some((id) => !EvaluatorIdentitySchema.safeParse(id).success)
      ) {
        refuse("validation", "evaluatorIds", "exactly two distinct configured evaluator identities are required");
      }
      const itemBytes = binaryJudgmentItemBytes(item);
      const itemSha256 = recordDigest(itemBytes);
      putSealedBytes(clocked.workspaceDir, itemBytes);
      const humanReviewEvaluationSpecSha256 = BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest;
      putSealedBytes(clocked.workspaceDir, BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.bytes);
      putSealedBytes(clocked.workspaceDir, HUMAN_REVIEW_FORM_SEALED.bytes);

      const packets = [...input.evaluatorIds].sort(compareCodeUnitStrings).map((reviewerId) => {
        const packet = sealHumanReviewDocument(HumanReviewPacketSchema, {
          protocol: HUMAN_REVIEW_PACKET_PROTOCOL,
          itemSha256,
          item,
          evaluationSpecSha256: humanReviewEvaluationSpecSha256,
          reviewerId,
          form: {
            question: HUMAN_REVIEW_FORM.question,
            labels: HUMAN_REVIEW_FORM.labels,
            completeReviewRequired: true,
          },
        }, "human review packet");
        putSealedBytes(clocked.workspaceDir, packet.bytes);
        const visibility = sealHumanReviewDocument(HumanReviewVisibilityReceiptSchema, {
          protocol: HUMAN_REVIEW_VISIBILITY_RECEIPT_PROTOCOL,
          packetSha256: packet.digest,
          itemSha256,
          reviewerId,
          omittedFields: HUMAN_REVIEW_OMITTED_FIELDS,
          issuedAt: at,
        }, "visibility receipt");
        putSealedBytes(clocked.workspaceDir, visibility.bytes);
        return {
          reviewerId,
          packetSha256: packet.digest,
          visibilityReceiptSha256: visibility.digest,
        };
      });
      return {
        itemSha256,
        humanReviewEvaluationSpecSha256,
        packets,
      };
    },
  });
}

export async function signHumanReviewResponse(
  context: OperationContext,
  input: SignHumanReviewResponseInput,
): Promise<OperationResult<SignHumanReviewResponseResult>> {
  return operateAsync({
    context,
    action: "human-review.response.sign",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      assertPreRunDraft(context, input.draftId);
      const configured = [...input.configuredEvaluatorIds];
      if (
        configured.length < 2
        || new Set(configured).size !== configured.length
        || configured.some((id) => !EvaluatorIdentitySchema.safeParse(id).success)
      ) {
        refuse("validation", "configuredEvaluatorIds", "configured evaluator identities must be a distinct stable inventory");
      }
      if (!configured.includes(input.activeEvaluatorId)) {
        refuse("validation", "activeEvaluatorId", "active evaluator is absent from the configured signer inventory");
      }
      const packet = parseCanonicalHumanReviewBytes(
        HumanReviewPacketSchema,
        getSealedBytes(context.workspaceDir, bare(input.packetSha256)),
        "human review packet",
      );
      const visibility = parseCanonicalHumanReviewBytes(
        HumanReviewVisibilityReceiptSchema,
        getSealedBytes(context.workspaceDir, bare(input.visibilityReceiptSha256)),
        "visibility receipt",
      );
      if (recordDigest(canonicalJsonBytes(packet.item)) !== packet.itemSha256) {
        refuse("validation", "packet.itemSha256", "packet embedded item bytes do not match itemSha256");
      }
      if (packet.reviewerId !== input.activeEvaluatorId || visibility.reviewerId !== input.activeEvaluatorId) {
        refuse("validation", "activeEvaluatorId", "configured signer is not the reviewer named by the packet and visibility receipt");
      }
      if (visibility.packetSha256 !== prefixed(input.packetSha256) || visibility.itemSha256 !== packet.itemSha256) {
        refuse("validation", "visibilityReceiptSha256", "visibility receipt does not bind the selected packet and item");
      }
      if (Date.parse(input.completedAt) < Date.parse(visibility.issuedAt)) {
        refuse("validation", "completedAt", "review completion cannot precede the visibility receipt");
      }
      if (packet.evaluationSpecSha256 !== BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest) {
        refuse("validation", "packet.evaluationSpecSha256", "packet does not bind the registered human-review EvaluationSpec");
      }
      const response = sealHumanReviewDocument(HumanReviewResponseSchema, {
        protocol: HUMAN_REVIEW_RESPONSE_PROTOCOL,
        packetSha256: prefixed(input.packetSha256),
        visibilityReceiptSha256: prefixed(input.visibilityReceiptSha256),
        itemSha256: packet.itemSha256,
        evaluatorId: input.activeEvaluatorId,
        label: input.label,
        complete: input.complete,
        completedAt: input.completedAt,
      }, "human review response");
      putSealedBytes(context.workspaceDir, response.bytes);

      const keys = loadOrCreateEvaluatorSigningKeys(
        context.workspaceDir,
        configured.map((id) => ({ id })),
      );
      const active = keys.find((entry) => entry.id === input.activeEvaluatorId)!;
      const verdict = input.complete
        ? input.label === "CORRECT" ? "pass" : input.label === "WRONG" ? "fail" : "inconclusive"
        : "inconclusive";
      const statementBytes = buildResultEvaluationPayload({
        task: { name: "binary-judgment-item", digest: prefixed(packet.itemSha256) },
        results: [{
          name: "human-review-response",
          digest: response.digest,
          mediaType: HUMAN_REVIEW_RESPONSE_MEDIA_TYPE,
        }],
        evaluator: {
          id: input.activeEvaluatorId,
          extensions: { "network.jinn.reviewer.keyid": active.key.keyId },
        },
        evaluatedAt: input.completedAt,
        verdict,
        evaluationSpecification: {
          name: "human-review-evaluation-spec",
          digest: prefixed(packet.evaluationSpecSha256),
        },
        measurements: [
          { name: "truthLabel", value: input.label },
          { name: "reviewComplete", value: input.complete },
          { name: "reviewPacketSha256", value: prefixed(input.packetSha256) },
          { name: "visibilityReceiptSha256", value: prefixed(input.visibilityReceiptSha256) },
          { name: "responseSha256", value: response.digest },
        ],
        evidence: [
          { name: "human-review-packet", digest: prefixed(input.packetSha256), mediaType: HUMAN_REVIEW_PACKET_MEDIA_TYPE },
          { name: "visibility-receipt", digest: prefixed(input.visibilityReceiptSha256), mediaType: HUMAN_REVIEW_VISIBILITY_RECEIPT_MEDIA_TYPE },
          { name: "human-review-response", digest: response.digest, mediaType: HUMAN_REVIEW_RESPONSE_MEDIA_TYPE },
        ],
        limitations: ["reviewer-person-distinctness-is-roster-attested"],
      });
      const envelopeBytes = await sealVerdictStatement({
        statementBytes,
        evaluatorId: input.activeEvaluatorId,
        expectedEvaluationSpecificationSha256: bare(packet.evaluationSpecSha256),
        signer: createVerdictDsseSigner(active.key),
      });
      const verdictSha256 = prefixed(putSealedBytes(context.workspaceDir, envelopeBytes));
      return {
        evaluatorId: input.activeEvaluatorId,
        responseSha256: response.digest,
        verdictSha256,
        envelopeBase64: Buffer.from(envelopeBytes).toString("base64"),
      };
    },
  });
}

export function admitHumanTruth(
  context: OperationContext,
  input: AdmitHumanTruthInput,
): OperationResult<AdmitHumanTruthResult> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operate({
    context: clocked,
    action: "human-review.admit",
    subject: input.draftId,
    inputs: input,
    run: () => {
      assertPreRunDraft(clocked, input.draftId);
      const parsed = parseInput(AdmitInputSchema, input);
      for (const encoded of parsed.evidenceEnvelopesBase64 ?? []) {
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(Buffer.from(encoded, "base64"));
          parseExactDsseEnvelope(bytes);
        } catch {
          refuse("validation", "evidenceEnvelopesBase64", "imported evidence is not a compact exact DSSE envelope");
        }
        putSealedBytes(clocked.workspaceDir, bytes);
      }
      const positions = new Set<number>();
      const itemDigests = new Set<string>();
      for (const candidate of parsed.candidates) {
        if (positions.has(candidate.poolPosition)) refuse("validation", "candidates.poolPosition", "pool positions must be unique");
        if (itemDigests.has(candidate.itemSha256)) refuse("validation", "candidates.itemSha256", "candidate item digests must be unique");
        positions.add(candidate.poolPosition);
        itemDigests.add(candidate.itemSha256);
      }
      const authoritySigner = loadOrCreateReportSigningKey(clocked.workspaceDir);
      // The closure verifier treats the frozen EvaluationSpec like every other reachable CAS
      // record. Admission must therefore be self-contained even when callers import already
      // signed review evidence without first using the packet-creation convenience operation.
      putSealedBytes(
        clocked.workspaceDir,
        BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.bytes,
      );
      putSealedBytes(clocked.workspaceDir, HUMAN_REVIEW_FORM_SEALED.bytes);
      const verificationPorts = buildBinaryJudgmentAdmissionClosureWorkspacePorts(clocked.workspaceDir);

      // Screened-operator-sampled admission (spec §6.3, §6.9; packet P6 item A, RULING C-4):
      // one bank-scoped table and one bank-scoped reveal receipt, sealed ONCE here — before the
      // per-candidate loop below, which reads `screeningRowsByItem` to decide each candidate's
      // admission per §6.4. RULING C-6: both are DSSE-signed via `sealRoleEvidence`, exactly like
      // the reviewer roster and per-item reveal receipt, under the SAME `authoritySigner` key —
      // never a second signer, and never bare canonical JSON.
      if (parsed.truthAdmission === "screened-operator-sampled" && parsed.screening === undefined) {
        refuse("validation", "screening", "screened-operator-sampled admission requires bank-scoped screening table content");
      }
      if (parsed.truthAdmission !== "screened-operator-sampled" && parsed.screening !== undefined) {
        refuse("validation", "screening", "screening table content is only accepted for screened-operator-sampled admission");
      }
      let screeningTableSha256: `sha256:${string}` | undefined;
      let screeningRevealReceiptSha256: `sha256:${string}` | undefined;
      let screeningRowsByItem = new Map<string, ScreeningRow>();
      if (parsed.truthAdmission === "screened-operator-sampled" && parsed.screening !== undefined) {
        const screeningInstrumentBytes = decodeCanonicalBase64(
          parsed.screening.screeningInstrumentBase64,
          "screening.screeningInstrumentBase64",
        );
        const samplingScriptBytes = decodeCanonicalBase64(
          parsed.screening.samplingScriptBase64,
          "screening.samplingScriptBase64",
        );
        const rawOutputsBytes = decodeCanonicalBase64(
          parsed.screening.rawOutputsBase64,
          "screening.rawOutputsBase64",
        );
        for (const [path, expectedDigest, bytes] of [
          ["screening.screeningInstrumentSha256", parsed.screening.screeningInstrumentSha256, screeningInstrumentBytes],
          ["screening.samplingScriptSha256", parsed.screening.samplingScriptSha256, samplingScriptBytes],
          ["screening.rawOutputsSha256", parsed.screening.rawOutputsSha256, rawOutputsBytes],
        ] as const) {
          if (recordDigest(bytes) !== expectedDigest) {
            refuse("validation", path, "declared digest does not match the supplied exact bytes");
          }
        }
        let screeningInstrument: ReturnType<typeof parseBinaryJudgmentInstrument>;
        try {
          screeningInstrument = parseBinaryJudgmentInstrument(screeningInstrumentBytes);
        } catch (cause) {
          refuse(
            "validation",
            "screening.screeningInstrumentBase64",
            `screening instrument is outside the sealed BinaryJudgmentInstrument contract: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
        const resealedScreeningInstrument = sealBinaryJudgmentInstrument(screeningInstrument);
        if (
          resealedScreeningInstrument.digest !== parsed.screening.screeningInstrumentSha256
          || !bytesEqual(resealedScreeningInstrument.bytes, screeningInstrumentBytes)
        ) {
          refuse(
            "validation",
            "screening.screeningInstrumentBase64",
            "screening instrument must be exact canonical bytes that reseal to its declared digest",
          );
        }
        // Store only after every nested record and the instrument contract have validated, so a
        // refused admission does not leave a partially imported screening closure.
        putSealedBytes(clocked.workspaceDir, screeningInstrumentBytes);
        putSealedBytes(clocked.workspaceDir, samplingScriptBytes);
        putSealedBytes(clocked.workspaceDir, rawOutputsBytes);
        const table = sealHumanReviewDocument(ScreeningTableSchema, {
          protocol: SCREENING_TABLE_PROTOCOL,
          draftId: parsed.draftId,
          screeningInstrumentSha256: parsed.screening.screeningInstrumentSha256,
          sampleSeed: parsed.screening.sampleSeed,
          sampleSize: parsed.screening.sampleSize,
          samplingScriptSha256: parsed.screening.samplingScriptSha256,
          rawOutputsSha256: parsed.screening.rawOutputsSha256,
          rows: parsed.screening.rows,
          sealedAt: at,
        }, "screening table");
        screeningTableSha256 = sealRoleEvidence(clocked.workspaceDir, table, SCREENING_TABLE_MEDIA_TYPE, authoritySigner);
        const reveal = sealHumanReviewDocument(ScreeningRevealReceiptSchema, {
          protocol: SCREENING_REVEAL_RECEIPT_PROTOCOL,
          draftId: parsed.draftId,
          screeningTableSha256,
          truthFrozenAt: at,
          judgeExecutionState: "not-started",
          attestedBy: clocked.principal,
          attestorKeyId: authoritySigner.keyId,
          attestorRole: "truth-reveal-attestor",
        }, "screening reveal receipt");
        screeningRevealReceiptSha256 = sealRoleEvidence(clocked.workspaceDir, reveal, SCREENING_REVEAL_RECEIPT_MEDIA_TYPE, authoritySigner);
        screeningRowsByItem = new Map(table.value.rows.map((row) => [row.itemSha256, row] as const));
      }

      const evaluated = [...parsed.candidates]
        .sort((left, right) => left.poolPosition - right.poolPosition)
        .map((candidate) => {
          const itemBytes = getSealedBytes(clocked.workspaceDir, bare(candidate.itemSha256));
          const item = parseBinaryJudgmentPayload(itemBytes);
          if (
            recordDigest(canonicalJsonBytes(item)) !== candidate.itemSha256
            || !bytesEqual(canonicalJsonBytes(item), itemBytes)
            || item.itemId !== candidate.itemId
          ) {
            refuse("validation", "candidates.itemSha256", "candidate must resolve to exact canonical F0 item bytes with the declared itemId");
          }
          if (candidate.humanReviewEvaluationSpecSha256 !== BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest) {
            refuse("validation", "humanReviewEvaluationSpecSha256", "candidate does not bind the registered human-review EvaluationSpec");
          }
          // Exhaustive switch over the three-member truthAdmission union, never-typed default
          // (spec §6.8a Group B; packet P6 item B). A widened enum plus an untouched === chain is
          // WORSE than an unwidened one, because the unwidened one refuses and the widened one
          // proceeds: a fourth admission mode in future must be a compile error here, not a
          // silent reroute into an existing path.
          switch (parsed.truthAdmission) {
            case "operator-only": {
              if (candidate.operatorTruthLabel === undefined || candidate.reviewVerdictSha256s !== undefined || candidate.reviewers !== undefined) {
                refuse("validation", "candidates", "operator-only admission requires one operator truth and forbids publication-grade review evidence");
              }
              return { candidate, truth: candidate.operatorTruthLabel } as const;
            }
            case "screened-operator-sampled": {
              // Screened truth comes from the bank-scoped table (spec §6.4), never from
              // per-candidate operator or review fields.
              if (candidate.operatorTruthLabel !== undefined || candidate.reviewVerdictSha256s !== undefined || candidate.reviewers !== undefined) {
                refuse("validation", "candidates", "screened admission forbids operator truth and review evidence; truth comes from the bank-scoped screening table");
              }
              const row = screeningRowsByItem.get(candidate.itemSha256);
              if (row === undefined) refuse("validation", "candidates.itemSha256", "candidate has no covering screening-table row");
              // Per-row admission rule (spec §6.4): the hand check, when it happened, decides;
              // otherwise agreement decides. No label correction: an admitted item's truth is
              // always the row's own intendedLabel, never the screen's verdict.
              const agreed = row.screeningVerdict === row.intendedLabel;
              const admitted = row.handChecked ? row.handVerdict === "confirm" : agreed;
              if (admitted) return { candidate, truth: row.intendedLabel } as const;
              // R-3's tie-break (spec §6.4): a screen-agreed row the hand check overrode is
              // `screening-hand-excluded`, distinct from a flagged row's own disagreement or
              // indeterminate finding.
              const exclusionReason = !agreed
                ? (row.screeningVerdict === "indeterminate" ? "screening-indeterminate" as const : "screening-disagreement" as const)
                : "screening-hand-excluded" as const;
              return { candidate, exclusionReason } as const;
            }
            case "two-human-unanimous": {
              if (candidate.operatorTruthLabel !== undefined || candidate.reviewVerdictSha256s === undefined || candidate.reviewers === undefined) {
                refuse("validation", "candidates", "publication-grade admission requires exactly two review verdicts and two roster declarations");
              }
              const verdictDigests = sortedPair(candidate.reviewVerdictSha256s);
              let reviews: ReturnType<typeof verifyBinaryJudgmentReviewerResult>[];
              try {
                reviews = verdictDigests.map((digest) => verifyBinaryJudgmentReviewerResult({
                  verdictSha256: digest,
                  expectedItemSha256: prefixed(candidate.itemSha256),
                }, verificationPorts));
              } catch (cause) {
                if (cause instanceof BinaryJudgmentAdmissionClosureError && cause.cause instanceof BenchmarkProductError && cause.cause.code === "not-found") {
                  throw cause.cause;
                }
                refuse("validation", "reviewVerdictSha256s", cause instanceof Error ? cause.message : "review evidence verification failed");
              }
              if (reviews.some((review) => review.itemId !== candidate.itemId)) {
                refuse("validation", "itemId", "review packets do not bind the candidate itemId");
              }
              if (reviews.some((review) => Date.parse(review.completedAt) > Date.parse(at))) {
                refuse("validation", "reviewVerdictSha256s", "truth reveal cannot precede either completed review");
              }
              if (reviews[0]!.evaluatorId === reviews[1]!.evaluatorId || reviews[0]!.keyId === reviews[1]!.keyId) {
                refuse("validation", "reviewVerdictSha256s", "publication-grade reviews require distinct evaluator identities and keys");
              }
              const rosterByEvaluator = new Map(candidate.reviewers.map((reviewer) => [reviewer.evaluatorId, reviewer]));
              if (rosterByEvaluator.size !== 2 || reviews.some((review) => !rosterByEvaluator.has(review.evaluatorId))) {
                refuse("validation", "reviewers", "roster declarations must bind the exact two signed evaluator identities");
              }
              const declarations = reviews
                .map((review) => ({ ...rosterByEvaluator.get(review.evaluatorId)!, keyId: review.keyId }))
                .sort((left, right) => compareCodeUnitStrings(left.evaluatorId, right.evaluatorId));
              if (declarations[0]!.personId === declarations[1]!.personId) {
                refuse("validation", "reviewers.personId", "distinct keys do not establish distinct people; roster person ids must differ");
              }
              if (declarations.some((entry) => entry.conflicts.length > 0)) {
                refuse("validation", "reviewers.conflicts", "reviewers with declared conflicts cannot establish publication-grade truth");
              }
              const roster = sealHumanReviewDocument(HumanReviewRosterSchema, {
                protocol: HUMAN_REVIEW_ROSTER_PROTOCOL,
                itemSha256: candidate.itemSha256,
                reviewers: declarations,
                attestedBy: clocked.principal,
                attestorKeyId: authoritySigner.keyId,
                attestorRole: "roster-attestor",
                attestedAt: at,
              }, "reviewer roster");
              const reviewerRosterSha256 = sealRoleEvidence(
                clocked.workspaceDir,
                roster,
                HUMAN_REVIEW_ROSTER_MEDIA_TYPE,
                authoritySigner,
              );
              const reveal = sealHumanReviewDocument(HumanReviewRevealReceiptSchema, {
                protocol: HUMAN_REVIEW_REVEAL_RECEIPT_PROTOCOL,
                draftId: parsed.draftId,
                itemSha256: candidate.itemSha256,
                truthFrozenAt: at,
                judgeExecutionState: "not-started",
                attestedBy: clocked.principal,
                attestorKeyId: authoritySigner.keyId,
                attestorRole: "truth-reveal-attestor",
              }, "reveal receipt");
              const revealReceiptSha256 = sealRoleEvidence(
                clocked.workspaceDir,
                reveal,
                HUMAN_REVIEW_REVEAL_RECEIPT_MEDIA_TYPE,
                authoritySigner,
              );
              const exclusionReason = reviews.some((review) => !review.complete)
                ? "review-incomplete" as const
                : reviews.some((review) => review.label === "indeterminate")
                  ? "review-indeterminate" as const
                  : reviews[0]!.label !== reviews[1]!.label
                    ? "review-disagreement" as const
                    : undefined;
              return exclusionReason === undefined
                ? {
                    candidate,
                    truth: reviews[0]!.label as "CORRECT" | "WRONG",
                    reviewVerdictSha256s: verdictDigests,
                    visibilityReceiptSha256s: sortedPair([
                      reviews[0]!.visibilityReceiptSha256,
                      reviews[1]!.visibilityReceiptSha256,
                    ]),
                    reviewerRosterSha256,
                    revealReceiptSha256,
                  } as const
                : {
                    candidate,
                    exclusionReason,
                    reviewVerdictSha256s: verdictDigests,
                    visibilityReceiptSha256s: sortedPair([
                      reviews[0]!.visibilityReceiptSha256,
                      reviews[1]!.visibilityReceiptSha256,
                    ]),
                    reviewerRosterSha256,
                    revealReceiptSha256,
                  } as const;
            }
            default: {
              const exhaustive: never = parsed.truthAdmission;
              refuse("validation", "truthAdmission", `unsupported truthAdmission ${String(exhaustive)}`);
            }
          }
        });

      const excluded = evaluated.filter((entry): entry is typeof entry & {
        exclusionReason:
          | "review-disagreement" | "review-indeterminate" | "review-incomplete"
          | "screening-disagreement" | "screening-indeterminate" | "screening-hand-excluded";
      } => "exclusionReason" in entry);
      const accepted = evaluated.filter((entry): entry is typeof entry & { truth: "CORRECT" | "WRONG" } => "truth" in entry);
      const ledgerEntries = excluded.map((entry) => {
        const replacements = accepted.filter((candidate) => candidate.candidate.replacesItemSha256 === entry.candidate.itemSha256);
        if (replacements.length !== 1) {
          refuse("validation", "candidates.replacesItemSha256", "every excluded review requires exactly one admitted reserve replacement before run lock");
        }
        const replacement = replacements[0]!.candidate;
        if (
          replacement.candidateClass !== entry.candidate.candidateClass
          || replacement.stratum !== entry.candidate.stratum
          || replacement.poolPosition <= entry.candidate.poolPosition
        ) {
          refuse("validation", "candidates.replacesItemSha256", "replacement must be a later reserve in the same candidate class and stratum");
        }
        const common = {
          excludedItemSha256: entry.candidate.itemSha256,
          replacementItemSha256: replacement.itemSha256,
          candidateClass: entry.candidate.candidateClass,
          stratum: entry.candidate.stratum,
          excludedPoolPosition: entry.candidate.poolPosition,
          replacementPoolPosition: replacement.poolPosition,
          reason: entry.exclusionReason,
        };
        // Per-item two-human digests are present if and only if the reason is a two-human
        // reason (spec §6.9 deliberately drops them for the screened branch: one signature on
        // the whole table, not 240 on individual rows). `entry`'s own shape already reflects
        // this — a screened-excluded entry never carries these four fields at all.
        return "reviewVerdictSha256s" in entry
          ? {
              ...common,
              reviewVerdictSha256s: entry.reviewVerdictSha256s,
              visibilityReceiptSha256s: entry.visibilityReceiptSha256s,
              reviewerRosterSha256: entry.reviewerRosterSha256,
              revealReceiptSha256: entry.revealReceiptSha256,
            }
          : { ...common };
      });
      for (const replacement of accepted.filter((entry) => entry.candidate.replacesItemSha256 !== undefined)) {
        if (!excluded.some((entry) => entry.candidate.itemSha256 === replacement.candidate.replacesItemSha256)) {
          refuse("validation", "candidates.replacesItemSha256", "replacement points to an item that was not excluded by this admission");
        }
      }
      const ledger = sealHumanReviewDocument(HumanReviewReplacementLedgerSchema, {
        protocol: HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL,
        draftId: parsed.draftId,
        entries: ledgerEntries,
        sealedAt: at,
      }, "replacement ledger");
      putSealedBytes(clocked.workspaceDir, ledger.bytes);

      const resolutions = accepted.map((entry) => {
        // Exhaustive switch, never-typed default (spec §6.8a Group B; packet P6 item C).
        // `resolutionInput` carries the real discriminated-union type (H-3), not `let x;`
        // left untyped: a branch producing the wrong shape is a compile error here, not only a
        // runtime parse failure a callsite away.
        let resolutionInput: BinaryJudgmentLabelResolution;
        switch (parsed.truthAdmission) {
          case "operator-only": {
            const assertion = sealHumanReviewDocument(HumanReviewOperatorAssertionSchema, {
              protocol: HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL,
              itemSha256: entry.candidate.itemSha256,
              truthLabel: entry.truth,
              assertedBy: clocked.principal,
              assertedAt: at,
              attestorKeyId: authoritySigner.keyId,
              attestorRole: "operator-truth-attestor",
              limitation: "operator-only-not-publication-grade",
            }, "operator truth assertion");
            const operatorAssertionSha256 = sealRoleEvidence(
              clocked.workspaceDir,
              assertion,
              HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE,
              authoritySigner,
            );
            resolutionInput = {
              protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
              itemSha256: entry.candidate.itemSha256,
              itemId: entry.candidate.itemId,
              humanReviewEvaluationSpecSha256: entry.candidate.humanReviewEvaluationSpecSha256,
              truthLabel: entry.truth,
              candidateClass: entry.candidate.candidateClass,
              stratum: entry.candidate.stratum,
              truthAdmission: "operator-only",
              operatorAssertionSha256,
              resolvedAt: at,
            };
            break;
          }
          case "screened-operator-sampled": {
            // Bank-scoped (spec §6.3, §6.9): the SAME table and reveal receipt digest for every
            // accepted item in this admission, sealed once above — never per-item. This is an
            // internal-invariant guard, not a validation error: `parsed.truthAdmission ===
            // "screened-operator-sampled"` here already implies both digests were sealed above;
            // it should be unreachable, not load-bearing.
            if (screeningTableSha256 === undefined || screeningRevealReceiptSha256 === undefined) {
              refuse("execution", "screening", "internal: screened admission reached resolution construction without a sealed screening table");
            }
            resolutionInput = {
              protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
              itemSha256: entry.candidate.itemSha256,
              itemId: entry.candidate.itemId,
              truthLabel: entry.truth,
              candidateClass: entry.candidate.candidateClass,
              stratum: entry.candidate.stratum,
              truthAdmission: "screened-operator-sampled",
              screeningTableSha256,
              screeningRevealReceiptSha256,
              resolvedAt: at,
            };
            break;
          }
          case "two-human-unanimous": {
            // H-4: this cast stays inside the two-human arm only. The screened arm above needs
            // no cast of `entry` at all — `candidate` and `truth` are present on every member of
            // `entry`'s union unconditionally, and the bank-scoped digests come from the
            // enclosing closure, not from `entry`.
            const reviewed = entry as typeof entry & {
              reviewVerdictSha256s: readonly [`sha256:${string}`, `sha256:${string}`];
              visibilityReceiptSha256s: readonly [`sha256:${string}`, `sha256:${string}`];
              reviewerRosterSha256: `sha256:${string}`;
              revealReceiptSha256: `sha256:${string}`;
            };
            resolutionInput = {
              protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
              itemSha256: reviewed.candidate.itemSha256,
              itemId: reviewed.candidate.itemId,
              humanReviewEvaluationSpecSha256: reviewed.candidate.humanReviewEvaluationSpecSha256,
              truthLabel: reviewed.truth,
              candidateClass: reviewed.candidate.candidateClass,
              stratum: reviewed.candidate.stratum,
              truthAdmission: "two-human-unanimous",
              reviewVerdictSha256s: reviewed.reviewVerdictSha256s,
              reviewerRosterSha256: reviewed.reviewerRosterSha256,
              visibilityReceiptSha256s: reviewed.visibilityReceiptSha256s,
              revealReceiptSha256: reviewed.revealReceiptSha256,
              resolvedAt: at,
            };
            break;
          }
          default: {
            const exhaustive: never = parsed.truthAdmission;
            refuse("execution", "truthAdmission", `unsupported truthAdmission ${String(exhaustive)}`);
          }
        }
        const resolution = sealBinaryJudgmentLabelResolution(resolutionInput);
        putSealedBytes(clocked.workspaceDir, resolution.bytes);
        const analysis = sealBinaryJudgmentAnalysisContext({
          protocol: BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
          itemSha256: prefixed(entry.candidate.itemSha256),
          itemId: entry.candidate.itemId,
          labelResolutionSha256: resolution.digest,
          truthLabel: entry.truth,
          candidateClass: entry.candidate.candidateClass,
          stratum: entry.candidate.stratum,
        });
        putSealedBytes(clocked.workspaceDir, analysis.bytes);
        return {
          itemSha256: entry.candidate.itemSha256,
          labelResolutionSha256: resolution.digest,
          analysisContextSha256: analysis.digest,
        };
      });
      const manifest = sealHumanReviewDocument(BinaryJudgmentAdmissionManifestSchema, {
        protocol: BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
        draftId: parsed.draftId,
        truthAdmission: parsed.truthAdmission,
        labelResolutionSha256s: resolutions.map((entry) => entry.labelResolutionSha256).sort(compareCodeUnitStrings),
        analysisContextSha256s: resolutions.map((entry) => entry.analysisContextSha256).sort(compareCodeUnitStrings),
        excludedItemSha256s: excluded.map((entry) => entry.candidate.itemSha256).sort(compareCodeUnitStrings),
        replacementLedgerSha256: ledger.digest,
        // Present if and only if truthAdmission === "screened-operator-sampled" (spec §6.8);
        // absent for both existing modes, exactly as it is today.
        ...(screeningTableSha256 === undefined ? {} : { screeningTableSha256 }),
        admittedAt: at,
      }, "admission manifest");
      putSealedBytes(clocked.workspaceDir, manifest.bytes);
      try {
        verifyBinaryJudgmentAdmissionClosure({
          admissionManifestSha256: manifest.digest,
          expectedDraftId: parsed.draftId,
        }, verificationPorts);
      } catch (cause) {
        refuse(
          "execution",
          "admissionManifest",
          `internally produced admission closure failed replay: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      return {
        admissionManifestSha256: manifest.digest,
        replacementLedgerSha256: ledger.digest,
        resolutions,
        exclusions: ledgerEntries.map((entry) => ({
          itemSha256: entry.excludedItemSha256,
          reason: entry.reason,
          replacementItemSha256: entry.replacementItemSha256,
        })),
        // Derived by exclusion, not by equality (spec §6.8a Group A; packet P6 item D): a
        // screened admission is publication-grade too (spec §6.8), and `=== "two-human-
        // unanimous"` would derive `false` for it. `operator-only` is the one mode that is never
        // publication-grade. Matches the verify package's own fix to the same derivation
        // (`verifyBinaryJudgmentAdmissionClosure`'s `publicationGrade`, S3a).
        publicationGrade: parsed.truthAdmission !== "operator-only",
      };
    },
  });
}
