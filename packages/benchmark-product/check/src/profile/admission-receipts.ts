import {
  ADMISSION_RECEIPT_MEDIA_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1,
  type PredictionSnapshotAdmissionReceiptV1,
} from "@jinn-network/task-admission";
import { parseDsseEnvelope } from "@jinn-network/trust-core";

export interface LocalAdmissionReceiptFact { readonly zeroReplayVariance: boolean; readonly externalCapabilities: boolean; }
export interface ParsedLocalAdmissionReceipt { readonly sha256: string; readonly taskSha256: string; readonly fact: LocalAdmissionReceiptFact; }

/** Parses the public, sealed prediction-snapshot admission receipt. */
export function parsePredictionSnapshotAdmissionReceipt(bytes: Uint8Array, sha256 = ""): ParsedLocalAdmissionReceipt | undefined {
  let envelope: ReturnType<typeof parseDsseEnvelope>;
  try { envelope = parseDsseEnvelope(bytes); } catch { return undefined; }
  if (envelope.payloadType !== ADMISSION_RECEIPT_MEDIA_TYPE) return undefined;
  try {
    const statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes)) as {
      _type?: unknown; predicateType?: unknown; predicate?: Partial<PredictionSnapshotAdmissionReceiptV1>;
    };
    const digest = statement.predicate?.task?.documentDigest;
    if (statement._type !== IN_TOTO_STATEMENT_TYPE || statement.predicateType !== PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1.predicateType || typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) return undefined;
    return { sha256, taskSha256: digest.slice("sha256:".length), fact: { zeroReplayVariance: true, externalCapabilities: false } };
  } catch { return undefined; }
}
