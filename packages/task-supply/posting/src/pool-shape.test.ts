import type { SupplyPool } from "@jinn-network/task-derivation";
import { describe, expect, test } from "vitest";
import { planPosting, postingPoolEntry } from "./index.js";
import type { SuppliedPoolEntry } from "./pool-entry.js";
import type { PostingPoolEntry } from "./types.js";

// The one place this package names C4's contract.
//
// F-C5-8 is RESOLVED by program ruling R10 (see the program plan §8 and this package's README).
// The finding reported that the C5 plan's Task B5 assertion
// `(entry: PoolListing[number]) => PostingPoolEntry` does not compile against C4, because
// `SupplyPool.list()` yields `PoolEntrySummary`, which:
//   1. carries no `taskBytes` -- the sealed bytes live on `PoolEntry`, read through
//      `SupplyPool.get()`;
//   2. names the admission receipt `receiptDigest`, not `admissionReceiptDigest`;
//   3. models no `evaluationSpecPublic` at all.
//
// R10 ruled the plan wrong on all three counts, and C4 unchanged:
//   1. the two-step join IS the pool's contract -- listing stays cheap, bytes are fetched when a
//      caller actually needs them -- so the identity assertion belongs at `get()`, pinned at (b);
//   2. `receiptDigest` is the program-pinned name (§4, ruling R5); posting renames at its own
//      boundary, in `postingPoolEntry`;
//   3. publicness is DERIVED from the sealed EvaluationSpec bytes and never carried as a field.
//      D5 stamps `accessClass: "public"` on every access-classified descriptor at seal time, and
//      `evaluationSpecIsPublic` reads those stamps back, fail-closed. This is the load-bearing
//      half: a carried boolean would make every D5 refusal a caller's assertion, where a derived
//      one is a fact about the bytes the entry's own digest addresses.
//
// So `postingPoolEntry` is the settled design, not an interim workaround, and the pins below are
// permanent tripwires rather than a gap being tracked.
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

// (d) Publicness is never carried on a pool entry. This is a safety property under R10, not a gap:
// if C4 (or any future producer) grew an `evaluationSpecPublic` field, this stops compiling, and
// the fix is to keep deriving from bytes rather than to start trusting the field. A carried flag
// would silently downgrade D5's gate from "proven from the sealed specification" to "the producer
// said so".
//
// The rename half needs no pin of its own: (b) already fails to compile if C4 renames
// `receiptDigest`, because `SuppliedPoolEntry` requires that exact name.
type PoolEntryKeys = keyof PoolListingEntry | keyof PoolStoredEntry;
const _publicnessIsNeverCarriedOnThePoolEntry: Extract<
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
      _publicnessIsNeverCarriedOnThePoolEntry,
    ]).toHaveLength(5);
  });
});
