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

describe("evidence role vocabularies (§6.8a Group C)", () => {
  test("BUNDLE_V4_EVIDENCE_ROLES carries both new roles, appended after snapshot-probe", () => {
    const tail = BUNDLE_V4_EVIDENCE_ROLES.slice(-3);
    expect(tail).toEqual(["snapshot-probe", "screening-table", "screening-reveal-receipt"]);
  });

  test("BUNDLE_V4_ADMISSION_EVIDENCE_ROLES carries both new roles, appended after operator-assertion", () => {
    const tail = BUNDLE_V4_ADMISSION_EVIDENCE_ROLES.slice(-3);
    expect(tail).toEqual(["operator-assertion", "screening-table", "screening-reveal-receipt"]);
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

  test("the admission-only subset has no judge-instrument entry, unlike the full list (deliberate, not to be normalized)", () => {
    expect(BUNDLE_V4_EVIDENCE_ROLES).toContain("judge-instrument");
    expect(BUNDLE_V4_ADMISSION_EVIDENCE_ROLES).not.toContain("judge-instrument");
  });
});
