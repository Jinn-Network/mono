---
title: Baseline-failure regression benchmark — held-out exam construction (screening) design
date: 2026-06-03
author: opus (brainstormed on claude/intelligent-haibt-894e4e; operator adrianobradley)
status: design-locked — pending operator review of this spec, then implementation plan
version: 0.1
issue: https://github.com/Jinn-Network/mono/issues/986
---

**Pre-reads (load-bearing):**

- **Issue [#986](https://github.com/Jinn-Network/mono/issues/986)** — the forward path this implements: live SolverNet as the training stream + a standing baseline-failure regression benchmark.
- **DR-2026-06-02-b** (`log/decisions/2026-06-02-held-out-efficacy-measurement-power.md`, ships on **[PR #987](https://github.com/Jinn-Network/mono/pull/987)**) — the finding this follows from: an honest negative whose binding blockers were measurement power + headroom, not the learner. Read §4 (laptop disk crash), §5 (power table), §8.2 (paired McNemar).
- **`spec/2026-04-30-phase-a-umbrella.md`** — Phase A substrate framing.
- **#817** (held-out slate primitive `excludeHeldOutSlate`/`loadHeldOutSlate`), **#818** (eval orchestrator), **PR #975** (slate-content-drift guard).

**Hard dependency:** this work **stacks on PR #987** (`claude/gallant-brattain-b07015`). #987 carries `client/src/eval/paired.ts` (the McNemar matched-design statistic) and the `EvalRunResult.paired` wiring that the eval-on-v2 reporting (AC#3) needs, plus the mode-aware steer hook the live-evidence follow-on needs. **Merge order: #987 → this.**

---

## 1. Summary

The held-out efficacy investigation (DR-2026-06-02-b) isolated *why* no trustworthy positive delta was demonstrable: the v1 slate was *randomly sampled*, so Haiku already aced the easy instances (ceiling, no room to improve) and the only headroom lived in giant repos that crashed an operator laptop. The fix is to stop running bespoke controlled training runs and instead:

1. **Treat the live SolverNet as the training stream** — operators already solve rebench tasks continuously and self-update; that *is* the training signal.
2. **Build a standing regression benchmark** of tasks the *base* (no-learning) harness reliably fails, **held out** from the train stream, scored against frozen checkpoints over time.

By construction the benchmark baseline sits at **0%** — the most sensitive operating point — so even a handful of fail→pass flips is real, attributable signal. With the paired McNemar test (#987) and a 0% baseline, **~5–6 flips clears the strict bar**.

This spec covers the **measurement infrastructure + protocol**: a screening tool that *constructs* the exam (the `v2` slate), the train-stream exclusion, and the repeatable eval-on-`v2`. The **live-evidence run** (scoring a real trained checkpoint and reporting the delta) is a tracked **follow-on milestone** — it is gated on training wall-clock and the hosted operator, not on this code.

## 2. The exam-construction pipeline (the screening tool)

One operator action — `jinn solver-nets screen-held-out swe-rebench-v2` — runs a single integrated pass that reuses the existing `validate-pool` gradeability machinery and inserts a partition stage. Three filter layers, ordered **cheapest-discriminator-first** so the expensive model runs only on survivors:

| Layer | Test | Determinism / cost | Reuses |
|---|---|---|---|
| **1. Gradeable** | gold patch resolves at the **current** `EVAL_SEMANTICS_VERSION` (`'4'`) | deterministic, model-free, ~1 Docker grade/instance | `validatePoolInstances` + `filterToScorablePool` — idempotent, skips already-validated |
| **2. Base reliably fails** | base **Haiku** harness, **frozen**, empty impl-state, **0/R** (R≥3) | stochastic, model-specific; R× Haiku + grade/instance | `runHarnessForEval` (frozen) + `SweRebenchV2Evaluator` |
| **3. Proven headroom** | **Codex / GPT-5.5** prover, **frozen**, empty impl-state, **≥1 pass** (R'=1, early-stop) | runs ONLY on layer-2 survivors; 1 strong-model run/candidate | same `runHarnessForEval` via `CodexCodeHarnessAdapter` |

**Deliberate asymmetry.** Layer 2 demands *consistent* failure (high confidence the gap is real); layer 3 needs only *one* success (existence proof the task is agent-solvable → real headroom). A task that clears all three sits in the learnable gap: **above Haiku's ceiling, below a strong model's ceiling** — exactly where training should be able to move the needle, so a later flip there is maximally informative.

**Why layer 3 matters (this is a strengthening beyond the issue's guards, never a weakening).** "Haiku fails" alone conflates *hard-but-learnable* tasks with *unflippable dead weight* (impossible for the model class, underspecified, or a flaky/broken test) whose ceiling is also 0% — those can never flip and silently shrink the exam. Requiring a stronger model to pass removes them. Honest framing: layer 3 proves the task is *reachable by an agent*, not that Haiku-specifically-with-learning will reach it — but it excludes the provably-unflippable and the broken, which is the win.

### Candidate selection — whole pool, multi-repo, bounded

The SolverNet trains across the *whole* validated pool (~30 repos), so the exam matches that distribution rather than narrowing to one repo:

- **Default candidate pool = the whole gradeable pool MINUS the never-trained remainder's complement**, walked **repo-stratified (round-robin across repos)** in a fixed, deterministic order. Concretely, before screening the runner excludes (a) instances in any active held-out slate (`loadActiveHeldOutSlateIds` → `excludeHeldOutSlate`) and (b) instances the generator has already posted (`GeneratorStateStore.postedInstanceIds()`, `posted > 0`). **This is the held-out-discipline core:** a posted instance may already be in the train stream, so holding it out later would make a trained-checkpoint pass count as *memorization, not generalization* — the exam must be drawn from the never-posted, never-held-out remainder. (`posted` is reused from the validate-pool-adjacent *generator* state, not the validated-pool store — validation ≠ training.) `--instance-id` / `--repo` scope it down; `--instance-id` is an explicit override (screens exactly those, warning if any are already posted/held-out).
- **Budget-bounded:** sample candidates up to `--max-candidates` (default ~60–100); stop once the exam cap fills. This keeps a whole-pool screen tractable (~150–300 total runs to fill the exam, same order as a single-repo plan) instead of `pool × R`.
- **Exam cap:** the first **N (default 10, range 10–20; `--held-out-count`)** candidates clearing all three layers, with a **per-repo diversity cap** so one repo can't dominate. Round-robin ordering means the first N naturally span repos.
- **No-headroom tasks (layer-2 fail but layer-3 also fails) are excluded** from the exam; they remain gradeable and stay in the train stream.

### Freeze + determinism (anti-p-hacking)

Selection order is fixed (deterministic round-robin by `instance_id`), the chosen set is **content-hashed**, and the exclusion is registered **before any checkpoint is measured**. The set is **never re-picked based on checkpoint outcomes**. If fewer than N tasks clear all three layers, **widen the candidate pool** (more repos/instances) rather than pad — and **log what was dropped** (disk-skipped repos, short-of-N). No silent truncation.

## 3. Components

| Component | Change | Purpose |
|---|---|---|
| `client/src/eval/screen.ts` | **new, tested core** — `screenBaseFailures(deps, opts)`, all boundaries injected | the selection logic (the 3-layer partition + cap), unit-testable with stubs (no Docker/inference) |
| `jinn solver-nets screen-held-out` subverb (`client/src/cli/commands/solver-nets.ts`) | **new, thin** — reuses validate-pool's evaluator/Docker/pool setup; wires the real Haiku + Codex harnesses into `screen.ts` | the operator entry point — one pass, gradeability + partition |
| `client/src/solver-types/swe-rebench-v2.ts:564` | exclude the **union of active slate versions** (`ACTIVE_SLATE_VERSIONS = ['v1','v2']`) instead of just `v1` | AC#2 — holds `v2` out of the train stream while the *rest* of every repo stays trainable |
| `client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v2.json` | **new artifact, emitted by a real screening run** (not hand-authored), content-hashed | the `v2` exam |
| `…held-out-slate.swe-rebench-v2.v2.screening-report.json` | **new sidecar** | Legibility: per-candidate evidence (gradeable?, Haiku k/R, prover pass + model, skipped repos) |
| eval store (`recordEvalResult`) | screening **persists the base arm** (passed=false per held-out id) under `(emptyTreeDigest, v2, v2hash)` | gives `jinn eval v2 --parent <emptyTreeDigest>` a real parent so Wilson + McNemar work out of the box |
| `jinn eval v2 --checkpoint <cid> --parent <emptyTreeDigest>` | **reused, no new code** | AC#3 scoring side (reports per-task + Wilson + paired McNemar via #987) |
| protocol doc (`docs/runbooks/held-out-regression-benchmark.md`) | **new** | AC#4 — R≥3, prover layer, deterministic capped selection, periodic base re-run control, Threats to validity |

### `screenBaseFailures` shape (core)

```
screenBaseFailures(
  deps: {
    candidateOrder(): PoolTask[],                       // repo-stratified, deterministic
    ensureGradeable(task): Promise<boolean>,            // validatePoolInstances + filterToScorablePool @ current semantics (idempotent)
    runBaseFrozen(task): Promise<{ passed: boolean | null }>,   // Haiku frozen, empty impl-state; null = unscorable
    runProverFrozen(task): Promise<{ passed: boolean | null }>, // Codex/GPT-5.5 frozen, empty impl-state
  },
  opts: { R: number /*≥3*/, proverRuns: number /*=1*/, heldOutCount: number, maxCandidates: number, perRepoCap: number },
): Promise<{
  heldOut: { instance_id: string; repo: string; baseFails: `0/${number}`; prover: { passed: true } }[],  // capped, ordered
  screened: { instance_id: string; gradeable: boolean; basePasses: number; baseRuns: number; proverPass: boolean | null; unscorableReason?: string }[],
  skippedRepos: { repo: string; reason: 'disk-floor' }[],
}>
```

Unscorable runs (Docker/grader/infra failures) are **excluded from the denominator, never coerced to a fail** (#476) — they don't make a task a "base fail."

## 4. Data flow

```
whole gradeable pool (repo-stratified, deterministic order)
  │  budget: --max-candidates
  ├─ Layer 1  ensureGradeable @ EVAL_SEMANTICS_VERSION='4'  (validate-pool, idempotent)        → gradeable
  ├─ Layer 2  Haiku frozen × R≥3, grade each                → keep 0/R                          → base-fails
  ├─ Layer 3  Codex/GPT-5.5 frozen × 1 (early-stop on pass) → keep ≥1 pass                      → proven-headroom
  └─ cap at N (per-repo diversity), sort, content-hash, freeze
        → emit v2 slate + screening-report
        → persist base arm (passed=false per held-out id) to eval store
        → set ACTIVE_SLATE_VERSIONS=['v1','v2'] in the generator (lands with the v2 file)

[follow-on, repeatable]  jinn eval v2 --checkpoint <trained-cid> --parent <emptyTreeDigest>
        → runEval frozen on v2 → per-task + Wilson + paired McNemar vs base → verdict (~5–6 flips clears the bar)
[control]  periodically re-run base Haiku on the v2 ids → assert still 0% (rules out regression-to-the-mean)
```

## 5. Artifacts

### `held-out-slate.swe-rebench-v2.v2.json`

Same schema as v1 (`schemaVersion: "held-out-slate.v1"`, `solverType: "swe-rebench-v2.v1"`, `version: "v2"`, `generatedAt`, `instanceIds`, `hash`). The loader (`loadHeldOutSlate`) already supports any `/^v\d+$/` version. The `comment` field documents provenance (screened at `EVAL_SEMANTICS_VERSION=4`; gradeable × Haiku-0/R × Codex-passes; baseline 0% by construction; the empty-tree base codeDigest the eval compares against). The `hash` is `sha256` over the canonical, `instanceIds`-sorted artifact — the `comment` is outside the hash.

### Screening report sidecar

Per-candidate evidence for audit (gradeable, Haiku passes/runs, prover pass + model, unscorable reasons), plus the candidates that were base-fails but **not** chosen (no proven headroom, or beyond the per-repo cap / N), and the skipped-repo log. This is the proof the baseline is 0% and the selection was reliable (0/R) and headroom-proven — not single-run noise.

### Persisted base arm

A synthesized base checkpoint (codeDigest = the empty-impl-state hash, `sha256:e3b0c442…`) with `passed=false` recorded per held-out instance under slate `v2` + its hash. The R≥3 evidence lives in the report; the store carries the canonical baseline (all-fail). This makes the McNemar `before[]` arm real: `b` (improved) = checkpoint passes, `c` (regressed) = 0 by construction → `p = mcnemarExact(passes, 0)`.

## 6. Held-out enforcement (generator-only, by decision)

The exam instances are *selected to be gradeable*, so they are recorded `scorable: true` in `validated-pool.json` and therefore appear in the published vetted-pool artifact. The single barrier keeping them out of training is the generator's `excludeHeldOutSlate` over the **union** of active slate versions (`v1 ∪ v2`) at `swe-rebench-v2.ts:564` — `excludeHeldOutSlate` leaves non-slate instances of every repo eligible, so disjoint training falls out automatically. The held-out 10 stay on record as gradeable (the exam must be gradeable to score it) but are **set aside** from the generator's posting list.

This is the generator-only approach (no publication-level exclusion). See Threats to validity §9 for the boundary condition.

## 7. Honesty guards → acceptance criteria

| Issue #986 AC | Delivered by |
|---|---|
| AC#1 — tool emits content-hashed `v2` of gradeable × base-fails, baseline reliably 0% | `screen.ts` + `screen-held-out` subverb + v2 JSON (+ the layer-3 proven-headroom strengthening) |
| AC#2 — `v2` excluded from the generator train stream, verified via `excludeHeldOutSlate` | generator union-exclusion + unit test |
| AC#3 — repeatable eval scoring a frozen checkpoint on `v2`: per-task, Wilson, paired McNemar vs base | reuse `jinn eval v2 --checkpoint --parent` + persisted base arm (needs #987's `paired.ts`) |
| AC#4 — documented protocol incl. periodic base re-run (control) + R≥3 | protocol doc |
| AC#5 — evidence: run vs ≥1 live trained checkpoint, report the delta | **follow-on milestone** (gated on training wall-clock + hosted operator + #987's steer hook on `next`); this spec delivers everything needed to run it |

## 8. Preconditions (fail-loud)

- **Evaluator enabled** (`jinn harnesses enable swe-rebench-v2-evaluator`) + **Docker reachable** — same as `validate-pool`.
- **Codex prover configured** — the `codex` CLI + its API key must be available for layer 3; if absent, fail loud with an actionable message (or skip layer 3 only on explicit `--no-prover`, which weakens the exam and must be logged). (Cf. the OpenRouter/Codex key dependency noted in operator runbooks.)
- **Disk:** keep `JINN_EVAL_DISK_FLOOR_GB ≥ 40`. The evaluator (`PythonEvalRunner`) prunes Docker **per instance** (`rmi` + `container`/`builder prune`) and gates each round on the floor, so peak disk ≈ the heaviest single image (~12.6 GB), **not the sum** — a whole-pool screen runs on a normal machine, exactly as `validate-pool` already walks all 841 tasks. If an individual instance can't hold the floor, the runner aborts that grade cleanly (`InsufficientDiskError` → unscorable → excluded) and screening continues to the next; it never crashes. The DR §4 laptop crash was a low *starting* disk (~14 GB, below the 20 GB default floor), not a leak or an accumulation. **No ≥100 GB host is required**; on a very tight box, raise headroom or scope with `--repo`.

## 9. Threats to validity (Legibility)

- **Generator-only chokepoint.** The published vetted-pool artifact still lists the exam instances; held-out discipline rests on the generator being the *sole* posting path. Valid today (no second generator, no routine manual submits on this SolverNet). If a non-generator posting path is introduced, the publication-level exclusion (layer-1) becomes necessary — tracked as a future hardening, not in this spec.
- **Posted-exclusion uses this launcher's generator-state.** Candidates exclude `posted > 0` from the local `GeneratorStateStore` — complete for a single-launcher SolverNet (one poster owns the train stream, the norm). A multi-poster net would need the union of all posters' posting histories (or an on-chain posted-instances read); until then, screen from the launcher that owns the generator.
- **Cross-repo is a harder bar.** A whole-pool exam measures cross-repo transfer, which is genuinely hard (DR §3b: a cyclopts lesson didn't transfer to another repo's bug). The exam may read within-noise longer than a within-repo exam would — that is the *honest* measurement of broad capability, and a within-repo `--repo sqlglot` run remains available as a first "does the instrument detect *any* signal" check.
- **Layer 3 proves reachability, not Haiku-reachability.** A Codex pass proves the task is agent-solvable, not that Haiku-with-learning will reach it. It removes provably-unflippable/broken tasks; it does not guarantee every exam task is flippable by the learner specifically.
- **Short-of-N.** If fewer than N tasks clear all three layers, the tool widens the candidate pool or reports fewer than N — never pads. The report logs the shortfall.
- **Single-run prover.** R'=1 for the prover is an existence proof; a flaky prover-pass is possible. Acceptable because the prover only *admits* a task (it never sets the baseline), and the periodic base re-run control re-confirms Haiku still fails.

## 10. Testing (unit-only, by decision)

No Docker/inference in CI. The heavy run is the subverb, exercised manually (the existing efficacy/e2e paths skip cleanly when keys are absent).

- `screen.ts`: stubbed `ensureGradeable`/`runBaseFrozen`/`runProverFrozen` → asserts keep-only-(0/R ∧ prover-passes), unscorable excluded (never coerced to fail), R + N + per-repo cap honored, no-headroom excluded, deterministic order, emitted slate round-trips through `loadHeldOutSlate` (hash matches).
- Generator: a `v2` id is dropped from the eligible pool (the new union-exclusion).

## 11. Scope & sequencing

- **Stacked on PR #987** (`paired.ts`); merge order #987 → this.
- **In this unit:** `screen.ts` + the `screen-held-out` subverb + generator union-exclusion + protocol doc + unit tests, **plus a real screening run** that emits & commits the `v2` slate + base arm + report. (Laptop-feasible with ≥40 GB free — per-instance Docker prune keeps peak ≈ one image; scope with `--repo` on a very tight box.)
- **Follow-on (tracked, non-blocking merge):** the live trained-checkpoint delta — Milestone 1 (whole-pool, after meaningful SolverNet training) and, if cross-repo signal is slow to surface, a within-repo `--repo sqlglot` sanity check.

## 12. Decided parameters

| Parameter | Value |
|---|---|
| Command | `jinn solver-nets screen-held-out swe-rebench-v2` |
| Gradeability | reuse `validatePoolInstances` @ `EVAL_SEMANTICS_VERSION='4'` (idempotent) |
| Base model / runs | Haiku, frozen, empty impl-state, **R=3**, keep **0/R** |
| Prover model / runs | **Codex / GPT-5.5**, frozen, empty impl-state, **R'=1**, keep **≥1 pass**, early-stop |
| No-headroom task | **excluded** from exam (stays in train stream) |
| Candidate pool | whole gradeable pool, repo-stratified round-robin, `--max-candidates` ~60–100; scopeable via `--instance-id`/`--repo` |
| Exam cap | **N=10** default (range 10–20, `--held-out-count`), per-repo diversity cap |
| Selection | deterministic order, content-hashed, frozen before measurement; widen-don't-pad; log drops |
| Enforcement | generator-only, union `['v1','v2']` |
| Eval / stat | reuse `jinn eval v2 --parent <emptyTreeDigest>`; Wilson + paired McNemar (#987) |
| Disk | `JINN_EVAL_DISK_FLOOR_GB ≥ 40`; per-instance Docker prune keeps peak ≈ one image (~12.6 GB); clean abort (`InsufficientDiskError`→unscorable→skip) if the floor can't hold — no ≥100 GB host needed |
