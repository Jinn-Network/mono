import { documentDigest, type MatrixRecord } from "@jinn-network/benchmarking-records";

/** Injected evidence port for the Jinn-owned Matrix projection. */
export type EvidenceResolver = {
  transcriptFor?(cellKey: string): Promise<unknown> | unknown;
  evidenceRefFor?(cellKey: string): Promise<unknown> | unknown;
};

export type MatrixProjectionSample = {
  id: string;
  repetition: number;
  armId: string;
  outcome: string;
  evidence: {
    transcriptRef: string;
    evidenceRef: string;
  };
};

/**
 * A deliberately Jinn-owned convenience projection. It is not an Inspect EvalLog and must not
 * be passed to Inspect log readers or Inspect View.
 */
export type MatrixProjection = {
  schema: "jinn.network/benchmark-matrix-projection/1";
  samples: MatrixProjectionSample[];
};

function deterministicRef(kind: "transcript" | "evidence", cellKey: string, resolved: unknown): string {
  if (typeof resolved === "string" && resolved.length > 0) return resolved;
  if (resolved !== undefined && resolved !== null) {
    return documentDigest(new TextEncoder().encode(JSON.stringify(resolved)));
  }
  return documentDigest(new TextEncoder().encode(`${kind}:${cellKey}`));
}

/** Matrix -> honest Jinn projection; samples follow the Matrix's sealed cell order. */
export async function exportMatrixProjection(
  matrix: MatrixRecord,
  evidence: EvidenceResolver,
): Promise<MatrixProjection> {
  const samples: MatrixProjectionSample[] = [];
  for (const cell of matrix.cells) {
    const transcript = await evidence.transcriptFor?.(cell.cellKey);
    const evidenceRef = await evidence.evidenceRefFor?.(cell.cellKey);
    samples.push({
      id: cell.cellKey,
      repetition: cell.replicate,
      armId: cell.armId,
      outcome: cell.outcome,
      evidence: {
        transcriptRef: deterministicRef("transcript", cell.cellKey, transcript),
        evidenceRef: deterministicRef("evidence", cell.cellKey, evidenceRef),
      },
    });
  }
  return {
    schema: "jinn.network/benchmark-matrix-projection/1",
    samples,
  };
}
