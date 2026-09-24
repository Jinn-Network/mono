// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the enum widenings the screened-operator-sampled admission branch adds to
 * `BinaryJudgmentAdmissionManifestSchema` and `HumanReviewReplacementLedgerEntrySchema` (judge-path
 * program packet P6, spec `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §6.4,
 * §6.8, §10 row 13, §10 row 18). Every input valid before this change must still validate and seal
 * to identical bytes (spec §0.4) — asserted below by byte-for-byte proof, not by assertion in
 * prose.
 *
 * Every digest below is synthetic: `"sha256:" + "<digit>".repeat(64)`, never a real dataset row.
 */

import { describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/task-execution-profiles";
import {
  BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
  BinaryJudgmentAdmissionManifestSchema,
  HumanReviewReplacementLedgerEntrySchema,
} from "./contracts.js";

const digest = (d: string) => `sha256:${d.repeat(64)}`;

function twoHumanManifest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    protocol: BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
    draftId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    truthAdmission: "two-human-unanimous",
    labelResolutionSha256s: [digest("1"), digest("2")],
    analysisContextSha256s: [digest("3"), digest("4")],
    excludedItemSha256s: [],
    replacementLedgerSha256: digest("5"),
    admittedAt: "2026-08-20T09:00:00.000Z",
    ...overrides,
  };
}

function twoHumanLedgerEntry(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    excludedItemSha256: digest("1"),
    replacementItemSha256: digest("2"),
    candidateClass: "factual",
    stratum: "core",
    excludedPoolPosition: 1,
    replacementPoolPosition: 2,
    reason: "review-disagreement",
    reviewVerdictSha256s: [digest("3"), digest("4")],
    visibilityReceiptSha256s: [digest("5"), digest("6")],
    reviewerRosterSha256: digest("7"),
    revealReceiptSha256: digest("8"),
    ...overrides,
  };
}

describe("BinaryJudgmentAdmissionManifestSchema truthAdmission widening (§6.8, §10 row 13)", () => {
  test("byte-compat proof: an existing two-human-unanimous manifest (no screeningTableSha256) seals identically", () => {
    const parsed = BinaryJudgmentAdmissionManifestSchema.parse(twoHumanManifest());
    expect(new TextDecoder().decode(canonicalJsonBytes(parsed))).toBe(
      '{"admittedAt":"2026-08-20T09:00:00.000Z","analysisContextSha256s":["sha256:'
      + "3".repeat(64) + '","sha256:' + "4".repeat(64) + '"],"draftId":"urn:uuid:11111111-1111-4111-8111-111111111111",'
      + '"excludedItemSha256s":[],"labelResolutionSha256s":["sha256:' + "1".repeat(64)
      + '","sha256:' + "2".repeat(64) + '"],"protocol":"https://spec.jinn.network/binary-judgment/admission-manifest/v1",'
      + '"replacementLedgerSha256":"sha256:' + "5".repeat(64) + '","truthAdmission":"two-human-unanimous"}',
    );
  });

  test("an operator-only manifest still validates without screeningTableSha256", () => {
    expect(BinaryJudgmentAdmissionManifestSchema.safeParse(
      twoHumanManifest({ truthAdmission: "operator-only" }),
    ).success).toBe(true);
  });

  test("accepts screened-operator-sampled with screeningTableSha256 present", () => {
    expect(BinaryJudgmentAdmissionManifestSchema.safeParse(twoHumanManifest({
      truthAdmission: "screened-operator-sampled",
      screeningTableSha256: digest("9"),
    })).success).toBe(true);
  });

  test("refuses screened-operator-sampled with screeningTableSha256 absent", () => {
    expect(BinaryJudgmentAdmissionManifestSchema.safeParse(twoHumanManifest({
      truthAdmission: "screened-operator-sampled",
    })).success).toBe(false);
  });

  test("refuses screeningTableSha256 present on the two non-screened modes (present-iff, both directions)", () => {
    expect(BinaryJudgmentAdmissionManifestSchema.safeParse(twoHumanManifest({
      truthAdmission: "two-human-unanimous",
      screeningTableSha256: digest("9"),
    })).success).toBe(false);
    expect(BinaryJudgmentAdmissionManifestSchema.safeParse(twoHumanManifest({
      truthAdmission: "operator-only",
      screeningTableSha256: digest("9"),
    })).success).toBe(false);
  });

  test("refuses an unknown truthAdmission value entirely", () => {
    expect(BinaryJudgmentAdmissionManifestSchema.safeParse(twoHumanManifest({
      truthAdmission: "some-other-mode",
    })).success).toBe(false);
  });
});

describe("HumanReviewReplacementLedgerEntrySchema reason widening (§6.4, §10 row 18)", () => {
  test("byte-compat proof: an existing review-disagreement entry (four digests present) seals identically", () => {
    const parsed = HumanReviewReplacementLedgerEntrySchema.parse(twoHumanLedgerEntry());
    expect(new TextDecoder().decode(canonicalJsonBytes(parsed))).toBe(
      '{"candidateClass":"factual","excludedItemSha256":"sha256:' + "1".repeat(64)
      + '","excludedPoolPosition":1,"reason":"review-disagreement","replacementItemSha256":"sha256:'
      + "2".repeat(64) + '","replacementPoolPosition":2,"revealReceiptSha256":"sha256:' + "8".repeat(64)
      + '","reviewVerdictSha256s":["sha256:' + "3".repeat(64) + '","sha256:' + "4".repeat(64)
      + '"],"reviewerRosterSha256":"sha256:' + "7".repeat(64) + '","stratum":"core","visibilityReceiptSha256s":['
      + '"sha256:' + "5".repeat(64) + '","sha256:' + "6".repeat(64) + '"]}',
    );
  });

  test("the existing three review-* reasons still require all four two-human digests", () => {
    for (const reason of ["review-disagreement", "review-indeterminate", "review-incomplete"]) {
      const { reviewVerdictSha256s: _omitted, ...withoutOne } = twoHumanLedgerEntry({ reason });
      expect(HumanReviewReplacementLedgerEntrySchema.safeParse(withoutOne).success).toBe(false);
    }
  });

  test("accepts each of the three new screening-* reasons with all four two-human digests absent", () => {
    for (const reason of ["screening-disagreement", "screening-indeterminate", "screening-hand-excluded"]) {
      const {
        reviewVerdictSha256s: _a, visibilityReceiptSha256s: _b, reviewerRosterSha256: _c,
        revealReceiptSha256: _d, ...screenedShape
      } = twoHumanLedgerEntry({ reason });
      expect(HumanReviewReplacementLedgerEntrySchema.safeParse(screenedShape).success).toBe(true);
    }
  });

  test("refuses a screening-* reason if any of the four two-human digests is present (present-iff two-human, both directions)", () => {
    const {
      visibilityReceiptSha256s: _b, reviewerRosterSha256: _c, revealReceiptSha256: _d, ...withOnlyReviewVerdicts
    } = twoHumanLedgerEntry({ reason: "screening-disagreement" });
    expect(HumanReviewReplacementLedgerEntrySchema.safeParse(withOnlyReviewVerdicts).success).toBe(false);
  });

  test("refuses an unknown reason value entirely", () => {
    expect(HumanReviewReplacementLedgerEntrySchema.safeParse(twoHumanLedgerEntry({
      reason: "some-other-reason",
    })).success).toBe(false);
  });
});
