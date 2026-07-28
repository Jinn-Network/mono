# Session addendum: extend the stack program with the marketplace binding and benchmarking application

Paste everything below the line into the running stack-implementation session (the Fable
coordinator on `claude/stack-implementation`). It updates the program's ground truth and
extends its scope; it does not interrupt Phase 2.

---

**Ground-truth update.** Since your worktree was cut at `3650ac65e`,
`origin/integration/evidence-v1` has advanced to **`f5602b60b`** — a docs-only delta carrying
two newly approved designs and one amendment:

- `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md` — the chain-venue TEP
  binding over the deployed TaskCoordinator + JinnRouterV3 + OLAS Mech substrate, plus a
  specified contract revision carried as declared impact. Architecture + adversarial reviews
  were run against the deployed contract code; seven deduped blocking findings are resolved in
  the text.
- `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md` v0.3 — four tier-2
  record kinds (Benchmark, Run, Matrix, Report) + one backend-neutral tier-3 application.
  Architecture + adversarial reviews run; five deduped blocking findings resolved.

Your prompt's "Not designed — do NOT plan or implement" list is now stale: the marketplace
binding and the benchmarking application are designed and on the integration branch. Only the
migration-mechanics/operator-daemon-composition session remains pending — update the
pending-design-session ledger accordingly. Also absorb: the #2038 issue tree was swept on
2026-07-28 — #2040/#2041/#2043/#2045 closed as **re-homed** (their capabilities are already
your work items: provisioner loadout materialization, per-attempt isolation +
effective-execution attestation, marketplace posting/escrow, trust-layer evidence
authentication), #2047–#2054 closed as superseded by the benchmarking design, and only
#2044/PR #2219 still runs on `next`. Closed issues are not scope; the specs are the scope.

**What to do, without stopping Phase 2:**

1. **Advance your ground truth.** Fetch; move the session branch's baseline view of
   `integration/evidence-v1` to `f5602b60b` per your train structure (docs-only; no code
   contention with the streams).
2. **Draft two additional component plans** (opus, same discipline, reviewed + fixed per
   rule 5): `marketplace-binding` (from its design — note the two-generation seam: today-mode
   against deployed contracts and revised-mode behind it; "projector #1" now has its design
   and belongs to this plan) and `benchmarking-application` (its §18 holds the internal
   sequence; its §15 the package shape, including the `discovery/facts/benchmarking` leaf).
   Then extend the master program document: new phases appended in dependency order —
   benchmarking records + kit once TEP/profiles sealing lands; the marketplace binding once
   the TEP kit, trust, and discovery serve/client are green; benchmarking run orchestration
   once the backend contract is green; the benchmarking marketplace mode last. **Present the
   program extension at your next phase boundary for my approval; code for the new components
   starts only on my explicit yes.**
3. **Two companion amendments must reach in-flight phases before their surfaces freeze** —
   this is why this addendum arrives now. Record both as dated addenda on the affected plans
   immediately:
   - The benchmarking design declares an additive amendment to the **Submission and Delivery
     facts profiles** (optional namespaced fields `benchrun`/`benchcell`/`bencharm`, declared
     as CloudEvents filter attributes — its §11 and §17.5). Phase 3's discovery/facts work
     must build those facts profiles with these fields from day one, not reopen them later.
   - The marketplace binding declares a **two-party engagement entry** on the
     local-backend/TEP interface — a caller-supplied deterministic Attempt URI, anticipated
     by TEP §9.2 (see the binding's companion-amendment declaration). Phase 4's
     backend-assembly work must include it in the engagement surface, not retrofit it.
4. **Your frozen `deriveAttemptUri` ruling is confirmed load-bearing**: the marketplace
   binding derives the same deterministic Attempt URIs third-party (its §6.2). Its plan must
   consume the protocol package's exported constant — never re-derive the rule.
5. **Still out of scope**: the daemon TaskEngine carve and operator-daemon composition (waits
   on the pending migration-mechanics design session); all tier-4 products (marketplace
   benchmarking service, skill factory, leaderboards, plugin composition); any on-chain
   deployment (the contract-revision code and its kit are in scope for the marketplace plan;
   deploys are a human-gated runbook item, not program work).
