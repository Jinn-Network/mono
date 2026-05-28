---
id: DR-2026-05-28
title: Outcome-measurement infrastructure for the harness-RL ladder — the held-out exam
date: 2026-05-28
verb: Steer
status: proposed
authors: opus (spike on exciting-mayer-68adc9 worktree)
spike: issue [#766](https://github.com/Jinn-Network/mono/issues/766)
relates-to: [#689](https://github.com/Jinn-Network/mono/issues/689) (design issue this feeds), [#683](https://github.com/Jinn-Network/mono/issues/683) (multi-task tracker — subsumed here, see §6), [#601](https://github.com/Jinn-Network/mono/issues/601) (parent EPIC), DR-2026-05-06-c (frozen-state contract — the freeze mechanism this builds on), DR-2026-05-27 (the RL ladder this supplies measurement for), [#669](https://github.com/Jinn-Network/mono/issues/669) (launcher under-count — degrades option A)
---

## Context

DR-2026-05-27 ratified a six-level ladder of RL applied to the harness.
Level 1 (per-codeDigest aggregate selection-on-reward) closes the
*mechanism* gap — the daemon will run a quantitative, reward-driven
hill-climbing loop on the harness. But the mechanism running is not the
same as the mechanism *working*. There is no clean way today to answer the
question this spike exists for: **did the training period under Level 1
actually make the agent better, or did it just get lucky?** Every higher
level of the ladder (L2 ablation, L3a/3b GRPO, L4 PRM) needs the same
answer, so this is not a Level-1-only concern — it is the outcome-measurement
substrate the whole ladder stands on.

### The object being measured

The agent is a frozen foundation model plus a mutable harness
(`implStateDir`: skills, hooks, tool configs, notes, strategies). Per
[#689](https://github.com/Jinn-Network/mono/issues/689), **the harness is
the policy**, and `codeDigest` — the content-hash of `implStateDir`
(DR-2026-05-27 §1.3) — is the identity of a policy version. So "did the
training period improve the agent" reduces to: **is `codeDigest_later` a
better policy than `codeDigest_earlier` on the SolverNet's task
distribution?**

### Why that is hard: three confounders

Three independent confounders corrupt the naive answer ("watch the win rate
climb"). They are the lens this DR grades the options against.

1. **Task-selection.** Each `codeDigest` is scored on a *different,
   self-selected* subset of tasks — the operator only claims what is
   available when it is available. `codeDigest_X` was tested on
   `{a,b,c}`; `codeDigest_Y` on `{d,e,f}`. If `{d,e,f}` were easier, `Y`
   looks better even if it is a worse policy. DR-2026-05-06-c names this
   exactly: "per-codeDigest rollups are confounded by Task-subset
   selection."
2. **Train/test leakage.** In train mode `codeDigest` mutates *every
   task*. A `codeDigest` produced by Improve-ing *on* task `d` and then
   scored *on* `d` measures memorization, not learning. The
   [#766](https://github.com/Jinn-Network/mono/issues/766) comment pins
   this flaw on [#683](https://github.com/Jinn-Network/mono/issues/683)'s
   sequence-slope approach, which never separates train from test.
3. **Denominator noise.** Small N per `codeDigest` (it changes every task
   in train mode, so each may have only a handful of attempts) plus the
   launcher under-count
   ([#669](https://github.com/Jinn-Network/mono/issues/669)) make the
   *rate* wobble independently of policy quality.

The deepest of these is the interaction of (1) and (2) with `codeDigest`
churn: **in train mode there is almost never a stable
(policy, task-set) pair to measure.** This is precisely why DR-2026-05-06-c
invented frozen mode — freezing the harness produces a *stable* codeDigest
across a window, so a meaningful sample can accumulate for one policy
version.

## Decision

**Adopt the held-out exam as the outcome-measurement primitive for the RL
ladder: a fixed, versioned, replayable set of tasks held out from the train
stream, run against a frozen checkpoint and compared before-vs-after.** This
is option B (frozen-mode checkpoint benchmark, DR-2026-05-06-c) made honest
by adding the held-out task discipline. Live production trend (option A) is
retained as the free always-on leading indicator; the synthetic-SolverNet
idea (option C) is re-homed, not rejected, as the *construction method* for
non-replayable domains (§3.3).

Build it in cost tiers ordered by honesty-per-dollar (§4). File the
follow-up issues in §5. [#683](https://github.com/Jinn-Network/mono/issues/683)
is subsumed as the train-arm of the same harness (§6).

This DR's structure mirrors the issue's acceptance criteria: §3 surveys
A / B / C plus the synthesis; §4 recommends the concrete shape (held-out
discipline, cadence, trigger, CI-vs-production); §5 names the follow-up
`feat` / `chore` issues with effort; §7 names what this does *not* address.

## §1 — What already exists (so the gap is exact)

The freeze-and-checkpoint machinery from DR-2026-05-06-c is largely built.
The held-out exam is a thin layer on top, not a new subsystem.

| Capability | Status | Location |
|---|---|---|
| `mode: 'train' \| 'frozen'` Harness contract | **built** | `HarnessContext.mode`, envelope `Executor.mode` |
| Freeze enforcement (hash-fence before/after) | **built** | `client/src/daemon/freeze-fence.ts:45`, `client/src/harnesses/freeze.ts:51` (`hashImplStateDir`) |
| Checkpoint identity + on-chain anchor | **built** | `HarnessCheckpoint` entity `packages/indexer/ponder.schema.ts:457`; handler `packages/indexer/src/handlers.ts:895` |
| `jinn checkpoint publish` (codeDigest + implStateDir CID + source bundle) | **built** | `client/src/cli/commands/checkpoint.ts:22` |
| Per-codeDigest frozen score | **built but confounded** | explorer `frozenResolvedRate` / CheckpointTimeline, `packages/indexer/src/api/explorer.ts:797`, `.../explorer/src/lib/api.ts:133` |
| verdict↔codeDigest join (`actualPassed`/`actualScore`) | **built, queryable** | `attemptEnvelopeMeta` + `verdictEnvelopeMeta`, DR-2026-05-27 §1.3 |
| Mechanism smoke (freeze train/frozen/violation) | **built** | `client/test/e2e/freeze-mode.test.ts` (`yarn e2e:freeze-mode`) |
| **Fixed held-out task slate** | **MISSING** | — |
| **Run a slate against a checkpoint + compare** | **MISSING** | — |

The single load-bearing gap: today `frozenResolvedRate` scores a checkpoint
on *whatever frozen-mode attempts happened to match its codeDigest*
(`explorer.ts:820`). Freezing already kills confounder (2) — no mutation, no
leakage — and stabilises the policy arm of (1). But the *task-selection*
arm of (1) and the denominator noise of (3) survive, because two checkpoints
frozen at different times are still scored on different self-selected task
subsets. **The fix is to run a fixed task set against each checkpoint.**

## §2 — The core idea, stated plainly

To prove the agent improved, give it a **fixed exam** — the *same* tasks to
the before-checkpoint and the after-checkpoint. Same questions both times. A
higher score on the *identical* exam is real improvement, not an easy week.

Two disciplines make the exam honest:

- **Fixed and versioned.** Same tasks across checkpoints, content-addressed,
  so scores are comparable. A slate version bump is a measurement
  discontinuity and must be recorded as one.
- **Held out from training.** The exam tasks are reserved and never enter the
  train stream, so a high score is generalization, not memorization
  (defeats confounder 2 even as policies keep training). For
  swe-rebench-v2 this means reserving a fixed set of `instance_id`s and
  adding a generator/claim guard that excludes them from the train stream.

A fixed set of known size also pins confounder (3): the denominator is
exactly N, controlled, independent of the launcher under-count.

## §3 — Survey of the options

### §3.1 Option A — live production trend

Already built (`bucketResolvedRate` / `rollingResolvedRate` over a rolling
time/attempt window). Free, observational (rides attempts operators pay for
anyway), always-on. **Verdict: keep as the free leading indicator; it can
never confirm learning.** It suffers all three confounders maximally —
time-bucketing smears across codeDigest churn, task-mix drift,
model-provider drift, and operator-population change. It answers "is the
aggregate number moving" but cannot attribute movement to harness learning
versus easier tasks versus more operators. DR-2026-05-27 §4.2 itself flags
the production denominator as noisy with many confounders. Its enduring job
is to tell us *when* it is worth paying for a real exam (§4).

### §3.2 Option B — frozen-mode checkpoint benchmark

Designed in DR-2026-05-06-c; machinery largely built (§1). Freezing removes
confounder (2) and stabilises the policy. **The gap is the held-out exam:**
without a fixed task set, the frozen score still floats on self-selected
tasks (confounder 1) with a noisy denominator (confounder 3). **Adding the
held-out slate converts B into an honest before/after comparison.** This is
the recommendation.

### §3.3 Option C — synthetic SolverNet — re-homed, not rejected

Both B-with-exam and C give a *fixed exam*; they differ only in where the
questions come from — **reserve real tasks** vs **construct synthetic ones**.

Reserved-real usually wins: a good score on real tasks means the agent is
good at the real work (external validity), and reserving existing tasks is
far less to build than a per-SolverType synthetic-task generator. But C is
genuinely better in two cases, and the first is decisive for some domains:

1. **Replayability.** An exam requires handing the *exact same* question to
   before- and after-checkpoints. swe-rebench-v2 tasks are replayable (a
   frozen GitHub bug in a Docker box). But some Jinn task types **cannot be
   replayed** — a prediction-market task ("predict the outcome of event X")
   is unrepeatable once X resolves. For those domains, constructing fixed
   synthetic tasks is the *only* way to get a replayable exam.
2. **Difficulty tuning.** Reserved-real tasks may all be easy (100% pass,
   no signal) or all hard (0% pass, no signal) —
   [#683](https://github.com/Jinn-Network/mono/issues/683) flags this.
   Synthetic lets you hand-pick a spread with measurement resolution.

**Synthesis.** The primitive is "a fixed, held-out, **replayable** exam."
There are two construction methods for the drawer, chosen by whether the
domain's tasks can be re-run:

- **Reserve real tasks** — for replayable domains (swe-rebench-v2). Cheap,
  high validity. **Start here.**
- **Construct synthetic tasks** — C's mechanism, retained for
  non-replayable domains (predictions). Built later, per-domain, only where
  reservation is impossible.

C is therefore not rejected globally; it is the slate-construction method
for non-replayable SolverTypes. The slate abstraction is the same either
way (per DR-2026-05-26, SolverType plugins describe their domain only; the
exam orchestrator composes over arbitrary SolverTypes).

## §4 — Recommended shape

**Option B made honest via a held-out exam slate, built in cost tiers
ordered by honesty-per-dollar.** Every exam question is a real task run that
burns real inference/JINN spend — an N-task exam costs N× per run — so
cadence and trigger are split by *who is asking*.

| Tier | Consumer | Exam | Trigger | Cost | Build order |
|---|---|---|---|---|---|
| **0** | the dashboard | none (live trend) | always-on | free | keep (exists) |
| **1** | CI robot | tiny (1–2 tasks), **mocked harness** | every PR | ~free | **first** |
| **2** | a human asking a specific question | full held-out slate, frozen | `jinn eval <slate> --checkpoint <cid>` | N× on demand | **the deliverable** |
| **3** | nightly robot | full held-out slate, frozen | cron, dedicated EOA | N× nightly | **defer + gate** |

- **Tier 1 (CI smoke, ship first).** Extend `client/test/e2e/freeze-mode.test.ts`
  to assert the *exam orchestrator* runs a tiny slate against a checkpoint
  deterministically (mocked harness), records per-task results, and the
  freeze-fence holds. It does **not** measure learning — it protects the
  exam machinery from silently rotting, and is the prerequisite for trusting
  any number Tiers 2/3 produce.
- **Tier 2 (operator-triggered, the actual deliverable).**
  `jinn eval <slate> --checkpoint <cid>` runs the full held-out slate in
  frozen mode and emits a comparison against the parent checkpoint's
  held-out score, with a confidence interval. Pay N× only when a human
  asks a specific question ("I changed the promoter prompt — is the new
  frozen version better?"). **Highest honesty-per-dollar point on the
  curve** — the minimum that satisfies the issue's held-out-discipline and
  "is the agent better" requirements.
- **Tier 3 (nightly, deferred + gated).** Tier 2 on a cron against a
  dedicated EOA for an unattended longitudinal curve. File it; gate it on
  Tier 2 having shown the number actually moves. Do not front-load the most
  expensive tier.

**Why tiered rather than a single tier.** Operator-only would leave the
exam machinery itself untested in CI (it would break silently and surface
as garbage on first real run) and would drop the free signal that tells us
*when* to spend. Observational-only (reject N× entirely) is declining to
build the thing the spike is about — confounders (1) and (2) cannot be
answered observationally. Nightly-first is premature spend before the slate
has shown signal.

### §4.1 Determinism caveat (named, not hidden)

Agent runs are stochastic (model temperature, tool nondeterminism). A single
slate run is a noisy point. v1 records per-task pass/fail and reports the
rate **with a confidence interval**, accepting that small N plus
stochasticity means **only large deltas are trustworthy.** The exam confirms
*large* improvements; it is not a microscope for 1pp changes. Exact seed /
multi-run-averaging / CI methodology is deferred to the Tier-2 `feat`
design (the options #683 already enumerates: fixed seed + temp 0; or
multi-run averaging with CIs).

## §5 — Follow-up issues to file

1. **`chore(eval)` — held-out slate primitive.** Versioned, content-addressed
   task list for a SolverType + a generator/claim guard that excludes slate
   `instance_id`s from the train stream. First instantiation: reserve a
   fixed swe-rebench-v2 subset. **Effort: S (~1–2 days).** Independent.
2. **`feat(eval)` — `jinn eval` orchestrator (Tier 2).** Run a slate against
   `(checkpoint, mode)`, persist per-task results, emit comparison vs
   parent checkpoint with a confidence interval. **Effort: M (~1 sprint).**
   Depends on #1.
3. **`test(eval)` — Tier-1 CI smoke.** Extend `e2e:freeze-mode` to exercise
   the orchestrator deterministically against a tiny mocked slate.
   **Effort: S.** Depends on a thin slice of #2.
4. **`feat(explorer)` — checkpoint-vs-checkpoint held-out view.** Make
   `frozenResolvedRate` slate-scoped (not "whatever claimed"); render the
   held-out delta on CheckpointTimeline. **Effort: S–M.** Depends on #1/#2
   writing slate-scoped results.
5. **`chore(ci)` — Tier-3 nightly held-out eval** on a dedicated EOA.
   **Effort: S. Filed-but-gated** on #2 proving the number moves.
6. **Disposition of [#683](https://github.com/Jinn-Network/mono/issues/683).**
   Reframe/close as the train-arm of this harness once #1/#2 land (§6).

## §6 — Disposition of #683 (derived from the survey)

[#683](https://github.com/Jinn-Network/mono/issues/683) is the multi-task
swe-rebench learning tracker — run an operator across a task sequence and
watch the solve-rate slope. Its named flaw (the
[#766](https://github.com/Jinn-Network/mono/issues/766) comment) is that it
never separates train from test. **The held-out slate fixes that flaw and
reveals #683 to be the same harness in train mode:**

- **#766 = frozen-arm.** Freeze a checkpoint, run the held-out slate,
  compare to the parent checkpoint.
- **#683 = train-arm.** Train across a sequence, evaluate *on the held-out
  slate* at intervals, watch the slope. Evaluating on held-out tasks (not
  the training tasks) is exactly the correction #683 needs.

Both arms share the slate (#5.1), the orchestrator (#5.2), and the
comparison surface (#5.4); they differ only in `mode` and trigger. **#683 is
subsumed as the train-arm** — reframe it to "train-arm slope on the held-out
slate + determinism strategy" or close-as-subsumed once #1/#2 land. This is
the "merge" disposition the #766 comment offered, but earned by the survey
(the held-out slate is the unifying primitive) rather than asserted.

## §7 — What this does NOT address

Per BRAND.md, naming the gap is more Legible than papering over it.

1. **Cross-operator outcome comparison / federated Level 1.** The held-out
   exam is per-operator-local. The marketplace-wide aggregator
   (DR-2026-05-27 §4.8 — "which codeDigests across the network perform best
   on this SolverNet") is out of scope and belongs in
   [#689](https://github.com/Jinn-Network/mono/issues/689)'s Phase 5
   scoping.
2. **Federation-level measurement** generally.
3. **Level 4 PRM step-level credit.** That needs trajectory density (gated
   on MCP-server span instrumentation or
   [#671](https://github.com/Jinn-Network/mono/issues/671) /
   [#672](https://github.com/Jinn-Network/mono/issues/672), DR-2026-05-27
   §4.6); the held-out exam is an outcome signal, not a per-step one.
4. **The cost-leverage Pareto.** The optimal slate size N for a target
   confidence is named, not solved; v1 picks a defensible small N and states
   the confidence caveat (§4.1). An honest Pareto would shape the
   per-SolverNet decision on exam size.
5. **Synthetic-task construction for non-replayable domains.** §3.3 re-homes
   C as the construction method for predictions etc., but does not design
   it — that is a separate `feat` filed when a non-replayable SolverType
   needs an exam.
6. **Launcher under-count
   ([#669](https://github.com/Jinn-Network/mono/issues/669)).** Degrades
   option A's denominator; flagged, not fixed here. The held-out exam's
   denominator (fixed N) is immune to it.
7. **Deep statistical methodology** (seed strategy, exact CI math) —
   deferred to the Tier-2 `feat` design.

## §8 — Cross-references (required grounding)

- **DR-2026-05-06-c (frozen-state contract).** Supplies the freeze
  mechanism and checkpoint identity the frozen-arm depends on. This DR
  operationalises the "canonical slate" that DR named ("Run frozen against
  the canonical slate") but never built — the held-out exam *is* that
  canonical slate, with the held-out discipline made explicit.
- **DR-2026-05-27 (RL-on-harness ladder).** This DR supplies the
  outcome-measurement substrate every level of that ladder needs. §4 of the
  ladder repeatedly invokes a "sample window before update"; the held-out
  exam is the held-out, confound-controlled version of that window, reusable
  from Level 1 through Level 4.

## Status

Proposed — pending Captain ratification. Authored as the spike finding for
[#766](https://github.com/Jinn-Network/mono/issues/766). The C
re-homing in §3.3 (synthetic as construction-method-for-non-replayable,
not global rejection) was prompted by Captain dialogue during the spike.
