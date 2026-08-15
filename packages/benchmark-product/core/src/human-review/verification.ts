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
  type BinaryJudgmentAnalysisContext,
  type BinaryJudgmentLabelResolution,
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
  HumanReviewOperatorAssertionSchema,
  HumanReviewPacketSchema,
  HumanReviewReplacementLedgerSchema,
  HumanReviewResponseSchema,
  HumanReviewRevealReceiptSchema,
  HumanReviewRosterSchema,
  HumanReviewVisibilityReceiptSchema,
  type BinaryJudgmentAdmissionManifest,
  type HumanReviewReplacementLedger,
} from "./contracts.js";
import { readOrderedVerdictMeasurements, readVerdictEnvelope } from "../venue/signing.js";

export type AdmissionSha256 = `sha256:${string}`;
export const BINARY_JUDGMENT_ADMISSION_RECORD_ROLES = [
  "admission-manifest", "replacement-ledger", "source-item", "label-resolution",
  "analysis-context", "human-review-evaluation-spec", "human-review-form",
  "human-review-packet", "human-review-response", "human-review-verdict",
  "reviewer-roster", "review-visibility-receipt", "review-reveal-receipt",
  "operator-assertion",
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
  readonly stratum: "core" | "stress";
  readonly truthAdmission: "two-human-unanimous" | "operator-only";
  readonly labelResolutionSha256: AdmissionSha256;
  readonly analysisContextSha256: AdmissionSha256;
}

export interface VerifiedBinaryJudgmentAdmissionExclusion {
  readonly itemSha256: AdmissionSha256;
  readonly itemId: string;
  readonly candidateClass: string;
  readonly stratum: "core" | "stress";
  readonly reason: "review-disagreement" | "review-indeterminate" | "review-incomplete";
  readonly replacementItemSha256: AdmissionSha256;
}

export interface VerifiedBinaryJudgmentAdmissionClosure {
  readonly manifestSha256: AdmissionSha256;
  readonly manifest: BinaryJudgmentAdmissionManifest;
  readonly replacementLedger: HumanReviewReplacementLedger;
  readonly publicationGrade: boolean;
  readonly classes: readonly string[];
  readonly strata: readonly ("core" | "stress")[];
  readonly accepted: readonly VerifiedBinaryJudgmentAdmissionItem[];
  readonly excluded: readonly VerifiedBinaryJudgmentAdmissionExclusion[];
  /** Complete, sorted digest inventory reachable from the manifest closure. */
  readonly reachableSha256s: readonly AdmissionSha256[];
  /** Same closure with semantic roles assigned by the exact traversal that authenticated it. */
  readonly reachableRecords: readonly {
    readonly sha256: AdmissionSha256;
    readonly roles: readonly BinaryJudgmentAdmissionRecordRole[];
  }[];
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
  let view: ReturnType<typeof readVerdictEnvelope>;
  let ordered: ReturnType<typeof readOrderedVerdictMeasurements>;
  try {
    view = readVerdictEnvelope(envelopeBytes);
    ordered = readOrderedVerdictMeasurements(envelopeBytes);
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
  const item = parseProfileRecord(state, expectedItemSha256, `${path}.item`, parseBinaryJudgmentPayload, "source-item").value;
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

function authorityPayload<T>(
  state: VerificationState,
  digest: string,
  mediaType: string,
  role: AdmissionAuthorityRole,
  schema: z.ZodType<T>,
  path: string,
): { readonly value: T; readonly keyId: string } {
  const evidenceRole: BinaryJudgmentAdmissionRecordRole = role === "roster-attestor"
    ? "reviewer-roster"
    : role === "truth-reveal-attestor"
      ? "review-reveal-receipt"
      : "operator-assertion";
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
  const rosterEvidence = authorityPayload(state, refs.reviewerRosterSha256, HUMAN_REVIEW_ROSTER_MEDIA_TYPE, "roster-attestor", HumanReviewRosterSchema, `${path}.roster`);
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
  const revealEvidence = authorityPayload(state, refs.revealReceiptSha256, HUMAN_REVIEW_REVEAL_RECEIPT_MEDIA_TYPE, "truth-reveal-attestor", HumanReviewRevealReceiptSchema, `${path}.reveal`);
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

  const resolutions = manifest.labelResolutionSha256s.map((digest, index) => ({
    digest,
    ...parseProfileRecord(state, digest, `admissionManifest.labelResolutionSha256s.${index}`, parseBinaryJudgmentLabelResolution, "label-resolution"),
  }));
  const contexts = manifest.analysisContextSha256s.map((digest, index) => ({
    digest,
    ...parseProfileRecord(state, digest, `admissionManifest.analysisContextSha256s.${index}`, parseBinaryJudgmentAnalysisContext, "analysis-context"),
  }));
  if (resolutions.length !== contexts.length) fail("admissionManifest", "resolution and analysis-context coverage differs");
  const contextByResolution = new Map(contexts.map((entry) => [entry.value.labelResolutionSha256, entry]));
  if (contextByResolution.size !== contexts.length) fail("admissionManifest.analysisContextSha256s", "multiple contexts cover one resolution");
  const acceptedItems = new Set<string>();
  const accepted: VerifiedBinaryJudgmentAdmissionItem[] = [];

  for (const [index, entry] of resolutions.entries()) {
    const resolution = entry.value;
    const path = `resolutions.${index}`;
    if (acceptedItems.has(resolution.itemSha256)) fail(path, "item is admitted more than once");
    acceptedItems.add(resolution.itemSha256);
    if (resolution.truthAdmission !== manifest.truthAdmission || resolution.resolvedAt !== manifest.admittedAt) fail(path, "resolution admission kind/time differs from manifest");
    if (resolution.humanReviewEvaluationSpecSha256 !== BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest) fail(path, "resolution names a different human-review EvaluationSpec");
    verifyFrozenHumanReviewSpec(state, path);
    const item = parseProfileRecord(state, resolution.itemSha256, `${path}.itemSha256`, parseBinaryJudgmentPayload, "source-item").value;
    if (item.itemId !== resolution.itemId) fail(path, "resolution itemId differs from exact item record");
    const contextEntry = contextByResolution.get(entry.digest);
    if (contextEntry === undefined) fail(path, "resolution has no analysis context");
    const context: BinaryJudgmentAnalysisContext = contextEntry.value;
    if (
      context.itemSha256 !== resolution.itemSha256
      || context.itemId !== resolution.itemId
      || context.truthLabel !== resolution.truthLabel
      || context.candidateClass !== resolution.candidateClass
      || context.stratum !== resolution.stratum
    ) fail(path, "analysis context does not exactly project the resolution");

    if (resolution.truthAdmission === "two-human-unanimous") {
      const human = verifyHumanEvidence(state, resolution, resolution.itemSha256, input.expectedDraftId, manifest.admittedAt, path);
      if (
        human.itemId !== resolution.itemId
        || human.reviews.some((review) => !review.complete || review.label === "indeterminate" || review.label !== resolution.truthLabel)
      ) fail(path, "admitted human truth is not two complete unanimous reviews");
    } else {
      const assertionEvidence = authorityPayload(state, resolution.operatorAssertionSha256, HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE, "operator-truth-attestor", HumanReviewOperatorAssertionSchema, `${path}.operatorAssertion`);
      const assertion = assertionEvidence.value;
      if (
        assertion.attestorRole !== "operator-truth-attestor"
        || assertion.attestorKeyId !== assertionEvidence.keyId
        || assertion.itemSha256 !== resolution.itemSha256
        || assertion.truthLabel !== resolution.truthLabel
        || assertion.assertedAt !== resolution.resolvedAt
        || assertion.limitation !== "operator-only-not-publication-grade"
      ) fail(path, "operator assertion does not exactly bind the non-publication resolution");
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
    const human = verifyHumanEvidence(state, entry, entry.excludedItemSha256, input.expectedDraftId, manifest.admittedAt, path);
    const derivedReason = expectedExclusionReason(human.reviews);
    if (derivedReason === undefined || derivedReason !== entry.reason) fail(path, "ledger reason does not derive from the two signed reviews");
    excluded.push({
      itemSha256: prefixed(entry.excludedItemSha256),
      itemId: human.itemId,
      candidateClass: entry.candidateClass,
      stratum: entry.stratum,
      reason: entry.reason,
      replacementItemSha256: prefixed(entry.replacementItemSha256),
    });
  }

  const classes = [...new Set([...accepted.map((entry) => entry.candidateClass), ...excluded.map((entry) => entry.candidateClass)])].sort(compareCodeUnitStrings);
  const strata = [...new Set([...accepted.map((entry) => entry.stratum), ...excluded.map((entry) => entry.stratum)])].sort(compareCodeUnitStrings);
  return {
    manifestSha256: input.admissionManifestSha256,
    manifest,
    replacementLedger: ledger,
    publicationGrade: manifest.truthAdmission === "two-human-unanimous",
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
  };
}
