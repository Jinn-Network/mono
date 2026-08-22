// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the judge-model-profile deltas packet P1 owns in this package (spec
 * `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §1.4 and §1.6):
 *
 * - `binaryInstrumentReportLimitations` (this file's module under test) must stop publishing a
 *   false `mutableModelAlias` limitation for a dated-snapshot run and must stop publishing the
 *   two-reviewer-protocol strings for an operator-only run, while leaving every parameter set
 *   valid today byte-identical (§1.4 clauses 2-4).
 * - `InspectBinaryJudgeArmSchema` and `InspectBinaryJudgeSelectionManifestSchema`
 *   (`./binary-judge-manifest.js`) must accept the widened model set, enforce the arm-level
 *   generation/profile agreement, and require/forbid the snapshot-serving probe digest (§1.3,
 *   §1.5).
 * - `BundleQualificationSchema` (`../schema.js`) must accept a six-arm run without moving the
 *   bytes of an existing four-arm document (§1.6).
 *
 * All digests and strings here are synthetic, per the spec's §0.3 license law.
 */

import { describe, expect, test } from "vitest";
import { BINARY_INSTRUMENT_MEASUREMENT_PROFILE } from "@jinn-network/benchmarking-aggregate";
import {
  ACCEPTED_JUDGE_MODEL_IDS,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  type BinaryJudgmentReasoningGeneration,
  type BinaryJudgmentSamplingGeneration,
} from "@jinn-network/task-execution-profiles";
import {
  BINARY_INSTRUMENT_REPORT_LIMITATIONS,
  binaryInstrumentReportLimitations,
} from "./binary-qualification.js";
import { PROMPTED_SCREENING_LIMITATIONS } from "../admission/contracts.js";
import {
  INSPECT_BINARY_JUDGE_INSPECT_EVALS_VERSION,
  INSPECT_BINARY_JUDGE_INSPECT_VERSION,
  INSPECT_BINARY_JUDGE_OCI_PLATFORM,
  INSPECT_BINARY_JUDGE_OPENAI_SDK_VERSION,
  INSPECT_BINARY_JUDGE_PYTHON_VERSION,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  InspectBinaryJudgeArmSchema,
  InspectBinaryJudgeSelectionManifestSchema,
  type InspectBinaryJudgeArm,
} from "./binary-judge-manifest.js";
import { BUNDLE_QUALIFICATION_FORMAT, BundleQualificationSchema } from "../schema.js";

// --- shared synthetic fixtures -------------------------------------------------------------

const REASONING_MODEL = ACCEPTED_JUDGE_MODEL_IDS.find((id) => id === "gpt-5.6-luna")!;
const DATED_SNAPSHOT_MODEL = ACCEPTED_JUDGE_MODEL_IDS.find((id) => id !== "gpt-5.6-luna")!;

const REASONING_GENERATION: BinaryJudgmentReasoningGeneration = {
  reasoningEffort: "none",
  maxOutputTokens: 128,
  store: false,
  background: false,
  stream: false,
  serviceTier: "default",
  tools: [],
  fallbackModels: [],
  retries: 0,
  persistedConversation: false,
  metadata: null,
  promptCacheIdentifier: null,
};

const SAMPLING_GENERATION: BinaryJudgmentSamplingGeneration = {
  temperature: 0,
  maxOutputTokens: 512,
  store: false,
  background: false,
  stream: false,
  serviceTier: "default",
  tools: [],
  fallbackModels: [],
  retries: 0,
  persistedConversation: false,
  metadata: null,
  promptCacheIdentifier: null,
};

function hexDigest(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function shaDigest(seed: number): string {
  return `sha256:${hexDigest(seed)}`;
}

function reasoningArm(armId: string, instrumentSeed: number): InspectBinaryJudgeArm {
  return {
    armId,
    instrumentSha256: shaDigest(instrumentSeed),
    model: REASONING_MODEL,
    generation: REASONING_GENERATION,
  };
}

function datedSnapshotArm(armId: string, instrumentSeed: number): InspectBinaryJudgeArm {
  return {
    armId,
    instrumentSha256: shaDigest(instrumentSeed),
    model: DATED_SNAPSHOT_MODEL,
    generation: SAMPLING_GENERATION,
  };
}

function selectionManifest(arms: readonly InspectBinaryJudgeArm[], snapshotProbeSha256?: string) {
  return {
    schema: INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
    runtime: {
      imageDigest: shaDigest(900001),
      platform: INSPECT_BINARY_JUDGE_OCI_PLATFORM,
      pythonVersion: INSPECT_BINARY_JUDGE_PYTHON_VERSION,
      inspectVersion: INSPECT_BINARY_JUDGE_INSPECT_VERSION,
      inspectEvalsVersion: INSPECT_BINARY_JUDGE_INSPECT_EVALS_VERSION,
      openaiSdkVersion: INSPECT_BINARY_JUDGE_OPENAI_SDK_VERSION,
      runtimeHostSourceSha256: hexDigest(900002),
      workerSourceSha256: hexDigest(900003),
      brokerSourceSha256: hexDigest(900004),
      modelProviderSourceSha256: hexDigest(900005),
    },
    execution: {
      callsPerCell: 1,
      epochs: 1,
      inspectScorer: false,
      retries: 0,
      fallbacks: 0,
      tools: [],
      storage: false,
    },
    requirement: {
      key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
      valueShape: "sha256:<64-lowercase-hex>",
      comparison: "exact",
      location: "submission-effective-requirements",
    },
    arms,
    ...(snapshotProbeSha256 === undefined ? {} : { snapshotProbeSha256 }),
  };
}

/** Minimal valid `BundleQualificationSchema` document with `armCount` distinct arms, using
 * operator-only admission to keep the admission-record closure to its smallest legal shape. */
function bundleQualification(armCount: number, distinctInstruments = armCount) {
  const arms = Array.from({ length: armCount }, (_, index) => ({
    armId: `arm-${String(index + 1).padStart(2, "0")}`,
    instrumentSha256: shaDigest(200000 + (index % distinctInstruments)),
  }));
  const admissionManifestSha256 = shaDigest(1);
  const admissionRecords = [
    { sha256: admissionManifestSha256, roles: ["admission-manifest"] as const },
    { sha256: shaDigest(2), roles: ["replacement-ledger"] as const },
    { sha256: shaDigest(3), roles: ["human-review-evaluation-spec"] as const },
    { sha256: shaDigest(4), roles: ["human-review-form"] as const },
    { sha256: shaDigest(5), roles: ["operator-assertion"] as const },
  ];
  return {
    format: BUNDLE_QUALIFICATION_FORMAT,
    claimSchema: "benchmark-product.claim-package/2" as const,
    sourceManifestSha256: shaDigest(6),
    admissionManifestSha256,
    publicationGrade: false,
    truthAdmission: "operator-only" as const,
    candidateClasses: ["alpha"],
    strata: ["core", "stress"] as const,
    arms,
    items: [],
    exclusions: [],
    admissionRecords,
    reachableSha256s: admissionRecords.map((entry) => entry.sha256),
  };
}

// --- 1-5: binaryInstrumentReportLimitations -------------------------------------------------

describe("binaryInstrumentReportLimitations", () => {
  const base = {
    verdictRule: "sole",
    k: 3,
    reduction: "strict-majority",
    measurementProfile: BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
    candidateClasses: ["alpha", "zeta"],
    strata: ["core", "stress"],
    parserInvalidPolicy: "reject",
    intervalAlpha: "0.05",
  } as const;

  test("1: no judgeModelProfile + two-human-unanimous emits today's three-string bytes", () => {
    const result = binaryInstrumentReportLimitations({ ...base, truthAdmission: "two-human-unanimous" });
    expect(result).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.reviewerKeyPerson,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.cognitiveBlinding,
    ]);
  });

  test("2: reasoning-2026-08 profile is identical to the absent case", () => {
    const result = binaryInstrumentReportLimitations({
      ...base,
      truthAdmission: "two-human-unanimous",
      judgeModelProfile: "reasoning-2026-08",
    });
    expect(result).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.reviewerKeyPerson,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.cognitiveBlinding,
    ]);
  });

  test("3: dated-snapshot-sampling profile drops the alias string, keeps the rest", () => {
    const result = binaryInstrumentReportLimitations({
      ...base,
      truthAdmission: "two-human-unanimous",
      judgeModelProfile: "dated-snapshot-sampling",
    });
    expect(result).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.reviewerKeyPerson,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.cognitiveBlinding,
    ]);
  });

  test("4: operator-only with no profile drops the two reviewer-protocol strings", () => {
    const result = binaryInstrumentReportLimitations({ ...base, truthAdmission: "operator-only" });
    expect(result).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly,
    ]);
  });

  test("5: dated-snapshot + operator-only yields exactly the operator-only string", () => {
    const result = binaryInstrumentReportLimitations({
      ...base,
      truthAdmission: "operator-only",
      judgeModelProfile: "dated-snapshot-sampling",
    });
    expect(result).toEqual([BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly]);
  });

  // --- 6-9: screened-operator-sampled (spec §6.8, §6.8a Group A third bullet; packet P6) --------

  test("6: no judgeModelProfile + screened-operator-sampled emits the alias string and the new screened limitation, not the two-human or operator-only strings", () => {
    const result = binaryInstrumentReportLimitations({ ...base, truthAdmission: "screened-operator-sampled" });
    expect(result).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.screenedNotIndependentlyLabeled,
    ]);
  });

  test("7: dated-snapshot + screened-operator-sampled yields exactly the screened limitation", () => {
    const result = binaryInstrumentReportLimitations({
      ...base,
      truthAdmission: "screened-operator-sampled",
      judgeModelProfile: "dated-snapshot-sampling",
    });
    expect(result).toEqual([BINARY_INSTRUMENT_REPORT_LIMITATIONS.screenedNotIndependentlyLabeled]);
  });

  test("8: the screened limitation is prose, not the spec's kebab identifier (ruling C-1)", () => {
    // §6.8 names the limitation `screened-not-independently-labeled` -- that is its NAME. Every
    // existing entry in this map is a full English sentence, rendered on the public page and
    // byte-compared at cold verification, so the bare kebab token must never be what gets emitted.
    expect(BINARY_INSTRUMENT_REPORT_LIMITATIONS.screenedNotIndependentlyLabeled).not.toBe(
      "screened-not-independently-labeled",
    );
    expect(BINARY_INSTRUMENT_REPORT_LIMITATIONS.screenedNotIndependentlyLabeled).toMatch(/^[A-Z].*[.]$/u);
  });

  test("9: the screened arm is appended after the operator-only arm (ruling C-3): array position for the other three modes is unmoved", () => {
    // The two frozen 144-cell goldens depend on the existing three entries keeping their indices;
    // this only asserts the *other* three modes' output is byte-identical to tests 1-5 above,
    // which is the closest this file can get to that guarantee without re-running the goldens.
    expect(binaryInstrumentReportLimitations({ ...base, truthAdmission: "two-human-unanimous" })).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.reviewerKeyPerson,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.cognitiveBlinding,
    ]);
    expect(binaryInstrumentReportLimitations({ ...base, truthAdmission: "operator-only" })).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly,
    ]);
  });

  test("10: an authenticated prompted-v2 profile appends the exact seal-only capability boundary", () => {
    expect(binaryInstrumentReportLimitations({
      ...base,
      truthAdmission: "screened-operator-sampled",
      promptedScreeningProfile: "prompted-codex-screening/v1",
    })).toEqual([
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.screenedNotIndependentlyLabeled,
      ...PROMPTED_SCREENING_LIMITATIONS,
    ]);
  });

  test("11: legacy screened parameters omit every prompted capability-boundary string", () => {
    const legacy = binaryInstrumentReportLimitations({ ...base, truthAdmission: "screened-operator-sampled" });
    expect(legacy).not.toEqual(expect.arrayContaining([...PROMPTED_SCREENING_LIMITATIONS]));
  });
});

// --- 6: selection manifest -------------------------------------------------------------------

describe("InspectBinaryJudgeSelectionManifestSchema", () => {
  test("6a: two-arm reasoning selection with no snapshotProbeSha256 parses (today's bytes)", () => {
    const manifest = selectionManifest([reasoningArm("arm-a", 1), reasoningArm("arm-b", 2)]);
    expect(InspectBinaryJudgeSelectionManifestSchema.safeParse(manifest).success).toBe(true);
  });

  test("6b: the same reasoning selection WITH a probe digest refuses", () => {
    const manifest = selectionManifest(
      [reasoningArm("arm-a", 1), reasoningArm("arm-b", 2)],
      shaDigest(999),
    );
    expect(InspectBinaryJudgeSelectionManifestSchema.safeParse(manifest).success).toBe(false);
  });

  test("6c: a dated-snapshot selection WITHOUT a probe digest refuses", () => {
    const manifest = selectionManifest([datedSnapshotArm("arm-a", 1), datedSnapshotArm("arm-b", 2)]);
    expect(InspectBinaryJudgeSelectionManifestSchema.safeParse(manifest).success).toBe(false);
  });

  test("6d: a dated-snapshot selection WITH a probe digest parses", () => {
    const manifest = selectionManifest(
      [datedSnapshotArm("arm-a", 1), datedSnapshotArm("arm-b", 2)],
      shaDigest(999),
    );
    expect(InspectBinaryJudgeSelectionManifestSchema.safeParse(manifest).success).toBe(true);
  });

  test("6e: a six-arm reasoning selection parses", () => {
    const arms = Array.from({ length: 6 }, (_, index) => reasoningArm(`arm-${"abcdef"[index]}`, index + 1));
    const manifest = selectionManifest(arms);
    expect(InspectBinaryJudgeSelectionManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

// --- 7: arm schema -----------------------------------------------------------------------------

describe("InspectBinaryJudgeArmSchema", () => {
  test("7a: a dated-snapshot arm carrying a reasoning generation block refuses", () => {
    const arm = { ...datedSnapshotArm("arm-a", 1), generation: REASONING_GENERATION };
    expect(InspectBinaryJudgeArmSchema.safeParse(arm).success).toBe(false);
  });

  test("7b: a reasoning-model arm carrying a sampling generation block refuses", () => {
    const arm = { ...reasoningArm("arm-a", 1), generation: SAMPLING_GENERATION };
    expect(InspectBinaryJudgeArmSchema.safeParse(arm).success).toBe(false);
  });

  test("a correctly paired dated-snapshot arm still parses", () => {
    expect(InspectBinaryJudgeArmSchema.safeParse(datedSnapshotArm("arm-a", 1)).success).toBe(true);
  });

  test("a correctly paired reasoning arm still parses", () => {
    expect(InspectBinaryJudgeArmSchema.safeParse(reasoningArm("arm-a", 1)).success).toBe(true);
  });
});

// --- 8: BundleQualificationSchema arm cardinality -----------------------------------------------

describe("BundleQualificationSchema arm cardinality", () => {
  test("8a: a two-arm qualification document parses", () => {
    expect(BundleQualificationSchema.safeParse(bundleQualification(2)).success).toBe(true);
  });

  test("8b: a six-arm qualification document parses", () => {
    expect(BundleQualificationSchema.safeParse(bundleQualification(6)).success).toBe(true);
  });

  test("8c: a one-arm qualification document refuses", () => {
    expect(BundleQualificationSchema.safeParse(bundleQualification(1)).success).toBe(false);
  });

  test("8d: N arms binding fewer than N distinct instruments refuses", () => {
    const document = bundleQualification(3, 2);
    expect(BundleQualificationSchema.safeParse(document).success).toBe(false);
  });

  test("8e: an existing four-arm qualification document still parses byte-identically", () => {
    const document = bundleQualification(4);
    const result = BundleQualificationSchema.safeParse(document);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(document);
  });
});
