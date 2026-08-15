// SPDX-License-Identifier: MIT

/**
 * The host-persisted campaign journal (product design §5.2).
 *
 * One campaign per directory: `campaign.json` holds the sealed document, `journal.jsonl` holds the
 * append-only ordering of decisions. "Authoritative *facts* live in the referenced sealed records;
 * the journal itself is the non-derivable ordering of product decisions." Nothing here interprets
 * a payload, computes a statistic, or decides anything — it records, in order, durably, once.
 *
 * A handle is an **immutable snapshot**. `appendCampaignEvent` returns a new one rather than
 * mutating in place, which is what makes "restart recovery" and "resume from a stale handle"
 * the same code path: `openCampaign` produces a handle indistinguishable from the one the
 * appending process was holding.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compareCalendarStrictRfc3339Instants } from "@jinn-network/benchmarking-records";
import { prefixedDigest } from "@jinn-network/policy-identity";
import type { CampaignBenchmarkBytes } from "./benchmark-disjointness.js";
import { parseExactCampaign, sealCampaign } from "./campaign.js";
import { issue, refuse, refuseAll } from "./errors.js";
import { checkExploringEntry, type ExploringEntryInput } from "./exploring-entry.js";
import { appendFsyncedLineSync, atomicWriteFileSync, readFileIfExistsSync, readTextIfExistsSync } from "./fs-atomic.js";
import {
  buildJournalEntry,
  journalEntryDigest,
  journalEntryText,
  parseExactJournalLine,
  type CampaignJournalEntry,
  type CampaignJournalEntryInput,
} from "./journal-entry.js";
import {
  applyEntry,
  checkEventLegality,
  entersExploring,
  EMPTY_LIFECYCLE_STATE,
  type CampaignLifecycleState,
} from "./journal-lifecycle.js";
import { CAMPAIGN_DOCUMENT_FILENAME, CAMPAIGN_JOURNAL_FILENAME } from "./tokens.js";
import type { CampaignDocument, SeedResolution } from "./types.js";

export interface CampaignHandle {
  readonly directory: string;
  readonly campaign: CampaignDocument;
  /** The sealed campaign document's digest — the identity every journal entry names. */
  readonly digest: string;
  readonly entries: readonly CampaignJournalEntry[];
  readonly state: CampaignLifecycleState;
}

export interface CreateCampaignInput {
  readonly directory: string;
  readonly campaign: CampaignDocument;
  /** The seed referents, so the §5.1 sealing-time frozen-axis check can actually run. */
  readonly seedResolutions: readonly SeedResolution[];
  /**
   * The two slates' exact bytes, when the creator holds them — review disposition M4's
   * sealing-time leg. Optional here and mandatory at `DRAFT → EXPLORING`.
   */
  readonly benchmarks?: CampaignBenchmarkBytes;
  readonly createdAt: string;
  readonly payload?: CampaignJournalEntryInput["payload"];
}

export interface AppendOptions {
  /**
   * Required exactly when the append crosses `DRAFT → EXPLORING`. Supplying the *inputs* rather
   * than a pre-computed verdict is deliberate: a caller cannot satisfy the gate by handing over an
   * admission object it made up.
   */
  readonly exploringEntry?: ExploringEntryInput;
}

/**
 * Is `candidate` recorded no earlier than `previous`?
 *
 * The comparison is a tri-state plus `undefined` for an uninterpretable instant. Both operands
 * have already passed `validateJournalEntry`'s calendar-strict check, so `undefined` should be
 * unreachable — which is exactly why it refuses rather than defaulting: an unreachable branch that
 * silently returns `true` is how an ordering claim quietly stops being checked.
 */
function recordedInOrder(previous: string, candidate: string, path: string): boolean {
  const comparison = compareCalendarStrictRfc3339Instants(candidate, previous);
  if (comparison === undefined) {
    refuse("journal-integrity", path, "recordedAt is not a calendar-valid RFC 3339 instant");
  }
  return comparison >= 0;
}

/**
 * MAJOR-1. Refuses when the journal on disk has moved on from what this handle believes.
 *
 * A handle is a snapshot, and two live handles on one directory are ordinary — a long-running
 * campaign process beside a CLI invocation, or a resumed process that never noticed a sibling.
 * Without this check the stale handle appends its next entry with a `previous` copied from its own
 * out-of-date head, and the line lands: the file then contains a chain that does not join and a
 * duplicated `seq`, so every subsequent `openCampaign` refuses. The journal would be wedged by a
 * write that looked locally valid.
 *
 * The check is a comparison, not a lock: line count plus the tail entry's digest. It closes the
 * stale-handle case completely. It does not make concurrent appends *atomic* — two processes that
 * both pass this check and then both write can still interleave, and the loser's line is caught on
 * the next open rather than at write time. Single-writer-per-campaign is the operating assumption;
 * this guard is what makes a violation of it loud instead of silent.
 */
function assertHandleIsCurrent(handle: CampaignHandle): void {
  const lines = readTextIfExistsSync(journalPath(handle.directory))
    .split("\n").filter((line) => line !== "");
  if (lines.length !== handle.entries.length) {
    refuse("journal-conflict", "entries",
      `this handle holds ${handle.entries.length} entries, the journal on disk holds ${lines.length}; another writer has moved it on`);
  }
  const tail = lines[lines.length - 1];
  if (tail === undefined) return;
  const onDisk = journalEntryDigest(parseExactJournalLine(tail));
  if (onDisk !== handle.state.head) {
    refuse("journal-conflict", "entries",
      "the journal's tail on disk is not the entry this handle believes it follows");
  }
}

function documentPath(directory: string): string {
  return join(directory, CAMPAIGN_DOCUMENT_FILENAME);
}

function journalPath(directory: string): string {
  return join(directory, CAMPAIGN_JOURNAL_FILENAME);
}

/**
 * Replays the journal into a derived state, checking the three integrity properties a resumed
 * journal must have: contiguous sequence from 1, an unbroken `previous` chain, and every entry
 * naming this campaign. A journal that fails any of them is refused rather than repaired — a
 * partially-believed ordering is worse than none, because the campaign would resume spending
 * against decisions it can no longer account for.
 */
function replay(campaignDigest: string, text: string): {
  entries: CampaignJournalEntry[];
  state: CampaignLifecycleState;
} {
  const entries: CampaignJournalEntry[] = [];
  let state = EMPTY_LIFECYCLE_STATE;
  const lines = text.split("\n").filter((line) => line !== "");

  for (const [index, line] of lines.entries()) {
    const entry = parseExactJournalLine(line);
    const position = index + 1;
    if (entry.campaign !== campaignDigest) {
      refuse("journal-integrity", `entries.${index}.campaign`,
        `entry names campaign ${entry.campaign}, this directory holds ${campaignDigest}`);
    }
    if (entry.seq !== position) {
      refuse("journal-integrity", `entries.${index}.seq`,
        `expected seq ${position}, found ${entry.seq}`);
    }
    if (entry.previous !== state.head) {
      refuse("journal-integrity", `entries.${index}.previous`,
        "the journal chain is broken; an entry does not follow the one before it");
    }
    const illegal = checkEventLegality(state, entry.type);
    if (illegal !== undefined) {
      refuseAll([issue(illegal.code, `entries.${index}.type`, illegal.message)]);
    }
    const path = `entries.${index}.recordedAt`;
    if (state.lastRecordedAt !== null
      && !recordedInOrder(state.lastRecordedAt, entry.recordedAt, path)) {
      refuse("journal-integrity", path, "an entry is recorded before the one it follows");
    }
    entries.push(entry);
    state = applyEntry(state, entry, journalEntryDigest(entry));
  }
  return { entries, state };
}

/**
 * Seals the campaign, writes it, and records `created`.
 *
 * Idempotent for the *same* campaign, and refusing for a different one. The two writes here — the
 * document, then the first journal line — cannot be one atomic act, so a crash between them is
 * reachable; a `create` that refused on sight of an existing document would turn that window into
 * a directory nobody can ever finish or reuse. Re-running with byte-identical inputs resumes it
 * instead, through exactly the same idempotent-replay path an ordinary append uses.
 */
export function createCampaign(input: CreateCampaignInput): CampaignHandle {
  const sealed = sealCampaign(input.campaign, input.seedResolutions, input.benchmarks);
  const created = {
    seq: 1,
    type: "created",
    recordedAt: input.createdAt,
    payload: input.payload,
  } as const;

  const existing = readFileIfExistsSync(documentPath(input.directory));
  if (existing !== undefined) {
    if (prefixedDigest(existing) !== sealed.digest) {
      refuse("journal-conflict", input.directory,
        "this directory already holds a different campaign; a sealed campaign is never replaced in place");
    }
    return appendCampaignEvent(openCampaign(input.directory), created);
  }
  if (existsSync(journalPath(input.directory))) {
    refuse("journal-conflict", input.directory,
      "this directory holds a journal with no campaign document");
  }

  mkdirSync(input.directory, { recursive: true });
  if (readdirSync(input.directory).length > 0) {
    refuse("journal-conflict", input.directory, "campaign directory is not empty");
  }
  atomicWriteFileSync(documentPath(input.directory), sealed.bytes);

  return appendCampaignEvent({
    directory: input.directory,
    campaign: sealed.campaign,
    digest: sealed.digest,
    entries: [],
    state: EMPTY_LIFECYCLE_STATE,
  }, created);
}

/**
 * Reads a campaign directory back into a handle. This is the whole of restart recovery.
 *
 * An empty journal is a legal state, not a corrupt one: it is the crash window inside
 * `createCampaign`, and the handle it returns takes the `created` append that finishes the job.
 */
export function openCampaign(directory: string): CampaignHandle {
  const bytes = readFileIfExistsSync(documentPath(directory));
  if (bytes === undefined) {
    refuse("journal-integrity", directory,
      `no ${CAMPAIGN_DOCUMENT_FILENAME} in this directory`);
  }
  const sealed = readSealedCampaign(bytes);
  const { entries, state } = replay(sealed.digest, readTextIfExistsSync(journalPath(directory)));
  return { directory, campaign: sealed.campaign, digest: sealed.digest, entries, state };
}

function readSealedCampaign(bytes: Uint8Array): { campaign: CampaignDocument; digest: string } {
  // The digest comes from the bytes on disk, not from a re-seal: `parseExactCampaign` has already
  // established that these bytes ARE the canonical form, so hashing them is hashing the document —
  // and a re-seal would need the seed referents, which a reader of the directory does not hold.
  return { campaign: parseExactCampaign(bytes), digest: prefixedDigest(bytes) };
}

/**
 * Appends one event.
 *
 * Three outcomes, and only three:
 *
 * - `seq` is already recorded and the entry it would produce is byte-identical → **no-op**, the
 *   idempotent-replay case a crashed caller re-enters on restart.
 * - `seq` is already recorded and the entry differs → **`journal-conflict`**. Two different
 *   decisions cannot occupy one position in an ordering; refusing is the only honest answer.
 * - `seq` is the next one and every guard passes → the line is fsynced before the new handle
 *   exists, so nothing downstream can observe a decision that is not yet durable.
 *
 * The last guard before the write is `assertHandleIsCurrent`: a handle whose view of the journal
 * is stale refuses rather than appending a line that would wedge the file for every future reader.
 */
export function appendCampaignEvent(
  handle: CampaignHandle,
  input: CampaignJournalEntryInput,
  options: AppendOptions = {},
): CampaignHandle {
  if (input.seq < 1 || !Number.isSafeInteger(input.seq)) {
    refuse("journal-conflict", "seq", "seq must be a positive integer");
  }

  if (input.seq <= handle.entries.length) {
    const recorded = handle.entries[input.seq - 1]!;
    const replayed = buildJournalEntry(handle.digest, recorded.previous, input);
    if (journalEntryText(replayed) !== journalEntryText(recorded)) {
      refuse("journal-conflict", `entries.${input.seq - 1}`,
        `seq ${input.seq} already records a different decision (${recorded.type} at ${recorded.recordedAt})`);
    }
    return handle;
  }

  if (input.seq !== handle.state.nextSeq) {
    refuse("journal-conflict", "seq",
      `expected seq ${handle.state.nextSeq}, received ${input.seq}; the journal admits no gaps`);
  }

  const illegal = checkEventLegality(handle.state, input.type);
  if (illegal !== undefined) refuseAll([illegal]);

  if (handle.state.lastRecordedAt !== null
    && !recordedInOrder(handle.state.lastRecordedAt, input.recordedAt, "recordedAt")) {
    refuse("journal-integrity", "recordedAt",
      `recordedAt ${input.recordedAt} predates the previous entry's ${handle.state.lastRecordedAt}`);
  }

  if (entersExploring(handle.state, input.type)) {
    const proof = options.exploringEntry;
    if (proof === undefined) {
      refuse("promotion-benchmark", "exploringEntry",
        "DRAFT -> EXPLORING requires the promotion Benchmark's bytes and reveal context (§6.3)");
    }
    const admission = checkExploringEntry(handle.campaign, proof);
    if (!admission.ok) {
      refuse("promotion-benchmark", "target.promotionBenchmark",
        `${admission.reason}: ${admission.detail}`);
    }
  }

  const entry = buildJournalEntry(handle.digest, handle.state.head, input);
  // Last, and immediately before the only write: every cheaper refusal has already run, and the
  // window between reading the tail and appending is as small as it can be made without a lock.
  assertHandleIsCurrent(handle);
  appendFsyncedLineSync(journalPath(handle.directory), journalEntryText(entry));
  return {
    ...handle,
    entries: [...handle.entries, entry],
    state: applyEntry(handle.state, entry, journalEntryDigest(entry)),
  };
}
