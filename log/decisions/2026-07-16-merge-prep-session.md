---
id: DR-2026-07-16
title: The merge-prep session — an AI session resolves mechanical merge conflicts on stuck pipeline PRs and pushes to the PR branch; it never merges. Extends AI-rule 4 with exception (c).
date: 2026-07-16
verb: Decide
status: accepted
authors: Claude Opus 4.8 (drafted, design + implementation session), Ritsu (steer + decision)
spec: none — design captured in the implementation plan for #1756
amends: docs/engineering/handbook.md AI-rule 4 (adds exception (c))
relates-to: "#1756 (parent feat), #1757 (Stage A — stuck report + escalation), #1758 (Stage C — this DR + handbook), #1759 (Stage B — the session); #1735 (auto-merge sweep); DR-2026-06-15 (dual-identity review authority); DR-2026-06-03 (agent approval never satisfies the code-owner gate)"
---

## Context

The autopilot's auto-merge sweep (`syncMerges`, #1735) auto-merges an engine-approved,
un-drafted, CI-green, non-code-owned pipeline PR, and gives a merely-stale (`BEHIND`) PR one
`gh pr update-branch`. But a PR with a **real merge conflict** against `next` — or one still
behind after that single update — had no path forward: it surfaced only as a dispatcher log
line. An approved, green, un-drafted PR could sit unmergeable indefinitely with nothing on the
board to draw a human's eye. Observed live in the 2026-07-15 manual merge batch (dependabot
lockfile clusters, stale-base PRs, a rename-collision), which also proved the resolution work
is largely mechanical and charter-able.

Note also: the 2026-07-15 auto-merge carve-out (#1735) amended AI-rule 4 but was never recorded
in a decision log. This DR records both it and the new merge-prep carve-out.

## Decision

Add a third autopilot session type — the **merge-prep session** — under a strict
prepare-only authority boundary.

1. **Event-triggered, not cadence-triggered.** The merge sweep now returns a structured
   `stuck` set (conflicting / still-behind / update-branch-failed), computed **label-blind** so
   escalation cannot erase its own trigger signal. A stuck PR — not a PR count — is the trigger.

2. **The session prepares; the sweep merges.** The session rebases the stuck PR in a **detached**
   worktree (`merge-<N>`; the head branch is almost always already checked out in the persisting
   In-Review impl worktree), resolves **mechanical** conflicts, and pushes to the **PR branch**
   with `--force-with-lease`. It **never** runs `gh pr merge`, `gh pr ready`, or an approving
   review. The unchanged deterministic sweep merges the result later, through its existing gates.

3. **Re-draft before push re-validates every resolution.** The session re-drafts the PR
   (`gh pr ready --undo`) *before* pushing. The pushed commit moves `headRefOid`, so the review
   loop's freshness check re-reviews the new head; a distinct-identity re-approval (DR-2026-06-15)
   + green CI + the sweep's `--match-head-commit` pin are what let it merge. No new trust
   machinery: an agent-authored resolution is re-reviewed exactly like any other change.

4. **Mechanical vs semantic charter** (from the `merge-batch` skill). **Mechanical** — lockfile
   regens, rename-ports, import-path collisions, adjacent non-overlapping edits, stale-base
   rebase — is resolved. **Semantic** — a resolution requiring reasoning about overlapping logic
   — is never guessed: the session aborts, sets the linked issue `Blocked on: Human`, labels the
   PR `review:needs-human`, comments, and touches nothing.

5. **Identity.** The session pushes under the **implementer** token, not the reviewer's, so the
   subsequent re-review is independent (never a self-review) and DR-2026-06-15 parity holds.

6. **Code-owned PRs are never prepped.** The sweep can never auto-merge them anyway (DR-2026-06-03),
   a human is already in the loop, and force-pushing under active human work is the worst case —
   so a stuck code-owned PR is escalated, not resolved. Enforced dispatcher-side and skill-side.

7. **Bounds against runaway.** Per-process attempt tracking keyed to the head oid; a same-head
   second sighting escalates; ≤2 attempts across advancing heads; a 2-hour stale-worktree reaper;
   singleton cap; and the whole thing is dead code until `JINN_MERGE_PREP=1` **and** the review
   loop is armed (a fail-loud boot check refuses `mergePrepEnabled` without `reviewBotLogin`,
   since a re-drafted PR would otherwise never be re-approved).

This extends AI-rule 4 with **exception (c)**: agent-authored *mechanical* conflict resolutions,
pushed to a PR branch and re-drafted so they re-enter the review + merge gates. Parity is
preserved — the PR still passes independent review and the auto-merge gate, or a human.

## Rollout & rollback

Ships as three stacked PRs against `next`, one per tracking issue: Stage A (issue #1757 → PR #1760,
structured stuck report + deterministic needs-human escalation — valuable on its own, no session),
Stage C (issue #1758 → PR #1761, this DR + handbook), Stage B (issue #1759 → PR #1762, the flag-gated
session). `packages/autopilot` is not covered by repo CI, so each PR's gate is
`yarn typecheck && yarn test` in that package, run on the merge result.

**Arming is operator-local.** `supervise.sh` (gitignored, per-operator) exports `JINN_MERGE_PREP=1`
under a Gate parallel to the review-loop gate: unset by default, keyed on a `next`-file-presence
proxy so merging Stage B to `next` is "the flip" that arms it on the next respawn. **Rollback is
`unset JINN_MERGE_PREP`** — no code change; Stage A's deterministic escalation continues to run,
so stuck PRs stay visible either way.

## Amendment (2026-07-21, single-surface lifecycle)

The merge-prep session concept in this DR is **subsumed** by reconcile child
issues and the tier-0 update-branch gate in
`docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md`. Handbook
AI-rule 4(c) now references agent-authored mechanical conflict resolutions via
the children ladder (never rebase; full fresh re-review after reconcile). The
`JINN_MERGE_PREP` arming path and `supervise.sh` merge-prep exports are
retired — operators use the v2 entry point only (see cutover runbook §12).

## Rejected alternatives

- **Session merges directly** (like the manual `/merge-batch`). Rejected: an agent-authored
  resolution would reach `next` on the session's own judgment, bypassing the deterministic gate.
  The prepare-only boundary keeps every resolution CI-gated and independently re-reviewed.
- **Count-triggered batch** ("every 3–5 approved PRs"). Rejected: it would make a clean approved
  PR *wait* to fill a batch, and waiting increases drift, which creates the conflicts we are
  trying to avoid. Batch-integration verification (hold ≥3 eligible, test the combined set once)
  is deferred to a follow-up issue, decoupled from conflict resolution.
