# Design: Autopilot dependency-aware unblock + PR stacking

- **Version:** 0.1 (design)
- **Date:** 2026-07-13
- **Author:** Ritsu (ritsuKai2000)
- **Status:** Proposed — awaiting review
- **Component:** `packages/eng-loop` (Autopilot dispatcher)

## Motivation

Today the dispatcher's ready-filter excludes any issue whose `Blocked on`
field is `Another issue` (`selectReady` requires `blockedOn === 'Nothing'`).
So a dependent issue **B** sits idle until its blocker **A** is fully merged —
even when A's work is already done and sitting in an open PR. That serializes
work that could pipeline: B could be built *on top of* A's unmerged branch and
its PR stacked on A's, so both land in sequence without B waiting for A to
merge first.

Goal: when B is blocked on A and A already has an open PR solving it,
auto-unblock B and dispatch it **stacked on A's PR branch**.

## Key finding — the blocker edge is not recorded machine-readably

Investigation (2026-07-13) of the ~13 `Blocked on: Another issue` items:

- The board `Blocked on` field is a **flag** (`Nothing` / `Human` /
  `Another issue`) — it does **not** record *which* issue is the blocker.
- Only 4 of 13 name a blocker in the body, inconsistently: `Blocked on #1570`
  (#1573), `Parent: #983` (#1024), `after #1461` (#1464), `Blocked on #986`
  (#1032). The other 9 name no blocker at all.
- GitHub **native issue dependencies** (`blocked_by`) are **empty** — unused.

So the prerequisite for the whole feature is establishing a reliable,
machine-readable edge. That is decision 1 below.

## Decisions (locked)

1. **Edge source: GitHub native issue dependencies** (`blocked_by`). Structured,
   first-class, queryable, and composes with GitHub's auto-retarget-of-stacked-PRs
   on merge. The board `Blocked on: Another issue` flag becomes *derived* from
   whether open `blocked_by` edges remain.
2. **Trigger: the blocker has any open PR, draft included.** The autopilot opens
   draft PRs, so requiring non-draft/CI-green would never fire. Earliest
   pipelining; the review loop + `stack-order.ts` review the stack in dependency
   order, so a rejected base surfaces before B's PR could merge.

## Design

### 1. Edge representation & backfill

- Adopt `blocked_by` as source of truth. **Backfill** the current blocked issues
  by mapping their prose blocker reference to a native dependency (one-time; the
  9 with no named blocker are triaged by hand).
- Going forward, triage sets the native dependency; the `Blocked on: Another issue`
  board flag is kept only as the human-visible mirror, derived from open edges.

### 2. Readiness rule (`ready-filter` + `project-snapshot`)

- `project-snapshot` is extended to fetch, per candidate issue: its `blocked_by`
  edges and, for each blocker, whether it is closed/merged or has an open PR
  (issue → linked PRs).
- New predicate: an issue with `blocked_by` edges is **ready** when **every**
  blocker is either closed/merged **or** has an open PR.
- ⚑ **Multi-blocker default:** if more than one blocker is unmerged-but-PR'd,
  the issue stays blocked. Auto-stacking is only driven when there is exactly
  one unmerged-but-PR'd blocker (all other blockers already merged). Multi-parent
  stacking is too fragile to auto-drive.

### 3. Stacking on dispatch (`dispatch`)

- `dispatch` currently branches every worktree off `origin/next`. Change: when B's
  single unmerged blocker A has an open PR, branch B's worktree off **A's PR head
  branch** and pass that base into the session so it opens B's PR targeting A's
  branch. If all blockers are already merged, branch off `next` as today.
- The session prompt is told its base branch explicitly (do not assume `next`).

### 4. Merge & abandoned-base handling

- **A merges:** GitHub auto-retargets B's PR base to `next`. No dispatcher action.
- **Abandoned-base sweep (`syncStackBases`, as built — refined from the original
  sketch during review 2026-07-13):** if A's PR is closed **without** merging,
  B's PR base still points at A's dead branch (GitHub only auto-retargets on
  *merge*). Each cycle, for every open child PR whose base isn't `next`, the
  sweep finds the PR whose head *is* that base (A) and, if A's PR is `CLOSED`,
  parks B to **`Blocked on: Human`** + posts an explanatory comment. Parking (not
  `Another issue`) frees B's slot via the existing `deriveInFlight`
  `blockedOn === 'Human'` carve-out and avoids the `syncHumanLane` demote-
  conflict — so no `state.ts` change is needed.
  - **Detection is PR-data only (no marker file):** it reads B's PR `baseRefName`,
    so it acts on children in `In Progress` **or** `In Review` (a session flips to
    In Review seconds after opening its PR, so In Review is the common case). The
    brief pre-PR window is caught on the child's next cycle once its PR exists.

### 5. Reuse

- `stack-order.ts` + the review loop already review a stack in dependency order —
  no new review logic. A rejected/blocked base means B's PR is held until the base
  is resolved.

## Modules touched

- `project-snapshot.ts` — fetch `blocked_by` + blockers' PR state.
- `ready-filter.ts` — new dependency-aware ready predicate.
- `dispatch.ts` — variable base branch (blocker's PR head vs `origin/next`).
- new: abandoned-base re-block sweep (sibling of `human-lane.ts`).
- `types.ts` — carry blocker/base info on the polled/ready issue shapes.

## Testing (TDD)

- Unit: readiness predicate across the matrix — no blockers; blocker open-PR;
  blocker merged; blocker no-PR (stay blocked); multi-blocker (one PR'd vs all
  merged); abandoned base.
- Unit: dispatch base-branch selection (blocker PR head vs `next`).
- Unit: abandoned-base sweep re-blocks the right issues, idempotent.
- Integration: `project-snapshot` parses native `blocked_by` + linked-PR state
  from a recorded GraphQL fixture.

## Rollout

- `feat` on the core dispatcher — built TDD, PR to `next`. The running supervisor
  tracks `origin/next`, so it picks up the change on its next respawn after merge.
- One-time backfill of native `blocked_by` on the current blocked issues.

## Out of scope

- Multi-parent (>1 unmerged blocker) auto-stacking.
- Transitive chains deeper than the natural PR-stack GitHub already retargets.
- Cross-repo dependencies.
- Auto-rebase of B on top of a *changed* (force-pushed) base — relies on the base
  session pushing cleanly; a churny base is a review-lane concern, not dispatch.

## Open questions

- Backfill authorship: do the 9 unnamed-blocker issues get their edges set by
  hand now, or left `Blocked on: Human` until someone records the real dependency?
- Should the derived `Blocked on` flag be written back to the board by the
  dispatcher, or left as a manual human field with `blocked_by` as the only
  machine source? (Leaning: dispatcher derives readiness from `blocked_by` and
  does not fight the human over the board flag.)
