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
- The Codex prover configured (the `codex` CLI + its API key) for layer 3.
- `JINN_EVAL_DISK_FLOOR_GB ≥ 40`. A full whole-pool screen wants a ≥100 GB host;
  on a laptop, scope to small/medium repos (`--repo`) — large-image repos
  (pandas / OpenHands / litellm) can exhaust disk.

## Cut the exam (screening)
```
jinn solver-nets screen-held-out swe-rebench-v2 \
  --runs 3 --held-out-count 10 --max-candidates 60 --per-repo-cap 3
```
Whole-pool by default (repo-stratified). Scope with `--repo tobymao` (within-repo
sanity check) or `--instance-id <id> ...`. Emits, next to the slate module:
- `held-out-slate.swe-rebench-v2.v2.json` (content-hashed exam)
- `held-out-slate.swe-rebench-v2.v2.screening-report.json` (per-candidate evidence)
and records the base arm (all-fail) under the printed `baseCodeDigest`.

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
