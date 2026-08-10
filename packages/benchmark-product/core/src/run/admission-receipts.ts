/**
 * Bridges BP-11's real prediction-snapshot admission receipts (`@jinn-network/task-admission`,
 * `../intake/sample.ts`) to `@jinn-network/benchmarking-local`'s `LocalAdmissionEvidenceInput`
 * shape (`{zeroReplayVariance, externalCapabilities}`, `admission.ts`'s own `integrityTierFromReceipt`)
 * — two different fact shapes about the same admitted Task that this product is the one place
 * positioned to reconcile: task-admission owns the receipt's real content, benchmarking-local
 * owns what a `re-derivable` tier requires, and nothing between them imports the other.
 *
 * A receipt's mere presence is the fact this module reports: `admitPredictionSnapshot` only
 * mints one for a Task bound to a `family: "deterministic-process"` EvaluationSpec whose grader,
 * familyBlock, measurements, and verdictRule are pinned byte-exactly
 * (`@jinn-network/task-admission`'s own `exactEvaluationSpec`) — a fixed, offline, non-networked
 * grading procedure. That is what licenses `zeroReplayVariance: true, externalCapabilities:
 * false` for it; a Task with no receipt reports nothing (the caller's own conservative
 * `attested-only` default applies, per `integrityTierFromReceipt`).
 */

import { readdirSync } from "node:fs";
import {
  ADMISSION_RECEIPT_MEDIA_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1,
  type PredictionSnapshotAdmissionReceiptV1,
} from "@jinn-network/task-admission";
import { parseDsseEnvelope } from "@jinn-network/trust-core";
import { recordsDir } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

export interface LocalAdmissionReceiptFact {
  readonly zeroReplayVariance: boolean;
  readonly externalCapabilities: boolean;
}

export interface LocalAdmissionReceiptRecord {
  readonly sha256: string;
  readonly fact: LocalAdmissionReceiptFact;
}

export interface ParsedLocalAdmissionReceipt extends LocalAdmissionReceiptRecord {
  readonly taskSha256: string;
}

interface PredictionSnapshotStatementShape {
  readonly _type?: unknown;
  readonly predicateType?: unknown;
  readonly predicate?: unknown;
}

/** Pure parser used by both workspace scanning and portable graph verification. */
export function parsePredictionSnapshotAdmissionReceipt(
  bytes: Uint8Array,
  sha256 = "",
): ParsedLocalAdmissionReceipt | undefined {
  let envelope: ReturnType<typeof parseDsseEnvelope>;
  try {
    envelope = parseDsseEnvelope(bytes);
  } catch {
    return undefined;
  }
  if (envelope.payloadType !== ADMISSION_RECEIPT_MEDIA_TYPE) return undefined;
  let statement: PredictionSnapshotStatementShape;
  try {
    statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes)) as PredictionSnapshotStatementShape;
  } catch {
    return undefined;
  }
  if (
    statement._type !== IN_TOTO_STATEMENT_TYPE
    || statement.predicateType !== PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1.predicateType
  ) return undefined;
  const predicate = statement.predicate as Partial<PredictionSnapshotAdmissionReceiptV1> | undefined;
  const taskDigest = predicate?.task?.documentDigest;
  if (typeof taskDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(taskDigest)) return undefined;
  return {
    sha256,
    taskSha256: taskDigest.slice("sha256:".length),
    fact: { zeroReplayVariance: true, externalCapabilities: false },
  };
}

/**
 * Scans every sealed record in the workspace once for prediction-snapshot admission-receipt
 * DSSE envelopes and returns a lookup keyed by the admitted Task's own digest (bare hex). Most
 * records are NOT admission receipts (Tasks, Deliveries, Submissions, verdict envelopes,
 * Benchmarks…) — each one is tried and, on any parse/shape mismatch, silently skipped; that is
 * the expected outcome for the overwhelming majority of files, not a corruption signal.
 */
export function scanPredictionSnapshotAdmissionReceipts(
  workspaceDir: string,
): Map<string, LocalAdmissionReceiptFact> {
  return new Map(
    [...scanPredictionSnapshotAdmissionReceiptRecords(workspaceDir)].map(([taskDigest, record]) => [taskDigest, record.fact]),
  );
}

/** Same validated scan with the receipt envelope's own CAS digest retained for BP-40's exact
 * allowlisted evidence closure. */
export function scanPredictionSnapshotAdmissionReceiptRecords(
  workspaceDir: string,
): Map<string, LocalAdmissionReceiptRecord> {
  const byTaskDigestHex = new Map<string, LocalAdmissionReceiptRecord>();

  let fileNames: string[];
  try {
    fileNames = readdirSync(recordsDir(workspaceDir)).filter((name) => name.endsWith(".bin"));
  } catch {
    return byTaskDigestHex;
  }

  for (const fileName of fileNames) {
    const digest = fileName.slice(0, -".bin".length);
    let bytes: Uint8Array;
    try {
      bytes = getSealedBytes(workspaceDir, digest);
    } catch {
      continue;
    }

    const parsed = parsePredictionSnapshotAdmissionReceipt(bytes, digest);
    if (parsed === undefined) continue;
    byTaskDigestHex.set(parsed.taskSha256, { sha256: parsed.sha256, fact: parsed.fact });
  }

  return byTaskDigestHex;
}
