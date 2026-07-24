# Autopilot Review Lifecycle Recovery Design

## Status

Approved in conversation on 2026-07-18.

## Problem

Autopilot review capacity is derived from `pr-<N>` git worktrees. Today, the
existence of a review worktree is treated as proof that a review process is
still running. Review processes are detached and their worktrees are never
removed after normal completion. Once three worktrees exist, the configured
`reviewCap` of three remains permanently occupied even when no review process
is alive.

This wedges the pipeline before auto-merge:

1. implementation opens a draft PR carrying `engine:review`;
2. review dispatch creates `pr-<N>`;
3. the review process exits but `pr-<N>` remains;
4. `deriveReviewInFlight` continues counting the worktree;
5. newer PRs never receive an independent review or become ready;
6. auto-merge correctly refuses drafts without approval.

The failure was observed with stale worktrees for PRs #1723, #1726, and #1727.
The merge stage itself is known to work because it auto-merged PR #1723.

PR #1778 implements a two-hour stale-worktree reaper. That bounds a permanent
wedge, but by itself it still creates a two-hour pause after every normal batch
of three reviews. It is therefore necessary as crash recovery but insufficient
as the normal completion lifecycle.

## Goals

- Free a review slot immediately after its detached review process exits.
- Never remove the worktree of a process that is still running.
- Recover capacity after dispatcher crashes or restarts and cannot observe the
  original child-process exit.
- Keep cleanup isolated to dispatcher-created `pr-<N>` review worktrees.
- Preserve the fail-safe behavior when cleanup itself fails.
- Make the existing reviewer credential sufficient for label transitions
  without requiring organization-read scope.
- Recover the valid #1816 implementation rather than regenerating it.

## Non-goals

- Redesign implementation-session or merge-prep lifecycle management.
- Persist a general-purpose process lease database.
- Automatically merge human-surface or otherwise human-gated changes.
- Recover arbitrary uncommitted work from a crashed review agent.
- Change the three-slot review concurrency setting.

## Approaches Considered

### Timeout-only cleanup

Use PR #1778 unchanged: reap `pr-<N>` worktrees after two hours.

This is small and crash-safe, but normal successful batches still block the
review lane for two hours. It does not meet the continuous-loop goal.

### General-purpose process lease database

Persist PID, process-start identity, PR head, and lifecycle state outside the
worktree, then reconcile those leases every cycle.

This is the most explicit model, but it introduces PID-reuse handling,
cross-platform process identity, state migration, and another durable store.
The dispatcher already remains alive for normal child completion, so this is
unnecessary Stage 2 machinery.

### Process-exit cleanup plus a minimal ownership lease

Attach cleanup to the child-process exit event before detaching it. Remove the
exact review worktree immediately when the child exits. Retain the two-hour
reaper from PR #1778 for orphaned worktrees after dispatcher crashes, restarts,
or cleanup failures. Persist only the facts the fallback needs—canonical
worktree path, reviewer PID, and dispatch timestamp—in a per-PR lease.

This is the selected approach. It makes normal completion immediate and uses
age only as one of three exceptional-recovery proofs: canonical ownership,
reviewer process death, and elapsed time.

## Design

### Spawn lifecycle

Extend the existing spawn seam with an optional exit callback:

```ts
type SpawnExitHandler = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;
```

`dispatchReview` supplies an exit callback bound to the dispatcher-derived
`pr-<N>` worktree path. The production spawn adapter registers the callback on
the `ChildProcess` before calling `unref()`. Test spawn adapters may invoke the
callback deterministically.

On child exit or child-process error, one idempotent terminal callback invokes:

```text
git worktree remove --force <exact dispatcher-derived pr-N path>
```

Cleanup is best-effort and asynchronous. Failure is logged with the PR number
and path. It never terminates the dispatcher. The ownership lease is released
only after worktree removal succeeds, so a failed immediate cleanup remains
eligible for safe fallback recovery.

The callback is registered before detachment so a fast exit, including a
provider quota response, cannot race past registration.

### Safety boundary

The cleanup target is not accepted from model output, PR content, or an
environment variable. It is computed by `dispatchReview` as:

```text
join(WORKTREES_BASE, `pr-${validatedGitHubPrNumber}`)
```

Only that exact worktree is removed. Numeric implementation worktrees,
`merge-<N>` worktrees, the runner, and arbitrary paths are outside the cleanup
surface.

Review worktrees are detached at the remote PR head. The review skill requires
fixes to be committed and pushed before its process completes. Forced cleanup
therefore removes an ephemeral checkout, not the PR branch. An abnormal process
exit may lose uncommitted review-fix work; that is already the accepted behavior
of PR #1778's forced timeout cleanup. The PR remains reviewable and is
redispatched from its remote head.

### Crash and restart fallback

Retain and update PR #1778's reaper:

- dispatch writes a per-PR ownership lease containing the exact canonical
  `pr-<N>` path, reviewer PID, and dispatch timestamp;
- after restart, only a valid lease may restore PID and age;
- a worktree is stale only when its path is exactly canonical, its lease is
  valid, its PID is provably no longer alive, and it is older than two hours;
- missing/malformed leases, unknown PIDs, liveness-check errors, and
  `startedAt === 0` remain protected;
- a successful reap removes the worktree before computing the review budget;
- the freed slot may dispatch a waiting review in the same cycle;
- a failed reap is logged and the worktree remains counted as live.

The immediate exit handler is the normal path. The reaper covers:

- dispatcher termination before the child exits;
- machine restart after the reviewer process has exited;
- lost child exit notification;
- immediate cleanup failure.

### Review metadata operations

The reviewer token currently has `repo` and `project` scopes but not
`read:org`. `gh pr review` works, while `gh pr edit` performs an organization
Projects lookup and fails before applying labels.

Replace review-skill label mutations with repository REST endpoints:

```text
POST   /repos/Jinn-Network/mono/issues/<N>/labels
DELETE /repos/Jinn-Network/mono/issues/<N>/labels/<label>
```

These operations require repository access, not organization-read scope.
The clean flow reconciles these labels, posts a fresh approval, and runs
`gh pr ready` last as the draft-to-ready publication step. If ready fails, the
dispatcher must keep a currently approved draft reviewable for reconciliation;
a current approval suppresses redispatch only once the PR is non-draft. The
review-skill contract tests must reject the old `gh pr edit` form, require the
REST form, and pin this ordering.

This credential repair is a separate commit from lifecycle cleanup so each
behavior can be independently reviewed or reverted.

### #1816 recovery

The existing #1816 worktree contains two commits implementing the slim plugin
release channel. Its focused suite passes all 10 tests, its workflow YAML
parses, and it has no textual conflict with current `origin/next`.

Recovery will:

1. preserve the two commits;
2. exclude the untracked design and plan scratch files;
3. rebase the branch onto current `origin/next`;
4. rerun the focused test and YAML validation;
5. push the recovered branch;
6. open a draft PR referencing #1816 with `engine:review`;
7. retain the issue's human-review requirement for the release workflow.

Restarting #1816 from scratch is explicitly rejected because it would duplicate
tested work and discard the independent hardening commit.

## Runtime Sequence

```text
reviewable draft PR
  -> create detached pr-N worktree
  -> spawn review process with exit handler registered
  -> review/fix/re-review
  -> process exits
  -> remove pr-N immediately
  -> next cycle sees free slot
  -> approved + ready + green PR enters auto-merge
```

Exceptional path:

```text
dispatcher dies before child exit
  -> pr-N remains
  -> restarted dispatcher derives it as in-flight
  -> after two-hour ceiling, reaper removes it
  -> same cycle dispatches a waiting review
```

## Verification

### Unit coverage

- The production spawn adapter registers exit handling before `unref()`.
- A review child exit removes only its exact `pr-<N>` worktree.
- Cleanup failure is logged and does not fail the review pass.
- Three review processes may occupy all three slots; after their exit callbacks,
  the next cycle dispatches waiting reviews without a two-hour delay.
- A still-running review is not removed.
- A leased, stale, provably dead orphan is reaped before budget calculation.
- A live reviewer is never reaped solely because its directory is old.
- An unknown or invalid lease is not reaped.
- A non-canonical discovered path is never passed to worktree removal.
- Failed timeout removal remains counted as live.
- Review-skill contract tests require REST label mutations and forbid
  `gh pr edit`.

### Package verification

Run from `packages/autopilot`:

```text
yarn typecheck
yarn test
```

### Live verification

1. Keep the shared supervisor paused during integration.
2. Merge the lifecycle and credential repairs into `next`.
3. Remove the three known stale review worktrees after verifying no process is
   using them and each checkout is clean.
4. Restart the supervisor so its runner resets to the repaired `origin/next`.
5. Observe three reviews dispatch.
6. Observe their worktrees disappear after process exit.
7. Observe at least one approve-eligible PR become non-draft and approved.
8. Observe auto-merge either merge it or report a later, specific gate.
9. Recover and open the #1816 PR.

## Failure Handling

- Exit cleanup failure: log, keep running, timeout reaper remains available.
- Timeout cleanup failure: log and keep the worktree counted; never pretend the
  slot is free.
- Review command failure: PR remains reviewable and may be redispatched after
  checkout cleanup.
- Label mutation failure: surface the exact REST error; do not un-draft unless
  the approval verdict was successfully recorded.
- Auto-merge rejection: report the specific unmet gate; never force-merge.
- #1816 rebase conflict: stop recovery and resolve only after inspecting the
  conflicting semantic change.

## Rollback

- Immediate cleanup can be disabled by removing the review exit callback while
  retaining the timeout reaper.
- REST label commands can revert independently to a credential with
  `read:org`.
- #1816 remains on its recovery branch until human approval; recovery cannot
  change `next` by itself.
