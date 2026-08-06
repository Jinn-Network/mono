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

interface PredictionSnapshotStatementShape {
  readonly _type?: unknown;
  readonly predicateType?: unknown;
  readonly predicate?: unknown;
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
  const byTaskDigestHex = new Map<string, LocalAdmissionReceiptFact>();

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

    let envelope: ReturnType<typeof parseDsseEnvelope>;
    try {
      envelope = parseDsseEnvelope(bytes);
    } catch {
      continue;
    }
    if (envelope.payloadType !== ADMISSION_RECEIPT_MEDIA_TYPE) continue;

    let statement: PredictionSnapshotStatementShape;
    try {
      statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes)) as PredictionSnapshotStatementShape;
    } catch {
      continue;
    }
    if (
      statement._type !== IN_TOTO_STATEMENT_TYPE
      || statement.predicateType !== PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1.predicateType
    ) {
      continue;
    }

    const predicate = statement.predicate as Partial<PredictionSnapshotAdmissionReceiptV1> | undefined;
    const taskDigest = predicate?.task?.documentDigest;
    if (typeof taskDigest !== "string" || !taskDigest.startsWith("sha256:")) continue;

    byTaskDigestHex.set(taskDigest.slice("sha256:".length), { zeroReplayVariance: true, externalCapabilities: false });
  }

  return byTaskDigestHex;
}
