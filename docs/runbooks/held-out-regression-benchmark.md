# Held-out regression benchmark (baseline-failure exam) — runbook

Issue #986. Design: `docs/superpowers/specs/2026-06-03-baseline-failure-regression-benchmark-design.md`.

## What it is
A standing, content-addressed set of swe-rebench-v2 tasks that are (a) gradeable
at the current evalSemanticsVersion, (b) reliably failed by the base
claude-code/Haiku harness (0/R, R≥3), and (c) passed by a stronger Codex/GPT-5.5
prover at least once (proven headroom). Baseline = 0% by construction → the most
sensitive operating point. The live SolverNet is the training stream; this exam
is held out from it and scored against frozen checkpoints over time.

## Preconditions
- `jinn harnesses enable swe-rebench-v2-evaluator` (clones the upstream eval repo).
- Docker reachable.
- The Codex prover configured for layer 3: `codex` CLI **>= 0.133.0** (older CLIs
  deliver the prompt differently and the prover returns unscorable → every
  base-fail is logged as `no-headroom` and the slate comes out empty) + valid auth
  (`~/.codex/auth.json`). The screen logs a loud WARNING if the prover returns no
  gradeable result, so an unavailable prover can't masquerade as "no headroom".
- `JINN_EVAL_DISK_FLOOR_GB ≥ 40`. The evaluator prunes Docker per instance
  (`rmi` + `container`/`builder prune`) and gates each round on the floor, so
  peak disk ≈ the heaviest single image (~12.6 GB), NOT the sum — a whole-pool
  screen runs on a normal machine, exactly like `validate-pool` walks all 841
  tasks. If an instance can't hold the floor the runner aborts that grade
  cleanly (`InsufficientDiskError` → unscorable → skipped); it never crashes.
  The DR §4 laptop crash was a low *starting* disk (~14 GB, below the 20 GB
  default floor), not a leak. Keep ≥40 GB free (peak image + build overhead);
  on a very tight box raise headroom or scope with `--repo`. No 100 GB host
  needed.

## Cut the exam (screening)
```
jinn solver-nets screen-held-out swe-rebench-v2 \
  --runs 3 --held-out-count 10 --max-candidates 60 --per-repo-cap 3
```
Whole-pool by default (repo-stratified). Scope with `--repo tobymao` (within-repo
sanity check) or `--instance-id <id> ...`. **Candidates are drawn only from the
never-trained, never-held-out remainder**, excluding the union of: (1) the active
held-out slate (would overlap an existing exam); (2) instances **already attempted
on-network** — any verdict envelope, passed or failed — read from the **indexer**
(`verdictEnvelopeMeta`, cross-operator and current); and (3) this box's posted
ledger (`posted > 0` in generator-state) as a belt. The indexer is the source of
truth because the local ledger can be **stale** when a different generator (e.g.
a hosted operator) is the active poster. An attempted instance was executed → the
learner trained on it → holding it out later would make a trained-checkpoint pass
count as memorization, not generalization. If the indexer is unreachable the
screen **aborts** (it must not screen against an unknown attempted set).
Candidates are further **restricted to the already-validated-scorable set** (the
never-validated tail is ~90% not-gradeable, so base-screening it wastes inference):
discovery of gradeability is `validate-pool`'s job; the screen selects held-out
*from* the scorable set. So the workflow is **run `validate-pool` first to grow the
scorable pool, then screen it.** (`--instance-id` is an explicit override: it screens
exactly those, warning if any are already attempted/posted/held-out.) The prover
(layer 3) is selectable:
`--prover-harness codex` (default, GPT-5.5) or `--prover-harness claude-code
--prover-model opus` (a stronger same-family prover via the Claude auth — useful
when codex is rate-limited; Haiku→Opus is a clean capability ladder). Emits, next
to the slate module:
- `held-out-slate.swe-rebench-v2.v2.json` (content-hashed exam)
- `held-out-slate.swe-rebench-v2.v2.screening-report.json` (per-candidate evidence)
and records the base arm (all-fail) under the printed `baseCodeDigest`.

**Resumable.** A real R≥3 cut is hours of inference; it is NOT one-shot. Each
candidate's measurement (gradeable + base R-runs + prover) is cached to
`<stateDir>/held-out-screen-progress.json`. **Re-run the exact same command to
resume** — cached candidates replay instantly (no inference, no budget cost) and
`--max-candidates` bounds only the *new* work, so a long screen proceeds in
budget-sized chunks across invocations (and survives a rate-limit / crash / disk
abort). The cache is keyed by a config signature (base model, prover, `--runs`,
eval-semantics version); changing any of those starts fresh. To force a clean
re-screen, delete `held-out-screen-progress.json`.

Then add `'v2'` to `ACTIVE_HELD_OUT_SLATE_VERSIONS` and commit the slate + report
(see the plan, Task 7). The generator now holds v2 out of the train stream.

## Honesty guards (never weaken the exam)
- **R≥3, keep only 0/R.** A single Haiku miss is noise, not a capability gap.
- **Prover proves headroom, not Haiku-reachability.** It removes unflippable /
  broken tasks; it does not guarantee the learner specifically can flip them.
- **Freeze before training.** Selection order is deterministic and the set is
  content-hashed; never re-pick based on checkpoint outcomes (no p-hacking).
- **Exclude un-gradeable / unscorable.** Never coerce an infra/grader failure to
  a capability fail.
- **Widen, don't pad.** If fewer than N clear all three layers, widen the
  candidate pool; the report logs the shortfall and any disk-skipped repos.

## Score a checkpoint
```
jinn eval v2 --checkpoint <trained-cid> --parent <baseCodeDigest>
```
Reports per-task pass/fail, Wilson CIs, and the paired McNemar verdict vs the
base arm. With baseline 0%, ~5–6 fail→pass flips clears the strict bar.

## Periodic base re-run (control)
Re-run `screen-held-out` scoped to the v2 ids (or re-grade base Haiku on them) to
confirm they STILL fail at baseline — rules out regression-to-the-mean. If base
still fails them but a trained checkpoint passes, the delta is airtight.

## Threats to validity
Held-out discipline currently rests on the generator being the sole posting path
(generator-only exclusion; the published vetted-pool artifact still lists the exam
instances). A whole-pool exam measures cross-repo transfer, a genuinely harder bar
than within-repo — it may read within-noise longer.
