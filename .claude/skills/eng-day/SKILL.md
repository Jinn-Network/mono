---
name: eng-day
description: Daily aggregator + guidance surface for Jinn engineering work — reads bd ready queue, open PRs, and (once GitHub Project (v2) "Jinn engineering" board exists, per jinn-mono-2cl.9) the current sprint state. Surfaces sprint progress against the upcoming Monday cut, yesterday's shipped, today's top-3 *guidance* actions tagged by work shape (fix / feat / refactor / spike / chore / docs / test), drift flags (canary status, sprint age > 7 days, PRs > 3 days stale, latest vs canary mismatch). Not a dispatcher — does not invoke action skills (brainstorming / writing-plans / executing-plans / systematic-debugging / etc.); Captain invokes those from the brief. Triggers on "eng day", "morning engineering standup", "what should I do today", "daily eng check", "what's pending", "start of day engineering", "let's plan today's work", "engineering check-in", "what's next". Reads bd state via `bd ready` and `bd list`, open PRs via `gh pr list`, and the GitHub Project board state via `gh project item-list` (when 2cl.9 lands). Refuses to produce a top-3 if no active sprint exists in the Project board (fail-loud, references docs/engineering/handbook.md §The shipping machine for the daily-loop shape).
---

# Engineering day

The daily aggregator + guidance surface for Jinn engineering work. Run by Captain at the start of an engineering block. Reads operational state (bd ready, open PRs, Project board); surfaces sprint progress, today's top-3 actions tagged by work shape, drift flags. Not a dispatcher — Captain picks and invokes from the brief.

Modeled on the `growth-day` skill — same Tier-A discipline, same drift-flag pattern, same fail-loud sprint precondition.

## Read first

- [`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md) §The shipping machine (daily loop + weekly retrace), §The shapes of work (which shapes exist + their flows), §Sprint surface (GH Project shape).
- [`CLAUDE.md`](../../../CLAUDE.md) — agent-canonical project guide.
- bd state: `bd ready`, `bd list --status=in_progress`, `bd list --status=open --priority=P0,P1`.
- Open PRs: `gh pr list --search 'is:open draft:false' --json number,title,author,createdAt,reviewDecision,mergeable`.
- GitHub Project board (once `jinn-mono-2cl.9` lands): `gh project item-list <project-number> --owner Jinn-Network --format json` filtered to the current Sprint field value.

## Sprint precondition (fail-loud)

This skill refuses to produce a top-3 unless an active sprint exists. Active sprint = at least one item on the "Jinn engineering" GitHub Project (v2) board with `Sprint = <upcoming-monday-date>`. Until `jinn-mono-2cl.9` creates the Project board, the precondition relaxes to: at least one P0 or P1 bd issue in `bd ready` is recent (created or updated within the last 7 days).

No active sprint = no daily plan. Either declare a sprint (mirror at least one bd issue to the Project board with Sprint = upcoming-Monday) or explicitly take a rest day. The fail-loud message quotes `docs/engineering/handbook.md` §Sprint surface for the sprint shape.

## Output shape

A four-section brief:

1. **Sprint context** — current sprint window (Monday cut date), days elapsed, % closed vs queued, any work in-progress.
2. **Yesterday shipped** — PRs merged in the last 24h (with shape prefix and author), bd issues closed.
3. **Today's top-3 guidance** — tagged by work shape, with bd id + one-line context. Order by: blockers first, then by sprint-fit (sprint-target items rank above unrelated ready items), then by priority. Always include the next stale PR (> 3 days idle) if there is one.
4. **Drift flags** — surface only the flags that are active:
   - Canary publish broken on most recent merge.
   - npm `latest` mismatched against expected weekly cut (no Monday Release in the last 8+ days).
   - PR open > 3 days without review activity.
   - Sprint age > 7 days (Monday cut should reset weekly).
   - bd state has issues marked in-progress with no commits in 5+ days.

## How to assemble

1. Read state in parallel:
   - `bd ready`
   - `bd list --status=in_progress --json id,title,priority,assignee,updated_at`
   - `gh pr list --search 'is:open draft:false' --json number,title,author,createdAt,updatedAt,reviewDecision,mergeable`
   - When 2cl.9 lands: `gh project item-list <project-number> --owner Jinn-Network --format json`
2. Compute drift flags from the joined state.
3. Build the top-3 by:
   - Filter `bd ready` to items with `Sprint = <upcoming-monday>` on the Project board (when available); else recent P0/P1 in bd-only.
   - Rank by: stale-PR-review-needed > sprint-blocker > sprint-target ready > non-sprint P0 > non-sprint P1.
   - Tag each with shape from the bd `Run-mode` field.
4. Format the brief; output to terminal; do not dispatch.

## Failure modes

- **No active sprint.** Print the fail-loud message:
  > No active sprint declared. Per docs/engineering/handbook.md §Sprint surface, the canonical sprint board is the "Jinn engineering" GitHub Project (v2) on Jinn-Network/mono. Mirror at least one bd issue to the Project board with `Sprint = <upcoming-monday-date>` to declare a sprint, or take an explicit rest day. (Until `jinn-mono-2cl.9` creates the board, the precondition relaxes to: at least one recent P0/P1 in bd ready.)
- **Project board absent (2cl.9 not landed).** Print a one-line note and fall back to bd-only state. Continue.
- **gh CLI unauthenticated.** Print the auth instruction (`gh auth login`); do not block on the brief.

## v0 vs v1

This is the v0 skill. v1 will:
- Auto-detect Project board number from `gh project list` (currently hardcoded after 2cl.9 lands).
- Compute the suggested-semver-bump heuristic surface (always-minor; Captain-overrides) and flag if an epic-major bd issue closed in the window.
- Surface shape-flow refinement candidates (per handbook §Iterative refinement) if friction signals emerge in repeated brief runs.

These v1 improvements come from iterative refinement (handbook §Iterative refinement) — file a bd under `jinn-mono-2cl` if friction observed.

## Composition

- Composes with `growth-day` only at the Captain's invocation level (Captain reads both each morning). The two skills do not share state; engineering and growth loops have different rhythms (engineering weekly cut vs growth daily loop).
- Composes downstream with the action skills it lists but does not invoke (`brainstorming`, `writing-plans`, `executing-plans`, `systematic-debugging`, `dispatching-parallel-agents`, `subagent-driven-development`, `verification-before-completion`, `receiving-code-review`).
- Composes with the Friday triage cron (`jinn-mono-2cl.11`) which mirrors bd → GitHub Issues + Project board — `eng-day` reads what triage produced.
