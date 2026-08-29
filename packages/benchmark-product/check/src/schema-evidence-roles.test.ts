// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the two new evidence roles the screened-operator-sampled admission branch adds to
 * the three hand-synchronized role lists (judge-path program packet P6, spec
 * `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §6.8a Group C, first bullet):
 * `verify/src/schema.ts`'s `BUNDLE_V4_EVIDENCE_ROLES` and its admission-only subset
 * `BUNDLE_V4_ADMISSION_EVIDENCE_ROLES`, and `verify/src/admission/verification.ts`'s verbatim
 * duplicate `BINARY_JUDGMENT_ADMISSION_RECORD_ROLES`.
 *
 * These lists' index order is a frozen ordering map (spec §1.5 rule 5 / §1.6 site 9): appending at
 * the very end is the only safe edit, and packet P1 already appended `snapshot-probe` last to the
 * full list. This packet appends `screening-table` then `screening-reveal-receipt` after that, in
 * all three lists, in one edit.
 */

import { describe, expect, test } from "vitest";
import {
  BUNDLE_V4_ADMISSION_EVIDENCE_ROLES,
  BUNDLE_V4_EVIDENCE_ROLES,
} from "./schema.js";
import { BINARY_JUDGMENT_ADMISSION_RECORD_ROLES } from "./admission/verification.js";
import {
  HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL,
  HUMAN_REVIEW_REVEAL_RECEIPT_PROTOCOL,
  HumanReviewResponseSchema,
  SCREENING_REVEAL_RECEIPT_PROTOCOL,
  SCREENING_TABLE_PROTOCOL,
  ScreeningRowSchema,
} from "./admission/contracts.js";

describe("evidence role vocabularies (§6.8a Group C)", () => {
  test("BUNDLE_V4_EVIDENCE_ROLES carries the nested screening roles as an appended tail", () => {
    const tail = BUNDLE_V4_EVIDENCE_ROLES.slice(-11);
    expect(tail).toEqual([
      "snapshot-probe", "screening-table", "screening-reveal-receipt",
      "screening-instrument", "screening-sampling-script", "screening-raw-outputs",
      "screening-prompt", "screening-procedure", "screening-pool",
      "screening-sample-commitment", "screening-transcript",
    ]);
  });

  test("BUNDLE_V4_ADMISSION_EVIDENCE_ROLES carries the nested screening roles as an appended tail", () => {
    const tail = BUNDLE_V4_ADMISSION_EVIDENCE_ROLES.slice(-11);
    expect(tail).toEqual([
      "operator-assertion", "screening-table", "screening-reveal-receipt",
      "screening-instrument", "screening-sampling-script", "screening-raw-outputs",
      "screening-prompt", "screening-procedure", "screening-pool",
      "screening-sample-commitment", "screening-transcript",
    ]);
  });

  test("every existing role is unmoved: the two new roles are strictly appended, nothing reordered", () => {
    const previousFull = [
      "task", "runtime-selection", "evaluation-spec", "admission-receipt", "solve-submission",
      "run-pinning-evidence", "evaluation-submission", "solve-delivery", "solve-output",
      "evaluation-task", "evaluation-delivery", "verdict", "item-bank", "source-manifest",
      "admission-index", "admission-manifest", "replacement-ledger", "source-item",
      "judge-instrument", "analysis-context", "label-resolution", "human-review-evaluation-spec",
      "human-review-form", "human-review-packet", "human-review-response", "human-review-verdict",
      "reviewer-roster", "review-visibility-receipt", "review-reveal-receipt", "operator-assertion",
      "snapshot-probe",
    ];
    expect(BUNDLE_V4_EVIDENCE_ROLES.slice(0, previousFull.length)).toEqual(previousFull);

    const previousAdmission = [
      "admission-manifest", "replacement-ledger", "source-item", "label-resolution",
      "analysis-context", "human-review-evaluation-spec", "human-review-form",
      "human-review-packet", "human-review-response", "human-review-verdict",
      "reviewer-roster", "review-visibility-receipt", "review-reveal-receipt",
      "operator-assertion",
    ];
    expect(BUNDLE_V4_ADMISSION_EVIDENCE_ROLES.slice(0, previousAdmission.length)).toEqual(previousAdmission);
  });

  test("BINARY_JUDGMENT_ADMISSION_RECORD_ROLES stays a verbatim, hand-kept-in-sync duplicate of the admission-only subset", () => {
    expect(BINARY_JUDGMENT_ADMISSION_RECORD_ROLES).toEqual(BUNDLE_V4_ADMISSION_EVIDENCE_ROLES);
  });

  test("the admission screening instrument stays distinct from a run judge instrument role", () => {
    expect(BUNDLE_V4_EVIDENCE_ROLES).toContain("judge-instrument");
    expect(BUNDLE_V4_ADMISSION_EVIDENCE_ROLES).not.toContain("judge-instrument");
    expect(BUNDLE_V4_ADMISSION_EVIDENCE_ROLES).toContain("screening-instrument");
  });
});

// Item 4 (§6.10 acceptance 3): "the screening model can never be confused with a human verdict",
// on the two axes not already covered above (distinct evidence class is this file's own subject).
describe("the screening model can never be confused with a human verdict (§6.10 acceptance 3)", () => {
  test("distinct record protocol URIs: neither screening protocol is a human-review protocol", () => {
    const screeningProtocols = [SCREENING_TABLE_PROTOCOL, SCREENING_REVEAL_RECEIPT_PROTOCOL];
    const humanProtocols = [HUMAN_REVIEW_REVEAL_RECEIPT_PROTOCOL, HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL];
    for (const screeningProtocol of screeningProtocols) {
      expect(humanProtocols).not.toContain(screeningProtocol);
    }
    // Named explicitly, not just "not equal": a screened bundle's two record protocols must never
    // resolve to either `.../reveal-receipt/v1` (the two-human per-item receipt) or
    // `.../operator-truth-assertion/v1` (the operator-only assertion).
    expect(SCREENING_TABLE_PROTOCOL).not.toBe("https://spec.jinn.network/binary-judgment/reveal-receipt/v1");
    expect(SCREENING_REVEAL_RECEIPT_PROTOCOL).not.toBe("https://spec.jinn.network/binary-judgment/reveal-receipt/v1");
  });

  test("distinct measurement names: a screening row's judgment fields never reuse a human-review verdict's", () => {
    // §6.3: `handVerdict` deliberately does not reuse `BinaryJudgmentTruthLabelSchema` -- the
    // hand-check outcome space is confirm-or-exclude only, with no label corrections. This is the
    // field-name half of that ruling, scoped to the JUDGMENT-bearing fields (not shared identity
    // fields like `itemSha256`, which every admission record carries regardless of mode and which
    // is not what could be mistaken for a human finding): `ScreeningRowSchema`'s own disposition
    // keys (screeningVerdict, handChecked, handVerdict) never collide with
    // `HumanReviewResponseSchema`'s disposition keys (label, complete), or with the measurement
    // names `signHumanReviewResponse` seals onto a human verdict statement (truthLabel,
    // reviewComplete, reviewPacketSha256, visibilityReceiptSha256, responseSha256) -- a screened
    // admission never emits anything spelled "truthLabel" or "label" as a human finding.
    const screeningJudgmentFields = ["screeningVerdict", "handChecked", "handVerdict"] as const;
    const screeningRowFields = new Set(Object.keys(ScreeningRowSchema.shape));
    for (const field of screeningJudgmentFields) expect(screeningRowFields.has(field)).toBe(true);
    const humanJudgmentFields = new Set(["label", "complete"]);
    const humanResponseFields = new Set(Object.keys(HumanReviewResponseSchema.shape));
    for (const field of humanJudgmentFields) expect(humanResponseFields.has(field)).toBe(true);
    const humanVerdictMeasurementNames = new Set([
      "truthLabel", "reviewComplete", "reviewPacketSha256", "visibilityReceiptSha256", "responseSha256",
    ]);
    for (const field of screeningJudgmentFields) {
      expect(humanJudgmentFields.has(field)).toBe(false);
      expect(humanVerdictMeasurementNames.has(field)).toBe(false);
    }
  });
});
