// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
  BINARY_JUDGMENT_LABEL_RESOLUTION_MEDIA_TYPE,
} from "../identifiers.js";
import {
  type BinaryJudgmentLabelResolution,
  BinaryJudgmentLabelResolutionSchema,
  parseBinaryJudgmentLabelResolution,
  sealBinaryJudgmentLabelResolution,
} from "./label-resolution.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}` as const;

const human: BinaryJudgmentLabelResolution = {
  protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
  itemSha256: digest("1"),
  itemId: "urn:uuid:123e4567-e89b-12d3-a456-426614174000",
  humanReviewEvaluationSpecSha256: digest("2"),
  truthLabel: "WRONG",
  candidateClass: "temporal",
  stratum: "stress",
  truthAdmission: "two-human-unanimous",
  reviewVerdictSha256s: [digest("3"), digest("4")],
  reviewerRosterSha256: digest("5"),
  visibilityReceiptSha256s: [digest("6"), digest("7")],
  revealReceiptSha256: digest("8"),
  resolvedAt: "2026-08-15T09:00:00.000Z",
};

describe("binary judgment label-resolution@1", () => {
  it("seals and parses the frozen human golden bytes", () => {
    const sealed = sealBinaryJudgmentLabelResolution(human);
    expect(new TextDecoder().decode(sealed.bytes)).toBe(
      '{"candidateClass":"temporal","humanReviewEvaluationSpecSha256":"sha256:' + "2".repeat(64)
      + '","itemId":"urn:uuid:123e4567-e89b-12d3-a456-426614174000","itemSha256":"sha256:'
      + "1".repeat(64) + '","protocol":"https://spec.jinn.network/binary-judgment/label-resolution/v1",'
      + '"resolvedAt":"2026-08-15T09:00:00.000Z","revealReceiptSha256":"sha256:' + "8".repeat(64)
      + '","reviewVerdictSha256s":["sha256:' + "3".repeat(64) + '","sha256:' + "4".repeat(64)
      + '"],"reviewerRosterSha256":"sha256:' + "5".repeat(64) + '","stratum":"stress",'
      + '"truthAdmission":"two-human-unanimous","truthLabel":"WRONG","visibilityReceiptSha256s":['
      + '"sha256:' + "6".repeat(64) + '","sha256:' + "7".repeat(64) + '"]}',
    );
    expect(parseBinaryJudgmentLabelResolution(sealed.bytes)).toEqual(human);
    expect(BINARY_JUDGMENT_LABEL_RESOLUTION_MEDIA_TYPE).toContain("label-resolution.v1");
  });

  it("keeps operator-only evidence distinct from publication-grade review evidence", () => {
    const operator: BinaryJudgmentLabelResolution = {
      protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
      itemSha256: digest("1"),
      itemId: human.itemId,
      humanReviewEvaluationSpecSha256: digest("2"),
      truthLabel: "CORRECT",
      candidateClass: "factual",
      stratum: "core",
      truthAdmission: "operator-only",
      operatorAssertionSha256: digest("9"),
      resolvedAt: "2026-08-15T09:00:00.000Z",
    };
    expect(parseBinaryJudgmentLabelResolution(sealBinaryJudgmentLabelResolution(operator).bytes))
      .toEqual(operator);
    expect(BinaryJudgmentLabelResolutionSchema.safeParse({
      ...operator,
      reviewVerdictSha256s: [digest("3"), digest("4")],
    }).success).toBe(false);
  });

  it("rejects reordered, duplicate, copied, or unknown authority evidence", () => {
    expect(BinaryJudgmentLabelResolutionSchema.safeParse({
      ...human,
      reviewVerdictSha256s: [...human.reviewVerdictSha256s].reverse(),
    }).success).toBe(false);
    expect(BinaryJudgmentLabelResolutionSchema.safeParse({
      ...human,
      visibilityReceiptSha256s: [digest("6"), digest("6")],
    }).success).toBe(false);
    expect(BinaryJudgmentLabelResolutionSchema.safeParse({
      ...human,
      verdicts: [{ truthLabel: "WRONG" }],
    }).success).toBe(false);
    expect(BinaryJudgmentLabelResolutionSchema.safeParse({ ...human, extra: true }).success)
      .toBe(false);
  });

  // §6.7's CommonShape refactor moves `humanReviewEvaluationSpecSha256` from a shared spread into
  // each of the two existing branch literals. Canonical JSON sorts keys, so the refactor must not
  // move a single byte. This pins the operator-only branch's exact serialized bytes (the human
  // branch is already pinned above), captured from the pre-refactor schema.
  it("keeps the operator-only branch byte-stable across the CommonShape refactor", () => {
    const operator: BinaryJudgmentLabelResolution = {
      protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
      itemSha256: digest("1"),
      itemId: human.itemId,
      humanReviewEvaluationSpecSha256: digest("2"),
      truthLabel: "CORRECT",
      candidateClass: "factual",
      stratum: "core",
      truthAdmission: "operator-only",
      operatorAssertionSha256: digest("9"),
      resolvedAt: "2026-08-15T09:00:00.000Z",
    };
    const sealed = sealBinaryJudgmentLabelResolution(operator);
    expect(new TextDecoder().decode(sealed.bytes)).toBe(
      '{"candidateClass":"factual","humanReviewEvaluationSpecSha256":"sha256:' + "2".repeat(64)
      + '","itemId":"urn:uuid:123e4567-e89b-12d3-a456-426614174000","itemSha256":"sha256:'
      + "1".repeat(64) + '","operatorAssertionSha256":"sha256:' + "9".repeat(64)
      + '","protocol":"https://spec.jinn.network/binary-judgment/label-resolution/v1",'
      + '"resolvedAt":"2026-08-15T09:00:00.000Z","stratum":"core",'
      + '"truthAdmission":"operator-only","truthLabel":"CORRECT"}',
    );
  });

  // §6.7 third member: screened by a pinned model, sampled and hand-checked by the operator.
  describe("screened-operator-sampled (§6.7)", () => {
    const screened: BinaryJudgmentLabelResolution = {
      protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
      itemSha256: digest("1"),
      itemId: human.itemId,
      truthLabel: "CORRECT",
      candidateClass: "factual",
      stratum: "core",
      truthAdmission: "screened-operator-sampled",
      screeningTableSha256: digest("a"),
      screeningRevealReceiptSha256: digest("b"),
      resolvedAt: "2026-08-15T09:00:00.000Z",
    };

    it("seals and parses the screened branch round trip", () => {
      const sealed = sealBinaryJudgmentLabelResolution(screened);
      expect(parseBinaryJudgmentLabelResolution(sealed.bytes)).toEqual(screened);
    });

    it("never carries humanReviewEvaluationSpecSha256: a row never hand-checked has no human review", () => {
      expect(BinaryJudgmentLabelResolutionSchema.safeParse({
        ...screened,
        humanReviewEvaluationSpecSha256: digest("2"),
      }).success).toBe(false);
    });

    it("rejects a screening branch missing either screening digest", () => {
      const { screeningTableSha256: _omitted, ...withoutTable } = screened;
      expect(BinaryJudgmentLabelResolutionSchema.safeParse(withoutTable).success).toBe(false);
      const { screeningRevealReceiptSha256: _omitted2, ...withoutReceipt } = screened;
      expect(BinaryJudgmentLabelResolutionSchema.safeParse(withoutReceipt).success).toBe(false);
    });

    it("rejects two-human or operator-only fields mixed onto the screened branch", () => {
      expect(BinaryJudgmentLabelResolutionSchema.safeParse({
        ...screened,
        operatorAssertionSha256: digest("9"),
      }).success).toBe(false);
      expect(BinaryJudgmentLabelResolutionSchema.safeParse({
        ...screened,
        reviewVerdictSha256s: [digest("3"), digest("4")],
      }).success).toBe(false);
    });

    it("rejects an unknown truthAdmission value entirely (closed three-member union)", () => {
      expect(BinaryJudgmentLabelResolutionSchema.safeParse({
        ...screened,
        truthAdmission: "screened-somehow-else",
      }).success).toBe(false);
    });
  });
});
