# Operator-Daemon Composition and Cutover

- **Version:** 0.2
- **Date:** 2026-07-30
- **Status:** Draft — sections approved in-session (Ritsu, 2026-07-30); two fresh reviews
  (architecture + standards/adversarial) resolved in this revision; operator review pending
- **Shape:** `design`
- **Scope:** recompose the production operator daemon onto the implemented stack packages
  (task-execution, evidence, trust, discovery, marketplace) and cut the running system over
  to that composition. In scope beyond the daemon core: the SolverNet retirement schedule,
  the CLI wiring, and the operator-app deltas the cutover forces. Out of scope: the `sdk`
  retirement remainder and the projector/explorer split (marketplace-surfaces session, with
  [#2296](https://github.com/Jinn-Network/mono/issues/2296)); the `core`/`layer`/`plugin`
  disposition (plugin session); any operator-app redesign beyond forced deltas.
- **Depends on:** the seven stack designs and the platform architecture
  ([`2026-07-30-jinn-platform-architecture.md`](./2026-07-30-jinn-platform-architecture.md),
  DR-2026-07-30); the merged stack implementation (PR
  [#2292](https://github.com/Jinn-Network/mono/pull/2292) → `integration/evidence-v1`,
  merge commit `8c7179f2c`).

## 1. Summary

The stack that merged in PR #2292 is a set of engines with empty sockets. Every place an
engine must touch the real world — send a Base transaction, read chain events, serve records
over HTTP — is a port interface, and the only implementations are test fakes. A code-level
walk of the operator loop (§2) confirms it: every stack entry point on the operator path
(`runPipeline`, `makeLocalTaskExecutionBackend`, `openLocalEvidenceRuntime`, the projector,
the evaluation-derive leg) exists, is conformance-tested, and has zero non-test callers.
There is no composition root anywhere in the repository.

This design supplies the three missing trees plus two small modules (§6.3–§6.4), and
nothing else:

1. **The host** — the recomposed daemon, named per the ratified terminology (profiles design
   §3, issue #1979): the tier-4 product is the **operator application**; the daemon proper is
   the **operator runtime**. It assembles the engines from operator configuration, injects
   the plugs, and runs the loops (§4).
2. **The chain plugs** — production implementations of every venue-facing port, as a new
   tier-3 tree `packages/marketplace/venue-base/` (§6.1). Venue-specific, product-agnostic:
   Autopilot's adoption pass and benchmarking's marketplace mode consume the identical plugs.
3. **The discovery plugs** — production transports for the record-discovery serve/client
   pair, as `packages/discovery/transport-http/` (§6.2).

The cutover proceeds flow-by-flow (solver flow, evaluator flow, posting flow), hard-swap per
stage with revert as the rollback, each stage closing a real loop on testnet before the next
begins (§10). The physical tree renames `client/` → `operator/` as the final, mechanical
stage. SolverNet vocabulary retires on the same schedule, surface by surface, each retiring
only when its replacement is live (§9).

Decisions this spec does **not** re-open (settled by the owning designs): the TaskEngine
carve table (marketplace binding §9, drift-guarded as code in
`packages/marketplace/pipeline/src/carve.ts`); the operator-sovereignty model — pluggable
claim predicate, execution wiring as non-protocol config, the `legacyManifestDigest`
compile-down bridge (binding §7, frozen §11.9); the composition rule — pipeline composes
binding + embedded backend through public interfaces only (binding §9, guarded in CI); layer
ownership per TEP §4; and `client/`'s disposition as an in-repo tier-4 product with
extraction only after this cutover (platform architecture §7, DR-2026-07-30).

## 2. Ground truth — the nine-step walk

Method per the design-tail session brief: walk find work → decide to claim → claim → execute
→ capture evidence → deliver → settle → evaluate → earn, naming the implemented owner of
each step. Findings at stack head `8c7179f2c` (worktree audit 2026-07-30):

| Step | Legacy owner | Stack owner | State |
| --- | --- | --- | --- |
| Find work | `MechAdapter.watchForTasks` + `client/src/discovery/` | projector (`decodeMarketplaceLogs` → observations → signed announcements) + discovery serve/client/facts | library complete; **no chain log source, no runnable transports, no subscriber loop** |
| Decide to claim | `TaskEngine.canAcceptTask` + daemon gates (readiness, AI-units, spend caps) | pipeline claim predicate + caps + wiring (`evaluateClaimPredicate`, `checkCaps`, `resolveWiringEntry`) | pure functions done; **no facts → `SubmissionFacts` mapper exists**; rolling-window USD caps have no stack owner (host-owned by design) |
| Claim | `contracts.ts claimTask` via Safe + nonce ledger + eviction recovery | binding claim leg (`claimAttempt` over `ClaimPorts`) + deterministic Attempt URI | sequence done; **chain write is an unimplemented port**; daemon-grade Safe concurrency explicitly disclaimed by `binding/src/venue/safe.ts` and replicated nowhere |
| Execute | engine PRE_SNAPSHOT/RUNNING/POST_SNAPSHOT + runners | `makeLocalTaskExecutionBackend` (supervisor/workspace/launchers/assembly) | **most complete step**; nobody assembles `LocalTaskExecutionBackendConfig` |
| Capture evidence | envelope assembly; envelope hash doubles as evidence hash | evidence join wired end-to-end **inside** the backend; recorder → receipt → sealed Delivery | done for recording; the `EvidenceBindingPorts` ← `evidence-local-runtime` join is deliberately host-owned (architecture test enforces the package must not import it); nothing drives `awaitIndexed`/sync/publication |
| Deliver | `callDeliverToMarketplace` + IPFS upload | binding delivery leg (`convergeDelivery`) + `IpfsPinPort` | correspondence checks done; **pin port is the one production-capable plug** (`createRegistryPinPort`); the anchoring tx is folded into settlement ports, unimplemented |
| Settle | `claimDelivery`, provenance verification, race-loss classification | binding settlement leg (`settleDelivery` — every gate implemented) + lifecycle ports | **every gate implemented, every chain read/write unimplemented** |
| Evaluate | mech adapter's internal evaluation-opportunity machinery (not the delivery-watcher, which only validates envelopes) | `deriveAndSealEvaluationSubmission`, `gateVerdictObservation`, evaluation harness, attestation-issuer | **no evaluator loop**; verdict-gate policy entries unassembled; no concrete `EvaluatorAdapter` ships (explicitly descoped by the program) |
| Earn | earning bootstrap, reward-claim/checkpoint/eviction/balance-topup loops | **none — by design** | confirmed wholly application-tier (binding design's own exclusion list) |

Consolidated: the primitives survive the walk; the composition is the entire remaining
artifact — a runtime plus roughly a dozen unwritten adapters. §6 turns that gap list into
owned deliverables. Bright spots: `createRegistryPinPort` is real; `BASE_SEPOLIA_TODAY`
(`binding/src/addresses.ts`) is a deployed, preflight-confirmed chain config with
`TaskCoordinatorV4` + `JinnRouterV4` Solidity behind the seam.

## 3. Shape — the operator application and the operator runtime

**Naming.** "Client" is retired as the component name. Per the ratified terminology
discipline (profiles design §3, #1979): the **operator application** is the tier-4 product —
SPA, CLI, HTTP API, earning, config surface. The **operator runtime** is the daemon proper —
the composition root this spec designs. The physical tree renames `client/` → `operator/` at
cutover stage 5 (§10) — after the recomposition, so the strangler stages diff against a
stable tree and the rename is one clean commit touching only paths.
`client/OPERATOR-APP-SPEC.md` moves with it, its name finally matching its home.

**The three-way split:**

1. **Operator runtime (tier 4, in `operator/`)** — owns exactly what the layering law
   assigns applications: the composition root assembling `LocalTaskExecutionBackendConfig`,
   `PipelineConfig`, and `PipelinePorts` from operator config; operator sovereignty (claim
   predicate config, execution wiring, the rolling-window USD cap gates over SQLite);
   earning and bootstrap untouched; HTTP API + SPA + CLI; watchdog; store. The one join the
   stack deliberately refuses to own — `EvidenceBindingPorts` ← `evidence-local-runtime` —
   is written here, exactly as the backend's architecture test demands.
2. **Venue adapters (tier 3, `packages/marketplace/venue-base/`)** — the chain plugs (§6.1).
   One tree because they share one thing: a viem client pair and the canonical venue's
   contracts. Never names a product.
3. **Discovery transports (tier 3, `packages/discovery/transport-http/`)** — the HTTP plugs
   (§6.2).

Everything the walk confirmed as application-tier with no stack replacement designed —
corpus autoload, faucet, watchdog, SQLite activity store, the earning family — stays where
it is, untouched except where a cutover stage forces a delta.

> **Amended 2026-08-04: the "untouched" ruling above is superseded.** The application tier
> is re-derived per surface by the
> [headless operator re-derivation design](../specs/2026-08-04-headless-operator-rederivation-design.md)
> (headless daemon, control/application route split, separate operator console, receipts +
> versioned read contract). The re-derivation's surface execution is **stage 6** (§10
> amendment below); its contract discipline binds stages 1–5's operator-app deltas
> immediately. This paragraph's ruling was scope-bounding for the cutover, not a
> derivation, and the finding is recorded there (§2).

## 4. The composed operator runtime — loop map

Today's daemon runs eleven supervised loops plus one-shot recovery. The recomposition
replaces the four that belong to the marketplace loop and keeps the rest untouched.

| New loop | Does | Replaces |
| --- | --- | --- |
| **Projector loop** | reads venue chain events via `venue-base`'s log source, reduces to TEP observations + signed discovery announcements, maintains the local discovery archive; the finality waiter reads from it | engine-watcher's chain scanning; all of `client/src/discovery/` |
| **Work loop** | subscribes to the local archive → facts → `SubmissionFacts` mapper → claim predicate + caps + wiring → one pipeline engagement per claim (claim → execute on the embedded backend → deliver → settle) | engine-watcher, engine-tick, the TaskEngine's venue + execution states |
| **Evaluator loop** *(new capability)* | observes solution deliveries (skipping the operator's own) → derives + posts the evaluation Submission → claims the verdict attempt → executes it as an **evaluation-profile Attempt on the same embedded backend** via the evaluation-harness launcher — same shim, journal, harvest; the backend seals the Delivery, and the **attestation-issuer runs inside the executor** to seal the conclusion as Result Evaluation Evidence (local-backend §10.3–§10.4; there is no separate evaluation runner — its re-implementation is named forbidden duplication) | the mech adapter's evaluation-opportunity machinery; delivery-watcher |
| **Posting loop** | the requester side: posts Submission documents through the binding's posting leg + durable intent store; **owns requester-side adoption** of deliveries for the operator's own tasks (the carve table's "application" owner, named for this host); built as the extractable work-client module (§8) | creator loop internals; launched-record generators |
| **Evidence driver** *(new, small)* | drives what the backend deliberately will not: local-runtime `sync`, publication/announcement, `awaitIndexed`, indexing-failure surfacing. **Publication policy:** the driver publishes only records already sealed for marketplace delivery or announcement — capability-grant material and secret-forwards never enter the archive. Idempotent by record digest; a record is announced only after it is indexed | nothing (unowned today) |

> **Amended 2026-08-03 (`25924bd4a`): the Evaluator loop row's "the attestation-issuer runs
> inside the executor" is reversed.** The sandbox now writes an **unsigned** Result Evaluation
> statement to `out/verdict` and holds no signing key at all — the evaluation harness launcher
> grants `secretForwards: []` (`evaluation-harness/src/launcher.ts:94-95`) and the composition
> layer rejects any grant on the evaluator-sealed input
> (`client/src/daemon/native-evaluator-composition.ts:291-293`). The **host** parses the
> unsigned statement, re-serializes it to canonical bytes, and refuses to seal/publish unless
> the reserialized bytes are byte-identical to what the sandbox wrote
> (`client/src/daemon/native-evaluator-composition.ts:343-345`, fail-closed on mismatch), then
> seals the DSSE envelope with the evaluator Agent's key on the host side. Why: no signing
> capability goes into an untrusted sandbox; the byte-equality reseal preserves the same
> integrity property (delivered verdict = exactly what the sandboxed evaluation produced) that
> in-executor signing was meant to give. The reversal is sound and not reopened by this note.
> Same reversal, same reasoning, recorded in the
> [local-execution-backend design §10.4](./2026-07-27-local-execution-backend-design.md#104-evaluation-runner-design-reconciliation).
>
> **Further amended 2026-08-30, recording the 2026-08-12 repair (`688bf27ad`, PR #2601):
> the re-serialization half of the note above is superseded; its conclusion stands.** The host does *not* re-serialize the
> statement to canonical bytes and compare. That guard compared the harness's output against
> trust-core's compact JCS encoding, while the harness writes the attestation family's pretty
> spelling, so the two could never agree and every real evaluation threw. The host now checks
> the producer's own spelling (`canonicalAttestationJsonBytes`, the encoder
> `buildResultEvaluationPayload` writes with) and seals *the sandbox's exact bytes* via
> `sealSignedPayload` — still fail-closed on mismatch. The integrity property is unchanged and
> in fact strengthened: the DSSE payload is now the graded file itself rather than a
> re-encoding of it. The Evaluator loop row's reversal — no signing key in the sandbox, host-side
> sealing — is unchanged. Cite these by symbol, not by line: the file is now
> `operator/src/daemon/native-evaluator-composition.ts` (renamed from `client/` on
> 2026-08-16 in `5a4b537cf`), the grant rejection is its `stateBackedProvisioner` `setup` guard
> ("evaluator-sealed Submission must remain grant-free", formerly cited `:291-293`) and the
> byte check is in the same provisioner's `harvest` path (formerly cited `:343-345`);
> `secretForwards: []` is set in `evaluation-harness/src/launcher.ts`'s
> `launcherCapabilities` helper (formerly cited `:94-95`).

**Kept as-is:** reward-claim, checkpoint, eviction, balance-topup, harvest (corpus mining),
watchdog + heartbeats.
**Retired:** delivery-watcher (absorbed by the settlement leg and the evaluator loop);
peer-sync at the discovery-serving stage — once the operator serves a signed discovery
archive, envelope gossip is subsumed.

**Evaluation sealing during the bridge era.** The evaluator loop operates in the binding's
evaluator-seals carve-out — public evaluation specs only, the today-mode case (binding
§6.4). Requester-side sealing of evaluation Submissions — the default for private test
material under capability grants — is a posting-loop deliverable and lands with stage 3.

**Crash recovery is derivation-first.** Today `recoverInFlight` re-enters a bespoke SQLite
state machine (`task_runs`). In the new shape the chain (through the projector) and the
backend's own journal are the sources of truth; boot reconstructs in-flight engagements from
them — the backend already recovers its executions, and the binding's settlement leg is
idempotent by design. The host keeps a thin **engagement ledger** in SQLite only for what
the chain cannot tell it (which wiring entry served a claim; operator-local decisions). Two
ordering rules close the crash windows: the engagement-ledger row — wiring entry plus
idempotency key — is written in the same transaction that admits the claim intent,
**strictly before the claim broadcast**, outbox-style, and is reconciled against the chain
on boot; and at boot the work loop issues no new claim until the projector's durable cursor
has caught up to the chain head at the finalized tier, so it cannot re-claim a task it
already holds or re-execute a delivered attempt. The `task_runs` machine is deleted at
stage 5.

**The unreleased-attempt path.** In today-mode the binding's `releaseAttempt` returns
`unsupported` while the pipeline treats an undefined release as released — so a post-claim
failure leaves the attempt unreleased on the venue. The runtime surfaces this as an operator
state message (with the eventual close/release action once the revised generation supports
it) rather than pretending release happened. Legacy attempts stranded at a cutover boundary
(§10 drain rules) surface through the same state message — the condition is identical from
the operator's seat.

## 5. Stack coverage and usage disciplines

The runtime composes cataloged capabilities from the task-execution, marketplace, discovery,
trust, and evidence domains in their designed roles. Exact package membership and runtime edges
come from the [generated platform topology](../../../architecture/generated/platform-topology.md),
not a fixed tree count in this design. Correct non-uses: **benchmarking** (a different
application), **repository-oci** (an alternate repository backend the operator does not select),
and the attestation-issuer's *second* family — Execution Verification Evidence — whose producer
(a process verifier) is a Phase B.1 actor, not the operator.

Disciplines held by construction: composition through public interfaces only (the
source-boundary guard enforces it); seal-once — the work loop mints the Attempt URI, hands
it to the backend via the two-party engagement entry, the backend seals the Delivery
exactly once, the binding uploads and anchors without re-sealing; the evidence join is
host-injected; the claim decision stays operator-private.

## 6. The build list

Every gap from §2, owned. All new packages follow the stack's standing discipline:
**conformance kits precede implementations**, and each new tree ships the guard trio
(package inventory, source-boundary, packed-types canaries + CI workflow) with the packages,
not after.

### 6.1 `packages/marketplace/venue-base/` — the chain plugs

Fresh, package-grade implementations (decision §7 note below on how fresh-rewrite stays
safe):

| Deliverable | Fills |
| --- | --- |
| Chain log source — chunked `getLogs` sized to provider caps, durable `(blockNumber, blockHash)` cursor, reorg handling per §7.2 | the projector's event feed |
| Safe broadcast — `execTransaction` with shared nonce ledger, cross-process lock, eviction-recovery retry, inner-revert decode | `SafeBroadcastPort`; the daemon-grade concerns `binding/src/venue/safe.ts` explicitly disclaims |
| Claim writer | `ClaimPorts.claimTask` |
| Settlement reads + writes — delivery-facts readers, `claimSolutionDelivery`, revised-generation settle | `SettlementPorts` (pin already exists) |
| Lifecycle writes — resolve / cancel / withdraw / refund / close / release | `MarketplaceLifecyclePorts`, `ReleaseAttemptPort` |
| Finality waiter — a real waiter over the log source applying the projector's finality policy | `FinalityPort` |
| Delivery waiter — event-watch with poll fallback and cancellation | `DeliveryWaitPort` |
| Durable posting-intent store (SQLite, §7.4) | replaces the in-memory crash WAL |
| Projector-backed observe | `MarketplaceObservePort` — retires the in-memory stub the binding flags as "Milestone M4, not yet built" |

Four placement notes:

- **Single-broadcaster rule.** From cutover stage 1 onward, `venue-base`'s Safe broadcast is
  the **only** transaction path in the daemon process: the surviving legacy legs (creator
  posting until stage 3, evaluation transactions until stage 2) are re-pointed through the
  venue-base broadcast port in the stage-1 PR. Two independent nonce stacks against one Safe
  and one EOA is the #525/#562/#897 failure class; it is excluded by construction, not by
  luck.
- **Supersession note.** `binding/src/venue/safe.ts` currently says the daemon-grade
  concerns "belong to the pipeline (Milestone M6)". This spec re-homes them to `venue-base`
  — venue mechanics, not application policy; nothing frozen pins the M6 placement. The
  comment is updated at stage 0.
- **Port-type home.** Three of the ports venue-base implements (`FinalityPort`,
  `DeliveryWaitPort`, `ReleaseAttemptPort`) are declared in the pipeline package. At stage 0
  they are re-exported from the binding's port surface so the adapter tree depends on
  binding types only, keeping tier-3 adapters off the application-shaped package.
  *Corrected 2026-07-30 (planning consolidation, venue-base plan finding 1):* venue-base
  additionally takes `marketplace-projector` as a production dependency — the log source
  emits its types, the finality waiter applies its policy, projector-backed observe is
  projector-shaped by definition. The operative clause is that `marketplace-pipeline` is
  guard-forbidden in venue-base production source.
- **npm posture (recorded for #2293).** `venue-base` is signer-injection-only: every port
  takes an injected viem `WalletClient`; the package contains no keystore, no key-loading
  code, and no key material ever. The external-consumer boundary rule ("no tx client in the
  SDK") governs the *supported external surface* — schemas + the `jinn` CLI — not
  first-party tier-3 packages; whether that line moves is the marketplace-surfaces session's
  question, and publishing venue-base does not preempt it.

### 6.2 `packages/discovery/transport-http/` — the discovery plugs

Filesystem `BlobStore`; an HTTP handler over `serve`'s static layout — the host mounts it on
the operator API server (one process, no second listener by default); client-side
`Transport` / `StreamTransport` / ping. Wire profile per §7.3. Exposure is scoped: only the
archive subtree is public; every other operator API route stays on the authenticated
surface, and exposing the listener beyond localhost is an explicit opt-in (with a separate
bind available for operators who want the archive public and the dashboard private).
Serving an archive from a residential operator discloses the operator's IP to consumers;
the static-file layout exists precisely so a mirror or static host can serve it instead,
and the operator app says so where the opt-in lives.

> **Amended 2026-08-04: the mounted-by-default posture is reversed.** The public archive
> is a **separate Hono app on a separate listener, mandatorily** — never a route prefix on
> the operator API — effective at stage 4 so the split is built once. The archive-subtree
> exposure invariant becomes structural rather than documented. Ruling and payload-class
> model in the
> [headless operator re-derivation design §6](../specs/2026-08-04-headless-operator-rederivation-design.md).

### 6.3 `packages/task-execution/evaluator-adapters/`

Fresh re-homing of the concrete result parsers (swe-rebench, prediction) into the evaluation
harness's deployment allowlist. Parsers ingest JUnit XML / TAP / benchmark-local JSON at the
adapter edge; the verdict record stays in Jinn's sealed-record grammar (§7.5).

### 6.4 Pipeline tree — one pure module

The facts-card → `SubmissionFacts` mapper. `SubmissionFacts` stays structurally independent
of the discovery packages, as designed; the mapper lives beside the pipeline and is the only
place the two shapes meet.

### 6.5 Host-only deliverables (operator runtime)

The composition root; the evidence join; the evidence driver loop; verdict-gate policy
assembly (`admissionAgentPolicy` / `evaluatorPolicy` / `requesterPolicy` resolved from
trust-resolve + operator config); the thin engagement ledger; requester-side adoption in the
posting loop; cap gates re-pointed at pipeline caps while keeping their SQLite
rolling-window accounting. The four new loops of §4 — projector, work, evaluator, posting —
are likewise host deliverables; the §4 loop map is their specification.

### 6.6 Kit strategy — how fresh-rewrite stays safe

The adapters are written fresh (approved in-session over porting legacy code), and **legacy
behavior enters as fixtures, not code**: the mech adapter's revert-classification table, the
nonce/eviction recovery scenarios, and the RPC chunking rules become kit test cases the
fresh implementations must pass. The venue kit's backbone is an Anvil-fork integration suite
— the same infrastructure as `e2e:daemon-harness` — because integration-over-mocks is the
ratified rule for migration surfaces.

## 7. Standards audit

Run per the composition-over-invention principle (stack design principles §3): adopt /
compose-with-profile / bespoke, per surface. The six stack contracts carry their own audits;
this audit covers only the surfaces where this design has freedom. Repo-local check first:
the record-discovery design already pins the archive semantics (HTTPS static-file root,
digest-addressed immutable paths, RFC 5005-shaped pages, DSSE-signed head, CloudEvents
structured JSON wire, the atproto five-case cursor contract) — those are treated as settled.
It left **one choice explicitly open**: §9.4's pull-tail transport, "one normative HTTP
profile fixed at implementation." Ruling 3 closes it.

1. **Safe broadcasting — compose: viem + Defender-relayer semantics as the named profile.**
   Safe{Core} SDK is rejected: its value-add (tx-hash computation, signature encoding) is
   the easy part, while the hard parts — nonce ledger, fee-bumped retry, stuck-nonce
   eviction, inner-revert decode — stay ours either way; ERC-4337 is a distraction for a
   1-of-1 EOA-owned Safe that pays its own gas. The profile is what OpenZeppelin Defender
   Relayers document: per-sender serialized nonce assignment, a persistent submission ledger
   keyed `(chainId, from, nonce)`, fee-bumped replacement, eviction, reconcile-on-
   nonce-too-low. Today's `tx-retry.ts` already implements this shape — the fresh
   `venue-base` implementation is the *named* profile, with the legacy scenarios as kit
   fixtures. The two hand-rolled fragments (eth_sign v-adjustment, pre-validated signature
   encoding) are Safe-contract-specified behavior; the profile cites the Safe contracts
   spec for them.
2. **Chain event ingestion — compose: thin reader profile over viem `getLogs`.** Ponder is
   framework-shaped, not embeddable (it stays out-of-process as projector-adjacent infra);
   shovel and TrueBlocks are the wrong shape entirely. The profile: chunked `getLogs` sized
   to provider caps; cursor = hash-verified `(blockNumber, blockHash)` high-water mark,
   persisted; dual marks — a live cursor tracking `latest`, a durable checkpoint advancing
   only on Base's `finalized` tag; cursor-hash mismatch = reorg = roll the projector back to
   the finalized checkpoint and re-scan. OP-stack finality tags over a hand-tuned depth
   constant; depth is the fallback for providers serving stale tags. Rollback-and-rescan
   governs projector *state* only: announcements already emitted from pre-finality blocks
   are corrected append-only through signed retractions (binding §8), never rewritten.
3. **Archive transport — compose: RFC 9110/9111 + SSE.** `ETag`/`If-None-Match` conditional
   GET on the head (the only mutable object); `Cache-Control: immutable` on digest paths and
   archive pages *(refined 2026-07-30 at planning consolidation: `immutable` applies to
   sealed pages — those with a successor — while the newest, still-growing page serves with
   ETag + `no-cache`, since `serve` rewrites it on append; the replay-window advertisement
   is typed in `transport-http` pending promotion into `serve`)*; declared
   `Accept-Ranges: bytes` on blobs. The pull-tail is fixed as **SSE
   with `Last-Event-ID` carrying the relay cursor** — the boring standard for a
   server-to-client append-only feed (auto-reconnect, plain HTTP, stateless horizontal
   scale); WebSocket is justified only by mid-stream client-to-server messages, and our
   filters are set at subscribe time. The discovery design's five-case cursor contract maps
   onto SSE as typed terminal events (`unknown-cursor`, `cursor-too-old` naming the
   cold-sync path) followed by stream close, and each source advertises its bounded replay
   window in the well-known discovery document. Explicitly rejected: TUF's role machinery (the
   DSSE-signed sequence-numbered head already is the timestamp+snapshot in one envelope) and
   OCI's registry API (an active server conflating transport with registry semantics,
   against the "hosting a source costs a static file host" design goal — its
   content-addressed layout idea is already absorbed).
4. **Posting-intent store — established practice, named:** the transactional-outbox pattern
   + idempotency keys over SQLite WAL. The intent row (idempotency key = logical operation
   identity, not tx hash) is written in the same transaction as the motivating state change;
   a sweeper drains pending intents through the Safe broadcast profile; the broadcast fences
   are the seam, and broadcast-but-unrecorded is the one state the recovery scan reconciles
   against the tx-submission ledger.
5. **Evaluator results — bespoke verdict document, deliberately.** SARIF is
   findings-in-source shaped and would be abused for pass/fail checks; JUnit XML is a
   schema-less dialect soup in an I-JSON stack; TAP is too thin. All are parsed at the
   adapter edge as ingestion formats. "Verdict with per-check results, sealed and signed" is
   exactly the composition no existing format provides — the one place adopting a standard
   wholesale would be the over-engineering.

## 8. The requester side and the work client

A composed requester facade — "post this Submission, await the delivery, adopt, settle, hand
me the evidence" — has three known consumers (Autopilot's adoption pass, benchmarking's
marketplace mode, external integrators). It is **not minted as a public package here**,
for one settled-boundary reason: the external-consumer boundary design (2026-07-24) rules
that no key material or tx client lives in the SDK — external consumers get schemas + the
`jinn` CLI, and the CLI holds the keys. A work client that posts and settles *is* a tx
client; whether that posture loosens for npm-consuming first-party products while staying
hard for external integrators is a design question with its own threat model.

Disposition: **this spec builds the operator's requester side as an extractable module** —
the posting loop composed strictly through the binding's public interfaces, no imports from
the rest of the host — so it is the work client in everything but packaging. **The
marketplace-surfaces session owns the public work client**: the tx-client-in-SDK question
against the external boundary design, schema versioning, and the DevX program, starting from
the operator's requester module as the proven reference composition. Recorded as a
follow-up hand-off (§12).

## 9. Config migration and the SolverNet retirement schedule

**Migration is automatic and panel-visible.** The standing operator principle — after the
first `jinn run`, never back to the terminal — makes it a boot-time daemon action: on first
boot of the recomposed runtime, the daemon reads `joinedSolverNets[<manifestCid>]`, writes
the new shape, keeps the old file as a timestamped backup, and the panel shows a one-time
state message. Three hardening rules: the migration is **additive** — the new keys are
written beside `joinedSolverNets`, and the legacy keys are deleted only at stage 5, so any
prior daemon generation boots correctly from the migrated file and the hard-swap rollback
cannot produce a silent claim-nothing stall; the write is **atomic** (temp file + rename);
and it is **idempotent** via a config shape-version key, so re-upgrade after a revert is a
no-op. The backup keeps the config file's permissions (it can carry paid RPC keys) and is
pruned at stage 5. The mapping is the one the binding froze: each joined entry becomes one
**execution-wiring entry** (work-kind → harness, model, plugins, credential) carrying the
`legacyManifestDigest` annotation, and the claim predicate compiles down to manifest-digest
matching — behavior-identical on day one, by design. Launcher-side, each launched record
becomes an explicit **posting-config entry** (generators re-key from manifest-gating to
posting wiring). Restart-required semantics stay; no hot reload is added.

**Retirement rides the cutover** — each surface retires when its replacement is live, never
before:

| Retires | Stage (§10) | Replaced by |
| --- | --- | --- |
| `joinedSolverNets` claim gating | 1 | predicate + wiring (bridge annotation active) |
| Registry client (ERC-8004 manifest publish/discover/resolve) | 4 | signed discovery announcements from the projector |
| Lifecycle publishing + launched-record gating | 3 | posting config + binding lifecycle |
| The `legacyManifestDigest` bridge itself | after 5 | nothing — the annotation is deleted once the venue's open manifest-digest Submissions have all reached terminal states |

**CLI.** `jinn tasks` posts Submission documents and gains the lifecycle exits (close,
cancel, release); new `jinn policy` and `jinn wiring` verbs expose the claim predicate and
wiring entries; `jinn solver-nets` and the six `solver-plugins-*` modules retire on the same
schedule as their machinery — except the plugin *content* commands (publish / read /
feedback / block / revoke), which only re-key from manifestCid to wiring entries here; their
deeper disposition belongs to the plugin session and is not preempted.

**Operator app.** The memberships page becomes **Claim policy & wiring** (predicate, wiring
entries, caps, migration state message); new close / release / cancel actions with full
action-state lifecycles; the evidence driver surfaces indexing failures as a state message.
Each delta lands with its `OPERATOR-APP-SPEC` update in the same PR, per the frontend rules.
Deltas only; no redesign.

## 10. The cutover — six stages, swap by flow

The strangler unit is a **flow**, not a layer: horizontal layer swaps would force throwaway
shims between new layers and the legacy engine at every step, while a vertical flow swap
ships a complete slice through the new stack per stage, the legacy engine running the flows
not yet moved. Approved posture: **hard swap per stage; rollback is reverting the PR /
pinning the previous canary image.** No feature-flag matrix, no shadow mode.

| Stage | Swaps in | Retires | Gate (beyond typecheck / tests / kits / guards) |
| --- | --- | --- | --- |
| **0 — Packages** | `venue-base`, `transport-http`, `evaluator-adapters`, facts mapper; kits first; guard trio with the trees | nothing (no daemon change) | Anvil-fork venue kit green; independent review per new tree before dependents build on it |
| **1 — Solver flow** | work loop: projector-fed discovery → predicate → pipeline → embedded backend (evidence join + driver) → deliver → settle; config auto-migration (bridge live); **all surviving legacy tx legs re-pointed through the venue-base broadcast** (single-broadcaster rule, §6.1) | TaskEngine's solution path; `joinedSolverNets` gating; `task_runs` frozen for solutions | `e2e:daemon-harness` re-pointed and green; one real task closed-loop on testnet through the new flow, **including the verdict leg via the still-legacy evaluator** |
| **2 — Evaluator flow** | evaluator loop: derive → post (through the durable intent store, wired here) → claim verdict → evaluation-profile Attempt on the embedded backend → verdict delivery | delivery-watcher; the mech adapter's evaluation machinery; the legacy TaskEngine entirely (last flow out) | verdict closed-loop on testnet |
| **3 — Posting flow** | posting loop on the binding + requester-side adoption + requester-side evaluation sealing (the extractable work-client module) | creator loop; launched-record generators; lifecycle publishing | own posted task adopted end-to-end on testnet |
| **4 — Discovery serving** | public archive mounted on the operator API (SSE tail, ETag head) | peer-sync; registry client; `client/src/discovery/` | archive consumable by a second daemon; discovery kit green against the live surface |
| **5 — Rename + closure** | `client/` → `operator/`; guard trio on the operator tree | `task_runs` machine deleted; bridge retirement begins per §9 | extraction-gate-shaped check: the tree builds green with guards |

Operator-app deltas ride the stage that forces them: stage 1 the Claim policy & wiring page
+ migration message; stage 3 the posting surface; stage 4 the evidence/indexing status.

> **Amended 2026-08-04** per the
> [headless operator re-derivation design](../specs/2026-08-04-headless-operator-rederivation-design.md):
> **(a)** every operator-app delta above builds against the versioned read contract (its
> §8) so stage-6 relocation is cheap; **(b)** the stage-3 posting delta is re-ruled — posting
> *status* joins the read plane, posting *mutations* are config + `jinn tasks`, no mutating
> posting routes are built; **(c)** stage 4 mounts the public archive on its **own
> listener** (§6.2 amendment above), and its SPA-fallback guard task is re-planned
> accordingly; **(d)** stage 5 additionally flips the transition-manifest rows referencing
> the `verticalMode` branch to `deleted` in the same PR that deletes the branch; **(e)** a
> **stage 6** follows the rename: the SPA departs to the separate operator console,
> application routes retire per that spec's §4, the CLI migrates onto the read
> plane/control plane, and the tier-3-shaped extractions run — gated on that spec's §8
> contract artifacts and on re-homing the `e2e:app-flow` / `e2e:funding-sequence` gates
> onto the console's pipeline first.

> **Amended 2026-08-05** per
> [DR-2026-08-05](../../../log/decisions/2026-08-05-cutover-one-swap-collapse.md):
> **stages 2, 3, and 4 collapse into one wholesale swap** — one PR train into
> `integration/evidence-v1`, one combined drain
> ([`docs/runbooks/cutover-one-swap-drain.md`](../../runbooks/cutover-one-swap-drain.md)),
> one deploy PR, one fused two-probe gate (G-loop: a natively-posted own task solved by a
> second operator and container-graded through the native evaluator to a
> `decisionGrade: true` verdict and requester-side adoption; G-archive: second-daemon
> archive consumption + serving-plane kit). The three stage rows above read as a single
> row whose "swaps in" and "retires" columns are the union of theirs, **minus the
> bridge-era work the collapse deletes outright**: the bridge-subject synthesis and its
> admission-receipt rule (register R2 — dissolved unbuilt), the self-signer grant
> allowance (register R1 — dissolved by the 2026-08-03 host byte-equality reseal and the
> native derivation's `capabilityGrants: {}`), the operator-API archive mount (already
> reversed above), the mutating posting routes (already re-ruled above), and the
> inter-stage handshake checks the stage plans carried against each other. Native-v1's
> runtime is the machinery swapped in; its parallel entry point becomes redundant at the
> swap and **retires at stage 5** with the `verticalMode` manifest-row flips
> (DR-2026-08-04-b decision 1, headless §13(e)). Stages 5 and 6 are unchanged in content;
> stage 5's dependency reads "the one-swap deploy PR merged and its gate green." The
> support/earning loops are **not** in the swap — their re-derivation is stage 6's job
> (headless design §1).
>
> **Corrected 2026-08-07:** G-loop is **not** container-graded — decision 3a decoupled
> into two artifacts (G-loop on the prediction profile + a separately run container-grade
> proof); same bar, different shape. See the DR's 2026-08-07 addendum.

**Bridge-era document rules (stages 1–3).** *Amended 2026-08-05 per DR-2026-08-05: with
stages 2–4 collapsed, "stages 1–3" reads "until the one-swap deploy" and the window
closes per DR decision 4's straggler conditional.* Until stage 3, every claimable task is
legacy-posted and carries no sealed Submission. The projector synthesizes the facts card
for such tasks from the anchored task document under a `legacy` derivation annotation, and
the `SubmissionFacts` mapper accepts it as a declared bridge input until stage 5. In the
other direction, the loop stays closed because the converged Delivery is convergence, not
wrapping (binding §6.3): the sealed marketplace-profile Delivery re-homes the
`jinn.execution.v1` content the legacy evaluator already parses — verified by a stage-1
fixture, not assumed. *Corrected 2026-07-30 (planning consolidation, stage-1 plan finding
D3): code investigation showed the fixture would be red — the backend's sealed TEP Delivery
carries no `jinn.execution.v1` payload and the legacy evaluator's envelope parse throws.
The ratified bridge is an optional namespaced `deliveryExtensions` hook on
`LocalTaskExecutionBackendConfig` (permitted by `DeliveryRecordSchema`'s `.loose()` and TEP
§21.3) carrying the legacy envelope content, plus a read-path preference in the mech
adapter; both retire with the `legacyManifestDigest` bridge after stage 5.*

**Drain rules (every retiring flow).** A hard swap is preceded by a drain: the retiring
flow stops accepting new work and runs until its in-flight items reach terminal states
before the swap deploys (bounded by the operator's patience — remaining stragglers strand
with the §4 state message, never silently). Today-mode has no on-venue release, so a
stranded claim occupies its `maxClaims` slot until the revised generation's deadline-reap;
the drain exists to make that set empty in practice. Rollback is symmetric and honest:
reverting a stage abandons the new flow's in-flight engagements — chain state stays
consistent (claims are chain facts; the backend journal persists), but the reverted daemon
does not resume them, and the same state message names them.

Standing rules across all stages:

- Every stage is stacked PRs into `integration/evidence-v1` (application-layer rule; the
  integration branch is not yet in `next`).
- The runtime consumes the stack via in-repo `portal:` links. The npm publish path
  ([#2293](https://github.com/Jinn-Network/mono/issues/2293)) proceeds in parallel and is
  **not** a stage gate — it gates extraction and external consumers, not this cutover.
- The `core`/`layer`/`plugin` portal surface and the five-tree operator image stay intact
  until stage 5 completes, per the platform architecture's sequencing constraint; the plugin
  session inherits them after.
- Fixing the repository's single cross-tree import violation
  ([#2297](https://github.com/Jinn-Network/mono/issues/2297), in `client/scripts`) lands no
  later than stage 5's guard installation.
- Stages 1–3 knowingly run two chain readers (the legacy engine-watcher scan until stage 2,
  the retiring discovery floor until stage 4, plus the new projector). The window is
  accepted explicitly and kept short; readers share the venue-base log source where the
  seam allows, and the fleet-wide RPC-quota shape of the 2026-05-23 incident is the reason
  the window is named here rather than discovered later. *Amended 2026-08-05 per
  DR-2026-08-05: the one-swap collapse ends the whole window at one deploy — both legacy
  readers retire together instead of across two stage boundaries, which is part of the
  collapse's rationale.*

## 11. Non-goals

> **Amended 2026-08-04:** two non-goals below are narrowed by the
> [headless operator re-derivation design](../specs/2026-08-04-headless-operator-rederivation-design.md):
> "no operator-app redesign" becomes *no redesign beyond the deltas the cutover **and that
> spec's stage-6 disposition** force*; "no earning/staking recomposition" becomes *no
> recomposition beyond that spec's §11 surface repairs* — the earning family's tier-3
> candidacy is named there, not scheduled.

- **No operator-app redesign.** Only the deltas the cutover forces (§9).
- **No public work-client package** (§8) — marketplace-surfaces session.
- **No `sdk` retirement beyond the daemon's own consumption** and no projector/explorer
  split — marketplace-surfaces session,
  [#2296](https://github.com/Jinn-Network/mono/issues/2296).
- **No `core`/`layer`/`plugin` disposition** — plugin session; this cutover preserves their
  portal surface (§10).
- **No earning/staking recomposition.** The earning family is application-tier by design and
  stays untouched.
- **No hot reload of operator config.** Restart-required semantics stay.
- **No new protocol or record semantics anywhere.** This design writes adapters, a host, and
  a schedule; every contract it implements is owned elsewhere.
- **No mainnet deployment decisions.** The cutover proves itself on the testnet fleet;
  chain-config selection stays config. *Amended 2026-08-05 per DR-2026-08-05 decision 8
  (refuse and pin): the swapped daemon's boot gate admits only Base Sepolia 84532 with
  the pinned today-generation addresses — native + mainnet is an explicit boot refusal,
  never a silent legacy fallback, and the mainnet fleet stays pinned to the pre-swap
  canary until a mainnet native deployment is chartered (Phase 2 scope). The non-goal
  otherwise stands: nothing here charters that deployment.*

## 12. Follow-ups and hand-offs

1. **Marketplace-surfaces session inherits:** the public work client + the
   tx-client-in-SDK boundary question (§8); the `sdk` retirement remainder; the
   projector/explorer split (#2296); the hosted DevX program (docs, quickstarts, schema
   versioning).
2. **Plugin session inherits:** the `core`/`layer`/`plugin` disposition with the
   post-stage-5 operator tree as its stable base; the deeper disposition of the plugin
   content CLI (§9).
3. **Bridge retirement chore:** delete the `legacyManifestDigest` annotation once the
   venue's open manifest-digest Submissions are terminal (§9) — filed as a chore when stage
   5 lands.
4. **Discovery-design addendum:** record the §7.3 closure of discovery §9.4 (SSE +
   `Last-Event-ID`) as a dated addendum note per the program's designs-are-law rule.
5. **Guard coverage** ([#2299](https://github.com/Jinn-Network/mono/issues/2299)): stages 0
   and 5 satisfy it for the trees this spec touches.

## 13. Provenance and method

Designed 2026-07-30 in worktree `bold-elion-c1faea`, immediately following the
platform-boundary ratification (DR-2026-07-30). Method per stack design principles §12:
research lanes (a corpus sweep of everything the seven designs already settle about this
recomposition; the nine-step code walk of §2; the standards audit of §7 with primary
sources), one material question at a time, section-by-section approval (artifact scope,
perimeter, cutover posture, adapter placement and build mode, §A–§E as written), two fresh
reviews before presentation. In-session corrections that shaped the design: "client" retired
as the component name in favor of the ratified operator-application / operator-runtime
terminology; the attestation-issuer correctly placed in the evaluator loop (Result
Evaluation Evidence is the operator's job today — only Execution Verification is a later
actor); the work client identified and deliberately deferred with an extractable-module
requirement here.

**Review dispositions (v0.2).** The architecture review found no blockers, one major
(evaluation-as-same-backend — the evaluator loop now runs verdicts as evaluation-profile
Attempts on the embedded backend, §4), and verified twenty-plus code claims with one wrong
citation (profiles §7 → §3, fixed). The adversarial review found three blockers, all in the
cutover mechanics, each resolved in place: the dual-broadcast-stack race (→ the
single-broadcaster rule, §6.1/§10 stage 1), the missing in-flight drain across hard-swap
boundaries (→ the §10 drain rules), and the bridge-era document gap (→ the §10 bridge-era
document rules); its majors resolved as the additive/atomic/idempotent config migration
(§9), the ledger-before-broadcast and projector-catch-up ordering rules (§4), the
evaluator-seals carve-out statement with requester-side sealing at stage 3 (§4/§10), the
evidence-driver publication policy (§4), the archive exposure scoping (§6.2), and the
venue-base npm posture note (§6.1). Both reviews independently confirmed the §7 standards
audit rulings against code.
