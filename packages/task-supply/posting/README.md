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

## What v1 does not do

- No pricing engine — terms are operator-supplied (design §12).
- No derivation, no admission, no attestation reading. Posting carries the admission receipt by
  digest and never re-decides admission.
- No private evaluation material: v1 posts public-specification evaluation legs only, and
  `capabilityGrants` is never populated (design §8, D5).
