// SPDX-License-Identifier: MIT

/**
 * The campaign lifecycle, derived from the journal (product design §5.2).
 *
 * `DRAFT → EXPLORING → CONFIRMING → CLOSED`. The design fixes the phases and closes the event
 * list, and it names no separate "phase changed" event — so the phase is **derived from the
 * events**, not stored beside them. That is the right shape for a journal whose whole job is to be
 * the ordering: a stored phase is a second copy of a fact the ordering already carries, and two
 * copies can disagree after a partial write.
 *
 * The derivation, pinned:
 *
 * | Phase | entered by | events legal in it |
 * | --- | --- | --- |
 * | `DRAFT` | `created` (seq 1, and nowhere else) | `candidate-admitted`, `candidate-rejected`, `wave-planned`, `closed` |
 * | `EXPLORING` | the first `wave-planned` | every event except `created` |
 * | `CONFIRMING` | `promotion-run-sealed` | `matrix-assembled`, `report-recorded`, `frontier-updated`, `closed` |
 * | `CLOSED` | `closed` | nothing |
 *
 * Three of those cells are load-bearing rather than tidy:
 *
 * - **`wave-planned` is the `EXPLORING` boundary.** A wave is where a campaign starts spending
 *   evaluation budget, and §6.3 requires the promotion gate to be committed and unrevealed *before*
 *   that happens. Seed admission is deliberately legal in `DRAFT`: admitting a seed spends the
 *   owner's own fetch-and-canary budget (§12) and reveals nothing about the promotion set.
 * - **`CONFIRMING` admits exactly one `promotion-run-sealed`**, which falls out of the table: the
 *   event enters the phase, and the phase does not admit it. §6.1's "a sealed Run is never amended"
 *   is the same rule from the records' side.
 * - **`CONFIRMING` admits no new candidates, allocations, or dev Runs.** The promotion Run is
 *   preregistered and single-shot (§6.3); a candidate admitted after it has no wave to run in, and
 *   an allocation decision after it would be optional stopping applied to the one measurement the
 *   design confines it away from (§6.2).
 */

import { issue, type PolicyOptimizationIssue } from "./errors.js";
import type { CampaignJournalEntry, CampaignJournalEventType } from "./journal-entry.js";
import { CAMPAIGN_LIFECYCLE_PHASES } from "./tokens.js";

export type CampaignLifecyclePhase = (typeof CAMPAIGN_LIFECYCLE_PHASES)[number];

const LEGAL_EVENTS: Readonly<Record<CampaignLifecyclePhase, readonly CampaignJournalEventType[]>> = {
  DRAFT: ["candidate-admitted", "candidate-rejected", "wave-planned", "closed"],
  EXPLORING: [
    "candidate-admitted", "candidate-rejected", "wave-planned", "allocation-decided",
    "run-sealed", "matrix-assembled", "report-recorded", "frontier-updated",
    "promotion-run-sealed", "closed",
  ],
  CONFIRMING: ["matrix-assembled", "report-recorded", "frontier-updated", "closed"],
  CLOSED: [],
};

/** The phase an event moves the campaign into, or `undefined` when it leaves the phase alone. */
function advance(
  phase: CampaignLifecyclePhase,
  type: CampaignJournalEventType,
): CampaignLifecyclePhase | undefined {
  if (type === "closed") return "CLOSED";
  if (type === "promotion-run-sealed") return "CONFIRMING";
  if (type === "wave-planned" && phase === "DRAFT") return "EXPLORING";
  return undefined;
}

export interface CampaignLifecycleState {
  readonly phase: CampaignLifecyclePhase;
  readonly entries: number;
  /** The `seq` a fresh append must carry. */
  readonly nextSeq: number;
  /** The digest a fresh append must carry as `previous`; `null` on an empty journal. */
  readonly head: string | null;
  /** The instant of the last entry; a fresh append may not predate it. */
  readonly lastRecordedAt: string | null;
  readonly eventCounts: Readonly<Partial<Record<CampaignJournalEventType, number>>>;
}

export const EMPTY_LIFECYCLE_STATE: CampaignLifecycleState = {
  phase: "DRAFT",
  entries: 0,
  nextSeq: 1,
  head: null,
  lastRecordedAt: null,
  eventCounts: {},
};

/**
 * Is `type` legal as the next event? Returns the issue rather than throwing, so the store can
 * report it beside the other refusal categories.
 *
 * The empty-journal case is its own rule: a campaign's journal begins with `created` and nothing
 * else, and `created` never appears again. Without that, a journal could be opened, resumed, and
 * "created" a second time in the middle of its own history.
 */
export function checkEventLegality(
  state: CampaignLifecycleState,
  type: CampaignJournalEventType,
): PolicyOptimizationIssue | undefined {
  if (state.entries === 0) {
    return type === "created"
      ? undefined
      : issue("lifecycle-violation", "type", "a campaign journal opens with `created`");
  }
  if (type === "created") {
    return issue("lifecycle-violation", "type", "`created` is the first entry and appears once");
  }
  if (state.phase === "CLOSED") {
    return issue("lifecycle-violation", "type",
      "the campaign is CLOSED; it has published its outputs and stopped spending (§5.2)");
  }
  if (!LEGAL_EVENTS[state.phase].includes(type)) {
    return issue("lifecycle-violation", "type", `${type} is not legal in ${state.phase}`);
  }
  return undefined;
}

/** Does this event cross the `DRAFT → EXPLORING` boundary, and therefore need the §6.3 admission? */
export function entersExploring(
  state: CampaignLifecycleState,
  type: CampaignJournalEventType,
): boolean {
  return state.phase === "DRAFT" && state.entries > 0 && advance("DRAFT", type) === "EXPLORING";
}

/** Folds one already-legal entry into the derived state. */
export function applyEntry(
  state: CampaignLifecycleState,
  entry: CampaignJournalEntry,
  entryDigest: string,
): CampaignLifecycleState {
  const counts = { ...state.eventCounts };
  counts[entry.type] = (counts[entry.type] ?? 0) + 1;
  return {
    phase: advance(state.phase, entry.type) ?? state.phase,
    entries: state.entries + 1,
    nextSeq: entry.seq + 1,
    head: entryDigest,
    lastRecordedAt: entry.recordedAt,
    eventCounts: counts,
  };
}

/** The events each phase admits — exported so the table is testable rather than only readable. */
export function legalEventsIn(phase: CampaignLifecyclePhase): readonly CampaignJournalEventType[] {
  return LEGAL_EVENTS[phase];
}
