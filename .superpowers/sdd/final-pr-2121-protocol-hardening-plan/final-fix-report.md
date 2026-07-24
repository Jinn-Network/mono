# Final PR #2121 protocol-hardening fix report

Base: `48bd79b526ce926ff5aa0fd0386b99c1202af2d9`

## Design and root cause

### 1. Valid sibling verdicts

`verifyRouterAttemptProvenance` applied the solution conflict rule to both
roles: any event sharing the expected `(taskId, attemptIndex)` was related,
even when a verdict event used another legitimate request ID.

The fix makes relation role-specific:

- solution events retain the strict same-request **or** same-task/attempt
  conflict rule;
- verdict events are related only when they reuse the expected request ID;
- the expected verdict request must still occur exactly once with the expected
  Task, attempt, and evaluator;
- other verdict request IDs, including siblings on the same solution attempt,
  are ignored.

No verdict index is added to a public type or wire contract.

### 2. On-chain Task creation proof

The observer previously compared the expected CID and authenticated envelope
only to the indexer Task projection. A mutually forged indexer Task creation
block/transaction and envelope could therefore verify.

The observer now performs an independent Router log proof before verification:

- it scans only `TaskCreated` logs for the indexed expected Task ID;
- every RPC query is bounded to a 1,001-block inclusive chunk within the
  locally pinned `expected.fromBlock..expected.toBlock` range;
- it decodes with the existing Router ABI helper;
- it requires exactly one decoded event for the expected Task ID;
- it requires the RPC log's transaction hash and block number;
- it binds the event digest to `cidToDigestHex(expected.taskCid)`;
- it compares indexed digest/block/transaction to the event;
- it compares authenticated envelope Task block/transaction to the event;
- it returns the expected CID, now proven by the event digest, and the event's
  block/transaction as verified provenance.

The event already contains the authoritative Task CID digest, so the live
`getTaskCidDigest` state read is not used as a substitute for historical event
proof.

### 3. Immutable mismatch classification

Immutable recovery comparison threw an anonymous generic `Error`; the CLI
could not distinguish it from a fatal implementation failure.

The comparison now throws the internal named
`TaskPostImmutableCandidateMismatchError`. The machine submit CLI recognizes
that error only in the expired recovery context and emits the existing
`invalid_invocation` / `policy_expired` envelope. Canonical byte equality is
unchanged, and no ordinary posting or delivery behavior is relaxed.

## TDD evidence

All commands used Node 22 via:

`PATH=/opt/homebrew/Cellar/node@22/22.23.1/bin:$PATH`

### Finding 1 RED

Command:

`cd client && yarn vitest run test/autopilot/marketplace-delivery-observer.test.ts -t "legitimate sibling verdict request"`

Outcome: exit 1. One focused test failed because the observer returned
`contradiction` instead of `verified` for an exact verdict request accompanied
by a different legitimate sibling request.

### Finding 1 GREEN

Command:

`cd client && yarn vitest run test/autopilot/marketplace-delivery-observer.test.ts -t "verdict request"`

Outcome: exit 0. Two focused tests passed: exact-plus-sibling acceptance and
conflicting reuse of the expected request rejection.

### Finding 2 RED

Command:

`cd client && yarn vitest run test/autopilot/marketplace-delivery-observer.test.ts -t "on-chain TaskCreated provenance"`

Outcome: exit 1. Five focused cases failed because missing, duplicate,
digest-mismatched, transaction-incomplete, and block-incomplete Router events
all incorrectly returned `verified`.

### Finding 2 GREEN

Command:

`cd client && yarn vitest run test/autopilot/marketplace-delivery-observer.test.ts -t "TaskCreated provenance|forged indexed Task|exact indexed"`

Outcome: exit 0. Nine focused cases passed, covering the valid event proof,
missing/duplicate/digest/incomplete events, and forged indexed CID
digest/block/transaction (including mutually forged indexer/envelope
provenance).

### Finding 3 RED

Command:

`cd client && yarn vitest run test/cli/commands/tasks.test.ts -t "immutable mismatch"`

Outcome: exit 1. The expired recovery-only retry produced `fatal` instead of
`invalid_invocation`; the second invocation made zero post/recovery calls.

### Finding 3 GREEN

Command:

`cd client && yarn vitest run test/cli/commands/tasks.test.ts -t "immutable mismatch"`

Outcome: exit 0. The retry produced `invalid_invocation` with
`policy_expired`, and both recovery and second-broadcast spies remained at
zero calls.

## Files changed

- `client/src/adapters/mech/contracts.ts`
  - role-specific verdict/solution related-event classification.
- `client/src/autopilot/marketplace-delivery-observer.ts`
  - internal chunked exact `TaskCreated` proof and on-chain-authoritative
    comparisons/return provenance.
- `client/src/tasks/posting-service.ts`
  - internal named immutable-candidate mismatch error.
- `client/src/cli/commands/tasks.ts`
  - expired recovery mismatch mapping to `invalid_invocation`.
- `client/test/autopilot/marketplace-delivery-observer.test.ts`
  - verdict sibling/conflict and Task creation proof regressions.
- `client/test/cli/commands/tasks.test.ts`
  - expired immutable mismatch/zero-broadcast CLI regression.

No SDK schema, SDK export, wire version, public observer result shape, or
non-Autopilot delivery path changed.

## Verification

Focused observer suite:

`cd client && yarn vitest run test/autopilot/marketplace-delivery-observer.test.ts`

Outcome: exit 0, 1 file and 53 tests passed.

All requested focused suites:

`cd client && yarn vitest run test/autopilot/marketplace-delivery-observer.test.ts test/cli/commands/tasks-observe-autopilot.test.ts test/cli/commands/tasks.test.ts test/tasks/submit-preflight.test.ts test/tasks/submit-selection.test.ts test/tasks/posting-service.test.ts`

Outcome: exit 0, 6 files and 127 tests passed.

Client typecheck:

`cd client && yarn typecheck`

Outcome: exit 0. SDK, plugin, and core dependency builds plus client
`tsc --noEmit` completed. Yarn emitted its pre-existing portal
`--preserve-symlinks` warning; no type error occurred.

Diff whitespace check:

`git diff --check`

Outcome: exit 0 with no output.

## Self-review

- Mutating verdict classification back to the old shared-task/attempt rule
  fails the sibling regression.
- Ignoring all non-exact verdict events still fails the expected-request reuse
  regression.
- Removing the TaskCreated scan makes all missing/duplicate/digest/incomplete
  regressions fail.
- Trusting indexer or envelope creation provenance instead of the decoded event
  fails the forged block/transaction regressions.
- Replacing the named immutable mismatch with generic `Error` fails the CLI
  classification regression.
- Solution role retains its original strict same-task/attempt mismatch rule.
- Duplicate exact attempt events and duplicate exact TaskCreated events fail
  closed.
- RPC failures remain pending; authenticated contradictions remain
  contradictions.
- The observer returns only the decoded event block/transaction after all
  comparisons pass.
- The recovery CLI test proves zero second transaction broadcast and zero
  recovery call on mismatched immutable bytes.

## Concerns

No product or protocol concerns found. The only verification noise is the
non-failing Yarn portal warning described above.
