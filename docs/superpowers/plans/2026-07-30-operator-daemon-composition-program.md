# Operator-Daemon Composition Program

> **For agentic workers:** this is the coordination plan. Implementation runs through the
> component plans in §1, each authored to the superpowers:writing-plans conventions
> (bite-sized tasks, TDD, checkbox steps) and executed with
> superpowers:subagent-driven-development or superpowers:executing-plans. Do not implement
> from this document alone.

**Goal:** implement
[`../specs/2026-07-30-operator-daemon-composition-design.md`](../specs/2026-07-30-operator-daemon-composition-design.md)
(v0.2, reviews resolved) — the production operator daemon recomposed onto the stack
packages, cut over flow by flow, ending with the `client/` → `operator/` rename.

**Architecture:** three new tier-3 adapter trees plug the merged stack engines into the
real world (chain, HTTP); the operator runtime becomes the composition root hosting five
new loops; the cutover is six hard-swap stages, strictly ordered, each closing a real loop
on testnet. The spec is law; discoveries are findings with proposed dispositions, never
silent patches.

**Tech stack:** TypeScript / Node 22 / Yarn workspaces with `portal:` resolution; viem;
Hono; SQLite; vitest; the stack conformance kits; Anvil-fork integration suites.

## Global constraints

- Branch target: `integration/evidence-v1` (stacked PR trains; the integration branch is
  not yet in `next`). Nothing here publishes to npm — #2293 runs in parallel.
- Kits and fixtures **before** implementations; a layer's kit green before dependents build.
- Guard trio (package inventory, source-boundary, packed-types + CI workflow) ships **with**
  each new tree, not after.
- Every task ends with typecheck + tests + relevant kit + guards run locally, outputs shown.
- Independent per-component review when a component completes, findings resolved before
  dependents build on it (program discipline, principles §13.2).
- American English throughout; no product names in tier-3 code.
- The spec's §6.1 placement notes and §10 bridge-era/drain/standing rules are binding
  cross-plan contracts (§6 below).

---

## 1. Component plans

Authored next (parallel planning agents), one per row; executed in dependency order.

| Plan | Scope | Depends on |
| --- | --- | --- |
| `2026-07-30-marketplace-venue-base.md` | `packages/marketplace/venue-base/` — all nine §6.1 deliverables (log source, Safe broadcast, claim writer, settlement, lifecycle, finality waiter, delivery waiter, durable posting-intent store, projector-backed observe) + venue kit (Anvil-fork backbone, legacy scenarios as fixtures) + guard trio + the stage-0 mechanical notes (binding port re-exports; `venue/safe.ts` comment supersession) | — (stack merged) |
| `2026-07-30-discovery-transport-http.md` | `packages/discovery/transport-http/` — filesystem `BlobStore`, HTTP handler over `serve`'s layout, client `Transport`/`StreamTransport`/ping, the §7.3 wire profile (ETag head, immutable digest paths, declared Range, SSE + `Last-Event-ID` with typed terminal events + advertised replay window) + kit + guard trio | — |
| `2026-07-30-evaluator-adapters.md` | `packages/task-execution/evaluator-adapters/` — fresh re-homing of the swe-rebench and prediction result parsers into the harness deployment allowlist; ingestion formats parsed at the adapter edge only | — |
| `2026-07-30-cutover-stage-1-solver-flow.md` | Operator runtime: composition root; projector loop (+ facts → `SubmissionFacts` mapper, pipeline tree); work loop; evidence join + driver; engagement ledger; config auto-migration (additive/atomic/idempotent); **single-broadcaster re-point of all surviving legacy tx legs**; bridge-era fixtures (legacy facts card; converged-Delivery-parseable-by-legacy-evaluator); Claim policy & wiring SPA page + `OPERATOR-APP-SPEC` delta; drain runbook | venue-base; transport-http (blob store + local archive); evaluator-adapters not required |
| `2026-07-30-cutover-stage-2-evaluator-flow.md` | Evaluator loop (evaluation-profile Attempts on the embedded backend; evaluator-seals carve-out); durable intent store wired; verdict-gate policy assembly; retire delivery-watcher + mech-adapter evaluation machinery + legacy TaskEngine; drain runbook | stage 1; evaluator-adapters |
| `2026-07-30-cutover-stage-3-posting-flow.md` | Posting loop (extractable work-client module); requester-side adoption; requester-side evaluation sealing; CLI `jinn tasks` lifecycle exits + `jinn policy`/`jinn wiring`; retire creator loop + launched-record generators + lifecycle publishing; posting SPA surface | stage 2 |
| `2026-07-30-cutover-stage-4-discovery-serving.md` | Public archive mount (exposure scoping, opt-in bind, IP-disclosure copy); retire peer-sync + registry client + `client/src/discovery/`; evidence/indexing status surface; discovery kit against the live surface | stage 3; transport-http (HTTP surface) |
| `2026-07-30-cutover-stage-5-rename-closure.md` | `client/` → `operator/` rename (paths-only commit); guard trio on the operator tree; delete `task_runs`; delete legacy config keys + prune migration backups; #2297 fix; bridge-retirement chore filed | stage 4 |

## 2. Streams, phases, critical path

**Phase 0 — three parallel streams** (S1 venue-base, S2 transport-http, S3
evaluator-adapters), kits first within each. **Phases 1–5 — the cutover stages, strictly
sequential** (the drain rules and flow-by-flow design make them non-overlappable; a stage's
PR train may be prepared while the prior stage's testnet gate soaks, but no stage deploys
before its predecessor's gate is green).

Critical path: **venue-base → stage 1 → stage 2 → stage 3 → stage 4 → stage 5**.
S2 joins the path at stage 1 (blob store) and again at stage 4 (HTTP surface); S3 joins at
stage 2. Each phase ends with tests/kits/guards green, the per-component review done and
resolved, and a phase report.

## 3. Commit/PR-train structure

Stacked PRs into `integration/evidence-v1`, one train per component plan. Each hard-swap
stage ends in exactly one deploy PR whose description carries the drain-runbook checklist
and the rollback statement (pin previous canary; new-flow in-flight engagements abandon
with the §4 state message). No agent self-merge; the stage deploy PRs are
operator-approved.

## 4. Review and verification gates

Per-stage gates are the spec §10 table's gate column, verbatim — notably: stage 0's
Anvil-fork venue kit + independent review per tree; stage 1's `e2e:daemon-harness`
re-pointed and green plus one real task closed-loop on testnet **including the verdict leg
via the still-legacy evaluator**; stage 2's verdict closed-loop; stage 3's own-task
adoption; stage 4's archive consumed by a second daemon; stage 5's
extraction-gate-shaped build check. Between reviews, correctness is carried by automated
gates.

## 5. Naming decisions (settled here, used everywhere)

- npm names: `@jinn-network/marketplace-venue-base`,
  `@jinn-network/record-discovery-transport-http`,
  `@jinn-network/task-execution-evaluator-adapters` (matching each tree's existing scheme).
- Loop modules: `src/daemon/projector-loop.ts`, `work-loop.ts`, `evaluator-loop.ts`,
  `posting-loop.ts`, `evidence-driver.ts`; the requester module directory
  `src/requester/` (the extractable work-client seam — no imports from the rest of the
  host).
- Config keys (new shape, written beside the legacy keys until stage 5):
  `configShapeVersion: 2`, `claimPolicy`, `executionWiring[]` (entries carry
  `legacyManifestDigest`), `posting[]`.
- CLI verbs: `jinn policy`, `jinn wiring` (§9 of the spec).
- Cross-plan factory surface (coordinator ruling, binding on the venue-base and stage
  plans): `venue-base` exports one facade `createBaseVenue(config)` returning
  `{ claim: ClaimPorts, settlement: SettlementPorts, lifecycle: MarketplaceLifecyclePorts,
  finality: FinalityPort, deliveryWait: DeliveryWaitPort, release: ReleaseAttemptPort,
  observe: MarketplaceObservePort, safe: SafeBroadcastPort, logSource, intents }` with
  `config = { chain, publicClient, walletClient, safeAddress, stateDbPath }` (per-port
  factories may exist underneath; the facade is the supported composition surface).
  `transport-http` exports `createFsBlobStore(rootDir)`, `createArchiveHttpHandler(opts)`
  (fetch-style, mountable under a Hono route), `createHttpTransport(baseUrl, fetchLike)`,
  `createSseStreamTransport(baseUrl, fetchLike)`.

## 6. Cross-plan contracts (binding on every component plan)

1. **Single-broadcaster rule** — from stage 1, venue-base's Safe broadcast is the only tx
   path in the process; legacy legs re-point in the stage-1 train (spec §6.1/§10).
2. **Ledger-before-broadcast** — engagement-ledger row (wiring entry + idempotency key) in
   the same transaction as claim-intent admission, strictly before broadcast; reconciled on
   boot (spec §4).
3. **Projector-catch-up claim gate** — no new claim at boot until the durable cursor reaches
   the finalized chain head (spec §4).
4. **Config migration** — additive, atomic (temp+rename), idempotent
   (`configShapeVersion`); legacy keys live until stage 5 (spec §9).
5. **Evaluator-seals carve-out** — public evaluation specs only until stage 3 brings
   requester-side sealing (spec §4).
6. **Evidence publication policy** — only records sealed for delivery/announcement;
   never capability-grant material or secret-forwards; idempotent by digest;
   announce-after-indexed (spec §4).
7. **Archive exposure scoping** — public subtree only; opt-in non-localhost bind;
   IP-disclosure copy (spec §6.2).
8. **Port-type home** — the three pipeline-declared ports re-export from binding at
   stage 0; venue-base depends on binding types only (spec §6.1).
9. **Bridge-era documents** — projector synthesizes legacy facts cards under a `legacy`
   derivation annotation; converged-Delivery legacy-evaluator parseability is a stage-1
   fixture (spec §10).
10. **Drain rules** — every retiring flow drains before its swap; stragglers strand loudly
    (spec §10).
11. **venue-base npm posture** — signer-injection only; no keystore or key-loading code
    (spec §6.1, recorded for #2293).
12. **Fresh rewrite, legacy as fixtures** — revert-classification tables, nonce/eviction
    scenarios, RPC chunking rules enter kits as test cases, never as ported code (spec
    §6.6).

## 7. Follow-ups registry (recorded once; none block the program)

From spec §12: marketplace-surfaces hand-off (public work client, `sdk` remainder, #2296,
DevX); plugin-session hand-off (`core`/`layer`/`plugin`, plugin-content CLI); the
bridge-retirement chore (filed at stage 5); the discovery §9.4 dated addendum (SSE — file
with stage 0's transport-http train); guard coverage #2299 satisfied for touched trees.

## 8. Out of scope

Everything the spec's §11 names: no operator-app redesign, no public work-client package,
no `sdk` retirement beyond the daemon's own consumption, no `core`/`layer`/`plugin`
disposition, no earning recomposition, no config hot reload, no new protocol semantics, no
mainnet decisions. Additionally: the npm publish path (#2293) is program-adjacent, not
program work.
