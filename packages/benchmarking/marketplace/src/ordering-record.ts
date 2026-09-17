// SPDX-License-Identifier: MIT

import {
  compareCodeUnitStrings,
  documentDigest,
  isCalendarStrictRfc3339,
  serializeCanonicalJson,
  sha256Hex,
  type JsonValue,
} from "@jinn-network/benchmarking-records";
import { isValidBlockHash } from "./canonical-bytes.js";
import type { CloseAnchorRef } from "./input-scope.js";

export const MARKETPLACE_ORDERING_SCHEMA_ID =
  "benchmark-product.marketplace-ordering/1" as const;

export const EVENT_ORDINAL_PAD_WIDTH = 6;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RUN_DIGEST = /^sha256:[0-9a-f]{64}$/;
const TASK_DIGEST = /^sha256:[0-9a-f]{64}$/;
const CHAIN = /^eip155:\d+$/;
const EVENT_PATH = /^ordering\/events\/(\d{6})-([0-9a-f]{64})\.json$/;
const SUBMISSION_PATH = /^ordering\/submissions\/([0-9a-f]{64})\.bin$/;

export class MarketplaceOrderingParseError extends Error {
  readonly code = "marketplace-ordering-parse" as const;

  constructor(readonly detail: string) {
    super(detail);
    this.name = "MarketplaceOrderingParseError";
  }
}

export interface MarketplaceOrderingEventEntry {
  readonly ordinal: number;
  readonly sha256: string;
  readonly path: string;
}

export interface MarketplaceOrderingSubmissionEntry {
  readonly submission: string;
  readonly task: `sha256:${string}`;
  readonly sha256: string;
  readonly path: string;
}

export interface MarketplaceOrderingTranscript {
  readonly runDigestAnchorAt: string;
  readonly earliestCellPostAt: string;
}

export interface MarketplaceOrderingRecord {
  readonly schema: typeof MARKETPLACE_ORDERING_SCHEMA_ID;
  readonly runDigest: `sha256:${string}`;
  readonly closeAnchor: CloseAnchorRef;
  readonly events: readonly MarketplaceOrderingEventEntry[];
  readonly submissions: readonly MarketplaceOrderingSubmissionEntry[];
  readonly transcript: MarketplaceOrderingTranscript;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysOf(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort(compareCodeUnitStrings);
}

function expectKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = keysOf(value);
  if (actual.length !== expected.length) {
    throw new MarketplaceOrderingParseError("unknown or missing keys");
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new MarketplaceOrderingParseError("unknown or missing keys");
    }
  }
}

function expectString(value: unknown, detail: string): string {
  if (typeof value !== "string") throw new MarketplaceOrderingParseError(detail);
  return value;
}

export function eventMemberPath(ordinal: number, sha256HexDigest: string): string {
  const padded = String(ordinal).padStart(EVENT_ORDINAL_PAD_WIDTH, "0");
  return `ordering/events/${padded}-${sha256HexDigest}.json`;
}

export function submissionMemberPath(sha256HexDigest: string): string {
  return `ordering/submissions/${sha256HexDigest}.bin`;
}

export function compareSubmissionEntries(
  left: MarketplaceOrderingSubmissionEntry,
  right: MarketplaceOrderingSubmissionEntry,
): number {
  return compareCodeUnitStrings(left.submission, right.submission)
    || compareCodeUnitStrings(left.task, right.task)
    || compareCodeUnitStrings(left.sha256, right.sha256);
}

function parseCloseAnchor(value: unknown): CloseAnchorRef {
  if (!isRecord(value)) throw new MarketplaceOrderingParseError("closeAnchor must be an object");
  expectKeys(value, ["blockHash", "blockNumber", "chain"]);
  const chain = expectString(value.chain, "closeAnchor.chain must be a string");
  if (!CHAIN.test(chain)) throw new MarketplaceOrderingParseError("closeAnchor.chain is not eip155:<id>");
  const blockNumber = value.blockNumber;
  if (
    typeof blockNumber !== "number"
    || !Number.isSafeInteger(blockNumber)
    || blockNumber < 0
  ) {
    throw new MarketplaceOrderingParseError("closeAnchor.blockNumber must be a non-negative safe integer");
  }
  const blockHash = expectString(value.blockHash, "closeAnchor.blockHash must be a string");
  if (!isValidBlockHash(blockHash)) {
    throw new MarketplaceOrderingParseError("closeAnchor.blockHash is not a 32-byte hash");
  }
  return { chain, blockNumber, blockHash };
}

function parseEventEntry(
  value: unknown,
  index: number,
): MarketplaceOrderingEventEntry {
  if (!isRecord(value)) throw new MarketplaceOrderingParseError("event entry must be an object");
  expectKeys(value, ["ordinal", "path", "sha256"]);
  const ordinal = value.ordinal;
  if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new MarketplaceOrderingParseError("event ordinal must be a non-negative safe integer");
  }
  if (ordinal !== index) {
    throw new MarketplaceOrderingParseError("event ordinal must equal its array index");
  }
  const sha256 = expectString(value.sha256, "event sha256 must be a string");
  if (!SHA256_HEX.test(sha256)) {
    throw new MarketplaceOrderingParseError("event sha256 must be 64 lowercase hex digits");
  }
  const path = expectString(value.path, "event path must be a string");
  const match = EVENT_PATH.exec(path);
  if (match === null) {
    throw new MarketplaceOrderingParseError("event path is unsafe or non-canonical");
  }
  if (Number(match[1]) !== ordinal || match[2] !== sha256) {
    throw new MarketplaceOrderingParseError("event path does not match ordinal and digest");
  }
  return { ordinal, sha256, path };
}

function parseSubmissionEntry(value: unknown): MarketplaceOrderingSubmissionEntry {
  if (!isRecord(value)) throw new MarketplaceOrderingParseError("submission entry must be an object");
  expectKeys(value, ["path", "sha256", "submission", "task"]);
  const submission = expectString(value.submission, "submission URN must be a string");
  if (submission.length === 0) throw new MarketplaceOrderingParseError("submission URN is empty");
  const task = expectString(value.task, "submission task must be a string");
  if (!TASK_DIGEST.test(task)) {
    throw new MarketplaceOrderingParseError("submission task must be sha256:<64 lowercase hex>");
  }
  const sha256 = expectString(value.sha256, "submission sha256 must be a string");
  if (!SHA256_HEX.test(sha256)) {
    throw new MarketplaceOrderingParseError("submission sha256 must be 64 lowercase hex digits");
  }
  const path = expectString(value.path, "submission path must be a string");
  const match = SUBMISSION_PATH.exec(path);
  if (match === null) {
    throw new MarketplaceOrderingParseError("submission path is unsafe or non-canonical");
  }
  if (match[1] !== sha256) {
    throw new MarketplaceOrderingParseError("submission path does not match digest");
  }
  return { submission, task: task as `sha256:${string}`, sha256, path };
}

function parseTranscript(value: unknown): MarketplaceOrderingTranscript {
  if (!isRecord(value)) throw new MarketplaceOrderingParseError("transcript must be an object");
  expectKeys(value, ["earliestCellPostAt", "runDigestAnchorAt"]);
  const runDigestAnchorAt = expectString(
    value.runDigestAnchorAt,
    "transcript.runDigestAnchorAt must be a string",
  );
  const earliestCellPostAt = expectString(
    value.earliestCellPostAt,
    "transcript.earliestCellPostAt must be a string",
  );
  if (!isCalendarStrictRfc3339(runDigestAnchorAt) || !isCalendarStrictRfc3339(earliestCellPostAt)) {
    throw new MarketplaceOrderingParseError("transcript timestamps must be calendar-strict RFC 3339");
  }
  return { runDigestAnchorAt, earliestCellPostAt };
}

export function parseMarketplaceOrderingRecord(value: unknown): MarketplaceOrderingRecord {
  if (!isRecord(value)) throw new MarketplaceOrderingParseError("record must be an object");
  expectKeys(value, [
    "closeAnchor",
    "events",
    "runDigest",
    "schema",
    "submissions",
    "transcript",
  ]);
  if (value.schema !== MARKETPLACE_ORDERING_SCHEMA_ID) {
    throw new MarketplaceOrderingParseError("schema id mismatch");
  }
  const runDigest = expectString(value.runDigest, "runDigest must be a string");
  if (!RUN_DIGEST.test(runDigest)) {
    throw new MarketplaceOrderingParseError("runDigest must be sha256:<64 lowercase hex>");
  }
  if (!Array.isArray(value.events)) throw new MarketplaceOrderingParseError("events must be an array");
  if (!Array.isArray(value.submissions)) {
    throw new MarketplaceOrderingParseError("submissions must be an array");
  }
  const events = value.events.map((entry, index) => parseEventEntry(entry, index));
  if (events.length === 0) throw new MarketplaceOrderingParseError("events must not be empty");
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.ordinal !== index) {
      throw new MarketplaceOrderingParseError("event ordinals are not contiguous from zero");
    }
  }
  const submissions = value.submissions.map((entry) => parseSubmissionEntry(entry));
  for (let index = 1; index < submissions.length; index += 1) {
    if (compareSubmissionEntries(submissions[index - 1]!, submissions[index]!) > 0) {
      throw new MarketplaceOrderingParseError("submissions are not sorted");
    }
  }
  const identities = new Map<string, string>();
  for (const entry of submissions) {
    const identity = `${entry.submission}\0${entry.task}`;
    const previous = identities.get(identity);
    if (previous !== undefined && previous !== entry.sha256) {
      throw new MarketplaceOrderingParseError("conflicting Submission identities");
    }
    // Identical byte material may be referenced more than once. Identity is
    // (submission, task); the sealed document must still bind to that identity.
    identities.set(identity, entry.sha256);
  }
  return {
    schema: MARKETPLACE_ORDERING_SCHEMA_ID,
    runDigest: runDigest as `sha256:${string}`,
    closeAnchor: parseCloseAnchor(value.closeAnchor),
    events,
    submissions,
    transcript: parseTranscript(value.transcript),
  };
}

export function serializeMarketplaceOrderingRecord(
  record: MarketplaceOrderingRecord,
): Uint8Array {
  return serializeCanonicalJson(record as unknown as JsonValue);
}

export function marketplaceOrderingRecordDigest(
  record: MarketplaceOrderingRecord,
): string {
  return sha256Hex(serializeMarketplaceOrderingRecord(record));
}

export function memberSha256Hex(bytes: Uint8Array): string {
  return documentDigest(bytes).slice("sha256:".length);
}
