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
  expectedCellSet,
  itemTaskDigest,
  parseBenchmark,
  parseMatrix,
  parseReport,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { exportStaticBundle } from "@jinn-network/benchmarking-interop";
import { SubmissionRecordSchema } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, dssePreAuthEncoding, parseDsseEnvelope } from "@jinn-network/trust-core";
import { refuse } from "../errors.js";
import { parseDraftDocument } from "../domain/draft.js";
import { atomicWriteFileSync, fsyncDirectorySync } from "../fs/atomic.js";
import { ClaimPackageSchema } from "../report/claim.js";
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
import { buildBundleManifest, verifyBundleManifest } from "./manifest.js";
import { buildPublicAssets } from "./assets.js";
import {
  BUNDLE_ASSEMBLY_FORMAT,
  BUNDLE_EVIDENCE_FORMAT,
  BUNDLE_TRUST_FORMAT,
  BUNDLE_VERDICTS_FORMAT,
  BundleAssemblyCellSchema,
  BundleAssemblyHeaderSchema,
  BundleEvidenceCatalogSchema,
  BundleTrustSchema,
  BundleVerdictCatalogSchema,
  type BundleAssemblyCell,
  type BundleAssemblyHeader,
  type BundleEvidenceCatalog,
  type BundleTrust,
  type BundleVerdictCatalog,
} from "./schema.js";
import { EVALUATOR_REQUIREMENT_KEY } from "../venue/venue.js";
import { INSPECT_EMBEDDED_EVALUATOR_ID } from "../runtime/inspect/artifacts.js";
import { INSPECT_ADAPTER_ID, InspectSelectionManifestSchema } from "../runtime/inspect/manifest.js";

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

const ROLE_ORDER: readonly BundleEvidenceCatalog["records"][number]["roles"][number][] = [
  "task",
  "runtime-selection",
  "evaluation-spec",
  "admission-receipt",
  "solve-submission",
  "evaluation-submission",
  "solve-delivery",
  "solve-output",
  "evaluation-task",
  "evaluation-delivery",
  "verdict",
];

export interface MaterializeBundleInput {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly benchmarkSha256: string;
  readonly runState: RunState;
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
  records: Map<string, Set<BundleEvidenceCatalog["records"][number]["roles"][number]>>,
  sha256: string,
  role: BundleEvidenceCatalog["records"][number]["roles"][number],
): void {
  const roles = records.get(sha256) ?? new Set();
  roles.add(role);
  records.set(sha256, roles);
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
  readonly evidenceRecords: Map<string, Set<BundleEvidenceCatalog["records"][number]["roles"][number]>>;
} {
  const { workspaceDir, draftId, benchmarkSha256, runState } = input;
  if (
    runState.runSha256 === undefined
    || runState.matrixSha256 === undefined
    || runState.reportSha256 === undefined
    || runState.reportEnvelopeSha256 === undefined
    || runState.reportedAt === undefined
  ) {
    refuse("conflict", `runs.${draftId}`, "reported run is missing its Run, Matrix, Report, or Report envelope identity");
  }

  const benchmarkBytes = getSealedBytes(workspaceDir, benchmarkSha256);
  const runBytes = getSealedBytes(workspaceDir, runState.runSha256);
  const matrixBytes = getSealedBytes(workspaceDir, runState.matrixSha256);
  const reportBytes = getSealedBytes(workspaceDir, runState.reportSha256);
  const reportEnvelopeBytes = getSealedBytes(workspaceDir, runState.reportEnvelopeSha256);
  const benchmark = parseBenchmark(benchmarkBytes);
  const run = parseRun(runBytes);
  const matrix = parseMatrix(matrixBytes);
  const report = parseReport(reportBytes);
  const draft = parseDraftDocument(JSON.parse(readFileSync(draftPath(workspaceDir, draftId), "utf8")));
  const embeddedInspect = draft.spec.evaluationRuntime?.adapterId === INSPECT_ADAPTER_ID;
  const inspectSelectionSha256 = embeddedInspect
    ? draft.spec.evaluationRuntime?.selectionManifestSha256
    : undefined;
  if (embeddedInspect) {
    if (inspectSelectionSha256 === undefined) {
      refuse("record-integrity", "evidence-closure", "Inspect draft has no sealed runtime selection identity");
    }
    const selectionBytes = getSealedBytes(workspaceDir, inspectSelectionSha256);
    exactJson(selectionBytes, InspectSelectionManifestSchema, `records/${inspectSelectionSha256}.bin`);
  }

  const claimBytes = new Uint8Array(readFileSync(claimPackageArtifactPath(workspaceDir, draftId)));
  const claim = exactJson(claimBytes, ClaimPackageSchema, "claim-package.json");
  const files = new Map<string, Uint8Array>([
    ["benchmark.json", benchmarkBytes],
    ["run.json", runBytes],
    ["matrix.json", matrixBytes],
    ["report.json", reportBytes],
    ["report-envelope.json", reportEnvelopeBytes],
    ["claim-package.json", claimBytes],
    ["static-bundle.json", canonicalJsonBytes(exportStaticBundle(matrix, [report]))],
  ]);

  const evidenceRecords = new Map<string, Set<BundleEvidenceCatalog["records"][number]["roles"][number]>>();
  const receipts = scanPredictionSnapshotAdmissionReceiptRecords(workspaceDir);
  const benchmarkTaskDigests = new Set(benchmark.items.map((item) => itemTaskDigest(item)));
  for (const item of benchmark.items) {
    const taskSha256 = itemTaskDigest(item);
    addRole(evidenceRecords, taskSha256, "task");
    const task = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(getSealedBytes(workspaceDir, taskSha256))) as {
      evaluation?: { digest?: { sha256?: string } };
      payload?: { selectionManifestSha256?: unknown };
    };
    if (embeddedInspect) {
      if (task.payload?.selectionManifestSha256 !== inspectSelectionSha256) {
        refuse("record-integrity", "evidence-closure", `Inspect Task ${taskSha256} does not bind the draft's sealed runtime selection`);
      }
      addRole(evidenceRecords, inspectSelectionSha256!, "runtime-selection");
    }
    const evaluationSpecSha256 = task.evaluation?.digest?.sha256;
    if (evaluationSpecSha256 !== undefined) addRole(evidenceRecords, evaluationSpecSha256, "evaluation-spec");
    const receipt = receipts.get(taskSha256);
    if (receipt !== undefined) addRole(evidenceRecords, receipt.sha256, "admission-receipt");
  }

  const journal = readRunJournalEntries(workspaceDir, draftId);
  const graph: BundleAssemblyHeader["graph"] = {
    // A workspace is a multi-run CAS. Only receipts reachable from this Benchmark belong in
    // this bundle's exact graph; unrelated valid receipts must not leak into its public closure.
    admissions: [...receipts]
      .filter(([taskSha256]) => benchmarkTaskDigests.has(taskSha256))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taskSha256, receipt]) => ({ taskSha256, receiptSha256: receipt.sha256 })),
    solveSubmissions: [],
    evaluationSubmissions: [],
    solveDeliveries: [],
    evaluations: [],
  };
  const evaluationEvidenceByVerdict = new Map<string, {
    relationship?: "same-execution-scorer";
    evalTaskSha256?: string;
    evalSubmissionSha256?: string;
    evalDeliverySha256?: string;
    evalAttempt?: string;
    evalIndex: number;
  }>();
  for (const entry of journal) {
    if (entry.kind === "submission-accepted") {
      const isEvaluation = entry.leg === "evaluation";
      addRole(evidenceRecords, entry.submissionSha256, isEvaluation ? "evaluation-submission" : "solve-submission");
      if (!isEvaluation) {
        graph.solveSubmissions.push({ cellKey: entry.cellKey, dispatch: entry.dispatch, sha256: entry.submissionSha256 });
      } else {
        const bytes = getSealedBytes(workspaceDir, entry.submissionSha256);
        let submission: ReturnType<typeof SubmissionRecordSchema.parse>;
        try {
          submission = SubmissionRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        } catch {
          refuse("record-integrity", "evidence-closure", `evaluation Submission ${entry.submissionSha256} is not a valid sealed Submission`);
        }
        const match = /^eval:[a-f0-9]{64}:e([1-9][0-9]*):/u.exec(submission.nonce);
        const evalIndex = match === null ? undefined : Number(match[1]);
        const evaluator = submission.requirements?.[EVALUATOR_REQUIREMENT_KEY];
        const evalTaskSha256 = submission.task.digest?.sha256;
        if (
          evalIndex === undefined || !Number.isSafeInteger(evalIndex)
          || typeof evaluator !== "string" || typeof evalTaskSha256 !== "string"
          || !submission.nonce.endsWith(`:${entry.cellKey}:${entry.dispatch}`)
        ) {
          refuse("record-integrity", "evidence-closure", `evaluation Submission ${entry.submissionSha256} lacks its exact journal/evaluator/task binding`);
        }
        graph.evaluationSubmissions.push({
          cellKey: entry.cellKey,
          dispatch: entry.dispatch,
          evalIndex,
          evaluator,
          evalTaskSha256,
          sha256: entry.submissionSha256,
        });
      }
    } else if (entry.kind === "delivery") {
      addRole(evidenceRecords, entry.deliverySha256, "solve-delivery");
      for (const output of entry.outputs) {
        addRole(evidenceRecords, output.sha256, "solve-output");
        if (embeddedInspect && output.name === "inspect-log") {
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
      const submission = [...graph.evaluationSubmissions].reverse().find(
        (candidate) => candidate.cellKey === entry.cellKey && candidate.evalIndex === evalIndex,
      );
      const hasSeparateLineage = entry.evalTaskSha256 !== undefined
        && entry.evalDeliverySha256 !== undefined
        && entry.evalAttempt !== undefined
        && submission !== undefined;
      const hasEmbeddedLineage = embeddedInspect
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
        ...(hasEmbeddedLineage ? { relationship: "same-execution-scorer" as const } : {}),
        ...(entry.evaluator !== undefined ? { evaluator: entry.evaluator } : {}),
        ...(entry.evalTaskSha256 !== undefined ? { evalTaskSha256: entry.evalTaskSha256 } : {}),
        ...(submission !== undefined ? { evalSubmissionSha256: submission.sha256 } : {}),
        ...(entry.evalAttempt !== undefined ? { evalAttempt: entry.evalAttempt } : {}),
        ...(entry.evalDeliverySha256 !== undefined ? { evalDeliverySha256: entry.evalDeliverySha256 } : {}),
        ...(entry.verdictSha256 !== undefined ? { verdictSha256: entry.verdictSha256 } : {}),
        ...(entry.evaluationTerminal !== undefined ? { evaluationTerminal: entry.evaluationTerminal } : {}),
      });
      if (entry.verdictSha256 !== undefined) {
        evaluationEvidenceByVerdict.set(
          `${entry.cellKey}\0${entry.verdictSha256}\0${evalIndex}`,
          hasEmbeddedLineage
            ? { relationship: "same-execution-scorer", evalIndex }
            : {
              evalTaskSha256: entry.evalTaskSha256!,
              evalSubmissionSha256: submission!.sha256,
              evalDeliverySha256: entry.evalDeliverySha256!,
              evalAttempt: entry.evalAttempt!,
              evalIndex,
            },
        );
      }
    }
  }
  for (const cell of matrix.cells) {
    for (const digest of cell.verdicts) addRole(evidenceRecords, digest.slice("sha256:".length), "verdict");
  }

  // Journal append order is not a public ordering authority. Canonicalize every edge list by
  // its stable graph coordinates so equivalent workspaces always emit identical assembly bytes.
  graph.solveSubmissions.sort((left, right) =>
    left.cellKey.localeCompare(right.cellKey) || left.dispatch - right.dispatch || left.sha256.localeCompare(right.sha256));
  graph.evaluationSubmissions.sort((left, right) =>
    left.cellKey.localeCompare(right.cellKey) || left.evalIndex - right.evalIndex
    || left.dispatch - right.dispatch || left.sha256.localeCompare(right.sha256));
  graph.solveDeliveries.sort((left, right) =>
    left.cellKey.localeCompare(right.cellKey) || left.dispatch - right.dispatch || left.sha256.localeCompare(right.sha256));
  graph.evaluations.sort((left, right) =>
    left.cellKey.localeCompare(right.cellKey) || left.evalIndex - right.evalIndex
    || (left.verdictSha256 ?? "").localeCompare(right.verdictSha256 ?? ""));

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
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sha256, value]) => ({
        sha256,
        evaluator: value.evaluator,
        keyId: value.keyId,
        cellKeys: [...value.cellKeys].sort(),
      })),
  });
  files.set("verdicts.json", canonicalJsonBytes(verdictCatalog));

  const evidenceCatalog: BundleEvidenceCatalog = BundleEvidenceCatalogSchema.parse({
    format: BUNDLE_EVIDENCE_FORMAT,
    records: [...evidenceRecords]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sha256, roles]) => ({
        sha256,
        roles: ROLE_ORDER.filter((role) => roles.has(role)),
      })),
  });
  files.set("evidence.json", canonicalJsonBytes(evidenceCatalog));
  for (const record of evidenceCatalog.records) {
    files.set(`records/${record.sha256}.bin`, getSealedBytes(workspaceDir, record.sha256));
  }

  const reportKey = loadOrCreateReportSigningKey(workspaceDir);
  const workspace = assertWorkspace(workspaceDir);
  const usedEvaluators = [...new Set(verdictCatalog.verdicts.map((verdict) => verdict.evaluator))].sort();
  const trust: BundleTrust = BundleTrustSchema.parse({
    format: BUNDLE_TRUST_FORMAT,
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
  });
  files.set("trust/public-keys.json", canonicalJsonBytes(trust));
  const dissentCellKeys = assemblyCells
    .filter((cell) => new Set(cell.verdicts.map((verdict) => verdict.verdict)).size > 1)
    .map((cell) => cell.cellKey)
    .sort();
  for (const [path, bytes] of Object.entries(buildPublicAssets({
    claim,
    matrix,
    report,
    reportSha256: runState.reportSha256,
    matrixSha256: runState.matrixSha256,
    recordSha256s: evidenceCatalog.records.map((record) => record.sha256),
    dissentCellKeys,
  }))) {
    files.set(path, bytes);
  }
  return { files, evidenceRecords };
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
    const paths = [...closure.files.keys()].sort();
    for (const path of paths) {
      const bytes = closure.files.get(path)!;
      if (byteIndexOf(bytes, needle) !== -1) {
        refuse("record-integrity", path, `public bundle file "${path}" contains the private workspace path`);
      }
      atomicWriteFileSync(join(stage, ...path.split("/")), bytes);
    }
    const built = buildBundleManifest(stage, paths);
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
