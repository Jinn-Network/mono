---
version: 1.0
date: 2026-05-28
author: opus + oaksprout
status: proposed
parent-epic: '#601 — EPIC: Demonstrate solver learning'
design-pass: '#689 — design: harness-as-policy learning architecture'
---

# Harness-as-policy learning architecture

The design-pass output for [#689](https://github.com/Jinn-Network/mono/issues/689),
parented to [#601](https://github.com/Jinn-Network/mono/issues/601). This is the
canonical roadmap for how Jinn learns. It consolidates three ratified decision
records into one durable architecture doc and records what has shipped, what is
in flight, and what is deferred — as of 2026-05-28.

This doc does **not** restate the literature survey or the per-level cost
analysis; those are ratified in the DRs below and referenced, not duplicated
(canonical-docs discipline — link, don't redefine).

## 0. The three priors this doc stands on

| Prior | What it ratified | Role here |
|---|---|---|
| [DR-2026-05-26](../log/decisions/2026-05-26-solvernet-learning-investigation.md) | **SolverType plugins describe their domain; they do not own orchestration.** The 7-phase loop lives in the `learner` plugin; domain plugins carry only task shape, output contract, success criteria. | **Architectural prior.** Every level below assumes the loop reaches Improve/Memory. The whole roadmap is moot if a domain plugin terminates the agent before phase 6 — which is exactly the bug #673 fixed. |
| [DR-2026-05-27](../log/decisions/2026-05-27-rl-on-harness-survey.md) | The two-layer taxonomy, a 16-technique prior-art landscape, and the **six-level RL-on-harness ladder** (§4) with per-level cost/work/prior-art. | **The ladder.** §3 below maps the issue's "Phase 3–6" framing onto this ladder. |
| [DR-2026-05-28](../log/decisions/2026-05-28-rl-eval-measurement.md) | The **held-out exam** — a fixed, versioned, replayable task slate run against a frozen checkpoint, before-vs-after, with a confidence interval. Option A (production resolved-rate) kept as the free leading indicator; option C re-homed for non-replayable domains. | **The measurement floor.** Every level ships on hope without it. Tracked under umbrella [#824](https://github.com/Jinn-Network/mono/issues/824). |

## 1. The wager and the taxonomy

**The harness is the policy.** Jinn does not update the foundation model's
weights. It updates the prompts, skills, tool libraries, hooks, retrieval
policies, and memory that surround a frozen model. The relevant prior art is
non-weight self-improvement for LLM-agent systems (Voyager, Reflexion, GEPA,
Darwin Gödel Machine), not classical RL on weights. See DR-2026-05-27 §2 for
the full landscape.

There are **two** RL-tractable layers in Jinn, not three:

1. **Retrieval (RAG).** The agent pulls past artifacts into context via
   `search_records → inspect_record → acquire_artifact`
   ([`client/src/mcp/server.ts`](../client/src/mcp/server.ts)).
2. **Parameters (harness mutations).** The Improve phase's seven-tier action
   surface plus the Memory-consolidation phase's revert/prune semantics
   ([`promoter-prompt.md`](../client/plugins/learner/skills/learn/promoter-prompt.md),
   [`consolidator-prompt.md`](../client/plugins/learner/skills/learn/consolidator-prompt.md)).

A third theoretical layer — **LLM weight updates** — is out of reach until Jinn
self-hosts an open-weight model. It is the horizon (Level 5), not a current
surface.

### 1.1 Why cross-operator and self collapse into one layer

The issue's load-bearing simplification: **cross-operator retrieval is not a
separate mechanism from self-retrieval.** Both pull bytes through the same
`search → inspect → acquire` chain. The only difference is the source:
`local:served:` (own past work) vs `network:envelope:` (other operators'
donations). The agent does not know or care which it acquired — it sees
artifact bytes either way.

Collapsing the distinction matters because it means cross-operator federation
(the issue's "Phase 5") is a **data-density** question — are there donations to
retrieve? — not an architecture question. The retrieval mechanism that works
intra-operator works cross-operator unchanged the moment the corpus is dense
enough and discovery is wired (the Hermes discovery bug
[#666](https://github.com/Jinn-Network/mono/issues/666) is exactly a
cross-operator retrieval that silently fails). DR-2026-05-26 §F2/§F3 confirmed
this empirically: 100% of acquires hit the operator's own past work today,
purely because the cross-operator pool is thin (2 active publishers), not
because cross-operator retrieval is a different code path.

## 2. The action surface (seven tiers) and why it is under-used

The Improve phase's promoter subagent has a seven-tier action surface, in
increasing risk order
([`promoter-prompt.md`](../client/plugins/learner/skills/learn/promoter-prompt.md)
§"Action surface"):

| Tier | Mutation | Write target |
|---|---|---|
| 1 | Skill edits | `implStateDir/skills/<name>/SKILL.md` |
| 2 | Hook edits | `implStateDir/hooks/*.sh` |
| 3 | Tool-config edits | `implStateDir/configs/<name>.json` |
| 4 | New skills / hooks / configs | new files under `implStateDir/` |
| 5 | New tool source | `implStateDir/tools/<name>/` |
| 6 | Operator-access requests | `workingDir/.operator-requests/<name>.json` |
| 7 | Harness install patches | policy-gated; on Claude Code emits a request instead |

**The empirical occupancy gap.** Per DR-2026-05-26 §F5 and DR-2026-05-27 §1.5:
the only working learning case at survey time
(`claude-code-learner/prediction_v1`, nine Improve commits) exercised **only the
lowest-risk tier** — markdown in `plans/`, `runs/`, `strategies/`. No skill
edits, no hook changes, no new tools, despite the surface allowing all of them.
The substrate is wide; usage is shallow.

**Why.** A markdown note is the safest write — it cannot break a future run.
Skill/hook/tool edits change executable behavior and carry rollback risk. The
agent, absent an incentive, rationally defaults to the floor. The design wager
in #689 is that this notes-only rut is a meaningful slice of the 60–70% resolved
plateau (DR-2026-05-26 §Context) — a harness-mutation gap, not a model-capability
gap.

**The fix that shipped** ([#765](https://github.com/Jinn-Network/mono/issues/765),
now in `promoter-prompt.md` §"Prefer harness mutations over notes-only"): a
Voyager-style nudge that instructs the promoter to default to the lowest tier
that *actually changes future behavior* (skill → hook → config → new artifact →
new tool) and treat notes-only as a last resort, with a recommendation→tier
routing table and a worked skill-edit example. Whether it shifts occupancy off
the floor is an empirical question the measurement floor (§4) must answer.

## 3. The roadmap: reconciling "Phase 3–6" with the ladder

The issue framed the work as Phases 3–6. The DR-2026-05-27 survey reframed it as
a six-level algorithm-family ladder (L0–L5), because the cleaner structure is
"hill climbing on the harness, then each level fixing one of hill climbing's
known weaknesses." Both taxonomies are valid; this is the reconciliation.

| Issue phase | Ladder level(s) | One-line | Status (2026-05-28) |
|---|---|---|---|
| (baseline) | **L0** — RL-shaped memory | Revert on Debrief's qualitative trend signal. Reflexion-shaped, not statistical. | **Shipped** (production) |
| **Phase 3** — selection-on-reward | **L1** — per-codeDigest aggregate selection-on-reward | First *quantitative* reward into the loop. Consolidator queries the verdict↔codeDigest join, reverts commits statistically associated with worse pass rate. Hill climbing on the harness. | **Shipped** — [#763](https://github.com/Jinn-Network/mono/issues/763) + [#764](https://github.com/Jinn-Network/mono/issues/764) + [#765](https://github.com/Jinn-Network/mono/issues/765) |
| Phase 3 (hardening) | **L2** — controlled per-commit ablation | Deliberately run K samples from sha_n vs sha_{n−1} instead of observational comparison. `jinn ablate <sha> --samples K`. | **Deferred** — gated on L1 evidence |
| **Phase 4** — parameter-space expansion | promoter nudge (L1's 3rd arm) + **L3a** retrieval-pattern GRPO + **L3b** per-tool-call GRPO/GEPA + Voyager skill-validation + tool synthesis | Push Improve up the action ladder; group-relative advantage to escape local optima; reward-shaped retrieval. | promoter nudge **shipped**; L3a/L3b **deferred** |
| **Phase 5** — cross-operator federation | federated L1 (DR-2026-05-27 §4.8.2) + donation-carries-skills (§4.9 HM) | Operators converge on dominant codeDigests by observing the cross-operator join; donations carry skill edits + tool implementations, not just past patches. | **Scoping only** (this doc) |
| **Phase 6** — open-weight self-host | **L5** — weight updates | Fine-tune on accumulated verdict-attributed trajectories. | **Horizon** — out of reach until Jinn self-hosts |

The crosswalk is not 1:1 and that is the point: the issue's "Phase 3" splits
into the L1 mechanism (shipped) and its L2 hardening (deferred); "Phase 4"
bundles three distinct ladder moves of different cost. Use the ladder (L0–L5) as
the canonical reference going forward; the phase numbers survive only as the
issue's original framing.

### 3.1 The deeper structure

L1 is **hill climbing on the harness**: the promoter proposes a neighbour (one
Improve commit), the consolidator evaluates and reverts if pass rate did not
improve. Greedy, single-trajectory, local. **Plateau on some SolverNets is
expected, not a bug** — it is the known characteristic of greedy local search,
and it is the signal to climb:

- **L2** turns observational hill climbing into controlled per-step experiments
  (disambiguates a genuine local optimum from a noisy denominator).
- **L3a/L3b** introduce a group baseline (`advantage = score − group_mean`) —
  the first escape from the local-optima trap.
- **L4** supplies step-level credit (finer gradient signal).
- **L5** moves from harness parameters to weight gradients.

This is a canonical algorithm-family progression, not an ad-hoc list. GEPA
(DR-2026-05-27 §2.15) frames its own contribution as defeating "the local-optima
problem that plagues greedy prompt search" — and greedy prompt search *is* hill
climbing on prompts.

## 4. The measurement floor (gates everything)

Per DR-2026-05-28: every level above L0 produces commits we can *see* but cannot
*attribute* — did the resolved rate rise because the harness learned, or because
the task slate got easier? The answer is a **held-out exam**:

- A fixed, versioned, replayable task slate, held out from the train stream.
- Run against a frozen `implStateDir` checkpoint (the `mode: 'frozen'` contract,
  DR-2026-05-06-c) before and after a training period.
- Compared with a confidence interval. Held-out discipline: measure on tasks the
  agent did **not** train on.
- Option A (production resolved-rate) is kept as the free leading indicator;
  option C is re-homed for non-replayable domains.

**This is the next sprint** (§6). Until #818's `jinn eval` orchestrator lands, L1
ships on the production leading indicator alone — usable, but not honest enough
to gate the K×-cost decision to climb to L2+.

Measurement protocol for the near-term experiments (§5) is: **prefer the held-out
exam (#818) once it lands; degrade to the production resolved-rate leading
indicator (option A) until then.** The train-arm slope on the held-out slate
([#822](https://github.com/Jinn-Network/mono/issues/822), successor to the now-closed
#683) is the in-repo dual of the indexer's learning curve.

## 5. Near-term experiments and their measurement

The four experiments the issue named, with current status and measurement
protocol:

1. **Promoter-prompt nudge toward higher tiers** — **shipped** ([#765](https://github.com/Jinn-Network/mono/issues/765)).
   *Measurement:* occupancy of tiers 1–5 in `implStateDir` git logs across runs,
   before vs after the nudge; resolved-rate via held-out exam (#818) once
   available, production leading indicator until then. **This A/B is now
   collectable and is the first datapoint the §6 sprint should read.**
2. **Reward-attribution wiring (verdict↔span back-join)** — **partially shipped /
   re-scoped.** DR-2026-05-27 §1.3 found the *aggregate* verdict↔codeDigest join
   is already live in the indexer; L1 (#764) consumes it. Per-*span* attribution
   (the issue's original framing) is a Level 3b prerequisite, gated on richer
   solver-side trajectory spans (MCP-server instrumentation **or**
   [#671](https://github.com/Jinn-Network/mono/issues/671) +
   [#672](https://github.com/Jinn-Network/mono/issues/672)). *Measurement:* n/a —
   infrastructure, validated by L3b consuming it.
3. **Selection-on-reward in Memory** — **shipped** ([#764](https://github.com/Jinn-Network/mono/issues/764)).
   Consolidator reads per-codeDigest aggregate reward and reverts commits not
   associated with a pass-rate lift, replacing the coarse Debrief-trend-only
   trigger. *Measurement:* revert-decision precision — do reverted commits
   correlate with genuinely worse held-out performance? Needs #818.
4. **Reward-shaped retrieval** — **deferred** (L3a). Replace name-similarity
   ranking in `handleSearchRecords` with empirical-reward ranking (donations
   weighted by downstream PASS correlation). *Measurement:* held-out exam
   comparing name-ranked vs reward-ranked retrieval; requires L1 substrate to
   supply the reward attribution and a denser corpus to rank over.

## 6. The concrete next sprint

**Ship the measurement floor — umbrella [#824](https://github.com/Jinn-Network/mono/issues/824),
children [#817](https://github.com/Jinn-Network/mono/issues/817)–[#822](https://github.com/Jinn-Network/mono/issues/822).**
The shape is settled (DR-2026-05-28); execution is the work. Ordered by
honesty-per-dollar:

- **#817** — held-out task slate primitive (`chore`)
- **#818** — `jinn eval` orchestrator, on-demand held-out eval (`feat`) — **the
  load-bearing deliverable**
- **#819** — Tier-1 CI smoke (`test`)
- **#820** — checkpoint-vs-checkpoint held-out view in the explorer (`feat`)
- **#821** — nightly held-out eval, gated (`chore`)
- **#822** — train-arm slope on the held-out slate (`feat`)

Concurrently, **read the L1 + promoter-nudge signal now available** (experiment 1
above): with #763/#764/#765 shipped, the occupancy A/B and the first
selection-on-reward reverts are already accumulating in production. A short
analysis pass — does occupancy shift off the notes-only floor, do reverts fire,
does the production resolved-rate move — is the experimental input that decides
whether L2 (ablation CLI) is worth its K× cost.

### What to defer, and why

- **L2 (controlled ablation CLI)** — gated on L1 having shown observational
  signal works *and* on #818 making before/after honest. No reason to pay K×
  inference to ablate if the L1 leading indicator is already conclusive.
- **L3a (retrieval-pattern GRPO)** — gated on L2's K-sample regime being shown
  economically acceptable for ≥1 SolverNet (the K× per-task cost is a real
  operator decision needing empirical grounding) and on a denser corpus.
- **L3b (per-tool-call GRPO/GEPA)** — gated on richer solver-side spans (MCP-server
  instrumentation or #671/#672).
- **L4 (process reward model)** — research direction; gated on L3b + sustained
  trajectory volume.
- **L5 (weight updates)** — horizon; gated on open-weight self-host.
- **Filing the whole ladder now** — deliberately not done. L1's empirical signal
  disambiguates which higher level to pursue first; filing them now pre-bakes
  design decisions the evidence will inform (DR-2026-05-27 §5).

## 7. What is NOT engineering

Naming the gap is more Legible than papering over it (BRAND.md). Three forces
that look like they should respond to engineering but do not — and the
engineering gates that depend on them:

- **Donation density is GTM, not code.** Cross-operator federation (Phase 5 / §1.1)
  is a data-density question. DR-2026-05-26 §F3 found **2 active publishers** on
  the network. No retrieval improvement amplifies a corpus that thin. The fix is
  recruiting operators who publish donations — growth work, tracked in growth
  docs, not here. *Engineering gate it blocks:* reward-shaped retrieval (L3a /
  experiment 4) has nothing to rank until the corpus is dense.
- **Task-pool quality is curation, not code.** The held-out exam (§4) is only as
  honest as its task slate. A slate that drifts toward easy instances inflates
  every measurement. Choosing and versioning a representative, stable slate is a
  curation judgment (#817), not an algorithm. *Engineering gate it blocks:* the
  entire measurement floor is untrustworthy if the slate is unrepresentative.
- **Verdict reliability is the eval pipeline, not the learner.** Selection-on-reward
  (L1) reverts on `actualPassed`. If the evaluator's verdict is wrong — the
  on-chain default-to-Pass bug (spec/2026-05-25-demonstrate-solver-learning §P1),
  the launcher counter under-count
  ([#669](https://github.com/Jinn-Network/mono/issues/669)) degrading the
  denominator — the learner hill-climbs on noise. *Engineering gate it blocks:* L1
  precision is bounded by verdict precision; tighten the eval pipeline in parallel.

## 8. Open architectural questions (recorded, not decided)

- **Should the learner plugin be attested in the SolverNet manifest?** Today it is
  harness-internal (loaded by the adapter, not on-chain attested), so envelopes do
  not prove the operator ran with self-improvement (DR-2026-05-26 §F7). Whether
  on-chain attestation of the learning configuration should change is open for
  #601 / mainnet design.
- **`harvest.ts` SolverType-awareness** (`maybeMaterializeSweRebenchPatchPayload`)
  is a latent layering violation on the TypeScript side — the DR-2026-05-26
  principle says SolverType-specific logic belongs in plugins, not the daemon.
  Flagged as a follow-up `refactor`.
- **Multi-operator publish-vs-hoard dynamics.** When does an operator publish vs.
  hoard a skill discovery? No cited prior art addresses Jinn's marketplace dynamic
  (DR-2026-05-27 §7.4). Belongs in Phase 5 scoping, not here.
- **Window-pressure feasibility of higher-tier mutations.** Whether aggressive
  Improve-tier mutations fit within the task window at scale is unverified
  (DR-2026-05-26 caveat 3, DR-2026-05-27 §7.5). L1's instrumentation should
  surface it.

## 9. Status

Proposed. Children for the next sprint are filed under umbrella #824. This doc is
the canonical roadmap reference; the three DRs (§0) remain the point-in-time
decision records it consolidates. Revisit the literature ground (DR-2026-05-27 §7
caveat 1) roughly every six months — the field moves fast.
