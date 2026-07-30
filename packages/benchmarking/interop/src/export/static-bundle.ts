import {
  sealMatrix,
  type MatrixRecord,
  type ReportRecord,
} from "@jinn-network/benchmarking-records";

export type StaticBundle = {
  format: "jinn-benchmarking-static-bundle/1";
  matrixSha256: string;
  files: string[];
  reports?: number;
};

/**
 * Self-contained static bundle projection (§10.1 op 5). Private by default.
 * `matrixSha256` is the sealed Matrix document digest (hex, no `sha256:` prefix).
 */
export function exportStaticBundle(
  matrix: MatrixRecord,
  reports?: readonly ReportRecord[],
): StaticBundle {
  const sealed = sealMatrix(matrix);
  return {
    format: "jinn-benchmarking-static-bundle/1",
    matrixSha256: sealed.digest.slice("sha256:".length),
    files: ["benchmark.json", "run.json", "matrix.json", "verdicts.json", "evidence.json"],
    ...(reports === undefined ? {} : { reports: reports.length }),
  };
}
