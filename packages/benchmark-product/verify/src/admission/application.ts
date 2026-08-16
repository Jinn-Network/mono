// SPDX-License-Identifier: Apache-2.0

import {
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  canonicalJsonBytes,
  sealDocument,
  sealEvaluationSpec,
  type BinaryJudgmentPayload,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";

export const HUMAN_REVIEW_FORM = {
  protocol: "https://spec.jinn.network/binary-judgment/human-review-form/v1",
  question: "Is the candidate answer correct relative to the question and reference answer?",
  labels: ["CORRECT", "WRONG", "indeterminate"],
  completeReviewRequired: true,
  rationale: "optional",
} as const;

export const HUMAN_REVIEW_FORM_SEALED = sealDocument(HUMAN_REVIEW_FORM);

export function binaryJudgmentItemBytes(item: BinaryJudgmentPayload): Uint8Array {
  return canonicalJsonBytes(item);
}

export function buildBinaryJudgmentHumanReviewEvaluationSpec(): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "human-review",
    grader: {
      name: "external-human-review",
      uri: HUMAN_REVIEW_FORM.protocol,
      digest: { sha256: HUMAN_REVIEW_FORM_SEALED.digest.slice("sha256:".length) },
      mediaType: "application/vnd.jinn.binary-judgment.human-review-form.v1+json",
      accessClass: "public",
    },
    familyBlock: {
      reviewForm: {
        name: "human-review-form.json",
        uri: HUMAN_REVIEW_FORM.protocol,
        digest: { sha256: HUMAN_REVIEW_FORM_SEALED.digest.slice("sha256:".length) },
        mediaType: "application/vnd.jinn.binary-judgment.human-review-form.v1+json",
      },
      reviewerQualifications: { roleDeclaredInRoster: true },
      attestationShape: {
        labels: ["CORRECT", "WRONG", "indeterminate"],
        completeReviewRequired: true,
      },
    },
    measurements: [
      { name: "truthLabel", type: "string", direction: "none", required: true },
      { name: "reviewComplete", type: "boolean", direction: "none", required: true },
      { name: "reviewPacketSha256", type: "string", direction: "none", required: true },
      { name: "visibilityReceiptSha256", type: "string", direction: "none", required: true },
      { name: "responseSha256", type: "string", direction: "none", required: true },
    ],
    verdictRule: { threshold: { measurement: "truthLabel", op: "eq", value: "CORRECT" } },
    unscorable: [{ name: "indeterminate", disposition: "recorded-inconclusive" }],
    evidenceConventions: {
      requiredRefs: ["human-review-packet", "visibility-receipt", "human-review-response"],
    },
  };
}

export const BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED = sealEvaluationSpec(
  buildBinaryJudgmentHumanReviewEvaluationSpec(),
);
