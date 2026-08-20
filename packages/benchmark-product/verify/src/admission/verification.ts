// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import {
  VERDICT_DSSE_PAYLOAD_TYPE,
  canonicalJsonBytes,
  compareCodeUnitStrings,
  parseBinaryJudgmentAnalysisContext,
  parseBinaryJudgmentLabelResolution,
  parseBinaryJudgmentPayload,
  recordDigest,
} from "@jinn-network/task-execution-profiles";
import { parseExactDsseEnvelope } from "@jinn-network/trust-core";
import {
  BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED,
  HUMAN_REVIEW_FORM_SEALED,
} from "./application.js";
import {
  BinaryJudgmentAdmissionManifestSchema,
  HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE,
  HUMAN_REVIEW_PACKET_MEDIA_TYPE,
  HUMAN_REVIEW_RESPONSE_MEDIA_TYPE,
  HUMAN_REVIEW_REVEAL_RECEIPT_MEDIA_TYPE,
  HUMAN_REVIEW_ROSTER_MEDIA_TYPE,
  HUMAN_REVIEW_VISIBILITY_RECEIPT_MEDIA_TYPE,
  SCREENING_REVEAL_RECEIPT_MEDIA_TYPE,
  SCREENING_TABLE_MEDIA_TYPE,
  HumanReviewOperatorAssertionSchema,
  HumanReviewPacketSchema,
  HumanReviewReplacementLedgerSchema,
  HumanReviewResponseSchema,
  HumanReviewRevealReceiptSchema,
  HumanReviewRosterSchema,
  HumanReviewVisibilityReceiptSchema,
  ScreeningRevealReceiptSchema,
  ScreeningTableSchema,
  type BinaryJudgmentAdmissionManifest,
  type HumanReviewReplacementLedger,
  type ScreeningRow,
  type ScreeningTable,
} from "./contracts.js";
import { readOrderedAdmissionVerdictMeasurements, readAdmissionVerdictEnvelope } from "./result-evaluation.js";
import { computeScreeningSample, ScreeningSampleError } from "./screening-sample.js";

/**
 * Two unrelated things in this file are spelled `evidence`, and neither can be renamed.
 *
 * This one is the solver-visible per-item evidence passage: the field name is the literal payload
 * key that `parseBinaryJudgmentPayload` produces, so this view must spell it `evidence` or it
 * stops describing the bytes it is cast over. The other is the DSSE predicate's `evidence` array
 * of attached admission records (`predicateView.evidence`, `view.evidence`), which is an in-toto
 * envelope field name. They never meet: this one only ever reaches a `BinaryJudgmentPayloadView`
 * bound as `item`, and the DSSE ones only ever reach the verdict-envelope views.
 */
interface BinaryJudgmentPayloadView {
  readonly itemId: string;
  readonly question: string;
  readonly referenceAnswer: string;
  readonly candidateAnswer: string;
  readonly evidence?: string;
  readonly provenance: {
    readonly sourceCommitment: string;
    readonly timestamp: string;
  };
  readonly sources: readonly { readonly digest: { readonly sha256: string } }[];
}

// Checked against §6.7 (packet P6 item H-0): unlike the label-resolution mirror below, this view
// needs NO third arm. BinaryJudgmentAnalysisContextSchema carries no truthAdmission-conditional
// field for any of the three admission modes -- it stays a flat, mode-independent shape.
interface BinaryJudgmentAnalysisContextView {
  readonly itemSha256: AdmissionSha256;
  readonly itemId: string;
  readonly labelResolutionSha256: AdmissionSha256;
  readonly truthLabel: "CORRECT" | "WRONG";
  readonly candidateClass: string;
  readonly stratum: string;
}

// Widened to a third arm (spec §6.7; packet P6 item H-0, handed off by S1). Mirrors
// `profiles/src/binary-judgment/label-resolution.ts`'s own CommonShape reduction:
// `humanReviewEvaluationSpecSha256` moved OUT of the common part and into the two branches that
// still carry it, because a screened row (never hand-checked) has no human-review evaluation.
type BinaryJudgmentLabelResolutionView = {
  readonly itemSha256: AdmissionSha256;
  readonly itemId: string;
  readonly truthLabel: "CORRECT" | "WRONG";
  readonly candidateClass: string;
  readonly stratum: string;
  readonly resolvedAt: string;
} & ({
  readonly truthAdmission: "two-human-unanimous";
  readonly humanReviewEvaluationSpecSha256: AdmissionSha256;
  readonly reviewVerdictSha256s: readonly [AdmissionSha256, AdmissionSha256];
  readonly visibilityReceiptSha256s: readonly [AdmissionSha256, AdmissionSha256];
  readonly reviewerRosterSha256: AdmissionSha256;
  readonly revealReceiptSha256: AdmissionSha256;
} | {
  readonly truthAdmission: "operator-only";
  readonly humanReviewEvaluationSpecSha256: AdmissionSha256;
  readonly operatorAssertionSha256: AdmissionSha256;
} | {
  readonly truthAdmission: "screened-operator-sampled";
  readonly screeningTableSha256: AdmissionSha256;
  readonly screeningRevealReceiptSha256: AdmissionSha256;
});

export type AdmissionSha256 = `sha256:${string}`;
// Verbatim duplicate of `schema.ts`'s `BUNDLE_V4_ADMISSION_EVIDENCE_ROLES`, hand-kept in sync
// (spec §6.8a Group C).
export const BINARY_JUDGMENT_ADMISSION_RECORD_ROLES = [
  "admission-manifest", "replacement-ledger", "source-item", "label-resolution",
  "analysis-context", "human-review-evaluation-spec", "human-review-form",
  "human-review-packet", "human-review-response", "human-review-verdict",
  "reviewer-roster", "review-visibility-receipt", "review-reveal-receipt",
  "operator-assertion",
  // Appended after operator-assertion (spec §6.8a Group C, first bullet; packet P6).
  "screening-table",
  "screening-reveal-receipt",
] as const;
export type BinaryJudgmentAdmissionRecordRole = (typeof BINARY_JUDGMENT_ADMISSION_RECORD_ROLES)[number];
export type AdmissionAuthorityRole =
  | "roster-attestor"
  | "truth-reveal-attestor"
  | "operator-truth-attestor";

export interface BinaryJudgmentAdmissionClosurePorts {
  /** Resolve immutable bytes by their prefixed digest. The verifier re-hashes every result. */
  resolveExactRecord(digest: AdmissionSha256): Uint8Array;
  /** Verify the one reviewer signature against the evaluator/key binding trusted by the caller. */
  verifyReviewerSignature(input: {
    readonly envelopeBytes: Uint8Array;
    readonly evaluatorId: string;
    readonly keyId: string;
  }): boolean;
  /** Verify the one product-authority signature under its payload-declared, separated role. */
  verifyAuthoritySignature(input: {
    readonly envelopeBytes: Uint8Array;
    readonly keyId: string;
    readonly role: AdmissionAuthorityRole;
  }): boolean;
}

export interface VerifyBinaryJudgmentAdmissionClosureInput {
  readonly admissionManifestSha256: AdmissionSha256;
  readonly expectedDraftId: string;
}

export interface VerifiedBinaryJudgmentAdmissionItem {
  readonly itemSha256: AdmissionSha256;
  readonly itemId: string;
  readonly truthLabel: "CORRECT" | "WRONG";
  readonly candidateClass: string;
  readonly stratum: string;
  readonly truthAdmission: "two-human-unanimous" | "operator-only" | "screened-operator-sampled";
  readonly labelResolutionSha256: AdmissionSha256;
  readonly analysisContextSha256: AdmissionSha256;
}

export interface VerifiedBinaryJudgmentAdmissionExclusion {
  readonly itemSha256: AdmissionSha256;
  readonly itemId: string;
  readonly candidateClass: string;
  readonly stratum: string;
  readonly reason:
    | "review-disagreement" | "review-indeterminate" | "review-incomplete"
    | "screening-disagreement" | "screening-indeterminate" | "screening-hand-excluded";
  readonly replacementItemSha256: AdmissionSha256;
}

export interface VerifiedBinaryJudgmentAdmissionClosure {
  readonly manifestSha256: AdmissionSha256;
  readonly manifest: BinaryJudgmentAdmissionManifest;
  readonly replacementLedger: HumanReviewReplacementLedger;
  readonly publicationGrade: boolean;
  readonly classes: readonly string[];
  readonly strata: readonly string[];
  readonly accepted: readonly VerifiedBinaryJudgmentAdmissionItem[];
  readonly excluded: readonly VerifiedBinaryJudgmentAdmissionExclusion[];
  /** Complete, sorted digest inventory reachable from the manifest closure. */
  readonly reachableSha256s: readonly AdmissionSha256[];
  /** Same closure with semantic roles assigned by the exact traversal that authenticated it. */
  readonly reachableRecords: readonly {
    readonly sha256: AdmissionSha256;
    readonly roles: readonly BinaryJudgmentAdmissionRecordRole[];
  }[];
  /** Present iff `manifest.truthAdmission === "screened-operator-sampled"` (spec §6.5 check (3)). */
  readonly screening?: {
    readonly sampleAgreementRate: number;
  };
}

export class BinaryJudgmentAdmissionClosureError extends Error {
  readonly path: string;

  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(`${path}: ${detail}`, options);
    this.name = "BinaryJudgmentAdmissionClosureError";
    this.path = path;
  }
}

function fail(path: string, detail: string, cause?: unknown): never {
  throw new BinaryJudgmentAdmissionClosureError(path, detail, cause === undefined ? undefined : { cause });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function exactCanonical<T>(schema: z.ZodType<T>, bytes: Uint8Array, path: string): T {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    fail(path, "record is not UTF-8 JSON", cause);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) fail(path, parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "));
  if (!bytesEqual(bytes, canonicalJsonBytes(parsed.data))) fail(path, "record is not in exact canonical JSON encoding");
  return parsed.data;
}

function prefixed(value: string): AdmissionSha256 {
  return (value.startsWith("sha256:") ? value : `sha256:${value}`) as AdmissionSha256;
}

function bare(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface VerificationState {
  readonly ports: BinaryJudgmentAdmissionClosurePorts;
  readonly reachable: Set<AdmissionSha256>;
  readonly roles: Map<AdmissionSha256, Set<BinaryJudgmentAdmissionRecordRole>>;
}

function resolve(
  state: VerificationState,
  digest: string,
  path: string,
  role: BinaryJudgmentAdmissionRecordRole,
): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) fail(path, "record digest is not canonical sha256");
  const exactDigest = digest as AdmissionSha256;
  let bytes: Uint8Array;
  try {
    bytes = state.ports.resolveExactRecord(exactDigest);
  } catch (cause) {
    fail(path, `cannot resolve ${digest}`, cause);
  }
  if (recordDigest(bytes) !== digest) fail(path, `resolved bytes do not hash to ${digest}`);
  state.reachable.add(exactDigest);
  const roles = state.roles.get(exactDigest) ?? new Set<BinaryJudgmentAdmissionRecordRole>();
  roles.add(role);
  state.roles.set(exactDigest, roles);
  return bytes;
}

function parseProfileRecord<T>(
  state: VerificationState,
  digest: string,
  path: string,
  parse: (bytes: Uint8Array) => T,
  role: BinaryJudgmentAdmissionRecordRole,
): { readonly value: T; readonly bytes: Uint8Array } {
  const bytes = resolve(state, digest, path, role);
  let value: T;
  try {
    value = parse(bytes);
  } catch (cause) {
    fail(path, "record does not satisfy its registered schema", cause);
  }
  if (!bytesEqual(bytes, canonicalJsonBytes(value))) fail(path, "record is not in exact canonical JSON encoding");
  return { value, bytes };
}

function verifyFrozenHumanReviewSpec(state: VerificationState, path: string): void {
  const specBytes = resolve(
    state,
    BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
    `${path}.evaluationSpecification`,
    "human-review-evaluation-spec",
  );
  if (!bytesEqual(specBytes, BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.bytes)) {
    fail(path, "frozen human-review EvaluationSpec bytes do not match the registered contract");
  }
  const formBytes = resolve(state, HUMAN_REVIEW_FORM_SEALED.digest, `${path}.reviewForm`, "human-review-form");
  if (!bytesEqual(formBytes, HUMAN_REVIEW_FORM_SEALED.bytes)) {
    fail(path, "frozen human-review form bytes do not match the registered contract");
  }
}

export interface VerifiedBinaryJudgmentReviewerResult {
  readonly evaluatorId: string;
  readonly keyId: string;
  readonly label: "CORRECT" | "WRONG" | "indeterminate";
  readonly complete: boolean;
  readonly completedAt: string;
  readonly itemId: string;
  readonly packetSha256: AdmissionSha256;
  readonly visibilityReceiptSha256: AdmissionSha256;
}

function verifyReview(
  state: VerificationState,
  verdictSha256: string,
  expectedItemSha256: string,
  path: string,
): VerifiedBinaryJudgmentReviewerResult {
  const envelopeBytes = resolve(state, verdictSha256, path, "human-review-verdict");
  let envelope: ReturnType<typeof parseExactDsseEnvelope>;
  try {
    envelope = parseExactDsseEnvelope(envelopeBytes);
  } catch (cause) {
    fail(path, "review verdict is not an exact compact DSSE envelope", cause);
  }
  if (envelope.payloadType !== VERDICT_DSSE_PAYLOAD_TYPE || envelope.signatures.length !== 1) {
    fail(path, "review verdict must be one Result Evaluation envelope with one signature");
  }
  let statement: Record<string, unknown>;
  try {
    statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes)) as Record<string, unknown>;
  } catch (cause) {
    fail(path, "Result Evaluation payload is not UTF-8 JSON", cause);
  }
  if (!bytesEqual(canonicalJsonBytes(statement), envelope.payloadBytes)) fail(path, "Result Evaluation payload is not exact canonical JSON");
  let view: ReturnType<typeof readAdmissionVerdictEnvelope>;
  let ordered: ReturnType<typeof readOrderedAdmissionVerdictMeasurements>;
  try {
    view = readAdmissionVerdictEnvelope(envelopeBytes);
    ordered = readOrderedAdmissionVerdictMeasurements(envelopeBytes);
  } catch (cause) {
    fail(path, "Result Evaluation payload is outside the closed verdict grammar", cause);
  }
  const signature = envelope.signatures[0]!;
  const signatureKeyId = signature.keyid;
  if (typeof signatureKeyId !== "string" || !state.ports.verifyReviewerSignature({ envelopeBytes, evaluatorId: view.evaluatorId, keyId: signatureKeyId })) {
    fail(path, "reviewer signature or evaluator/key binding is invalid");
  }
  if (view.evaluationSpecificationSha256 !== bare(BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest)) {
    fail(path, "review names a different human-review EvaluationSpec");
  }
  verifyFrozenHumanReviewSpec(state, path);
  const expectedNames = ["truthLabel", "reviewComplete", "reviewPacketSha256", "visibilityReceiptSha256", "responseSha256"];
  if (ordered.length !== expectedNames.length || ordered.some((entry, index) => entry.name !== expectedNames[index])) {
    fail(path, "review measurements do not match the frozen human-review EvaluationSpec");
  }
  const [labelRaw, completeRaw, packetRaw, visibilityRaw, responseRaw] = ordered.map((entry) => entry.value);
  const labelResult = z.enum(["CORRECT", "WRONG", "indeterminate"]).safeParse(labelRaw);
  if (!labelResult.success || typeof completeRaw !== "boolean" || typeof packetRaw !== "string" || typeof visibilityRaw !== "string" || typeof responseRaw !== "string") {
    fail(path, "review measurement values are invalid");
  }
  const packetSha256 = prefixed(packetRaw);
  const visibilityReceiptSha256 = prefixed(visibilityRaw);
  const responseSha256 = prefixed(responseRaw);
  const packet = exactCanonical(HumanReviewPacketSchema, resolve(state, packetSha256, `${path}.packet`, "human-review-packet"), `${path}.packet`);
  const visibility = exactCanonical(HumanReviewVisibilityReceiptSchema, resolve(state, visibilityReceiptSha256, `${path}.visibility`, "review-visibility-receipt"), `${path}.visibility`);
  const response = exactCanonical(HumanReviewResponseSchema, resolve(state, responseSha256, `${path}.response`, "human-review-response"), `${path}.response`);
  const itemBytes = resolve(state, expectedItemSha256, `${path}.item`, "source-item");
  const item = parseProfileRecord<BinaryJudgmentPayloadView>(state, expectedItemSha256, `${path}.item`, (bytes) => parseBinaryJudgmentPayload(bytes) as BinaryJudgmentPayloadView, "source-item").value;
  if (!bytesEqual(itemBytes, canonicalJsonBytes(packet.item)) || packet.item.itemId !== item.itemId) {
    fail(path, "packet embedded item does not equal the exact referenced item record");
  }

  const subjects = statement.subject;
  const predicate = statement.predicate;
  if (!Array.isArray(subjects) || subjects.length !== 2 || typeof predicate !== "object" || predicate === null || Array.isArray(predicate)) {
    fail(path, "Result Evaluation subjects or predicate are malformed");
  }
  const subjectView = subjects as Array<{ name?: unknown; digest?: { sha256?: unknown }; mediaType?: unknown }>;
  const predicateView = predicate as {
    taskSubject?: unknown;
    resultSubjects?: unknown;
    evaluator?: { id?: unknown; "network.jinn.reviewer.keyid"?: unknown };
    verdict?: unknown;
    evaluatedAt?: unknown;
    evidence?: unknown;
    limitations?: unknown;
  };
  const expectedVerdict = !completeRaw || labelResult.data === "indeterminate"
    ? "inconclusive"
    : labelResult.data === "CORRECT" ? "pass" : "fail";
  const expectedEvidence = [
    ["human-review-packet", bare(packetSha256), HUMAN_REVIEW_PACKET_MEDIA_TYPE],
    ["visibility-receipt", bare(visibilityReceiptSha256), HUMAN_REVIEW_VISIBILITY_RECEIPT_MEDIA_TYPE],
    ["human-review-response", bare(responseSha256), HUMAN_REVIEW_RESPONSE_MEDIA_TYPE],
  ] as const;
  const evidenceMatches = Array.isArray(predicateView.evidence)
    && predicateView.evidence.length === expectedEvidence.length
    && predicateView.evidence.every((raw, index) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
      const entry = raw as { name?: unknown; digest?: { sha256?: unknown }; mediaType?: unknown };
      const expected = expectedEvidence[index]!;
      return entry.name === expected[0]
        && entry.digest?.sha256 === expected[1]
        && entry.mediaType === expected[2]
        && Object.keys(entry).every((key) => ["name", "digest", "mediaType"].includes(key));
    });
  if (
    packet.itemSha256 !== expectedItemSha256
    || recordDigest(canonicalJsonBytes(packet.item)) !== expectedItemSha256
    || packet.evaluationSpecSha256 !== BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest
    || packet.reviewerId !== view.evaluatorId
    || visibility.packetSha256 !== packetSha256
    || visibility.itemSha256 !== expectedItemSha256
    || visibility.reviewerId !== view.evaluatorId
    || response.packetSha256 !== packetSha256
    || response.visibilityReceiptSha256 !== visibilityReceiptSha256
    || response.itemSha256 !== expectedItemSha256
    || response.evaluatorId !== view.evaluatorId
    || response.label !== labelResult.data
    || response.complete !== completeRaw
    || response.completedAt !== view.evaluatedAt
    || Date.parse(response.completedAt) < Date.parse(visibility.issuedAt)
    || subjectView[0]?.name !== "binary-judgment-item"
    || subjectView[0]?.digest?.sha256 !== bare(expectedItemSha256)
    || Object.keys(subjectView[0] ?? {}).some((key) => !["name", "digest"].includes(key))
    || subjectView[1]?.name !== "human-review-response"
    || subjectView[1]?.digest?.sha256 !== bare(responseSha256)
    || subjectView[1]?.mediaType !== HUMAN_REVIEW_RESPONSE_MEDIA_TYPE
    || Object.keys(subjectView[1] ?? {}).some((key) => !["name", "digest", "mediaType"].includes(key))
    || predicateView.taskSubject !== "binary-judgment-item"
    || !Array.isArray(predicateView.resultSubjects)
    || predicateView.resultSubjects.length !== 1
    || predicateView.resultSubjects[0] !== "human-review-response"
    || predicateView.evaluator?.id !== view.evaluatorId
    || predicateView.evaluator?.["network.jinn.reviewer.keyid"] !== signatureKeyId
    || predicateView.verdict !== expectedVerdict
    || predicateView.evaluatedAt !== response.completedAt
    || !evidenceMatches
    || !Array.isArray(predicateView.limitations)
    || !sameStrings(predicateView.limitations as string[], ["reviewer-person-distinctness-is-roster-attested"])
    || view.evidence?.length !== 3
  ) fail(path, "Result Evaluation packet/response/visibility/item/evaluator joins do not close");
  return {
    evaluatorId: view.evaluatorId,
    keyId: signatureKeyId,
    label: labelResult.data,
    complete: completeRaw,
    completedAt: response.completedAt,
    itemId: item.itemId,
    packetSha256,
    visibilityReceiptSha256,
  };
}

interface AuthorityPayloadOptions<T> {
  readonly digest: string;
  readonly mediaType: string;
  readonly role: AdmissionAuthorityRole;
  /**
   * The evidence role to resolve under -- supplied by the CALLER rather than reconstructed from
   * `role` (spec §6.8a Group B-bis; packet P6). `truth-reveal-attestor` signs two different
   * records depending on admission mode (the two-human per-item reveal receipt, evidence role
   * `review-reveal-receipt`; the screened bank-scoped reveal receipt, evidence role
   * `screening-reveal-receipt`), and `AdmissionAuthorityRole` itself deliberately stays a
   * three-member union (§6.6 reuses the role rather than minting one) -- so an exhaustive switch
   * over `role` alone cannot distinguish the two. Reconstructing the evidence role from `role`
   * would resolve a screened reveal receipt under `review-reveal-receipt`, which is exactly the
   * role the third evidence-set `superRefine` branch (Group C) refuses.
   */
  readonly evidenceRole: BinaryJudgmentAdmissionRecordRole;
  readonly schema: z.ZodType<T>;
  readonly path: string;
}

function authorityPayload<T>(
  state: VerificationState,
  options: AuthorityPayloadOptions<T>,
): { readonly value: T; readonly keyId: string } {
  const { digest, mediaType, role, evidenceRole, schema, path } = options;
  const envelopeBytes = resolve(state, digest, path, evidenceRole);
  let envelope: ReturnType<typeof parseExactDsseEnvelope>;
  try {
    envelope = parseExactDsseEnvelope(envelopeBytes);
  } catch (cause) {
    fail(path, "authority evidence is not an exact compact DSSE envelope", cause);
  }
  if (envelope.payloadType !== mediaType || envelope.signatures.length !== 1) fail(path, "authority evidence has the wrong payload type or signature count");
  const signature = envelope.signatures[0]!;
  const signatureKeyId = signature.keyid;
  if (typeof signatureKeyId !== "string" || !state.ports.verifyAuthoritySignature({ envelopeBytes, keyId: signatureKeyId, role })) {
    fail(path, `authority signature is invalid for role ${role}`);
  }
  return { value: exactCanonical(schema, envelope.payloadBytes, `${path}.payload`), keyId: signatureKeyId };
}

interface HumanEvidenceRefs {
  readonly reviewVerdictSha256s: readonly [string, string];
  readonly visibilityReceiptSha256s: readonly [string, string];
  readonly reviewerRosterSha256: string;
  readonly revealReceiptSha256: string;
}

function verifyHumanEvidence(
  state: VerificationState,
  refs: HumanEvidenceRefs,
  expectedItemSha256: string,
  expectedDraftId: string,
  admittedAt: string,
  path: string,
): { readonly reviews: readonly [VerifiedBinaryJudgmentReviewerResult, VerifiedBinaryJudgmentReviewerResult]; readonly itemId: string } {
  const reviews = refs.reviewVerdictSha256s.map((digest, index) => verifyReview(state, digest, expectedItemSha256, `${path}.reviews.${index}`)) as unknown as [VerifiedBinaryJudgmentReviewerResult, VerifiedBinaryJudgmentReviewerResult];
  if (reviews[0].evaluatorId === reviews[1].evaluatorId || reviews[0].keyId === reviews[1].keyId) {
    fail(path, "reviewers must have distinct evaluator identities and keys");
  }
  if (reviews[0].itemId !== reviews[1].itemId) fail(path, "review packets disagree on itemId");
  const visibilityDigests = reviews.map((review) => review.visibilityReceiptSha256).sort(compareCodeUnitStrings);
  if (!sameStrings(visibilityDigests, refs.visibilityReceiptSha256s)) fail(path, "declared visibility receipt coverage differs from signed reviews");
  const rosterEvidence = authorityPayload(state, {
    digest: refs.reviewerRosterSha256,
    mediaType: HUMAN_REVIEW_ROSTER_MEDIA_TYPE,
    role: "roster-attestor",
    evidenceRole: "reviewer-roster",
    schema: HumanReviewRosterSchema,
    path: `${path}.roster`,
  });
  const roster = rosterEvidence.value;
  if (roster.attestorRole !== "roster-attestor" || roster.attestorKeyId !== rosterEvidence.keyId || roster.itemSha256 !== expectedItemSha256) {
    fail(path, "roster authority role/key/item binding is invalid");
  }
  const declarations = [...roster.reviewers];
  if (compareCodeUnitStrings(declarations[0].evaluatorId, declarations[1].evaluatorId) >= 0) fail(path, "roster reviewers are not sorted and unique");
  const reviewByEvaluator = new Map(reviews.map((review) => [review.evaluatorId, review]));
  if (declarations.some((declaration) => reviewByEvaluator.get(declaration.evaluatorId)?.keyId !== declaration.keyId)) {
    fail(path, "roster does not bind the exact reviewer evaluator/key pairs");
  }
  if (declarations[0].personId === declarations[1].personId || declarations.some((declaration) => declaration.conflicts.length > 0)) {
    fail(path, "roster does not attest distinct conflict-free people");
  }
  const revealEvidence = authorityPayload(state, {
    digest: refs.revealReceiptSha256,
    mediaType: HUMAN_REVIEW_REVEAL_RECEIPT_MEDIA_TYPE,
    role: "truth-reveal-attestor",
    evidenceRole: "review-reveal-receipt",
    schema: HumanReviewRevealReceiptSchema,
    path: `${path}.reveal`,
  });
  const reveal = revealEvidence.value;
  if (
    reveal.attestorRole !== "truth-reveal-attestor"
    || reveal.attestorKeyId !== revealEvidence.keyId
    || revealEvidence.keyId !== rosterEvidence.keyId
    || reveal.draftId !== expectedDraftId
    || reveal.itemSha256 !== expectedItemSha256
    || reveal.judgeExecutionState !== "not-started"
    || reveal.truthFrozenAt !== admittedAt
    || reviews.some((review) => Date.parse(review.completedAt) > Date.parse(reveal.truthFrozenAt))
  ) fail(path, "signed reveal does not follow both completed reviews under the same authority");
  return { reviews, itemId: reviews[0].itemId };
}

function expectedExclusionReason(reviews: readonly [VerifiedBinaryJudgmentReviewerResult, VerifiedBinaryJudgmentReviewerResult]): "review-disagreement" | "review-indeterminate" | "review-incomplete" | undefined {
  if (reviews.some((review) => !review.complete)) return "review-incomplete";
  if (reviews.some((review) => review.label === "indeterminate")) return "review-indeterminate";
  if (reviews[0].label !== reviews[1].label) return "review-disagreement";
  return undefined;
}

/**
 * The screened branch's sibling of `expectedExclusionReason` above, derived from §6.4's admission
 * rule instead of two signed reviews (spec §6.4, §6.5 check (4)). The seventh copy of the
 * replacement-ledger reason vocabulary this file carries (contracts.ts's own comment names the
 * other six and defers this one to S3, "recomputation logic").
 *
 * A row this file already knows is admitted returns `undefined` (no exclusion). Among excluded
 * rows: a FLAGGED row (`screeningVerdict !== intendedLabel`) is always hand-checked in a passing
 * closure (check (2) requires it), so its reason names the screen's own finding regardless of
 * that hand check having run -- `screening-indeterminate` when the screen itself was
 * indeterminate, `screening-disagreement` for a definite-label disagreement. `screening-hand-
 * excluded` is reserved for the one case a flagged-first read would miss: R-3's tie-break, a row
 * the screen AGREED with that the hand check overrode to exclude.
 */
function expectedScreeningExclusionReason(row: ScreeningRow): "screening-disagreement" | "screening-indeterminate" | "screening-hand-excluded" | undefined {
  const agreed = row.screeningVerdict === row.intendedLabel;
  const admitted = row.handChecked ? row.handVerdict === "confirm" : agreed;
  if (admitted) return undefined;
  if (!agreed) return row.screeningVerdict === "indeterminate" ? "screening-indeterminate" : "screening-disagreement";
  return "screening-hand-excluded";
}

/** The reviewer Result Evaluation verifier shared by admission construction and closure replay. */
export function verifyBinaryJudgmentReviewerResult(
  input: { readonly verdictSha256: AdmissionSha256; readonly expectedItemSha256: AdmissionSha256 },
  ports: BinaryJudgmentAdmissionClosurePorts,
): VerifiedBinaryJudgmentReviewerResult {
  return verifyReview(
    { ports, reachable: new Set<AdmissionSha256>(), roles: new Map() },
    input.verdictSha256,
    input.expectedItemSha256,
    "reviewVerdictSha256",
  );
}

/**
 * Portable, fail-closed replay of the entire binary-judgment admission graph. The caller supplies
 * immutable record resolution and role-separated trust; no candidate truth is caller-authored.
 */
export function verifyBinaryJudgmentAdmissionClosure(
  input: VerifyBinaryJudgmentAdmissionClosureInput,
  ports: BinaryJudgmentAdmissionClosurePorts,
): VerifiedBinaryJudgmentAdmissionClosure {
  const state: VerificationState = { ports, reachable: new Set<AdmissionSha256>(), roles: new Map() };
  const manifest = exactCanonical(
    BinaryJudgmentAdmissionManifestSchema,
    resolve(state, input.admissionManifestSha256, "admissionManifestSha256", "admission-manifest"),
    "admissionManifest",
  );
  if (manifest.draftId !== input.expectedDraftId) fail("admissionManifest.draftId", "manifest belongs to a different draft");
  const ledger = exactCanonical(
    HumanReviewReplacementLedgerSchema,
    resolve(state, manifest.replacementLedgerSha256, "admissionManifest.replacementLedgerSha256", "replacement-ledger"),
    "replacementLedger",
  );
  if (ledger.draftId !== input.expectedDraftId || ledger.sealedAt !== manifest.admittedAt) fail("replacementLedger", "ledger draft/time does not bind the manifest");

  // Screened-operator-sampled admission (spec §6.4, §6.5; packet P6 item A): the table and S2's
  // `screening-sample/1` recomputation are resolved and checked ONCE per bank, ahead of the
  // resolutions and ledger loops below, which read `screeningRowsByItem` per item. Checks (1)-(3)
  // run here, over `rows` alone; check (0)'s coverage half runs after both loops, once
  // `acceptedItems`/`excludedItems` (the closure's own reconstruction of the frozen bank's
  // candidate pool -- see the coverage check below) are fully known; check (4) runs per item in
  // both loops.
  let screeningTable: ScreeningTable | undefined;
  let screeningRowsByItem = new Map<string, ScreeningRow>();
  let screeningSample = new Set<string>();
  let screeningSampleAgreementRate: number | undefined;
  if (manifest.truthAdmission === "screened-operator-sampled") {
    if (manifest.screeningTableSha256 === undefined) {
      fail("admissionManifest.screeningTableSha256", "screened admission manifest carries no screening table reference");
    }
    // The table is signed ONCE, DSSE-sealed on the same path as the other admission records
    // (spec §6.3, final sentence, verbatim) -- this is what makes §6.9's dropping of 240 per-item
    // signatures sound ("one key signing 240 rows separately proves nothing beyond one signature
    // on the whole table"). The table schema carries no attestorRole field (unlike the roster and
    // reveal receipt), but `sealRoleEvidence` (core/src/operations/human-review.ts:218-233) DSSE-
    // wraps arbitrary bytes under any payload type regardless of the payload's own shape, so
    // `screeningTableSha256` names the DSSE ENVELOPE digest, exactly like `reviewerRosterSha256`
    // and `revealReceiptSha256` already do -- not the bare canonical table bytes. The screened
    // branch's sole legal authority set is `["truth-reveal-attestor"]` alone (§6.8a Group C), so
    // that is the one key that signs both the bank-scoped table and the bank-scoped reveal
    // receipt: "signed once per bank" as D1 describes.
    screeningTable = authorityPayload(state, {
      digest: manifest.screeningTableSha256,
      mediaType: SCREENING_TABLE_MEDIA_TYPE,
      role: "truth-reveal-attestor",
      evidenceRole: "screening-table",
      schema: ScreeningTableSchema,
      path: "admissionManifest.screeningTableSha256",
    }).value;
    screeningRowsByItem = new Map(screeningTable.rows.map((row) => [row.itemSha256, row]));

    // (1) Sample membership: recomputed by screening-sample/1, never by executing the sealed
    // script (R-4). The recomputation is authoritative for checks (2) and (3) below -- there is
    // no separate "compare against the operator's script" step, because the script is never run.
    let sampleResult: ReturnType<typeof computeScreeningSample>;
    try {
      sampleResult = computeScreeningSample({
        itemSha256s: screeningTable.rows.map((row) => row.itemSha256),
        sampleSeed: screeningTable.sampleSeed,
        sampleSize: screeningTable.sampleSize,
      });
    } catch (cause) {
      fail(
        "admissionManifest.screeningTableSha256",
        cause instanceof ScreeningSampleError
          ? `sample recomputation refused its own input: ${cause.message}`
          : "sample recomputation (screening-sample/1) failed",
        cause,
      );
    }
    screeningSample = new Set(sampleResult.sample);

    // (2) Required hand checks: flagged := rows where NOT agreed. Every row in flagged ∪ sample
    // must carry handChecked === true.
    for (const row of screeningTable.rows) {
      const flagged = row.screeningVerdict !== row.intendedLabel;
      if ((flagged || screeningSample.has(row.itemSha256)) && !row.handChecked) {
        fail("screeningTable.rows", `row ${row.itemSha256} is flagged or sampled but was never hand-checked`);
      }
    }

    // (3) Sample agreement rate -- the one definition (spec §6.5(3)), symmetric on purpose. Every
    // row in `screeningSample` is hand-checked by check (2) above, so `handVerdict` is defined.
    const sampleMatches = [...screeningSample].filter((sampledItemSha256) => {
      const row = screeningRowsByItem.get(sampledItemSha256)!;
      return (row.screeningVerdict === row.intendedLabel) === (row.handVerdict === "confirm");
    }).length;
    screeningSampleAgreementRate = sampleMatches / screeningSample.size;
  }

  const resolutions = manifest.labelResolutionSha256s.map((digest, index) => ({
    digest,
    ...parseProfileRecord<BinaryJudgmentLabelResolutionView>(state, digest, `admissionManifest.labelResolutionSha256s.${index}`, (bytes) => parseBinaryJudgmentLabelResolution(bytes) as BinaryJudgmentLabelResolutionView, "label-resolution"),
  }));
  const contexts = manifest.analysisContextSha256s.map((digest, index) => ({
    digest,
    ...parseProfileRecord<BinaryJudgmentAnalysisContextView>(state, digest, `admissionManifest.analysisContextSha256s.${index}`, (bytes) => parseBinaryJudgmentAnalysisContext(bytes) as BinaryJudgmentAnalysisContextView, "analysis-context"),
  }));
  if (resolutions.length !== contexts.length) fail("admissionManifest", "resolution and analysis-context coverage differs");
  const contextByResolution = new Map<string, (typeof contexts)[number]>(
    contexts.map((entry) => [entry.value.labelResolutionSha256, entry]),
  );
  if (contextByResolution.size !== contexts.length) fail("admissionManifest.analysisContextSha256s", "multiple contexts cover one resolution");
  const acceptedItems = new Set<string>();
  const accepted: VerifiedBinaryJudgmentAdmissionItem[] = [];

  for (const [index, entry] of resolutions.entries()) {
    const resolution = entry.value;
    const path = `resolutions.${index}`;
    if (acceptedItems.has(resolution.itemSha256)) fail(path, "item is admitted more than once");
    acceptedItems.add(resolution.itemSha256);
    if (resolution.truthAdmission !== manifest.truthAdmission || resolution.resolvedAt !== manifest.admittedAt) fail(path, "resolution admission kind/time differs from manifest");
    // A screened resolution carries no humanReviewEvaluationSpecSha256 (spec §6.7: a row never
    // hand-checked has no human-review evaluation), so this equality check only applies to the
    // two branches that still carry the field. `verifyFrozenHumanReviewSpec` stays unconditional
    // below regardless: the frozen spec+form are required admission-record roles for every mode
    // (§6.8a's ratified G-5), not only the two that reference the spec by digest.
    if (resolution.truthAdmission !== "screened-operator-sampled") {
      if (resolution.humanReviewEvaluationSpecSha256 !== BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest) {
        fail(path, "resolution names a different human-review EvaluationSpec");
      }
    }
    verifyFrozenHumanReviewSpec(state, path);
    const item = parseProfileRecord<BinaryJudgmentPayloadView>(state, resolution.itemSha256, `${path}.itemSha256`, (bytes) => parseBinaryJudgmentPayload(bytes) as BinaryJudgmentPayloadView, "source-item").value;
    if (item.itemId !== resolution.itemId) fail(path, "resolution itemId differs from exact item record");
    const contextEntry = contextByResolution.get(entry.digest);
    if (contextEntry === undefined) fail(path, "resolution has no analysis context");
    const context: BinaryJudgmentAnalysisContextView = contextEntry.value;
    if (
      context.itemSha256 !== resolution.itemSha256
      || context.itemId !== resolution.itemId
      || context.truthLabel !== resolution.truthLabel
      || context.candidateClass !== resolution.candidateClass
      || context.stratum !== resolution.stratum
    ) fail(path, "analysis context does not exactly project the resolution");

    // Exhaustive switch over the three-member truthAdmission union, never-typed default (spec
    // §6.8a Group B / this packet's G-3): an unrecognized future mode is a compile error here,
    // not a silent reroute into the two-human or operator-only path.
    switch (resolution.truthAdmission) {
      case "two-human-unanimous": {
        const human = verifyHumanEvidence(state, resolution, resolution.itemSha256, input.expectedDraftId, manifest.admittedAt, path);
        if (
          human.itemId !== resolution.itemId
          || human.reviews.some((review) => !review.complete || review.label === "indeterminate" || review.label !== resolution.truthLabel)
        ) fail(path, "admitted human truth is not two complete unanimous reviews");
        break;
      }
      case "operator-only": {
        const assertionEvidence = authorityPayload(state, {
          digest: resolution.operatorAssertionSha256,
          mediaType: HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE,
          role: "operator-truth-attestor",
          evidenceRole: "operator-assertion",
          schema: HumanReviewOperatorAssertionSchema,
          path: `${path}.operatorAssertion`,
        });
        const assertion = assertionEvidence.value;
        if (
          assertion.attestorRole !== "operator-truth-attestor"
          || assertion.attestorKeyId !== assertionEvidence.keyId
          || assertion.itemSha256 !== resolution.itemSha256
          || assertion.truthLabel !== resolution.truthLabel
          || assertion.assertedAt !== resolution.resolvedAt
          || assertion.limitation !== "operator-only-not-publication-grade"
        ) fail(path, "operator assertion does not exactly bind the non-publication resolution");
        break;
      }
      case "screened-operator-sampled": {
        if (resolution.screeningTableSha256 !== manifest.screeningTableSha256) {
          fail(path, "resolution names a different screening table than the manifest");
        }
        const revealEvidence = authorityPayload(state, {
          digest: resolution.screeningRevealReceiptSha256,
          mediaType: SCREENING_REVEAL_RECEIPT_MEDIA_TYPE,
          role: "truth-reveal-attestor",
          evidenceRole: "screening-reveal-receipt",
          schema: ScreeningRevealReceiptSchema,
          path: `${path}.screeningReveal`,
        });
        const reveal = revealEvidence.value;
        if (
          reveal.attestorRole !== "truth-reveal-attestor"
          || reveal.attestorKeyId !== revealEvidence.keyId
          || reveal.draftId !== input.expectedDraftId
          || reveal.screeningTableSha256 !== resolution.screeningTableSha256
          || reveal.judgeExecutionState !== "not-started"
          || reveal.truthFrozenAt !== manifest.admittedAt
        ) fail(path, "signed screening reveal does not bind the screening table under the same authority");
        // (4) Per-row admission (spec §6.4): an admitted item's own table row must itself be
        // admitted, and the resolution's truth label must be the row's intended label -- the
        // screened branch never corrects a label, only confirms or excludes.
        const row = screeningRowsByItem.get(resolution.itemSha256);
        if (row === undefined) fail(path, "accepted screened item has no covering screening-table row");
        const agreed = row.screeningVerdict === row.intendedLabel;
        const admitted = row.handChecked ? row.handVerdict === "confirm" : agreed;
        if (!admitted) fail(path, "admitted screened item's table row is not itself admitted per §6.4's admission rule");
        if (row.intendedLabel !== resolution.truthLabel) fail(path, "resolution truth label differs from the screening table's intended label");
        break;
      }
      default: {
        const exhaustive: never = resolution;
        fail(path, `unsupported truthAdmission ${String((exhaustive as { truthAdmission?: unknown }).truthAdmission)}`);
      }
    }
    accepted.push({
      itemSha256: prefixed(resolution.itemSha256),
      itemId: resolution.itemId,
      truthLabel: resolution.truthLabel,
      candidateClass: resolution.candidateClass,
      stratum: resolution.stratum,
      truthAdmission: resolution.truthAdmission,
      labelResolutionSha256: prefixed(entry.digest),
      analysisContextSha256: prefixed(contextEntry.digest),
    });
  }
  if (contextByResolution.size !== resolutions.length || contexts.some((entry) => !manifest.labelResolutionSha256s.includes(entry.value.labelResolutionSha256))) {
    fail("admissionManifest.analysisContextSha256s", "analysis-context coverage has an orphan or omission");
  }

  const excludedDigests = ledger.entries.map((entry) => entry.excludedItemSha256).sort(compareCodeUnitStrings);
  if (!sameStrings(excludedDigests, manifest.excludedItemSha256s)) fail("replacementLedger.entries", "ledger exclusion coverage differs from manifest");
  if (manifest.truthAdmission === "operator-only" && ledger.entries.length > 0) fail("replacementLedger.entries", "operator-only admission cannot claim human-review exclusions");
  const excludedItems = new Set<string>();
  const replacementItems = new Set<string>();
  const excluded: VerifiedBinaryJudgmentAdmissionExclusion[] = [];
  let previousPosition = 0;
  for (const [index, entry] of ledger.entries.entries()) {
    const path = `replacementLedger.entries.${index}`;
    if (entry.excludedPoolPosition <= previousPosition) fail(path, "ledger entries are not in deterministic pool order");
    previousPosition = entry.excludedPoolPosition;
    if (excludedItems.has(entry.excludedItemSha256) || acceptedItems.has(entry.excludedItemSha256)) fail(path, "excluded item is duplicated or also admitted");
    excludedItems.add(entry.excludedItemSha256);
    if (replacementItems.has(entry.replacementItemSha256)) fail(path, "one admitted reserve is reused for multiple exclusions");
    replacementItems.add(entry.replacementItemSha256);
    const replacement = accepted.find((candidate) => candidate.itemSha256 === entry.replacementItemSha256);
    if (replacement === undefined) fail(path, "replacement is not in the admitted resolution set");
    if (
      entry.replacementPoolPosition <= entry.excludedPoolPosition
      || replacement.candidateClass !== entry.candidateClass
      || replacement.stratum !== entry.stratum
    ) fail(path, "replacement is not a later admitted reserve in the same class and stratum");
    // Branches on admission mode (spec §6.4, §6.5 check (4); ratified resolution to G-1): a
    // screened exclusion is verified against the screening table's own per-row admission rule
    // rather than against two signed reviews. §6.9 deliberately DROPS the four per-item two-human
    // digests for the screened branch (one signature on the whole table, not 240 on individual
    // rows), so those four fields are never read here for a screened entry. `operator-only` is
    // unreachable in this loop body: any operator-only manifest with ledger.entries.length > 0
    // already refused above, before this loop began.
    let itemId: string;
    let derivedReason: string | undefined;
    switch (manifest.truthAdmission) {
      case "screened-operator-sampled": {
        const row = screeningRowsByItem.get(entry.excludedItemSha256);
        if (row === undefined) fail(path, "excluded item has no covering screening-table row");
        derivedReason = expectedScreeningExclusionReason(row);
        const item = parseProfileRecord<BinaryJudgmentPayloadView>(
          state,
          entry.excludedItemSha256,
          `${path}.item`,
          (bytes) => parseBinaryJudgmentPayload(bytes) as BinaryJudgmentPayloadView,
          "source-item",
        ).value;
        itemId = item.itemId;
        break;
      }
      case "two-human-unanimous": {
        // TypeScript narrows each optional property read below, but not `entry`'s own declared
        // (still-optional) structural type, so the narrowed fields are passed on explicitly
        // rather than passing `entry` itself. Defensive: the schema's own present-iff refinement
        // (checked at `exactCanonical` above) already guarantees these four digests are present
        // for a two-human reason, so this guard should be unreachable, not load-bearing.
        if (
          entry.reviewVerdictSha256s === undefined
          || entry.visibilityReceiptSha256s === undefined
          || entry.reviewerRosterSha256 === undefined
          || entry.revealReceiptSha256 === undefined
        ) fail(path, "two-human ledger entry is missing its required review evidence digests");
        const human = verifyHumanEvidence(state, {
          reviewVerdictSha256s: entry.reviewVerdictSha256s,
          visibilityReceiptSha256s: entry.visibilityReceiptSha256s,
          reviewerRosterSha256: entry.reviewerRosterSha256,
          revealReceiptSha256: entry.revealReceiptSha256,
        }, entry.excludedItemSha256, input.expectedDraftId, manifest.admittedAt, path);
        derivedReason = expectedExclusionReason(human.reviews);
        itemId = human.itemId;
        break;
      }
      case "operator-only":
        fail(path, "operator-only admission cannot claim a replacement-ledger entry");
        break;
      default: {
        const exhaustive: never = manifest.truthAdmission;
        fail(path, `unsupported truthAdmission ${String(exhaustive)}`);
      }
    }
    if (derivedReason === undefined || derivedReason !== entry.reason) fail(path, "ledger reason does not derive from the admitted evidence");
    excluded.push({
      itemSha256: prefixed(entry.excludedItemSha256),
      itemId,
      candidateClass: entry.candidateClass,
      stratum: entry.stratum,
      reason: entry.reason,
      replacementItemSha256: prefixed(entry.replacementItemSha256),
    });
  }

  // (0) Coverage, the other half (spec §6.5 check (0)): the table's rows must cover the frozen
  // bank's candidate pool EXACTLY. The pool itself is not a separate input to this function --
  // it is reconstructed as accepted ∪ excluded, the closure's own admission decision, which by
  // construction is exactly the frozen bank (every candidate item is either admitted or excluded
  // with a same-class same-stratum replacement, and every replacement is itself an admitted pool
  // member). `sampleSize <= rows.length` (check (0)'s other clause) is enforced transitively:
  // `computeScreeningSample` above refuses a `sampleSize` exceeding the pool size on its own.
  if (manifest.truthAdmission === "screened-operator-sampled" && screeningTable !== undefined) {
    const pool = [...acceptedItems, ...excludedItems].sort(compareCodeUnitStrings);
    const rowIdentities = screeningTable.rows.map((row) => row.itemSha256);
    if (!sameStrings(pool, rowIdentities)) {
      fail("screeningTable.rows", "screening table rows do not cover the admitted-plus-excluded closure exactly");
    }
  }

  const classes = [...new Set([...accepted.map((entry) => entry.candidateClass), ...excluded.map((entry) => entry.candidateClass)])].sort(compareCodeUnitStrings);
  const strata = [...new Set([...accepted.map((entry) => entry.stratum), ...excluded.map((entry) => entry.stratum)])].sort(compareCodeUnitStrings);
  return {
    manifestSha256: input.admissionManifestSha256,
    manifest,
    replacementLedger: ledger,
    // Derived by exclusion, not by equality (spec §6.8a Group A, first bullet; ratified fix):
    // `=== "two-human-unanimous"` derives `false` for a screened manifest, which is
    // publication-grade under §6.8, and would make schema.ts's third `superRefine` branch (which
    // REQUIRES `true`) refuse every screened bundle. `operator-only` is the one mode that is
    // never publication-grade.
    publicationGrade: manifest.truthAdmission !== "operator-only",
    classes,
    strata,
    accepted,
    excluded,
    reachableSha256s: [...state.reachable].sort(compareCodeUnitStrings),
    reachableRecords: [...state.roles]
      .sort(([left], [right]) => compareCodeUnitStrings(left, right))
      .map(([sha256, roles]) => ({
        sha256,
        roles: BINARY_JUDGMENT_ADMISSION_RECORD_ROLES.filter((role) => roles.has(role)),
      })),
    // Present iff screened (spec §6.5 check (3)): the one definition of the screen-versus-hand
    // agreement rate on the random sample, so no caller recomputes it independently.
    ...(screeningSampleAgreementRate === undefined ? {} : {
      screening: { sampleAgreementRate: screeningSampleAgreementRate },
    }),
  };
}
