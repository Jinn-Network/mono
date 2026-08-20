import { randomUUID, verify as cryptoVerify } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  compareCodeUnitStrings,
  expectedCellSet,
  itemTaskDigest,
  parseBenchmark,
  parseMatrix,
  parseReport,
  parseRun,
  readRunPublicationExtension,
} from "@jinn-network/benchmarking-records";
import { exportStaticBundle } from "@jinn-network/benchmarking-interop";
import { SubmissionRecordSchema } from "@jinn-network/task-execution-protocol";
import {
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  parseBinaryJudgmentAnalysisContext,
  parseBinaryJudgmentInstrument,
  parseEvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes, dssePreAuthEncoding, parseDsseEnvelope } from "@jinn-network/trust-core";
import { refuse } from "../errors.js";
import { parseDraftDocument } from "../domain/draft.js";
import { atomicWriteFileSync, fsyncDirectorySync } from "../fs/atomic.js";
import {
  additionalClaimPackagePath,
  BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
  ClaimPackageSchema,
} from "../report/claim.js";
import { verifyBinaryJudgmentAdmissionClosureInWorkspace } from "../human-review/verification-workspace.js";
import type { AdmissionAuthorityRole, BinaryJudgmentAdmissionRecordRole } from "../human-review/verification.js";
import {
  parseBinaryItemBankIntakeExtension,
} from "../intake/binary-item-bank.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import {
  scanPredictionSnapshotAdmissionReceiptRecords,
  type LocalAdmissionReceiptRecord,
} from "../run/admission-receipts.js";
import { readCancelMarker } from "../run/cancel-marker.js";
import { foldRunJournal, readRunJournalEntries } from "../run/journal.js";
import { readPreviewLog } from "../run/preview-log.js";
import type { RunState } from "../run/state.js";
import { readEvaluatorPublicKeyRecords, readVerdictEnvelope } from "../venue/signing.js";
import { claimPackageArtifactPath, draftPath, publicBundlePath, publicBundlesDir, runCancelMarkerPath } from "../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import { assertWorkspace } from "../workspace/workspace.js";
import { BUNDLE_V4_FORMAT, BUNDLE_V6_FORMAT, buildBundleManifest, verifyBundleManifest } from "./manifest.js";
import { readRunAnchorCarriage } from "../anchor/carriage.js";
import { buildPublicAssets } from "./assets.js";
import {
  BUNDLE_ASSEMBLY_FORMAT,
  BUNDLE_EVIDENCE_FORMAT,
  BUNDLE_EVIDENCE_ROLES,
  BUNDLE_TRUST_FORMAT,
  BUNDLE_VERDICTS_FORMAT,
  BUNDLE_QUALIFICATION_FORMAT,
  BUNDLE_V4_EVIDENCE_FORMAT,
  BUNDLE_V4_EVIDENCE_ROLES,
  BUNDLE_V4_TRUST_FORMAT,
  BundleAssemblyCellSchema,
  BundleAssemblyHeaderSchema,
  BundleEvidenceCatalogSchema,
  BundleQualificationSchema,
  BundleTrustSchema,
  BundleV4EvidenceCatalogSchema,
  BundleV4TrustSchema,
  BundleVerdictCatalogSchema,
  type BundleAssemblyCell,
  type BundleAssemblyHeader,
  type BundleEvidenceCatalog,
  type BundleTrust,
  type BundleV4EvidenceCatalog,
  type BundleV4EvidenceRole,
  type BundleV4Trust,
  type BundleVerdictCatalog,
} from "./schema.js";
import { EVALUATOR_REQUIREMENT_KEY } from "../venue/venue.js";
import { INSPECT_EMBEDDED_EVALUATOR_ID } from "../runtime/inspect/artifacts.js";
import { INSPECT_ADAPTER_ID, InspectSelectionManifestSchema } from "../runtime/inspect/manifest.js";
import {
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  InspectBinaryJudgeSelectionManifestSchema,
  type InspectBinaryJudgeSelectionManifest,
} from "../runtime/inspect/binary-judge-manifest.js";
import { deriveInspectEvaluationStrategy } from "../runtime/inspect/assurance.js";
import { INSPECT_SELECTION_CORRELATION_ROLE } from "../runtime/adapter.js";
import { derivePublicComparison } from "@colophon-claims/verify";

export const PUBLIC_BUNDLE_FILES = [
  "static-bundle.json",
  "benchmark.json",
  "run.json",
  "matrix.json",
  "report.json",
  "report-envelope.json",
  "claim-package.json",
  "verdicts.json",
  "evidence.json",
  "verification/assembly.jsonl",
  "trust/public-keys.json",
  "index.html",
  "badge.svg",
  "social-card.svg",
  "README.md",
  "share.txt",
] as const;

export const PUBLIC_BUNDLE_V4_FILES = [
  ...PUBLIC_BUNDLE_FILES.slice(0, 7),
  "qualification.json",
  ...PUBLIC_BUNDLE_FILES.slice(7),
] as const;

const ROLE_ORDER: readonly BundleV4EvidenceRole[] = BUNDLE_V4_EVIDENCE_ROLES;

function analysisContextDigestFromEvalSpec(spec: ReturnType<typeof parseEvaluationSpec>): string | undefined {
  const block = spec.familyBlock;
  if (typeof block !== "object" || block === null || Array.isArray(block)) return undefined;
  const testMaterial = (block as { readonly testMaterial?: unknown }).testMaterial;
  if (!Array.isArray(testMaterial) || testMaterial.length !== 1) return undefined;
  const entry = testMaterial[0];
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as { readonly name?: unknown; readonly digest?: { readonly sha256?: unknown } };
  if (record.name !== "analysis-context.json" || typeof record.digest?.sha256 !== "string") return undefined;
  if (!/^[a-f0-9]{64}$/u.test(record.digest.sha256)) return undefined;
  return record.digest.sha256;
}

export interface MaterializeBundleInput {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly benchmarkSha256: string;
  readonly runState: RunState;
  /** Packet P5 (spec §8.3 option 5): which sealed Report (and its own Claim) this bundle
   * materializes from, when the run's analysis plan carries more than the canonical entry. Absent
   * selects the canonical `reportSha256`/`reportEnvelopeSha256` pair and the canonical Claim path
   * — byte-identical to every bundle materialized before this field existed. Present selects the
   * matching `(method, version)` sibling from `runState.additionalReports` and that sibling's own
   * Claim path (`report/claim.ts`'s `additionalClaimPackagePath`). */
  readonly reportSelector?: { readonly method: string; readonly version: string };
}

/** Resolves which sealed Report identity pair this bundle materializes from (module header). */
function resolveReportIdentity(
  runState: RunState,
  draftId: string,
  reportSelector: MaterializeBundleInput["reportSelector"],
): { readonly reportSha256: string; readonly reportEnvelopeSha256: string } {
  if (reportSelector === undefined) {
    // Unreachable when the combined presence check above has already refused — kept as a type
    // narrowing, not a new runtime branch.
    return { reportSha256: runState.reportSha256!, reportEnvelopeSha256: runState.reportEnvelopeSha256! };
  }
  const match = (runState.additionalReports ?? []).find(
    (entry) => entry.method === reportSelector.method && entry.version === reportSelector.version,
  );
  if (match === undefined) {
    refuse(
      "conflict",
      `runs.${draftId}.additionalReports`,
      `no additional Report is recorded for "${reportSelector.method}@${reportSelector.version}"`,
    );
  }
  return { reportSha256: match.reportSha256, reportEnvelopeSha256: match.reportEnvelopeSha256 };
}

export interface MaterializeBundleDeps {
  /** Fault-injection hooks used only by crash-safety tests. */
  readonly beforeRename?: () => void;
  readonly afterRename?: () => void;
}

export interface MaterializedBundle {
  readonly bundleDir: string;
  readonly identity: string;
  readonly files: readonly string[];
}

function addRole(
  records: Map<string, Set<BundleV4EvidenceRole>>,
  sha256: string,
  role: BundleV4EvidenceRole,
): void {
  const roles = records.get(sha256) ?? new Set();
  roles.add(role);
  records.set(sha256, roles);
}

/**
 * The evidence-role-to-authority-role mapping for admission trust bindings (spec §6.8a Group
 * B-bis; packet P6 item E). Exported for direct test coverage: this is the specific NEW logic
 * this packet adds to the discriminator below, and it is exercised without needing the full
 * Benchmark/Run/Matrix/Report bundle-materialization fixture.
 *
 * Both screened-branch roles map to `truth-reveal-attestor` — the SAME authority role the
 * per-item reveal receipt already uses (spec §6.6 deliberately reuses the role rather than
 * minting one), which is also §6.8a Group C's frozen third authority set,
 * `["truth-reveal-attestor"]`, exactly.
 */
export function binaryAdmissionEvidenceRoleToAuthorityRole(
  role: Extract<
    BinaryJudgmentAdmissionRecordRole,
    "reviewer-roster" | "review-reveal-receipt" | "operator-assertion" | "screening-table" | "screening-reveal-receipt"
  >,
): AdmissionAuthorityRole {
  switch (role) {
    case "reviewer-roster": return "roster-attestor";
    case "review-reveal-receipt": return "truth-reveal-attestor";
    case "operator-assertion": return "operator-truth-attestor";
    case "screening-table": return "truth-reveal-attestor";
    case "screening-reveal-receipt": return "truth-reveal-attestor";
    default: {
      const exhaustive: never = role;
      throw new Error(`unsupported admission evidence role ${String(exhaustive)}`);
    }
  }
}

function nodeCode(cause: unknown): string | undefined {
  return cause !== null && typeof cause === "object" && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : undefined;
}

function byteIndexOf(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function exactJson<T>(bytes: Uint8Array, schema: { parse(value: unknown): T }, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("record-integrity", label, `${label} is not valid UTF-8 JSON`);
  }
  return schema.parse(parsed);
}

function recordClosure(input: MaterializeBundleInput): {
  readonly files: Map<string, Uint8Array>;
  readonly evidenceRecords: Map<string, Set<BundleV4EvidenceRole>>;
  readonly format:
    | "benchmark-product-public-bundle/2"
    | typeof BUNDLE_V4_FORMAT
    | typeof BUNDLE_V6_FORMAT;
} {
  const { workspaceDir, draftId, benchmarkSha256, runState, reportSelector } = input;
  if (
    runState.runSha256 === undefined
    || runState.matrixSha256 === undefined
    || runState.reportedAt === undefined
    || (reportSelector === undefined && (runState.reportSha256 === undefined || runState.reportEnvelopeSha256 === undefined))
  ) {
    refuse("conflict", `runs.${draftId}`, "reported run is missing its Run, Matrix, Report, or Report envelope identity");
  }
  const { reportSha256, reportEnvelopeSha256 } = resolveReportIdentity(runState, draftId, reportSelector);

  const benchmarkBytes = getSealedBytes(workspaceDir, benchmarkSha256);
  const runBytes = getSealedBytes(workspaceDir, runState.runSha256);
  const matrixBytes = getSealedBytes(workspaceDir, runState.matrixSha256);
  const reportBytes = getSealedBytes(workspaceDir, reportSha256);
  const reportEnvelopeBytes = getSealedBytes(workspaceDir, reportEnvelopeSha256);
  const benchmark = parseBenchmark(benchmarkBytes);
  const run = parseRun(runBytes);
  const matrix = parseMatrix(matrixBytes);
  const report = parseReport(reportBytes);
  const draft = parseDraftDocument(JSON.parse(readFileSync(draftPath(workspaceDir, draftId), "utf8")));
  const genericInspectRuntime = draft.spec.evaluationRuntime?.adapterId === INSPECT_ADAPTER_ID;
  const binaryInspectRuntime = draft.spec.evaluationRuntime?.adapterId === INSPECT_BINARY_JUDGE_ADAPTER_ID;
  const inspectRuntime = genericInspectRuntime || binaryInspectRuntime;
  const separateInspectVerifier = genericInspectRuntime
    && deriveInspectEvaluationStrategy(run.policy.evaluation) === "separate-log-verification";
  const inspectSelectionSha256 = inspectRuntime
    ? draft.spec.evaluationRuntime?.selectionManifestSha256
    : undefined;
  // Captured when this run is the binary-judge runtime, so the probe's digest (if any) is
  // available where roles are assembled below without re-parsing the selection bytes.
  let binaryInspectSelection: InspectBinaryJudgeSelectionManifest | undefined;
  if (inspectRuntime) {
    if (inspectSelectionSha256 === undefined) {
      refuse("record-integrity", "evidence-closure", "Inspect draft has no sealed runtime selection identity");
    }
    const registeredSelections = readRunPublicationExtension(run as unknown as Record<string, unknown>)
      ?.registrationArtifacts.filter((artifact) => artifact.role === INSPECT_SELECTION_CORRELATION_ROLE) ?? [];
    if (
      registeredSelections.length !== 1
      || registeredSelections[0]!.artifact.mediaType !== "application/json"
      || registeredSelections[0]!.artifact.digest.sha256 !== inspectSelectionSha256
    ) {
      refuse("record-integrity", "evidence-closure", "draft Inspect selection differs from the selection frozen in Run registration");
    }
    const selectionBytes = getSealedBytes(workspaceDir, inspectSelectionSha256);
    if (binaryInspectRuntime) {
      binaryInspectSelection = exactJson(
        selectionBytes,
        InspectBinaryJudgeSelectionManifestSchema,
        `records/${inspectSelectionSha256}.bin`,
      );
    } else {
      exactJson(selectionBytes, InspectSelectionManifestSchema, `records/${inspectSelectionSha256}.bin`);
    }
  }

  const claimPath = reportSelector === undefined
    ? claimPackageArtifactPath(workspaceDir, draftId)
    : additionalClaimPackagePath(workspaceDir, draftId, reportSelector.method, reportSelector.version);
  const claimBytes = new Uint8Array(readFileSync(claimPath));
  const claim = exactJson(claimBytes, ClaimPackageSchema, "claim-package.json");
  if (!Buffer.from(canonicalJsonBytes(claim)).equals(Buffer.from(claimBytes))) {
    refuse("record-integrity", "claim-package.json", "claim package is not in exact canonical JSON encoding");
  }
  const binaryQualification = claim.claimSchema === BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID;
  if (binaryQualification !== (report.method.id === BENCHMARKING_METHOD_IDS.binaryInstrument)) {
    refuse("record-integrity", "claim-package.json", "claim schema and sealed Report method disagree on binary qualification");
  }
  if (binaryQualification) {
    const reportSubjects = (report.results as { readonly perSubject?: readonly { readonly subjectSha256?: unknown; readonly results?: unknown }[] }).perSubject;
    if (
      report.method.version !== BENCHMARKING_METHOD_VERSION
      || claim.method.id !== report.method.id
      || claim.method.version !== report.method.version
      || claim.records.benchmarkSha256 !== benchmarkSha256
      || claim.records.runSha256 !== runState.runSha256
      || claim.records.matrixSha256 !== runState.matrixSha256
      || claim.records.reportSha256 !== reportSha256
      || claim.records.reportEnvelopeSha256 !== reportEnvelopeSha256
      || reportSubjects?.length !== 1
      || reportSubjects[0]?.subjectSha256 !== runState.matrixSha256
      || !Buffer.from(canonicalJsonBytes(reportSubjects[0]?.results as never)).equals(
        Buffer.from(canonicalJsonBytes(claim.qualification as never)),
      )
    ) {
      refuse("record-integrity", "claim-package.json", "claim-package/2 must exactly project the sealed binary-instrument@1 Report result");
    }
  }

  // ── The anchored closure (anchor-evidence design §7.4) ─────────────────────────────────────
  //
  // `anchors/<recordSha256>.bin` carries each recorded AnchorEvidence record's exact sealed bytes.
  // The claim's own `anchors` section must be exactly the projection of those bytes: the section is
  // sealed into the claim at `report` time, so a mismatch means the two disagree about what this
  // run is anchored by, and publishing either one over the other would put a claim in front of a
  // reader that its own carried evidence does not back.
  const anchorCarriage = readRunAnchorCarriage(workspaceDir, runState);
  const anchored = anchorCarriage.anchoredClosure;
  if (anchored && binaryQualification) {
    refuse(
      "conflict",
      "anchors",
      "the anchored binary-qualification closure is a later allocation; this run carries both a"
      + " binary qualification projection and an anchor, and no closure version expresses both",
    );
  }
  // Presence is compared, not only contents: an unanchored claim inside an anchored closure is
  // exactly as wrong as an anchored claim whose section drifted, and an omitted section is not an
  // empty one.
  const storedAnchors = (claim as { readonly anchors?: readonly unknown[] }).anchors;
  const expectedAnchors = anchored ? anchorCarriage.anchors : undefined;
  if (!Buffer.from(canonicalJsonBytes({ anchors: storedAnchors ?? null } as never)).equals(
    Buffer.from(canonicalJsonBytes({ anchors: expectedAnchors ?? null } as never)),
  )) {
    refuse(
      "record-integrity",
      "claim-package.json",
      "the sealed claim's anchors section is not the projection of the anchors this run records"
      + " — an anchor obtained after the run was reported is recorded and audited, but this claim"
      + " predates it and cannot be republished as though it did not",
    );
  }

  const files = new Map<string, Uint8Array>([
    ["benchmark.json", benchmarkBytes],
    ["run.json", runBytes],
    ["matrix.json", matrixBytes],
    ["report.json", reportBytes],
    ["report-envelope.json", reportEnvelopeBytes],
    ["claim-package.json", claimBytes],
    ["static-bundle.json", canonicalJsonBytes(exportStaticBundle(matrix, [report]))],
  ]);
  for (const record of anchorCarriage.records) {
    files.set(`anchors/${record.recordSha256}.bin`, record.bytes);
  }

  const evidenceRecords = new Map<string, Set<BundleV4EvidenceRole>>();
  const admissionReviewerBindings = new Map<string, string>();
  const admissionAuthorityBindings = new Map<"roster-attestor" | "truth-reveal-attestor" | "operator-truth-attestor", string>();
  let binaryAssetQualification: {
    publicationGrade: boolean;
    // Type-only widening (packet P6): matches the already-widened source type at
    // `admission.manifest.truthAdmission`. The screened branch's own materialize.ts logic
    // (evidence-role mapping, authority-binding discriminators) is out of this packet's scope.
    truthAdmission: "two-human-unanimous" | "operator-only" | "screened-operator-sampled";
    sourceManifestSha256: string;
    admissionManifestSha256: string;
    exclusions: readonly unknown[];
    instruments: readonly { armId: string; instrumentSha256: string; promptTemplateSha256: string }[];
  } | undefined;
  if (binaryQualification) {
    const extension = parseBinaryItemBankIntakeExtension(benchmark);
    let admission: ReturnType<typeof verifyBinaryJudgmentAdmissionClosureInWorkspace>;
    try {
      admission = verifyBinaryJudgmentAdmissionClosureInWorkspace({
        workspaceDir,
        admissionManifestSha256: extension.admissionManifestSha256,
        expectedDraftId: draftId,
      });
    } catch (cause) {
      refuse(
        "record-integrity",
        "qualification.admission",
        `binary admission closure does not replay before publication: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (extension.replacementLedgerSha256 !== admission.manifest.replacementLedgerSha256) {
      refuse(
        "record-integrity",
        "qualification.admission",
        "Benchmark intake extension and authenticated admission manifest bind different replacement ledgers",
      );
    }

    for (const [digest, role] of [
      [extension.itemBankSha256, "item-bank"],
      [extension.sourceManifestSha256, "source-manifest"],
      [extension.admissionIndexSha256, "admission-index"],
    ] as const) addRole(evidenceRecords, digest.slice("sha256:".length), role);

    for (const reachable of admission.reachableRecords) {
      const prefixed = reachable.sha256;
      const digest = prefixed.slice("sha256:".length);
      const bytes = getSealedBytes(workspaceDir, digest);
      for (const role of reachable.roles) addRole(evidenceRecords, digest, role);
      if (reachable.roles.includes("human-review-verdict")) {
        const view = readVerdictEnvelope(bytes);
        const envelope = parseDsseEnvelope(bytes);
        const keyId = envelope.signatures[0]?.keyid;
        if (typeof keyId !== "string") refuse("record-integrity", "qualification.trust", `review ${prefixed} has no signer key id`);
        const prior = admissionReviewerBindings.get(view.evaluatorId);
        if (prior !== undefined && prior !== keyId) refuse("record-integrity", "qualification.trust", `reviewer ${view.evaluatorId} uses multiple keys`);
        admissionReviewerBindings.set(view.evaluatorId, keyId);
      } else {
        // Widened spec §6.8a Group B-bis (packet P6): the discriminator the spec calls invisible
        // to both the compiler and the grep sweep, because it switches on nothing and its line
        // carries none of the family's search tokens. Both screened-branch roles are named here
        // explicitly so they contribute an authority binding instead of being silently skipped by
        // `if (role === undefined) continue;` below — which is exactly what made §6.8a's frozen
        // third authority set unreachable before this fix.
        const role = reachable.roles.find((candidate): candidate is Parameters<typeof binaryAdmissionEvidenceRoleToAuthorityRole>[0] =>
          candidate === "reviewer-roster" || candidate === "review-reveal-receipt" || candidate === "operator-assertion"
          || candidate === "screening-table" || candidate === "screening-reveal-receipt");
        if (role === undefined) continue;
        const envelope = parseDsseEnvelope(bytes);
        const keyId = envelope.signatures[0]?.keyid;
        if (typeof keyId !== "string") refuse("record-integrity", "qualification.trust", `${role} has no signer key id`);
        const authorityRole = binaryAdmissionEvidenceRoleToAuthorityRole(role);
        const prior = admissionAuthorityBindings.get(authorityRole);
        if (prior !== undefined && prior !== keyId) refuse("record-integrity", "qualification.trust", `${authorityRole} uses multiple keys`);
        admissionAuthorityBindings.set(authorityRole, keyId);
      }
    }

    const acceptedByItem = new Map(admission.accepted.map((entry) => [entry.itemSha256, entry] as const));
    const qualificationItems = benchmark.items.map((item) => {
      const taskSha256 = itemTaskDigest(item);
      const taskBytes = getSealedBytes(workspaceDir, taskSha256);
      const task = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(taskBytes)) as Record<string, unknown>;
      const itemSha256 = task["network.jinn.binary-judgment.item-sha256"];
      if (typeof itemSha256 !== "string") refuse("record-integrity", "qualification.items", `Task ${taskSha256} has no item commitment`);
      const admitted = acceptedByItem.get(itemSha256 as `sha256:${string}`);
      if (admitted === undefined) refuse("record-integrity", "qualification.items", `Task ${taskSha256} is not in the authenticated admission manifest`);
      return {
        taskSha256: `sha256:${taskSha256}`,
        itemSha256: admitted.itemSha256,
        labelResolutionSha256: admitted.labelResolutionSha256,
        analysisContextSha256: admitted.analysisContextSha256,
      };
    }).sort((left, right) => compareCodeUnitStrings(left.taskSha256, right.taskSha256));
    if (
      qualificationItems.length !== admission.accepted.length
      || new Set(qualificationItems.map((entry) => entry.itemSha256)).size !== admission.accepted.length
    ) {
      refuse("record-integrity", "qualification.items", "Benchmark Tasks do not exactly cover the authenticated accepted admission set");
    }
    const instrumentAssets: { armId: string; instrumentSha256: string; promptTemplateSha256: string }[] = [];
    const arms = run.arms.map((arm) => {
      const instrumentSha256 = arm.pinning[BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY];
      if (typeof instrumentSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(instrumentSha256)) {
        refuse("record-integrity", "qualification.arms", `Run arm ${arm.armId} has no exact judge-instrument pin`);
      }
      addRole(evidenceRecords, instrumentSha256.slice("sha256:".length), "judge-instrument");
      const instrumentBytes = getSealedBytes(workspaceDir, instrumentSha256.slice("sha256:".length));
      const instrument = parseBinaryJudgmentInstrument(instrumentBytes);
      if (!Buffer.from(canonicalJsonBytes(instrument)).equals(Buffer.from(instrumentBytes))) {
        refuse("record-integrity", "qualification.arms", `Run arm ${arm.armId} instrument bytes are not exact canonical profile bytes`);
      }
      instrumentAssets.push({ armId: arm.armId, instrumentSha256, promptTemplateSha256: instrument.promptTemplateSha256 });
      return { armId: arm.armId, instrumentSha256 };
    }).sort((left, right) => compareCodeUnitStrings(left.armId, right.armId));
    const qualification = BundleQualificationSchema.parse({
      format: BUNDLE_QUALIFICATION_FORMAT,
      claimSchema: BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
      sourceManifestSha256: extension.sourceManifestSha256,
      admissionManifestSha256: extension.admissionManifestSha256,
      publicationGrade: admission.publicationGrade,
      truthAdmission: admission.manifest.truthAdmission,
      candidateClasses: admission.classes,
      strata: admission.strata,
      arms,
      items: qualificationItems,
      exclusions: admission.excluded.map((entry) => ({
        itemSha256: entry.itemSha256,
        replacementItemSha256: entry.replacementItemSha256,
        reason: entry.reason,
      })),
      admissionRecords: admission.reachableRecords,
      reachableSha256s: admission.reachableSha256s,
    });
    files.set("qualification.json", canonicalJsonBytes(qualification));
    binaryAssetQualification = {
      publicationGrade: admission.publicationGrade,
      truthAdmission: admission.manifest.truthAdmission,
      sourceManifestSha256: extension.sourceManifestSha256,
      admissionManifestSha256: extension.admissionManifestSha256,
      exclusions: qualification.exclusions,
      instruments: instrumentAssets.sort((left, right) => compareCodeUnitStrings(left.armId, right.armId)),
    };
  }
  const receipts = scanPredictionSnapshotAdmissionReceiptRecords(workspaceDir);
  const benchmarkTaskDigests = new Set(benchmark.items.map((item) => itemTaskDigest(item)));
  for (const item of benchmark.items) {
    const taskSha256 = itemTaskDigest(item);
    addRole(evidenceRecords, taskSha256, "task");
    const task = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(getSealedBytes(workspaceDir, taskSha256))) as {
      evaluation?: { digest?: { sha256?: string } };
      payload?: { selectionManifestSha256?: unknown };
    };
    if (genericInspectRuntime) {
      if (task.payload?.selectionManifestSha256 !== inspectSelectionSha256) {
        refuse("record-integrity", "evidence-closure", `Inspect Task ${taskSha256} does not bind the draft's sealed runtime selection`);
      }
      addRole(evidenceRecords, inspectSelectionSha256!, "runtime-selection");
    }
    const evaluationSpecSha256 = task.evaluation?.digest?.sha256;
    if (evaluationSpecSha256 !== undefined) addRole(evidenceRecords, evaluationSpecSha256, "evaluation-spec");
    if (binaryInspectRuntime && evaluationSpecSha256 !== undefined) {
      let spec: ReturnType<typeof parseEvaluationSpec>;
      try {
        spec = parseEvaluationSpec(getSealedBytes(workspaceDir, evaluationSpecSha256));
      } catch {
        refuse("record-integrity", "evidence-closure", `EvaluationSpec ${evaluationSpecSha256} bytes are invalid`);
      }
      const analysisHex = analysisContextDigestFromEvalSpec(spec);
      if (analysisHex === undefined) {
        refuse("record-integrity", "evidence-closure", `EvaluationSpec ${evaluationSpecSha256} has no analysis-context`);
      }
      addRole(evidenceRecords, analysisHex, "analysis-context");
      const analysis = parseBinaryJudgmentAnalysisContext(getSealedBytes(workspaceDir, analysisHex));
      addRole(evidenceRecords, analysis.labelResolutionSha256.slice("sha256:".length), "label-resolution");
    }
    const receipt = receipts.get(taskSha256);
    if (receipt !== undefined) addRole(evidenceRecords, receipt.sha256, "admission-receipt");
  }
  if (binaryInspectRuntime) {
    addRole(evidenceRecords, inspectSelectionSha256!, "runtime-selection");
    // Family-method additional-analysis bundles are /2 (no qualification.json) but still
    // recompute pairwise-disagreement@1 / paired-majority-delta@1, which resolve arm
    // instruments. The V4 qualification block also addRoles these; the Set is idempotent.
    for (const arm of run.arms) {
      const instrumentSha256 = arm.pinning[BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY];
      if (typeof instrumentSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(instrumentSha256)) {
        refuse("record-integrity", "evidence-closure", `Run arm ${arm.armId} has no exact judge-instrument pin`);
      }
      addRole(evidenceRecords, instrumentSha256.slice("sha256:".length), "judge-instrument");
    }
    // §1.5 rule 5: publish the pre-run snapshot-serving probe as a bundle asset alongside the
    // selection manifest, so a cold verifier reads the same bytes. Present exactly when the
    // sealed selection manifest carries `snapshotProbeSha256`.
    if (binaryInspectSelection?.snapshotProbeSha256 !== undefined) {
      addRole(
        evidenceRecords,
        binaryInspectSelection.snapshotProbeSha256.slice("sha256:".length),
        "snapshot-probe",
      );
    }
  }

  const journal = readRunJournalEntries(workspaceDir, draftId);
  const graph: BundleAssemblyHeader["graph"] = {
    // A workspace is a multi-run CAS. Only receipts reachable from this Benchmark belong in
    // this bundle's exact graph; unrelated valid receipts must not leak into its public closure.
    admissions: [...receipts]
      .filter(([taskSha256]) => benchmarkTaskDigests.has(taskSha256))
      .sort(([left], [right]) => compareCodeUnitStrings(left, right))
      .map(([taskSha256, receipt]) => ({ taskSha256, receiptSha256: receipt.sha256 })),
    solveSubmissions: [],
    evaluationSubmissions: [],
    solveDeliveries: [],
    evaluations: [],
  };
  const evaluationEvidenceByVerdict = new Map<string, {
    relationship?: "same-execution-scorer" | "separate-log-verifier";
    evalTaskSha256?: string;
    evalSubmissionSha256?: string;
    evalDeliverySha256?: string;
    evalAttempt?: string;
    evalIndex: number;
  }>();
  const pinningBySubmission = new Map<string, string>();
  for (const entry of journal) {
    if (entry.kind !== "submission-pinning-evidence") continue;
    const key = `${entry.cellKey}:${entry.dispatch}:${entry.submissionSha256}`;
    const prior = pinningBySubmission.get(key);
    if (prior !== undefined && prior !== entry.pinningEvidenceSha256) {
      refuse("record-integrity", "evidence-closure", `solve Submission ${entry.submissionSha256} has conflicting run-pinning evidence`);
    }
    pinningBySubmission.set(key, entry.pinningEvidenceSha256);
  }
  for (const entry of journal) {
    if (entry.kind === "submission-accepted") {
      const isEvaluation = entry.leg === "evaluation";
      addRole(evidenceRecords, entry.submissionSha256, isEvaluation ? "evaluation-submission" : "solve-submission");
      if (!isEvaluation) {
        const enrichedPinning = pinningBySubmission.get(`${entry.cellKey}:${entry.dispatch}:${entry.submissionSha256}`);
        if (entry.pinningEvidenceSha256 !== undefined && enrichedPinning !== undefined && entry.pinningEvidenceSha256 !== enrichedPinning) {
          refuse("record-integrity", "evidence-closure", `solve Submission ${entry.submissionSha256} has conflicting run-pinning evidence`);
        }
        const pinningEvidenceSha256 = entry.pinningEvidenceSha256 ?? enrichedPinning;
        if (pinningEvidenceSha256 !== undefined) {
          addRole(evidenceRecords, pinningEvidenceSha256, "run-pinning-evidence");
        }
        graph.solveSubmissions.push({
          cellKey: entry.cellKey,
          dispatch: entry.dispatch,
          sha256: entry.submissionSha256,
          ...(pinningEvidenceSha256 === undefined
            ? {}
            : { pinningEvidenceSha256 }),
        });
      } else {
        const bytes = getSealedBytes(workspaceDir, entry.submissionSha256);
        let submission: ReturnType<typeof SubmissionRecordSchema.parse>;
        try {
          submission = SubmissionRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        } catch {
          refuse("record-integrity", "evidence-closure", `evaluation Submission ${entry.submissionSha256} is not a valid sealed Submission`);
        }
        const match = /^eval:[a-f0-9]{64}:e([1-9][0-9]*)(?::r([2-9][0-9]*))?:/u.exec(submission.nonce);
        const evalIndex = match === null ? undefined : Number(match[1]);
        const evaluationAttempt = match?.[2] === undefined ? 1 : Number(match[2]);
        const evaluator = submission.requirements?.[EVALUATOR_REQUIREMENT_KEY];
        const evalTaskSha256 = submission.task.digest?.sha256;
        if (
          evalIndex === undefined || !Number.isSafeInteger(evalIndex)
          || typeof evaluator !== "string" || typeof evalTaskSha256 !== "string"
          || !submission.nonce.endsWith(`:${entry.cellKey}:${entry.dispatch}`)
          || (entry.evalIndex !== undefined && entry.evalIndex !== evalIndex)
          || (entry.evaluationAttempt !== undefined && entry.evaluationAttempt !== evaluationAttempt)
        ) {
          refuse("record-integrity", "evidence-closure", `evaluation Submission ${entry.submissionSha256} lacks its exact journal/evaluator/task binding`);
        }
        graph.evaluationSubmissions.push({
          cellKey: entry.cellKey,
          dispatch: entry.dispatch,
          evalIndex,
          ...(evaluationAttempt === 1 ? {} : { evaluationAttempt }),
          evaluator,
          evalTaskSha256,
          sha256: entry.submissionSha256,
        });
      }
    } else if (entry.kind === "delivery") {
      addRole(evidenceRecords, entry.deliverySha256, "solve-delivery");
      for (const output of entry.outputs) {
        addRole(evidenceRecords, output.sha256, "solve-output");
        if (inspectRuntime && output.name === "inspect-log") {
          // Duplicate the authenticated record bytes under Inspect's native extension so the
          // copied bundle opens directly in the pinned Inspect reader and Inspect View.
          files.set(`native/inspect/${output.sha256}.eval`, getSealedBytes(workspaceDir, output.sha256));
        }
      }
      graph.solveDeliveries.push({
        cellKey: entry.cellKey,
        dispatch: entry.dispatch,
        attempt: entry.attempt,
        sha256: entry.deliverySha256,
        outputs: entry.outputs.map((output) => ({ ...output })),
      });
    } else if (entry.kind === "evaluation") {
      const evalIndex = entry.evalIndex ?? 1;
      const evaluationAttempt = entry.evaluationAttempt ?? 1;
      const submission = [...graph.evaluationSubmissions].reverse().find(
        (candidate) => candidate.cellKey === entry.cellKey && candidate.evalIndex === evalIndex
          && (candidate.evaluationAttempt ?? 1) === evaluationAttempt,
      );
      const hasSeparateLineage = entry.evalTaskSha256 !== undefined
        && entry.evalDeliverySha256 !== undefined
        && entry.evalAttempt !== undefined
        && submission !== undefined;
      const hasEmbeddedLineage = inspectRuntime
        && entry.evaluator === INSPECT_EMBEDDED_EVALUATOR_ID
        && entry.evalTaskSha256 === undefined
        && entry.evalDeliverySha256 === undefined
        && entry.evalAttempt === undefined
        && submission === undefined;
      if (entry.verdictSha256 !== undefined && !hasSeparateLineage && !hasEmbeddedLineage) {
        refuse(
          "conflict",
          `runs.${draftId}.evidence-closure`,
          `evaluation evidence for ${entry.cellKey} is neither a complete separate-evaluator lineage nor an Inspect same-execution scorer lineage`,
        );
      }
      if (submission !== undefined && entry.evalTaskSha256 !== undefined && submission.evalTaskSha256 !== entry.evalTaskSha256) {
        refuse("record-integrity", "evidence-closure", `evaluation Submission and journal Task disagree for ${entry.cellKey}/e${evalIndex}`);
      }
      if (entry.evalTaskSha256 !== undefined) addRole(evidenceRecords, entry.evalTaskSha256, "evaluation-task");
      if (entry.evalDeliverySha256 !== undefined) addRole(evidenceRecords, entry.evalDeliverySha256, "evaluation-delivery");
      if (entry.verdictSha256 !== undefined) addRole(evidenceRecords, entry.verdictSha256, "verdict");
      graph.evaluations.push({
        cellKey: entry.cellKey,
        evalIndex,
        ...(evaluationAttempt === 1 ? {} : { evaluationAttempt }),
        ...(hasEmbeddedLineage
          ? { relationship: "same-execution-scorer" as const }
          : hasSeparateLineage && separateInspectVerifier
            ? { relationship: "separate-log-verifier" as const }
            : {}),
        ...(entry.evaluator !== undefined ? { evaluator: entry.evaluator } : {}),
        ...(entry.evalTaskSha256 !== undefined ? { evalTaskSha256: entry.evalTaskSha256 } : {}),
        ...(submission !== undefined ? { evalSubmissionSha256: submission.sha256 } : {}),
        ...(entry.evalAttempt !== undefined ? { evalAttempt: entry.evalAttempt } : {}),
        ...(entry.evalDeliverySha256 !== undefined ? { evalDeliverySha256: entry.evalDeliverySha256 } : {}),
        ...(entry.verdictSha256 !== undefined ? { verdictSha256: entry.verdictSha256 } : {}),
        ...(entry.evaluationTerminal !== undefined ? { evaluationTerminal: entry.evaluationTerminal } : {}),
        // Carry the terminal's operational category into the bundle. `evaluationRetries` already
        // carries the category of every failure that was RETRIED; the failure that exhausted the
        // budget and terminalized the leg has no retry row, so without this member the accounted
        // ungradeable cell publishes as an uncategorized absence. Additive and optional: a run
        // with no categorized could-not-grade terminal seals to identical assembly bytes.
        ...(entry.failureCategory !== undefined ? { failureCategory: entry.failureCategory } : {}),
      });
      if (entry.verdictSha256 !== undefined) {
        evaluationEvidenceByVerdict.set(
          `${entry.cellKey}\0${entry.verdictSha256}\0${evalIndex}`,
          hasEmbeddedLineage
            ? { relationship: "same-execution-scorer", evalIndex }
            : {
              ...(separateInspectVerifier ? { relationship: "separate-log-verifier" as const } : {}),
              evalTaskSha256: entry.evalTaskSha256!,
              evalSubmissionSha256: submission!.sha256,
              evalDeliverySha256: entry.evalDeliverySha256!,
              evalAttempt: entry.evalAttempt!,
              evalIndex,
          },
        );
      }
    } else if (entry.kind === "evaluation-retryable-failure") {
      const submission = [...graph.evaluationSubmissions].reverse().find(
        (candidate) => candidate.cellKey === entry.cellKey && candidate.evalIndex === entry.evalIndex
          && (candidate.evaluationAttempt ?? 1) === entry.evaluationAttempt,
      );
      const retries = graph.evaluationRetries ?? [];
      if (entry.evalTaskSha256 !== undefined) addRole(evidenceRecords, entry.evalTaskSha256, "evaluation-task");
      retries.push({
        cellKey: entry.cellKey,
        dispatch: entry.dispatch,
        evalIndex: entry.evalIndex,
        evaluationAttempt: entry.evaluationAttempt,
        evaluator: entry.evaluator,
        ...(entry.evalTaskSha256 === undefined ? {} : { evalTaskSha256: entry.evalTaskSha256 }),
        ...(submission === undefined ? {} : { evalSubmissionSha256: submission.sha256 }),
        ...(entry.evalAttempt === undefined ? {} : { evalAttempt: entry.evalAttempt }),
        failureCategory: entry.category,
        recoveryAdvice: entry.recoveryAdvice,
        detail: entry.detail,
      });
      graph.evaluationRetries = retries;
    }
  }
  for (const cell of matrix.cells) {
    for (const digest of cell.verdicts) addRole(evidenceRecords, digest.slice("sha256:".length), "verdict");
  }

  // Journal append order is not a public ordering authority. Canonicalize every edge list by
  // its stable graph coordinates so equivalent workspaces always emit identical assembly bytes.
  graph.solveSubmissions.sort((left, right) =>
    compareCodeUnitStrings(left.cellKey, right.cellKey) || left.dispatch - right.dispatch || compareCodeUnitStrings(left.sha256, right.sha256));
  graph.evaluationSubmissions.sort((left, right) =>
    compareCodeUnitStrings(left.cellKey, right.cellKey) || left.evalIndex - right.evalIndex
    || (left.evaluationAttempt ?? 1) - (right.evaluationAttempt ?? 1)
    || left.dispatch - right.dispatch || compareCodeUnitStrings(left.sha256, right.sha256));
  graph.solveDeliveries.sort((left, right) =>
    compareCodeUnitStrings(left.cellKey, right.cellKey) || left.dispatch - right.dispatch || compareCodeUnitStrings(left.sha256, right.sha256));
  graph.evaluations.sort((left, right) =>
    compareCodeUnitStrings(left.cellKey, right.cellKey) || left.evalIndex - right.evalIndex
    || (left.evaluationAttempt ?? 1) - (right.evaluationAttempt ?? 1)
    || compareCodeUnitStrings(left.verdictSha256 ?? "", right.verdictSha256 ?? ""));
  graph.evaluationRetries?.sort((left, right) =>
    compareCodeUnitStrings(left.cellKey, right.cellKey) || left.evalIndex - right.evalIndex
    || left.evaluationAttempt - right.evaluationAttempt);

  const fold = foldRunJournal(journal);
  const assemblyCells: BundleAssemblyCell[] = expectedCellSet(benchmark, run).map((coord) => {
    const cell = fold.get(coord.cellKey);
    const taskBytes = getSealedBytes(workspaceDir, coord.taskDigest);
    const task = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(taskBytes)) as {
      evaluation?: { digest?: { sha256?: string } };
    };
    const receipt = receipts.get(coord.taskDigest);
    const verdicts = (cell?.verdicts ?? []).map((verdict) => {
      const view = readVerdictEnvelope(getSealedBytes(workspaceDir, verdict.sha256));
      const evaluationEvidence = evaluationEvidenceByVerdict.get(`${coord.cellKey}\0${verdict.sha256}\0${verdict.evalIndex ?? 1}`);
      if (evaluationEvidence === undefined) {
        refuse("conflict", `runs.${draftId}.evidence-closure`, `verdict ${verdict.sha256} lacks exact evaluation Task/Delivery linkage`);
      }
      return {
        sha256: verdict.sha256,
        ...evaluationEvidence,
        evaluator: view.evaluatorId,
        verdict: view.verdict,
        evaluationSpecSha256: view.evaluationSpecificationSha256,
        measurements: view.measurements,
      };
    });
    return BundleAssemblyCellSchema.parse({
      kind: "cell",
      cellKey: coord.cellKey,
      armId: coord.armId,
      replicate: coord.replicate,
      taskDigest: coord.taskDigest,
      dispatches: cell?.dispatches ?? 0,
      ...(cell !== undefined && cell.dispatches > 0 ? { accounted: cell.dispatches } : {}),
      ...(cell?.submissionSha256 !== undefined ? { submissionSha256: cell.submissionSha256 } : {}),
      ...(cell?.pinningEvidenceSha256 !== undefined
        ? { pinningEvidenceSha256: cell.pinningEvidenceSha256 }
        : {}),
      ...(cell?.attempt !== undefined ? { attempt: cell.attempt } : {}),
      ...(cell?.deliverySha256 !== undefined ? { deliverySha256: cell.deliverySha256 } : {}),
      ...(cell?.deliveryOutputs !== undefined ? { solveOutputs: cell.deliveryOutputs.map((output) => ({ ...output })) } : {}),
      ...(task.evaluation?.digest?.sha256 !== undefined ? { evaluationSpecSha256: task.evaluation.digest.sha256 } : {}),
      ...(cell?.evaluationTerminal !== undefined ? { evaluationTerminal: cell.evaluationTerminal } : {}),
      ...(receipt !== undefined ? { admission: receipt.fact } : {}),
      ...(receipt !== undefined ? { admissionReceiptSha256: receipt.sha256 } : {}),
      verdicts,
    });
  });
  const cancelMarker = readCancelMarker(workspaceDir, draftId);
  const previewLog = readPreviewLog(workspaceDir, draftId);
  const header = BundleAssemblyHeaderSchema.parse({
    format: BUNDLE_ASSEMBLY_FORMAT,
    kind: "run",
    runCancelled: cancelMarker !== undefined,
    draftId,
    assurancePreset: draft.spec.assurance.preset,
    ...(previewLog !== undefined && previewLog.count > 0
      ? { rehearsal: { previewCount: previewLog.count, timestamps: previewLog.previews.map((preview) => preview.at) } }
      : {}),
    graph,
  });
  const assemblyLines = [
    canonicalJsonBytes(header),
    ...assemblyCells.map((cell) => canonicalJsonBytes(cell)),
  ];
  files.set("verification/assembly.jsonl", Buffer.concat(assemblyLines.map((line) => Buffer.concat([line, Buffer.from("\n")]))));
  if (cancelMarker !== undefined) {
    files.set("verification/cancel-requested.json", new Uint8Array(readFileSync(runCancelMarkerPath(workspaceDir, draftId))));
  }

  const evaluatorRecords = readEvaluatorPublicKeyRecords(workspaceDir);
  const verdictByDigest = new Map<string, { evaluator: string; keyId: string; cellKeys: Set<string> }>();
  for (const matrixCell of matrix.cells) {
    for (const prefixed of matrixCell.verdicts) {
      const digest = prefixed.slice("sha256:".length);
      const envelopeBytes = getSealedBytes(workspaceDir, digest);
      const envelope = parseDsseEnvelope(envelopeBytes);
      const view = readVerdictEnvelope(envelopeBytes);
      const key = evaluatorRecords.get(view.evaluatorId);
      if (key === undefined) refuse("record-integrity", "trust.evaluators", `no public evaluator key for ${view.evaluatorId}`);
      const preAuth = Buffer.from(dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes));
      const valid = envelope.signatures.some((signature) => signature.keyid === key.keyId
        && cryptoVerify(null, preAuth, key.publicKey, Buffer.from(signature.sig, "base64")));
      if (!valid) refuse("record-integrity", "trust.evaluators", `verdict ${digest} is not signed by ${view.evaluatorId}/${key.keyId}`);
      const prior = verdictByDigest.get(digest);
      if (prior !== undefined && (prior.evaluator !== view.evaluatorId || prior.keyId !== key.keyId)) {
        refuse("record-integrity", "verdicts.json", `verdict ${digest} resolves inconsistently`);
      }
      const record = prior ?? { evaluator: view.evaluatorId, keyId: key.keyId, cellKeys: new Set<string>() };
      record.cellKeys.add(matrixCell.cellKey);
      verdictByDigest.set(digest, record);
    }
  }
  const verdictCatalog: BundleVerdictCatalog = BundleVerdictCatalogSchema.parse({
    format: BUNDLE_VERDICTS_FORMAT,
    verdicts: [...verdictByDigest]
      .sort(([left], [right]) => compareCodeUnitStrings(left, right))
      .map(([sha256, value]) => ({
        sha256,
        evaluator: value.evaluator,
        keyId: value.keyId,
        cellKeys: [...value.cellKeys].sort(compareCodeUnitStrings),
      })),
  });
  files.set("verdicts.json", canonicalJsonBytes(verdictCatalog));

  const evidenceCatalog: BundleEvidenceCatalog | BundleV4EvidenceCatalog = binaryQualification
    ? BundleV4EvidenceCatalogSchema.parse({
      format: BUNDLE_V4_EVIDENCE_FORMAT,
      records: [...evidenceRecords]
        .sort(([left], [right]) => compareCodeUnitStrings(left, right))
        .map(([sha256, roles]) => ({ sha256, roles: ROLE_ORDER.filter((role) => roles.has(role)) })),
    })
    : BundleEvidenceCatalogSchema.parse({
    format: BUNDLE_EVIDENCE_FORMAT,
    records: [...evidenceRecords]
      .sort(([left], [right]) => compareCodeUnitStrings(left, right))
      .map(([sha256, roles]) => ({
        sha256,
        roles: BUNDLE_EVIDENCE_ROLES.filter((role) => roles.has(role)),
      }))
      .filter((record) => record.roles.length > 0),
  });
  files.set("evidence.json", canonicalJsonBytes(evidenceCatalog));
  for (const record of evidenceCatalog.records) {
    files.set(`records/${record.sha256}.bin`, getSealedBytes(workspaceDir, record.sha256));
  }

  const reportKey = loadOrCreateReportSigningKey(workspaceDir);
  const workspace = assertWorkspace(workspaceDir);
  const usedEvaluators = [...new Set([
    ...verdictCatalog.verdicts.map((verdict) => verdict.evaluator),
    ...admissionReviewerBindings.keys(),
  ])].sort(compareCodeUnitStrings);
  const trustBase = {
    selfRun: {
      custody: "workspace-minted",
      evaluatorDistinctness: "agent-distinctness-only",
      partyIndependence: "not-established",
    },
    report: {
      author: run.owner,
      keyId: reportKey.keyId,
      didKey: reportKey.keyId,
      algorithm: "ed25519",
      spkiDerBase64: Buffer.from(reportKey.publicKey.export({ type: "spki", format: "der" })).toString("base64"),
      validFrom: workspace.createdAt,
    },
    evaluators: usedEvaluators.map((evaluator) => {
      const key = evaluatorRecords.get(evaluator);
      if (key === undefined) refuse("record-integrity", "trust.evaluators", `no key for evaluator ${evaluator}`);
      return {
        evaluator,
        keyId: key.keyId,
        algorithm: "ed25519" as const,
        spkiDerBase64: Buffer.from(key.publicKey.export({ type: "spki", format: "der" })).toString("base64"),
      };
    }),
  };
  const trust: BundleTrust | BundleV4Trust = binaryQualification
    ? BundleV4TrustSchema.parse({
      format: BUNDLE_V4_TRUST_FORMAT,
      ...trustBase,
      admission: {
        reviewers: [...admissionReviewerBindings]
          .sort(([left], [right]) => compareCodeUnitStrings(left, right))
          .map(([evaluator, keyId]) => ({ evaluator, keyId })),
        authorities: [...admissionAuthorityBindings]
          .sort(([left], [right]) => compareCodeUnitStrings(left, right))
          .map(([role, keyId]) => ({ role, keyId })),
      },
    })
    : BundleTrustSchema.parse({ format: BUNDLE_TRUST_FORMAT, ...trustBase });
  files.set("trust/public-keys.json", canonicalJsonBytes(trust));
  const dissentCellKeys = assemblyCells
    .filter((cell) => new Set(cell.verdicts.map((verdict) => verdict.verdict)).size > 1)
    .map((cell) => cell.cellKey)
    .sort(compareCodeUnitStrings);
  const comparison = binaryQualification ? undefined : derivePublicComparison({
    benchmark,
    matrix,
    assemblyCells,
    recordBytes: new Map(evidenceCatalog.records.map((record) => [
      record.sha256,
      getSealedBytes(workspaceDir, record.sha256),
    ])),
  });
  for (const [path, bytes] of Object.entries(buildPublicAssets({
    claim,
    matrix,
    report,
    reportSha256,
    matrixSha256: runState.matrixSha256,
    recordSha256s: evidenceCatalog.records.map((record) => record.sha256),
    dissentCellKeys,
    comparison,
    ...(binaryAssetQualification === undefined ? {} : { binaryQualification: binaryAssetQualification }),
  }))) {
    files.set(path, bytes);
  }
  return {
    files,
    evidenceRecords,
    // Carrying an anchor is what moves a bundle onto the anchored closure. Everything else emits
    // exactly the version it emitted before this feature existed, byte for byte (§12).
    format: anchored
      ? BUNDLE_V6_FORMAT
      : binaryQualification
        ? BUNDLE_V4_FORMAT
        : "benchmark-product-public-bundle/2",
  };
}

export function materializePublicBundle(
  input: MaterializeBundleInput,
  deps: MaterializeBundleDeps = {},
): MaterializedBundle {
  const parent = publicBundlesDir(input.workspaceDir, input.draftId);
  mkdirSync(parent, { recursive: true });
  const stage = join(parent, `.stage-${randomUUID()}`);
  mkdirSync(stage, { recursive: false });
  let renamed = false;
  try {
    const closure = recordClosure(input);
    const needle = new TextEncoder().encode(input.workspaceDir);
    const paths = [...closure.files.keys()].sort(compareCodeUnitStrings);
    for (const path of paths) {
      const bytes = closure.files.get(path)!;
      if (byteIndexOf(bytes, needle) !== -1) {
        refuse("record-integrity", path, `public bundle file "${path}" contains the private workspace path`);
      }
      atomicWriteFileSync(join(stage, ...path.split("/")), bytes);
    }
    const built = buildBundleManifest(stage, paths, { format: closure.format });
    atomicWriteFileSync(join(stage, "bundle.json"), built.bytes);
    fsyncDirectorySync(stage);
    const target = publicBundlePath(input.workspaceDir, input.draftId, built.identity);
    deps.beforeRename?.();
    try {
      renameSync(stage, target);
      renamed = true;
      fsyncDirectorySync(parent);
    } catch (cause) {
      const code = nodeCode(cause);
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw cause;
      const existing = verifyBundleManifest(target);
      if (existing.identity !== built.identity) {
        refuse("conflict", "bundle.target", "the digest-addressed publication target is occupied by different bytes; refusing to overwrite it");
      }
      deps.afterRename?.();
      return { bundleDir: target, identity: existing.identity, files: existing.manifest.files.map((file) => file.path) };
    }
    deps.afterRename?.();
    return { bundleDir: target, identity: built.identity, files: built.manifest.files.map((file) => file.path) };
  } finally {
    if (!renamed && existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}
