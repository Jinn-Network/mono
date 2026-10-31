// SPDX-License-Identifier: Apache-2.0

/**
 * The two admission signature ports inside `verifyPublicBundleSnapshot` run only on a qualifying
 * bundle, and the conformance kit's golden bundle is not one. These builders turn a copy of it into
 * a `/4` bundle carrying a real, signed admission closure, far enough along for the checker to
 * reach those ports and go one step past them.
 *
 * They are not complete bundles, on purpose. Nothing after the admission replay was re-derived: a
 * correctly signed closure ends at the next refusal, which is what proves the port said yes. A
 * bundle that passes every check needs the product core's producer, which this package cannot
 * depend on.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportStaticBundle } from "@jinn-network/benchmarking-interop";
import {
  BENCHMARKING_METHOD_IDS,
  parseMatrix,
  parseReport,
} from "@jinn-network/benchmarking-records";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
  BinaryJudgmentAnalysisContextSchema,
  BinaryJudgmentLabelResolutionSchema,
  BinaryJudgmentPayloadSchema,
  RESULT_EVALUATION_PREDICATE_TYPE,
  VERDICT_DSSE_PAYLOAD_TYPE,
  canonicalJsonBytes,
  recordDigest,
  sealDocument,
} from "@jinn-network/task-execution-profiles";
import type { z } from "zod";
import {
  BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED,
  HUMAN_REVIEW_FORM_SEALED,
} from "../../admission/application.js";
import {
  BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
  BinaryJudgmentAdmissionManifestSchema,
  HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE,
  HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL,
  HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL,
  HumanReviewOperatorAssertionSchema,
  HumanReviewReplacementLedgerSchema,
} from "../../admission/contracts.js";
import { BUNDLE_V4_FORMAT } from "../../legacy-closures.js";
import {
  BUNDLE_QUALIFICATION_FORMAT,
  BUNDLE_V4_EVIDENCE_FORMAT,
  BUNDLE_V4_EVIDENCE_ROLES,
  BUNDLE_V4_ADMISSION_EVIDENCE_ROLES,
  BUNDLE_V4_TRUST_FORMAT,
  type BundleV4EvidenceRole,
} from "../../schema.js";
import { verdictKeyIdFromEd25519PublicKey } from "../../profile/verdict.js";
import {
  copyGolden,
  memberPaths,
  readJson,
  reseal,
  writeCanonical,
  type JsonObject,
} from "./golden-variants.js";
import {
  kitReportSigner,
  sealSigned,
  signedBy,
  signerFromLabel,
  type DsseSignatures,
  type PinnedSigner,
} from "./signers.js";

type Sha256 = `sha256:${string}`;
type AdmissionRole = (typeof BUNDLE_V4_ADMISSION_EVIDENCE_ROLES)[number];

/** The golden assembly's own draft, which the replay requires the manifest to name. */
const DRAFT_ID = "conformance-golden";
const ADMITTED_AT = "2026-08-20T09:00:00.000Z";
const ITEM_ID = "urn:uuid:00000000-0000-4000-8000-000000000001";
const CANDIDATE_CLASS = "factual";
const STRATUM = "core";
const TRUTH_LABEL = "CORRECT";

const REVIEWER_IDS = ["urn:reviewer:characterization-1", "urn:reviewer:characterization-2"] as const;

const REVIEWERS: readonly PinnedSigner[] = REVIEWER_IDS.map((id) => {
  const signer = signerFromLabel(id);
  return { ...signer, keyId: verdictKeyIdFromEd25519PublicKey(signer.publicKey) };
});

function digestOf(label: string): Sha256 {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

class AdmissionRecords {
  readonly bytes = new Map<Sha256, Uint8Array>();
  readonly roles = new Map<Sha256, Set<AdmissionRole>>();

  put(role: AdmissionRole, bytes: Uint8Array): Sha256 {
    const digest = recordDigest(bytes) as Sha256;
    this.bytes.set(digest, bytes);
    this.roles.set(digest, new Set([...(this.roles.get(digest) ?? []), role]));
    return digest;
  }

  seal<T>(role: AdmissionRole, schema: z.ZodType<T>, value: unknown): { digest: Sha256; value: T } {
    const parsed = schema.parse(value);
    return { digest: this.put(role, sealDocument(parsed as never).bytes), value: parsed };
  }

  /** A role the qualification projection must claim, for a record the replay never reaches. */
  claim(role: AdmissionRole): void {
    const digest = digestOf(`claimed:${role}`);
    this.roles.set(digest, new Set([role]));
  }
}

function sealCommonRecords(records: AdmissionRecords): Sha256 {
  records.put("human-review-evaluation-spec", BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.bytes);
  records.put("human-review-form", HUMAN_REVIEW_FORM_SEALED.bytes);
  const item = records.seal("source-item", BinaryJudgmentPayloadSchema, {
    itemId: ITEM_ID,
    question: "question",
    referenceAnswer: "reference",
    candidateAnswer: "candidate",
    provenance: { sourceCommitment: digestOf("source"), timestamp: "2026-08-01T00:00:00Z" },
    sources: [{ digest: { sha256: digestOf("source").slice("sha256:".length) } }],
  });
  return item.digest;
}

function resolutionCommon(itemSha256: Sha256): JsonObject {
  return {
    protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
    itemSha256,
    itemId: ITEM_ID,
    truthLabel: TRUTH_LABEL,
    candidateClass: CANDIDATE_CLASS,
    stratum: STRATUM,
    resolvedAt: ADMITTED_AT,
    humanReviewEvaluationSpecSha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
  };
}

function sealManifest(
  records: AdmissionRecords,
  itemSha256: Sha256,
  truthAdmission: "two-human-unanimous" | "operator-only",
  resolution: JsonObject,
): { readonly manifest: Sha256; readonly labelResolution: Sha256; readonly analysisContext: Sha256 } {
  const labelResolution = records.seal(
    "label-resolution",
    BinaryJudgmentLabelResolutionSchema,
    resolution,
  ).digest;
  const analysisContext = records.seal("analysis-context", BinaryJudgmentAnalysisContextSchema, {
    protocol: BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
    itemSha256,
    itemId: ITEM_ID,
    labelResolutionSha256: labelResolution,
    truthLabel: TRUTH_LABEL,
    candidateClass: CANDIDATE_CLASS,
    stratum: STRATUM,
  }).digest;
  const ledger = records.seal("replacement-ledger", HumanReviewReplacementLedgerSchema, {
    protocol: HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL,
    draftId: DRAFT_ID,
    entries: [],
    sealedAt: ADMITTED_AT,
  });
  const manifest = records.seal("admission-manifest", BinaryJudgmentAdmissionManifestSchema, {
    protocol: BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
    draftId: DRAFT_ID,
    truthAdmission,
    labelResolutionSha256s: [labelResolution],
    analysisContextSha256s: [analysisContext],
    excludedItemSha256s: [],
    replacementLedgerSha256: ledger.digest,
    admittedAt: ADMITTED_AT,
  });
  return { manifest: manifest.digest, labelResolution, analysisContext };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function frozenOrder<T extends string>(roles: Iterable<string>, order: readonly T[]): T[] {
  const held = new Set(roles);
  return order.filter((role) => held.has(role));
}

interface QualifyingBundleInput {
  readonly records: AdmissionRecords;
  readonly itemSha256: Sha256;
  readonly sealed: ReturnType<typeof sealManifest>;
  readonly truthAdmission: "two-human-unanimous" | "operator-only";
  readonly reviewers: readonly PinnedSigner[];
  readonly authorities: readonly string[];
}

/** Rewrites a golden copy into the `/4` closure's grammar around the sealed admission records. */
function qualifyingBundle(input: QualifyingBundleInput): string {
  const { records, itemSha256, sealed, truthAdmission, reviewers, authorities } = input;
  const bundleDir = copyGolden();

  // The closure is bound to the sealed Report's method before any admission record is read.
  const report = readJson(bundleDir, "report.json");
  report["method"] = { ...report["method"], id: BENCHMARKING_METHOD_IDS.binaryInstrument };
  writeCanonical(bundleDir, "report.json", report);
  const staticBundle = exportStaticBundle(
    parseMatrix(new Uint8Array(readFileSync(join(bundleDir, "matrix.json")))),
    [parseReport(new Uint8Array(readFileSync(join(bundleDir, "report.json"))))],
  );
  writeCanonical(bundleDir, "static-bundle.json", staticBundle);

  const carried = [...records.bytes];
  for (const [digest, bytes] of carried) {
    writeFileSync(join(bundleDir, "records", `${digest.slice("sha256:".length)}.bin`), bytes);
  }
  const golden = readJson(bundleDir, "evidence.json")["records"] as { sha256: string; roles: string[] }[];
  writeCanonical(bundleDir, "evidence.json", {
    format: BUNDLE_V4_EVIDENCE_FORMAT,
    records: [
      ...golden.map(({ sha256, roles }) => ({
        sha256,
        roles: frozenOrder<BundleV4EvidenceRole>(roles, BUNDLE_V4_EVIDENCE_ROLES),
      })),
      ...carried.map(([digest]) => ({
        sha256: digest.slice("sha256:".length),
        roles: frozenOrder<BundleV4EvidenceRole>(records.roles.get(digest)!, BUNDLE_V4_EVIDENCE_ROLES),
      })),
    ].sort((left, right) => compareCodeUnits(left.sha256, right.sha256)),
  });

  const trust = readJson(bundleDir, "trust/public-keys.json");
  const reviewerEntries = reviewers.map((signer, index) => ({
    algorithm: "ed25519",
    evaluator: REVIEWER_IDS[index]!,
    keyId: signer.keyId,
    spkiDerBase64: signer.spkiDerBase64,
  }));
  writeCanonical(bundleDir, "trust/public-keys.json", {
    format: BUNDLE_V4_TRUST_FORMAT,
    selfRun: trust["selfRun"],
    report: trust["report"],
    evaluators: [...(trust["evaluators"] as { evaluator: string }[]), ...reviewerEntries]
      .sort((left, right) => compareCodeUnits(left.evaluator, right.evaluator)),
    admission: {
      reviewers: reviewerEntries.map(({ evaluator, keyId }) => ({ evaluator, keyId })),
      authorities: authorities.map((role) => ({ role, keyId: trust["report"]["keyId"] })),
    },
  });

  const reachable = [...records.roles.keys()].sort(compareCodeUnits);
  writeCanonical(bundleDir, "qualification.json", {
    format: BUNDLE_QUALIFICATION_FORMAT,
    claimSchema: "benchmark-product.claim-package/2",
    sourceManifestSha256: digestOf("source-manifest"),
    admissionManifestSha256: sealed.manifest,
    publicationGrade: truthAdmission !== "operator-only",
    truthAdmission,
    candidateClasses: [CANDIDATE_CLASS],
    strata: [STRATUM],
    arms: [
      { armId: "baseline", instrumentSha256: digestOf("instrument:baseline") },
      { armId: "treatment", instrumentSha256: digestOf("instrument:treatment") },
    ],
    items: [{
      taskSha256: digestOf("task"),
      itemSha256,
      labelResolutionSha256: sealed.labelResolution,
      analysisContextSha256: sealed.analysisContext,
    }],
    exclusions: [],
    admissionRecords: reachable.map((sha256) => ({
      sha256,
      roles: frozenOrder(records.roles.get(sha256)!, BUNDLE_V4_ADMISSION_EVIDENCE_ROLES),
    })),
    reachableSha256s: reachable,
  });

  reseal(bundleDir, BUNDLE_V4_FORMAT, [
    ...memberPaths(bundleDir),
    "qualification.json",
    ...carried.map(([digest]) => `records/${digest.slice("sha256:".length)}.bin`),
  ]);
  return bundleDir;
}

/** The product authority's signature over the operator's truth assertion. */
export function operatorOnlyBundle(signatures: DsseSignatures = signedBy(kitReportSigner())): string {
  const records = new AdmissionRecords();
  const itemSha256 = sealCommonRecords(records);
  const authority = kitReportSigner();
  const assertion = HumanReviewOperatorAssertionSchema.parse({
    protocol: HUMAN_REVIEW_OPERATOR_ASSERTION_PROTOCOL,
    itemSha256,
    truthLabel: TRUTH_LABEL,
    assertedBy: authority.keyId,
    assertedAt: ADMITTED_AT,
    attestorKeyId: authority.keyId,
    attestorRole: "operator-truth-attestor",
    limitation: "operator-only-not-publication-grade",
  });
  const operatorAssertionSha256 = records.put("operator-assertion", sealSigned(
    HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE,
    canonicalJsonBytes(assertion),
    signatures,
  ));
  const sealed = sealManifest(records, itemSha256, "operator-only", {
    ...resolutionCommon(itemSha256),
    truthAdmission: "operator-only",
    operatorAssertionSha256,
  });
  return qualifyingBundle({
    records,
    itemSha256,
    sealed,
    truthAdmission: "operator-only",
    reviewers: [],
    authorities: ["operator-truth-attestor"],
  });
}

function sealReview(evaluatorId: string, signatures: DsseSignatures): Uint8Array {
  return sealSigned(VERDICT_DSSE_PAYLOAD_TYPE, canonicalJsonBytes({
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluator: { id: evaluatorId },
      verdict: "pass",
      evaluationSpecification: {
        digest: {
          sha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest.slice("sha256:".length),
        },
      },
      evaluatedAt: ADMITTED_AT,
    },
  }), signatures);
}

/** The two-human grammar requires these roles, and the replay stops at the verdicts before them. */
const UNREACHED_HUMAN_ROLES = [
  "human-review-packet",
  "human-review-response",
  "reviewer-roster",
  "review-visibility-receipt",
  "review-reveal-receipt",
] as const;

export interface TwoHumanBundleOptions {
  /** How each reviewer's verdict is signed. Defaults to that reviewer's own key. */
  readonly signatures?: (reviewer: PinnedSigner) => DsseSignatures;
  /** The evaluator each verdict names. Defaults to that reviewer's own identity. */
  readonly evaluatorId?: (index: number) => string;
}

/** Two reviewers' signed verdicts over one item. */
export function twoHumanBundle(options: TwoHumanBundleOptions = {}): string {
  const records = new AdmissionRecords();
  const itemSha256 = sealCommonRecords(records);
  const reviewVerdictSha256s = REVIEWERS
    .map((reviewer, index) => records.put("human-review-verdict", sealReview(
      options.evaluatorId?.(index) ?? REVIEWER_IDS[index]!,
      options.signatures?.(reviewer) ?? signedBy(reviewer),
    )))
    .sort(compareCodeUnits);
  for (const role of UNREACHED_HUMAN_ROLES) records.claim(role);
  const sealed = sealManifest(records, itemSha256, "two-human-unanimous", {
    ...resolutionCommon(itemSha256),
    truthAdmission: "two-human-unanimous",
    reviewVerdictSha256s,
    reviewerRosterSha256: digestOf("claimed:reviewer-roster"),
    visibilityReceiptSha256s: [digestOf("visibility:1"), digestOf("visibility:2")].sort(compareCodeUnits),
    revealReceiptSha256: digestOf("claimed:review-reveal-receipt"),
  });
  return qualifyingBundle({
    records,
    itemSha256,
    sealed,
    truthAdmission: "two-human-unanimous",
    reviewers: REVIEWERS,
    authorities: ["roster-attestor", "truth-reveal-attestor"],
  });
}
