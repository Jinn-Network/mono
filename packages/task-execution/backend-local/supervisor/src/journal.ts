// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { appendFsyncedLineSync, readTextIfExistsSync } from "./fs-atomic.js";
import type {
  JournalEvent, JournalEventIntent, SubmissionEvent, SubmissionEventIntent,
} from "./journal-types.js";

/** A non-trailing journal record failed to parse — an unexpected corruption, distinct from the sanctioned trailing torn-tail case (design §6.2). */
export class JournalCorruptionError extends Error {
  constructor(path: string, lineNumber: number) {
    super(`journal corruption: non-trailing record at line ${lineNumber} of ${path} failed to parse`);
    this.name = "JournalCorruptionError";
  }
}

/** A second terminal for one nonce was appended without the sanctioned `lost`-correction exception (design §6.2/§6.4, TEP §10.4 rule 6). */
export class JournalTerminalRejectedError extends Error {
  constructor(attemptId: string) {
    super(`journal: a contradictory terminal for attempt "${attemptId}" was rejected at append and flagged`);
    this.name = "JournalTerminalRejectedError";
  }
}

function journalPath(metaDir: string): string {
  return join(metaDir, "journal.jsonl");
}

function parseIntactLines<T>(raw: string, path: string): { events: T[]; tornTail: boolean } {
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const events: T[] = [];
  let tornTail = false;
  for (let index = 0; index < lines.length; index++) {
    try {
      events.push(JSON.parse(lines[index]!) as T);
    } catch {
      if (index === lines.length - 1) {
        tornTail = true; // the sanctioned trailing torn-tail case — discarded wholesale, never trusted
      } else {
        throw new JournalCorruptionError(path, index + 1);
      }
    }
  }
  return { events, tornTail };
}

/** Accepted (non-rejected) terminals for an attemptId within an event list, in durable order. */
function acceptedTerminalsFor(events: readonly JournalEvent[], attemptId: string): JournalEvent[] {
  return events.filter(
    (event) => event.attemptId === attemptId && event.type === "attempt-terminal" && event.rejectedAtAppend !== true,
  );
}

/**
 * The append-only, per-attempt journal (design §6.2, frozen interface §14 item 3). Storage is
 * JSONL with torn-tail tolerance (an implementation profile — the contract is the event shape,
 * append-before-emit ordering, and the pure fold, not this file format). `append` and
 * `fsyncedAppend` are the same fully-durable operation exposed under both names (every append is
 * fsynced before this call returns — the journal is the source of truth, so nothing is EVER
 * appended without first being durable; "spawn-intended... fsynced before fork/exec" is simply
 * the specific call-site that matters most, not a distinct less-durable append path).
 */
export interface AttemptJournal {
  /** Appends and fsyncs one event, assigning its `seq` from `durableSeq()`. Throws `JournalTerminalRejectedError` if this is a contradictory (non-corrective) second terminal — the record is STILL durably appended (flagged `rejectedAtAppend: true`) before the error is thrown; the error signals the caller, it does not un-append the record. */
  append(intent: JournalEventIntent): JournalEvent;
  /** Alias for `append` (§6.2 names both the general operation and its most safety-critical call site — the intent record — as fsynced; there is only one durability level). */
  fsyncedAppend(intent: JournalEventIntent): JournalEvent;
  /** Durably appends, then (and only then) emits the journal event's observation projection. */
  appendAndEmit(intent: JournalEventIntent, emit: (event: JournalEvent) => void): JournalEvent;
  /** All intact events in `seq` order (a trailing torn record, if any, is silently discarded). */
  read(): JournalEvent[];
  /** `max(seq)+1` over intact records — always derived from disk, never an in-memory counter (design §6.2: this is what survives a torn tail correctly, journals/seq-resumption.json). */
  durableSeq(): number;
}

/**
 * Opens (or creates) the per-attempt journal rooted at `metaDir` (design §6.2). `isNonceLive`
 * is an OPTIONAL cross-attempt collision check (default: never live) — a single per-attempt
 * journal instance has no visibility into sibling attempts' journals by construction, so
 * cross-attempt nonce-collision detection (journals/duplicate-nonces.json: "a conforming
 * supervisor detects the collision at append... and refuses the second spawn-intent") is an
 * injected dependency a caller with cross-journal visibility (the assembly's nonce registry)
 * supplies; left unsupplied, this journal only enforces the invariants it can see on its own
 * (same-attempt nonce consistency across its own `spawn-intended`/`spawned` records, and
 * per-nonce terminal uniqueness).
 */
export function openAttemptJournal(
  metaDir: string,
  options?: { isNonceLive?: (nonce: string) => boolean },
): AttemptJournal {
  const path = journalPath(metaDir);

  function intact(): JournalEvent[] {
    const { events } = parseIntactLines<JournalEvent>(readTextIfExistsSync(path), path);
    return events;
  }

  function durableSeq(): number {
    const events = intact();
    if (events.length === 0) return 1;
    return Math.max(...events.map((event) => event.seq)) + 1;
  }

  function nonceOf(intent: JournalEventIntent): string | undefined {
    const nonce = intent.details["nonce"];
    return typeof nonce === "string" ? nonce : undefined;
  }

  function append(intent: JournalEventIntent): JournalEvent {
    const events = intact();
    const seq = events.length === 0 ? 1 : Math.max(...events.map((event) => event.seq)) + 1;

    // Same-attempt nonce consistency: a spawn record whose nonce differs from an already-live
    // nonce this journal itself minted for this attempt is refused (defensive; the cross-attempt
    // case is the injected `isNonceLive` check below).
    if ((intent.type === "spawn-intended" || intent.type === "spawned")) {
      const nonce = nonceOf(intent);
      if (nonce !== undefined && options?.isNonceLive?.(nonce)) {
        throw new Error(
          `journal: nonce "${nonce}" is already live under another attempt — refusing spawn intent (infrastructure)`,
        );
      }
    }

    let record: JournalEvent = {
      ...intent,
      seq,
      time: intent.time ?? new Date().toISOString(),
    };

    if (intent.type === "attempt-terminal") {
      const priorAccepted = acceptedTerminalsFor(events, intent.attemptId);
      if (priorAccepted.length > 0) {
        const correctionAvailable = priorAccepted.length === 1
          && priorAccepted[0]!.details["state"] === "lost";
        if (!correctionAvailable) {
          // Contradictory: still durably recorded (never silently dropped) but flagged, and the
          // first-by-seq terminal remains authoritative (TEP §10.4 rule 4).
          record = { ...record, rejectedAtAppend: true };
          appendFsyncedLineSync(path, JSON.stringify(record));
          throw new JournalTerminalRejectedError(intent.attemptId);
        }
        // Else: consume the ONE sanctioned terminal-to-terminal transition (TEP §10.4 rule 6).
        // Any later terminal sees two accepted terminals and is rejected above.
      }
    }

    appendFsyncedLineSync(path, JSON.stringify(record));
    return record;
  }

  return {
    append,
    fsyncedAppend: append,
    appendAndEmit(intent, emit) {
      const event = append(intent);
      emit(event);
      return event;
    },
    read: intact,
    durableSeq,
  };
}

// --- the submission-scoped log segment (design §6.2) ---

function submissionSegmentPath(segmentDir: string): string {
  return join(segmentDir, "submission.jsonl");
}

export interface SubmissionSegment {
  append(intent: SubmissionEventIntent): SubmissionEvent;
  read(): SubmissionEvent[];
}

/**
 * A submission-scoped log segment (design §6.2), keyed by Submission URI, holding
 * `submission-accepted|-rejected|-closed` — facts that exist before, or without, any Attempt. A
 * rejected Submission is durable and distinguishable from a never-seen one after restart: an
 * empty segment (no file, or a file with zero records) is "never seen"; a segment whose last
 * record is `submission-rejected` is durably "rejected" (`journals/submission-segment-survival.json`).
 */
export function openSubmissionSegment(segmentDir: string): SubmissionSegment {
  const path = submissionSegmentPath(segmentDir);

  function intact(): SubmissionEvent[] {
    const { events } = parseIntactLines<SubmissionEvent>(readTextIfExistsSync(path), path);
    return events;
  }

  function append(intent: SubmissionEventIntent): SubmissionEvent {
    const events = intact();
    const seq = events.length === 0 ? 1 : Math.max(...events.map((event) => event.seq)) + 1;
    const record: SubmissionEvent = { ...intent, seq, time: intent.time ?? new Date().toISOString() };
    appendFsyncedLineSync(path, JSON.stringify(record));
    return record;
  }

  return { append, read: intact };
}
