# Task Post Broadcast Intent Design

## Scope

Close the remaining cross-invocation safety gaps in machine-facing one-shot
Task submission without changing unrelated posting behavior:

- prevent a second process from blindly broadcasting when the first process
  crossed the wallet boundary but failed to persist the returned hash;
- classify owner-fence loss as recoverable at the command boundary without
  making it retryable inside Safe execution; and
- re-check machine-request freshness at the final wallet boundary after slow
  catalog, IPFS, RPC, and signing work.

## Durable state

`task_posts` gains a nullable `broadcast_intent_at` column through the existing
additive migration path. `TaskPostRecord` exposes the value as
`broadcastIntentAt`.

The Store provides one synchronous transaction that:

1. renews the matching `task_post_locks` row only when its owner token matches;
2. writes the current intent timestamp to the matching `task_posts` row; and
3. commits both changes together.

The transaction returns `false` on owner loss. Generic Task-post upserts retain
an existing intent when callers omit it. The final-boundary transaction may
refresh the timestamp for another wallet attempt owned by the same invocation.

## Posting state machine

For a machine post, the adapter's existing `beforeBroadcast` callback performs
these operations in order:

1. execute the command-supplied final freshness assertion using the current
   clock;
2. atomically renew ownership and persist broadcast intent; and
3. return directly to the Safe wallet write without another awaited operation.

If an unfinished stored post already has broadcast intent, the posting service
must invoke the existing exact recovery scan using creator Safe, signed Task
CID digest, and SolverNet manifest digest. A match is adopted idempotently. No
match raises a structured `TaskPostBroadcastUncertainError`; the adapter post
path is not entered. This deliberately treats a crash after intent but before
the actual write as uncertain, favoring at-most-once submission over blind
retry.

A completed `protocolTaskId` remains the authoritative idempotent state. The
intent is retained as audit/recovery provenance and does not change completed
result behavior.

## Error classification

Three named causes cross component boundaries:

- `TaskPostOwnershipLostError`: recoverable at the CLI boundary, but when
  wrapped by `SafeBroadcastFenceError` remains non-retryable inside the Safe
  transaction retry loop;
- `TaskPostBroadcastUncertainError`: CLI `transient_error` with
  `details.reason = "broadcast_uncertain"` and the intent timestamp; and
- `MarketplaceTaskRequestExpiredError`: command-entry failures remain invalid
  invocation errors, while a Safe-wrapped final-boundary failure is emitted as
  a stable policy-expiration rejection with
  `details.reason = "policy_expired"`.

The CLI walks the standard `cause` chain solely for these named classifications;
it does not broaden generic transaction retry rules.

## Tests

Test-first coverage must prove:

- legacy databases acquire the nullable column, owner mismatch cannot write
  intent, and later upserts preserve intent;
- after a first process persists intent, broadcasts, and fails its
  `onTransactionHash` Store write, a second Store/process performs exact
  recovery but never posts; a later visible `TaskCreated` is adopted;
- a crash after intent but before wallet write stays recoverable and never
  rebroadcasts;
- a real `executeSafeTransaction` fence wrapper caused by ownership loss emits
  CLI transient ownership classification with zero wallet writes; and
- a request live at command entry but expired during slow preparation fails
  the final callback with zero wallet writes and a stable policy-expiration
  result.
