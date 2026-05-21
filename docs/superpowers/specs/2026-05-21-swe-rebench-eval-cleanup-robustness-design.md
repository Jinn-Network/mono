# SWE-rebench Eval Cleanup Robustness — Design

**Version:** 0.1
**Date:** 2026-05-21
**Author:** Captain (brainstormed with Oak)
**Issue:** [#476](https://github.com/Jinn-Network/mono/issues/476)

## Problem

`client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts` — the SWE-rebench eval runner shared by `validate-pool` and the daemon's swe-rebench evaluator — manages Docker eval images with a **count-based LRU**: keep the last `JINN_EVAL_IMAGE_CACHE_MAX` (default 20) images, `docker rmi` the rest.

Three defects make it fill operator disks:

1. **Count-based, not disk-based.** 20 images × ~3 GB per SWE-rebench image ≈ 60 GB. The cap *is* "fill a 60 GB Docker disk"; it is blind to how much disk actually exists or remains.
2. **Only evicts tagged images.** Stopped containers, build cache, and dangling layers accumulate uncounted by the LRU.
3. **No pre-eval disk guard.** The runner starts each eval unconditionally; when the disk fills mid-pull it false-marks the casualty `docker_storage_io_error` (a *permanent* `scorable: false`) and keeps going until even a 30 KB state-file write fails with `ENOSPC`.

Observed live (2026-05-21): a `validate-pool --limit 30` run filled a 460 GB Mac, corrupted Docker's content store, false-marked 4 instances, and died mid-write. Recovery required a full Docker wipe.

## Goals

- Peak eval disk footprint ≈ **one instance**, on any machine, regardless of total disk size — no per-machine tuning.
- Cleanup removes the **whole per-round footprint**: container + image + build cache / dangling layers.
- Disk pressure produces a **clean stop** — never Docker corruption, never a permanent false `scorable: false`, never a mid-write death.

## Non-goals

- **Cross-round image reuse.** The LRU's only real purpose was avoiding a re-pull when the *same* instance is evaluated again soon. This design gives that up deliberately. `validate-pool` evaluates each instance exactly once, so it loses nothing; the daemon evaluator occasionally re-pulls an image — a speed/bandwidth cost, accepted in exchange for disk-safety. (A small cache could be reintroduced later if re-pull cost is ever measured to matter — explicitly deferred, YAGNI.)
- Changing the eval logic, scoring, or substrate verification — only the Docker resource lifecycle changes.

## Approach

### 1. Prune-after-every-round (replaces the LRU)

After each eval round completes — in `eval-runner.ts`'s existing post-eval `finally` — remove that round's entire Docker footprint:

- the per-instance **container** (force-remove, even if exited),
- the per-instance **image**,
- **build cache and dangling layers** produced by the round.

The `imageLru`, `imageCacheMax`, `resolveImageCacheMax`, and `JINN_EVAL_IMAGE_CACHE_MAX` mechanism is **removed entirely**. With nothing retained between rounds, peak disk is one instance's footprint (~3 GB) instead of 20×.

Cleanup remains best-effort: a failed `docker rm`/`rmi`/prune is logged (`console.warn`) but never escapes `runEval` — same tolerance the current `defaultCleanupImage` has.

### 2. Pre-eval disk-floor guard

Before starting each eval round, probe the disk space available to Docker's storage. If it is below a **floor** (default **10 GB**, overridable via env):

1. Run a broader reclaim (`docker system prune -f`) and re-probe.
2. If still below the floor, **abort the run cleanly**: surface a typed `insufficient_disk` outcome. The caller stops gracefully — no instance is evaluated, no instance is marked, on-disk state is left consistent.

The exact disk probe (host `df` on the Docker data dir vs. an in-container `df` vs. `docker system df`) is an implementation detail for the plan; the contract is "a number of bytes free, compared against the floor."

### 3. Failure semantics

- `ENOSPC` and `docker_storage_io_error` are classified as **retryable infra errors**, distinct from genuine gradeability failures. They **must not** write a `scorable: false` admission entry — the instance is left *unvalidated* so a later run retries it.
- On an infra abort, `validate-pool` persists progress-so-far with an atomic write and exits cleanly with a clear message, rather than dying mid-rename.

### 4. Scope

All changes are in `eval-runner.ts` plus the small caller-side handling of the new `insufficient_disk` outcome in `validate-pool` (the CLI command) and the daemon's evaluator harness. Both consumers inherit robust cleanup; no SolverType or scoring logic changes.

## Error handling

| Condition | Behaviour |
|---|---|
| `docker rm/rmi/prune` fails (post-round) | Logged `console.warn`, swallowed — never escapes `runEval`. |
| Free disk < floor before a round | Reclaim, re-probe; still low → `insufficient_disk`, clean abort. |
| `ENOSPC` / `docker_storage_io_error` during a round | Retryable infra error; no `scorable:false` written; instance left unvalidated. |
| Genuine ungradeable (pytest missing, gold-patch-not-resolved, …) | Unchanged — real `scorable:false` with reason. |

## Testing

- **Unit:** after a round, cleanup invokes container-remove + image-remove + cache-prune (inject the docker fns; assert all three called).
- **Unit:** disk-floor guard — below floor → reclaim invoked; still below → `insufficient_disk` outcome, no eval run; above floor → proceeds normally. (Inject the disk probe.)
- **Unit:** `ENOSPC` / `docker_storage_io_error` classify as retryable infra errors and produce **no** `scorable:false` admission entry.
- **Regression:** existing `eval-runner` tests stay green; tests asserting the old LRU/`imageCacheMax` behaviour are removed or rewritten to the new model (justified by this design).

## Rollout

Pure operator-side robustness fix; no protocol or on-chain change. Ships as a normal `fix` PR to `next`.
