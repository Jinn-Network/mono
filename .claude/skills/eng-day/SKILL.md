---
name: eng-day
description: Daily aggregator + guidance surface for Jinn engineering work — reads the open GitHub Issue queue, open PRs, and the "Jinn engineering" GitHub Project (v2) board state for the current sprint. Surfaces sprint progress against the upcoming Monday cut, yesterday's shipped, today's top-3 *guidance* actions tagged by work shape (fix / feat / refactor / spike / chore / docs / test), drift flags (canary status, sprint age > 7 days, PRs > 3 days stale, latest vs canary mismatch). Not a dispatcher — does not invoke action skills (brainstorming / writing-plans / executing-plans / systematic-debugging / etc.); Captain invokes those from the brief. Triggers on "eng day", "morning engineering standup", "what should I do today", "daily eng check", "what's pending", "start of day engineering", "let's plan today's work", "engineering check-in", "what's next". Reads Issue state via `gh issue list`, open PRs via `gh pr list`, and the GitHub Project board state via `gh project item-list`. Refuses to produce a top-3 if no active sprint exists in the Project board (fail-loud, references docs/engineering/handbook.md §The shipping machine for the daily-loop shape). Per DR-2026-05-18 the prior `bd ready` / `bd list` reads are retired — historical `jinn-mono-<id>` lookups still resolve via `bd show <id>` against the in-tree `.beads/` archive.
---

# Engineering day

The daily aggregator + guidance surface for Jinn engineering work. Run by Captain at the start of an engineering block. Reads operational state (open GitHub Issues, open PRs, the "Jinn engineering" Project board); surfaces sprint progress, today's top-3 actions tagged by work shape, drift flags. Not a dispatcher — Captain picks and invokes from the brief.

Modeled on the `growth-day` skill — same Tier-A discipline, same drift-flag pattern, same fail-loud sprint precondition.

**Substrate note (2026-05-18):** Per DR-2026-05-18, the issue-tracking substrate is GitHub Issues + native sub-issues + the "Jinn engineering" Project (v2). `bd` is retired; the `.beads/` checkout stays in-tree as a read-only archive of historical `jinn-mono-<id>` references but is not part of the live daily-loop state read.

## Read first

- [`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md) §The shipping machine (daily loop + weekly retrace), §The shapes of work (which shapes exist + their flows), §Sprint surface (GH Project shape).
- [`CLAUDE.md`](../../../CLAUDE.md) — agent-canonical project guide.
- Open Issues (ready queue): `gh issue list --repo Jinn-Network/mono --state open --json number,title,labels,assignees,createdAt,updatedAt,milestone --limit 200`. Filter to items with no open blocking sub-issue / no `blocked:*` label for "ready."
- Open PRs: `gh pr list --search 'is:open draft:false' --json number,title,author,createdAt,updatedAt,reviewDecision,mergeable`.
- GitHub Project board: `gh project item-list <project-number> --owner Jinn-Network --format json`, filtered to the current `Sprint` Iteration value. (Project number: 1 — the "Jinn engineering" board on `Jinn-Network`.)

## Sprint precondition (fail-loud)

This skill refuses to produce a top-3 unless an active sprint exists. **Active sprint** = at least one item on the "Jinn engineering" GitHub Project (v2) board with `Sprint = <upcoming-monday-date>`.

No active sprint = no daily plan. Either declare a sprint (add at least one Issue to the Project board with `Sprint = upcoming-Monday`) or explicitly take a rest day. The fail-loud message quotes `docs/engineering/handbook.md` §Sprint surface for the sprint shape.

## Output shape

A four-section brief:

1. **Sprint context** — current sprint window (Monday cut date), days elapsed, % closed vs queued, any work in-progress.
2. **Yesterday shipped** — PRs merged in the last 24h (with shape prefix and author), Issues closed.
3. **Today's top-3 guidance** — tagged by work shape, with Issue number + one-line context. Order by: blockers first, then by sprint-fit (sprint-target items rank above unrelated ready Issues), then by priority. Always include the next stale PR (> 3 days idle) if there is one.
4. **Drift flags** — surface only the flags that are active:
   - Canary publish broken on most recent merge.
   - npm `latest` mismatched against expected weekly cut (no Monday Release in the last 8+ days).
   - PR open > 3 days without review activity.
   - Sprint age > 7 days (Monday cut should reset weekly).
   - Issues marked in-progress (assigned, Project Status = In Progress) with no commits / no PR activity in 5+ days.

## How to assemble

1. Read state in parallel:
   - `gh issue list --repo Jinn-Network/mono --state open --json number,title,labels,assignees,createdAt,updatedAt`
   - `gh pr list --search 'is:open draft:false' --repo Jinn-Network/mono --json number,title,author,createdAt,updatedAt,reviewDecision,mergeable`
   - `gh project item-list <project-number> --owner Jinn-Network --format json` (project-number: 1)
   - Last Release: `gh release list --repo Jinn-Network/mono --limit 1 --json publishedAt,tagName` (drift baseline for the canary/latest mismatch flag).
2. Compute drift flags from the joined state.
3. Build the top-3 by:
   - Filter open Issues to those on the Project board with `Sprint = <upcoming-monday>` (sprint-target); else fall back to recent P0/P1-labelled Issues for an "off-sprint preview."
   - Rank by: stale-PR-review-needed > sprint-blocker > sprint-target ready > non-sprint P0 > non-sprint P1.
   - Tag each with shape from the Issue body's `## Run-mode` section (or the `shape:*` label if present).
4. Format the brief; output to terminal; do not dispatch.

## Failure modes

- **No active sprint.** Print the fail-loud message:
  > No active sprint declared. Per docs/engineering/handbook.md §Sprint surface, the canonical sprint board is the "Jinn engineering" GitHub Project (v2) on Jinn-Network/mono. Add at least one GitHub Issue to the Project board with `Sprint = <upcoming-monday-date>` to declare a sprint, or take an explicit rest day.
- **Project number mismatch.** This skill assumes project-number `1` for "Jinn engineering" on `Jinn-Network`. If `gh project item-list 1 --owner Jinn-Network` returns "project not found" or an unrelated board, run `gh project list --owner Jinn-Network --format json | jq '.projects[] | {number,title}'` to discover the actual number and surface it in the brief alongside the "no active sprint" failure — do not silently emit a misleading "no sprint" message when the project number is wrong.
- **`gh` CLI unauthenticated.** Print the auth instruction (`gh auth login`, with the `project` scope: `gh auth refresh -s project`); do not block on the brief.
- **Project board not reachable** (network / token issue). Print a one-line note and fall back to the open-Issue queue alone. Continue.

## v0 vs v1

This is the v0 skill. v1 will:

- Auto-detect Project board number from `gh project list` (currently hardcoded to 1 for the "Jinn engineering" board on `Jinn-Network`).
- Compute the suggested-semver-bump heuristic surface (always-patch; Captain overrides to minor on epic close) and flag if an epic-major Issue closed in the window.
- Surface shape-flow refinement candidates (per handbook §Iterative refinement) if friction signals emerge in repeated brief runs.

These v1 improvements come from iterative refinement (handbook §Iterative refinement) — file a GitHub Issue under the engineering handbook umbrella if friction observed.

## Composition

- Composes with `growth-day` only at the Captain's invocation level (Captain reads both each morning). The two skills do not share state; engineering and growth loops have different rhythms (engineering weekly cut vs growth daily loop).
- Composes downstream with the action skills it lists but does not invoke (`brainstorming`, `writing-plans`, `executing-plans`, `systematic-debugging`, `dispatching-parallel-agents`, `subagent-driven-development`, `verification-before-completion`, `receiving-code-review`).
- Composes with the Project board's Friday triage flow (handbook §Weekly retrace) — `eng-day` reads what triage produced; the prior `bd-mirror`-coupled Friday cron is retired per DR-2026-05-18.
