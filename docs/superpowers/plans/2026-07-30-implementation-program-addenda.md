# Implementation Program — Coordination Addenda (2026-07-30 planning wave)

Cross-plan rulings and amendments produced while authoring the ten implementation plans
(eight per the operator-daemon composition program §1, plus the stack publish path and the
marketplace-surfaces gated tail). Each ruling is binding on the plans it names; each was
made by the wave coordinator under the designs-are-law discipline — design-level items that
exceed coordinator authority are in the ratification register (§3), not here.

## 1. Amendments to the program plan's §5 cross-plan factory surface (additive)

Settled by the venue-base plan's code audit (its D2/D3/D8/D9/D10/D11), consumed verbatim by
the stage plans:

- `createBaseVenue` is **async**, and its return gains a **`verdict` group** (the daemon
  design §6.1's port enumeration missed the verdict leg entirely: verdict-attempt claim +
  preflight, verdict facts readers, verdict settlement, `releaseVerdict`;
  `SettlementPorts` is solution-scoped by construction).
- `config` gains five additive host-injected keys: `priorityMech`,
  `isAuthorizedMechOrigin`, `pin`, `verifySettlementGrade`, `fetchBytes`.
- `safe` is `VenueSafeBroadcast extends SafeBroadcastPort` with the general surfaces the
  single-broadcaster rule actually requires:
  `broadcastSafeTransaction(input: { to, value, data, logicalTx }): Promise<Hex>` and
  `sendEoaTransaction(input: { to, value, data, logicalTx }): Promise<Hex>` — one lock,
  one submission ledger, one fee-bump machine keyed on the sender EOA;
  `broadcastCreateTask` becomes a caller. Ledger identity is the logical `(to, data)`
  pair (outer `execTransaction` calldata carries a per-attempt signature).
- `observe` is `VenueObservePort extends MarketplaceObservePort` adding
  `listAttemptsForTask(task: SubmissionUri | { taskId: bigint }): Promise<readonly VenueAttemptRef[]>`
  with `VenueAttemptRef = { attempt, taskId, attemptIndex, operator, requestId? }`
  (the requester await surface; the pipeline's `DeliveryWaitPort` is solver-side and
  cannot serve it).
- `claim` narrows to `Pick<ClaimPorts, "claimTask">`.

## 2. Coordinator rulings (recorded once, binding across plans)

1. **Port-type home is a move, not a re-export** (daemon design §6.1's placement note as
   written is impossible — the binding may not import the pipeline): the three
   pipeline-declared port types move to `binding/src/venue-ports.ts`; the pipeline
   re-exports. Same intent, direction flipped.
2. **Kit ownership:** `runServingPlaneConformance` (vector kind `serving-plane`) is born in
   the transport-http plan (phase 0, kit-first); the stage-4 plan **extends** it against
   the live operator surface. One suite; transport-http owns the file.
3. **Detail-code spelling:** `cursor-unknown` (the discovery design's pinned form). The
   composition design §7.3's `unknown-cursor` was a transposition; the stage-4 plan is
   normalized.
4. **Config-backup filename contract:** `config.json.pre-v2.<ISO8601>.bak`,
   permission-preserving; stage 1 writes it, stage 5 prunes by exactly that shape.
5. **`solver-nets` CLI retirement split:** stage 3 retires launcher-side subverbs; stage 4
   retires join / list / doctor with the registry client. *Amended 2026-08-05 per
   DR-2026-08-05: the split dissolves — all `solver-nets` subverbs retire in the one-swap
   train with their machinery.*
6. **Plugin-content CLI re-key** (manifestCid → wiring entries) is stage-1 scope (wiring
   entries are born in its config migration); the deeper disposition stays with the plugin
   session.
7. **`deriveBridgeTask`** is stage-1-owned (pipeline-adjacent bridge module), one shared
   pure function with a cross-operator determinism guarantee; stage 2 consumes it and adds
   the determinism fixture.
8. **Custody guard vs venue-base state stores** (venue-base D1): SQLite via dynamic
   `better-sqlite3` import, no `node:fs`, no `process.env`, host creates the parent
   directory — the tree stays inside the C2 tripwire without an allowlist edit. Follow-up:
   amend the guard's C2 comment to name the exception pattern.
9. **sdk retirement R2 split (R2a/R2b)** — already applied as a dated amendment to the
   marketplace-surfaces design §6 (commit `162315f63`): five SolverNet-era surfaces have
   consumers no cutover stage retires; they re-home on their own schedule.
10. **Fixture-immutability gate staging** (publish-path D9): the offline
    no-mutation/errata check binds from day one at the merge base; the minor-bump-on-
    addition check binds only against packages with a registry `latest` — §8.1's
    immutability governs published identifiers, so pre-publication thrash is out of scope
    by the rule's own terms.

## 3. Operator ratification register (design-level; blocks the affected tasks, not the wave)

| # | Item | Origin | Affected law | Blocked work |
| --- | --- | --- | --- | --- |
| R1 | Evaluator-sealed evaluations cannot execute: `assertSealerRule` forbids all `capabilityGrants`, but the evaluation launcher requires a signer secret-forward. Proposed: admit exactly one declared self-signer grant under `publicSpec`. — **Dissolved 2026-08-05 per [DR-2026-08-05](../../../log/decisions/2026-08-05-cutover-one-swap-collapse.md) decision 9:** the 2026-08-03 host byte-equality reseal removed the sandbox's need for a signer, and the native derivation seals grant-free (`capabilityGrants: {}`). Nothing to ratify. | stage-2 plan, Task 8 | binding design §6.4 (adjacent to frozen interface 8 — the sealer rule) | ~~stage-2 evaluator loop execution~~ (unblocked) |
| R2 | Bridge-era evaluation lacks a subject Submission and admission receipt until stage 3. Proposed third §10 bridge-era rule: deterministic subject-Submission synthesis + a fleet admission-agent receipt, bridge-marked, advisory. Corollary (stage-3 plan): requester-side sealing covers stage-3-posted Submissions only; the evaluator-seals carve-out persists for legacy tasks until they drain. — **Dissolved 2026-08-05 per DR-2026-08-05 decision 9:** the native path acquires real digest-verified subject material, and the one-swap's combined drain empties the legacy-posted set the synthesis existed for (DR decision 4's conditional governs stragglers). Nothing to ratify. | stage-2 plan, Task 7 | daemon design §10 bridge-era rules | ~~stage-2 derivation leg~~ (unblocked) |
| R3 | Archive exposure: the main operator API serves several unauthenticated routes held safe only by the localhost bind, so §6.2's "mount on the operator API" cannot be the public path. Proposed: the separate listener is the ONLY public path (archive routes + catch-all 404); the same-process mount remains localhost-only. — *Ratified in substance 2026-08-04 by DR-2026-08-04-b (headless design §6); the one-swap builds only the separate listener.* | stage-4 plan | daemon design §6.2 / cross-plan contract 7 | stage-4 public exposure tasks |
| R4 | No pure-parse grader family exists: the prediction evaluator must be authored as `deterministic-process` with a meaningless nominal image. Proposed: taxonomy amendment adding a pure-parse family; interim, the prediction spec builder ships in `./testing` only. | evaluator-adapters plan | task profiles / EvaluationSpecs design | cosmetic only (interim shipped) |

## 4. Standing findings routed elsewhere

- `executeSafeTxBatch` bypasses the nonce ledger today — a live instance of the
  #525/#562/#897 class; stage-1 Task 21 closes it (no separate issue needed).
- Pre-existing, out of scope, to file as issues: unauthenticated `POST /api/stop-hook`;
  dead `leaderboard-api.ts`; the benchmarking packed-types guard not covering published
  subpaths; the sdk/client held-out-slate locale-collation recomputation (chip already
  pending).
