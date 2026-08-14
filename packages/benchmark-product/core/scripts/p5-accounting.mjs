export const P5_TASK_COUNT = 3;
export const P5_CELL_COUNT = 12;
export const P5_RESAMPLES = 1_000;

function refuse(message) {
  throw new Error(`P5 accounting: ${message}`);
}

/** Pure, CI-safe audit of the real walkthrough's sealed Matrix and paired comparison. */
export function auditP5Accounting({ matrix, status, comparison }) {
  if (matrix.cells.length !== P5_CELL_COUNT || matrix.completeness.expected !== P5_CELL_COUNT
    || matrix.completeness.judged !== P5_CELL_COUNT || matrix.completeness.runOutcome !== "complete") {
    refuse(`Matrix did not account all ${P5_CELL_COUNT} cells: ${JSON.stringify(matrix.completeness)}`);
  }
  if (status.counts.expected !== P5_CELL_COUNT || status.counts.judged !== P5_CELL_COUNT
    || status.counts.failed !== 0) {
    refuse(`status did not account all ${P5_CELL_COUNT} cells: ${JSON.stringify(status.counts)}`);
  }
  for (const cell of matrix.cells) {
    for (const axis of ["harness", "model", "loadout", "isolation"]) {
      if (cell.verification[axis] !== "match") {
        refuse(`${cell.cellKey} ${axis} is ${cell.verification[axis]}, not match`);
      }
    }
    if (cell.dispatches !== 1 || cell.verification.checksFailed.length !== 0) {
      refuse(`${cell.cellKey} has non-exact dispatch/evidence accounting`);
    }
  }
  if (comparison === undefined || comparison.pairs !== P5_TASK_COUNT || comparison.interval !== null
    || !comparison.reasons.some((reason) => reason.includes("minN=5"))) {
    refuse(`undersized report did not withhold its interval: ${JSON.stringify(comparison)}`);
  }
  if (comparison.clustering.clusters !== P5_TASK_COUNT
    || comparison.bootstrap.count !== P5_TASK_COUNT
    || comparison.bootstrap.resamples !== P5_RESAMPLES
    || comparison.bootstrap.unit !== "source-cluster") {
    refuse(`report did not preserve three repository clusters: ${JSON.stringify(comparison.bootstrap)}`);
  }
  const clusterCount = comparison.bootstrap.clusters.length;
  if (clusterCount !== P5_TASK_COUNT) {
    refuse(`bootstrap cluster accounting moved: ${clusterCount} != ${P5_TASK_COUNT}`);
  }
  // This micro-slate is deliberately below paired-delta's minimum sample size.
  // With no interval to estimate, the method performs no resampling; planned
  // resample capacity must not be misreported as draws that actually occurred.
  if (comparison.bootstrap.draws !== 0) {
    refuse(`withheld interval performed ${comparison.bootstrap.draws} bootstrap draws, expected 0`);
  }
  return { clusterCount, draws: comparison.bootstrap.draws };
}
