// SPDX-License-Identifier: Apache-2.0
import type { RankedCandidate } from "./search.js";

/**
 * C5's producer-admission surface, pinned. This is the only file in C6 that names it, so a
 * C5 signature change at a restack costs exactly this file (same coupling budget as the C2
 * decoder adapter).
 */
export interface CorpusAdmission {
  admitProducer(producerId: string): Promise<{ readonly admitted: boolean }>;
}

export interface AdmissionFilter {
  admit(candidates: readonly RankedCandidate[]): Promise<readonly RankedCandidate[]>;
}

/**
 * Admission on the path into context (coordinator ruling, 2026-07-31).
 *
 * The index is a ranking accelerator and caches no admission decision: queries run against
 * it rather than through C5's reader, so a record indexed under a policy that has since
 * passed its `refreshBy` would otherwise keep reaching model context on a stale
 * authorization. This re-asks, over the selected handful only.
 *
 * Reads admission as a data-path fact — never another health check's verdict.
 */
export function createCorpusAdmissionFilter(admission: CorpusAdmission): AdmissionFilter {
  return {
    async admit(
      candidates: readonly RankedCandidate[],
    ): Promise<readonly RankedCandidate[]> {
      const decisions = new Map<string, boolean>();
      const kept: RankedCandidate[] = [];

      for (const candidate of candidates) {
        // Producer admission is a statement about third-party producers. The operator's own
        // capture never passed through it, and asking would mean admitting themselves.
        if (candidate.plane === "local") {
          kept.push(candidate);
          continue;
        }

        let admitted = decisions.get(candidate.origin);
        if (admitted === undefined) {
          try {
            admitted = (await admission.admitProducer(candidate.origin)).admitted;
          } catch {
            // Fail closed, per cross-plan contract 1: an undecidable producer is excluded.
            admitted = false;
          }
          decisions.set(candidate.origin, admitted);
        }
        if (admitted) kept.push(candidate);
      }

      return kept;
    },
  };
}
