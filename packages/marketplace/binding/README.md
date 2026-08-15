# @jinn-network/marketplace-binding

The chain-venue Task Execution Protocol (TEP) v1 binding: maps sealed Task / Submission /
Delivery documents onto the deployed OLAS-native Base substrate (TaskCoordinator + JinnRouterV3
+ OLAS Mech Marketplace), behind a two-contract-generation seam (`today` targets the deployed
contracts unchanged; `revised` targets the specified contract revision, built later).

See the design: `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md`. Implementation
plan: `docs/superpowers/plans/2026-07-28-marketplace-binding.md`.

## Current capability boundary

- The `ContractGeneration = "today" | "revised"` seam and the deployed today-mode address config
  (`src/generation.ts`, `src/addresses.ts`, design §5.4).
- Per-package sealing utilities for the binding's own backend-internal canonical bytes only —
  never a re-seal of a TEP or discovery document family (`src/order.ts`, `src/canonical-json.ts`,
  program §7.1/§7.14/§7.15).
- The marketplace Attempt-URI derivation: a thin adapter over
  `@jinn-network/task-execution-protocol`'s exported `deriveAttemptUri` +
  `TEP_ATTEMPT_NAMESPACE` — never re-derived (`src/attempt-uri.ts`, plan Milestone M1, must #2).
- The named, binding-side type declaration of the two-party engagement entry
  (`src/two-party-engagement.ts`) — the exact shape the pipeline will hand to the embedded local
  backend's assembly `submit` once that package lands (plan Finding F1; see below).

- Task/Submission validation and translation, posting-command preparation, the posting-intent WAL,
  chain observation ports, and the requester-facing `TaskExecutionBackend` implementation.
- `MarketplaceRequesterBackend.post(taskBytes, submissionBytes)` returns the exact durable
  `PostingOutcome`; `submit` is the unchanged generic two-argument backend seam.
- `MarketplaceRequesterBackend.recoverPosting()` atomically joins an exact resolved posting WAL
  row back to its requester/idempotency scope. Requester scope is logical idempotency authority;
  the WAL remains the sole transaction authority.

The backend accepts exact Task and Submission bytes plus configured binding mechanics. It does not
own pricing, approval, campaign, scheduling, key-loading, public discovery, delivery adoption, or
requester settlement policy. Those remain product responsibilities.

### Phase C requester recovery invariant

The requester scope binds requester, idempotency key, exact Task and Submission digests, creator,
venue namespace, posting-intent key, and the canonical posting-command digest. The posting command
also freezes chain, router, Safe, all commercial terms, calldata, and value. Reusing a logical
scope or WAL identity with different exact bytes is a conflict.

A pending scope completes automatically only from the matching **resolved WAL row**, read and
copied in the same venue-state transaction. A `TaskCreated` event anchors creator and Task but not
Submission, so chain-only matches are diagnostic evidence and remain broadcast-uncertain—even a
singleton match. The backend never rebroadcasts that uncertainty automatically. Legacy pending
scope rows without the Phase C join fields are marked `legacy-scope-unrecoverable` and require
explicit operator reconciliation.

## The two-party engagement entry (Finding F1)

`TwoPartyEngagement` names the surface the marketplace pipeline will pass to
`@jinn-network/task-execution-backend-local`'s assembly `submit` as an optional third parameter:
`submit(taskBytes, submissionBytes, engagement?: TwoPartyEngagement): Promise<SubmissionAck>`.
This widens the already-implemented, frozen `TaskExecutionBackend.submit(taskBytes,
submissionBytes)` (`packages/task-execution/backend/src/backend.ts:37`, Phase 2, merged) with an
optional parameter — additive, not a breaking change to the frozen 2-arg call sites. This plan
does **not** edit `backend/src/backend.ts`; the widening is dispositioned as a dated addendum on
the local-execution-backend plan and built into that package's assembly from day one (see plan
Finding F1 for the full reasoning: a Submission-document-field realization is impossible because
the deterministic URI depends on `attemptIndex`, known only at claim time; a separate `engage()`
method is disallowed by ruling §7.18).

## The requester on-ramp adapters (D7, Finding F2)

`postTask` has always taken its ports as parameters; until now the only implementations that
existed were the in-memory intent store and a broadcast port assembled inside the Anvil-fork
conformance harness. These four adapters close that gap, landed here rather than in a consuming
application because the requester on-ramp is binding-tree work (verified-environment supply design
§8 D7, finding F2):

- `createEoaBroadcastPort(publicClient, walletClient)` — the production `SafeBroadcastPort`: one
  direct EOA transaction plus the `TaskCreated` receipt decode, serialized per port so one EOA
  nonce sequence is not raced. Today-mode `createTask` is a plain `payable` function keyed on
  `msg.sender`, so it is not Safe-gated. **Safe-routing arrives with the work client** — the
  marketplace consumption-boundary design owns posting mechanics, and this adapter is the piece a
  requester backend composition supplies.
- `createFilePostingIntentStore(dir)` — the durable WAL: the claim writes the whole record to a
  sibling temp, fsyncs it, and `link`s it into place, so the record name is created atomically
  **and never exists half-written**; resolution is temp-file plus `rename`; owner tokens are
  persisted so a restarted process resumes the same ownership. Same
  claim/fence/resolve/lookup/scanPending semantics as the in-memory store; one suite
  (`posting-intent-store-conformance.test.ts`) runs against both, including a concurrent-claim
  case that pins "exactly one owner". A file this store did not write is never taken over: `claim`
  refuses it, and `scanPending` quarantines it (reported through `onMalformedRecord`) so one
  poisoned file cannot deny recovery to every other pending intent. Crash-orphaned
  `<record>.json.<uuid>.tmp` siblings are inert — the scan ignores them and they may be deleted.
- `scanForOnChainMatch(publicClient, config)` — the chain half of `recoverPostingIntents`: a
  windowed `TaskCreated` scan keyed on the indexed creator plus the `taskCidDigest`, bounded below
  by the intent's claim time (finding F-C5-7 below).
- `DEFAULT_POSTING_TERMS` + `postingEscrowValueWei` + `assertMaxClaimsAgreement` — the escrow
  formula in one place, with `maxClaims` named explicitly. `postTask` takes its multiplier from
  the sealed Submission's `attempts.maxTotal`, falling back to 1; `assertMaxClaimsAgreement`
  throws on an absent `maxTotal` so a posting application cannot reach that fallback by accident.
  Nothing inside `postTask` calls it — `postingEscrowValueWei(terms)` is the `msg.value` `postTask`
  sends only while the Submission and the terms agree, and both sides of that are pinned in
  `posting-defaults.test.ts`. `maxClaims: 1` is deliberate: the reference post admits a single
  solver, which is the cheapest first post; a requester who wants competing attempts raises it and
  seals the same number into the Submission. `responseTimeoutSeconds: 300n` is the deployed
  ceiling, read from the Base Sepolia MechMarketplace
  (`0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7`: `minResponseTimeout() = 60`,
  `maxResponseTimeout() = 300`) — `createTask` does not validate it, the marketplace does at claim
  time, so an out-of-bounds value posts fine and then makes every claim revert with the escrow
  locked.

## Finding F-C5-7 — TaskCreated cannot prove a requester submission

Filed at implementation time per supply program §5 contract 1 (a design defect found while
building is filed, never absorbed silently). The plan's Task A4 and design §8 D7 specify the log
scan keyed on `taskCidDigest + creator`, but the WAL key has three legs
(`creatorSafe, taskCidDigest, submissionDigest`) and `TaskCreated` carries no submission digest.
So the same requester re-posting the same Task under a second Submission — the ordinary re-post
after `maxClaims` is exhausted — produces two intents the scan cannot tell apart. If the second
broadcast crashed, the scan found exactly **one** match (the first, already-adopted post), adopted
it with no ambiguity report, and told the poster its second post had landed under a taskId
belonging to a different Submission. The second post never happened.

**Phase C disposition:** the bounded scan is retained for diagnostics, but no chain-only match is
adopted as a WAL outcome. Exact automatic completion requires an already-resolved WAL (or a future
local transaction proof bound to the exact command digest and canonical receipt). Closing the
wallet-accepted-but-unrecorded window requires a future on-chain Submission/operation anchor or a
persisted exact signed outer transaction identity; the current contract cannot prove it.

## A note on the package.json dependency graph

This package's own production dependencies are exactly the five it needs for M0-M1 source:
`task-execution-{protocol,backend,profiles}` and `trust-{core,resolve}`. It deliberately does
**not** declare `@jinn-network/marketplace-testing` as a devDependency (a deviation from the
plan's M0.1 Step 1 literal preview): declaring it creates a two-way portal cycle
(`binding` devDep→`testing` prod-dep→`binding`), which empirically breaks Yarn's `node-modules`
linker for standalone portal projects (it refuses to write into a portal target's `node_modules`
outside the current project root). The rest of the already-built stack follows a one-directional
pattern instead — `task-execution-backend`/`task-execution-profiles`/`trust-resolve` do not
devDep their sibling testing/kit packages either; only the testing/kit package depends on the
components it exercises. `marketplace-testing`'s own conformance suite is what runs "the relevant
conformance kit" against this package, invoked as its own `yarn test`, not via an import from
here.
