// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for `verifyBinaryJudgmentAdmissionClosure`'s screened-operator-sampled admission path
 * (judge-path program packet P6, spec
 * `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §6.4, §6.5). This is the
 * verifier's independent replay of the five §6.5 recomputations -- coverage, sample membership
 * (via S2's `screening-sample/1`), required hand checks, sample agreement rate, and per-row
 * admission plus ledger closure -- run from the sealed screening table plus the closure's own
 * accepted/excluded item sets, and nothing else.
 *
 * `BinaryJudgmentAdmissionClosurePorts` is the injected boundary (docs/runbooks/testing.md: "Wire
 * a fake"): `resolveExactRecord` reads from an in-memory content-addressed store this file builds,
 * and the two signature ports are permissive fakes that trust every keyId -- what this file tests
 * is the admission LOGIC, not the underlying DSSE/ed25519 machinery, which is exercised elsewhere.
 *
 * All digests are the REAL sha256 of REAL constructed bytes (`recordDigest`/`sealDocument`):
 * `resolve()` re-hashes every resolved record and refuses a mismatch, so placeholder digests
 * cannot be used here the way pure-schema tests use them. Every item id, seed, and string is
 * synthetic, per the spec's §0.3 license law.
 */

import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
  BinaryJudgmentAnalysisContextSchema,
  BinaryJudgmentLabelResolutionSchema,
  BinaryJudgmentPayloadSchema,
  canonicalJsonBytes,
  recordDigest,
  sealDocument,
  type BinaryJudgmentAnalysisContext,
  type BinaryJudgmentLabelResolution,
  type BinaryJudgmentPayload,
} from "@jinn-network/task-execution-profiles";
import { sealDsseEnvelope } from "@jinn-network/trust-core";
import { BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED, HUMAN_REVIEW_FORM_SEALED } from "./application.js";
import {
  BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
  HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE,
  HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL,
  HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL,
  SCREENING_REVEAL_RECEIPT_MEDIA_TYPE,
  SCREENING_REVEAL_RECEIPT_PROTOCOL,
  SCREENING_TABLE_MEDIA_TYPE,
  SCREENING_TABLE_PROTOCOL,
  BinaryJudgmentAdmissionManifestSchema,
  HumanReviewOperatorAssertionSchema,
  HumanReviewReplacementLedgerSchema,
  ScreeningRevealReceiptSchema,
  ScreeningTableSchema,
  type HumanReviewReplacementLedgerEntrySchema,
  type ScreeningRow,
} from "./contracts.js";
import {
  BinaryJudgmentAdmissionClosureError,
  verifyBinaryJudgmentAdmissionClosure,
  type BinaryJudgmentAdmissionClosurePorts,
} from "./verification.js";

// --- fixture kit -------------------------------------------------------------------------------

const DRAFT_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const ADMITTED_AT = "2026-08-20T09:00:00.000Z";
const OPERATOR_KEY = "urn:jinn:key:operator-truth-attestor-1";
const SCREENING_ATTESTOR_KEY = "urn:jinn:key:screening-reveal-attestor-1";

function itemId(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `urn:uuid:00000000-0000-4000-8000-${hex}`;
}

class Store {
  private readonly records = new Map<string, Uint8Array>();

  put(bytes: Uint8Array): `sha256:${string}` {
    const digest = recordDigest(bytes);
    this.records.set(digest, bytes);
    return digest;
  }

  seal<T>(schema: z.ZodType<T>, value: T): { readonly digest: `sha256:${string}`; readonly value: T } {
    const parsed = schema.parse(value);
    const sealed = sealDocument(parsed);
    this.records.set(sealed.digest, sealed.bytes);
    return { digest: sealed.digest, value: parsed };
  }

  sealDsse(payloadBytes: Uint8Array, payloadType: string, keyId: string): `sha256:${string}` {
    const envelopeBytes = sealDsseEnvelope({
      payloadType,
      payloadBytes,
      signatures: [{ keyid: keyId, signature: new Uint8Array([1]) }],
    });
    return this.put(envelopeBytes);
  }

  resolve(digest: `sha256:${string}`): Uint8Array {
    const bytes = this.records.get(digest);
    if (bytes === undefined) throw new Error(`test store: no record for ${digest}`);
    return bytes;
  }

  ports(): BinaryJudgmentAdmissionClosurePorts {
    return {
      resolveExactRecord: (digest) => this.resolve(digest),
      // Permissive fakes (docs/runbooks/testing.md): this suite tests admission LOGIC over an
      // authenticated-boundary interface, not DSSE/ed25519 signature verification itself.
      verifyReviewerSignature: () => true,
      verifyAuthoritySignature: () => true,
    };
  }
}

interface PoolItem {
  readonly itemSha256: `sha256:${string}`;
  readonly itemId: string;
  readonly truthLabel: "CORRECT" | "WRONG";
  readonly candidateClass: string;
  readonly stratum: string;
}

function sealItem(store: Store, seed: number, truthLabel: "CORRECT" | "WRONG"): PoolItem {
  const value: BinaryJudgmentPayload = {
    itemId: itemId(seed),
    question: `question ${seed}`,
    referenceAnswer: `reference ${seed}`,
    candidateAnswer: `candidate ${seed}`,
    provenance: {
      sourceCommitment: `sha256:${seed.toString(16).padStart(64, "0")}`,
      timestamp: "2026-08-01T00:00:00Z",
    },
    sources: [{ digest: { sha256: seed.toString(16).padStart(64, "0") } }],
  };
  const sealed = store.seal(BinaryJudgmentPayloadSchema, value);
  return {
    itemSha256: sealed.digest,
    itemId: sealed.value.itemId,
    truthLabel,
    candidateClass: "factual",
    stratum: "core",
  };
}

function sealAnalysisContext(store: Store, item: PoolItem, labelResolutionSha256: `sha256:${string}`): `sha256:${string}` {
  const value: BinaryJudgmentAnalysisContext = {
    protocol: BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
    itemSha256: item.itemSha256,
    itemId: item.itemId,
    labelResolutionSha256,
    truthLabel: item.truthLabel,
    candidateClass: item.candidateClass,
    stratum: item.stratum,
  };
  return store.seal(BinaryJudgmentAnalysisContextSchema, value).digest;
}

function screeningReveal(store: Store, screeningTableSha256: `sha256:${string}`): `sha256:${string}` {
  const bytes = canonicalJsonBytes(ScreeningRevealReceiptSchema.parse({
    protocol: SCREENING_REVEAL_RECEIPT_PROTOCOL,
    draftId: DRAFT_ID,
    screeningTableSha256,
    truthFrozenAt: ADMITTED_AT,
    judgeExecutionState: "not-started",
    attestedBy: "did:key:zScreeningAttestor",
    attestorKeyId: SCREENING_ATTESTOR_KEY,
    attestorRole: "truth-reveal-attestor",
  }));
  return store.sealDsse(bytes, SCREENING_REVEAL_RECEIPT_MEDIA_TYPE, SCREENING_ATTESTOR_KEY);
}

function sealScreenedResolution(
  store: Store,
  item: PoolItem,
  screeningTableSha256: `sha256:${string}`,
  screeningRevealReceiptSha256: `sha256:${string}`,
): { readonly digest: `sha256:${string}`; readonly analysisContextSha256: `sha256:${string}` } {
  const value: BinaryJudgmentLabelResolution = {
    protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
    itemSha256: item.itemSha256,
    itemId: item.itemId,
    truthLabel: item.truthLabel,
    candidateClass: item.candidateClass,
    stratum: item.stratum,
    resolvedAt: ADMITTED_AT,
    truthAdmission: "screened-operator-sampled",
    screeningTableSha256,
    screeningRevealReceiptSha256,
  };
  const resolution = store.seal(BinaryJudgmentLabelResolutionSchema, value);
  const analysisContextSha256 = sealAnalysisContext(store, item, resolution.digest);
  return { digest: resolution.digest, analysisContextSha256 };
}

function sealOperatorOnlyResolution(store: Store, item: PoolItem): { readonly digest: `sha256:${string}`; readonly analysisContextSha256: `sha256:${string}` } {
  const operatorAssertionSha256 = store.sealDsse(
    canonicalJsonBytes(HumanReviewOperatorAssertionSchema.parse({
      protocol: HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL,
      itemSha256: item.itemSha256,
      truthLabel: item.truthLabel,
      assertedBy: "did:key:zOperator",
      assertedAt: ADMITTED_AT,
      attestorKeyId: OPERATOR_KEY,
      attestorRole: "operator-truth-attestor",
      limitation: "operator-only-not-publication-grade",
    })),
    HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE,
    OPERATOR_KEY,
  );
  const value: BinaryJudgmentLabelResolution = {
    protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
    itemSha256: item.itemSha256,
    itemId: item.itemId,
    humanReviewEvaluationSpecSha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
    truthLabel: item.truthLabel,
    candidateClass: item.candidateClass,
    stratum: item.stratum,
    resolvedAt: ADMITTED_AT,
    truthAdmission: "operator-only",
    operatorAssertionSha256,
  };
  const resolution = store.seal(BinaryJudgmentLabelResolutionSchema, value);
  const analysisContextSha256 = sealAnalysisContext(store, item, resolution.digest);
  return { digest: resolution.digest, analysisContextSha256 };
}

function sealFrozenHumanReviewSpec(store: Store): void {
  store.put(BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.bytes);
  store.put(HUMAN_REVIEW_FORM_SEALED.bytes);
}

interface ScreenedFixtureOptions {
  /** One row per pool item; index-aligned with `items`. */
  readonly rows: readonly Pick<ScreeningRow, "screeningVerdict" | "handChecked" | "handVerdict">[];
  /** Which pool items are ADMITTED (get a label-resolution); the rest are excluded, each
   * replaced by `items[0]` (same class/stratum, so a two-item pool is the minimum viable shape). */
  readonly admittedIndices: readonly number[];
  readonly sampleSeed?: string;
  readonly sampleSize?: number;
  readonly ledgerReasonOverride?: string;
  /** Adds one extra, cleanly-admitted table row for an item that gets neither a label-resolution
   * nor a replacement-ledger entry -- a table naming an item outside the accepted+excluded
   * closure (spec §6.5 check (0)). */
  readonly extraUncoveredRow?: boolean;
}

/** Builds the smallest screened-operator-sampled closure that exercises all five §6.5 checks: two
 * pool items sharing one candidate class/stratum, one accepted (item 0, also the excluded item's
 * replacement) and by default one excluded (item 1). */
function buildScreenedClosure(options: ScreenedFixtureOptions): {
  readonly store: Store;
  readonly manifestSha256: `sha256:${string}`;
  /** The bare, parsed table -- exposed so a test can re-seal it under a different (e.g.
   * non-DSSE) mechanism without reconstructing the object from scratch. */
  readonly tableValue: z.infer<typeof ScreeningTableSchema>;
} {
  const store = new Store();
  sealFrozenHumanReviewSpec(store);

  const items = [sealItem(store, 1, "CORRECT"), sealItem(store, 2, "WRONG")];
  const rows: ScreeningRow[] = items.map((item, index) => ({
    itemSha256: item.itemSha256,
    intendedLabel: item.truthLabel,
    screeningVerdict: options.rows[index]!.screeningVerdict,
    handChecked: options.rows[index]!.handChecked,
    ...(options.rows[index]!.handVerdict === undefined ? {} : { handVerdict: options.rows[index]!.handVerdict }),
  }));
  if (options.extraUncoveredRow === true) {
    const uncovered = sealItem(store, 999, "CORRECT");
    rows.push({
      itemSha256: uncovered.itemSha256,
      intendedLabel: uncovered.truthLabel,
      screeningVerdict: "CORRECT",
      handChecked: true,
      handVerdict: "confirm",
    });
  }
  rows.sort((left, right) => (left.itemSha256 < right.itemSha256 ? -1 : left.itemSha256 > right.itemSha256 ? 1 : 0));

  const samplingScriptSha256 = store.put(new TextEncoder().encode("synthetic sampling script"));
  const rawOutputsSha256 = store.put(new TextEncoder().encode("synthetic raw screening outputs"));
  const tableValue = ScreeningTableSchema.parse({
    protocol: SCREENING_TABLE_PROTOCOL,
    draftId: DRAFT_ID,
    screeningInstrumentSha256: store.put(new TextEncoder().encode("synthetic screening instrument")),
    sampleSeed: options.sampleSeed ?? "synthetic-seed-alpha",
    sampleSize: options.sampleSize ?? rows.length,
    samplingScriptSha256,
    rawOutputsSha256,
    rows,
    sealedAt: ADMITTED_AT,
  });
  // Signed once, DSSE-wrapped on the same sealing path as the other admission records (spec
  // §6.3, final sentence, verbatim; the table schema itself gains no attestorRole field --
  // `sealRoleEvidence` (core/src/operations/human-review.ts:218-233) wraps arbitrary bytes and
  // returns the ENVELOPE digest regardless of payload shape). `screeningTableSha256` therefore
  // names the envelope, exactly like `reviewerRosterSha256`/`revealReceiptSha256` already do.
  const tableDigest = store.sealDsse(canonicalJsonBytes(tableValue), SCREENING_TABLE_MEDIA_TYPE, SCREENING_ATTESTOR_KEY);

  const revealReceiptSha256 = screeningReveal(store, tableDigest);

  const labelResolutionSha256s: `sha256:${string}`[] = [];
  const analysisContextSha256s: `sha256:${string}`[] = [];
  const acceptedByIndex = new Map<number, PoolItem>();
  for (const index of options.admittedIndices) {
    const item = items[index]!;
    const sealed = sealScreenedResolution(store, item, tableDigest, revealReceiptSha256);
    labelResolutionSha256s.push(sealed.digest);
    analysisContextSha256s.push(sealed.analysisContextSha256);
    acceptedByIndex.set(index, item);
  }

  const excludedIndices = items.map((_, index) => index).filter((index) => !options.admittedIndices.includes(index));
  const replacement = acceptedByIndex.get(0) ?? items[0]!;
  const ledgerEntries = excludedIndices.map((index, position) => {
    const excluded = items[index]!;
    const row = rows.find((candidate) => candidate.itemSha256 === excluded.itemSha256)!;
    const agreed = row.screeningVerdict === row.intendedLabel;
    const admitted = row.handChecked ? row.handVerdict === "confirm" : agreed;
    // Flagged (screen disagreed/indeterminate) rows are ALWAYS hand-checked in a passing closure
    // (check 2), so a flagged row's exclusion reason names the screen's own finding regardless of
    // the hand check having run; "screening-hand-excluded" is reserved for the R-3 tie-break
    // alone -- a row the screen AGREED with that the hand check overrode to exclude.
    const derivedReason = admitted
      ? undefined
      : !agreed
        ? (row.screeningVerdict === "indeterminate" ? "screening-indeterminate" : "screening-disagreement")
        : "screening-hand-excluded";
    return {
      excludedItemSha256: excluded.itemSha256,
      replacementItemSha256: replacement.itemSha256,
      candidateClass: excluded.candidateClass,
      stratum: excluded.stratum,
      excludedPoolPosition: index + 1,
      replacementPoolPosition: items.length + position + 1,
      reason: options.ledgerReasonOverride ?? derivedReason ?? "screening-disagreement",
    };
  });

  const ledger = store.seal(HumanReviewReplacementLedgerSchema, {
    protocol: HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL,
    draftId: DRAFT_ID,
    entries: ledgerEntries as unknown as z.infer<typeof HumanReviewReplacementLedgerEntrySchema>[],
    sealedAt: ADMITTED_AT,
  });

  const manifest = store.seal(BinaryJudgmentAdmissionManifestSchema, {
    protocol: BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
    draftId: DRAFT_ID,
    truthAdmission: "screened-operator-sampled",
    labelResolutionSha256s: [...labelResolutionSha256s].sort(),
    analysisContextSha256s: [...analysisContextSha256s].sort(),
    excludedItemSha256s: excludedIndices.map((index) => items[index]!.itemSha256).sort(),
    replacementLedgerSha256: ledger.digest,
    screeningTableSha256: tableDigest,
    admittedAt: ADMITTED_AT,
  });

  return { store, manifestSha256: manifest.digest, tableValue };
}

function refusal(fn: () => void): BinaryJudgmentAdmissionClosureError {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof BinaryJudgmentAdmissionClosureError) return cause;
    throw cause;
  }
  throw new Error("expected verifyBinaryJudgmentAdmissionClosure to refuse");
}

// --- operator-only regression: proves the switch/authorityPayload refactor left this path intact

describe("verifyBinaryJudgmentAdmissionClosure: operator-only (regression for items C/E)", () => {
  test("an operator-only closure with one admitted item still verifies", () => {
    const store = new Store();
    sealFrozenHumanReviewSpec(store);
    const item = sealItem(store, 1, "CORRECT");
    const sealed = sealOperatorOnlyResolution(store, item);
    const ledger = store.seal(HumanReviewReplacementLedgerSchema, {
      protocol: HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL,
      draftId: DRAFT_ID,
      entries: [],
      sealedAt: ADMITTED_AT,
    });
    const manifest = store.seal(BinaryJudgmentAdmissionManifestSchema, {
      protocol: BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
      draftId: DRAFT_ID,
      truthAdmission: "operator-only",
      labelResolutionSha256s: [sealed.digest],
      analysisContextSha256s: [sealed.analysisContextSha256],
      excludedItemSha256s: [],
      replacementLedgerSha256: ledger.digest,
      admittedAt: ADMITTED_AT,
    });

    const result = verifyBinaryJudgmentAdmissionClosure(
      { admissionManifestSha256: manifest.digest, expectedDraftId: DRAFT_ID },
      store.ports(),
    );
    expect(result.publicationGrade).toBe(false);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.truthAdmission).toBe("operator-only");
    expect(result.excluded).toHaveLength(0);
  });
});

// --- screened-operator-sampled: item A's five checks --------------------------------------------

describe("verifyBinaryJudgmentAdmissionClosure: screened-operator-sampled (§6.4, §6.5)", () => {
  test("happy path: one admitted, one excluded-and-replaced (R-3 tie-break), full sample, all hand-checked", () => {
    const { store, manifestSha256 } = buildScreenedClosure({
      rows: [
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "confirm" }, // item 0 (intended CORRECT): admitted
        { screeningVerdict: "WRONG", handChecked: true, handVerdict: "exclude" }, // item 1 (intended WRONG): screen agreed, hand excluded (R-3)
      ],
      admittedIndices: [0],
    });

    const result = verifyBinaryJudgmentAdmissionClosure(
      { admissionManifestSha256: manifestSha256, expectedDraftId: DRAFT_ID },
      store.ports(),
    );

    expect(result.publicationGrade).toBe(true); // Group A fix (item B)
    expect(result.manifest.truthAdmission).toBe("screened-operator-sampled");
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.truthAdmission).toBe("screened-operator-sampled");
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]!.reason).toBe("screening-hand-excluded"); // R-3 tie-break
    expect(result.reachableRecords.some((record) => record.roles.includes("screening-table"))).toBe(true);
    expect(result.reachableRecords.some((record) => record.roles.includes("screening-reveal-receipt"))).toBe(true);
  });

  test("the table is DSSE-sealed (spec §6.3, final sentence): bare canonical table bytes at screeningTableSha256 refuse", () => {
    // §6.9's argument for dropping 240 per-item signatures ("one signature on the whole table")
    // only holds if the table is actually signed once. A bare-canonical-JSON table -- no DSSE
    // envelope, no signature -- is a content commitment, not a signature, and must refuse exactly
    // like a malformed roster or reveal receipt would.
    const { store, manifestSha256, tableValue } = buildScreenedClosure({
      rows: [
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "confirm" },
        { screeningVerdict: "WRONG", handChecked: true, handVerdict: "exclude" },
      ],
      admittedIndices: [0],
    });
    const manifestValue = BinaryJudgmentAdmissionManifestSchema.parse(
      JSON.parse(new TextDecoder().decode(store.resolve(manifestSha256))),
    );
    const bareDigest = store.put(canonicalJsonBytes(tableValue));
    const retampered = store.seal(BinaryJudgmentAdmissionManifestSchema, {
      ...manifestValue,
      screeningTableSha256: bareDigest,
    });

    const error = refusal(() => verifyBinaryJudgmentAdmissionClosure(
      { admissionManifestSha256: retampered.digest, expectedDraftId: DRAFT_ID },
      store.ports(),
    ));
    expect(error.message).toMatch(/DSSE/);
  });

  test("check 0 (coverage): a table row naming an item outside accepted+excluded refuses", () => {
    const { store, manifestSha256 } = buildScreenedClosure({
      rows: [
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "confirm" },
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "confirm" },
      ],
      admittedIndices: [0, 1],
      extraUncoveredRow: true,
    });

    const error = refusal(() => verifyBinaryJudgmentAdmissionClosure(
      { admissionManifestSha256: manifestSha256, expectedDraftId: DRAFT_ID },
      store.ports(),
    ));
    expect(error.message).toMatch(/cover/);
  });

  test("check 2 (required hand checks): a fully-sampled row left un-hand-checked refuses", () => {
    const { store, manifestSha256 } = buildScreenedClosure({
      rows: [
        { screeningVerdict: "CORRECT", handChecked: false }, // sampleSize === rows.length, so this row IS in-sample
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "confirm" },
      ],
      admittedIndices: [0, 1],
    });

    const error = refusal(() => verifyBinaryJudgmentAdmissionClosure(
      { admissionManifestSha256: manifestSha256, expectedDraftId: DRAFT_ID },
      store.ports(),
    ));
    expect(error.message).toMatch(/hand-checked/);
  });

  test("check 3 (sample agreement rate): a mixed sample computes the documented symmetric rate", () => {
    // Item 0: screen CORRECT, intended CORRECT (agreed), hand confirms -> agreed === confirm: match.
    // Item 1: screen CORRECT, intended WRONG (disagreed/flagged), hand confirms -> a screen error
    // (a flagged row the hand confirms): agreed(false) !== confirm(true): NOT a match.
    const { store, manifestSha256 } = buildScreenedClosure({
      rows: [
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "confirm" },
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "confirm" },
      ],
      admittedIndices: [0, 1],
    });

    const result = verifyBinaryJudgmentAdmissionClosure(
      { admissionManifestSha256: manifestSha256, expectedDraftId: DRAFT_ID },
      store.ports(),
    );
    expect(result.screening?.sampleAgreementRate).toBeCloseTo(0.5, 10);
  });

  test("check 4 (per-row admission): an admitted item whose row is not itself admitted refuses", () => {
    // Item 0 is accepted (has a label-resolution) but its row's hand check excludes it --
    // contradiction between the closure's own admitted set and the table's admission rule.
    const { store, manifestSha256 } = buildScreenedClosure({
      rows: [
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "exclude" },
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "confirm" },
      ],
      admittedIndices: [0, 1],
    });

    const error = refusal(() => verifyBinaryJudgmentAdmissionClosure(
      { admissionManifestSha256: manifestSha256, expectedDraftId: DRAFT_ID },
      store.ports(),
    ));
    expect(error.message).toMatch(/admitted/);
  });

  test("check 4 (ledger closure): a ledger reason that does not derive from the row refuses", () => {
    const { store, manifestSha256 } = buildScreenedClosure({
      rows: [
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "confirm" },
        { screeningVerdict: "WRONG", handChecked: true, handVerdict: "exclude" }, // R-3 -> screening-hand-excluded
      ],
      admittedIndices: [0],
      ledgerReasonOverride: "screening-disagreement", // wrong: the row's actual reason is hand-excluded (R-3)
    });

    const error = refusal(() => verifyBinaryJudgmentAdmissionClosure(
      { admissionManifestSha256: manifestSha256, expectedDraftId: DRAFT_ID },
      store.ports(),
    ));
    expect(error.message).toMatch(/reason/);
  });

  test("screeningVerdict indeterminate never agrees: an indeterminate flagged row excludes with reason screening-indeterminate, not screening-hand-excluded", () => {
    // §6.5: "screeningVerdict === 'indeterminate' never agrees", so this row is flagged and (per
    // check 2) must be hand-checked -- but the reason names the screen's own finding
    // (indeterminate), not the mechanical fact that a hand check ran.
    const { store, manifestSha256 } = buildScreenedClosure({
      rows: [
        { screeningVerdict: "CORRECT", handChecked: true, handVerdict: "confirm" },
        { screeningVerdict: "indeterminate", handChecked: true, handVerdict: "exclude" },
      ],
      admittedIndices: [0],
    });
    const result = verifyBinaryJudgmentAdmissionClosure(
      { admissionManifestSha256: manifestSha256, expectedDraftId: DRAFT_ID },
      store.ports(),
    );
    expect(result.excluded[0]!.reason).toBe("screening-indeterminate");
  });

  test("byte-compat: two-human-unanimous and operator-only ledger reasons are untouched by the screened branching", () => {
    // The ledger loop now branches on manifest.truthAdmission; operator-only with zero entries
    // (the only reachable operator-only ledger shape, guarded earlier in the closure) must still
    // verify cleanly through the SAME branch as the regression test above.
    const store = new Store();
    sealFrozenHumanReviewSpec(store);
    const item = sealItem(store, 5, "WRONG");
    const sealed = sealOperatorOnlyResolution(store, item);
    const ledger = store.seal(HumanReviewReplacementLedgerSchema, {
      protocol: HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL,
      draftId: DRAFT_ID,
      entries: [],
      sealedAt: ADMITTED_AT,
    });
    const manifest = store.seal(BinaryJudgmentAdmissionManifestSchema, {
      protocol: BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
      draftId: DRAFT_ID,
      truthAdmission: "operator-only",
      labelResolutionSha256s: [sealed.digest],
      analysisContextSha256s: [sealed.analysisContextSha256],
      excludedItemSha256s: [],
      replacementLedgerSha256: ledger.digest,
      admittedAt: ADMITTED_AT,
    });
    expect(() => verifyBinaryJudgmentAdmissionClosure(
      { admissionManifestSha256: manifest.digest, expectedDraftId: DRAFT_ID },
      store.ports(),
    )).not.toThrow();
  });
});
