# Stage 2 umbrella plan — three tracks + Stage-1 debt as one program

- **Date:** 2026-07-17
- **Author:** Fable (Stage 2 meta session M); decisions ratified by Ritsu (DR-2026-07-17)
- **Charter:** `log/decisions/2026-07-17-stage2-charter.md` — every scope decision below
  traces to it; this plan adds sequencing, pairing, and verification structure, not new
  decisions.
- **Covers:** roadmap `docs/superpowers/specs/2026-07-14-jinn-plugin-product-roadmap-design.md`
  §Stage 2 (coverage map in §5 below). Specs: A/B/C of 2026-07-17. Execution precedent:
  `docs/superpowers/plans/2026-07-16-jinn-plugin-stage-1-rescope-plan.md` §5/§8.

## 1. Program shape

Three tracks — **A onboarding**, **B corpus supply**, **C architecture** — plus the Stage-1
debt chores run as one program under one tracking issue. **C's refactor spine
(C1→C2→C5→C6→C7→C8) is the declared critical path** (charter Decision 3): the stage's final
verification moment sits behind C6's published `@jinn-network/jinn-layer`. A and B
front-load their mechanism-agnostic work so only ratification waits on the spine.

Stage 2 gate (roadmap sentence, charter reading): users can reliably complete the lifecycle
through the C6-published install, **and the attribution instrument (C12) is live with its
first helped/harmed/no-difference readout produced**.

## 2. Track goals and gates

| Track | Goal | Track gate |
|---|---|---|
| A | One-command install (`hermes plugins install Jinn-Network/jinn-plugin`), zero-consent first run, loud-on-failure doctor, deleted parked surfaces | Four-layer gate per A §3.6; final layer = the shared post-C6 fresh-machine walkthrough (≤5-minute budget), operator-ratified |
| B | Curated, probe-verified retrieval corpus for the named repo (mono); visibility mark + policy-admission hook; schema fields for training consumers on the wire | K=3 marked records for mono, probe-verified; doctor `corpus-content` green on mono; one real session retrieving curated content; #1792 landed |
| C | Package end-state (plugin ← core ← layer; client unchanged shape), evidence contract v1.1 + index, published layer, attribution instrument | Spine complete through C8; reindex+rescue run on the real store; per-package canaries green; C12 first readout produced |

## 3. The issue train (banded)

Unit IDs are the specs' own (A §5, B §13, C §9), reproduced here with charter deltas
applied. File as sub-issues of the Stage 2 tracking issue, Issue Types as shown, board
routing (Blocked on / Effort / Priority) set at filing. **Owner lanes:** every unit enters
the autopilot engine queue except the operator-anchored set parked in the Human lane —
A2 (until un-parked), B3, C12, #1776 — per §10/§11.

### Band 1 — gate-blocking

| Unit | Title (delta from spec, if any) | Shape | Effort | Depends on |
|---|---|---|---|---|
| A2 | Slim-repo release channel + split-and-push on `main` promote *(A1 dependency resolved: no layer artifact inclusion — plugin references the published layer post-C6; repo-based interim)* | chore | Medium | — |
| A3 | Doctor: checks, output contract, session-start loudness, banner | feat | High | — |
| A4 | Delete wizard + consent surfaces; parked status line *(charter Decision 1)* | refactor | Medium | — (pairs with A3) |
| A5 | Layer-side probes: corpus reachability + content-present query *(placement: harness-layer now, pre-C5; the C5 move carries them)* | feat | Medium | A3 (contract), lands before C5 |
| A6 | Cold-stock extension: real install/enable, doctor precondition matrix, real remove | test | Medium | A3+A4 |
| A7 | Published-artifacts smoke workflow (scheduled) *(extends to the C6-published layer once it exists)* | chore | Medium | A2 |
| A8 | Cross-language contract-constant parity test | test | Low | — |
| A9 | Docs: README install story, state-purge, product-design §4.1/§4.8 pointers | docs | Low | A2 |
| B1 | Retrieval-visibility mark: allowlist semantics + pickup enforcement **+ the policy-admission hook** (charter Decision 4) | feat | Medium | — (ships before any bulk derivation) |
| B2 | Seed lane emits the mark; re-publish Stage 1 episodes (supersede unmarked) | feat | Small | #1784, B1 |
| B3 | Curated seed batches **for mono** + per-repo doctor probes *(scope: the charter's named-repo list)* | docs/feat | Medium | #1784, B1 |
| B6 | Native-path tuple fields: `generatorModel`, `distributionClass`, `task.createdAt`, `instanceId` on new solves | feat | Medium | pairs with C11 |
| B9 | Evaluator cost metering (`evaluator_cost_usd`) | chore | Small | — |
| #1792 | Retrieval escalation step 2: content re-scoring (existing issue → required scope, charter Decision 4) | feat | Medium | coordinates with A3 on plugin pickup files |
| C1 | Boundary manifest + extended boundary tests + golden-envelope fixture **(absorbs #1754 as an AC: the client-compat job)** | refactor | Low | — |
| C2 | `packages/core` scaffold: stores move, daemon re-point kills the esbuild artifact | refactor | High | C1 |
| C3 | Evidence contract v1.1 (local-episode deltas; **closes #1799 + #1800**) | feat | Medium | C1; serializes with C2 on `episode.ts` |
| C4 | Machine-local evidence index + `reindex` + store repair/rescue (coordinates with #1811's fix) | feat | Medium | C2 |
| C5 | Move scrub + trajectory + corpus-read into `core` | refactor | High | C2; after A5/B2 land (harness-layer files; B3's fixtures don't block) |
| C6 | `packages/layer` + independent publish **(absorbs A1: plugin↔layer handshake — bin discovery, version pinning, resolution order per A §3.1)** | refactor | High | C5 |
| C7 | Retire Hermes captures tee; distiller reads episodes; slim mineable store | refactor | Medium | C4, C6 |
| C8 | Delete `client/packages/harness-layer`; final consumer sweep | refactor | Low | C6, C7 |
| C9 | Tokens verify (`cost.tokens` actually populated) | fix | Low | — |
| C10 | Test-sandbox enforcement (store env overrides + lint) | test | Low | — |
| C11 | Published-payload unification: `jinn.episode.v1` **(carries B §8.2 deltas 1–6 with B6; owns delta 7, the tier-axis reconciliation)** | refactor | Medium | C3 + B6 (paired) |
| C12 | Marketplace attribution instrument: autoload on/off arms *(charter Decision 2 — required)* | spike | Medium | C3 |
| #1797 | npm-publish path filter + failed-publish root cause (existing; gates real canaries + A7) | chore | — | early, pre-C phase 1 |
| #1784 | Seed-profile scrub for the episode seed lane (existing; gates B2/B3) | fix | — | early |

### Band 2 — trailing (filed now, non-gate-blocking; run on slack)

| Unit | Title | Shape | Effort | Depends on |
|---|---|---|---|---|
| B5 | `manifest:` anchor record type + consumer enumeration + gas measurement | feat | Medium | — |
| B4 | Bridge derivation run v0: paged ledger walk, tuple output, held-out gate, batch manifest | feat | Large | B1, B5 |
| B11 | Retire #1672 backfill lane (keep parsers) | chore | Small | B4 |

### Band 3 — standalone chores (filed/boarded, non-gating)

#1783 (flaky delegate test), #1776 (testnet seed hygiene sweep).

### Deferred (recorded, not filed as Stage 2 issues)

B7 (K>1 group minting), B8 (SWE-rebench source expansion), B10 (dataset-reference
convention + overlap-manifest tooling — revisit when an import actually runs), C13
(interactive holdback — posture decided at the C12 readout review), C14 (feedback verb),
#1342 (bulk skills.sh import — safe as substrate-only whenever taken up).

## 4. The dependency graph (native `blocked_by` edges — dispatcher-enforced)

The rescope's paired trains and convergent-file coordination are expressed here as **native
`blocked_by` edges**, which is what the autopilot dispatcher enforces (it admits an issue
when its edges are satisfied, and can dispatch **stacked on a blocker's open PR branch** —
the paired-train behavior, without a coordinator). Edges are authoritative; the wave sketch
below is their human-readable projection.

**Edge list** (issue ← blockers; roots have none):

- **A track:** A4 ← A3 *(both edit `__init__.py`; A3 first so every merged state keeps a
  complete first-run surface — doctor+banner land before the wizard is deleted)* · A6 ← A3,
  A4 · A7 ← A2 · A9 ← A2 · A5 ← A3 *(implements against the doctor contract)*
- **B track:** B2 ← #1784, B1 · B3 ← #1784, B1 · B4 ← B1, B5 · B11 ← B4
- **C track:** C2 ← C1 · C3 ← C2 *(serializes `episode.ts` / `process-contract.ts` by edge
  rather than by coordination)* · C4 ← C2 · C5 ← C2, A5, B2 *(C5 moves `harness-layer`
  files; the A/B units that edit them land first and the move carries their code)* ·
  C6 ← C5 · C7 ← C4, C6 · C8 ← C6, C7 · C11 ← C3, B6 *(the wire-fields/schema pair — C11
  completes the schema B6 starts)* · C12 ← C3
- **Cross-track:** #1792 ← A4 *(pickup-path files settle after the A-train's plugin churn)*
- **Roots (no edges):** A2, A3, A8, B1, B5, B6, B9, C1, C9, C10, #1797, #1784, #1783, #1776

Notes: A7's acceptance is scoped to the plugin channel; C6's body carries the follow-up to
extend the smoke to the published layer. B3's edge exists but the unit sits in the Human
lane (§11) regardless.

**Wave sketch** (projection of the edges; each merged state independently green; PRs target
`next`; no unit ships partially):

- **Wave 0 (roots):** this docs PR · #1797 · #1784 · C1 · C9 · C10 · #1783 · A3 · A8 · B1 ·
  B5 · B6 · B9
- **Wave 1:** A4 (stacked on A3) · A5 · C2 · A2 (once un-parked, §11)
- **Wave 2:** A6 · B2 · B3 · #1792 · C3 · C4 · A9 · B4
- **Wave 3:** C5 · then C6 (+handshake) · C12 (after C3; Human lane) · C11 · B11
- **Wave 4:** C7 · C8 · A7 · shared walkthrough · track gates · stage close

## 5. Roadmap Stage 2 coverage map

Every roadmap bullet maps to units or a named deferral:

| Roadmap bullet | Covered by |
|---|---|
| Clean, stable plugin–host integration boundary | C1, C2, C5, C6, A3 (contract handshake), A8 |
| Stable canonical evidence contract, local + public | C3, C11 + B6 |
| Unify task/trace/trajectory/snapshot/outcome/contribution concepts | B §4 tuple (ratified frame), C2, C5, C7, C11 |
| Remove accidental storage boundaries | C4 (derived index), C7 (tee retirement, mineable slim) |
| Replace the manual bridges exposed by Stage 1 | C7; B11 (trailing); seed-import idempotency (shipped, R2) |
| Permissions, provenance, fallback legible | A3/A4 (doctor, parked line, empty states), C3 (writer stamps, read-tolerance surfacing), B `distributionClass` |
| Reliable attribution from supplied knowledge to outcomes | C3 (facts) + C12 (instrument); C13/C14 explicitly deferred (charter Decision 2) |
| Measures quality, cost, latency, failure rate | C9 (tokens), B9 (evaluator cost), C3 `activity.*` + `deliveryMode` (delivery/failure), C4 (queryable), B3 probes (supply quality). Scatter judged sufficient; no consolidated instrumentation issue. |

## 6. Field-home mapping (B §8.2 → schema homes)

| B delta | Home |
|---|---|
| 1. F2P/P2P + base commit first-classed on the tuple | B6 (wire emission) + C11 (payload task block) |
| 2. Group fields derivable from record links | C11 (linkage design; bridge already emits `{groupSize, nPass, nFail}`) |
| 3. `generatorModel` (+ honesty flag for history) | B6 + C11 |
| 4. `distributionClass` | B6 + C11 |
| 5. `task.createdAt` | B6 + C11 |
| 6. `instanceId` | B6 + C11 |
| 7. `evidenceTier`/`verifiabilityTier` → one verification-strength axis | **C11** (assigned by charter; was homeless in both specs) |

C3 carries only the local-episode deltas (session.kind/parent, origin/writer stamp,
`repositorySlug`, outcome observables, eligibility/delivery split). The W2 mark rides
record content under B1 now; C11 names the field in the unified schema.

## 7. Doctor placement (A↔C seam, resolved)

| Check | Placement | Unit |
|---|---|---|
| `plugin-build`, `layer-available`, `layer-contract`, `prerequisites` | plugin | A3 |
| `corpus-reachable`, `corpus-content` (runs B's K=3 probe) | layer (harness-layer now; C5 move carries them) | A5 |
| `host-provider` | pointer at `hermes doctor` | A3 |
| readable-episode count (unreadable-record surfacing) | joins the doctor post-C4, from C's index primitive | rider on C4 |

## 8. Operator verification moments

The walkthrough discipline is the gate discipline — Stage 1's thirteen defects were
CI-invisible. Each moment is an explicit tracking-issue checkbox assigned to the operator:

1. **Shared fresh-machine walkthrough (post-C6):** `hermes plugins install` on a clean
   environment, ≤5 minutes to a working session; closes A's layer-4 gate and C's install
   verification in one run.
2. **Corpus moment (post-B3):** doctor `corpus-content` green on mono; a real working
   session in mono retrieves a curated record, visibly attributed.
3. **Data moment (post-C4):** `reindex` + store repair on the operator's real store;
   before/after counts recorded (null-quartet rescue, misnamed files, legacy tagging).
4. **C12 readout review:** reads the first helped/harmed/no-difference readout; triggers
   the committed embeddings design session; decides C13's posture.
5. **Stage close:** proceed/iterate/stop recorded on the tracking issue against the gate
   sentence (§1), rescope-style.

## 9. Debt disposition and housekeeping

| Item | Disposition |
|---|---|
| #1797, #1784 | Band 1, early — typed, prioritized at filing |
| #1754 | Folds into C1 as an acceptance criterion (C1's PR closes it) |
| #1799, #1800 | Closed by C3's PR (design already absorbed) |
| #1811 | Keeps its own fix; C4 coordinates |
| #1783, #1776 | Band 3 standalone |
| #1775 | Close at filing (stale — acceptance satisfied when #1654 closed) |
| #1654 | Comment noting AC3's body checkbox stayed unticked while ratified in comments |
| #1342 | Deferred, recorded in §3 |

## 10. How the tracks run — autopilot-first

The **autopilot dispatcher** (`packages/autopilot`) is the default executor for the train
(operator's call, this session; the rescope's coordinator-session pattern remains the
fallback for anything the engine fumbles — the stuck-escalation lane names those).

- **Eligibility (what the dispatcher enforces, from `ready-filter.ts`):** an issue is
  dispatched when it is triage-complete (Issue Type + Priority set), on the board in
  `Todo`, its author is on the dispatcher allowlist, and its `Blocked on` field admits it —
  `Nothing`, or `Another issue` with every native `blocked_by` edge satisfied. Satisfied
  includes a blocker with an open PR: the dependent dispatches **stacked on the blocker's
  branch**, which is how §4's former paired trains execute without a coordinator.
  Scheduling order: current-sprint membership first, then Priority, then FIFO.
- **Implementer routing:** the `Effort` field (with shape) selects the implementer via
  `implementerRules` — the spine Highs (C2, C5, C6) and A3 should route to the strongest
  configured implementer; Lows route cheap.
- **Review and merge:** engine PRs take independent engine review (`engine:review`); the
  merge sweep auto-merges engine-reviewed, approved, CI-green, **non-code-owned** PRs
  (workflow rule 4 carve-out, #1735). Code-owned paths (`.github/workflows` — A2, A7,
  #1797) and human-surface PRs (doc/spec amendments — A9; walkthrough records; gate
  ratifications) always wait for the operator. Every merged state stays green; PRs target
  `next`; no unit ships partially.
- **The Human lane:** `Blocked on: Human` is an unconditional park — never auto-dispatched.
  Operator-anchored units live there: **A2** (repo creation + push secret are org-admin
  acts; once the slim repo and secret exist, flip to `Nothing` and the workflow half is
  engine work), **B3** (the curation bar is the operator's), **C12** (fleet arms + the
  readout are operator ops; the engine may draft analysis tooling inside the spike),
  **#1776** (testnet publish credentials). B2's code is engine work; its testnet
  re-publish run rides §8's corpus moment. Stuck PRs auto-escalate into this lane — check
  it at each eng-day.
- **Operator as user-tester holds:** §8's verification moments are tracking-issue
  checkboxes assigned to the operator; implementers never self-ratify a walkthrough.
- **Ops notes** (memory-hardened): launch the loop from a worktree under
  `jinn-mono_worktrees/` (not `.claude/worktrees/`); set
  `JINN_DISPATCHER_AUTHOR_ALLOWLIST`; monitor `~/.jinn-client/eng-loop/{sessions,dispatcher.log}`;
  after any dispatcher stop, sweep for stranded local branches (committed work that never
  reached a PR) and recover by push + draft PR.

## 11. Filing checklist (what makes the train autopilot-ready)

1. **Tracking issue** (operator-owned, not in the engine queue) with §8's moments as
   assigned checkboxes; all units below as native sub-issues.
2. **Per issue:** Issue Type per §3's shape column; added to the "Jinn engineering" board;
   Status `Todo`; `Effort` per §3 (it routes the implementer); Priority — **P1**: C1–C8
   spine, A3/A4, B1, #1797, #1784; **P2**: remaining Band 1; **P3**: trailing + standalone.
3. **`Blocked on` must mirror the edges:** `Another issue` on every unit with §4 edges
   (a unit with edges but `Blocked on: Nothing` dispatches prematurely), `Nothing` on §4's
   roots, `Human` on the operator lane (A2, B3, C12, #1776).
4. **Native `blocked_by` edges** exactly per §4's edge list.
5. **Author:** file from an account on `JINN_DISPATCHER_AUTHOR_ALLOWLIST` (empty or
   mismatched allowlist dispatches nothing).
6. **Body shape** (workflow rule 2 — problems, not solutions): context + impact +
   acceptance criteria, plus links to the governing spec sections, the charter decision,
   and this plan; name the convergent files the unit touches and the verification command
   (test scope / cold-stock / e2e) the PR must run. Design content stays in the specs.
7. **Sprint:** §4's wave-0 roots enter the active sprint at filing (sprint membership is
   the dispatcher's top scheduling key); later waves join at Friday triage as edges free
   them.
8. **Housekeeping** per §9: close #1775; comment on #1654 (AC3 box); "closed by C3" note
   on #1799/#1800; "folds into C1" note on #1754.
