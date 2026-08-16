# @jinn-network/task-posting

> Candidate in `implementations-v1`. Eligible for receipt-gated canary; that is not independent ratification.

Supply policy for marketplace posting: which pool entries post, when, at what terms, under whose
identity, with the escrow surfaced before spending.

`planPosting(pool, policy)` is pure — a materialized pool listing plus a policy in, a
`PostingPlan` out, carrying per-entry and total escrow. `executePosting(deps, plan)` surfaces that
plan, requires approval before spending, and posts through an injected requester backend.
Explicit post is the default; auto-post is an opt-in standing policy flag with the same visibility
in a log line.

The plan is the replay unit: the sealed dispatch Submission is a function of the plan alone, so
re-executing the same plan produces byte-identical Submission bytes, the same broadcast-intent
key, and a replayed outcome rather than a second post.

## Requester posting boundary

This package owns supply **policy** only. `PostingDeps.backend` is the existing
`MarketplaceRequesterBackend` from `@jinn-network/marketplace-binding`. It owns exact Task and
Submission admission, requester/idempotency scope, the posting WAL, recovered outcome
reconciliation and the actual transaction. This package never receives raw chain configuration,
wallet/broadcast ports, or a direct `postTask` function. The host must compose the backend with the
same creator and terms used to construct the plan; those configured venue inputs do not cross the
per-post operation boundary.

`executePosting` calls `backend.post(taskBytes, submissionBytes)` only after the plan is surfaced,
approval is granted and the complete batch passes its pure preflight. A recovered backend outcome
is accepted exactly like the original result. A retryable unresolved operation is reported as
uncertain and is never retried here; the host may invoke `backend.recoverPosting()` before a later
policy run. No separate work-client package or wrapper is required.

## Reported to the program: F-C5-8 (resolved — ruling R10)

**The pool listing this package is pinned to consume is not `PostingPoolEntry`, and one field of
`PostingPoolEntry` has no producer anywhere in the stack.** The C5 plan's Task B5 pins
`(entry: PoolListing[number]) => PostingPoolEntry` and instructs a stop-and-report if it does not
compile (program §5 contract 11). It does not compile. This is that report.

The task-derivation `SupplyPool.list()` yields `PoolEntrySummary`:

| `PostingPoolEntry` needs | C4 has |
| --- | --- |
| `taskBytes` | on `PoolEntry` via `SupplyPool.get()`, not on the listing element |
| `admissionReceiptDigest` | the same value, named `receiptDigest` |
| `evaluationSpecPublic` | not modelled — no package in the stack computes it |

The plan's own pre-flight gate accepts the first row (it stops only when the pool exposes neither
the bytes "or a way to read them" nor a per-entry receipt digest). The other two are unreconciled
between C4's pool contract and spec §8's posting inputs.

`evaluationSpecPublic` is the load-bearing one: it is the sole gate implementing D5 ("v1 posts
public-specification evaluation legs only") in both `planPosting` (the `evaluation-not-public`
skip) and `buildDispatchSubmission` (`assertPublicSpecEvaluationLeg`). A boolean nobody produces
makes every D5 refusal a caller's claim rather than a fact about the sealed bytes.

**What this package does.** `PostingPoolEntry` is untouched — it is exactly what the
plan pins, and it was not widened. The reconciliation lives in one named, tested adapter,
`postingPoolEntry(entry, options)`, which carries C4's `receiptDigest` into
`admissionReceiptDigest` and **derives** `evaluationSpecPublic` from the sealed EvaluationSpec
bytes the entry's own digest addresses: D5's stamping writes `accessClass: "public"` onto every
access-classified descriptor at seal time, and `evaluationSpecIsPublic` reads those stamps back,
failing closed on an unstamped specification, a private stamp, a non-string stamp, or bytes that
are not a JSON document. `src/pool-shape.test.ts` is the package's sole, test-only dependency on
task derivation; it pins C4's stored entry against the adapter input type at compile time, so a
rename on either side stops the build.

**How the program ruled (R10).** The C5 plan was wrong on every count; C4 is unchanged.

1. **`receiptDigest` stays C4's name** — it is what the program pinned (§4, ruling R5). Posting
   renames at its own boundary. The plan's alternative, renaming C4 to match the plan's guess,
   would have churned a pinned interface to spare this package one adapter.
2. **`evaluationSpecPublic` is derived here, permanently** — never modelled on the pool entry and
   never carried. Deriving it from the sealed bytes is what makes a D5 refusal a fact about the
   specification rather than a claim by whoever produced the entry; a carried boolean would be a
   silent downgrade of the gate. `src/pool-shape.test.ts` pin (d) fails the build if any producer
   grows such a field, and the fix in that case is to keep deriving, not to start trusting it.
3. **The adapter stays on the public surface.** `postingPoolEntry`, `evaluationSpecIsPublic`, and
   `SuppliedPoolEntry` are exported: the tier-4 composition is the only place holding both a pool
   and this application, so it is the caller that needs them, and exporting the tested adapter is
   what stops each composition from inventing a looser one. The program's §4 "C5 produces" list is
   amended accordingly.

The plan's Task B5 identity assertion is likewise amended: it pins the two-step join
(`SupplyPool.get()` → `SuppliedPoolEntry` → `PostingPoolEntry`) rather than the listing element,
because a listing that carried every pair's sealed bytes would be the wrong contract for a pool
that exists to be enumerated cheaply.

## What v1 does not do

- No pricing engine — terms are operator-supplied (design §12).
- No derivation, no admission, no attestation reading. Posting carries the admission receipt by
  digest and never re-decides admission.
- No private evaluation material: v1 posts public-specification evaluation legs only, and
  `capabilityGrants` is never populated (design §8, D5).
