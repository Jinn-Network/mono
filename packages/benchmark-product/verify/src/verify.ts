import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { verifyReport } from "@jinn-network/benchmarking-aggregate";
import {
  verifyEvidenceNativePortableBundle,
  type EvidenceNativePortableBundleVerification,
  type EvidenceNativeSignatureVerificationInput,
} from "@jinn-network/benchmarking-evidence";
import { exportStaticBundle } from "@jinn-network/benchmarking-interop";
import {
  cellIdempotencyKey,
  expectedCellSet,
  parseBenchmark,
  parseMatrix,
  parseReport,
  parseRun,
  readRunAnchorIntentExtension,
  readRunPublicationExtension,
} from "@jinn-network/benchmarking-records";
import { verifyMatrix, type InScopeCell, type InScopeVerdict } from "@jinn-network/benchmarking-run";
import {
  type AcceptedJudgeModelId,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_PROFILE_URI,
  BinaryJudgmentSnapshotProbeSchema,
  deriveEvaluationTask,
  parseBinaryJudgmentAnalysisContext,
  parseBinaryJudgmentInstrument,
  parseEvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import { DeliveryRecordSchema, SubmissionRecordSchema, TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, dssePreAuthEncoding, parseExactDsseEnvelope } from "@jinn-network/trust-core";
import { refuse } from "./profile/errors.js";
import { ClaimPackageSchema } from "./profile/claim.js";
import { buildMethodPortsFromResolver } from "./profile/ports.js";
import { didKeyFromEd25519PublicKey } from "./profile/signing.js";
import { buildPublicReportTrustDeps } from "./profile/trust.js";
import { buildAssemblyPortsFromFacts, type AssemblyPublicKeyRecord } from "./profile/assembly-ports.js";
import {
  parseRunPinningEvidenceArtifact,
  pinningEvidenceFacts,
  type RunPinningEvidence,
} from "./profile/pinning-evidence.js";
import {
  parsePredictionSnapshotAdmissionReceipt,
  type LocalAdmissionReceiptFact,
} from "./profile/admission-receipts.js";
import { EVALUATOR_REQUIREMENT_KEY } from "./profile/venue.js";
import {
  INSPECT_SELECTION_CORRELATION_ROLE,
  InspectBinaryJudgeSelectionManifestSchema,
} from "./profile/binary-judge-manifest.js";
import {
  readOrderedVerdictMeasurements,
  readVerdictEnvelope,
  verdictKeyIdFromEd25519PublicKey,
} from "./profile/verdict.js";
import {
  INSPECT_EMBEDDED_EVALUATOR_ID,
  InspectCellSummarySchema,
  INSPECT_TASK_PROFILE_URI,
  projectInspectCellVerdict,
  type InspectCellSummary,
} from "./profile/artifacts.js";
import {
  InspectSelectionManifestSchema,
  isInspectMultiScorerSelection,
  type InspectArmConfiguration,
  type InspectSelectionManifest,
} from "./profile/inspect-manifest.js";
import {
  describeInspectRuntimeMethod,
  type InspectRuntimeMethodDisclosure,
} from "./profile/inspect-disclosure.js";
import {
  deriveInspectEvaluationStrategy,
  INSPECT_SEPARATE_ASSURANCE_LIMITATIONS,
  inspectLogVerifierMethod,
} from "./profile/inspect-assurance.js";
import { assertClaimConsistency } from "./profile/claim-consistency.js";
import { buildPublicAssets } from "./assets.js";
import { derivePublicComparison, type PublicComparisonView } from "./comparison.js";
import {
  verifyBundleSnapshot,
  type VerifiedBundleSnapshot,
  type VerifyBundleSnapshotDeps,
} from "./manifest.js";
import { PUBLIC_BUNDLE_FILES, PUBLIC_BUNDLE_V4_FILES } from "./materialize.js";
import { BUNDLE_V4_FORMAT, BUNDLE_V5_FORMAT, BUNDLE_V6_FORMAT } from "./manifest.js";
import {
  evaluateIntegrityAnchors,
  type IntegrityAnchorsReport,
  type PublicBundleAnchorTrustMaterial,
} from "./anchor/check.js";
import { ClaimAnchorProjectionError, deriveClaimAnchors } from "./profile/anchor-claims.js";
import {
  verifyBinaryJudgmentAdmissionClosure,
  type AdmissionAuthorityRole,
  type AdmissionSha256,
} from "./admission/verification.js";
import { readAdmissionVerdictEnvelope } from "./admission/result-evaluation.js";
import {
  BINARY_ITEM_BANK_INTAKE_EXTENSION,
  BinaryAdmissionIndexEntrySchema,
  BinaryItemBankEntrySchema,
  BinaryItemBankIntakeExtensionSchema,
  BinarySourceManifestEntrySchema,
  type BinaryItemBankEntry,
  type BinarySourceManifestEntry,
} from "./admission/intake.js";
import {
  BundleAssemblyCellSchema,
  BundleAssemblyHeaderSchema,
  BundleCancelMarkerSchema,
  BundleEvidenceCatalogSchema,
  BundleQualificationSchema,
  BundleTrustSchema,
  BundleV4EvidenceCatalogSchema,
  BundleV4TrustSchema,
  BundleVerdictCatalogSchema,
  type BundleAssemblyCell,
  type BundleAssemblyHeader,
  type BundleEvidenceCatalog,
  type BundleQualification,
  type BundleV4EvidenceRole,
} from "./schema.js";

export type PublicBundleVerificationCheck =
  | "manifest"
  | "evidence-closure"
  | "trust"
  | "matrix-rederivation"
  | "report-verification"
  | "claim-consistency"
  /** Always present for `benchmark-product-public-bundle/6`, never for any earlier closure
   * (anchor-evidence design §8, §12). */
  | "integrity-anchors";

export interface LegacyPublicBundleVerificationResult {
  readonly format:
    | "benchmark-product-public-bundle/2"
    | "benchmark-product-public-bundle/4"
    | "benchmark-product-public-bundle/6";
  readonly identity: string;
  readonly checks: readonly PublicBundleVerificationCheck[];
  readonly benchmarkSha256: string;
  readonly runSha256: string;
  readonly matrixSha256: string;
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
  readonly runtimeMethod?: InspectRuntimeMethodDisclosure;
  /** Present exactly for the anchored closure: every carried anchor's own outcome plus each
   * subject's context outcome (anchor-evidence design §8). Statuses are disclosed facts, not a
   * summary — nothing here is folded into a single verified badge. */
  readonly anchors?: IntegrityAnchorsReport;
  readonly qualification?: {
    readonly publicationGrade: boolean;
    readonly truthAdmission: "two-human-unanimous" | "operator-only" | "screened-operator-sampled";
    readonly candidateClasses: readonly string[];
    readonly strata: readonly string[];
    // A count that is a constant is not a count (spec §1.6 site 8): a literal here does not
    // refuse a run with a different arm count, it publishes a false one.
    readonly armCount: number;
    readonly itemCount: number;
    readonly exclusionCount: number;
  };
}

export type PublicBundleVerificationResult =
  | LegacyPublicBundleVerificationResult
  | EvidenceNativePortableBundleVerification;

export interface VerifyPublicBundleDeps extends VerifyBundleSnapshotDeps {
  /**
   * Trust material for the `integrity-anchors` check (anchor-evidence design §8 step 3): timestamp
   * authority roots, Bitcoin block headers. **Strictly the verifier operator's own configuration.**
   * This package ships none, so the default outcome for a well-formed proof is `present`, not
   * `verified`; a chain validated solely against roots a bundle carried would re-import the
   * self-run problem with extra ceremony.
   */
  readonly anchorTrust?: PublicBundleAnchorTrustMaterial;
}

/**
 * One semantically verified result bound to the exact authenticated bytes used
 * to derive it. Consumers such as the local reader must serve these bytes
 * rather than reopening bundle paths after verification.
 */
export interface VerifiedPublicBundleSnapshot {
  readonly verification: PublicBundleVerificationResult;
  readonly comparison?: PublicComparisonView;
  readonly snapshot: VerifiedBundleSnapshot;
}

type EvidenceRole = BundleV4EvidenceRole;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function parseJson<T>(bytes: Uint8Array, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, path: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("record-integrity", path, `${path} is not valid UTF-8 JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) refuse("record-integrity", path, `${path} does not satisfy its public bundle schema`);
  return parsed.data;
}

function parseRecord<T>(bytes: Uint8Array, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, path: string): T {
  return parseJson(bytes, schema, path);
}

function requireCanonical<T>(bytes: Uint8Array, value: T, path: string): void {
  if (!equalBytes(bytes, canonicalJsonBytes(value))) refuse("record-integrity", path, `${path} is not the exact canonical encoding`);
}

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

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) refuse("record-integrity", path, `${path} contains duplicate identities`);
}

function publicKey(spkiDerBase64: string, path: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(spkiDerBase64, "base64"), format: "der", type: "spki" });
  } catch {
    refuse("record-integrity", path, `${path} is not a valid SPKI public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") refuse("record-integrity", path, `${path} is not an Ed25519 public key`);
  return key;
}

function parseAssembly(bytes: Uint8Array): { header: BundleAssemblyHeader; cells: BundleAssemblyCell[] } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse("record-integrity", "verification/assembly.jsonl", "assembly JSONL is not valid UTF-8");
  }
  if (!text.endsWith("\n")) refuse("record-integrity", "verification/assembly.jsonl", "assembly JSONL must end with one newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.some((line) => line.length === 0)) {
    refuse("record-integrity", "verification/assembly.jsonl", "assembly JSONL contains an empty line");
  }
  const headerBytes = new TextEncoder().encode(lines[0]!);
  const header = parseJson(headerBytes, BundleAssemblyHeaderSchema, "verification/assembly.jsonl#1");
  requireCanonical(headerBytes, header, "verification/assembly.jsonl#1");
  const cells = lines.slice(1).map((line, index) => {
    const lineBytes = new TextEncoder().encode(line);
    const cell = parseJson(lineBytes, BundleAssemblyCellSchema, `verification/assembly.jsonl#${index + 2}`);
    requireCanonical(lineBytes, cell, `verification/assembly.jsonl#${index + 2}`);
    return cell;
  });
  unique(cells.map((cell) => cell.cellKey), "verification/assembly.jsonl.cellKey");
  return { header, cells };
}

function addRole(expected: Map<string, Set<EvidenceRole>>, digest: string, role: EvidenceRole): void {
  const roles = expected.get(digest) ?? new Set<EvidenceRole>();
  roles.add(role);
  expected.set(digest, roles);
}

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort();
}

function exactCanonicalJsonl<T>(
  bytes: Uint8Array,
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): readonly T[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse("record-integrity", path, `${path} is not UTF-8 canonical JSONL`);
  }
  if (!text.endsWith("\n") || text.includes("\r")) refuse("record-integrity", path, `${path} must end in one LF and contain no CR`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) refuse("record-integrity", path, `${path} contains an empty JSONL row`);
  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      refuse("record-integrity", `${path}#${index + 1}`, "JSONL row is not JSON");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) refuse("record-integrity", `${path}#${index + 1}`, "JSONL row is outside its strict registered schema");
    if (!equalBytes(new TextEncoder().encode(line), canonicalJsonBytes(parsed.data))) {
      refuse("record-integrity", `${path}#${index + 1}`, "JSONL row is not exact canonical JSON");
    }
    return parsed.data;
  });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return equalBytes(canonicalJsonBytes(left as never), canonicalJsonBytes(right as never));
}

function verifyEvidenceNativeSignature(input: EvidenceNativeSignatureVerificationInput): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(input.publicKeyBytes), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" && verifySignature(
      null,
      Buffer.from(input.preAuthEncoding),
      key,
      Buffer.from(input.signature),
    );
  } catch {
    return false;
  }
}

/**
 * The cold verifier's item-bank/source-manifest closure, over already-parsed canonical rows.
 *
 * Exported so the closure can be exercised directly. It has to be: a bundle whose cluster key is
 * decoupled from its declared sources cannot be produced by this repository's own import path,
 * because the importer's code-unit-least rule is strictly stronger than the membership rule below.
 * This check exists for bundles produced by other implementations, so its test has to construct
 * the rows rather than round-trip them through the importer.
 */
export function checkItemBankSourceClosure(
  itemRows: readonly BinaryItemBankEntry[],
  sourceRows: readonly BinarySourceManifestEntry[],
): { readonly itemDigests: ReadonlySet<string> } {
  const itemDigests = new Set<string>();
  const coveredSourceDigests = new Set<string>();
  for (const [index, row] of itemRows.entries()) {
    const item = row.item;
    const digest = `sha256:${sha256(canonicalJsonBytes(item))}`;
    if (itemDigests.has(digest)) refuse("record-integrity", "item-bank.jsonl", "item bank contains duplicate payloads");
    itemDigests.add(digest);
    const itemSourceDigests = new Set<string>();
    for (const descriptor of item.sources) {
      const digestHex = descriptor.digest.sha256;
      itemSourceDigests.add(`sha256:${digestHex}`);
      coveredSourceDigests.add(`sha256:${digestHex}`);
    }
    // Membership only. The cluster key must name one of this item's own declared sources, or a
    // bundle could ship provenance decoupled from the sources it claims to draw on. Deliberately
    // NOT the code-unit-least rule and NOT the timestamp equality: both are enforced once, at
    // import. Membership is a different property, so this is not a second enforcement point.
    if (!itemSourceDigests.has(item.provenance.sourceCommitment)) {
      refuse(
        "record-integrity",
        `item-bank.jsonl.${index + 1}.item.provenance.sourceCommitment`,
        "item provenance sourceCommitment is not one of the item's declared sources",
      );
    }
  }
  // The covered set is derived from `sources` alone. Folding the cluster key in here would let a
  // source row count as used when only a cluster key names it, weakening this exact-equality
  // refusal against an unused source row.
  const sourceDigests = sourceRows.map((row) => row.provenanceSha256);
  if (!sameCanonical([...coveredSourceDigests].sort(), [...sourceDigests].sort())) {
    refuse("record-integrity", "source-manifest.jsonl", "source manifest does not exactly cover item-bank provenance");
  }
  return { itemDigests };
}

/** Verifies a copied public bundle using one authenticated byte snapshot and only bundle-carried
 * public keys. No pathname is reopened after manifest authentication. */
export async function verifyPublicBundleSnapshot(
  bundleDir: string,
  deps: VerifyPublicBundleDeps = {},
): Promise<VerifiedPublicBundleSnapshot> {
  const checked = verifyBundleSnapshot(bundleDir, deps);
  if (checked.manifest.format === BUNDLE_V5_FORMAT) {
    try {
      return {
        verification: await verifyEvidenceNativePortableBundle({
          files: checked.fileBytes,
          verifySignature: verifyEvidenceNativeSignature,
        }),
        snapshot: checked,
      };
    } catch (cause) {
      refuse(
        "record-integrity",
        "evidence-native-bundle",
        cause instanceof Error ? cause.message : "evidence-native bundle verification failed",
      );
    }
  }
  const read = (path: string): Uint8Array => {
    const bytes = checked.fileBytes.get(path);
    if (bytes === undefined) refuse("record-integrity", path, `authenticated bundle snapshot is missing "${path}"`);
    return bytes;
  };
  const checks: PublicBundleVerificationCheck[] = ["manifest"];
  const manifestPaths = new Set(checked.manifest.files.map((file) => file.path));
  const isV4 = checked.manifest.format === BUNDLE_V4_FORMAT;
  // The anchored closure is v2's graph plus `anchors/`, so it takes v2's mandatory member list; the
  // binary qualification projection has its own later anchored allocation and is not this one.
  const isV6 = checked.manifest.format === BUNDLE_V6_FORMAT;
  const mandatoryFiles = isV4 ? PUBLIC_BUNDLE_V4_FILES : PUBLIC_BUNDLE_FILES;
  for (const path of mandatoryFiles) {
    if (!manifestPaths.has(path)) refuse("record-integrity", path, `mandatory public bundle file "${path}" is missing`);
  }

  const evidenceBytes = read("evidence.json");
  const evidence = isV4
    ? parseJson(evidenceBytes, BundleV4EvidenceCatalogSchema, "evidence.json")
    : parseJson(evidenceBytes, BundleEvidenceCatalogSchema, "evidence.json");
  requireCanonical(evidenceBytes, evidence, "evidence.json");
  unique(evidence.records.map((record) => record.sha256), "evidence.json.records");
  for (const record of evidence.records) unique(record.roles, `evidence.json.records.${record.sha256}.roles`);
  const expectedPaths = new Set<string>([
    ...mandatoryFiles,
    ...evidence.records.map((record) => `records/${record.sha256}.bin`),
  ]);
  if (manifestPaths.has("verification/cancel-requested.json")) expectedPaths.add("verification/cancel-requested.json");
  for (const path of manifestPaths) {
    if (/^native\/inspect\/[a-f0-9]{64}\.eval$/u.test(path)) expectedPaths.add(path);
  }
  // `anchors/<sha256>.bin` is allowlisted only by the closure version that defines it: an anchor
  // member in a v2 or v4 bundle is a non-allowlisted file, exactly as it was before this format.
  const anchorPaths: string[] = [];
  if (isV6) {
    for (const path of manifestPaths) {
      if (/^anchors\/[a-f0-9]{64}\.bin$/u.test(path)) {
        expectedPaths.add(path);
        anchorPaths.push(path);
      }
    }
  }
  for (const path of manifestPaths) if (!expectedPaths.has(path)) refuse("record-integrity", path, `public bundle contains non-allowlisted file "${path}"`);
  for (const path of expectedPaths) if (!manifestPaths.has(path)) refuse("record-integrity", path, `public bundle closure is missing "${path}"`);

  const records = new Map<string, Uint8Array>();
  const declaredRoles = new Map<string, ReadonlySet<EvidenceRole>>();
  for (const record of evidence.records) {
    const bytes = read(`records/${record.sha256}.bin`);
    if (sha256(bytes) !== record.sha256) refuse("record-integrity", `records/${record.sha256}.bin`, "evidence record digest mismatch");
    records.set(record.sha256, bytes);
    declaredRoles.set(record.sha256, new Set(record.roles));
  }

  const trustBytes = read("trust/public-keys.json");
  const trust = isV4
    ? parseJson(trustBytes, BundleV4TrustSchema, "trust/public-keys.json")
    : parseJson(trustBytes, BundleTrustSchema, "trust/public-keys.json");
  requireCanonical(trustBytes, trust, "trust/public-keys.json");
  const reportKey = publicKey(trust.report.spkiDerBase64, "trust.report.spkiDerBase64");
  const carriedEvaluatorKeys = new Map(trust.evaluators.map((entry) => [
    entry.evaluator,
    { keyId: entry.keyId, publicKey: publicKey(entry.spkiDerBase64, `trust.evaluators.${entry.evaluator}`) },
  ] as const));

  let qualification: BundleQualification | undefined;
  if (isV4) {
    const qualificationBytes = read("qualification.json");
    qualification = parseJson(qualificationBytes, BundleQualificationSchema, "qualification.json");
    requireCanonical(qualificationBytes, qualification, "qualification.json");
  }

  const benchmarkBytes = read("benchmark.json");
  const runBytes = read("run.json");
  const matrixBytes = read("matrix.json");
  const reportBytes = read("report.json");
  const envelopeBytes = read("report-envelope.json");
  const claimBytes = read("claim-package.json");
  const claim = parseJson(claimBytes, ClaimPackageSchema, "claim-package.json");
  requireCanonical(claimBytes, claim, "claim-package.json");
  let benchmark: ReturnType<typeof parseBenchmark>;
  let run: ReturnType<typeof parseRun>;
  let matrix: ReturnType<typeof parseMatrix>;
  let report: ReturnType<typeof parseReport>;
  try {
    benchmark = parseBenchmark(benchmarkBytes);
    run = parseRun(runBytes);
    matrix = parseMatrix(matrixBytes);
    report = parseReport(reportBytes);
  } catch (cause) {
    refuse("record-integrity", "evidence-closure", `primary benchmark record is invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const identities = {
    benchmarkSha256: sha256(benchmarkBytes),
    runSha256: sha256(runBytes),
    matrixSha256: sha256(matrixBytes),
    reportSha256: sha256(reportBytes),
    reportEnvelopeSha256: sha256(envelopeBytes),
  };
  const staticBytes = read("static-bundle.json");
  if (!equalBytes(staticBytes, canonicalJsonBytes(exportStaticBundle(matrix, [report])))) {
    refuse("record-integrity", "static-bundle.json", "static bundle is not the exact platform metadata projection");
  }

  // ── integrity-anchors (anchor-evidence design §8) ──────────────────────────────────────────
  //
  // Evaluated here, before the claim is rebuilt, because an `invalid` anchor is affirmative
  // evidence of substitution and must be the refusal a reader sees — not a downstream claim
  // mismatch caused by it. Once nothing is invalid, the same bytes project the claim's anchors
  // section through the same function the producer used.
  let anchorReport: IntegrityAnchorsReport | undefined;
  // Supplied to the claim rebuild only for the anchored closure, and then even when empty: an
  // empty section and an omitted one are different claims, and §7.3's declared-but-absent bundle
  // carries the first.
  let claimAnchors: readonly import("./profile/anchor-claims.js").ClaimAnchor[] | undefined;
  if (isV6) {
    const anchorRecords = anchorPaths
      .map((path) => {
        const bytes = read(path);
        const recordSha256 = path.slice("anchors/".length, -".bin".length);
        if (sha256(bytes) !== recordSha256) {
          refuse("record-integrity", path, "anchor record digest mismatch");
        }
        return { recordSha256, bytes };
      });
    anchorReport = evaluateIntegrityAnchors({
      records: anchorRecords,
      runSha256: identities.runSha256,
      matrixSha256: identities.matrixSha256,
      closeAt: run.closeAt,
      declaredProfiles: readRunAnchorIntentExtension(run as unknown as Record<string, unknown>)?.providers ?? [],
      ...(deps.anchorTrust === undefined ? {} : { trust: deps.anchorTrust }),
    });
    const firstInvalid = anchorReport.invalid[0];
    if (firstInvalid !== undefined) {
      refuse(
        "record-integrity",
        `anchors/${firstInvalid.recordSha256}.bin`,
        `carried anchor is invalid: ${firstInvalid.reason ?? "the proof does not verify"}`,
      );
    }
    try {
      claimAnchors = deriveClaimAnchors({
        records: anchorRecords,
        runSha256: identities.runSha256,
        matrixSha256: identities.matrixSha256,
      });
    } catch (cause) {
      if (cause instanceof ClaimAnchorProjectionError) {
        refuse("record-integrity", `anchors/${cause.recordSha256}.bin`, cause.message);
      }
      throw cause;
    }
  }

  const assembly = parseAssembly(read("verification/assembly.jsonl"));
  const expectedNativePaths = new Set(
    assembly.header.graph.solveDeliveries.flatMap((delivery) => delivery.outputs
      .filter((output) => output.name === "inspect-log")
      .map((output) => `native/inspect/${output.sha256}.eval`)),
  );
  const actualNativePaths = new Set([...manifestPaths].filter((path) => path.startsWith("native/inspect/")));
  if (!equalBytes(canonicalJsonBytes(sorted(expectedNativePaths)), canonicalJsonBytes(sorted(actualNativePaths)))) {
    refuse("record-integrity", "native/inspect", "native Inspect log paths do not exactly match the run's delivered artifacts");
  }
  for (const path of expectedNativePaths) {
    const digest = path.slice("native/inspect/".length, -".eval".length);
    const recordBytes = records.get(digest);
    if (recordBytes === undefined || !equalBytes(read(path), recordBytes)) {
      refuse("record-integrity", path, "viewer-ready Inspect log differs from its content-addressed evidence record");
    }
  }
  if (manifestPaths.has("verification/cancel-requested.json")) {
    const cancelBytes = read("verification/cancel-requested.json");
    const cancelMarker = parseJson(cancelBytes, BundleCancelMarkerSchema, "verification/cancel-requested.json");
    requireCanonical(cancelBytes, cancelMarker, "verification/cancel-requested.json");
    if (!assembly.header.runCancelled) refuse("record-integrity", "verification/assembly.jsonl", "cancel marker and assembly cancellation fact disagree");
  } else if (assembly.header.runCancelled) {
    refuse("record-integrity", "verification/cancel-requested.json", "assembly declares cancellation without its public marker");
  }

  const expectedCoordinates = expectedCellSet(benchmark, run);
  if (assembly.cells.length !== expectedCoordinates.length) refuse("record-integrity", "evidence-closure", "assembly does not cover every expected cell");
  const cellsByKey = new Map(assembly.cells.map((cell) => [cell.cellKey, cell]));
  const coordinatesByKey = new Map(expectedCoordinates.map((coord) => [coord.cellKey, coord]));
  const expectedRoles = new Map<string, Set<EvidenceRole>>();
  const evaluationSpecs = new Map<string, ReturnType<typeof parseEvaluationSpec>>();
  const taskSpecs = new Map<string, ReturnType<typeof TaskSpecificationSchema.parse>>();
  const inspectSelections = new Map<string, InspectSelectionManifest>();
  const minVerdicts = run.policy.evaluation?.minVerdicts ?? 1;

  let verifiedAdmission: ReturnType<typeof verifyBinaryJudgmentAdmissionClosure> | undefined;
  let binaryAssetQualification: NonNullable<Parameters<typeof buildPublicAssets>[0]["binaryQualification"]> | undefined;
  if (qualification !== undefined) {
    const v4Trust = BundleV4TrustSchema.parse(trust);
    const ports = {
      resolveExactRecord: (digest: AdmissionSha256): Uint8Array => {
        const bytes = records.get(digest.slice("sha256:".length));
        if (bytes === undefined) throw new Error(`bundle record ${digest} is missing`);
        return bytes;
      },
      verifyReviewerSignature: (input: { envelopeBytes: Uint8Array; evaluatorId: string; keyId: string }): boolean => {
        const key = carriedEvaluatorKeys.get(input.evaluatorId);
        if (key === undefined || key.keyId !== input.keyId) return false;
        try {
          const envelope = parseExactDsseEnvelope(input.envelopeBytes);
          const signature = envelope.signatures[0];
          return envelope.signatures.length === 1 && signature?.keyid === input.keyId
            && verifySignature(
              null,
              Buffer.from(dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes)),
              key.publicKey,
              Buffer.from(signature.sig, "base64"),
            );
        } catch {
          return false;
        }
      },
      verifyAuthoritySignature: (input: { envelopeBytes: Uint8Array; keyId: string; role: AdmissionAuthorityRole }): boolean => {
        const binding = v4Trust.admission.authorities.find((candidate) => candidate.role === input.role);
        if (binding?.keyId !== input.keyId || input.keyId !== v4Trust.report.keyId) return false;
        try {
          const envelope = parseExactDsseEnvelope(input.envelopeBytes);
          const signature = envelope.signatures[0];
          return envelope.signatures.length === 1 && signature?.keyid === input.keyId
            && verifySignature(
              null,
              Buffer.from(dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes)),
              reportKey,
              Buffer.from(signature.sig, "base64"),
            );
        } catch {
          return false;
        }
      },
    };
    try {
      verifiedAdmission = verifyBinaryJudgmentAdmissionClosure({
        admissionManifestSha256: qualification.admissionManifestSha256 as AdmissionSha256,
        expectedDraftId: assembly.header.draftId,
      }, ports);
    } catch (cause) {
      refuse("record-integrity", "evidence-closure", `binary admission replay failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (
      !sameCanonical(verifiedAdmission.reachableSha256s, qualification.reachableSha256s)
      || !sameCanonical(verifiedAdmission.reachableRecords, qualification.admissionRecords)
      || verifiedAdmission.publicationGrade !== qualification.publicationGrade
      || verifiedAdmission.manifest.truthAdmission !== qualification.truthAdmission
      || !sameCanonical(verifiedAdmission.classes, qualification.candidateClasses)
      || !sameCanonical(verifiedAdmission.strata, qualification.strata)
    ) refuse("record-integrity", "qualification.json", "qualification admission projection differs from portable replay");
    for (const record of verifiedAdmission.reachableRecords) {
      for (const role of record.roles) addRole(expectedRoles, record.sha256.slice("sha256:".length), role);
    }

    const intakeParsed = BinaryItemBankIntakeExtensionSchema.safeParse(
      (benchmark as unknown as Record<string, unknown>)[BINARY_ITEM_BANK_INTAKE_EXTENSION],
    );
    if (!intakeParsed.success) refuse("record-integrity", "evidence-closure", "Benchmark binary intake extension is outside its strict schema");
    const intake = intakeParsed.data;
    const itemBankSha256 = intake.itemBankSha256;
    const sourceManifestSha256 = intake.sourceManifestSha256;
    const admissionIndexSha256 = intake.admissionIndexSha256;
    if (
      typeof itemBankSha256 !== "string" || typeof sourceManifestSha256 !== "string"
      || typeof admissionIndexSha256 !== "string"
      || sourceManifestSha256 !== qualification.sourceManifestSha256
      || intake.admissionManifestSha256 !== qualification.admissionManifestSha256
      || intake.replacementLedgerSha256 !== verifiedAdmission.manifest.replacementLedgerSha256
    ) refuse("record-integrity", "evidence-closure", "Benchmark binary intake roots differ from qualification/admission replay");
    const roots = [
      [itemBankSha256, "item-bank"],
      [sourceManifestSha256, "source-manifest"],
      [admissionIndexSha256, "admission-index"],
    ] as const;
    for (const [digest, role] of roots) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(digest) || !records.has(digest.slice("sha256:".length))) {
        refuse("record-integrity", "evidence-closure", `${role} root ${digest} is missing`);
      }
      addRole(expectedRoles, digest.slice("sha256:".length), role);
    }
    const itemRows = exactCanonicalJsonl(records.get(itemBankSha256.slice("sha256:".length))!, "item-bank.jsonl", BinaryItemBankEntrySchema);
    const sourceRows = exactCanonicalJsonl(records.get(sourceManifestSha256.slice("sha256:".length))!, "source-manifest.jsonl", BinarySourceManifestEntrySchema);
    const admissionRows = exactCanonicalJsonl(records.get(admissionIndexSha256.slice("sha256:".length))!, "admission-index.jsonl", BinaryAdmissionIndexEntrySchema);
    const strictOrder = (values: readonly string[], path: string): void => {
      for (let index = 1; index < values.length; index += 1) {
        if (values[index - 1]! >= values[index]!) refuse("record-integrity", path, `${path} rows are not sorted and unique`);
      }
    };
    strictOrder(itemRows.map((row) => row.item.itemId), "item-bank.jsonl");
    strictOrder(sourceRows.map((row) => row.provenanceSha256), "source-manifest.jsonl");
    strictOrder(admissionRows.map((row) => row.itemSha256), "admission-index.jsonl");
    const admittedByItem = new Map(verifiedAdmission.accepted.map((entry) => [entry.itemSha256, entry]));
    const { itemDigests } = checkItemBankSourceClosure(itemRows, sourceRows);
    const expectedAdmissions = verifiedAdmission.accepted.map((entry) => ({
      admissionManifestSha256: verifiedAdmission!.manifestSha256,
      itemSha256: entry.itemSha256,
      labelResolutionSha256: entry.labelResolutionSha256,
      analysisContextSha256: entry.analysisContextSha256,
    })).sort((left, right) => left.itemSha256 < right.itemSha256 ? -1 : left.itemSha256 > right.itemSha256 ? 1 : 0);
    const actualAdmissions = admissionRows.map((row) => ({
      admissionManifestSha256: row.admissionManifestSha256,
      itemSha256: row.itemSha256,
      labelResolutionSha256: row.labelResolutionSha256,
      analysisContextSha256: row.analysisContextSha256,
    }));
    if (!sameCanonical(actualAdmissions, expectedAdmissions)) refuse("record-integrity", "admission-index.jsonl", "admission index differs from authenticated accepted closure");

    const expectedTasks = new Set(benchmark.items.map((item) => item.task.digest.sha256));
    if (qualification.items.length !== expectedTasks.size || qualification.items.length !== verifiedAdmission.accepted.length) {
      refuse("record-integrity", "qualification.items", "qualification Task coverage cardinality differs from Benchmark/admission");
    }
    for (const entry of qualification.items) {
      const taskHex = entry.taskSha256.slice("sha256:".length);
      const taskBytes = records.get(taskHex);
      if (!expectedTasks.has(taskHex) || taskBytes === undefined) refuse("record-integrity", "qualification.items", `Task ${entry.taskSha256} is outside Benchmark evidence`);
      const task = parseRecord(taskBytes, TaskSpecificationSchema, `records/${taskHex}.bin`);
      if ((task as unknown as Record<string, unknown>)["network.jinn.binary-judgment.item-sha256"] !== entry.itemSha256) {
        refuse("record-integrity", "qualification.items", `Task ${entry.taskSha256} item commitment differs`);
      }
      const admitted = admittedByItem.get(entry.itemSha256 as AdmissionSha256);
      if (admitted === undefined || admitted.labelResolutionSha256 !== entry.labelResolutionSha256
        || admitted.analysisContextSha256 !== entry.analysisContextSha256 || !itemDigests.has(entry.itemSha256)) {
        refuse("record-integrity", "qualification.items", `Task ${entry.taskSha256} admission joins differ`);
      }
    }

    const runArms = new Map(run.arms.map((arm) => [arm.armId, arm]));
    if (!sameCanonical(
      [...runArms.keys()].sort(),
      qualification.arms.map((entry) => entry.armId),
    )) {
      refuse("record-integrity", "qualification.arms", "qualification does not exactly cover the Run arm set");
    }
    const instruments: Array<{
      armId: string;
      instrumentSha256: string;
      promptTemplateSha256: string;
      model: AcceptedJudgeModelId;
      generation: ReturnType<typeof parseBinaryJudgmentInstrument>["model"]["generation"];
    }> = [];
    for (const entry of qualification.arms) {
      const arm = runArms.get(entry.armId);
      if (arm?.pinning[BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY] !== entry.instrumentSha256) {
        refuse("record-integrity", "qualification.arms", `Run arm ${entry.armId} instrument pin differs`);
      }
      const instrumentHex = entry.instrumentSha256.slice("sha256:".length);
      const instrumentBytes = records.get(instrumentHex);
      if (instrumentBytes === undefined) refuse("record-integrity", "qualification.arms", `instrument ${entry.instrumentSha256} is missing`);
      let instrument: ReturnType<typeof parseBinaryJudgmentInstrument>;
      try {
        instrument = parseBinaryJudgmentInstrument(instrumentBytes);
      } catch (cause) {
        refuse("record-integrity", "qualification.arms", `instrument ${entry.instrumentSha256} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (!equalBytes(instrumentBytes, canonicalJsonBytes(instrument as never))) refuse("record-integrity", "qualification.arms", "instrument is not exact canonical profile bytes");
      addRole(expectedRoles, instrumentHex, "judge-instrument");
      instruments.push({
        armId: entry.armId,
        instrumentSha256: entry.instrumentSha256,
        promptTemplateSha256: instrument.promptTemplateSha256,
        model: instrument.model.requested,
        generation: instrument.model.generation,
      });
    }
    if (
      verifiedAdmission.screening !== undefined
      && instruments.some((entry) => entry.instrumentSha256 === verifiedAdmission!.screening!.instrumentSha256)
    ) {
      refuse("record-integrity", "qualification.arms", "the screening instrument is reused as a run judge arm");
    }
    const registeredSelections = readRunPublicationExtension(run as unknown as Record<string, unknown>)
      ?.registrationArtifacts.filter((artifact) => artifact.role === INSPECT_SELECTION_CORRELATION_ROLE) ?? [];
    if (
      registeredSelections.length !== 1
      || registeredSelections[0]!.artifact.mediaType !== "application/json"
    ) {
      refuse("record-integrity", "evidence-closure", "binary Run must register exactly one JSON Inspect runtime selection");
    }
    const registeredSelectionSha256 = registeredSelections[0]!.artifact.digest.sha256;
    const runtimeSelectionRecords = evidence.records.filter((record) => record.roles.includes("runtime-selection"));
    if (runtimeSelectionRecords.length !== 1) {
      refuse("record-integrity", "evidence-closure", "binary qualification requires exactly one runtime-selection record");
    }
    const binarySelectionRecord = runtimeSelectionRecords[0]!;
    if (binarySelectionRecord.sha256 !== registeredSelectionSha256) {
      refuse("record-integrity", "evidence-closure", "runtime-selection evidence differs from the selection frozen in Run registration");
    }
    const binarySelectionBytes = records.get(binarySelectionRecord.sha256)!;
    const binarySelection = parseRecord(
      binarySelectionBytes,
      InspectBinaryJudgeSelectionManifestSchema,
      `records/${binarySelectionRecord.sha256}.bin`,
    );
    requireCanonical(binarySelectionBytes, binarySelection, `records/${binarySelectionRecord.sha256}.bin`);
    const expectedSelectionArms = instruments.map((entry) => ({
      armId: entry.armId,
      instrumentSha256: entry.instrumentSha256,
      model: entry.model,
      generation: entry.generation,
    }));
    const actualSelectionArms = binarySelection.arms;
    if (!sameCanonical(actualSelectionArms, expectedSelectionArms)) {
      refuse("record-integrity", "evidence-closure", "binary runtime selection arms differ from qualification and Run pins");
    }
    addRole(expectedRoles, binarySelectionRecord.sha256, "runtime-selection");
    if (binarySelection.snapshotProbeSha256 !== undefined) {
      const probeHex = binarySelection.snapshotProbeSha256.slice("sha256:".length);
      const probeBytes = records.get(probeHex);
      if (probeBytes === undefined) refuse("record-integrity", "evidence-closure", `snapshot-serving probe ${binarySelection.snapshotProbeSha256} is missing`);
      const probe = parseRecord(probeBytes, BinaryJudgmentSnapshotProbeSchema, `records/${probeHex}.bin`);
      requireCanonical(probeBytes, probe, `records/${probeHex}.bin`);
      // This is the cold-verify SECOND COPY of the bind-time rule (spec §1.5 rule 4), not a
      // second enforcement point (§0.5): a cold verifier re-derives from bytes without trusting
      // the producer, which is the same reason this package already carries second copies of
      // other producer-side rules. Freshness (§1.5 rule 3) is deliberately NOT re-checked here —
      // it scopes to bind, where the bind clock exists.
      if (!instruments.some((entry) => entry.model === probe.requestedModel)) {
        refuse("record-integrity", "evidence-closure", "snapshot-serving probe model is not the model of any bound arm");
      }
      if (probe.outcome !== "serving") {
        refuse("record-integrity", "evidence-closure", "snapshot-serving probe outcome is not serving");
      }
      addRole(expectedRoles, probeHex, "snapshot-probe");
    }
    const reviewerBindingMap = new Map<string, string>();
    for (const entry of verifiedAdmission.reachableRecords
      .filter((candidate) => candidate.roles.includes("human-review-verdict"))) {
        const bytes = records.get(entry.sha256.slice("sha256:".length))!;
        const view = readAdmissionVerdictEnvelope(bytes);
        const keyId = parseExactDsseEnvelope(bytes).signatures[0]?.keyid;
        if (typeof keyId !== "string") {
          refuse("record-integrity", "trust.admission.reviewers", `reviewer ${view.evaluatorId} has no signer key id`);
        }
        const prior = reviewerBindingMap.get(view.evaluatorId);
        if (prior !== undefined && prior !== keyId) {
          refuse("record-integrity", "trust.admission.reviewers", `reviewer ${view.evaluatorId} uses more than one key`);
        }
        reviewerBindingMap.set(view.evaluatorId, keyId);
    }
    const reviewerBindings = [...reviewerBindingMap].map(([evaluator, keyId]) => ({ evaluator, keyId }))
      .sort((left, right) => left.evaluator < right.evaluator ? -1 : left.evaluator > right.evaluator ? 1 : 0);
    if (!sameCanonical(reviewerBindings, v4Trust.admission.reviewers)) {
      refuse("record-integrity", "trust.admission.reviewers", "reviewer registry differs from authenticated signed review closure");
    }
    binaryAssetQualification = {
      publicationGrade: qualification.publicationGrade,
      truthAdmission: qualification.truthAdmission,
      sourceManifestSha256: qualification.sourceManifestSha256,
      admissionManifestSha256: qualification.admissionManifestSha256,
      exclusions: qualification.exclusions,
      instruments: instruments.map(({ armId, instrumentSha256, promptTemplateSha256 }) => ({
        armId,
        instrumentSha256,
        promptTemplateSha256,
      })),
    };
  }

  for (const cell of assembly.cells) {
    unique(cell.verdicts.map((verdict) => String(verdict.evalIndex)), `${cell.cellKey}.verdicts.evalIndex`);
    if (cell.verdicts.some((verdict) => verdict.evalIndex < 1 || verdict.evalIndex > minVerdicts)) {
      refuse("record-integrity", "evidence-closure", `${cell.cellKey} verdict index is outside Run policy`);
    }
  }

  for (const coord of expectedCoordinates) {
    addRole(expectedRoles, coord.taskDigest, "task");
    const taskBytes = records.get(coord.taskDigest);
    if (taskBytes === undefined) refuse("record-integrity", "evidence-closure", `${coord.cellKey} has no exact Task bytes`);
    const task = taskSpecs.get(coord.taskDigest) ?? parseRecord(taskBytes, TaskSpecificationSchema, `records/${coord.taskDigest}.bin`);
    taskSpecs.set(coord.taskDigest, task);
    if (task.profile.uri === INSPECT_TASK_PROFILE_URI) {
      const payload = task.payload as { selectionManifestSha256?: unknown };
      const selectionSha256 = payload.selectionManifestSha256;
      if (typeof selectionSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(selectionSha256)) {
        refuse("record-integrity", "evidence-closure", `${coord.cellKey} Inspect Task has no sealed runtime selection identity`);
      }
      addRole(expectedRoles, selectionSha256, "runtime-selection");
      if (!inspectSelections.has(selectionSha256)) {
        const selectionBytes = records.get(selectionSha256);
        if (selectionBytes === undefined) {
          refuse("record-integrity", "evidence-closure", `${coord.cellKey} has no exact Inspect runtime selection bytes`);
        }
        const selection = parseRecord(
          selectionBytes,
          InspectSelectionManifestSchema,
          `records/${selectionSha256}.bin`,
        );
        requireCanonical(selectionBytes, selection, `records/${selectionSha256}.bin`);
        inspectSelections.set(selectionSha256, selection);
      }
    }
    const evaluationSpecSha256 = task.evaluation?.digest?.sha256;
    if (typeof evaluationSpecSha256 !== "string") refuse("record-integrity", "evidence-closure", `${coord.cellKey} Task has no EvaluationSpec digest`);
    addRole(expectedRoles, evaluationSpecSha256, "evaluation-spec");
    if (!evaluationSpecs.has(evaluationSpecSha256)) {
      const specBytes = records.get(evaluationSpecSha256);
      if (specBytes === undefined) refuse("record-integrity", "evidence-closure", `${coord.cellKey} has no exact EvaluationSpec bytes`);
      try {
        evaluationSpecs.set(evaluationSpecSha256, parseEvaluationSpec(specBytes));
      } catch {
        refuse("record-integrity", "evidence-closure", `${coord.cellKey} EvaluationSpec bytes are invalid`);
      }
    }
  }

  // Binary-judgment Tasks (the family that includes binary-instrument@1 and the two judge
  // readouts) catalog a runtime-selection, arm instruments, analysis-context, and
  // label-resolution even when the Report is not binary-instrument@1 and there is therefore no
  // qualification.json. The V4 qualification block above already expects those roles; this is
  // the same producer-side `binaryInspectRuntime` catalog for the non-V4 additional-analysis
  // bundles. Snapshot-probe is V4-only (stripped from the /2 catalog).
  if (
    qualification === undefined
    && [...taskSpecs.values()].some((task) => task.profile.uri === BINARY_JUDGMENT_PROFILE_URI)
  ) {
    const registeredSelections = readRunPublicationExtension(run as unknown as Record<string, unknown>)
      ?.registrationArtifacts.filter((artifact) => artifact.role === INSPECT_SELECTION_CORRELATION_ROLE) ?? [];
    if (
      registeredSelections.length !== 1
      || registeredSelections[0]!.artifact.mediaType !== "application/json"
    ) {
      refuse("record-integrity", "evidence-closure", "binary Run must register exactly one JSON Inspect runtime selection");
    }
    const registeredSelectionSha256 = registeredSelections[0]!.artifact.digest.sha256;
    const selectionBytes = records.get(registeredSelectionSha256);
    if (selectionBytes === undefined) {
      refuse("record-integrity", "evidence-closure", "binary runtime-selection bytes are missing");
    }
    const binarySelection = parseRecord(
      selectionBytes,
      InspectBinaryJudgeSelectionManifestSchema,
      `records/${registeredSelectionSha256}.bin`,
    );
    requireCanonical(selectionBytes, binarySelection, `records/${registeredSelectionSha256}.bin`);
    addRole(expectedRoles, registeredSelectionSha256, "runtime-selection");
    for (const arm of run.arms) {
      const instrumentSha256 = arm.pinning[BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY];
      if (typeof instrumentSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(instrumentSha256)) {
        refuse("record-integrity", "evidence-closure", `Run arm ${arm.armId} has no exact judge-instrument pin`);
      }
      const instrumentHex = instrumentSha256.slice("sha256:".length);
      const instrumentBytes = records.get(instrumentHex);
      if (instrumentBytes === undefined) {
        refuse("record-integrity", "evidence-closure", `instrument ${instrumentSha256} is missing`);
      }
      let instrument: ReturnType<typeof parseBinaryJudgmentInstrument>;
      try {
        instrument = parseBinaryJudgmentInstrument(instrumentBytes);
      } catch (cause) {
        refuse(
          "record-integrity",
          "evidence-closure",
          `instrument ${instrumentSha256} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      requireCanonical(instrumentBytes, instrument as never, `records/${instrumentHex}.bin`);
      addRole(expectedRoles, instrumentHex, "judge-instrument");
    }
    for (const task of taskSpecs.values()) {
      if (task.profile.uri !== BINARY_JUDGMENT_PROFILE_URI) continue;
      const specSha256 = task.evaluation?.digest?.sha256;
      if (typeof specSha256 !== "string") {
        refuse("record-integrity", "evidence-closure", "binary Task has no EvaluationSpec digest");
      }
      const spec = evaluationSpecs.get(specSha256);
      if (spec === undefined) {
        refuse("record-integrity", "evidence-closure", `EvaluationSpec ${specSha256} is not in the catalog`);
      }
      const analysisHex = analysisContextDigestFromEvalSpec(spec);
      if (analysisHex === undefined) {
        refuse("record-integrity", "evidence-closure", `EvaluationSpec ${specSha256} has no analysis-context`);
      }
      const analysisBytes = records.get(analysisHex);
      if (analysisBytes === undefined) {
        refuse("record-integrity", "evidence-closure", `analysis context ${analysisHex} is missing`);
      }
      let analysis: ReturnType<typeof parseBinaryJudgmentAnalysisContext>;
      try {
        analysis = parseBinaryJudgmentAnalysisContext(analysisBytes);
      } catch (cause) {
        refuse(
          "record-integrity",
          "evidence-closure",
          `analysis context ${analysisHex} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      requireCanonical(analysisBytes, analysis, `records/${analysisHex}.bin`);
      addRole(expectedRoles, analysisHex, "analysis-context");
      const labelHex = analysis.labelResolutionSha256.slice("sha256:".length);
      if (records.get(labelHex) === undefined) {
        refuse("record-integrity", "evidence-closure", `label resolution ${analysis.labelResolutionSha256} is missing`);
      }
      addRole(expectedRoles, labelHex, "label-resolution");
    }
  }

  unique(assembly.header.graph.admissions.map((entry) => entry.taskSha256), "verification.graph.admissions.taskSha256");
  const admissionByTask = new Map<string, { receiptSha256: string; fact: LocalAdmissionReceiptFact }>();
  for (const edge of assembly.header.graph.admissions) {
    if (![...coordinatesByKey.values()].some((coord) => coord.taskDigest === edge.taskSha256)) {
      refuse("record-integrity", "evidence-closure", `admission receipt is unreachable from Benchmark Task ${edge.taskSha256}`);
    }
    addRole(expectedRoles, edge.receiptSha256, "admission-receipt");
    const bytes = records.get(edge.receiptSha256);
    const parsed = bytes === undefined ? undefined : parsePredictionSnapshotAdmissionReceipt(bytes, edge.receiptSha256);
    if (parsed === undefined || parsed.taskSha256 !== edge.taskSha256) {
      refuse("record-integrity", "evidence-closure", `admission receipt ${edge.receiptSha256} does not bind Task ${edge.taskSha256}`);
    }
    admissionByTask.set(edge.taskSha256, { receiptSha256: edge.receiptSha256, fact: parsed.fact });
  }

  unique(assembly.header.graph.solveSubmissions.map((edge) => `${edge.cellKey}:${edge.dispatch}`), "verification.graph.solveSubmissions.coordinates");
  const solveSubmissionByCoordinate = new Map<string, (typeof assembly.header.graph.solveSubmissions)[number]>();
  const pinningEvidenceByDigest = new Map<string, RunPinningEvidence>();
  for (const edge of assembly.header.graph.solveSubmissions) {
    const coord = coordinatesByKey.get(edge.cellKey);
    if (coord === undefined) refuse("record-integrity", "evidence-closure", `solve Submission ${edge.sha256} names an unknown cell`);
    const cell = cellsByKey.get(edge.cellKey)!;
    if (edge.dispatch < 1 || edge.dispatch > cell.dispatches) {
      refuse("record-integrity", "evidence-closure", `solve Submission ${edge.sha256} dispatch is outside its cell lineage`);
    }
    addRole(expectedRoles, edge.sha256, "solve-submission");
    const bytes = records.get(edge.sha256);
    if (bytes === undefined) refuse("record-integrity", "evidence-closure", `solve Submission ${edge.sha256} bytes are missing`);
    const submission = parseRecord(bytes, SubmissionRecordSchema, `records/${edge.sha256}.bin`);
    const expectedNonce = `${edge.cellKey}:${edge.dispatch}`;
    if (
      submission.task.digest?.sha256 !== coord.taskDigest
      || submission.nonce !== expectedNonce
      || submission.idempotencyKey !== cellIdempotencyKey(`sha256:${identities.runSha256}`, edge.cellKey, edge.dispatch)
    ) refuse("record-integrity", "evidence-closure", `solve Submission ${edge.sha256} does not bind its Task/cell/dispatch`);
    if (edge.pinningEvidenceSha256 !== undefined) {
      addRole(expectedRoles, edge.pinningEvidenceSha256, "run-pinning-evidence");
      const evidenceBytes = records.get(edge.pinningEvidenceSha256);
      if (evidenceBytes === undefined) {
        refuse("record-integrity", "evidence-closure", `run-pinning evidence ${edge.pinningEvidenceSha256} bytes are missing`);
      }
      let evidence: RunPinningEvidence;
      try {
        evidence = parseRunPinningEvidenceArtifact(evidenceBytes);
      } catch {
        refuse("record-integrity", "evidence-closure", `run-pinning evidence ${edge.pinningEvidenceSha256} is invalid`);
      }
      requireCanonical(
        evidenceBytes,
        evidence,
        `records/${edge.pinningEvidenceSha256}.bin`,
      );
      if (evidence.submissionDigest !== `sha256:${edge.sha256}`) {
        refuse("record-integrity", "evidence-closure", `run-pinning evidence ${edge.pinningEvidenceSha256} names another Submission`);
      }
      pinningEvidenceByDigest.set(edge.pinningEvidenceSha256, evidence);
    }
    solveSubmissionByCoordinate.set(`${edge.cellKey}:${edge.dispatch}`, edge);
  }
  for (const cell of assembly.cells) {
    for (let dispatch = 1; dispatch <= cell.dispatches; dispatch += 1) {
      if (!solveSubmissionByCoordinate.has(`${cell.cellKey}:${dispatch}`)) {
        refuse("record-integrity", "evidence-closure", `${cell.cellKey} is missing solve Submission dispatch ${dispatch}`);
      }
    }
  }

  unique(assembly.header.graph.solveDeliveries.map((edge) => edge.cellKey), "verification.graph.solveDeliveries.cells");
  const solveDeliveryByCell = new Map<string, (typeof assembly.header.graph.solveDeliveries)[number]>();
  const inspectClosureByCell = new Map<string, {
    readonly summary: InspectCellSummary;
    readonly selection: InspectSelectionManifest;
    readonly selectionSha256: string;
    readonly arm: InspectArmConfiguration;
    readonly nativeLog: { readonly name: string; readonly sha256: string };
    readonly verdictOutput?: { readonly name: string; readonly sha256: string };
  }>();
  for (const edge of assembly.header.graph.solveDeliveries) {
    const coord = coordinatesByKey.get(edge.cellKey);
    if (coord === undefined) refuse("record-integrity", "evidence-closure", `solve Delivery ${edge.sha256} names an unknown cell`);
    const cell = cellsByKey.get(edge.cellKey)!;
    if (
      edge.dispatch !== cell.dispatches
      || solveSubmissionByCoordinate.get(`${edge.cellKey}:${edge.dispatch}`) === undefined
      || cell.deliverySha256 !== edge.sha256
    ) {
      refuse("record-integrity", "evidence-closure", `solve Delivery ${edge.sha256} is outside its exact cell lineage`);
    }
    addRole(expectedRoles, edge.sha256, "solve-delivery");
    const bytes = records.get(edge.sha256);
    if (bytes === undefined) refuse("record-integrity", "evidence-closure", `solve Delivery ${edge.sha256} bytes are missing`);
    const delivery = parseRecord(bytes, DeliveryRecordSchema, `records/${edge.sha256}.bin`);
    if (delivery.task !== `sha256:${coord.taskDigest}` || delivery.attempt !== edge.attempt) {
      refuse("record-integrity", "evidence-closure", `solve Delivery ${edge.sha256} does not bind its cell Task/attempt`);
    }
    const actualOutputs = delivery.outputs.flatMap((output) => typeof output.digest?.sha256 === "string"
      ? [{ name: output.name, sha256: output.digest.sha256 }]
      : []);
    if (!equalBytes(canonicalJsonBytes(actualOutputs), canonicalJsonBytes(edge.outputs))) {
      refuse("record-integrity", "evidence-closure", `solve Delivery ${edge.sha256} outputs disagree with the journal graph`);
    }
    for (const output of edge.outputs) addRole(expectedRoles, output.sha256, "solve-output");
    solveDeliveryByCell.set(edge.cellKey, edge);

    const task = taskSpecs.get(cell.taskDigest);
    if (task?.profile.uri === INSPECT_TASK_PROFILE_URI) {
      const nativeLog = edge.outputs.find((output) => output.name === "inspect-log");
      const summaryOutput = edge.outputs.find((output) => output.name === "inspect-summary");
      const verdictOutput = edge.outputs.find((output) => output.name === "verdict");
      if (nativeLog === undefined || summaryOutput === undefined) {
        refuse("record-integrity", "evidence-closure", "Inspect Delivery lacks its native log or summary");
      }
      const nativeBytes = records.get(nativeLog.sha256);
      const summaryBytes = records.get(summaryOutput.sha256);
      if (nativeBytes === undefined || summaryBytes === undefined) {
        refuse("record-integrity", "evidence-closure", "Inspect native log or summary bytes are absent");
      }
      let summary: InspectCellSummary;
      try {
        summary = InspectCellSummarySchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(summaryBytes)));
      } catch {
        refuse("record-integrity", "evidence-closure", "Inspect summary is invalid");
      }
      if (
        summary.nativeLogSha256 !== nativeLog.sha256
        || summary.nativeLogBytes !== nativeBytes.length
        || sha256(nativeBytes) !== nativeLog.sha256
      ) refuse("record-integrity", "evidence-closure", "Inspect summary does not bind the exact native log");

      const selectionSha256 = (task.payload as { selectionManifestSha256?: unknown }).selectionManifestSha256;
      const selection = typeof selectionSha256 === "string" ? inspectSelections.get(selectionSha256) : undefined;
      const arm = selection?.arms.find((candidate) => candidate.armId === cell.armId);
      if (selection === undefined || arm === undefined) {
        refuse("record-integrity", "evidence-closure", "Inspect Delivery has no exact selected arm configuration");
      }
      if (summary.schema === "jinn.network/benchmark-product/inspect-cell-summary/2") {
        let projectedVerdict: "pass" | "fail" | "inconclusive" | null;
        try {
          projectedVerdict = projectInspectCellVerdict(summary, selection);
        } catch {
          refuse("record-integrity", "evidence-closure", "Inspect summary differs from its sealed scorer projections");
        }
        if (summary.verdict !== projectedVerdict || !isInspectMultiScorerSelection(selection)) {
          refuse("record-integrity", "evidence-closure", "Inspect summary verdict does not match its sealed scoring rule");
        }
        const evaluationSpecSha256 = task.evaluation?.digest?.sha256;
        const spec = evaluationSpecSha256 === undefined ? undefined : evaluationSpecs.get(evaluationSpecSha256);
        const expectedDeclarations = summary.measurements.map((measurement) => ({
          name: measurement.measurementName,
          type: "boolean",
          required: true,
        }));
        if (
          spec === undefined
          || !equalBytes(canonicalJsonBytes(spec.measurements), canonicalJsonBytes(expectedDeclarations))
          || !equalBytes(canonicalJsonBytes(spec.verdictRule), canonicalJsonBytes(selection.scoring.verdictRule))
        ) {
          refuse("record-integrity", "evidence-closure", "Inspect summary measurements differ from the sealed EvaluationSpec");
        }
      } else if (isInspectMultiScorerSelection(selection) || summary.scorer !== selection.scorer.name) {
        refuse("record-integrity", "evidence-closure", "legacy Inspect summary differs from its sealed scorer selection");
      }
      if (arm.provider === undefined) {
        if (summary.provider !== undefined) {
          refuse("record-integrity", "evidence-closure", "credential-free Inspect arm carries provider evidence");
        }
      } else {
        const provider = summary.provider;
        const completed = provider?.terminalStatus === "completed";
        const noCall = provider?.terminalStatus === "no-call";
        const failedWithMethodConflict = provider?.terminalStatus === "method-conflict";
        if (
          provider?.surface !== arm.provider.surface
          || provider.brokerProtocol !== selection.runtime.execution?.broker?.protocol
          || provider.brokerSourceSha256 !== selection.runtime.execution?.brokerSourceSha256
          || (noCall ? provider.callCount !== 0 : provider.callCount !== 1)
          || (noCall && provider.resolvedModel !== null)
          || (completed && provider.resolvedModel !== arm.provider.upstreamModel)
          || (!completed && !failedWithMethodConflict && provider.resolvedModel !== null
            && provider.resolvedModel !== arm.provider.upstreamModel)
          || (summary.terminal === "scored" && !completed)
        ) {
          refuse("record-integrity", "evidence-closure", "Inspect provider evidence differs from the sealed arm/runtime selection");
        }
      }
      inspectClosureByCell.set(edge.cellKey, {
        summary,
        selection,
        selectionSha256: selectionSha256 as string,
        arm,
        nativeLog,
        ...(verdictOutput === undefined ? {} : { verdictOutput }),
      });
    }
  }

  unique(assembly.header.graph.evaluationSubmissions.map((edge) => `${edge.cellKey}:${edge.evalIndex}:${edge.evaluationAttempt ?? 1}`), "verification.graph.evaluationSubmissions.coordinates");
  const evaluationSubmissionByDigest = new Map<string, (typeof assembly.header.graph.evaluationSubmissions)[number]>();
  for (const edge of assembly.header.graph.evaluationSubmissions) {
    const cell = cellsByKey.get(edge.cellKey);
    if (cell === undefined) refuse("record-integrity", "evidence-closure", `evaluation Submission ${edge.sha256} names an unknown cell`);
    if (edge.dispatch < 1 || edge.dispatch > cell.dispatches || edge.evalIndex < 1 || edge.evalIndex > minVerdicts) {
      refuse("record-integrity", "evidence-closure", `evaluation Submission ${edge.sha256} is outside its cell/evaluator domain`);
    }
    const bytes = records.get(edge.sha256);
    if (bytes === undefined) refuse("record-integrity", "evidence-closure", `evaluation Submission ${edge.sha256} bytes are missing`);
    const submission = parseRecord(bytes, SubmissionRecordSchema, `records/${edge.sha256}.bin`);
    const evaluationAttempt = edge.evaluationAttempt ?? 1;
    const expectedNonce = evaluationAttempt === 1
      ? `eval:${identities.runSha256}:e${edge.evalIndex}:${edge.cellKey}:${edge.dispatch}`
      : `eval:${identities.runSha256}:e${edge.evalIndex}:r${evaluationAttempt}:${edge.cellKey}:${edge.dispatch}`;
    if (
      submission.task.digest?.sha256 !== edge.evalTaskSha256
      || submission.nonce !== expectedNonce || submission.idempotencyKey !== expectedNonce
      || submission.requirements?.[EVALUATOR_REQUIREMENT_KEY] !== edge.evaluator
    ) refuse("record-integrity", "evidence-closure", `evaluation Submission ${edge.sha256} does not bind its Task/cell/evaluator`);
    evaluationSubmissionByDigest.set(edge.sha256, edge);
  }

  unique(assembly.header.graph.evaluations.map((edge) => `${edge.cellKey}:${edge.evalIndex}:${edge.evaluationAttempt ?? 1}`), "verification.graph.evaluations.coordinates");
  const evaluationsByVerdict = new Map<string, Array<(typeof assembly.header.graph.evaluations)[number]>>();
  const consumedEvaluationSubmissions = new Set<string>();
  const inspectEvaluationStrategy = deriveInspectEvaluationStrategy(run.policy.evaluation);
  for (const edge of assembly.header.graph.evaluations) {
    const cell = cellsByKey.get(edge.cellKey);
    if (cell === undefined) refuse("record-integrity", "evidence-closure", "evaluation graph names an unknown cell");
    if (edge.evalIndex < 1 || edge.evalIndex > minVerdicts) refuse("record-integrity", "evidence-closure", "evaluation graph index is outside Run policy");
    const successful = edge.verdictSha256 !== undefined;
    const embedded = edge.relationship === "same-execution-scorer";
    const separateInspectVerifier = edge.relationship === "separate-log-verifier";
    const inspectClosure = inspectClosureByCell.get(cell.cellKey);
    if (
      successful
      && inspectClosure !== undefined
      && inspectEvaluationStrategy === "separate-log-verification"
      && !separateInspectVerifier
    ) {
      refuse("record-integrity", "evidence-closure", "separate Inspect verdict omits its verifier relationship");
    }
    if (successful) {
      if (embedded) {
        if (inspectEvaluationStrategy !== "embedded") {
          refuse("record-integrity", "evidence-closure", "separate Inspect assurance contains an embedded Matrix vote");
        }
        if (
          edge.evaluator !== INSPECT_EMBEDDED_EVALUATOR_ID
          || edge.evalTaskSha256 !== undefined || edge.evalSubmissionSha256 !== undefined
          || edge.evalAttempt !== undefined || edge.evalDeliverySha256 !== undefined
          || edge.evaluationTerminal !== undefined
        ) refuse("record-integrity", "evidence-closure", "same-execution Inspect score carries false separate-evaluator lineage");
        // Binary Tasks (binary-instrument@1 and the two judge-family readouts that share its
        // execution) are runtime-neutral and carry no generic Inspect summary. `qualification.json`
        // is present only for binary-instrument@1's V4 bundle; pairwise-disagreement@1 and
        // paired-majority-delta@1 ride the same Binary Tasks without that file, so the
        // discriminator is the Task profile URI (with qualification.json as the V4 alias).
        const binaryJudgmentCell = qualification !== undefined
          || taskSpecs.get(cell.taskDigest)?.profile.uri === BINARY_JUDGMENT_PROFILE_URI;
        if (binaryJudgmentCell) {
          // The solve Delivery plus signed verdict are joined here; verifyReport is the sole
          // authority that replays its exact response/observation/instrument semantics below.
          if (solveDeliveryByCell.get(cell.cellKey) === undefined) {
            refuse("record-integrity", "evidence-closure", "binary same-execution verdict has no solve Delivery lineage");
          }
        } else {
          const closure = inspectClosureByCell.get(cell.cellKey);
          const summary = closure?.summary;
          const verdictOutput = closure?.verdictOutput;
          if (
            closure === undefined || summary === undefined
            || verdictOutput?.sha256 !== edge.verdictSha256
          ) refuse("record-integrity", "evidence-closure", "same-execution score is not bound to one Inspect Task/Delivery/log/summary/verdict closure");
          if (summary.terminal !== "scored") refuse("record-integrity", "evidence-closure", "Inspect verdict is attached to an unscorable summary");
          if (summary.schema === "jinn.network/benchmark-product/inspect-cell-summary/2") {
            const verdictBytes = verdictOutput === undefined ? undefined : records.get(verdictOutput.sha256);
            if (verdictBytes === undefined) {
              refuse("record-integrity", "evidence-closure", "Inspect Result Evaluation bytes are absent");
            }
            const verdictView = readVerdictEnvelope(verdictBytes);
            const expectedMeasurements = summary.measurements.map((measurement) => ({
              name: measurement.measurementName,
              value: measurement.value!,
            }));
            if (
              verdictView.verdict !== summary.verdict
              || !equalBytes(
                canonicalJsonBytes(readOrderedVerdictMeasurements(verdictBytes)),
                canonicalJsonBytes(expectedMeasurements),
              )
            ) {
              refuse("record-integrity", "evidence-closure", "Inspect Result Evaluation differs from its projected measurements");
            }
          }
        }
      } else if (
        edge.evaluator === undefined || edge.evalTaskSha256 === undefined
        || edge.evalSubmissionSha256 === undefined || edge.evalAttempt === undefined
        || edge.evalDeliverySha256 === undefined || edge.evaluationTerminal !== undefined
      ) refuse("record-integrity", "evidence-closure", "successful evaluation lacks its exact Task/Submission/attempt/Delivery closure");
      if (separateInspectVerifier) {
        const closure = inspectClosureByCell.get(cell.cellKey);
        if (
          inspectEvaluationStrategy !== "separate-log-verification"
          || closure === undefined
          || closure.verdictOutput !== undefined
          || closure.summary.terminal !== "scored"
          || edge.evaluator === INSPECT_EMBEDDED_EVALUATOR_ID
        ) {
          refuse("record-integrity", "evidence-closure", "separate Inspect verification is not bound to a scored solve-only native-log closure");
        }
      }
    } else if (
      edge.evaluationTerminal !== "could-not-grade"
      || cell.evaluationTerminal !== "could-not-grade"
      || cell.verdicts.some((verdict) => verdict.evalIndex === edge.evalIndex)
    ) refuse("record-integrity", "evidence-closure", "terminal evaluation is outside its exact cell/index lineage");

    const carriesLineage = edge.evalTaskSha256 !== undefined
      || edge.evalSubmissionSha256 !== undefined || edge.evalAttempt !== undefined
      || edge.evalDeliverySha256 !== undefined;
    if (!embedded && !carriesLineage && edge.evaluator !== undefined) {
      refuse("record-integrity", "evidence-closure", "pre-evaluation terminal cannot claim an evaluator identity");
    }
    if (carriesLineage && !embedded && (edge.evaluator === undefined || edge.evalTaskSha256 === undefined)) {
      refuse("record-integrity", "evidence-closure", "partial evaluation lineage must name its evaluator and exact Task");
    }
    if (edge.evalAttempt !== undefined && edge.evalSubmissionSha256 === undefined) {
      refuse("record-integrity", "evidence-closure", "evaluation attempt has no accepted Submission lineage");
    }
    if (edge.evalDeliverySha256 !== undefined && edge.evalAttempt === undefined) {
      refuse("record-integrity", "evidence-closure", "evaluation Delivery has no attempt lineage");
    }

    const submission = edge.evalSubmissionSha256 === undefined
      ? undefined
      : evaluationSubmissionByDigest.get(edge.evalSubmissionSha256);
    if (edge.evalSubmissionSha256 !== undefined && submission === undefined) {
      refuse("record-integrity", "evidence-closure", "evaluation graph names an unknown accepted Submission");
    }
    if (submission !== undefined) {
      if (
        submission.cellKey !== edge.cellKey || submission.evalIndex !== edge.evalIndex
        || (submission.evaluationAttempt ?? 1) !== (edge.evaluationAttempt ?? 1)
        || submission.evalTaskSha256 !== edge.evalTaskSha256 || submission.evaluator !== edge.evaluator
      ) refuse("record-integrity", "evidence-closure", "evaluation graph and Submission linkage disagree");
      consumedEvaluationSubmissions.add(submission.sha256);
      addRole(expectedRoles, submission.sha256, "evaluation-submission");
    }
    if (edge.evalTaskSha256 !== undefined) addRole(expectedRoles, edge.evalTaskSha256, "evaluation-task");
    if (edge.evalTaskSha256 !== undefined) {
      const solveDelivery = solveDeliveryByCell.get(cell.cellKey);
      if (solveDelivery === undefined || cell.evaluationSpecSha256 === undefined) {
        refuse("record-integrity", "evidence-closure", `evaluation Task ${edge.evalTaskSha256} has no solve artifacts/spec source`);
      }
      const derived = deriveEvaluationTask({
        subjectTask: { name: "subject-task.json", digest: `sha256:${cell.taskDigest}` },
        subjectDelivery: { name: "subject-delivery.json", digest: `sha256:${solveDelivery.sha256}` },
        subjectResults: solveDelivery.outputs.map((output) => ({ name: output.name, digest: `sha256:${output.sha256}` as const })),
        evaluationSpecDigest: `sha256:${cell.evaluationSpecSha256}`,
      });
      const carried = records.get(edge.evalTaskSha256);
      if (carried === undefined || !equalBytes(carried, derived.bytes) || derived.digest !== `sha256:${edge.evalTaskSha256}`) {
        refuse("record-integrity", "evidence-closure", `evaluation Task ${edge.evalTaskSha256} is not the exact derivation from solve artifacts/spec`);
      }
    }
    if (edge.evalDeliverySha256 !== undefined) {
      addRole(expectedRoles, edge.evalDeliverySha256, "evaluation-delivery");
      const bytes = records.get(edge.evalDeliverySha256);
      if (bytes === undefined) refuse("record-integrity", "evidence-closure", `evaluation Delivery ${edge.evalDeliverySha256} bytes are missing`);
      const delivery = parseRecord(bytes, DeliveryRecordSchema, `records/${edge.evalDeliverySha256}.bin`);
      const verdictOutput = delivery.outputs.find((output) => output.name === "verdict");
      if (
        delivery.task !== `sha256:${edge.evalTaskSha256}` || delivery.attempt !== edge.evalAttempt
        || (successful && verdictOutput?.digest?.sha256 !== edge.verdictSha256)
      ) refuse("record-integrity", "evidence-closure", `evaluation Delivery ${edge.evalDeliverySha256} does not bind Task/attempt/verdict`);
    }
    if (edge.verdictSha256 !== undefined) {
      addRole(expectedRoles, edge.verdictSha256, "verdict");
      const edges = evaluationsByVerdict.get(edge.verdictSha256) ?? [];
      edges.push(edge);
      evaluationsByVerdict.set(edge.verdictSha256, edges);
    }
  }

  const maxInfrastructureRetries = run.policy.evaluation?.maxInfrastructureRetries ?? 0;
  const retriesByLeg = new Map<string, number[]>();
  const evaluationTaskByLeg = new Map<string, string>();
  for (const retry of assembly.header.graph.evaluationRetries ?? []) {
    const cell = cellsByKey.get(retry.cellKey);
    if (cell === undefined || retry.dispatch < 1 || retry.dispatch > cell.dispatches
      || retry.evalIndex < 1 || retry.evalIndex > minVerdicts) {
      refuse("record-integrity", "evidence-closure", "evaluation retry names an unknown or out-of-domain leg");
    }
    if (retry.evaluationAttempt < 1 || retry.evaluationAttempt > maxInfrastructureRetries) {
      refuse("record-integrity", "evidence-closure", "evaluation retry exceeds the sealed infrastructure retry policy");
    }
    if (retry.failureCategory !== "backend-unavailable"
      && retry.failureCategory !== "dependency-unavailable"
      && retry.failureCategory !== "transport-failure") {
      refuse("record-integrity", "evidence-closure", "evaluation retry carries an ineligible failure category");
    }
    const key = `${retry.cellKey}:${retry.evalIndex}`;
    const attempts = retriesByLeg.get(key) ?? [];
    attempts.push(retry.evaluationAttempt);
    retriesByLeg.set(key, attempts);
    const submission = retry.evalSubmissionSha256 === undefined
      ? undefined
      : evaluationSubmissionByDigest.get(retry.evalSubmissionSha256);
    if (retry.evalSubmissionSha256 !== undefined && submission === undefined) {
      refuse("record-integrity", "evidence-closure", "evaluation retry names an unknown accepted Submission");
    }
    if (submission !== undefined) {
      if (submission.cellKey !== retry.cellKey || submission.dispatch !== retry.dispatch
        || submission.evalIndex !== retry.evalIndex
        || (submission.evaluationAttempt ?? 1) !== retry.evaluationAttempt
        || submission.evaluator !== retry.evaluator
        || submission.evalTaskSha256 !== retry.evalTaskSha256) {
        refuse("record-integrity", "evidence-closure", "evaluation retry and Submission lineage disagree");
      }
      consumedEvaluationSubmissions.add(submission.sha256);
      addRole(expectedRoles, submission.sha256, "evaluation-submission");
    }
    if (retry.evalTaskSha256 !== undefined) {
      const priorTask = evaluationTaskByLeg.get(key);
      if (priorTask !== undefined && priorTask !== retry.evalTaskSha256) {
        refuse("record-integrity", "evidence-closure", "evaluation retry substituted a different derived Task");
      }
      evaluationTaskByLeg.set(key, retry.evalTaskSha256);
      addRole(expectedRoles, retry.evalTaskSha256, "evaluation-task");
      const solveDelivery = solveDeliveryByCell.get(retry.cellKey);
      if (solveDelivery === undefined || cell.evaluationSpecSha256 === undefined) {
        refuse("record-integrity", "evidence-closure", "evaluation retry Task has no solve artifacts/spec source");
      }
      const derived = deriveEvaluationTask({
        subjectTask: { name: "subject-task.json", digest: `sha256:${cell.taskDigest}` },
        subjectDelivery: { name: "subject-delivery.json", digest: `sha256:${solveDelivery.sha256}` },
        subjectResults: solveDelivery.outputs.map((output) => ({ name: output.name, digest: `sha256:${output.sha256}` as const })),
        evaluationSpecDigest: `sha256:${cell.evaluationSpecSha256}`,
      });
      const carried = records.get(retry.evalTaskSha256);
      if (carried === undefined || !equalBytes(carried, derived.bytes) || derived.digest !== `sha256:${retry.evalTaskSha256}`) {
        refuse("record-integrity", "evidence-closure", "evaluation retry Task is not the exact solve-derived Task");
      }
    }
  }
  for (const [key, attempts] of retriesByLeg) {
    const ordered = [...attempts].sort((left, right) => left - right);
    if (ordered.some((attempt, index) => attempt !== index + 1)) {
      refuse("record-integrity", "evidence-closure", `evaluation retry sequence is non-contiguous for ${key}`);
    }
  }
  for (const edge of assembly.header.graph.evaluations) {
    const evaluationAttempt = edge.evaluationAttempt ?? 1;
    if (evaluationAttempt > maxInfrastructureRetries + 1) {
      refuse("record-integrity", "evidence-closure", "evaluation terminal exceeds the sealed infrastructure retry policy");
    }
    if (evaluationAttempt > 1) {
      const key = `${edge.cellKey}:${edge.evalIndex}`;
      const attempts = [...(retriesByLeg.get(key) ?? [])].sort((left, right) => left - right);
      if (attempts.length !== evaluationAttempt - 1
        || attempts.some((attempt, index) => attempt !== index + 1)) {
        refuse("record-integrity", "evidence-closure", "evaluation retry terminal lacks its complete failed-attempt lineage");
      }
      const priorTask = evaluationTaskByLeg.get(key);
      if (priorTask !== undefined && edge.evalTaskSha256 !== undefined && priorTask !== edge.evalTaskSha256) {
        refuse("record-integrity", "evidence-closure", "evaluation retry terminal substituted a different derived Task");
      }
    }
  }
  if (consumedEvaluationSubmissions.size !== evaluationSubmissionByDigest.size) {
    refuse("record-integrity", "evidence-closure", "evaluation graph does not consume every exact Submission lineage");
  }

  const receipts = new Map<string, LocalAdmissionReceiptFact>();
  const consumedSuccessfulEvaluations = new Set<string>();
  const inScopeCells: InScopeCell[] = expectedCoordinates.map((coord) => {
    const cell = cellsByKey.get(coord.cellKey);
    if (cell === undefined || cell.armId !== coord.armId || cell.replicate !== coord.replicate || cell.taskDigest !== coord.taskDigest) {
      refuse("record-integrity", "evidence-closure", `assembly coordinate mismatch for ${coord.cellKey}`);
    }
    const task = taskSpecs.get(cell.taskDigest)!;
    if (task.evaluation?.digest?.sha256 !== cell.evaluationSpecSha256) refuse("record-integrity", "evidence-closure", `${cell.cellKey} Task and EvaluationSpec identities disagree`);
    const admission = admissionByTask.get(cell.taskDigest);
    if (
      (admission === undefined) !== (cell.admission === undefined)
      || admission?.receiptSha256 !== cell.admissionReceiptSha256
      || (admission !== undefined && !equalBytes(canonicalJsonBytes(admission.fact), canonicalJsonBytes(cell.admission)))
    ) refuse("record-integrity", "evidence-closure", `${cell.cellKey} admission receipt/fact linkage disagrees`);
    if (admission !== undefined) receipts.set(cell.taskDigest, admission.fact);
    const finalSubmission = cell.submissionSha256 === undefined ? undefined : solveSubmissionByCoordinate.get(`${cell.cellKey}:${cell.dispatches}`);
    if ((cell.submissionSha256 === undefined) !== (finalSubmission === undefined)) refuse("record-integrity", "evidence-closure", `${cell.cellKey} final solve Submission linkage disagrees`);
    if (finalSubmission !== undefined && finalSubmission.sha256 !== cell.submissionSha256) refuse("record-integrity", "evidence-closure", `${cell.cellKey} final solve Submission digest disagrees`);
    if (finalSubmission?.pinningEvidenceSha256 !== cell.pinningEvidenceSha256) {
      refuse("record-integrity", "evidence-closure", `${cell.cellKey} final run-pinning evidence linkage disagrees`);
    }
    let pinningEvidence: RunPinningEvidence | undefined;
    if (cell.pinningEvidenceSha256 !== undefined) {
      pinningEvidence = pinningEvidenceByDigest.get(cell.pinningEvidenceSha256);
      if (pinningEvidence === undefined) refuse("record-integrity", "evidence-closure", `${cell.cellKey} run-pinning evidence bytes are missing or unreachable`);
    }
    const finalDelivery = solveDeliveryByCell.get(cell.cellKey);
    if ((cell.deliverySha256 === undefined) !== (finalDelivery === undefined)) refuse("record-integrity", "evidence-closure", `${cell.cellKey} final solve Delivery linkage disagrees`);
    if (finalDelivery !== undefined && (
      finalDelivery.cellKey !== cell.cellKey || finalDelivery.attempt !== cell.attempt
      || !equalBytes(canonicalJsonBytes(finalDelivery.outputs), canonicalJsonBytes(cell.solveOutputs ?? []))
    )) refuse("record-integrity", "evidence-closure", `${cell.cellKey} solve Delivery/output linkage disagrees`);
    const evaluationSpec = cell.evaluationSpecSha256 === undefined ? undefined : evaluationSpecs.get(cell.evaluationSpecSha256);
    const verdicts: InScopeVerdict[] = cell.verdicts.map((declared) => {
      const edges = evaluationsByVerdict.get(declared.sha256)?.filter((candidate) =>
        candidate.cellKey === cell.cellKey
        && candidate.evalIndex === declared.evalIndex
        && candidate.evaluator === declared.evaluator
        && candidate.relationship === declared.relationship
        && candidate.evalTaskSha256 === declared.evalTaskSha256
        && candidate.evalSubmissionSha256 === declared.evalSubmissionSha256
        && candidate.evalDeliverySha256 === declared.evalDeliverySha256
        && candidate.evalAttempt === declared.evalAttempt
      );
      const edge = edges?.[0];
      if (edges?.length !== 1 || edge === undefined || edge.relationship !== declared.relationship
        || edge.evalTaskSha256 !== declared.evalTaskSha256
        || edge.evalSubmissionSha256 !== declared.evalSubmissionSha256
        || edge.evalDeliverySha256 !== declared.evalDeliverySha256
        || edge.evalAttempt !== declared.evalAttempt || edge.evalIndex !== declared.evalIndex) {
        refuse("record-integrity", "evidence-closure", `verdict ${declared.sha256} evaluation graph linkage disagrees`);
      }
      consumedSuccessfulEvaluations.add(`${edge.cellKey}:${edge.evalIndex}`);
      const verdictBytes = records.get(declared.sha256);
      if (verdictBytes === undefined) refuse("record-integrity", "evidence-closure", `verdict ${declared.sha256} bytes are missing`);
      const view = readVerdictEnvelope(verdictBytes);
      const binaryJudgmentCell = qualification !== undefined
        || taskSpecs.get(cell.taskDigest)?.profile.uri === BINARY_JUDGMENT_PROFILE_URI;
      if (!binaryJudgmentCell && declared.relationship === "same-execution-scorer" && (
        view.evaluatorExtensions?.["jinn.network/relationship"] !== "same-execution-scorer"
        || !view.limitations?.includes("same-execution-scorer")
      )) {
        refuse("record-integrity", "evidence-closure", `verdict ${declared.sha256} does not disclose its same-execution scorer relationship`);
      }
      if (declared.relationship === "separate-log-verifier") {
        const closure = inspectClosureByCell.get(cell.cellKey);
        if (closure === undefined) {
          refuse("record-integrity", "evidence-closure", `verdict ${declared.sha256} has no Inspect solve closure`);
        }
        const requiredLimitations = [
          "score-source:same-execution-scorer",
          "verification-process:separate",
          "self-run-operator-custody",
          "not-independent-rescoring",
          "not-separate-real-world-party",
          "not-method-diversity",
        ];
        const expectedMethod = inspectLogVerifierMethod(closure.selection, closure.selectionSha256);
        const expectedMeasurements = closure.summary.schema === "jinn.network/benchmark-product/inspect-cell-summary/1"
          ? [{ name: "inspect-score-pass", value: closure.summary.measurement! }]
          : closure.summary.measurements.map((measurement) => ({
            name: measurement.measurementName,
            value: measurement.value!,
          }));
        if (
          closure.summary.verdict !== view.verdict
          || view.evaluatorId === INSPECT_EMBEDDED_EVALUATOR_ID
          || view.evaluationMethod?.name !== expectedMethod.name
          || view.evaluationMethod.sha256 !== expectedMethod.digest.sha256
          || requiredLimitations.some((limitation) => !view.limitations?.includes(limitation))
          || !equalBytes(
            canonicalJsonBytes(readOrderedVerdictMeasurements(verdictBytes)),
            canonicalJsonBytes(expectedMeasurements),
          )
          || !view.evidence?.some((evidence) =>
            evidence.name === "inspect-native-log"
            && evidence.sha256 === closure.nativeLog.sha256
            && evidence.mediaType === "application/vnd.inspect-ai.eval")
        ) {
          refuse("record-integrity", "evidence-closure", `verdict ${declared.sha256} is not the locked separate Inspect log verification claim`);
        }
      }
      if (
        view.evaluatorId !== declared.evaluator || view.verdict !== declared.verdict
        || view.evaluationSpecificationSha256 !== declared.evaluationSpecSha256
        || !equalBytes(canonicalJsonBytes(view.measurements), canonicalJsonBytes(declared.measurements))
      ) refuse("record-integrity", "evidence-closure", `assembly facts disagree with verdict ${declared.sha256}`);
      return {
        digest: `sha256:${declared.sha256}`,
        record: { evaluationSpecification: `sha256:${view.evaluationSpecificationSha256}`, evaluator: view.evaluatorId, verdict: view.verdict },
        measurements: view.measurements,
        ...(evaluationSpec === undefined ? {} : { evaluationSpec }),
      };
    });
    return {
      cellKey: cell.cellKey,
      armId: cell.armId,
      replicate: cell.replicate,
      taskDigest: cell.taskDigest,
      dispatches: cell.dispatches,
      ...(cell.accounted === undefined ? {} : { accounted: cell.accounted }),
      ...(cell.submissionSha256 === undefined ? {} : { submissionDigest: `sha256:${cell.submissionSha256}` as const }),
      ...(pinningEvidence === undefined ? {} : { evidenceRef: pinningEvidenceFacts(pinningEvidence) }),
      ...(cell.attempt === undefined ? {} : { attempt: cell.attempt }),
      ...(cell.deliverySha256 === undefined ? {} : { deliveryDigest: `sha256:${cell.deliverySha256}` as const, deliveryBytes: records.get(cell.deliverySha256) }),
      ...(cell.evaluationSpecSha256 === undefined ? {} : { evaluationSpecDigest: `sha256:${cell.evaluationSpecSha256}` }),
      ...(evaluationSpec === undefined ? {} : { evaluationSpec }),
      ...(cell.evaluationTerminal === undefined ? {} : { evaluationTerminal: cell.evaluationTerminal }),
      verdicts,
    };
  });

  const successfulEvaluationCount = assembly.header.graph.evaluations.filter((edge) => edge.verdictSha256 !== undefined).length;
  if (successfulEvaluationCount !== consumedSuccessfulEvaluations.size) {
    refuse("record-integrity", "evidence-closure", "evaluation graph contains a successful lineage not consumed by an exact cell verdict");
  }

  if (expectedRoles.size !== declaredRoles.size) refuse("record-integrity", "evidence-closure", "evidence catalog contains missing or unreachable records");
  for (const [digest, roles] of expectedRoles) {
    const declared = declaredRoles.get(digest);
    if (declared === undefined || !equalBytes(canonicalJsonBytes(sorted(roles)), canonicalJsonBytes(sorted(declared)))) {
      refuse("record-integrity", "evidence-closure", `record ${digest} roles do not equal its derived graph roles`);
    }
  }

  const verdictCatalogBytes = read("verdicts.json");
  const verdictCatalog = parseJson(verdictCatalogBytes, BundleVerdictCatalogSchema, "verdicts.json");
  requireCanonical(verdictCatalogBytes, verdictCatalog, "verdicts.json");
  unique(verdictCatalog.verdicts.map((verdict) => verdict.sha256), "verdicts.json.verdicts");
  const expectedVerdictCells = new Map<string, Set<string>>();
  for (const cell of matrix.cells) for (const digest of cell.verdicts) {
    const hex = digest.slice("sha256:".length);
    const set = expectedVerdictCells.get(hex) ?? new Set<string>();
    set.add(cell.cellKey);
    expectedVerdictCells.set(hex, set);
  }
  if (expectedVerdictCells.size !== verdictCatalog.verdicts.length) refuse("record-integrity", "verdicts.json", "verdict catalog does not match Matrix verdict closure");
  for (const verdict of verdictCatalog.verdicts) {
    const cells = expectedVerdictCells.get(verdict.sha256);
    if (cells === undefined || !equalBytes(canonicalJsonBytes([...cells].sort()), canonicalJsonBytes(verdict.cellKeys))) {
      refuse("record-integrity", "verdicts.json", `verdict ${verdict.sha256} cell references do not match Matrix`);
    }
    const bytes = records.get(verdict.sha256);
    if (bytes === undefined || readVerdictEnvelope(bytes).evaluatorId !== verdict.evaluator) refuse("record-integrity", "verdicts.json", `verdict ${verdict.sha256} evaluator mismatch`);
  }
  checks.push("evidence-closure");

  const derivedReportDid = didKeyFromEd25519PublicKey(reportKey);
  if (trust.report.author !== report.author || trust.report.keyId !== derivedReportDid || trust.report.didKey !== derivedReportDid) {
    refuse("record-integrity", "trust", "Report author/keyId/didKey are not derived from the bundled Report SPKI");
  }
  unique(trust.evaluators.map((entry) => entry.evaluator), "trust.evaluators.evaluator");
  const admissionReviewerEvaluators = qualification === undefined
    ? []
    : BundleV4TrustSchema.parse(trust).admission.reviewers.map((entry) => entry.evaluator);
  const referencedEvaluators = [...new Set([
    ...verdictCatalog.verdicts.map((verdict) => verdict.evaluator),
    ...admissionReviewerEvaluators,
  ])].sort();
  const trustedEvaluators = trust.evaluators.map((entry) => entry.evaluator).sort();
  if (!equalBytes(canonicalJsonBytes(referencedEvaluators), canonicalJsonBytes(trustedEvaluators))) {
    refuse("record-integrity", "trust", "evaluator trust set must exactly equal Matrix-referenced evaluators");
  }
  const evaluatorKeys = new Map<string, AssemblyPublicKeyRecord>();
  const spkiIdentities = new Set<string>([sha256(Buffer.from(trust.report.spkiDerBase64, "base64"))]);
  for (const entry of trust.evaluators) {
    const key = publicKey(entry.spkiDerBase64, `trust.evaluators.${entry.evaluator}`);
    const derivedKeyId = verdictKeyIdFromEd25519PublicKey(key);
    if (entry.keyId !== derivedKeyId) refuse("record-integrity", "trust", `evaluator ${entry.evaluator} keyId is not derived from its SPKI`);
    const spkiIdentity = sha256(Buffer.from(entry.spkiDerBase64, "base64"));
    if (spkiIdentities.has(spkiIdentity)) refuse("record-integrity", "trust", "one SPKI is reused under multiple bundled identities");
    spkiIdentities.add(spkiIdentity);
    evaluatorKeys.set(entry.evaluator, { keyId: entry.keyId, publicKey: key });
  }
  for (const verdict of verdictCatalog.verdicts) {
    const key = evaluatorKeys.get(verdict.evaluator);
    if (key === undefined || key.keyId !== verdict.keyId) refuse("record-integrity", "trust", `verdict ${verdict.sha256} keyId cross-validation failed`);
  }
  checks.push("trust");

  const resolveBytes = (digest: string): Uint8Array => {
    const hex = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
    const bytes = records.get(hex)
      ?? (hex === identities.benchmarkSha256 ? benchmarkBytes : undefined)
      ?? (hex === identities.runSha256 ? runBytes : undefined)
      ?? (hex === identities.matrixSha256 ? matrixBytes : undefined)
      ?? (hex === identities.reportSha256 ? reportBytes : undefined)
      ?? (hex === identities.reportEnvelopeSha256 ? envelopeBytes : undefined);
    if (bytes === undefined) refuse("record-integrity", "evidence-closure", `bundle does not carry referenced record ${digest}`);
    return bytes;
  };
  const ports = buildAssemblyPortsFromFacts({
    runRecord: run,
    cells: inScopeCells,
    owner: run.owner,
    runCancelled: assembly.header.runCancelled,
    receiptsByTaskDigest: receipts,
    resolveBytes,
    evaluatorKeys: () => evaluatorKeys,
  });
  const verifiedMatrix = await verifyMatrix(matrix, benchmark, run, ports, undefined, matrixBytes);
  if (!verifiedMatrix.ok) refuse("record-integrity", "matrix-rederivation", `${verifiedMatrix.check}: ${verifiedMatrix.detail}`);
  checks.push("matrix-rederivation");

  const verifiedReport = await verifyReport(
    { envelopeBytes, subjects: [matrixBytes], effectiveTime: trust.report.validFrom },
    {
      ...buildMethodPortsFromResolver((digest) => {
        try { return resolveBytes(digest); } catch { return undefined; }
      }),
      trust: buildPublicReportTrustDeps({ report: trust.report, bindingEnvelopeBytes: trustBytes }),
    },
  );
  if (!verifiedReport.ok) refuse("record-integrity", "report-verification", `${verifiedReport.check}: ${verifiedReport.detail}`);
  if (!equalBytes(canonicalJsonBytes(verifiedReport.record), reportBytes)) refuse("record-integrity", "report-verification", "verified Report payload does not match report.json");
  checks.push("report-verification");
  assertClaimConsistency({
    claim,
    identities,
    benchmarkRecord: benchmark,
    runRecord: run,
    matrixRecord: matrix,
    reportRecord: verifiedReport.record,
    draftId: assembly.header.draftId,
    assurancePreset: assembly.header.assurancePreset,
    ...(inspectSelections.size > 0 && inspectEvaluationStrategy === "separate-log-verification"
      ? { additionalLimitations: INSPECT_SEPARATE_ASSURANCE_LIMITATIONS }
      : {}),
    ...(assembly.header.rehearsal === undefined ? {} : { rehearsal: assembly.header.rehearsal }),
    ...(claimAnchors === undefined ? {} : { anchors: claimAnchors }),
  });
  checks.push("claim-consistency");
  // Always present for this closure version, and never for any earlier one: an anchored bundle
  // whose anchors were stripped is a closure failure above, not a shorter check list here.
  if (isV6) checks.push("integrity-anchors");

  const dissentCellKeys = assembly.cells
    .filter((cell) => new Set(cell.verdicts.map((verdict) => verdict.verdict)).size > 1)
    .map((cell) => cell.cellKey)
    .sort();
  const comparison = qualification === undefined
    ? derivePublicComparison({
      benchmark,
      matrix,
      assemblyCells: assembly.cells,
      recordBytes: records,
    })
    : undefined;
  const assetFacts = {
    claim,
    matrix,
    report: verifiedReport.record,
    reportSha256: identities.reportSha256,
    matrixSha256: identities.matrixSha256,
    recordSha256s: checked.manifest.files.flatMap((file) => {
      const match = /^records\/([a-f0-9]{64})\.bin$/u.exec(file.path);
      return match === null ? [] : [match[1]!];
    }),
    dissentCellKeys,
  };
  // Reader v1 remains able to authenticate bundles published before the
  // human comparison projection existed. A bundle must match one complete,
  // deterministic presentation profile; individual assets cannot be mixed.
  const legacyAssets = qualification === undefined ? buildPublicAssets(assetFacts) : undefined;
  const isLegacyPresentation = legacyAssets !== undefined
    && Object.entries(legacyAssets).every(([path, bytes]) => equalBytes(read(path), bytes));
  const expectedAssets = qualification !== undefined
    ? buildPublicAssets({ ...assetFacts, binaryQualification: binaryAssetQualification })
    : isLegacyPresentation
      ? legacyAssets!
      : buildPublicAssets({ ...assetFacts, comparison });
  for (const [path, bytes] of Object.entries(expectedAssets)) {
    if (!equalBytes(read(path), bytes)) refuse("record-integrity", path, `${path} is not the exact projection of verified public facts`);
  }
  const bundledInspectSelections = [...inspectSelections.entries()];
  const bundledInspectSelection = bundledInspectSelections.length === 1
    ? bundledInspectSelections[0]
    : undefined;
  const runtimeMethod = bundledInspectSelection === undefined
    ? undefined
    : describeInspectRuntimeMethod(
      bundledInspectSelection[1],
      bundledInspectSelection[0],
      run.policy.evaluation,
    );
  return {
    verification: {
      format: checked.manifest.format,
      identity: checked.identity,
      checks,
      ...identities,
      ...(runtimeMethod === undefined ? {} : { runtimeMethod }),
      ...(anchorReport === undefined ? {} : { anchors: anchorReport }),
      ...(qualification === undefined ? {} : {
        qualification: {
          publicationGrade: qualification.publicationGrade,
          truthAdmission: qualification.truthAdmission,
          candidateClasses: qualification.candidateClasses,
          strata: qualification.strata,
          // Derived, not declared (spec §1.6 rule 4): a count that is a constant is not a count.
          armCount: qualification.arms.length,
          itemCount: qualification.items.length,
          exclusionCount: qualification.exclusions.length,
        },
      }),
    },
    ...(comparison === undefined ? {} : { comparison }),
    snapshot: checked,
  };
}

/** Verifies a bundle without exposing its authenticated byte snapshot. */
export async function verifyPublicBundle(
  bundleDir: string,
  deps: VerifyPublicBundleDeps = {},
): Promise<PublicBundleVerificationResult> {
  return (await verifyPublicBundleSnapshot(bundleDir, deps)).verification;
}
