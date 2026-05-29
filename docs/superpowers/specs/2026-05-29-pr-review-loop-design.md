# Autopilot — PR review-and-fix loop (`review-pr`) — design

**Version:** 0.2 (proposed)
**Date:** 2026-05-29
**Authors:** oak (Captain) and claude — co-designed in a brainstorming session, 2026-05-29
**Status:** Proposed. Output of a brainstorm; the implementation plan follows via `writing-plans`. Not yet ratified.

**Related:**
- `docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md` — **the parent design.** This spec *adds a layer* to it. The loop, the human's three touchpoints, the SolverNet seam, the headless-override pattern, the merge skill, and the gotchas appendix all carry over unchanged.
- `.claude/skills/implement-issue/SKILL.md` — the existing implementation coordinator. This design leaves it essentially untouched (see §"What does NOT change").
- `docs/engineering/handbook.md` — work shapes, per-shape skill chains, the canary / Monday-cut cadence, the worktree rule, stacked PRs.
- `docs/superpowers/specs/2026-05-23-author-allowlist-design.md` — the dispatcher's author allowlist (gates *issue* dispatch; the review loop uses a label, not the allowlist).
- `packages/eng-loop/` — the dispatcher this design extends with a second source.

---

## Summary

The autonomous engineering system — the dispatcher (`packages/eng-loop`) plus its coordinating sessions and the skills they run — is named **Autopilot**. It runs the software-delivery loop (issue → implementation → review → merge) unattended, with the human at the controls only at the parent design's three touchpoints. (Renaming the `eng-loop` package/commands to `autopilot` is a cosmetic follow-up, out of scope here.)

This spec adds Autopilot's second coordinating session, **`review-pr`**, that mirrors `implement-issue` and is triggered by **open PRs** rather than issues. It runs the authoritative independent review (code-review + security + app-test) and owns the review→fix→re-review loop on the PR branch.

`review-pr` is **purely additive**. It does **not** remove or move any stage out of `implement-issue`. The existing implementation pipeline keeps doing its full in-session review/security/app-test exactly as today — the coordinator reviews *as if it is the only reviewer* and has no knowledge that a second review runs later. The only edits to `implement-issue` are cosmetic/trivial (a stage rename and one label flag; see §"What does NOT change").

Participation is **opt-in via a label** (`engine:review`):
- The engine **auto-applies** the label to its own PRs, so engine solutions are reviewed by default.
- A human **tags** a PR with the label to request engine review of theirs; an un-labelled PR is never touched.
- Because the label is explicit consent, the auto-fix loop is free to push fixes to any labelled PR.

The net effect:
- **Engine PRs** get reviewed twice — belt (the in-session review inside `implement-issue`) and suspenders (the independent `review-pr` pass after the PR opens). Deliberate redundancy.
- **Human PRs** that opt in get their *only* automated review, plus the auto-fix loop.

## Motivation

Today every quality gate — code-review, security, app-test — lives *inside* the engine's own implementation sessions. Two gaps follow:

- **A human-authored PR gets none of them.** A dogfooding contributor who wants the engine's review on their own change has no way to ask for it.
- **Review is welded to implementation.** The strongest assurance the project has only ever fires on engine-authored work.

Re-rooting review on the PR — as an independent, opt-in layer — closes both gaps without disturbing the proven implementation pipeline. And it does so by *relocating the existing review→fix loop pattern onto a PR*, not by rebuilding it.

## What does NOT change

`implement-issue` keeps all eight stages and its full behaviour. The coordinator still runs Stage 5 independent review, Stage 6 security, and Stage 7 app-test, producing a fully self-reviewed draft PR — unaware that `review-pr` exists. Two edits only, neither a flow change:

1. **Stage 4 rename** — `/simplify` → `/code-review`, matching the already-renamed command. Behaviour identical.
2. **Self-opt-in** — Stage 8's existing `gh pr create` gains `--label engine:review`, so the engine's own PRs are picked up by `review-pr` by default. The coordinator's logic is otherwise byte-identical; it just tags its output.

This redundancy is intentional (belt and suspenders): the in-session review catches problems early and cheaply with the implementer's context; `review-pr` is the independent, fresh-checkout backstop that also covers PRs the engine never authored.

## Architecture — the dispatcher gains a second trigger

`packages/eng-loop` keeps its hardened substrate (single-snapshot GraphQL, field-id cache, rate-limit guard, idempotent worktrees, detached `claude -p` spawning, wall-clock breaker, drift detection). It gains a second **source** and **dispatch trigger**; it becomes a stage router:

```
GhIssueSource (open issues + board) ─▶ implement-dispatch ─▶ spawns `implement-issue` session   (unchanged)
PrSource      (labelled open PRs)   ─▶ review-dispatch    ─▶ spawns `review-pr` session          (new)
```

Routing table:

| Observable state | Dispatcher spawns |
|---|---|
| Issue: Todo + triage-complete + `Blocked on: Nothing`, not in-flight | `implement-issue` session (unchanged) |
| Open PR carrying `engine:review`, no bot review at its current head SHA, no `review-pr` already in flight | `review-pr` session (new) |

Work is discovered from observable GitHub state — restart-safe by construction, as in the parent design.

## The `review-pr` coordinator (new — mirrors `implement-issue`)

One coordinating agent that dispatches subagents per stage; it never writes or judges code itself. Independence is preserved at the *subagent* level — the reviewer subagent is always a different subagent than the fix subagent, identical to `implement-issue`'s stage-3 ≠ stage-5 discipline.

Triggered by any open PR carrying `engine:review` with no bot review at its current head SHA. Worktree `../jinn-mono_worktrees/pr-<n>` checked out **on the PR branch** (so the in-session fix subagent can commit and push). Resolves the linked issue for context where one exists.

Flow:
1. **Dispatch review subagents** — independent code-review (`requesting-code-review` + the code-reviewer template) + `/security-review` + *(app-test via `testing-jinn-app` iff the diff touches `client/src/dashboard/`)*, in parallel. Classify findings **blocking** vs **advisory/nit**.
2. **No blocking findings** → post a native *approve* review + `review:approved` label → un-draft the PR → done. The merge skill (human-invoked, parent §5) consumes it.
3. **Blocking findings** → dispatch a **fix subagent** (always a different subagent than the reviewers) seeded with the findings → it commits + pushes → coordinator **re-runs the review subagents on the new diff** → loop. **No round-count bound** — the coordinator escalates *on judgment* (`Blocked on: Human` + a structured `needs-decision` / `blocked` / `stuck` status and a summary comment) when it determines a human is needed: a scope/design wall, irreducible ambiguity, an unpushable branch, or non-converging findings. Otherwise it loops to clean → approve.

This is a **lift of the parent §4 review→fix loop**, re-rooted on a PR branch. The orchestration is not re-engineered.

**One flow for every labelled PR.** There is no author-based branching inside `review-pr`. The label is the gate *and* the consent: any PR carrying it — engine- or human-authored — runs the identical flow, fix loop included. The engine is trusted to recognise when a human is needed rather than gating on identity.

## The opt-in model

| Who | How they opt in | Result |
|---|---|---|
| Engine | `implement-issue` Stage 8 adds `--label engine:review` at PR creation | Every engine PR is reviewed by `review-pr` by default |
| Human | adds the `engine:review` label to their PR | That PR enters the review loop (and the auto-fix loop) |
| Anyone | *leaves the label off* | `review-pr` never touches the PR |

`engine:review` is a working name (bikeshed at implementation). The verdict labels `review:approved` / `review:changes-requested` are separate (output of the loop, not the trigger).

## The merge-ready signal

`review-pr` **approval** (`review:approved` + un-drafted) is the merge-ready signal the merge skill consumes — for *every* labelled PR, uniformly. For an engine PR this sits downstream of `implement-issue`'s own internal review; for a human PR it is the only automated gate. The "two queues, no overlap" property (parent §4) holds at the `review-pr` boundary: a labelled PR is either under the autonomous review/fix loop, `review:approved`-and-waiting, or escalated to `Blocked on: Human`.

## Dispatcher wiring

- **`PrSource`** — one additional GraphQL read per cycle for open PRs carrying `engine:review` + their review state, inside the existing rate-limit budget. Behind the same seam discipline as `GhIssueSource` (no `gh`/`git` in routing logic; injected as a dependency). Maps onto the SolverNet `IssueSource` seam family (parent §9) as a second source.
- **Separate concurrency cap** — `reviewCap` distinct from the implement-side cap, so a burst of labelled PRs cannot starve new implementation work (or vice-versa).
- **Backpressure** — unchanged for the implement side. `review-pr` approving/escalating PRs *relieves* the open-PR queue the implement-side backpressure watches.

## State & idempotency

- **Review verdict** = a SHA-tied native GitHub PR review + a `review:approved` / `review:changes-requested` label. Self-contained idempotency: the dispatcher re-spawns `review-pr` only when no bot review exists whose `commit_id` equals the PR's current head SHA. New commits (from a human or the fix subagent) invalidate the prior review and re-arm one next cycle.
- **Internal re-review** after a fix happens *inside* the `review-pr` session, so there is no double-spawn while a session is in flight.
- **`deriveInFlight`** extends to recognise `pr-<n>` worktrees, so `review-pr` sessions are crash-safe and resumable like implement sessions. No new persistent store.

## Error handling & escalation

Inherited from parent §4, unchanged:
- Wall-clock circuit-breaker covers `review-pr` sessions too — runaway protection only, never a logic bound.
- Escalation = pause a resumable session with a structured status; the human jumps in via the `Blocked on: Human` queue.
- Rate-limit guard and drift detection extend to the new source/worktrees.
- A branch the fix subagent cannot push to (e.g. a fork PR) → escalate `Blocked on: Human`; the advisory review is already posted.

## Testing

- Keep seam discipline: `PrSource` injectable; routing logic has no `gh`/`git` calls (mirrors `loop.ts`).
- **Unit:** the `engine:review` label filter; SHA-keyed review idempotency; the verdict→fix state transitions; the routing table.
- **Integration:** one full labelled-PR → review → changes-requested → fix → re-review → approve cycle against a mocked `gh`, plus the no-findings → approve fast path, plus the un-labelled-PR → ignored case.
- Pressure-test the `review-pr` skill headlessly per the parent's discipline (parent §7).

## Build phasing

1. **Stand up `review-pr` + `PrSource`** filtered on `engine:review`, reusing the proven review→fix loop. Add the `--label engine:review` flag to `implement-issue` Stage 8 and the Stage 4 `/code-review` rename. From day one: engine PRs get a second independent review, and humans can opt their PRs in.
2. **Tune** `reviewCap` and the label/verdict ergonomics from observed throughput.

(No "cutover" phase is needed — because nothing is removed from `implement-issue`, there is no coverage gap to bridge.)

## Deferred / follow-ups

Tracked as separate issues so this spec stays scoped to the additive `review-pr` layer:

- **Per-type implementation recipes** (feature B) — [#886](https://github.com/Jinn-Network/mono/issues/886). Richer, type-specific subagent chains in `implement-issue` (`spike` does research + design; `refactor` maps → designs → stacks). Out of scope here so `implement-issue` stays as-is.
- **Headless-session dispatch** — [#890](https://github.com/Jinn-Network/mono/issues/890). Coordinators dispatch headless CLI sessions instead of Claude-only Task subagents, enabling multi-CLI stages and nested dispatch (a Task subagent is Claude-only and cannot spawn its own subagents). Prerequisite for the routing below; applies to **both** `implement-issue` and `review-pr`.
- **CLI-agent / effort routing** (feature C) — [#887](https://github.com/Jinn-Network/mono/issues/887) (blocked on #890). Which *agent* (claude / codex / cursor — the existing `defaultImplementer`) runs each stage, routed by `Effort` and/or Issue Type. The genuine axis is the CLI agent, not the Claude model tier.

The primary `review-pr` implementation is tracked at [#889](https://github.com/Jinn-Network/mono/issues/889); the `eng-loop` → `autopilot` package rename at [#888](https://github.com/Jinn-Network/mono/issues/888).

## What's new vs. existing

**New:**
- `review-pr` coordinator skill (wraps the relocated review→fix loop, triggered per labelled PR).
- `PrSource` + the review-dispatch trigger in `packages/eng-loop`, filtered on `engine:review`.
- The `engine:review` opt-in label; the `review:approved` / `review:changes-requested` verdict labels.

**Changed (trivial):**
- `implement-issue` Stage 4 `/simplify` → `/code-review` (rename); Stage 8 `gh pr create` gains `--label engine:review`. No flow change.

**Existing, reused:**
- The review→fix→re-review loop and judgment-based escalation (parent §4) — relocated, not rebuilt.
- `requesting-code-review` + the code-reviewer template, `/security-review`, `testing-jinn-app`.
- The dispatcher substrate (snapshot, field cache, rate-limit guard, worktrees, wall-clock breaker, drift detection).
- The merge skill, the DR-2026-05-20-b taxonomy, the canary / Monday-cut cadence, the headless-override pattern.
