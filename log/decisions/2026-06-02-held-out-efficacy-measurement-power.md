---
id: DR-2026-06-02-b
title: Held-out efficacy run — REAL train→eval executed; learner CAN persist real lessons but does so UNRELIABLY (intermittent codeDigest churn); no trustworthy delta = unreliable persistence × underpowered exam at the feasible operating point (honest negative + scoped follow-up)
date: 2026-06-02
verb: Verify
status: draft
authors: opus (goal session — prove the learning loop improves the harness via the held-out exam)
relates-to: >
  DR-2026-05-28 (#766 — the held-out exam this measures efficacy with),
  DR-2026-05-27 (the RL-on-harness ladder this supplies the outcome signal for),
  DR-2026-06-02 (#930 — cross-cycle PERSISTENCE e2e; this shows that e2e's forced trivial-note masks the reliability gap),
  DR-2026-05-26 (#673 — "sessions terminate before Improve/Memory ran"; the same reliability class),
  issue #822 (train-arm slope on the held-out slate; successor to #683),
  issue #817 (held-out slate primitive), #818 (eval orchestrator), #819 (CI smoke),
  PR #975 (the exam trusted enough to measure against — re-validated here)
---

## Summary

Goal: prove the learning loop actually *improves* the harness — a REAL training
run on tasks DISJOINT from the held-out slate producing a **trustworthy positive
held-out delta** (later checkpoint beats earlier, disjoint Wilson intervals =
generalization, not memorization). Never weaken the exam; fix the learner.

**Result: honest negative — no trustworthy positive delta this session — but the
learner mechanism is healthier than a first pass suggested, and the binding
problems are now isolated.** Two are upstream of the exam:

1. **The learner CAN persist a real, generalizable lesson from a real task — but
   does so UNRELIABLY.** Across 4 real cyclopts training cycles, persistence
   happened **once** (`cyclopts-701` with an explicit "run the pipeline + persist"
   directive → committed `notes/lazy_loading_post_registration_hooks.md`, a
   genuine transferable lesson; `codeDigest` mutated empty-tree→`9901532…`). The
   other 3 cycles persisted nothing (`codeDigest` unchanged). Tally: **0/2 under
   the production prompt shape, 1/2 with an explicit directive.** The production
   handoff (`adapters/claude-code.ts buildInitialPrompt`) does NOT instruct the
   model to run the learn pipeline / persist — it relies on the model selecting
   the `learn` skill — so on real tasks the loop's policy (`codeDigest`) advances
   only intermittently. Intermittent + weak policy change ⇒ little for the exam to
   measure. (The #930 persistence e2e hides this: it FORCES a trivial note.)

2. **The exam is underpowered at the feasible operating point.** At slate N=10,
   R=1 a `trustworthy` (disjoint-interval) verdict needs **+60–70pp** and is
   **impossible from baseline ≥5/10** (§5). The only instances with real headroom
   (where Haiku fails at baseline) are large repos that are **disk-infeasible** on
   an operator laptop — they drove a **machine crash** (§4). So the feasible slate
   is small-repo, mostly at Haiku's ceiling — no room to show a delta even with
   reliable learning.

3. **The exam itself is trustworthy.** During the efficacy run the point estimate
   "rose" 50%→100% on *identical* impl-state (codeDigest unchanged — neither
   training cycle persisted under the production prompt) and the exam correctly
   returned `within-noise` (overlapping intervals). It did not false-positive on
   noise. Re-validates PR #975.

**Verdict: efficacy not demonstrated, and a trustworthy positive delta is not
reachable in THIS environment** (laptop disk → small-repo slate at ceiling; N≤10,
R=1 power floor) regardless of learner quality. The exam was NOT weakened. This is
the goal's sanctioned end state ("an honest negative result with diagnosis +
scoped follow-up") with the unblocker isolated (§6–§7).

## §1 — Audit (before spending inference), answered

Against `next` @ `6a4953f1`:

| Question | Answer |
|---|---|
| Train path: real learner or mock? | **Real learner** (claude-code/Haiku via the `claude` CLI). The only train+eval harness, `train-arm-slope-swe-rebench-v2.ts`, trains on a **trivial fixture** ("append e2e-ok to README") — wiring test, not efficacy. Fixed: §8. |
| Learner persists to implStateDir + frozen reads back? | **Yes, but unreliably** (§3). Mechanism works end-to-end on real tasks (a genuine lesson was committed; frozen mode mounts implStateDir so the note is read back), but it fired in only 1 of 4 real cycles, and 0/2 under the production prompt shape. |
| Does codeDigest change? | **Intermittently.** It mutated in the persisting cycle (`9901532…`) and stayed at the empty-tree hash (`e3b0c442…`) in the 3 non-persisting cycles. |

## §2 — Mock dry-run: exam machinery green & trustworthy

```
yarn typecheck            → exit 0
yarn test                 → 4891 passed | 9 skipped (0 failed)
yarn test test/eval test/store/eval-results.test.ts → 49 passed
yarn e2e:freeze-mode      → 5/5 (train codeDigest mutates; frozen stable; violation→rollback;
                            orchestrator records per-task over a mocked slate; frozen-mutation caught)
```

## §3 — PRIMARY finding: persistence works but is unreliable on real tasks

Real claude-code/Haiku + Docker. Four real cyclopts training cycles:

| run | instance | explicit pipeline+persist directive? | wall | codeDigest | persisted? |
|---|---|---|---|---|---|
| efficacy cycle 1 | cyclopts-633 | no (production `buildInitialPrompt` shape) | — | unchanged `e3b0c442…` | no |
| efficacy cycle 2 | cyclopts-701 | no | — | unchanged | no |
| persist probe 1 | cyclopts-633 | yes | 13.8 min | unchanged (`.improve` ran, no commit) | no |
| persist probe 2 | cyclopts-701 | yes | 3.5 min | **mutated `9901532…`** | **YES** |

The persisting cycle's ground truth (`scripts/train-persist-probe.ts`, instrumented):

```
codeDigest MUTATED?  true
git log:  71de8e6 Add lesson: lazy loading post-registration hooks pattern
          0a8b5f9 init implStateDir
implStateDir top-level (excl .git): [notes]
.memory-consolidation/consolidation_record.json → committed lesson
  notes/lazy_loading_post_registration_hooks.md
  "when code supports multiple registration paths, post-registration hooks must be
   applied consistently across all paths, even when some paths are deferred (lazy loading)"
```

That is a **genuine, generalizable** SWE lesson — so the extract→promote→commit
path is real and capable. But it fired in only one cycle, and **never under the
production prompt shape** (the efficacy run's two cycles used the raw task that the
daemon would; both persisted nothing → the after-eval ran on the *identical* empty
impl-state as the baseline, so the 50%→100% swing in §3-efficacy was pure noise).
The lever that helped: an explicit "run the 7-phase pipeline and persist durable
lessons" directive in the task — which `buildInitialPrompt` (`adapters/claude-code.ts:148`)
does **not** include.

### §3-efficacy — the executed train→eval (held-out slate, real)

`yarn e2e:train-arm-efficacy`; held-out slate `v1-sub4` = {cyclopts-609,
generate-release-notes-207, skelebot-280, pelita-863}; training (REAL, disjoint) =
{cyclopts-633, cyclopts-701}; N=2, K=2, R=1.

```
cycle 0 (baseline): codeDigest e3b0c442…  1/2 = 50.0% [9.5, 90.5] (2 unscorable)
train cyclopts-633: codeDigest UNCHANGED · train cyclopts-701: codeDigest UNCHANGED
cycle 2 (after):    codeDigest e3b0c442…  3/3 = 100.0% [43.8, 100.0] (1 unscorable)
slope +0.2500/cycle · disjoint(trustworthy)? FALSE
```

Same codeDigest at both intervals (no persistence under the production prompt) ⇒
the "improvement" is stochastic noise; the exam correctly called it within-noise.

## §4 — Operational finding: full slate is infeasible on an operator laptop (and crashed it)

Real baseline attempt, one instance at a time (before the crash): cyclopts-609 ✓
(5.7m), pelita-863 ✓ (2m), pelita-875 ✓ (4m), generate-release-notes-207 ✗ (2m,
scorable — the one small headroom case), skelebot-280 ✓ (3m), bqskit-337 —
unscorable (**disk floor 14.7 GB**). litellm×2 / OpenHands / pandas never graded —
their multi-GB images drove free disk toward 0 and the machine **hard-hung / was
force-restarted** (~50 GB reclaimed on reboot; no kernel-panic file; 32-min
uptime). Cleanup gap that caused it: the evaluator prunes Docker only reactively at
a 20 GB floor. The re-run used `JINN_EVAL_DISK_FLOOR_GB=40` + a 25 GB hard-kill
watchdog + small-repos-only and held flat at 62–67 GB. **Implication:** on real
hardware the headroom (large-repo) instances won't grade, so the feasible slate is
the small repos Haiku already passes — a ceiling with no room to show a delta.

## §5 — Measurement-power table (secondary wall)

From the exam's own `compareRates` (`client/src/eval/wilson.ts`): minimum
before→after pass-count jump for a `trustworthy` (disjoint) verdict.

| slate N | requirement |
|---|---|
| 3 | **impossible** at any delta |
| 5 | only 0→5 (perfect sweep) |
| 8 | 0→6 / 1→7 / 2→8 — all **+75pp** |
| **10 (shipped)** | 0→6 (+60pp), 1→8 / 2→9 / 3→10 (+70pp); **impossible from baseline ≥5** |
| 20 | ~+35–45pp · 30 | ~+23–37pp |

(Reproduce: `yarn tsx scripts/power.ts`.)

## §6 — Leading hypothesis (escalation)

The learner's extract→promote→commit path is **capable but not reliably
triggered** on real tasks under claude-code/Haiku:

- The production handoff `buildInitialPrompt` says only "complete the task… use the
  available skills" and relies on the model *selecting* the `learn` skill. On a
  hard real task Haiku often goes straight to solving (via the swe-rebench runtime
  skill) and never runs the full Improve/Memory pipeline to completion — so nothing
  is promoted. An explicit pipeline+persist directive raised persistence from 0/2
  to 1/2 in this session (small n — directional, not conclusive).
- Even with the directive it is stochastic per task (cyclopts-633 ran all 7 phases
  incl. `.improve` but committed nothing; cyclopts-701 committed a real lesson).
- NOTE the earlier mis-read: tier-1–5 mutations (skill/hook/notes edits to
  `implStateDir/**`) ARE allowed and preferred on claude-code; only tier-7
  installed-package patches are gated by `allowsHarnessSelfModification=false`. The
  blocker is *reliability of triggering + completing* the pipeline, not a missing
  durable sink.

## §7 — Scoped follow-ups (the path to an actual efficacy proof)

1. **`feat(learner)` — make persistence reliable on real tasks (the unblocker).**
   Have the daemon handoff / plugin projection reliably invoke the learn pipeline
   and require the Improve/Memory phases to run to completion + persist any genuine
   lesson (NOT a forced trivial note). Demonstrated lever: an explicit directive
   made cyclopts-701 persist. Acceptance: `codeDigest` advances in ≥k of N real
   cycles with no forced write. (Design-sensitive — the daemon handoff deliberately
   omits plugin operating details today; route via the projection.)
2. **`test(learner)` — persistence e2e must test genuine promotion**, not the
   forced trivial note that masks §3 (#930). Assert codeDigest advances on a real
   task without the forced write.
3. **`chore(eval)` — held-out slate v2: larger N + difficulty spread + laptop
   profile** (N≈20–30 → certifiable at ~+25–45pp; DR-2026-05-28 §3.3) AND a
   small-repo-only profile that grades without the disk crash (§4).
4. **`feat(eval)` — R>1 multi-run averaging** (gated on the `eval_results`
   append-vs-overwrite schema the train-arm header flags).
5. **Re-run `e2e:train-arm-efficacy`** at the higher-power config and/or a model
   tier with headroom on hard instances, once (1)/(3) land — the actual efficacy
   proof.

## §8 — Shipped this session (closes the trivial-training gap)

`client/test/e2e/train-arm-efficacy-swe-rebench-v2.ts` (`yarn e2e:train-arm-efficacy`):
trains the learner on REAL swe-rebench tasks disjoint from the slate (AC#2
`buildTrainSequence`/`assertNoOverlap` guard holds), both arms through the
daemon-faithful path (`runHarnessWithFreezeFence(train)` + `runEval`/frozen).
Env-parametrized for budget + explicit instance selection
(`JINN_EFFICACY_SLATE_IDS`, `_TRAIN_IDS`, `_N_TRAIN`, `_K`, `_SLATE_COUNT`,
`_TRAIN_WIN_MIN`); skips clean. Plus reproducers: `scripts/efficacy-probe.ts`
(baseline), `scripts/train-persist-probe.ts` (instrumented persistence probe),
`scripts/power.ts` (power table).

## §9 — Reproduction

```
cd client && yarn install --immutable
yarn typecheck && yarn e2e:freeze-mode
JINN_EFFICACY_SLATE_IDS=BrianPugh__cyclopts-609,AbsaOSS__generate-release-notes-207,carsdotcom__skelebot-280,ASPP__pelita-863 \
JINN_EFFICACY_TRAIN_IDS=BrianPugh__cyclopts-633,BrianPugh__cyclopts-701 \
JINN_EFFICACY_K=2 JINN_EVAL_DISK_FLOOR_GB=40 yarn e2e:train-arm-efficacy
JINN_PERSIST_INSTANCE=BrianPugh__cyclopts-701 JINN_EVAL_DISK_FLOOR_GB=40 yarn tsx scripts/train-persist-probe.ts   # persists
JINN_PERSIST_INSTANCE=BrianPugh__cyclopts-633 JINN_EVAL_DISK_FLOOR_GB=40 yarn tsx scripts/train-persist-probe.ts   # does not
yarn tsx scripts/power.ts
```

slate v1 hash: `sha256:2b029de15e271d5d2de35fe6477af98aef9fdc46f357e59139179edab1a42b15`
empty-impl-state codeDigest: `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
persisting-cycle codeDigest: `sha256:9901532255ea9879e5d2ea326d13fd102cc4a3c91537bd3dbb13b51876474bf9`

> **Hardware caution (Legibility):** running the *full* slate (pandas/OpenHands/
> litellm) on a laptop crashed the machine via disk exhaustion. Keep
> `JINN_EVAL_DISK_FLOOR_GB` ≥ 40, run small repos locally, reserve the large-repo
> slate for a host with ≥100 GB free.
