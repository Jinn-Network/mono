// SPDX-License-Identifier: Apache-2.0

import { InvalidOfferError, OFFER_RECORD_KIND, OFFER_RECORD_MEDIA_TYPE, parseOfferEnvelope } from "@jinn-network/evidence-offer";
import {
  DSSE_PAYLOAD_TYPE,
  EXECUTION_EVIDENCE_PROFILE_URI,
  EXECUTION_VERIFICATION_PREDICATE_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  validateExecutionEvidence,
  validateExecutionVerification,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";
import type { ConformanceDiagnostic } from "@jinn-network/evidence-protocol";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";

import { documentField, isRecordObject } from "../record-view.js";
import type { RecordView } from "../record-view.js";
import { describeError } from "../results.js";
import type { Finding } from "../results.js";
import type { RecordKind, RecordReference } from "./kind.js";
import { descriptorListReferences, descriptorReference, digestReference } from "./references.js";

/**
 * Execution Evidence Profile 1.0. Its text, not the general rules, decides two things here.
 *
 * Encoding: §1 applies conformance "to the exact bytes supplied to a validator", §3 asks for a UTF-8
 * JSON object, and §4 for "a DSSE object". None of them asks for RFC 8785, and the profile's golden
 * vector is pretty-printed. So digest binding holds and the canonical comparison is not this family's
 * rule; a reader must not fail a conforming record on it.
 *
 * Signatures: §4 makes `keyid` optional and §6 says the implementation "does not resolve keys", so a
 * claim's key comes from the caller unless its `keyid` happens to carry one.
 */

const EXACT_BYTES_RULE = "Execution Evidence Profile 1.0 §1: conformance applies to the exact bytes supplied; the profile requires no canonical encoding, so identity rests on the digest.";

function findings(diagnostics: readonly ConformanceDiagnostic[]): readonly Finding[] {
  return diagnostics.map(({ code, path, message }) => ({ code, path, detail: message }));
}

/** A bare Statement names the kind too, and then fails it: §4 requires the DSSE envelope. */
function isStatementOf(view: RecordView, predicateType: string): boolean {
  return documentField(view, "predicateType") === predicateType
    && (view.payloadType === undefined || view.payloadType === DSSE_PAYLOAD_TYPE);
}

/** §3.1: the Root Dataset's `conformsTo` includes the profile. A generic RO-Crate does not. */
function declaresEvidenceProfile(view: RecordView): boolean {
  const graph = documentField(view, "@graph");
  if (!Array.isArray(graph)) return false;
  const root = (graph as readonly unknown[]).find((entity) => isRecordObject(entity) && entity["@id"] === "./");
  if (!isRecordObject(root)) return false;
  return [root["conformsTo"]].flat().some((reference) =>
    isRecordObject(reference) && reference["@id"] === EXECUTION_EVIDENCE_PROFILE_URI);
}

/**
 * Every content-bound entity. §2 lets an artifact's bytes be withheld behind its commitment and the
 * public derivative in §3.6 does exactly that, so an absent one is unavailable, not dangling.
 */
function executionEvidenceReferences(view: RecordView): readonly RecordReference[] {
  const graph = documentField(view, "@graph") as readonly Record<string, unknown>[];
  return graph.flatMap((entity, index) => (typeof entity["sha256"] === "string"
    ? digestReference(`sha256:${entity["sha256"]}`, String(entity["@id"]), `/@graph/${index}/sha256`, true)
    : []));
}

/** §7: "Conformance says the record is structurally interpretable. It does not say that artifact bytes are available." */
function claimReferences(view: RecordView, method: string, specification: string): readonly RecordReference[] {
  const predicate = documentField(view, "predicate") as Record<string, unknown>;
  return [
    ...descriptorListReferences(documentField(view, "subject"), "subject", "/subject", true),
    ...descriptorReference(predicate[method], method, `/predicate/${method}`, true),
    ...descriptorReference(predicate[specification], specification, `/predicate/${specification}`, true),
    ...descriptorListReferences(predicate["evidence"], "evidence", "/predicate/evidence", true),
    ...descriptorListReferences(predicate["supersedes"], "supersedesDigests", "/predicate/supersedes", false),
    ...descriptorListReferences(predicate["disputes"], "disputesDigests", "/predicate/disputes", false),
  ];
}

function predicateField(view: RecordView, name: string): unknown {
  const predicate = documentField(view, "predicate");
  return isRecordObject(predicate) ? predicate[name] : undefined;
}

function claimAttribution(view: RecordView, actor: string, timeField: string) {
  const named = predicateField(view, actor);
  const agent = isRecordObject(named) ? named["id"] : undefined;
  const atTime = predicateField(view, timeField);
  return typeof agent === "string"
    ? { agent, scope: "verdicts", ...(typeof atTime === "string" ? { atTime } : {}) }
    : undefined;
}

function offerFindings({ bytes }: RecordView): readonly Finding[] {
  try {
    parseOfferEnvelope(bytes);
    return [];
  } catch (cause) {
    if (cause instanceof InvalidOfferError) {
      return cause.errors.map(({ path, message }) => ({ code: "invalid-document", path, detail: message }));
    }
    return [{ code: "invalid-document", detail: describeError(cause) }];
  }
}

export const EVIDENCE_KINDS: Readonly<Record<string, RecordKind>> = {
  [RECORD_KINDS.executionEvidence]: {
    family: "execution-evidence",
    identify: declaresEvidenceProfile,
    validate: ({ bytes }) => findings(validateExecutionEvidence(bytes).diagnostics),
    encodingExemption: EXACT_BYTES_RULE,
    unsignedBecause: "Execution Evidence Profile 1.0 §1: Execution Evidence is an unsigned RO-Crate; a later Execution Verification signs over it.",
    references: executionEvidenceReferences,
  },
  [RECORD_KINDS.resultEvaluation]: {
    family: "execution-evidence",
    identify: (view) => isStatementOf(view, RESULT_EVALUATION_PREDICATE_TYPE),
    validate: ({ bytes }) => findings(validateResultEvaluation(bytes).diagnostics),
    encodingExemption: EXACT_BYTES_RULE,
    anyEnvelopeSpelling: true,
    references: (view) => claimReferences(view, "evaluationMethod", "evaluationSpecification"),
    attribution: (view) => claimAttribution(view, "evaluator", "evaluatedAt"),
  },
  [RECORD_KINDS.executionVerification]: {
    family: "execution-evidence",
    identify: (view) => isStatementOf(view, EXECUTION_VERIFICATION_PREDICATE_TYPE),
    validate: ({ bytes }) => findings(validateExecutionVerification(bytes).diagnostics),
    encodingExemption: EXACT_BYTES_RULE,
    anyEnvelopeSpelling: true,
    references: (view) => claimReferences(view, "verificationMethod", "verificationPolicy")
      // §5: what is verified is one exact serialization, so unlike an artifact it has to be held.
      .map((reference) => (reference.field === "subject" ? { ...reference, mayBeUnavailable: false } : reference)),
    attribution: (view) => claimAttribution(view, "verifier", "verifiedAt"),
  },
  [OFFER_RECORD_KIND]: {
    family: "execution-evidence",
    // A published facts profile for offers carries the same `kind`, as the kind it describes, beside
    // a `protocol` no offer has.
    identify: (view) => view.payloadType === OFFER_RECORD_MEDIA_TYPE
      || (documentField(view, "kind") === OFFER_RECORD_KIND && documentField(view, "protocol") === undefined),
    validate: offerFindings,
    references: (view) => [
      // An offer is for a record its reader may not hold yet.
      ...digestReference(documentField(view, "subject"), "subject", "/subject", true),
      ...digestReference(documentField(view, "supersedes"), "supersedes", "/supersedes", false),
    ],
    // The holder is an input the record cannot vouch for (`verifyOffer`), so nothing is attributed here.
  },
};
