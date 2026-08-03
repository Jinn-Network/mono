// SPDX-License-Identifier: MIT

/**
 * Per-policy evaluated history (product design §8.3).
 *
 * A selection and an ordering, and nothing else. Every value is carried verbatim as the registry
 * method sealed it or the adapter folded it; the archive never re-reads a Report's `results` block
 * and never derives a number from one (program ruling R3, and the same reasoning `allocation.ts`
 * states at length).
 *
 * The ordering is total and deterministic so two hosts write the same projection: wave ascending,
 * then method id, then method version, then Report digest. Observations sort by bucket then by
 * their input-ref list — a `PolicyOutcomesRow` has no other stable key, since it is an aggregate
 * over exactly those announcements.
 */

import { compareCodeUnitStrings } from "@jinn-network/policy-identity";
import type { OutcomesProjectionRow, WaveReportRow } from "../wave-types.js";
import type { EvaluatedHistory } from "./types.js";

function compareReportRows(left: WaveReportRow, right: WaveReportRow): number {
  if (left.waveNumber !== right.waveNumber) return left.waveNumber - right.waveNumber;
  return compareCodeUnitStrings(
    `${left.method.id} ${left.method.version} ${left.reportDigest}`,
    `${right.method.id} ${right.method.version} ${right.reportDigest}`,
  );
}

function compareOutcomeRows(left: OutcomesProjectionRow, right: OutcomesProjectionRow): number {
  return compareCodeUnitStrings(
    `${left.bucket} ${left.inputRefs.join(",")}`,
    `${right.bucket} ${right.inputRefs.join(",")}`,
  );
}

/**
 * Everything this operator has measured about one tuple, in one deterministic order.
 *
 * Rows naming another tuple are filtered out rather than refused: the caller holds one campaign's
 * Reports and one projection, both of which legitimately cover the whole population, and asking
 * for one member's history is not an assertion that the others do not exist.
 */
export function evaluatedHistory(
  reports: readonly WaveReportRow[],
  rows: readonly OutcomesProjectionRow[],
  tupleDigest: string,
): EvaluatedHistory {
  const evaluations = reports
    .filter((row) => row.tupleDigest === tupleDigest)
    .sort(compareReportRows);
  const observations = rows
    .filter((row) => row.tupleDigest === tupleDigest)
    .sort(compareOutcomeRows);
  return {
    tupleDigest,
    evaluations,
    observations,
    waves: [...new Set(evaluations.map((row) => row.waveNumber))].sort((a, b) => a - b),
  };
}
