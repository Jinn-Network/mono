import { documentDigest, type MatrixRecord } from "@jinn-network/benchmarking-records";

/** Injected evidence port for EvalLog export — contracts only, no concrete binding. */
export type EvidenceResolver = {
  transcriptFor?(cellKey: string): Promise<unknown> | unknown;
  evidenceRefFor?(cellKey: string): Promise<unknown> | unknown;
};

export type EvalLogSample = {
  id: string;
  epoch: number;
  target: string;
  outcome: string;
  /** Deterministic evidence references resolved through the injected port. */
  evidence: {
    transcriptRef: string;
    evidenceRef: string;
  };
};

export type EvalLog = {
  schema: "inspect-ai/eval-log/1";
  status: "success";
  samples: EvalLogSample[];
};

function deterministicRef(kind: "transcript" | "evidence", cellKey: string, resolved: unknown): string {
  if (typeof resolved === "string" && resolved.length > 0) return resolved;
  if (resolved !== undefined && resolved !== null) {
    return documentDigest(new TextEncoder().encode(JSON.stringify(resolved)));
  }
  return documentDigest(new TextEncoder().encode(`${kind}:${cellKey}`));
}

/**
 * Matrix → Inspect-compatible EvalLog (§10.1 op 5 / §10.2 seam 3).
 * Epoch-as-repetition; samples follow the Matrix's sealed cell order.
 * Always consumes the injected EvidenceResolver for deterministic transcript/evidence refs.
 */
export async function exportEvalLog(
  matrix: MatrixRecord,
  evidence: EvidenceResolver,
): Promise<EvalLog> {
  const samples: EvalLogSample[] = [];
  for (const cell of matrix.cells) {
    const transcript = await evidence.transcriptFor?.(cell.cellKey);
    const evidenceRef = await evidence.evidenceRefFor?.(cell.cellKey);
    samples.push({
      id: cell.cellKey,
      epoch: cell.replicate,
      target: cell.armId,
      outcome: cell.outcome,
      evidence: {
        transcriptRef: deterministicRef("transcript", cell.cellKey, transcript),
        evidenceRef: deterministicRef("evidence", cell.cellKey, evidenceRef),
      },
    });
  }
  return {
    schema: "inspect-ai/eval-log/1",
    status: "success",
    samples,
  };
}
