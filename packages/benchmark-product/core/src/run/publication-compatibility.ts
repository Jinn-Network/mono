/** Explicit, non-mutating assessment for the benchmark-publication/v1 boundary. */

import { foldRunJournalLineage, readRunJournalEntries } from "./journal.js";
import { readRunState } from "./state.js";

export type PublicationCompatibilityAssessment =
  | { readonly status: "ready"; readonly dispatchCount: number }
  | { readonly status: "refused"; readonly reasons: readonly string[] };

/**
 * A legacy workspace can still produce and verify its local bundle, but it has no prospective
 * Submission/observation capture. Never invent that historical TEP lineage on its behalf.
 */
export function assessPublicationCompatibility(
  workspaceDir: string,
  draftId: string,
): PublicationCompatibilityAssessment {
  const state = readRunState(workspaceDir, draftId);
  if (state === undefined) return { status: "refused", reasons: ["no run state exists"] };
  if (state.publication === undefined) {
    return { status: "refused", reasons: ["legacy run state has no prospective publication capture"] };
  }
  const lineage = foldRunJournalLineage(readRunJournalEntries(workspaceDir, draftId));
  const reasons: string[] = [];
  let dispatchCount = 0;
  for (const dispatches of lineage.values()) {
    for (const dispatch of dispatches) {
      dispatchCount += 1;
      if (dispatch.submissionSha256 === undefined) reasons.push(`${dispatch.cellKey}/${dispatch.dispatch}: missing pre-submit Submission capture`);
      if (dispatch.acceptedSubmissionSha256 !== undefined && dispatch.observationArchiveSha256 === undefined) {
        reasons.push(`${dispatch.cellKey}/${dispatch.dispatch}: missing accepted observation archive`);
      }
    }
  }
  return reasons.length === 0 ? { status: "ready", dispatchCount } : { status: "refused", reasons };
}
