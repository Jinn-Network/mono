import type { MatrixRecord, ReportRecord } from "@jinn-network/benchmarking-records";

/** The kit's injected shape (design §10.1 op 5, §10.2): `benchmarking/interop` (wave 2, M5)
 * implements these three fixture-pinned projections of a Matrix (+ optional Reports). */
export interface Exporters {
  evalLog(matrix: MatrixRecord): unknown;
  croissant(matrix: MatrixRecord): unknown;
  staticBundle(matrix: MatrixRecord, reports?: readonly ReportRecord[]): unknown;
}

/**
 * §16 export conformance: the EvalLog and Croissant projections of the miniature run MUST be
 * byte-exact against the pinned fixtures. Deferred to wave 2 (M5, `benchmarking/interop`) along
 * with the miniature-run fixture and the export fixtures themselves — this wave (M1-M3) has no
 * consumer to exercise it against, so the driver body is intentionally a placeholder that fails
 * loudly rather than silently reporting success.
 */
export function describeExportConformance(_exporters: Exporters): void {
  throw new Error(
    "describeExportConformance is not yet implemented: the export fixtures (design §16) are "
      + "scoped to wave 2 (M5, benchmarking/interop) — see this package's README.",
  );
}
