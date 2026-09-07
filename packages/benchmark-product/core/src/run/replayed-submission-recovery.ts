/**
 * The one reconciliation preamble both resume legs run before they replay a Submission the
 * backend may already have accepted (#3198).
 *
 * The solve leg (`../operations/run-launch.ts`, the `for (const cell of outstanding)` loop) and
 * the evaluation leg (`./drive.ts`, `dispatchEvaluation`'s `replayed !== undefined` block) reach
 * this from different crash windows, but the rule they enforce is the same one and must not drift
 * between them: read the recovery ref OUT of the accepted bytes, never recompute it from the
 * idempotency key, so a drift between the two refuses here rather than reconciling nothing and
 * degrading silently — on the evaluation side, to permanent verdict loss.
 *
 * The caller keeps what is genuinely its own: the refusal path, both message strings (each leg
 * names its own leg context), and what it does with the report. `absent` in particular is not
 * decided here — the solve leg lets `resumeRun` submit the same bytes normally, while the
 * evaluation leg probes whether the idempotency key is actually free (#3237).
 */

import type { ReconciliationReport, SubmissionUri } from "@jinn-network/task-execution-backend";
import { refuse } from "../errors.js";

/** The backend surface this preamble needs — `recover` and nothing else. */
export interface RecoveringBackend {
  recover(ref: SubmissionUri): Promise<ReconciliationReport>;
}

export interface ReplayedSubmissionRecoveryInput {
  readonly backend: RecoveringBackend;
  /** The exact sealed Submission bytes the journal captured for this leg. */
  readonly submissionBytes: Uint8Array;
  /** Issue path both refusals carry. */
  readonly refusalPath: string;
  /** Full message for bytes carrying no `urn:uuid:` Submission URI. */
  readonly invalidUriMessage: string;
  /** Full message for a `contradictory` report; the report's own detail is appended as `: <detail>`. */
  readonly contradictionMessage: string;
}

/**
 * Decodes the captured bytes, refuses `record-integrity` unless they name a `urn:uuid:` Submission
 * URI, reconciles that exact ref with the backend, and refuses `record-integrity` on a
 * `contradictory` report. Returns the validated ref and the report for the caller's own branching.
 */
export async function reconcileReplayedSubmission(
  input: ReplayedSubmissionRecoveryInput,
): Promise<{ readonly submissionUri: SubmissionUri; readonly reconciliation: ReconciliationReport }> {
  const decoded = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(input.submissionBytes),
  ) as { readonly submission?: unknown };
  if (typeof decoded.submission !== "string" || !decoded.submission.startsWith("urn:uuid:")) {
    refuse("record-integrity", input.refusalPath, input.invalidUriMessage);
  }
  const submissionUri = decoded.submission as SubmissionUri;
  const reconciliation = await input.backend.recover(submissionUri);
  if (reconciliation.classification === "contradictory") {
    refuse(
      "record-integrity",
      input.refusalPath,
      `${input.contradictionMessage}${
        reconciliation.detail === undefined ? "" : `: ${reconciliation.detail}`
      }`,
    );
  }
  return { submissionUri, reconciliation };
}
