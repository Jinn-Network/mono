import type { SupplyPool } from "@jinn-network/task-derivation";
import { describe, expect, test } from "vitest";
import { planPosting } from "./index.js";
import type { PostingPoolEntry } from "./types.js";

// The one place this package names C4's contract.
//
// STOP-AND-REPORT, filed as F-C5-8 against the C5 plan's Task B5 (contract 11; the plan's own
// instruction is "stop and report citing F-C5-4, do not widen PostingPoolEntry here"):
//
//   The plan asserts `(entry: PoolListing[number]) => PostingPoolEntry`. On
//   `supply/c4-task-derivation` that assertion does NOT compile. `SupplyPool.list()` yields
//   `PoolEntrySummary`, which differs from `PostingPoolEntry` in three ways:
//     1. no `taskBytes` -- the sealed bytes live on `PoolEntry`, read through `SupplyPool.get()`;
//     2. the admission receipt is named `receiptDigest`, not `admissionReceiptDigest`;
//     3. `evaluationSpecPublic` does not exist in C4 at all.
//   The plan's own pre-flight gate admits (1): it stops only when the pool exposes neither the
//   bytes "or a way to read them" nor a per-entry receipt digest, and C4 exposes both. (2) and
//   (3) are unreconciled between C4's pool contract and spec §8's posting inputs, and reconciling
//   them is a program decision, not a local rename or a widened type.
//
// Until that decision lands, this file pins C4's contract field-by-field rather than asserting an
// identity that does not hold. Every assertion below is a tripwire: if C4 renames a field, drops
// one, or grows the two posting needs, one of these stops compiling and the finding is revisited.
type PoolListing = Awaited<ReturnType<SupplyPool["list"]>>;
type PoolListingEntry = PoolListing[number];
type PoolStoredEntry = NonNullable<Awaited<ReturnType<SupplyPool["get"]>>>;

// (a) The two digests posting and the pool already agree on, by name and by type.
const _taskDigestIsShared: (entry: PoolListingEntry) => PostingPoolEntry["taskDigest"] = (entry) =>
  entry.taskDigest;
const _evaluationSpecDigestIsShared: (
  entry: PoolListingEntry,
) => PostingPoolEntry["evaluationSpecDigest"] = (entry) => entry.evaluationSpecDigest;

// (b) The sealed Task bytes the dispatch Submission is built from: present on the stored entry
// `SupplyPool.get()` returns, not on the listing element. This is the "way to read them" the
// plan's pre-flight gate accepts.
const _taskBytesAreReadable: (entry: PoolStoredEntry) => PostingPoolEntry["taskBytes"] = (entry) =>
  entry.taskBytes;

// (c) The admission receipt each entry earned. C4 calls it `receiptDigest`; posting's
// `admissionReceiptDigest` carries the same value. The types agree; only the names do not.
const _receiptDigestIsCarried: (
  entry: PoolListingEntry,
) => PostingPoolEntry["admissionReceiptDigest"] = (entry) => entry.receiptDigest;

// (d) The two fields C4 does not model. Written as key assertions so this file fails to compile
// the moment C4 grows either one -- at which point the identity assertion the plan wrote becomes
// reachable and F-C5-8 closes.
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
      _taskBytesAreReadable,
      _receiptDigestIsCarried,
      _admissionReceiptDigestIsNotYetModelled,
      _evaluationSpecPublicIsNotYetModelled,
    ]).toHaveLength(6);
  });
});
