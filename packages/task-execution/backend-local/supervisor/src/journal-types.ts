// SPDX-License-Identifier: Apache-2.0

/**
 * The append-only journal's event-type vocabulary (design §6.2, frozen interface §14 item 3).
 * Backend-internal — distinct from the TEP CloudEvents observation types the assembly projects
 * these onto (`@jinn-network/task-execution-protocol`'s `OBSERVATION_TYPES`); the golden journal
 * fixtures (`@jinn-network/task-execution-testing/backend-local`) document (not enforce) this
 * vocabulary — this module is where it is actually pinned. The set below is a superset of what
 * any single golden fixture exercises: it names every phase §6.3's phase-timestamp list requires
 * a journal record to derive (created / prepare-started / exec-started / exec-finished /
 * harvested / recorded), so the reconciler (§6.4) can classify "harvesting" vs "recording" phases
 * from real journal content, not just from fixture-provided labels.
 */
export const JOURNAL_EVENT_TYPES = [
  /** The attempt is minted and pinned to this backend as the authoritative observation source. */
  "attempt-engaged",
  /** `spawn-intended` — carries the serialized LaunchPlan digest; fsynced before fork/exec (§6.2 intent-before-action). */
  "spawn-intended",
  /** The shim's fingerprint has been observed; the attempt is now supervised. */
  "spawned",
  /** The harness itself has started producing observable progress (distinct from the shim merely existing). */
  "attempt-started",
  "progress",
  "cancel-requested",
  "cancel-acknowledged",
  /** The shim's `meta/outcome.json` has been ingested (exec phase over; harvest not yet run). */
  "exec-finished",
  "harvest-started",
  /** Harvest complete; `out/` collection frozen into a manifest. */
  "harvested",
  /** The Delivery has been sealed once and checkpointed (§9.1 seal-once); not yet recorded as an observation. */
  "delivery-checkpointed",
  "delivery-recorded",
  "attempt-terminal",
  /** Reconciliation actions that are not themselves a terminal (e.g. naming killed PIDs after an orphan kill-ladder, §6.4). */
  "reconciliation",
] as const;

export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number];

/**
 * One journal event (design §6.2's event shape): `{attemptId, seq, type, time, displayMessage?,
 * details{}, failsAttempt?}` (the Nomad TaskEvents shape — machine details plus human message).
 * `rejectedAtAppend` marks a record that failed the per-nonce terminal-uniqueness check at append
 * (§6.2): it is still durably recorded (never silently dropped — the journal is the source of
 * truth), but flagged so the fold never treats it as authoritative.
 */
export interface JournalEvent {
  readonly attemptId: string;
  readonly seq: number;
  readonly type: JournalEventType;
  readonly time: string;
  readonly displayMessage?: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly failsAttempt?: boolean;
  readonly rejectedAtAppend?: boolean;
}

/** A `JournalEvent` before `seq`/`time` are assigned by `append` (§6.2: `seq` is always derived, never caller-supplied). */
export type JournalEventIntent = Omit<JournalEvent, "seq" | "time" | "rejectedAtAppend"> & {
  readonly time?: string;
};

export const TERMINAL_JOURNAL_STATES = [
  "delivered", "failed", "rejected", "cancelled", "expired", "lost",
] as const;
export type TerminalJournalState = (typeof TERMINAL_JOURNAL_STATES)[number];

/** The submission-scoped log segment's event vocabulary (design §6.2): facts that exist before, or without, any Attempt. */
export const SUBMISSION_EVENT_TYPES = [
  "submission-accepted", "submission-rejected", "submission-closed",
] as const;
export type SubmissionEventType = (typeof SUBMISSION_EVENT_TYPES)[number];

export interface SubmissionEvent {
  readonly submission: string;
  readonly seq: number;
  readonly type: SubmissionEventType;
  readonly time: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type SubmissionEventIntent = Omit<SubmissionEvent, "seq" | "time"> & { readonly time?: string };
