import { renderTimestampCoverage, timestampProofEvaluationNote, timestampSubjectName } from "@colophon-claims/check";
import type { RunVerifyResult } from "../operations/verify.js";

// The timestamp-proof lines name each outcome as the reader tool does (reader-facing vocabulary spec
// §4.2, v1.14; issue #5241): the claimant who reads this next runs the reader on the same records.
// The note, the coverage block and each covered record's label (§4.2, v1.15; issue #5278) are the
// reader's own functions, not copies. `--json` keeps the raw values, `declared-but-absent` and the
// raw subject `matrix` included.
export function renderWorkspaceVerifyHuman(value: RunVerifyResult): string {
  const lines = [`verified draft ${value.draftId}: ${value.checks.join(", ")}`];
  // The first line names only what ran. This one names what `publish` will run on the bundle that
  // this operation did not (issue #4940), so a pass is not read as a prediction that `publish` succeeds.
  if (value.readerChecksNotRun !== undefined) {
    lines.push(`not run here (publish runs them on the bundle and refuses if one fails): ${value.readerChecksNotRun.join(", ")}`);
  }
  for (const anchor of value.anchors?.anchors ?? []) {
    const basis = [anchor.provider, anchor.timeBasis].filter((part) => part !== undefined).join(", ");
    lines.push(
      `${anchor.subject === undefined ? "unknown" : timestampSubjectName(anchor.subject)} timestamp proof: `
      + `${basis.length === 0 ? "unknown provider/time source" : basis}, `
      + `${anchor.status}, record ${anchor.recordSha256}`,
    );
    lines.push(`  ${timestampProofEvaluationNote(anchor)}`);
  }
  if (value.anchors !== undefined) {
    lines.push(renderTimestampCoverage(value.anchors));
  }
  if (value.anchoringWindow !== undefined) {
    lines.push("a timestamp proof is still pending, and `report` closes the anchoring window.");
  }
  return `${lines.join("\n")}\n`;
}
