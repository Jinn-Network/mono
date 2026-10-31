// SPDX-License-Identifier: Apache-2.0

/**
 * What a check returns. A result is data: a bad record never throws, and a check that did not run
 * says `skipped` and why, so nothing reads as passed that was not checked.
 */

export type CheckStatus = "passed" | "failed" | "skipped";

export type RecordCheckId = "digest" | "encoding" | "schema" | "signature" | "trust-binding";
export type SetCheckId = "references" | "lifecycle" | "anchors";
export type CheckId = RecordCheckId | SetCheckId;

export interface Finding {
  readonly code: string;
  /** What the finding is about: a key, an Attempt, or the record a reference left from. */
  readonly subject?: string;
  /** Where in the record, in the notation of the validator that reported it. */
  readonly path?: string;
  readonly detail: string;
}

/** On `failed`, the findings say what failed; on `skipped`, why; on `passed`, what it did not cover. */
export interface CheckResult<Id extends CheckId = CheckId> {
  readonly id: Id;
  readonly status: CheckStatus;
  readonly findings: readonly Finding[];
}

export function passed<Id extends CheckId>(id: Id, findings: readonly Finding[] = []): CheckResult<Id> {
  return { id, status: "passed", findings };
}

export function failed<Id extends CheckId>(id: Id, findings: readonly Finding[]): CheckResult<Id> {
  return { id, status: "failed", findings };
}

export function skipped<Id extends CheckId>(id: Id, code: string, detail: string): CheckResult<Id> {
  return { id, status: "skipped", findings: [{ code, detail }] };
}

/** Stands in for a kind id when no registered kind claims a record. */
export const UNKNOWN_KIND = "unknown";

/**
 * - `failed`: at least one check failed.
 * - `unknown-kind`: no registered kind claims the record, so only digest and encoding were looked at.
 * - `checked`: the kind is known and no check failed. Read `checks` for what ran: some may be skipped.
 */
export type RecordOutcome = "failed" | "unknown-kind" | "checked";

/** The DSSE signatures a record carries, and what became of each. */
export interface SignatureCounts {
  readonly total: number;
  /** Verified, under any key. */
  readonly verified: number;
  /** Of `verified`, those under a key the caller supplied. That shows a key signed, not whose it is. */
  readonly verifiedWithSuppliedKey: number;
  /** Under a key that is known, and did not verify. */
  readonly invalid: number;
  /** Not verified at all: no key was known, or the record's kind is unknown. */
  readonly unverified: number;
}

export interface RecordReport {
  /** `sha256:` of the exact bytes received, whether or not a digest was claimed for them. */
  readonly digest: `sha256:${string}`;
  /** A key of the kinds registry, or `unknown`. */
  readonly kind: string;
  readonly family?: string;
  /** The type identifier the bytes name for themselves, known to the registry or not. */
  readonly names?: string;
  readonly outcome: RecordOutcome;
  /** All five, in order, with `skipped` where a check did not run. */
  readonly checks: readonly CheckResult<RecordCheckId>[];
  readonly signatures: SignatureCounts;
}

export function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
