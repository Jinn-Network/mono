// SPDX-License-Identifier: MIT

/**
 * One journal entry: its envelope, its canonical bytes, and the chain link to its predecessor
 * (product design §5.2).
 *
 * The journal is "the **non-derivable ordering of product decisions** — admissions, allocations,
 * wave boundaries — which cannot be reconstructed from records and is exactly what it exists to
 * preserve. It is not network truth." Two consequences are built into this envelope:
 *
 * - **`seq` is explicit, not positional.** A caller that replays "entry 7" after a crash is asking
 *   a different question from a caller appending the next entry, and a positional API cannot tell
 *   them apart — so it silently duplicates decisions on every restart.
 * - **`previous` chains the entries by digest.** Ordering is the whole content of this file; a
 *   journal whose middle was rewritten between restarts must fail to open rather than resume as
 *   though the rewrite were the truth. The chain is host-local integrity, not a network claim —
 *   and its reach is exactly "every entry that has a successor". A rewritten **tail** chains to
 *   nothing and opens cleanly; catching that needs an external commitment, which v0 has nowhere by
 *   design (product §11: a v0 owner "can retro-write a host-local journal — invisibly"). The
 *   chain is here to catch a corrupted or half-edited file, not a determined owner.
 *
 * `payload` is validated as canonical JSON and nothing more. Per-event payload schemas belong to
 * the sub-unit that emits them (the wave engine's `allocation-decided`, admission's
 * `candidate-admitted`); freezing them here would be this unit legislating for units that have not
 * been designed yet.
 */

import { canonicalJsonBytes, canonicalJsonText, prefixedDigest } from "@jinn-network/policy-identity";
import { isCalendarStrictRfc3339 } from "@jinn-network/benchmarking-records";
import { issue, refuseAll, type PolicyOptimizationIssue, type ValidationResult } from "./errors.js";
import {
  CAMPAIGN_JOURNAL_ENTRY_FORMAT_TOKEN,
  CAMPAIGN_JOURNAL_EVENT_TYPES,
} from "./tokens.js";
import type { JsonValue } from "./types.js";

export type CampaignJournalEventType = (typeof CAMPAIGN_JOURNAL_EVENT_TYPES)[number];

const EVENT_TYPES = new Set<string>(CAMPAIGN_JOURNAL_EVENT_TYPES);
const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;

export interface CampaignJournalEntry {
  readonly formatToken: string;
  /** The sealed campaign document's digest. Every entry names the campaign it orders. */
  readonly campaign: string;
  /** 1-based and contiguous. */
  readonly seq: number;
  /** `sha256:` over the previous entry's canonical bytes; `null` at `seq` 1. */
  readonly previous: string | null;
  readonly type: CampaignJournalEventType;
  /** RFC 3339 with a mandatory offset. Non-decreasing across the journal. */
  readonly recordedAt: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

/** What a caller supplies; `campaign` and `previous` are the journal's to fill in. */
export interface CampaignJournalEntryInput {
  readonly seq: number;
  readonly type: CampaignJournalEventType;
  readonly recordedAt: string;
  readonly payload?: Readonly<Record<string, JsonValue>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_FIELDS = new Set([
  "formatToken", "campaign", "seq", "previous", "type", "recordedAt", "payload",
]);

export function validateJournalEntry(input: unknown): ValidationResult<CampaignJournalEntry> {
  const errors: PolicyOptimizationIssue[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [issue("journal-integrity", "", "a journal entry must be a JSON object")] };
  }
  if (input["formatToken"] !== CAMPAIGN_JOURNAL_ENTRY_FORMAT_TOKEN) {
    errors.push(issue("journal-integrity", "formatToken",
      `formatToken must be ${CAMPAIGN_JOURNAL_ENTRY_FORMAT_TOKEN}`));
  }
  if (typeof input["campaign"] !== "string" || !SHA256_PREFIXED.test(input["campaign"])) {
    errors.push(issue("journal-integrity", "campaign", "campaign must be sha256:<64 lowercase hex>"));
  }
  const seq = input["seq"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    errors.push(issue("journal-integrity", "seq", "seq must be a positive integer"));
  }
  const previous = input["previous"];
  if (previous !== null && (typeof previous !== "string" || !SHA256_PREFIXED.test(previous))) {
    errors.push(issue("journal-integrity", "previous",
      "previous must be sha256:<64 lowercase hex>, or null at seq 1"));
  }
  if (seq === 1 && previous !== null) {
    errors.push(issue("journal-integrity", "previous", "the first entry has no predecessor"));
  }
  if (typeof seq === "number" && seq > 1 && previous === null) {
    errors.push(issue("journal-integrity", "previous", "only the first entry may have no predecessor"));
  }
  if (typeof input["type"] !== "string" || !EVENT_TYPES.has(input["type"])) {
    errors.push(issue("journal-integrity", "type",
      `type must be one of ${[...CAMPAIGN_JOURNAL_EVENT_TYPES].join(", ")}`));
  }
  if (typeof input["recordedAt"] !== "string" || !isCalendarStrictRfc3339(input["recordedAt"])) {
    errors.push(issue("journal-integrity", "recordedAt",
      "recordedAt must be a calendar-valid RFC 3339 instant with an offset"));
  }
  if (!isPlainObject(input["payload"])) {
    errors.push(issue("journal-integrity", "payload", "payload must be a JSON object (possibly empty)"));
  }
  for (const key of Object.keys(input)) {
    if (KNOWN_FIELDS.has(key)) continue;
    errors.push(issue("journal-integrity", key, "unrecognized journal entry field"));
  }
  if (errors.length > 0) return { ok: false, errors };
  try {
    canonicalJsonText(input as JsonValue);
  } catch (cause) {
    return {
      ok: false,
      errors: [issue("journal-integrity", "payload",
        `entry is not canonicalizable: ${cause instanceof Error ? cause.message : String(cause)}`)],
    };
  }
  return { ok: true, value: input as unknown as CampaignJournalEntry };
}

/** Builds the entry an input becomes, given the campaign it orders and the head it follows. */
export function buildJournalEntry(
  campaignDigest: string,
  previous: string | null,
  input: CampaignJournalEntryInput,
): CampaignJournalEntry {
  const entry: CampaignJournalEntry = {
    formatToken: CAMPAIGN_JOURNAL_ENTRY_FORMAT_TOKEN,
    campaign: campaignDigest,
    seq: input.seq,
    previous,
    type: input.type,
    recordedAt: input.recordedAt,
    payload: input.payload ?? {},
  };
  const validated = validateJournalEntry(entry);
  if (!validated.ok) refuseAll(validated.errors);
  return validated.value;
}

/** The exact line an entry occupies on disk: canonical JSON, one entry, no newline. */
export function journalEntryText(entry: CampaignJournalEntry): string {
  return canonicalJsonText(entry as unknown as JsonValue);
}

/** `sha256:` over the entry's canonical bytes — the value its successor carries as `previous`. */
export function journalEntryDigest(entry: CampaignJournalEntry): string {
  return prefixedDigest(canonicalJsonBytes(entry as unknown as JsonValue));
}

/**
 * Parses one journal line. As with every sealed surface in this stack, the bytes must already BE
 * the canonical form: a line that parses to the right entry but is not its canonical encoding
 * would chain to a different digest than the one its successor recorded.
 */
export function parseExactJournalLine(line: string): CampaignJournalEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    refuseAll([issue("journal-integrity", "", "journal line is not valid JSON")]);
  }
  const result = validateJournalEntry(parsed);
  if (!result.ok) refuseAll(result.errors);
  if (journalEntryText(result.value) !== line) {
    refuseAll([issue("journal-integrity", "",
      "journal line is not the canonical encoding of the entry it carries")]);
  }
  return result.value;
}
