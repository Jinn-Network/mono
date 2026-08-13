import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { verifyReport } from "@jinn-network/benchmarking-aggregate";
import { exportStaticBundle } from "@jinn-network/benchmarking-interop";
import {
  cellIdempotencyKey,
  expectedCellSet,
  parseBenchmark,
  parseMatrix,
  parseReport,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { verifyMatrix, type InScopeCell, type InScopeVerdict } from "@jinn-network/benchmarking-run";
import { deriveEvaluationTask, parseEvaluationSpec } from "@jinn-network/task-execution-profiles";
import { DeliveryRecordSchema, SubmissionRecordSchema, TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
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
import { assertClaimConsistency } from "./profile/claim-consistency.js";
import { buildPublicAssets } from "./assets.js";
import {
  verifyBundleSnapshot,
  type VerifiedBundleSnapshot,
  type VerifyBundleSnapshotDeps,
} from "./manifest.js";
import { PUBLIC_BUNDLE_FILES } from "./materialize.js";
import {
  BundleAssemblyCellSchema,
  BundleAssemblyHeaderSchema,
  BundleCancelMarkerSchema,
  BundleEvidenceCatalogSchema,
  BundleTrustSchema,
  BundleVerdictCatalogSchema,
  type BundleAssemblyCell,
  type BundleAssemblyHeader,
  type BundleEvidenceCatalog,
} from "./schema.js";

export type PublicBundleVerificationCheck =
  | "manifest"
  | "evidence-closure"
  | "trust"
  | "matrix-rederivation"
  | "report-verification"
  | "claim-consistency";

export interface PublicBundleVerificationResult {
  readonly identity: string;
  readonly checks: readonly PublicBundleVerificationCheck[];
  readonly benchmarkSha256: string;
  readonly runSha256: string;
  readonly matrixSha256: string;
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
  readonly runtimeMethod?: InspectRuntimeMethodDisclosure;
}

export interface VerifyPublicBundleDeps extends VerifyBundleSnapshotDeps {}

/**
 * One semantically verified result bound to the exact authenticated bytes used
 * to derive it. Consumers such as the local reader must serve these bytes
 * rather than reopening bundle paths after verification.
 */
export interface VerifiedPublicBundleSnapshot {
  readonly verification: PublicBundleVerificationResult;
  readonly snapshot: VerifiedBundleSnapshot;
}

type EvidenceRole = BundleEvidenceCatalog["records"][number]["roles"][number];

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

/** Verifies a copied public bundle using one authenticated byte snapshot and only bundle-carried
 * public keys. No pathname is reopened after manifest authentication. */
export async function verifyPublicBundleSnapshot(
  bundleDir: string,
  deps: VerifyPublicBundleDeps = {},
): Promise<VerifiedPublicBundleSnapshot> {
  const checked = verifyBundleSnapshot(bundleDir, deps);
  const read = (path: string): Uint8Array => {
    const bytes = checked.fileBytes.get(path);
    if (bytes === undefined) refuse("record-integrity", path, `authenticated bundle snapshot is missing "${path}"`);
    return bytes;
  };
  const checks: PublicBundleVerificationCheck[] = ["manifest"];
  const manifestPaths = new Set(checked.manifest.files.map((file) => file.path));
  for (const path of PUBLIC_BUNDLE_FILES) {
    if (!manifestPaths.has(path)) refuse("record-integrity", path, `mandatory public bundle file "${path}" is missing`);
  }

  const evidenceBytes = read("evidence.json");
  const evidence = parseJson(evidenceBytes, BundleEvidenceCatalogSchema, "evidence.json");
  requireCanonical(evidenceBytes, evidence, "evidence.json");
  unique(evidence.records.map((record) => record.sha256), "evidence.json.records");
  for (const record of evidence.records) unique(record.roles, `evidence.json.records.${record.sha256}.roles`);
  const expectedPaths = new Set<string>([
    ...PUBLIC_BUNDLE_FILES,
    ...evidence.records.map((record) => `records/${record.sha256}.bin`),
  ]);
  if (manifestPaths.has("verification/cancel-requested.json")) expectedPaths.add("verification/cancel-requested.json");
  for (const path of manifestPaths) {
    if (/^native\/inspect\/[a-f0-9]{64}\.eval$/u.test(path)) expectedPaths.add(path);
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
        arm,
        nativeLog,
        ...(verdictOutput === undefined ? {} : { verdictOutput }),
      });
    }
  }

  unique(assembly.header.graph.evaluationSubmissions.map((edge) => `${edge.cellKey}:${edge.evalIndex}`), "verification.graph.evaluationSubmissions.coordinates");
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
    const expectedNonce = `eval:${identities.runSha256}:e${edge.evalIndex}:${edge.cellKey}:${edge.dispatch}`;
    if (
      submission.task.digest?.sha256 !== edge.evalTaskSha256
      || submission.nonce !== expectedNonce || submission.idempotencyKey !== expectedNonce
      || submission.requirements?.[EVALUATOR_REQUIREMENT_KEY] !== edge.evaluator
    ) refuse("record-integrity", "evidence-closure", `evaluation Submission ${edge.sha256} does not bind its Task/cell/evaluator`);
    evaluationSubmissionByDigest.set(edge.sha256, edge);
  }

  unique(assembly.header.graph.evaluations.map((edge) => `${edge.cellKey}:${edge.evalIndex}`), "verification.graph.evaluations.coordinates");
  const evaluationsByVerdict = new Map<string, Array<(typeof assembly.header.graph.evaluations)[number]>>();
  const consumedEvaluationSubmissions = new Set<string>();
  for (const edge of assembly.header.graph.evaluations) {
    const cell = cellsByKey.get(edge.cellKey);
    if (cell === undefined) refuse("record-integrity", "evidence-closure", "evaluation graph names an unknown cell");
    if (edge.evalIndex < 1 || edge.evalIndex > minVerdicts) refuse("record-integrity", "evidence-closure", "evaluation graph index is outside Run policy");
    const successful = edge.verdictSha256 !== undefined;
    const embedded = edge.relationship === "same-execution-scorer";
    if (successful) {
      if (embedded) {
        if (
          edge.evaluator !== INSPECT_EMBEDDED_EVALUATOR_ID
          || edge.evalTaskSha256 !== undefined || edge.evalSubmissionSha256 !== undefined
          || edge.evalAttempt !== undefined || edge.evalDeliverySha256 !== undefined
          || edge.evaluationTerminal !== undefined
        ) refuse("record-integrity", "evidence-closure", "same-execution Inspect score carries false separate-evaluator lineage");
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
      } else if (
        edge.evaluator === undefined || edge.evalTaskSha256 === undefined
        || edge.evalSubmissionSha256 === undefined || edge.evalAttempt === undefined
        || edge.evalDeliverySha256 === undefined || edge.evaluationTerminal !== undefined
      ) refuse("record-integrity", "evidence-closure", "successful evaluation lacks its exact Task/Submission/attempt/Delivery closure");
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
      if (declared.relationship === "same-execution-scorer" && (
        view.evaluatorExtensions?.["jinn.network/relationship"] !== "same-execution-scorer"
        || !view.limitations?.includes("same-execution-scorer")
      )) {
        refuse("record-integrity", "evidence-closure", `verdict ${declared.sha256} does not disclose its same-execution scorer relationship`);
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

  const trustBytes = read("trust/public-keys.json");
  const trust = parseJson(trustBytes, BundleTrustSchema, "trust/public-keys.json");
  requireCanonical(trustBytes, trust, "trust/public-keys.json");
  const reportKey = publicKey(trust.report.spkiDerBase64, "trust.report.spkiDerBase64");
  const derivedReportDid = didKeyFromEd25519PublicKey(reportKey);
  if (trust.report.author !== report.author || trust.report.keyId !== derivedReportDid || trust.report.didKey !== derivedReportDid) {
    refuse("record-integrity", "trust", "Report author/keyId/didKey are not derived from the bundled Report SPKI");
  }
  unique(trust.evaluators.map((entry) => entry.evaluator), "trust.evaluators.evaluator");
  const referencedEvaluators = [...new Set(verdictCatalog.verdicts.map((verdict) => verdict.evaluator))].sort();
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
    ...(assembly.header.rehearsal === undefined ? {} : { rehearsal: assembly.header.rehearsal }),
  });
  checks.push("claim-consistency");

  const dissentCellKeys = assembly.cells
    .filter((cell) => new Set(cell.verdicts.map((verdict) => verdict.verdict)).size > 1)
    .map((cell) => cell.cellKey)
    .sort();
  const expectedAssets = buildPublicAssets({
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
  });
  for (const [path, bytes] of Object.entries(expectedAssets)) {
    if (!equalBytes(read(path), bytes)) refuse("record-integrity", path, `${path} is not the exact projection of verified public facts`);
  }
  const bundledInspectSelections = [...inspectSelections.entries()];
  const bundledInspectSelection = bundledInspectSelections.length === 1
    ? bundledInspectSelections[0]
    : undefined;
  const runtimeMethod = bundledInspectSelection === undefined
    ? undefined
    : describeInspectRuntimeMethod(bundledInspectSelection[1], bundledInspectSelection[0]);
  return {
    verification: {
      identity: checked.identity,
      checks,
      ...identities,
      ...(runtimeMethod === undefined ? {} : { runtimeMethod }),
    },
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
