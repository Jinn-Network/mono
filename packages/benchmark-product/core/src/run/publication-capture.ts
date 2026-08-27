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
import { appendRunJournalEntry, readRunJournalEntries } from "./journal.js";
import { putSealedBytes } from "../workspace/sealed-store.js";

export interface ProductLaunchCaptureDeps {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly liveClock: () => string;
  /** The source append is deliberately before the backend submission. */
  readonly announceSubmission?: (input: {
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly at: string;
  }) => Promise<{ readonly sequence: string; readonly entrySha256: string }>;
}

export function createProductLaunchCapture(deps: ProductLaunchCaptureDeps): LaunchCapturePort {
  const capturedSubmissions = new Map<string, string>();
  const acceptedSubmissions = new Map<string, string>();
  const acceptedObservations = new Map<string, string>();

  // Resume may re-observe an attempt that the backend had already accepted before the process
  // stopped. Seed the capture state from the durable journal so replaying that exact attempt is
  // idempotent: append only facts that were missing at the interruption boundary.
  for (const entry of readRunJournalEntries(deps.workspaceDir, deps.draftId)) {
    if (
      entry.kind !== "submission-captured"
      && !(entry.kind === "submission-accepted" && entry.leg !== "evaluation")
      && entry.kind !== "observation-accepted"
    ) continue;
    const key = `${entry.cellKey}::${entry.dispatch}`;
    const map = entry.kind === "submission-captured"
      ? capturedSubmissions
      : entry.kind === "submission-accepted"
        ? acceptedSubmissions
        : acceptedObservations;
    const prior = map.get(key);
    if (prior !== undefined && prior !== entry.submissionSha256) {
      refuse(
        "record-integrity",
        `runs.${deps.draftId}.${entry.cellKey}.${entry.dispatch}`,
        `${entry.kind} carries conflicting Submission bytes`,
      );
    }
    map.set(key, entry.submissionSha256);
  }

  return {
    async captureSubmission(input) {
      const submissionSha256 = putSealedBytes(deps.workspaceDir, input.bytes);
      const key = `${input.cellKey}::${input.dispatch}`;
      const prior = capturedSubmissions.get(key);
      if (prior !== undefined) {
        if (prior !== submissionSha256) {
          refuse(
            "record-integrity",
            `runs.${deps.draftId}.${input.cellKey}.${input.dispatch}`,
            "resumed Submission bytes do not match the pre-submit capture",
          );
        }
        return;
      }
      const at = deps.liveClock();
      const announcement = deps.announceSubmission === undefined
        ? undefined
        : await deps.announceSubmission({ bytes: new Uint8Array(input.bytes), digest: `sha256:${submissionSha256}`, at });
      capturedSubmissions.set(key, submissionSha256);
      appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
        kind: "submission-captured",
        at,
        cellKey: input.cellKey,
        armId: input.armId,
        replicate: input.replicate,
        dispatch: input.dispatch,
        submissionSha256,
        ...(announcement === undefined ? {} : {
          publicationSourceSequence: announcement.sequence,
          publicationEntrySha256: announcement.entrySha256,
        }),
      });
    },
    captureObservation(input) {
      const submissionSha256 = input.submissionDigest.slice("sha256:".length);
      const key = `${input.cellKey}::${input.dispatch}`;
      const captured = capturedSubmissions.get(key);
      if (captured !== submissionSha256) {
        refuse("record-integrity", `runs.${deps.draftId}.${input.cellKey}.${input.dispatch}`, "accepted Submission digest does not match the pre-submit captured bytes");
      }
      const priorAccepted = acceptedSubmissions.get(key);
      const priorObservation = acceptedObservations.get(key);
      if (
        (priorAccepted !== undefined && priorAccepted !== submissionSha256)
        || (priorObservation !== undefined && priorObservation !== submissionSha256)
      ) {
        refuse(
          "record-integrity",
          `runs.${deps.draftId}.${input.cellKey}.${input.dispatch}`,
          "resumed observation conflicts with the accepted Submission bytes",
        );
      }
      if (priorObservation !== undefined) return;
      if (priorAccepted === undefined) {
        appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
          kind: "submission-accepted",
          at: deps.liveClock(),
          cellKey: input.cellKey,
          dispatch: input.dispatch,
          submissionSha256,
          leg: "solve",
        });
        acceptedSubmissions.set(key, submissionSha256);
      }
      const { sealed } = buildObservationArchive({
        submission: { name: "submission", digest: { sha256: submissionSha256 } },
        capturedThrough: { at: deps.liveClock(), cursor: input.snapshot.cursor.sequence },
        snapshots: input.snapshot.observations.map((observation) => ({ observation, accepted: true })),
      });
      const observationArchiveSha256 = putSealedBytes(deps.workspaceDir, sealed.bytes);
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
      acceptedObservations.set(key, submissionSha256);
    },
  };
}
