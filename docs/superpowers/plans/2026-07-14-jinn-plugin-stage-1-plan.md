# Jinn Plugin Stage 1 — Decomposition, Acceptance Gate, and GitHub Coordination Plan

- **Date:** 2026-07-14 (planning session)
- **Parents:** `docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-product-design.md` (approved),
  `docs/superpowers/specs/2026-07-14-jinn-plugin-stage-1-package-architecture.md` (approved),
  PR #1651 roadmap (**unmerged — named blocker**).
- **Status:** issue drafts pending human approval; nothing filed yet.

## 1. Work packages

Conventions: all implementation PRs target `next` (stacked PRs name their base). "Blocked on"
values are the Project-field values to set at filing. Uncertain file paths are marked
`(estimated)`. Existing issues are **adopted**, not duplicated.

### S1-P — Parent tracking issue (new)

- **Title:** Jinn Plugin Stage 1 — complete connected product (tracking)
- **Type:** `feat` · **Blocked on:** Another issue (PR #1651 + the Stage 1 planning-docs PR) ·
  **Effort:** High · **Priority:** P1
- **Context.** Tracking issue for Stage 1 of the Jinn Plugin product lifecycle
  (`docs/superpowers/specs/2026-07-14-jinn-plugin-product-roadmap-design.md`, PR #1651): assemble
  the existing Hermes-plugin, corpus, capture, distillation, task-mint, and history capabilities
  into one coherent product with an enforceable package boundary and reusable evidence. Product
  design + package architecture are committed as sibling specs (2026-07-14).
- **Impact.** The Stage 1 gate: a person can use Jinn for real OSS work, receive shared
  knowledge, understand what Jinn did, and contribute an eligible learning signal, while evidence
  stays reusable.
- **Acceptance criteria.**
  - [ ] All child issues closed.
  - [ ] S1-G1 acceptance harness passes on stock upstream Hermes.
  - [ ] Gate review recorded (proceed / iterate / stop) on this issue.
- **Children (sub-issues):** S1-F1, S1-F2, S1-E1, S1-E2, S1-A1, S1-B1, S1-C1, S1-C2, S1-D1,
  S1-F3, S1-H1, S1-G1 + adopted #1473.
- **Adjacent (tracked elsewhere, listed for visibility):** #1486 stack (rung-1 distillation,
  incl. #1553/PR #1554 gate fix), #1437 (consent-link 404), #1380 (superseded by S1-E2 — close
  with it), #1379 (corpus display), #1376/#1342 (seeds), #1058 (search relevance), #1561
  (distiller kill-test), #1647/#1640 (task-creator substrate).

### S1-F1 — Foundation: `@jinn-network/plugin` package (contracts, kit, enforcement, CI)

- **Type:** `feat` · **Blocked on:** Another issue (PR #1651, planning-docs PR) · **Effort:**
  High · **Priority:** P1 · **Branch:** `feat/plugin-foundation` · **Base:** `next`
- **Context.** Stage 1 requires a first-class product package. Create `packages/plugin`
  (`@jinn-network/plugin`, private, own yarn project) per the package-architecture spec §2–§8:
  the five ports (Corpus, Evidence, Contribution, LocalLearning, Skills), product schemas
  (`EpisodeV1`, `KnowledgeHit`, `EligibilityVerdict`, `SessionSummary`, `HistoryEntry`),
  `createJinnPlugin` + `PluginSession` skeleton, `./testing` in-memory adapters + per-port
  contract-test kits, forbidden-import architecture tests, and a paths-filtered CI workflow.
- **Impact.** The shared foundation every Stage 1 lane builds against; the boundary that keeps
  the product from dissolving into the monorepo.
- **Acceptance criteria.**
  - [ ] `yarn build && yarn typecheck && yarn test` pass inside `packages/plugin` standalone.
  - [ ] Public entry exports ports/schemas/factory; `./testing` exports in-memory adapters and
        contract kits; no other subpath imports resolve for consumers (reverse architecture test).
  - [ ] The architecture test fails on a canary forbidden import (demonstrated in test).
  - [ ] New CI workflow triggers on `packages/plugin/**` and is green.
  - [ ] `createJinnPlugin` with in-memory adapters completes a session→end smoke returning an
        `EpisodeV1`.
- **Files/components.** `packages/plugin/**` (new), `.github/workflows/plugin-ci.yml` (new).
- **Base / stacking.** None — independent of all in-flight work. `Blocked on: Another issue`
  (#1651 + planning-docs PR).
- **Interfaces produced:** the five ports, product schemas, testing kit. **Consumed:** none.
- **Parallel:** no (single owner; the shared-contract exception).
- **Tests:** package unit tests + architecture tests + CI.

### S1-F2 — Core workflow (pickup policy, episode assembly, eligibility, summary, history)

- **Type:** `feat` · **Blocked on:** Another issue (S1-F1) · **Effort:** High · **Priority:** P1
  · **Branch:** `feat/plugin-core-workflow` · **Base:** stacks on `feat/plugin-foundation`
- **Context.** Implement the product workflow in the core on in-memory adapters: first-turn
  pickup policy (ported from `apps/jinn-agent/plugins/jinn/pickup.py` — tier-gated adopt vs
  suggest, term derivation), session event intake, session-end `EpisodeV1` assembly, cheap
  eligibility candidate-verdict (public-repo/diff/consent inputs), `SessionSummary` composition
  (incl. explicit nothing-found), and derived `history()`/`explain()`.
- **Impact.** Product decisions move into the core (architecture §10); every surface lane
  consumes these results.
- **Acceptance criteria.**
  - [ ] `firstTurnPickup` returns suggestions/context per product design §4.2, with pickup-policy
        parity tests ported from the Python behavior.
  - [ ] `end()` returns a complete `EpisodeV1` (all turns, loadout, tokens-when-provided,
        retention field) + eligibility verdict + summary; nothing-found summary is explicit.
  - [ ] `history()` output is reproducible purely from port reads (delete any cache → identical).
  - [ ] All tests run with in-memory adapters only; no `node:fs`/network in `src/`.
- **Files/components.** `packages/plugin/src/**`.
- **Base / stacking.** Stacks on S1-F1 (`feat/plugin-foundation`). `Blocked on: Another issue`.
- **Parallel:** no (same owner as F1).

### S1-E1 — Adapter shims in harness-layer (five ports over existing machinery)

- **Type:** `feat` · **Blocked on:** Another issue (S1-F1) · **Effort:** Medium · **Priority:**
  P1 · **Branch:** `feat/plugin-adapters` · **Base:** `next` (after F1 merges)
- **Context.** Additive shims in `client/packages/harness-layer/src/adapters/` `(estimated)`
  implementing the ports over existing modules: consume.ts (Corpus), captures-dir store
  (Evidence, incl. legacy `CapturedTask` reads + `EpisodeV1` writes), mineable-trace store +
  mint pool read + ledger (Contribution), distiller pipeline (LocalLearning), skills install
  (Skills). Each adapter passes its contract kit with network mocked.
- **Impact.** Connects the core to real infrastructure without moving files; direction:
  harness-layer imports plugin contracts.
- **Acceptance criteria.**
  - [ ] All five adapters pass their `@jinn-network/plugin/testing` contract kits in
        harness-layer's vitest suite.
  - [ ] Evidence adapter reads legacy captures and writes `EpisodeV1` (round-trip test).
  - [ ] Existing harness-layer tests remain green (no behavior change to existing modules).
- **Files/components.** `client/packages/harness-layer/src/adapters/**` (new) `(estimated)`,
  `client/package.json` (portal dep on `@jinn-network/plugin` + build-first wiring).
- **Base / stacking.** Requires S1-F1 merged; otherwise independent. Coordinate merge order with
  the open distill PR stack (#1543–#1554) — additive files, low collision.
- **Parallel:** yes, with S1-A1/#1473/S1-C1.

### S1-E2 — CLI process API + contract handshake; Python adapter switch

- **Type:** `feat` · **Blocked on:** Another issue (S1-F2, S1-E1; sequence after the distill
  stack merges — shared `cli.ts`) · **Effort:** Medium · **Priority:** P1 · **Branch:**
  `feat/plugin-process-api` · **Base:** `next` (after F2+E1 merge)
- **Context.** Wire the composition root: `jinn-layer contract --json` (contractVersion),
  `jinn-layer session pickup`, `jinn-layer session end` driving the core with real adapters;
  JSON status envelopes (exit 0 on product-level failure). Switch the Python adapter:
  `pickup.py` delegates policy to `session pickup`; `_on_session_end` posts buffered events to
  `session end`; add the handshake check with instructive degrade.
- **Impact.** The cross-language product contract; closes the #1380 skew class (close #1380 with
  this).
- **Acceptance criteria.**
  - [ ] Handshake: version match proceeds; mismatch degrades with an instructive message (tests
        both sides).
  - [ ] Python retrieval-policy code is removed; `session pickup` verb owns the decision;
        behavior parity test (same fixture → same suggestions as pre-switch).
  - [ ] `session end` returns episodeRef/eligibility/summary consumed by Python; existing
        session-end lines behavior-parity.
  - [ ] Cold-stock e2e (`apps/jinn-agent/scripts/cold-stock-e2e.sh`) passes.
- **Files/components.** `client/packages/harness-layer/src/{cli.ts,bin/**}`,
  `apps/jinn-agent/plugins/jinn/{pickup.py,__init__.py,jinn_layer.py}` + tests.
- **Base / stacking.** After S1-F2 + S1-E1 land; rebase over the distill stack (`cli.ts`).
- **Parallel:** no (touches the shared CLI + Python surface).

### S1-A1 — Hermes adapter: complete trajectory capture

- **Type:** `feat` · **Blocked on:** Another issue (S1-F1 for `EpisodeV1`; serialize after
  S1-C1 on the `__init__.py` surface) · **Effort:** Medium · **Priority:** P1 · **Branch:**
  `feat/hermes-complete-trajectory` · **Base:** `next`
- **Context.** The capture buffer records only the first user message + tool calls. Subscribe
  `post_llm_call` (exists in Hermes `VALID_HOOKS`) and record all user turns so the episode
  carries the full trajectory; record skills loadout and token usage (when the host provides it
  `(estimated)`) in `environment`/`cost`; stamp the per-record retention field; write `EpisodeV1`.
- **Impact.** Product design P5/§4.3 — the durable evidence later stages reuse.
- **Acceptance criteria.**
  - [ ] Driving the hooks in tests yields an episode with all user turns, assistant turns, and
        tool calls in order.
  - [ ] `environment` includes the skills loadout; `cost.tokens` populated when the host reports
        usage.
  - [ ] Episode written as `EpisodeV1`; the distiller still reads legacy captures (compat test).
  - [ ] Absent consent/opt-in, the buffer remains in-memory only (existing gating tests stay
        green).
- **Files/components.** `apps/jinn-agent/plugins/jinn/{capture_buffer.py,distill.py,__init__.py}`,
  `apps/jinn-agent/tests/plugins/**`.
- **Base / stacking.** Requires S1-F1 (schema). Serialize after S1-C1 (shared `__init__.py`).

### S1-B1 — Legibility surfaces (point-of-use marker, session summary, /jinn session) — `human-surface`

- **Type:** `feat` · **Blocked on:** Another issue (S1-E2) · **Effort:** Medium · **Priority:**
  P1 · **Branch:** `feat/jinn-legibility-surfaces` · **Base:** `next` (after E2)
- **Context.** Today the `◇ corpus` marker fires only on auto-adopt (dormant) — there is no
  "what Jinn did" moment. Render the point-of-use marker on *suggestions*, the session-end Jinn
  summary (from `session end`'s `SessionSummary`, incl. explicit nothing-found), and `/jinn
  session` for on-demand current-session activity.
- **Impact.** Stage 1 journey step 4: the user understands what Jinn contributed.
- **Acceptance criteria.**
  - [ ] A pickup with suggestions emits the point-of-use marker (test).
  - [ ] Session end prints the Jinn summary; nothing-found case explicit.
  - [ ] `/jinn session` renders current-session activity.
  - [ ] Plugin disabled → zero Jinn output (test).
- **Files/components.** `apps/jinn-agent/plugins/jinn/{__init__.py,style.py}` + new module
  `(estimated)`, tests.
- **Human-surface block.** Surface: jinn-agent TUI (session chrome + `/jinn` actions).
  Domain-model delta: product design §4.2 "Legibility" (new state message: session summary; new
  action: `/jinn session`). Design artifact: copy table in this issue (text TUI; no visual
  design). Existing-user impact: additive lines, no comms needed.

### S1-C1 — Re-land session-echo mining + consent tiers (#1646 scope)

- **Type:** `feat` · **Blocked on:** Nothing (base is merged #1485 on `next`) · **Effort:** High
  · **Priority:** P1 · **Branch:** `feat/session-echo-reland` · **Base:** `next`
- **Context.** PR #1646 (session-echo real-usage mining + v0 loop closure) closed 2026-07-14
  pending rebase after #1485 merged. Re-land its scope on `next`: `MineableTraceStore` (five-field
  contract, tier-1 fail-closed), producers (engine + jinn-agent onboarding both consent tiers,
  tier-2 skipped when tier-1 declined), session-echo miner (accepted diff at true `repo@commit`,
  blinded provenance, per-record publish gate, empirical F2P/P2P, dead-mint rejection, claim
  filters), `harvest.sources` config, marketplace-leg e2e — reconciling the loop-registry
  divergence noted on #1646. Include the #1649 fix (loud warning when `sources:['sessions']`
  lacks consent).
- **Impact.** The Stage 1 contribution lane (product design P3/P4); without it the gate signal
  does not exist.
- **Acceptance criteria.** (inherited from #1646, plus)
  - [ ] Tier-1 refused append performs zero I/O; tier-2 skipped entirely when tier-1 declined.
  - [ ] Session-echo mint carries lineage hash only (sourceId never leaves the machine) (test).
  - [ ] `yarn e2e:task-creator` passes twice against an Anvil fork.
  - [ ] `harvest.sources: ['sessions']` without consent logs a loud boot warning (closes #1649).
  - [ ] Loop-registry divergence resolved (8-loop `LOOP_REGISTRY` vs 9-loop `LOOP_NAMES`) with a
        test.
- **Files/components.** per #1646: `client/src/task-creator/**`, `client/src/daemon/**`,
  `apps/jinn-agent/plugins/jinn/onboarding.py` `(estimated paths — recover from the closed PR
  branch)`.
- **Human-surface note.** Tier-2 consent prompt copy needs human sign-off (#1646 flagged it) —
  carry the `human-surface` label; domain-model delta = product design §4.1 consent; design
  artifact = prompt copy in the issue.
- **Owner note.** Oak authored #1646; offer him first refusal, else an agent re-lands with his
  review.

### S1-C2 — Contribution inspection surfaces (history entries, first-publish preview, veto)

- **Type:** `feat` · **Blocked on:** Another issue (S1-C1, S1-E1) · **Effort:** Medium ·
  **Priority:** P1 · **Branch:** `feat/contribution-inspection` · **Base:** `next`
- **Context.** Product design P4: contribution is silent but inspectable. Wire ContributionPort
  reads into history/explain; one-time first-publish preview for mints; `/jinn veto` covers the
  current session's mineable record; honest queued-vs-published status when the sidecar is
  absent.
- **Acceptance criteria.**
  - [ ] History shows mint entries with recorded/minted/queued/published states from the pool.
  - [ ] First mint publication is preceded by a one-time preview; subsequent mints are silent
        (test).
  - [ ] `/jinn veto` withholds the current session's mineable record (test).
  - [ ] Sidecar absent → status reads `queued`, no error (test).
- **Files/components.** `client/packages/harness-layer/src/adapters/**`,
  `apps/jinn-agent/plugins/jinn/**` `(estimated)`.

### S1-D1 — History surface (`jinn-layer history` + `/jinn history`) — `human-surface`

- **Type:** `feat` · **Blocked on:** Another issue (S1-F2, S1-E1) · **Effort:** Medium ·
  **Priority:** P1 · **Branch:** `feat/jinn-history` · **Base:** `next`
- **Context.** No per-user cross-session history exists (everything is operator/Safe-scoped).
  Surface the core's derived history: per session — task summary, knowledge surfaced/used,
  capture status, eligibility verdict, contribution state, distilled skills.
- **Acceptance criteria.**
  - [ ] `jinn-layer history --json` lists sessions with those fields from real stores.
  - [ ] `/jinn history` renders it; empty state is explicit.
  - [ ] Contribution data absent (pre-C2) → field shows `unavailable`, no error.
- **Files/components.** `client/packages/harness-layer/src/cli.ts` (verb),
  `apps/jinn-agent/plugins/jinn/**`, core `history()` from S1-F2.
- **Human-surface block.** Surface: jinn-agent TUI (`/jinn history` new action). Delta: product
  design §4.5. Design artifact: column/format table in the issue. Impact: additive.

### #1473 (adopted) — Marketplace transcript typed + discoverable

- **Type:** `design`→`feat` (DR resolves the span-enum vs `agent-transcript.v1` fork first — the
  issue's own AC) · **Blocked on:** Nothing · **Effort:** High · **Priority:** P1 · **Branch:**
  `feat/1473-typed-solve-transcript` · **Base:** `next`
- Stage 1 addition to its ACs: fresh attempts on minted tasks carry the typed transcript
  (product design §6). Recommendation into the DR: the artifact route.

### S1-F3 — CI hardening: plugin tests in mono CI + cold-stock e2e job

- **Type:** `test` · **Blocked on:** Nothing · **Effort:** Low · **Priority:** P1 · **Branch:**
  `test/jinn-agent-plugin-ci` · **Base:** `next`
- **Context.** `jinn-agent-ci.yml` runs only `tests/hermes_cli` + `tests/dehermes`; the 18
  `tests/plugins/test_jinn_*.py` files never run in mono CI; the cold-stock e2e is manual.
- **Acceptance criteria.**
  - [ ] PRs touching `apps/jinn-agent/**` run `tests/plugins/` in CI.
  - [ ] Cold-stock e2e runs on `workflow_dispatch` + nightly schedule (non-required check —
        network-dependent).
- **Files/components.** `.github/workflows/jinn-agent-ci.yml`.

### S1-H1 — Spec amendment: consent defaults + Stage 1 contribution lane

- **Type:** `docs` · **Blocked on:** Another issue (PR #1651 merge) · **Effort:** Low ·
  **Priority:** P2 · **Branch:** `docs/harness-network-consent-amendment` · **Base:** `next`
- **Acceptance criteria.**
  - [ ] `spec/2026-07-02-jinn-harness-network.md` D3 records decline-default + review-first per
        product design P7, and notes the Stage 1 gate lane is the task mint (P3), citing the
        Stage 1 product design.

### S1-G1 — Stage 1 acceptance harness (the gate)

- **Type:** `test` · **Blocked on:** Another issue (S1-A1, S1-B1, S1-C2, S1-D1, S1-E2) ·
  **Effort:** High · **Priority:** P1 · **Branch:** `test/stage1-acceptance` · **Base:** `next`
- **Context.** One journey proving Stage 1 completeness (§2 below). Extends the cold-stock-e2e
  pattern into the full product journey with fixtures.
- **Acceptance criteria.** The §2 assertion list, each as a binary test, green in CI
  (`workflow_dispatch` + nightly; hermetic parts on PR).

## 2. Acceptance gate definition (Phase 5)

**Environment.** CI-able script extending `apps/jinn-agent/scripts/cold-stock-e2e.sh`: venv with
**real upstream Hermes** (pinned commit) + the plugin pip-installed from the tree; **real**
`jinn-layer` built from the tree; temp `$HERMES_HOME`; programmatic hook driving (the
`test_jinn_distill_tee.py` pattern) plus one headless scripted session as smoke.

**Fixtures.** Local corpus fixture (static discovery endpoint + 2–3 artifacts incl. one skill
relevant to the scripted task); a tiny public OSS repo at a pinned commit + scripted accepted
diff (the mineable session); a private-repo variant (ineligibility); seeded-secrets fixture
(scrub assertion, reused).

**Faked:** indexer (fixture server), IPFS (local content store), chain anchoring (stub), sidecar
mint validation (stub validator transitioning pool entries; a separate optional job runs real
Docker echo-validation on ubuntu). **Real (required):** stock Hermes host, the Python plugin,
`@jinn-network/plugin` core, `jinn-layer` CLI + adapters (pointed at fixtures), on-disk evidence
store.

**Assertions (product proof):**
1. Plugin enables on stock Hermes (register wires hooks/tools/commands).
2. An ordinary session runs — no Jinn-specific task format.
3. The fixture skill is retrieved and surfaced (suggestion present).
4. The knowledge reaches the agent (context block injected into the turn).
5. Work completes; session ends normally.
6. The stored episode is a complete `EpisodeV1`: all user turns, assistant turns, tool calls,
   loadout, retention field (tokens when host reports usage).
7. The point-of-use marker fired and the session summary states what was surfaced (and the
   nothing-found variant states that).
8. Eligibility: public-repo session → eligible; private-repo variant → ineligible.
9. Consent honored: tier-1 off → no mineable record; tier-2 off → recorded, never published.
10. Private material local: with consent off, zero outbound publish calls (network spy).
11. Approved path: tier-2 on → mint appears in the pool and transitions via the stub sidecar
    (queued→published), visible in history/ledger.
12. The session appears in `/jinn history` with knowledge/capture/contribution fields.
13. Disable/uninstall → hooks unregistered, zero Jinn output, host session works (stock parity).

**Failure-path assertions:** corpus fixture down → pickup degrades open, session completes;
`jinn-layer` missing → instructive error, host unaffected; contract-version mismatch →
instructive degrade.

**Boundary.** This gate proves the lifecycle exists and coheres. It makes **no** claim that
retrieved knowledge improves task quality — efficacy is the harness-network capability gate
(spec §8) and the #1561-style evals, later.

## 3. Dependency DAG

```
PR #1651 ──┐
planning-docs PR ──┴─→ S1-P (tracking) ─ gates S1-F1, S1-H1
Wave 0 (parallel, start now):   S1-F3   #1473(DR→impl)   S1-C1   [S1-H1 after #1651]
Wave 1:                         S1-F1  (single owner)
Wave 2 (parallel):              S1-F2 (stacks on F1)     S1-E1 (after F1)
Wave 3 (parallel):              S1-A1 (after F1, after C1 on __init__.py)   S1-D1 (after F2+E1)
Wave 4 (serial-ish):            S1-E2 (after F2+E1+distill stack)   S1-C2 (after C1+E1)
Wave 5:                         S1-B1 (after E2)  →  S1-G1 (after A1,B1,C2,D1,E2)
```

Contention rules: `packages/plugin` contracts are owned by the F1/F2 owner — no other agent
edits them (changes go through that owner or a named stacked PR). The Python plugin surface
(`plugins/jinn/__init__.py`) serializes C1 → A1 → E2 → B1. `harness-layer/cli.ts` serializes
distill-stack → E2 → D1-verb (D1's verb may stack on E2 if timing collides).

## 4. Execution waves and agent assignment

| Wave | Issues | Agent (suggested) | Notes |
|---|---|---|---|
| 0 | S1-F3 | agent-infra | independent, immediate |
| 0 | #1473 | agent-evidence | DR first, then impl |
| 0 | S1-C1 | Oak (first refusal) or agent-taskcreator | recover branch `feat/task-creator-remainder` |
| 0* | S1-H1 | agent-infra | after #1651 merges |
| 1 | S1-F1 | agent-foundation | sole owner of contracts |
| 2 | S1-F2 | agent-foundation | stacked PR |
| 2 | S1-E1 | agent-foundation (or handoff w/ review) | after F1 merge |
| 3 | S1-A1 | agent-hermes | after C1 lands |
| 3 | S1-D1 | agent-surfaces | vs in-memory + real reads |
| 4 | S1-E2 | agent-foundation | after distill stack |
| 4 | S1-C2 | agent-taskcreator | after C1+E1 |
| 5 | S1-B1 | agent-hermes | after E2 |
| 5 | S1-G1 | agent-acceptance | the gate |

Conservative parallelism: ≤3 concurrent implementation agents; one PR per issue; stacked PRs
only F1→F2 (and optionally E2→B1/D1-verb if timing forces it, each naming its base).

## 5. Branch / base table

| Issue | Branch | PR base |
|---|---|---|
| S1-F1 | `feat/plugin-foundation` | `next` |
| S1-F2 | `feat/plugin-core-workflow` | `feat/plugin-foundation` (stacked) |
| S1-E1 | `feat/plugin-adapters` | `next` (after F1 merge) |
| S1-E2 | `feat/plugin-process-api` | `next` (after F2+E1) |
| S1-A1 | `feat/hermes-complete-trajectory` | `next` |
| S1-B1 | `feat/jinn-legibility-surfaces` | `next` (after E2) |
| S1-C1 | `feat/session-echo-reland` | `next` |
| S1-C2 | `feat/contribution-inspection` | `next` |
| S1-D1 | `feat/jinn-history` | `next` |
| #1473 | `feat/1473-typed-solve-transcript` | `next` |
| S1-F3 | `test/jinn-agent-plugin-ci` | `next` |
| S1-H1 | `docs/harness-network-consent-amendment` | `next` |
| S1-G1 | `test/stage1-acceptance` | `next` |

## 6. Risks and unresolved decisions

1. **PR #1651 unmerged** — parent + F1 + H1 blocked on it; if it changes materially, the product
   design needs a delta pass.
2. **#1646 recovery** — C1 depends on recovering the closed branch's content; Oak's
   loop-registry reconciliation note is the known divergence. Mitigation: branch still exists on
   the remote.
3. **Distill-stack collisions** — E2/D1 touch `cli.ts`; sequence after #1543–#1554 or stack.
4. **Hermes token-usage availability** — `cost.tokens` depends on what `post_llm_call` exposes
   `(estimated)`; A1 treats it as populate-when-available.
5. **Anemic-core risk** — mitigated by the F2 parity tests (policy genuinely moves) and review
   attention on "decisions in core, adapters mechanical."
6. **TUI human-surface process** — B1/D1/C1 carry `human-surface`; the product design doc serves
   as the domain-model spec for these text surfaces; if the reviewer wants a fuller APP-SPEC for
   the jinn-agent TUI, that is a named follow-up, not a Stage 1 blocker.
7. **Gate hermeticity** — upstream Hermes pin + fixture corpus keep the harness deterministic;
   the real-Docker validation job is optional/nightly to avoid CI flake.

## 7. Recommended first tranche

File everything, then start **Wave 0 + Wave 1 together**: S1-F3 (instant, independent), #1473
field-setting + DR, S1-C1 (longest pole on the contribution lane), and S1-F1 (the foundation,
sole owner). S1-F1 is the recommended first work package overall — everything else converges on
its contracts.
