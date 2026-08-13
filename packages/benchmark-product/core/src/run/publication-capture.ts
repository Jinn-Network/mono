/**
 * Product adapter for benchmarking-run's prospective `LaunchCapturePort`.
 *
 * This is intentionally outside the backend proxy: the runner invokes `captureSubmission`
 * before `submit`, so a CAS/journal failure prevents the backend from seeing the Submission.
 * The accepted snapshot is then sealed as a deterministic observation archive per dispatch.
 */

import { buildObservationArchive } from "@jinn-network/benchmarking-publication";
import type { LaunchCapturePort } from "@jinn-network/benchmarking-run";
import { refuse } from "../errors.js";
import { appendRunJournalEntry } from "./journal.js";
import { putSealedBytes } from "../workspace/sealed-store.js";

export interface ProductLaunchCaptureDeps {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly liveClock: () => string;
}

export function createProductLaunchCapture(deps: ProductLaunchCaptureDeps): LaunchCapturePort {
  const capturedSubmissions = new Map<string, string>();
  return {
    captureSubmission(input) {
      const submissionSha256 = putSealedBytes(deps.workspaceDir, input.bytes);
      capturedSubmissions.set(`${input.cellKey}::${input.dispatch}`, submissionSha256);
      appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
        kind: "submission-captured",
        at: deps.liveClock(),
        cellKey: input.cellKey,
        armId: input.armId,
        replicate: input.replicate,
        dispatch: input.dispatch,
        submissionSha256,
      });
    },
    captureObservation(input) {
      const submissionSha256 = input.submissionDigest.slice("sha256:".length);
      const captured = capturedSubmissions.get(`${input.cellKey}::${input.dispatch}`);
      if (captured !== submissionSha256) {
        refuse("record-integrity", `runs.${deps.draftId}.${input.cellKey}.${input.dispatch}`, "accepted Submission digest does not match the pre-submit captured bytes");
      }
      const { sealed } = buildObservationArchive({
        submission: { name: "submission", digest: { sha256: submissionSha256 } },
        capturedThrough: { at: deps.liveClock(), cursor: input.snapshot.cursor.sequence },
        snapshots: input.snapshot.observations.map((observation) => ({ observation, accepted: true })),
      });
      const observationArchiveSha256 = putSealedBytes(deps.workspaceDir, sealed.bytes);
      appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
        kind: "submission-accepted",
        at: deps.liveClock(),
        cellKey: input.cellKey,
        dispatch: input.dispatch,
        submissionSha256,
        leg: "solve",
      });
      appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
        kind: "observation-accepted",
        at: deps.liveClock(),
        cellKey: input.cellKey,
        armId: input.armId,
        replicate: input.replicate,
        dispatch: input.dispatch,
        submissionSha256,
        observationArchiveSha256,
        attempt: input.snapshot.descriptor.attempt,
      });
    },
  };
}
