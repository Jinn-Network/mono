# @jinn-network/task-posting

Supply policy for marketplace posting: which pool entries post, when, at what terms, under whose
identity, with the escrow surfaced before spending.

`planPosting(pool, policy)` is pure — a materialized pool listing plus a policy in, a
`PostingPlan` out, carrying per-entry and total escrow. `executePosting(deps, plan)` surfaces that
plan, requires approval before spending, and posts through injected ports. Explicit post is the
default; auto-post is an opt-in standing policy flag with the same visibility in a log line.

The plan is the replay unit: the sealed dispatch Submission is a function of the plan alone, so
re-executing the same plan produces byte-identical Submission bytes, the same broadcast-intent
key, and a replayed outcome rather than a second post.

## Named residual: the work client (F7)

This package owns supply **policy** only. *How to post safely* — posting and settlement mechanics,
the preflight core, requester-side evaluation sealing, custody discipline — is the work client's
job (`packages/marketplace/work-client`), whose design already owns it under a no-wrapper-layers
rule. The work client's mint is gated on daemon cutover stage 3 plus published canaries; until
then this package composes the marketplace binding's `postTask` plus the D7 on-ramp adapters
directly.

That interim composition is a **named residual of the same class the consumption-boundary design
already records for benchmarking's marketplace venue**, with the same disposition: **at
work-client mint, task-posting adopts the work client's posting core beneath its policy surface —
same code, no fork.** Filed as F7 in
`docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md` §13. The swap point is
the injected `PostingDeps.postTask` and `PostingDeps.ports`; no policy code changes with it.

## Reported to the program: F-C5-8 (open — needs a ruling)

**The pool listing this package is pinned to consume is not `PostingPoolEntry`, and one field of
`PostingPoolEntry` has no producer anywhere in the stack.** The C5 plan's Task B5 pins
`(entry: PoolListing[number]) => PostingPoolEntry` and instructs a stop-and-report if it does not
compile (program §5 contract 11). It does not compile. This is that report.

On `supply/c4-task-derivation`, `SupplyPool.list()` yields `PoolEntrySummary`:

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

**What this branch does in the interim.** `PostingPoolEntry` is untouched — it is exactly what the
plan pins, and it was not widened. The reconciliation lives in one named, tested adapter,
`postingPoolEntry(entry, options)`, which carries C4's `receiptDigest` into
`admissionReceiptDigest` and **derives** `evaluationSpecPublic` from the sealed EvaluationSpec
bytes the entry's own digest addresses: D5's stamping writes `accessClass: "public"` onto every
access-classified descriptor at seal time, and `evaluationSpecIsPublic` reads those stamps back,
failing closed on an unstamped specification, a private stamp, a non-string stamp, or bytes that
are not a JSON document. `src/pool-shape.test.ts` pins C4's stored entry against the adapter's
input type at compile time, so a rename on either side stops the build.

**What the program still has to rule on**, before the tier-4 ops note is written against this
surface:

1. rename C4's `receiptDigest` to `admissionReceiptDigest` (or have posting accept both), so the
   listing element is postable without an adapter; and
2. where `evaluationSpecPublic` is owned — derived at the posting boundary as it is here, or
   modelled on the pool entry by C4 and carried; and
3. whether the adapter (`postingPoolEntry`, `evaluationSpecIsPublic`, `SuppliedPoolEntry`) stays on
   this package's public surface, which is a name the program's §4 "C5 produces" list does not
   carry.

## What v1 does not do

- No pricing engine — terms are operator-supplied (design §12).
- No derivation, no admission, no attestation reading. Posting carries the admission receipt by
  digest and never re-decides admission.
- No private evaluation material: v1 posts public-specification evaluation legs only, and
  `capabilityGrants` is never populated (design §8, D5).
