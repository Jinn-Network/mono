// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the two new sealed records the screened-operator-sampled admission branch
 * introduces (judge-path program packet P6, spec
 * `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §6.3 and §6.6):
 * `screening-table/v1` (one signed record per bank; §6.3) and `screening-reveal-receipt/v1` (a
 * bank-scoped sibling of the existing per-item `HumanReviewRevealReceiptSchema`; §6.6).
 *
 * Every digest, seed, and item id below is synthetic: `"sha256:" + "<digit>".repeat(64)` patterns,
 * never a real dataset row or third-party judge prompt byte.
 */

import { describe, expect, test } from "vitest";
import {
  SCREENING_REVEAL_RECEIPT_PROTOCOL,
  SCREENING_TABLE_PROTOCOL,
  ScreeningRevealReceiptSchema,
  ScreeningRowSchema,
  ScreeningTableSchema,
} from "./contracts.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const DRAFT_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    itemSha256: digest("1"),
    intendedLabel: "CORRECT",
    screeningVerdict: "CORRECT",
    handChecked: false,
    ...overrides,
  };
}

function table(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    protocol: SCREENING_TABLE_PROTOCOL,
    draftId: DRAFT_ID,
    screeningInstrumentSha256: digest("2"),
    sampleSeed: "synthetic-seed-alpha",
    sampleSize: 1,
    samplingScriptSha256: digest("3"),
    rawOutputsSha256: digest("4"),
    rows: [row()],
    sealedAt: "2026-08-20T09:00:00.000Z",
    ...overrides,
  };
}

describe("ScreeningRowSchema (§6.3)", () => {
  test("accepts a row never hand-checked, with handVerdict absent", () => {
    expect(ScreeningRowSchema.safeParse(row({ handChecked: false })).success).toBe(true);
  });

  test("accepts a hand-checked row with handVerdict present", () => {
    expect(ScreeningRowSchema.safeParse(row({ handChecked: true, handVerdict: "confirm" })).success)
      .toBe(true);
    expect(ScreeningRowSchema.safeParse(row({ handChecked: true, handVerdict: "exclude" })).success)
      .toBe(true);
  });

  test("refuses handChecked=true with handVerdict absent", () => {
    expect(ScreeningRowSchema.safeParse(row({ handChecked: true })).success).toBe(false);
  });

  test("refuses handChecked=false with handVerdict present", () => {
    expect(ScreeningRowSchema.safeParse(row({ handChecked: false, handVerdict: "confirm" })).success)
      .toBe(false);
  });

  test("accepts an indeterminate screeningVerdict", () => {
    expect(ScreeningRowSchema.safeParse(row({ screeningVerdict: "indeterminate" })).success).toBe(true);
  });

  test("does not reuse BinaryJudgmentTruthLabelSchema for handVerdict: CORRECT/WRONG refuse", () => {
    expect(ScreeningRowSchema.safeParse(row({ handChecked: true, handVerdict: "CORRECT" })).success)
      .toBe(false);
    expect(ScreeningRowSchema.safeParse(row({ handChecked: true, handVerdict: "WRONG" })).success)
      .toBe(false);
  });

  test("rejects an unknown field, including screeningModel (deliberately absent)", () => {
    expect(ScreeningRowSchema.safeParse(row({ screeningModel: "gpt-4o-mini-2024-07-18" })).success)
      .toBe(false);
  });
});

describe("ScreeningTableSchema (§6.3)", () => {
  test("accepts the minimal one-row table", () => {
    const result = ScreeningTableSchema.safeParse(table());
    expect(result.success).toBe(true);
  });

  test("refuses an empty rows array", () => {
    expect(ScreeningTableSchema.safeParse(table({ rows: [] })).success).toBe(false);
  });

  test("refuses rows out of itemSha256 order", () => {
    expect(ScreeningTableSchema.safeParse(table({
      rows: [row({ itemSha256: digest("9") }), row({ itemSha256: digest("1") })],
    })).success).toBe(false);
  });

  test("refuses a duplicate itemSha256 across rows", () => {
    expect(ScreeningTableSchema.safeParse(table({
      rows: [row({ itemSha256: digest("1") }), row({ itemSha256: digest("1") })],
    })).success).toBe(false);
  });

  test("accepts multiple rows in strict itemSha256 order", () => {
    expect(ScreeningTableSchema.safeParse(table({
      rows: [row({ itemSha256: digest("1") }), row({ itemSha256: digest("2") })],
    })).success).toBe(true);
  });

  test("refuses sampleSize zero, negative, or non-integer", () => {
    expect(ScreeningTableSchema.safeParse(table({ sampleSize: 0 })).success).toBe(false);
    expect(ScreeningTableSchema.safeParse(table({ sampleSize: -1 })).success).toBe(false);
    expect(ScreeningTableSchema.safeParse(table({ sampleSize: 1.5 })).success).toBe(false);
  });

  test("accepts a positive integer sampleSize", () => {
    expect(ScreeningTableSchema.safeParse(table({ sampleSize: 1 })).success).toBe(true);
  });

  test("refuses an empty sampleSeed", () => {
    expect(ScreeningTableSchema.safeParse(table({ sampleSeed: "" })).success).toBe(false);
  });

  test("rejects an unknown field, including screeningModel (deliberately absent)", () => {
    expect(ScreeningTableSchema.safeParse(table({ screeningModel: "gpt-4o-mini-2024-07-18" })).success)
      .toBe(false);
  });
});

describe("ScreeningRevealReceiptSchema (§6.6)", () => {
  const receipt = {
    protocol: SCREENING_REVEAL_RECEIPT_PROTOCOL,
    draftId: DRAFT_ID,
    screeningTableSha256: digest("5"),
    truthFrozenAt: "2026-08-20T09:00:00.000Z",
    judgeExecutionState: "not-started",
    attestedBy: "did:key:zScreeningAttestor",
    attestorKeyId: "urn:jinn:key:screening-attestor",
    attestorRole: "truth-reveal-attestor",
  };

  test("accepts the exact sibling shape: same ordering primitive, same gate, differing subject", () => {
    expect(ScreeningRevealReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  test("reuses truth-reveal-attestor rather than minting a new role", () => {
    expect(ScreeningRevealReceiptSchema.safeParse({ ...receipt, attestorRole: "roster-attestor" }).success)
      .toBe(false);
  });

  test("refuses any judgeExecutionState other than not-started", () => {
    expect(ScreeningRevealReceiptSchema.safeParse({ ...receipt, judgeExecutionState: "started" }).success)
      .toBe(false);
  });

  test("rejects itemSha256 in place of the bank-scoped screeningTableSha256", () => {
    const { screeningTableSha256: _omitted, ...withoutTable } = receipt;
    expect(ScreeningRevealReceiptSchema.safeParse({ ...withoutTable, itemSha256: digest("5") }).success)
      .toBe(false);
  });

  test("rejects an unknown or missing field", () => {
    expect(ScreeningRevealReceiptSchema.safeParse({ ...receipt, extra: true }).success).toBe(false);
    const { attestedBy: _omitted, ...withoutAttestedBy } = receipt;
    expect(ScreeningRevealReceiptSchema.safeParse(withoutAttestedBy).success).toBe(false);
  });
});
