# Jinn Marketplace Binding v1

**Date:** 2026-07-28

**Status:** design approved section-by-section in session; architecture and adversarial reviews
run 2026-07-28 (nine blocking findings across both, deduped to seven; all resolved in this
revision); written review pending

**Shape:** `design`

**Scope:** the chain-venue binding of the TEP backend contract — mapping sealed Task /
Submission / Delivery documents onto the deployed OLAS-native Base substrate (TaskCoordinator +
JinnRouterV3 + OLAS Mech Marketplace); a specified contract revision carried as declared
impact; projector #1 (chain events → protocol observations + signed discovery announcements);
operator claim sovereignty replacing SolverNet membership; the daemon TaskEngine venue/execution
carve; cancellation and lifecycle exits

**Out of scope:** contract implementation (a later contracts session builds the specified
revision); settlement economics, challenge mechanism, and evaluator incentives (Phase B.2);
reputation scoring policy; benchmarking (next design session); the sovereign-chain substrate
(superseded by DR-2026-06-30); operator-app UI detail (spec impact declared)

Companion designs: the five stack designs of 2026-07-27 (TEP, profiles, trust, discovery,
local execution backend) on `integration/evidence-v1`; the Evidence Protocol (2026-07-23);
`2026-07-24-marketplace-external-consumer-boundary-design.md` and
`2026-07-24-task-post-broadcast-intent-design.md` (both honored as-is, never rewritten).

**One companion amendment is declared** (not "no change"): the local-execution-backend / TEP
backend interface gains a **two-party engagement entry** that accepts a caller-minted
deterministic Attempt URI and a caller-built dispatch-context, for bindings where the Attempt
identity is fixed by an external correlation tuple. TEP §9.2 already contemplates deterministic
UUIDv5 for two-party bindings; the local backend's single-party path mints a random `urn:uuid`,
so embedding it inside this two-party binding requires the entry (§6.2, §6.3). This is a small,
additive interface amendment carried as declared impact on those two designs.

## 1. Problem statement

TEP defines sealed documents and a backend contract; the local backend binds them to one
machine. The marketplace binding is the second production binding: it makes the OLAS-native
Base substrate a venue where mutually-distrusting operators claim and fulfill work,
coordinated by the chain and settled in OLAS. The current marketplace path exists and runs on
testnet, but it predates the stack:

- **Inconsistent hash domains.** The chain anchors the sealed task by the sha256 inside its
  raw-codec CID (correct), but anchors solutions and verdicts by a keccak256 of the JCS
  envelope body, while the Mech `Deliver` event separately carries the envelope's sha256 CID
  digest — two digests for one artifact on two contracts, equal only by client convention.
- **No Submission, no signature.** The chain records no Submission-level document; terms are
  loose call parameters, and the requester is implicit as the posting Safe. The marketplace
  profile's signed-Submission requirement and the trust layer's §7.5b requester
  authentication have no chain-anchored counterpart.
- **Claims without honesty.** The tokenless trim deleted all on-chain windows and leases. A
  claim today never expires: claim-and-abandon permanently burns the attempt slot *and* its
  escrowed fee (spent into the Mech request at claim time). The `Closed`/`Cancelled` statuses
  exist in the enum and are never assigned; there is no way to close a task, release an
  attempt, or cancel anything — only silent, slotless waiting.
- **SolverNet coupling everywhere.** Claim eligibility, concurrency slots, spend caps,
  AI-unit budgets, and readiness gates all key on SolverNet manifest CIDs, which the profiles
  design dissolved.
- **Trusted-indexer discovery.** Finding work means trusting the Ponder indexer's database;
  the discovery protocol requires the marketplace's facts to become signed, spot-checkable
  announcements.

## 2. Decision and rationale

The binding does **two jobs** (per session decision): a faithful TEP binding over the
**deployed contracts unchanged** — so nothing blocks — plus a **specified contract revision**
carried as declared impact and implemented in a later contracts session. The revision closes
exactly what the sealed-document model and honest claiming require: an anchored Submission
commitment, sha256 hash-domain convergence, and attempts with honest expiry.

**Compose over build** (per the standards audit, §3): the consensus-critical spine remains a
**thin recorder** — one event per lifecycle fact, sha256 digests in indexed topics, storage
only for uniqueness, sequencing, self-evaluation prevention, and escrow linkage (DR-2026-06-30's
"recorder, not computer"). Rejected alternatives:

- **EAS as the anchor layer**: its keccak-of-EIP-712 identity would fork the stack's
  sha256-over-exact-bytes scheme; it cannot express first-wins, per-task uniqueness, or
  escrow linkage; production protocols with marketplace semantics uniformly ship thin custom
  contracts and use EAS only for claims-shaped statements. EAS survives only as optional
  off-path composition (`multiTimestamp` batch anchoring; verdict-summary attestations) —
  neither needed at v1.
- **ERC-8004 as verdict-of-record**: agent-centric, single-designated-validator,
  keccak-hashed, Draft-mutable. It composes **one-way**: identity registry as the discovery
  pointer (settled in the trust layer), plus an optional later *export* of verdicts as
  Validation Registry responses for portable operator reputation. Never imported into
  settlement.
- **Replacing the escrow machinery**: the OLAS Mech BalanceTracker is already the modern
  deposit-ledger + pull-withdrawal pattern (OpenZeppelin removed its escrow primitives in
  v5); the substrate's payment rails stay.
- **The claim-model swap** (assignment + open race): rejected in discussion. Open racing
  duplicates compute-expensive work; the production pattern's real content — time-boxed
  exclusivity with consequences for abandonment — is delivered by **attempts with honest
  expiry** (§5.2), which also maps directly onto TEP's `attempts` Submission parameters and
  creator-controlled redundancy.

**On "payment rails stay" — the precise claim.** The OLAS Mech BalanceTracker deposit-ledger +
pull-withdrawal *pattern* stays; what changes in the revision is the *timing and role* of the
Mech `request()`. Today `claimTask` funds a Mech request at claim (`JinnRouterV3.claimTask`
routes `deliveryRate` into `request{value:…}`), which is exactly why an abandoned claim burns
the fee — the money has already left the router. The revision holds the reservation in the
**JinnRouter escrow** and makes the **on-chain claim-with-deadline the exclusivity mechanism**
(not a funded Mech request); the Mech payment leg is funded at the delivery step (or, if the
contracts session keeps the request funded at claim, it is made refundable to the router on
`responseTimeout`). Either realization satisfies the frozen economic invariant — *no valid
delivery, net no spend* (§5.2) — without abandoning the Mech deposit/pull rails. The invariant
is frozen as economics; the exact Mech interaction is a contract-implementation choice bounded
by it (§5.2).

## 3. Standards and substrate audit

| Source | What is taken |
| --- | --- |
| EAS (OP-stack predeploy) | `refUID`-style explicit parent linkage; revocation-as-record; digest-in-indexed-topic event shape; delegated EIP-712 posting pattern for relayed flows. Not in the core path |
| ERC-8004 | Identity pointer (trust layer, settled); emit-don't-store URI discipline; submitter ≠ owner/operator feedback enforcement; optional one-way verdict export |
| OLAS Mech Marketplace | The substrate itself: request/deliver with atomic skip-if-delivered; `priorityMech` + `responseTimeout` exclusivity; BalanceTracker pull payments; Karma as an available consequence channel |
| Chainlink request model | Commitment-hash storage deleted on fulfill — minimal state, replay-proof first-valid-write |
| UMA OOv3 | The assert/dispute/settle shape reserved for the Phase B.2 challenge mechanism — noted, not built |
| CIDv1 raw-codec convention | One `bytes32` on-chain, fixed-prefix reconstruction; raw codec so CID digest **equals** sha256 of exact bytes (Autonolas's own dag-pb hashing is the cautionary counterexample) |
| Event-emission consensus | One event per fact; join keys in indexed topics; never require call-trace decoding or archive `eth_call` for indexing |
| OP-stack finality | Real `safe`/`finalized` block tags instead of fixed confirmation counts |
| Production indexer reorg handling | Rewind-internal (Ponder/graph-node) made *explicit*: append-only signed corrections per the discovery design |
| x402 | Out of scope at the binding layer (synchronous pay-per-request; no escrow, no verification-contingent release). Legitimate only at resource-serving edges, later |

Deployed substrate facts the design binds to (Base Sepolia): TaskCoordinator
`0x8a34…AD98` + JinnRouterV3 `0x6f47…A247` (proxy pair), MechMarketplace `0xD323…c0e7`,
activity checker `0x0e1B…0f70`; two-rail escrow `msg.value == (solutionRate + verdictRate) ×
maxClaims`; first-verdict finalization; self-evaluation prevention on-chain; all state-changing
calls Safe-routed with the client's nonce-ledger and inner-revert classification.

## 4. Design tenets

1. **The chain proves; documents mean.** On-chain: fingerprints, sequence, escrow,
   uniqueness, self-eval enforcement, activity credit. Off-chain: sealed documents and
   signatures, end-to-end verifiable. The chain never stores documents and never computes
   judgments.
2. **One fingerprint scheme at the protocol boundary**: sha256 over exact sealed bytes,
   everywhere the protocol looks. Chain-internal keccak survives only inside the binding
   (today-mode) and dies with the revision.
3. **Attempts are exclusive and honest.** Exclusivity prevents duplicated compute; expiry,
   release, and consequences prevent squatting; the creator buys exactly as much redundancy
   as they fund. No open racing, ever.
4. **Operator sovereignty.** The protocol prescribes no membership and no filter schema.
   Claim policy is the operator's own predicate over discovery facts; the only structural
   gates are backend capability ("can I run this") and the operator's own spend caps.
5. **Settlement is binding-internal.** Delivered ≠ settled ≠ adopted; race-lost maps to what
   actually happened to the attempt; TEP's frozen vocabularies are untouched.
6. **Both contract generations, one seam.** The binding runs on today's contracts and on the
   revision through a single generation seam; flipping is configuration, not rewrite.
7. **Honor what is pinned.** The external-consumer CLI boundary and broadcast-intent
   crash-safety designs are honored as-is.

## 5. The contract revision (specified now, built later)

### 5.1 The revised anchor set

| Record | Today | Revised |
| --- | --- | --- |
| Task | sha256 of sealed task bytes (via raw CID digest) | unchanged |
| Submission | none — inline params; requester = posting Safe | sha256 of the sealed, DSSE-signed Submission bytes, anchored in the posting transaction beside the task digest |
| Attempt | claim event (operator, slot) — no deadline | claim event + **claim deadline**; release and expiry events |
| Delivery | keccak of JCS envelope body (router) + sha256 CID digest (mech event) | sha256 of the sealed Delivery bytes — one digest, one scheme |
| Verdict | keccak evidence hash + `verdictCode` | sha256 of the sealed evaluation Delivery bytes + `verdictCode` |

Supporting rules: **event completeness** — every posting-policy parameter is emitted (closing
the current call-trace-only gap where claim windows and policy fields are invisible to any
projector); one event per fact, digests and parties in indexed topics; the SolverNet
`manifestDigest` discriminator is dropped (nothing replaces it — eligibility was never
chain-enforced); `Closed`/`Cancelled` statuses become reachable (§5.3).

### 5.2 Attempts with honest expiry

- `claim(taskId)` grants **exclusive ownership of one attempt with a deadline** (from the
  task's posted policy). No racing; parallelism only where the creator funds parallel
  capacity (`maxClaims`, mapping TEP `attempts.maxTotal`).
- **Two distinct counters, and the URI depends only on the first.** `attemptIndex` is a
  **strictly monotonic, never-reused per-task engagement counter** — it is the sole variable
  input to the deterministic Attempt URI (§6.2), so it MUST NOT be decremented or recycled by
  release or expiry. A **separate live-occupancy counter** tracks how many attempts are
  currently held and is what the `maxClaims` gate reads; release and expiry decrement
  *occupancy*, never `attemptIndex`. "Slot returned to the pool" means occupancy freed, never
  index reused. (Today's contract conflates the two into `claimCount`; the revision splits
  them — a claim→expire→reclaim sequence yields two distinct `attemptIndex` values and two
  distinct Attempt URIs, so two executions never collide on one identity.)
- **Reservation, not claim-time spend.** The fee for an attempt is *reserved* in the router
  escrow at claim and *released* only on valid delivery; an expired or released attempt
  returns occupancy and reservation to the pool. The frozen invariant is economic — *no valid
  delivery, net no spend*; the Mech interaction that realizes it (reservation held in-router,
  Mech funded at delivery, or Mech-funded-at-claim-refundable-on-timeout) is a
  contract-implementation choice bounded by the invariant (§2).
- **Expiry is lazily reaped**: the next claim (or any state-changing touch) clears expired
  attempts as a side effect, emitting `AttemptExpired(taskId, attemptIndex, operator)`. No
  janitor process. The projector may announce expiry from deadline passage without waiting for
  the reap. **Any refund path (including `closeTask`) MUST reap past-deadline attempts before
  computing its refund**, so a creator can always recover funds for provably-expired work even
  if no further claim ever arrives (§5.3, closes the lazy-reap fund-lock).
- **Abandonment is visible and attributable**: expiry and release events name the operator.
  The **consequence channel is deferred policy** (session decision): mech Karma decrement,
  ERC-8004 negative feedback, or staking-activity shortfall can each consume the on-chain
  fact later without contract changes. To keep the honesty signal from being gamed by
  claim→release cycling (N1), release carries a **minimum-hold or same-identity re-claim
  cooldown** — rapid cycling by one identity is bounded so it cannot silently starve a
  scarce-capacity task under the "release is the honest exit" framing. An optional
  per-operator simultaneous-claim cap is a revision parameter, default off.
- **Creator top-up**: `addAttempts(taskId, n)` — **creator-only, reverts on `Closed`** — funds
  additional capacity on an open task; creator-steered retry as a first-class move.
- **First valid delivery wins, atomically** — unchanged.

### 5.3 Lifecycle exits (cancellation)

- **`closeTask(taskId)`** — creator-only: status → `Closed`, stops new claims, **reaps
  past-deadline attempts, then refunds all unreserved budget** in the same transaction, emits
  the event discovery needs to withdraw the announcement. Two invariants make it airtight
  against a creator rug: **(i)** a delivery-claim for a live reserved attempt MUST succeed
  regardless of `Closed` status — `Closed` stops *new claims* only, never settlement of work
  already commissioned; **(ii)** `closeTask` MUST NOT refund or free a live reservation, only
  unreserved budget and reaped-expired reservations. So a creator cannot front-run a pending
  delivery with `closeTask` to take the work for free (adv B3). Realizes TEP's
  `submission-closed` (reason: requester close) and the Submission's `closeAt` (the binding
  schedules the call).
- **`releaseAttempt(taskId, attemptIndex)`** — operator-only: early return before deadline;
  reservation returns to pool; event names the operator with `released` (cheaper in standing
  than silent expiry — prompt give-back is the honest exit for post-claim rejection), subject
  to the cooldown of §5.2.
- **Cancel of an in-flight attempt is a request, never a revocation.** The requester signals
  through the protocol's cancel flow; a compliant operator releases. There is **no
  unilateral on-chain revocation**: the exclusive window is a commitment the creator sold —
  delivery within it settles, and a creator who no longer wants the result may decline to
  *use* it but still pays for the attempt they commissioned (TEP §12.1's stance, enforced
  economically).
- **Self-claim on solve work is allowed** (session decision): a same-address block is
  sybil-defeated security theater that blocks honest flows (org posts + org fleet solves;
  solo dogfooding). Farming defense is economic (fees, shipped reward decay, evaluation
  gating) and named as a residual for B.2. **Evaluator ≠ solver is retained on-chain as a
  cheap first filter, but it is NOT the load-bearing control** — the deployed check is
  address-only, which the trust layer establishes is worthless against a two-address single
  party. The load-bearing control is the trust layer's **§7.5a settlement join** (verdict key
  and settling Safe resolve to the same Agent IRI) and its declared-identity distinctness
  check, run before a verdict is treated as decision-grade (§6.4). The on-chain address check
  is described here honestly as its cheapest enforcement point, not as the security boundary —
  so the contracts session does not mistake it for one.

### 5.4 Generation seam

The binding exposes one configuration seam selecting the contract generation. Today-mode and
revised-mode are both fully specified (§6 marks every divergence); the seam is frozen so the
flip is config, not rewrite. Testnet redeploys are cheap and practiced (Track 2 precedent).

## 6. Document translation

### 6.1 Posting

The requester seals Task and Submission; the binding uploads both as raw-codec CIDs (address
= sha256 of exact bytes) and posts one transaction with anchors + escrow, honoring the
broadcast-intent protocol (intent persisted before broadcast; recovery scan after; at-most-once).

Submission field mapping: `attempts.maxTotal` → funded capacity (`maxClaims`);
`attempts.maxConcurrent` → on-chain concurrency parameter (revised); `deadline` → task
claim/delivery windows (revised: on-chain; today: document-honored, expiry surfaced by the
projector from the document); `closeAt` → scheduled `closeTask` (today: approximated by budget
refund + announcement withdrawal — honestly weaker, named); `evaluationRequirements` → the
verdict rail. **Honor-or-reject applies at the binding, symmetrically** (TEP §8 forbids silent
degradation): today-mode finalization is first-verdict, so `minVerdicts > 1` rejects with
`unsupported-requirement`; and today's chain enforces only `maxClaims` (= `maxTotal`), so a
`maxConcurrent` stricter than `maxTotal` **also rejects with `unsupported-requirement`** in
today-mode rather than being merely client-honored — `capabilities()` declares
`maxConcurrent == maxTotal` as the today-mode bound, and the revision adds the on-chain
concurrency parameter and multi-verdict finalization.

Today-mode divergence: only the task digest is anchored; the sealed Submission's existence and
terms are carried by the **signed announcement** (projector) and verified off-chain (§7.5b
requester authentication against the document's DSSE signature). A decision-grade consumer MUST
enforce the join `Submission.referencedTaskDigest == on-chain TaskCreated.taskCidDigest ==
sha256(fetched task bytes)` before trusting the announced facts card, so a malicious announcer
cannot pair a genuine signed Submission with a different on-chain task. Revised-mode anchors
the Submission digest and the announcement becomes corroboration. The broadcast-intent recovery
scan is honored, re-keyed by SolverNet dissolution onto (creator Safe, Task CID digest, +
Submission digest in revised mode) in place of the retired manifest-digest leg — the at-most-
once property is preserved and strengthened.

### 6.2 Claiming

A chain claim becomes a protocol Attempt via TEP §9.2's deterministic identity: the Attempt
URI is the UUIDv5 over `(chainId, coordinator address, taskId, attemptIndex)` — computable by
requester, operator, and any third party from public facts, and (per §5.2) never colliding
across a released/re-claimed slot because `attemptIndex` never recycles. This is a **two-party
binding**: the Attempt identity is fixed by the chain tuple, not minted by the executor. So the
binding mints the deterministic Attempt URI and builds the dispatch-context itself, then engages
its **embedded local backend through the two-party engagement entry** (the declared companion
amendment in the header) — passing the sealed Task bytes, the caller-minted Attempt URI, and the
dispatch-context. The backend provisions, executes, and harvests under *that* identity rather
than minting its own random one. The claim event projects to `attempt-engaged` (pinning the
binding as authoritative observation source, carrying the dispatch-context descriptor); from
engagement to the harvested outputs, execution is the local backend design's story — the binding
re-enters at sealing (§6.3).

Pre-claim, the pipeline asks its own backend before spending anything: capability match plus
`preflight` probe (declared requirements vs declared capabilities vs live readiness — the
Q&A of the session made normative). Post-claim rejection (provisioning failure →
never-executed `rejected`) is handled by prompt `releaseAttempt`.

### 6.3 Delivery: convergence, not wrapping

**The marketplace envelope becomes the TEP Delivery under the marketplace deployment
profile** — one document, not a wrapper. The embedded backend, engaged under the marketplace
profile and the caller-minted Attempt URI (§6.2), seals the Delivery carrying the
profile-required fields (executor identity and signature, participant identities, evidence
records and execution IDs, trajectory references — today's `jinn.execution.v1` content re-homed
as profile fields) — and because it was engaged with the *deterministic* Attempt URI, the
sealed Delivery names the marketplace Attempt without the binding re-sealing anything. The
binding uploads the exact sealed bytes; sha256 is the identity everywhere the protocol looks.

Today-mode divergence: the deployed router requires the keccak evidence hash at
delivery-claim; the binding computes it **binding-internally** from the same sealed bytes and
submits it, while the announcement asserts the correspondence `(sha256 CID digest ↔ keccak
evidence hash)` with both values. Both digests are independently on-chain (the Mech `Deliver`
event carries the sha256 CID digest; the router carries the keccak), joined by `requestId`, so
the correspondence is verifiable — and it is a **mandatory decision-grade check**, not an
optional spot-check: a settlement-grade consumer MUST fetch the bytes, recompute both digests,
and confirm they match the asserted values and the on-chain keccak. If a (non-honest-binding)
operator submits mismatched digests, the projector MUST refuse to emit `delivery-recorded`
(emit a typed divergence, never silently pick one digest, N4). The correspondence dies with the
revision. The zero-evidence-hash guard survives verbatim. `jinn.execution.v1`'s migration to
the Delivery profile is declared impact.

Delivered ≠ settled: settlement (delivery claim, fee release, activity credit) is
binding-internal; a lost race maps to what actually happened (typically `rejected` at claim
or delivered-but-unsettled), never to failure — preserving today's race-lost discipline in
TEP vocabulary.

### 6.4 The evaluation leg

Per the profiles design (§9.1, §10.1): evaluation opportunities surface as delivery
announcements; the evaluation task is **derived mechanically** from the settlement slot's
`(Task, Delivery)` pair by the full-document template — byte-checkable by anyone. **Who seals
the evaluation Submission is the requester-side binding, not the evaluator** (profiles §9.1
"Sealer"): the default production case marks test material *private* (profiles §7.1, §8), and
only the subject requester holds authority over the `capabilityGrants` that convey the private
grader and test material — a self-sealing evaluator cannot dispatch that case at all. So the
requester-side binding derives and seals the evaluation Submission, carrying the admission
receipt and the `capabilityGrants`; the evaluator claims and executes it through their own
embedded backend, and every checker verifies the derivation is byte-exact. (The
evaluator-derives-and-seals shortcut is reserved for the fully-public-spec deployments profiles
§9.1 explicitly carves out.) The verdict **is** the evaluator-signed Result Evaluation
Statement in their Delivery.

**Where the checks bind, stated precisely** (adv B4): the verdict code lands on-chain via the
*evaluator's own* delivery-claim transaction — the binding/projector does not gate that write,
and today's contract finalizes on the first verdict of any code, crediting the solver's
activity before any check runs. So the named checks — derivation byte-equality,
admission-receipt validity, `verdict-consistency` (declared rule → code), evaluator ≠ solver,
and the trust layer's **§7.5a settlement join** (verdict DSSE key and settling Safe resolve to
the same Agent IRI at the envelope's effective time, no partial credit; the envelope's
effective time is cross-checked against the verdict-claim block time) — gate the **off-chain
verdict observation and announcement**, i.e. whether a verdict is treated as *decision-grade*
by any consumer. They are **not** on-chain settlement protection in today-mode: today-mode
on-chain finalization and activity credit are therefore **advisory-only** until the revision
makes the on-chain code derive from and be checked against the signed Statement. Verdict-code
mapping is envelope-authoritative: the Statement's verdict maps to
`{Pass, Fail, Invalid, Unresolved}` with no defaulting (the binding refuses a missing verdict
rather than guessing). In today-mode the projector publishes a signed **verdict-code ↔
Statement-verdict correspondence assertion** (both values) exactly as for the delivery
digests, and refuses to treat a verdict as decision-grade if they disagree (containing the
known on-chain default-Pass quirk); the revision makes the on-chain code and the Statement
authoritative-equal.

## 7. Operator sovereignty

**At the protocol level there is no membership, no filter concept, and nothing prescribed.**
The chain accepts any operator on any task (it always did); discovery supplies facts as a
menu, not a rule. The claim decision is a **pluggable operator predicate** over (discovery
facts, own backend capabilities, own caps) — hand-picked IDs, take-everything-runnable,
price thresholds, requester allowlists, or per-task model judgment are all equally valid and
protocol-invisible.

What remains is not eligibility:

1. **Execution wiring** — an unattended daemon needs work-kind → (harness, model, plugins,
   credential) mapping to act. This is configuration for execution, not permission for
   claiming; the daemon ships a default config shape as convenience, explicitly non-protocol.
2. **Two structural guards** — backend capability + preflight ("can I actually run this",
   asked of the embedded backend through its standard interface), and the operator's own
   spend/AI-unit caps (self-protection, re-keyed from manifest CID to the wiring entry's
   credential).

**Run pinning under the marketplace's `attested` posture** (profiles §5.2): where a Submission
pins harness / model / loadout / effort-floor, the marketplace binding is assigned the
`attested` posture — pinning is conveyed to claimants as a claim-eligibility constraint (the
operator's predicate reads it from the discovery facts and declines work it won't run to the
pin), and honored pinning is verified *after the fact* against the Evidence Runtime Observation;
a cell whose observed run violates its pin is invalid **consumer-side**, never a protocol state.
The binding's `capabilities()` carries the `runPinning` block the profiles design requires. This
is the ordinary-Submission path for `effort`-as-floor and model constraints; the benchmarking
application (next session) builds its cell matrix on top of it.

Everything else dissolves: the joinedSolverNets filter, launch/join lifecycle, the launched-
record generator gating (generators become ordinary requester applications that post under
their own identity and stop posting to pause), the manifest-keyed readiness registry
(re-founded on backend capabilities + probes), and the manifest-keyed single-flight
concurrency (re-scoped to the wiring entry). "Community" is emergent: a requester may publish
a suggested configuration beside their profile; adoption is voluntary; nothing enforces a
boundary. The claim-nothing-when-unconfigured safety default survives. The synthetic-
provenance self-claim gate is re-declared as an operational detail of the health-check
feature, not a claiming rule.

Migration honesty: until the daemon migration completes, claim predicates compile down to
today's manifest-digest matching via a legacy annotation per wiring entry; the config maps
one entry to one entry.

## 8. Projector #1

**One projection machine, two deterministic outputs** — TEP lifecycle observations and
discovery's signed announcements — from the same chain events, so the two views cannot
disagree. Hosted first by the Ponder indexer, which becomes "replaceable implementation"
rather than "trusted interface"; the explorer consumes the query layer above; anyone can run
a rival projector.

| Chain event | Observations | Announcements |
| --- | --- | --- |
| Task posted | `submission-accepted` | `available` Submission item: facts card (task digest, profile URI, requester IRI, deadline as record facts; price, window as substrate facts) |
| Claim | `attempt-engaged` (deterministic Attempt URI) | — (edges, not counters; claimability liveness is query-plane) |
| Mech delivery + delivery-claim | `delivery-recorded` (only if the sha256↔keccak correspondence holds, §6.3) | `available` Delivery item (task digest, Attempt URI, outcome) — the evaluator feed |
| Verdict-claim / finalization | `attempt-terminal` (mapped per §6.4) | `available` evaluation Delivery item |
| Capacity exhausted / first-verdict finalized (both generations) | terminal / `submission` availability ends | `withdrawn` (reason `delisted`) |
| Close / refund / expiry / release (close+release revised; exhaustion+finalization today too) | `submission-closed`, terminal observations | `withdrawn` (reason `delisted`) |
| Reorg past an announced fact | corrective terminal per TEP fold rules | append-only signed retraction, reason `reorged` |

Rules: every item carries a **derivation annotation** `{chainId, contract, event, blockNumber,
blockHash, txHash, logIndex, finalityTier, contractGeneration}` — the discovery §6.2 EVM shape
plus `blockHash` (reorg detection), `finalityTier`, and `contractGeneration` (so mode-dependent
honor-or-reject, anchoring, and verdict authority are legible to consumers, N4); `event` is
retained so `derivation-consistency` can target the exact log. `blockHash` and `finalityTier`
are proposed as standard additions to the discovery annotation. **Finality policy is declared,
not inherited**: announce from `safe` blocks by default (a two-lane unsafe-provisional mode is
an optional profile); decision-grade consumers wait for `finalized` per the discovery design's
rules, and **the pipeline SHOULD gate expensive execution on the claim reaching `finalized`**
(spending compute is decision-grade; on a `safe`→reorg the claim reverts and the work is
unpaid — operator-borne loss unless finalized-gated, N2); corrections are append-only signed
records, never rewrites. Today-mode gap named honestly: posting-policy parameters not emitted by
the deployed contracts ride in the Submission document the announcement references (subject to
the digest-join a consumer MUST enforce, §6.1), becoming chain-corroborated only after the
revision. The `envelope:`/`capture:`/`checkpoint:` MetadataSet ingestion continues for evidence
and corpus records; the `solvernet-manifest:` prefix retires with dissolution.

**Projector-censorship recourse, honestly** (N3): "anyone can run a rival projector" is the
structural recourse, but the deployed default (`discovery.fallbackToOnchain` off since the
2026-05-23 incident) means a consumer following only the indexer-hosted projector has no live
fallback if it censors a requester's tasks. So the binding requires a consumer following a
single projector to periodically cross-check the announced open-Submission set against the
on-chain `TaskCreated` count (a cheap `finalized`-only floor, distinct from full self-indexing)
— censorship becomes detectable without storming shared RPC.

## 9. The daemon carve

Disposition of today's TaskEngine states (twelve non-terminal/terminal states plus FAILED;
this refines local-backend §11.2's coarse "marketplace pipeline" grouping into pipeline vs
binding):

| State(s) | Goes to |
| --- | --- |
| DISCOVERED, CLAIMED, WAITING | **Pipeline** (claim policy + binding claim leg; window-wait becomes Submission-deadline awareness) |
| PRE_SNAPSHOT, RUNNING, POST_SNAPSHOT | **Embedded local backend** (provision → execute → harvest; the shim/journal/reconciliation honesty arrives with it, closing the mid-run recovery hole) |
| PACKAGING | **Embedded backend seals the marketplace-profile Delivery** (§6.3), under the caller-minted Attempt URI; the binding uploads and anchors |
| DELIVERING, COMPLETE | **Binding** delivery + settlement legs |
| AWAITING_ADOPTION, CLAIMING_DELIVERY | **Application (Autopilot)** — adoption is application acceptance; the binding surfaces delivery + receipt observations |
| RACE_LOST | **Binding** — mapped to TEP outcomes, kept off failure counters |
| FAILED | **Split by cause**: backend-side execution failure → the backend's `failed`/`rejected` terminal (execution states); venue-side failure (claim revert, settlement failure) → binding, mapped to TEP outcomes |

The pipeline is an application composing binding + embedded backend through their public
interfaces only — no subcomponent imports (session Q&A made normative); the one exception is
the two-party engagement entry (§6.2), a public-interface addition, not a subcomponent reach-in. The evaluation
opportunity path re-founds on delivery announcements + mechanical derivation (§6.4),
replacing bespoke log-scan opportunity construction. Pinned designs honored: the CLI-only
external boundary (new consumer surfaces land as SDK schemas + `jinn` CLI commands) and
broadcast-intent posting. Untouched: earning bootstrap, staking loops, reward claiming,
balance top-up, dashboard plumbing below the affected surfaces.

## 10. Security considerations

| Threat | Answer |
| --- | --- |
| Result theft / delivery front-running | Deliveries are executor-signed; settlement requires claimer == attempt operator plus the §7.5a settlement join; anchoring another's signed envelope gains nothing |
| Claim squatting / griefing | Revised: deadlines + lazy reap + attributable expiry events + deferred consequence channel + optional per-operator cap; today: named residual, compensated by operator policy and surfaced by the projector |
| Creator rug on in-flight work | No unilateral revocation; delivery-claim survives `Closed`; `closeTask` never frees a live reservation and reaps-before-refund; so a creator cannot front-run a delivery to take the work free, nor lock funds on an expired-but-unreaped slot (§5.3) |
| Verdict manipulation via on-chain settlement | Today-mode on-chain finalization/credit is advisory-only (§6.4); decision-grade trust requires the off-chain named checks + §7.5a join + verdict-code correspondence; the revision makes the on-chain code derive from the signed Statement |
| Attempt-identity collision | `attemptIndex` never reused across release/expiry; two-party engagement carries the deterministic URI into sealing — one execution, one identity (§5.2, §6.2) |
| Escrow leakage | No-valid-delivery-no-spend invariant (revised); every exit evented; pull payments in the OLAS ledger |
| Requester spoofing | §7.5b over signed Submissions; today-mode carried by signed announcements, revised-mode chain-anchored |
| Verdict manipulation | Derivation byte-equality (pair-fixing removes evaluator input choice), receipt validity, verdict-consistency, evaluator ≠ solver, settlement join; envelope-authoritative code mapping refuses defaults |
| Farming via self-loops | Named residual: address rules are sybil-theater; defense is economic (delivery fees, shipped reward decay, evaluation gating) with full treatment in B.2. Release-cycling starvation bounded by the minimum-hold/cooldown (§5.2) |
| Reorg exploitation | `safe`-tag derivation; block-hash-bearing derivation annotations; append-only signed corrections; decision-grade waits for `finalized` |
| Projector dishonesty | Signed announcements + derivation annotations = provable misbehavior; anyone can run a rival; consumers spot-check per the discovery protocol |
| Key/settlement mismatch | §7.5a join fails closed — no partial credit across rotated or mismatched identities |
| External-consumer abuse | CLI boundary: no key material or tx client in the SDK; Safe/keystore stays CLI-side; verification profiles fail closed |

## 11. Frozen interfaces

1. The two-generation seam and its today/revised divergence points (§5.4, §6.1, §6.3, §6.4).
2. The revised anchor set and one-scheme rule (§5.1); event completeness; emit-don't-store.
3. Attempts semantics: exclusive claim with deadline; **`attemptIndex` strictly monotonic and
   never reused, a separate occupancy counter gating `maxClaims`** (§5.2); reservation escrow
   with the *no-valid-delivery-net-no-spend* economic invariant; lazy reap with
   reap-before-refund; release with cooldown; creator-only top-up reverting on `Closed`;
   first-valid-write (§5.2).
4. Lifecycle exits: `closeTask` (reap-before-refund; delivery survives `Closed`; live
   reservation untouched), `releaseAttempt`, cancel-as-request, no unilateral revocation
   (§5.3).
5. Self-claim allowed on solve work; evaluator ≠ solver retained on-chain as a cheap first
   filter, **not** the load-bearing control — the §7.5a join and declared-identity check are
   (§5.3, §6.4).
6. Deterministic Attempt URIs over `(chainId, coordinator, taskId, attemptIndex)`, with the
   two-party engagement entry carrying the caller-minted URI into the embedded backend so the
   sealed Delivery names it without re-sealing (§6.2, §6.3).
7. Delivery convergence: envelope = TEP Delivery under the marketplace profile, sealed by the
   embedded backend under the deterministic URI; keccak binding-internal in today-mode with the
   **mandatory decision-grade** correspondence check and the projector's refuse-on-mismatch
   rule (§6.3).
8. The evaluation sealer rule (requester-side derives *and seals* with capability grants;
   evaluator-seals only for public specs); the named checks gate the **off-chain
   observation**, not on-chain settlement, with today-mode finalization advisory-only; the
   §7.5a join; envelope-authoritative verdict mapping with refusal-not-defaulting and the
   verdict-code correspondence assertion (§6.4).
9. Operator sovereignty: no prescribed filter schema; pluggable claim predicate; the two
   structural guards; execution wiring as non-protocol config; the `attested` run-pinning
   posture (§7).
10. Projector determinism; derivation annotations with `event`, block hash, finality tier, and
    contract generation; declared `safe`/`finalized` policy with finalized-gated execution;
    append-only corrections; single-projector censorship cross-check (§8).
11. The carve disposition table (incl. FAILED) and pipeline composition rule with the
    two-party-entry exception (§9).
12. Honor-or-reject symmetry: `minVerdicts > 1` and `maxConcurrent > maxTotal` both reject in
    today-mode; `capabilities()` declares the today-mode bounds (§6.1).

## 12. Packages

```text
packages/marketplace/            (working names; settled at implementation planning)
  binding/     document translation, posting (broadcast-intent honored), claim/deliver/
               verdict legs, envelope convergence, generation seam, named-check invocation
  projector/   the one chain-reading machine: observations + signed announcements
  pipeline/    the daemon's marketplace application: claim predicate + execution wiring +
               binding + embedded local backend composition
contracts/     the revision (later contracts session; this design is its requirements)
```

Dependencies: protocol/profiles/discovery/trust/evidence **contracts**; the local backend via
its public TEP interface only; external consumers via SDK schemas + `jinn` CLI only. The
conformance kit slice lives with the stack's testing package.

## 13. Conformance

- **The TEP kit runs against this binding** — the second real binding is what proves the
  backend contract's neutrality. Marketplace-profile checks included: signed documents,
  mandatory evidence, dispatch-binding, executor-signed Deliveries.
- **Projector determinism**: same events → byte-identical observations and announcements;
  reorg-correction fixtures (announce, reorg, retract-and-correct, never rewrite).
- **Escrow lifecycle fixtures** on a local fork, both generations through the seam: post /
  claim / deliver / verdict / close / release / expiry / top-up / refund, including
  no-valid-delivery-net-no-spend, lazy-reap, **reap-before-refund** (all-slots-expired →
  closeTask refunds everything), **closeTask-front-runs-delivery → delivery still settles**,
  and **claim → expire → reclaim yields distinct `attemptIndex` and distinct Attempt URIs**.
- **Attempt-URI two-party agreement**: requester, operator, and a third party independently
  compute the same URI; a reclaimed slot never collides with the abandoned one.
- **Named checks**: §7.5a/§7.5b fixtures reused from the trust kit; derivation byte-equality
  positive and negative; verdict-mapping refusal cases; **on-chain evaluator ≠ solver rejection
  and self-claim-allowed-on-solve**; delivery correspondence and verdict-code correspondence
  checking in today-mode (including the projector refusing to emit on mismatch).
- **Honor-or-reject**: `minVerdicts > 1` and `maxConcurrent > maxTotal` in today-mode →
  `unsupported-requirement`; `closeAt` approximation behavior pinned.

## 14. Declared impact

- **Local backend / TEP interface** (companion amendment, header): the two-party engagement
  entry accepting a caller-minted deterministic Attempt URI + caller-built dispatch-context —
  small, additive, built first (§15 step 1).
- **Contracts**: the §5 revision — a new recorder generation implemented in a later contracts
  session; Base Sepolia redeploy per Track 2 practice. Named requirements for that session:
  split `attemptIndex` from the occupancy counter; reservation escrow with reap-before-refund
  and delivery-survives-`Closed`; `closeTask`/`releaseAttempt`/`addAttempts`; event
  completeness; on-chain concurrency and multi-verdict parameters; the verdict-code deriving
  from the signed Statement.
- **Daemon**: TaskEngine carve per §9; config migration memberships → claim predicate +
  execution wiring; the mech adapter's venue verbs re-home into `binding/`; the stale
  revert-classifier and unreachable-refund drift bugs already spun off as tasks.
- **Indexer**: hosts the projector; GraphQL surface eventually superseded per the discovery
  design; `solvernet-manifest:` ingestion retires.
- **Envelope**: `jinn.execution.v1` migrates to the marketplace Delivery profile (with the
  evidence stream's UTF-16 ordering rule applying wherever sealed bytes are produced).
- **Operator app**: memberships page → claim policy + wiring; new close/release actions;
  spec update per the frontend rules.
- **SolverNet machinery**: registry client, lifecycle publishing, launched-record gating —
  retired on the daemon-migration schedule.
- **CLI**: posting/observe commands extend for Submission documents and lifecycle exits;
  external boundary unchanged.

## 15. Sequence

(1) the local-backend two-party engagement entry (the declared companion amendment, §6.2) →
(2) binding document layer + posting + CLI surfaces (today-mode) → (3) projector +
announcements (indexer-hosted) → (4) pipeline + daemon carve → (5) evaluation leg (**depends on
the trust-layer key-binding + anchor infrastructure** for the §7.5a/§7.5b checks — trust §18
step 5/7; today-mode fallback: the checks run on whatever binding statements exist and are
advisory where they cannot resolve) → (6) contracts-revision session → (7) generation flip.
Nothing gates the stack-implementation session in flight.

## 16. Explicit non-goals

Settlement economics, evaluator incentives, and the challenge mechanism (B.2); reputation
*scoring*; token mechanics of any kind (DR-2026-06-30); the sovereign-chain substrate
(superseded exploration); benchmarking (next session); contract implementation; operator-app
UI design; knowledge pricing.

## 17. Non-blocking follow-ups

- Consequence-channel selection for abandonment (Karma vs ERC-8004 feedback vs staking
  shortfall) — deferred by session decision; the on-chain expiry/release fact supports all three.
- Optional ERC-8004 Validation Registry verdict export; optional EAS `multiTimestamp`
  batch anchoring for non-marketplace statements.
- Per-operator simultaneous-claim cap parameterization; tuning the release minimum-hold/cooldown.
- Two-lane (unsafe-provisional) announcement profile for latency-sensitive consumers.
- Relayed/sponsored posting via the delegated EIP-712 pattern.
- Multi-verdict finalization parameters (with B.2's evaluator economics).
- Operator-app spec update; the two spun-off drift-bug tasks.

**Review disposition (2026-07-28):** architecture + adversarial reviews run against this
spec; nine blocking findings (deduped to seven) resolved in-place — Attempt-URI reuse (§5.2),
the two-party engagement entry for the deterministic URI (§6.2, header amendment), the
escrow/Mech reframing (§2, §5.2), `closeTask` airtightness (§5.3), checks-gate-observation-not-
settlement (§6.4), the evaluation sealer rule (§6.4), and `maxConcurrent` honor-or-reject
(§6.1); eight non-blocking tightenings folded into §5.2, §6.1, §6.3, §7, §8, §9, §13, §15.

## Appendix: sources

External: EAS contracts/docs and OP-stack predeploys; ERC-8004 draft + reference
deployments; valory-xyz mech marketplace contracts; Chainlink basic request model; UMA OOv3;
Boson v2; UniswapX/ERC-7683; IPFS CIDv1-in-EVM practice; OP-stack finality docs; Ponder/
graph-node reorg handling; OZ v5 changelog; x402 foundation materials.

Internal: the six stack designs (2026-07-23 → 2026-07-27); `contracts/src/tasks/
TaskCoordinator.sol`, `contracts/src/staking/JinnRouterV3.sol`, deployment JSONs;
`client/src/adapters/mech/*`, `client/src/harnesses/engine/*` venue surfaces,
`client/src/daemon/*` gates; `packages/indexer/*` (config, schema, handlers);
`docs/superpowers/specs/2026-07-24-marketplace-external-consumer-boundary-design.md`;
`docs/superpowers/specs/2026-07-24-task-post-broadcast-intent-design.md`; the `.local`
sovereign-chain launch spec (superseded context); DR-2026-06-30.
