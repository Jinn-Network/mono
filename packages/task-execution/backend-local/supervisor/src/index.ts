// @jinn-network/task-execution-supervisor — public surface.
// Task A2: the `AttemptIdentity`/`SpawnRequest` contract types (custody-owned, design §14 item
// 1; backend plan Finding (e)). The shim (A4) and the journal/attempt-record/reconciler/
// cancellation/deadline internals (A5) land next.
export type { AttemptIdentity, SpawnRequest } from "./attempt-identity.js";
export { openAttemptJournal, openSubmissionSegment, JournalCorruptionError, JournalTerminalRejectedError } from "./journal.js";
export type { AttemptJournal, SubmissionSegment } from "./journal.js";
export { foldAttemptRecord } from "./attempt-record.js";
export { reconcileAttempt } from "./reconciler.js";
export { runCancellationLadder } from "./cancellation.js";
export { armDeadline, heartbeatIsStale } from "./deadline.js";
export {
  probeShimAlive,
  readOutcome,
  readProcessStartTime,
  readShimFingerprint,
  spawnShim,
} from "./shim.js";
export type { OutcomeFile, ShimFingerprint } from "./shim.js";
export type { JournalEvent, JournalEventIntent, SubmissionEvent, SubmissionEventIntent } from "./journal-types.js";
export type { AttemptRecord, AttemptHarvestInput, AttemptOutputArtifact } from "./attempt-record.js";
export type { AttemptReality, ReconciliationResult, ReconciliationClassification } from "./reconciler.js";
export type { CancellationAttempt, CancellationDriver, CancellationOptions, CancellationResult } from "./cancellation.js";
