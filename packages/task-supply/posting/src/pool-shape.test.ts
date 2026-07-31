import type { SupplyPool } from "@jinn-network/task-derivation";
import { describe, expect, test } from "vitest";
import { planPosting, postingPoolEntry } from "./index.js";
import type { SuppliedPoolEntry } from "./pool-entry.js";
import type { PostingPoolEntry } from "./types.js";

// The one place this package names C4's contract.
//
// STOP-AND-REPORT, filed as F-C5-8 against the C5 plan's Task B5 (contract 11). The report is on
// the record in this package's README ("Reported to the program: F-C5-8"), which carries the
// options the program has to rule between; this file carries the compile-time half.
//
//   The plan asserts `(entry: PoolListing[number]) => PostingPoolEntry`. On
//   `supply/c4-task-derivation` that assertion does NOT compile. `SupplyPool.list()` yields
//   `PoolEntrySummary`, which differs from `PostingPoolEntry` in three ways:
//     1. no `taskBytes` -- the sealed bytes live on `PoolEntry`, read through `SupplyPool.get()`;
//     2. the admission receipt is named `receiptDigest`, not `admissionReceiptDigest`;
//     3. `evaluationSpecPublic` does not exist in C4 at all.
//   The plan's own pre-flight gate admits (1): it stops only when the pool exposes neither the
//   bytes "or a way to read them" nor a per-entry receipt digest, and C4 exposes both.
//
// Until the program rules on (2) and (3), `PostingPoolEntry` stays exactly as the plan pins it and
// the reconciliation lives in one named, tested adapter -- `postingPoolEntry` -- rather than in
// whatever each caller invents. That adapter is what closes the gap the finding named: D5's
// publicness is read off the sealed EvaluationSpec bytes the entry addresses, so the refusal is a
// fact about the bytes rather than a caller's assertion. Every pin below is a tripwire: if C4
// renames a field, drops one, or grows the two posting needs, one of these stops compiling and
// F-C5-8 is revisited.
type PoolListing = Awaited<ReturnType<SupplyPool["list"]>>;
type PoolListingEntry = PoolListing[number];
type PoolStoredEntry = NonNullable<Awaited<ReturnType<SupplyPool["get"]>>>;

// (a) The two digests posting and the pool already agree on, by name and by type.
const _taskDigestIsShared: (entry: PoolListingEntry) => PostingPoolEntry["taskDigest"] = (entry) =>
  entry.taskDigest;
const _evaluationSpecDigestIsShared: (
  entry: PoolListingEntry,
) => PostingPoolEntry["evaluationSpecDigest"] = (entry) => entry.evaluationSpecDigest;

// (b) The stored entry `SupplyPool.get()` returns is exactly the adapter's input: the sealed pair's
// bytes, the digests that address them, and the receipt digest. This is the identity assertion the
// plan wrote, at the one place where it does hold.
const _storedEntryIsSuppliable: (entry: PoolStoredEntry) => SuppliedPoolEntry = (entry) => entry;

// (c) And the adapter's output is what this application plans and posts, with no further widening.
const _suppliedEntryIsPostable: (entry: SuppliedPoolEntry) => PostingPoolEntry = (entry) =>
  postingPoolEntry(entry);

// (d) The two fields C4 does not model. Written as key assertions so this file fails to compile the
// moment C4 grows either one -- at which point the listing element itself becomes postable and the
// adapter's rename half falls away.
type PoolEntryKeys = keyof PoolListingEntry | keyof PoolStoredEntry;
const _admissionReceiptDigestIsNotYetModelled: Extract<
  PoolEntryKeys,
  "admissionReceiptDigest"
> extends never
  ? true
  : false = true;
const _evaluationSpecPublicIsNotYetModelled: Extract<
  PoolEntryKeys,
  "evaluationSpecPublic"
> extends never
  ? true
  : false = true;

describe("pool shape", () => {
  test("a C4 listing plans without adaptation", () => {
    const listing: readonly PostingPoolEntry[] = [];
    expect(planPosting(listing, {
      terms: {
        solutionMaxDeliveryRateWei: 1n, verdictMaxDeliveryRateWei: 1n,
        responseTimeoutSeconds: 60n, allowSolverSelfEvaluation: false, maxClaims: 1,
      },
      creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
      requester: "urn:uuid:11111111-2222-3333-4444-555555555555",
      now: "2026-07-31T00:00:00Z",
      deadlineSeconds: 60,
      batchLimit: 1,
    }).entries).toEqual([]);
  });

  test("the compile-time pins above are the contract; this run only proves the file loaded", () => {
    expect([
      _taskDigestIsShared,
      _evaluationSpecDigestIsShared,
      _storedEntryIsSuppliable,
      _suppliedEntryIsPostable,
      _admissionReceiptDigestIsNotYetModelled,
      _evaluationSpecPublicIsNotYetModelled,
    ]).toHaveLength(6);
  });
});
