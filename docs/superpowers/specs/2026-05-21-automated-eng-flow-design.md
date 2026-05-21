# Automated engineering flow — design

**Version:** 0.1 (proposed)
**Date:** 2026-05-21
**Authors:** oak (Captain) and claude — co-designed in a brainstorming session, 2026-05-21
**Status:** Proposed. Output of a brainstorm; the implementation plan follows via `writing-plans`. Not yet ratified.

**Related:**
- DR-2026-05-20-b — *Issue taxonomy redesign* (`log/decisions/2026-05-20-issue-taxonomy-redesign.md`). The taxonomy — work-shape Issue Types plus the `Blocked on` / `Effort` / `Priority` Project fields — is the routing layer this flow consumes. This design is a primary motivation for that DR.
- `docs/engineering/handbook.md` — work shapes and their per-shape skill chains (SOPs), the canary / Monday-cut cadence, the worktree rule, stacked PRs.
- The `frink` project (sibling repo) — prior art for running interactive skill methodology autonomously; source of the override-header pattern adopted in §7.

---

## Summary

An autonomous engineering loop. People dogfood the Jinn operator app and file GitHub issues; a local dispatcher reads the categorized issue queue and, for each automatable issue, runs an autonomous implementation session that produces a reviewed, app-tested pull request; the human batch-merges the open PRs into `next`, acceptance-tests by *using the app* — which surfaces the next batch of issues — and the existing Monday cadence promotes `next` to `main` for public release.

The human's role narrows to exactly three touchpoints:

1. **File issues** — skill-assisted, while dogfooding.
2. **Steer the human-input issues** — jump into paused sessions in the `Blocked on: Human` queue.
3. **Acceptance-test `next`** — by using the app.

Everything else runs unattended. The system is deliberately built so it can later be re-homed as a Jinn SolverNet without changing its core (§9).

## Motivation

Engineering throughput is gated by human attention at every step: triage, implementation, review, merge. Most of those steps are now automatable. The constraint worth preserving is human *judgment* — what to build, and whether the running app is actually good — not human *mechanism*.

Three things make this buildable now rather than aspirational:

- **The taxonomy exists.** DR-2026-05-20-b gives every issue a machine-readable shape (Issue Type) and routing fields (`Blocked on`, `Effort`, `Priority`) — precisely the signal a dispatcher needs to decide what runs autonomously, what needs a human, and how strong a model to use.
- **The methodology exists.** The handbook already prescribes a per-shape skill chain (the superpowers methodology). The in-session pipeline runs that chain; it does not invent a new one.
- **The cadence exists.** `next` is already the integration branch with auto-canary; `promote-main.yml` already cuts the Monday release. The loop feeds `next`; it does not touch the release machinery.

This design is therefore mostly *wiring existing parts into a closed loop*. The genuinely new pieces are small and enumerated in §"What's new vs. existing".

## The loop

```
dogfood the app
      |
      v
file-issue skill --> triaged GitHub issue --> dispatcher queue
                                                   |
                                                   v
                            worktree + autonomous in-session pipeline
                            (one coordinating agent, subagents per stage)
                                        |
                          +-------------+-------------+
                          v                           v
                draft PR + green CI          Blocked on: Human
                          |                  (paused, resumable session)
                          |                           |
                          |          human jumps in: steer / resume
                          v                           |
                (human) merge skill <-----------------+
                          |
                          v
                        next --> (human) app-tests next --> new issues --+
                          |                                              |
                          |        (loops back to dogfood / file-issue) -+
                          v
            Monday: next --> main   (public release -- existing cadence)
```

The loop is closed: using the app generates the issues that feed it.

## Components

| # | Component | Status |
|---|-----------|--------|
| 1 | `file-issue` skill — agent-assisted issue authoring | **new skill** |
| 2 | Triage-finish pass — backstop categorizer | **new** (a dispatcher stage) |
| 3 | `eng-orchestrator` — the local dispatcher | **new program** |
| 4 | The in-session pipeline — coordinating agent + subagent stages | **composes existing skills**, headless-adapted (§7) |
| 5 | The merge skill — agent-driven batch integration | **new skill** |
| 6 | The canary / Monday-cut cadence | **reused, unchanged** |

---

## 1. Issue intake — `file-issue` skill + triage-finish

Issue quality is the single strongest predictor of autonomous-implementation success: scoped, self-contained issues with binary acceptance criteria and file/component hints raise merge rates substantially; long bodies and external-reference-heavy issues lower them. Issue authoring is therefore a first-class engineering activity, not an afterthought.

**`file-issue` skill (new).** Invoked by a person while dogfooding, when the context of what they hit is still fresh. The skill interviews them briefly and writes a **short, scoped** issue — context, impact, **binary acceptance criteria**, file/component hints, minimal external references. It sets the taxonomy fields (Issue Type, `Blocked on`, `Effort`, `Priority`) and files via `gh`.

**Triage-finish pass (new — a dispatcher stage).** A backstop for issues filed *without* the skill (raw, straight from the app or from GitHub). An agent rewrites them into the scoped shape and sets the fields.

**Queue-eligibility gate.** An issue is not eligible for the dispatcher queue until it is **triage-complete** — Issue Type set and the routing fields populated. Triage-complete is the entry condition to the queue.

## 2. The dispatcher — `eng-orchestrator`

A thin local TypeScript program, run as `yarn eng:loop`. It is a conductor: it shells out to agent CLIs and existing skills; it does not reimplement them. Its cycle:

**Poll & filter.** Read the issue queue (`gh issue list` plus the "Jinn engineering" Project board). An issue is **ready** when it is triage-complete, `Blocked on: Nothing`, on the board, and not already in flight. Order by `Priority`, then FIFO.

**Two throttles.**
- *Concurrency cap* — maximum simultaneous sessions. Default low (3); configurable; the practical technical ceiling is ~5–7.
- *Backpressure on the open-PR queue* — if the count of PRs already waiting for the human's batch-merge exceeds a threshold, the dispatcher **stops pulling new issues**. This is the deliberate defence against the dominant industry failure mode — reviewer/queue abandonment, work going stale. The loop self-throttles to the human's pace; it cannot outrun them.

**Dispatch.** Per picked issue: create a git worktree + branch (per handbook workflow rule 1); move the issue to `In Progress`; assign it; spawn one coordinating session (§3).

**Stacked dispatch.** If an issue is `Blocked on: Another issue #A`, it is not dispatched independently. The dispatcher waits until A has a PR, then dispatches the dependent issue **stacked on A's branch** (its worktree branches off A; its PR base is A's branch). The `Blocked on: Another issue` field doubles as the stacking instruction — no separate mechanism (see §5).

**Agent selection.** One agent per issue — *not* competition (equal-budget single-agent matches multi-agent on a coherent single change; competition multiplies cost and review load). The *coordinating* agent is always Claude Code — it invokes Claude Code skills (§7). The *implementer* — the subagent the coordinator hands the implement stage to — may be codex, claude, or cursor. v1: a configurable default implementer plus an optional per-issue override label. Effort-tiered routing and round-robin load-spreading are easy follow-ons.

**Collect.** All gates green → a draft PR enters the human's batch queue. Escalation → the issue moves to `Blocked on: Human` with a paused, resumable session (§4). The dispatcher **verifies git/PR state externally** — it never trusts a session's self-reported "done" (the zero-commit guard, Appendix).

**State.** State lives in GitHub, not the dispatcher. The Project `Status` field *is* the state machine (Todo → In Progress → In Review → Done); `Blocked on` flags escalations. The dispatcher re-derives state from `gh` + `git worktree list` each cycle, so a crash or restart simply resumes; only live retry context and process handles need a small local file.

## 3. The in-session pipeline

When the dispatcher hands an issue to a session, that session is **one coordinating agent** (Claude Code) that runs the issue's pipeline by **dispatching subagents per stage**. There is no external coordination of stages — all stage-handoff, the finding→fix loop, and the escalation decision live inside this one process, where dispatching subagents is first-class.

The pipeline is an **autonomous run of the superpowers methodology** for the issue's shape: the handbook already prescribes a skill chain per Issue Type, and the session runs *that*, headless. Triage has made the issue a good enough spec to feed it. The loop then adds three gates *because no human reads the diff*.

Stages — they scale to the shape and `Effort` (a Low-effort `docs` change compresses stages 1–2 to almost nothing; a High-effort `feat` runs them fully):

1. **Design the solution** — autonomous `brainstorming`, minus the human dialogue (that half already happened in `file-issue` + triage; the triaged issue is the approved design brief). The agent explores the code, picks an approach, writes a short design note.
2. **Plan the implementation** — autonomous `writing-plans` → a step-by-step plan.
3. **Implement** — `test-driven-development` + `executing-plans`. Tests first — they are the net a human diff-read would otherwise be. Per the shape's SOP (regression-test-first for `fix`).
4. **`/simplify`** — existing skill. Tighten the diff: reuse, clarity, small and focused.
5. **Independent review** — a *fresh* subagent (never the implementer; independence is free, a clean context) runs `requesting-code-review` with the code-reviewer template. It has send-back authority.
6. **`/security-review`** — existing skill, a subagent pass. Runs every session.
7. **jinn-app test** — `testing-jinn-app` for the specific feature/fix when it touches an operator-visible surface. The automated behavioural check.
8. **Verify + open PR** — `verification-before-completion` (typecheck + tests + build green locally), then a draft PR with a shape-prefixed Conventional-Commit title and `Closes #N`.

**The human gate.** The human does **not** read diffs. They acceptance-test the running app on `next` (§6). Consequently the in-session pipeline + CI carry 100% of code-correctness assurance — which is why stages 4–7 and TDD are non-negotiable, and why the reviewer is independent of the implementer.

**`spike` / `incident` / `design`** run only stages 1–2 — the "first push" (a finding, a diagnosis + candidate patch, or a spec/DR draft) — then **pause for the human** (§4) instead of proceeding to PR.

## 4. Finding handling & escalation

One uniform model, no special cases (security findings included).

**Findings route back to the implementer, inside the session.** Whichever gate found the problem hands its findings to the coordinating agent, which dispatches a fix subagent; the gate then re-runs. (`/simplify` is the mild exception — it fixes in place; it only "raises" something when simplifying reveals a structural problem, which is then treated as a review finding.) Re-review after a fix stays with the *independent* reviewer.

**Two kinds of finding:**
- *Fixable* — wrong logic, missing test, red CI, failing app-test → the retry loop.
- *Scope / design* — the issue is mis-scoped, the approach is wrong, a product decision is needed → immediate escalation; do not iterate on something that is not an implementation bug.

**No round-count budget.** The coordinating agent escalates **on judgment** — when it assesses the findings are not converging, or it hits a scope/design finding. An arbitrary cap would escalate legitimate multi-round fixes prematurely.

**The resource circuit-breaker.** A backstop owned by the *dispatcher*, not the agent: a generous wall-clock ceiling per session (hours — sessions legitimately run long). It does not cap retries; it is purely a runaway guard for the rare doom-loop the agent fails to self-recognise. Because escalation is a *pause* (below), the wall-clock needs no precise tuning — a spurious early pause costs one human glance.

**Escalation = pause a resumable session, never kill.** When a session escalates — wall-clock, judgment, or a spike/incident/design first-push — it stops but is fully preserved: the coordinating agent's transcript, subagent history, and worktree all intact and resumable. On a graceful pause it leaves a one-paragraph "where I am / why I stopped" note (a soft warning before a hard wall-clock stop lets it write one); the full transcript is the record regardless. The escalation carries a **structured status** — `needs-decision` / `blocked` / `stuck` — so the human knows the class at a glance.

**The human jumps in.** From the `Blocked on: Human` queue the human attaches to that exact session (`eng-loop attach <issue>` / `claude --resume`), reads the transcript, judges "freaking out, or just a long honest job?", then resumes it (optionally extending the wall-clock), steers it (types the missing input, resumes), or takes over. Live sessions are observable read-only via their transcript too.

**One human-handoff mechanism.** Spike/incident/design first-push, judgment-escalation, and wall-clock all land in the same place: a paused session with a resume handle. No escalation is ever lossy.

**The clean property:** a PR reaches the human's batch queue *only if every gate is green*. Otherwise it is not a PR in that queue — it is a paused session in the `Blocked on: Human` queue. Two queues, no overlap.

## 5. The merge skill

Batch integration is **a reasoning task, not a script** — which conflicts are mechanical versus which hide a real trade-off, what order to merge, whether two PRs that both touched a function need their overlap *re-implemented* rather than just resolved. So it is **a new skill** — a coordinating agent session — that the human invokes when ready to integrate.

The merge skill surveys the ready PRs, decides order, and merges them into `next` one at a time; after each merge `next` advances and the next PR is rebased onto it (a rebase subagent re-runs the gates/CI). Clean conflicts auto-resolve; a genuine semantic conflict the agent cannot cleanly resolve sends that PR's issue to `Blocked on: Human` (a paused session to jump into), and the batch continues without it. It inherits the §4 escalation mechanism.

**PR stacking** reduces merge conflict by integrating at *build* time instead of *merge* time. Three tiers:

1. *Known dependencies* stack at dispatch — `Blocked on: Another issue` is the signal (§2).
2. *`refactor`* stacks by handbook mandate (strangler-fig); a large refactor's coordinating agent decomposes itself into a stack.
3. *Unforeseen overlap* — the merge skill stacks reactively (order + rebase) at integration time.

The dispatcher stays independence-first (parallelism for the common case); `Blocked on: Another issue` carries the known dependencies as real stacks; the merge skill is the catch-all integrator. `gh-stack` (the handbook's named tool) does the mechanics.

## 6. The human integration cycle

**The ready queue.** Sessions that pass all gates leave draft PRs against `next`, bounded by the §2 backpressure throttle.

**Batch-merge.** The human invokes the merge skill (§5) when ready.

**App-test `next`.** With the batch merged, `next` is the integrated working state (and a canary build, per the existing cadence). The human uses the app — the real acceptance gate, the one human-judgment step. This is the *integrated* test; the in-session jinn-app test only checked each change in isolation.

**New issues close the loop.** Whatever the human finds while testing → `file-issue` skill → dispatcher queue. A regression *from the batch* → a `fix` / `incident` issue, or revert that PR; `next` is the integration branch, so a bad state there is recoverable and never reaches users.

**Monday: `next` → `main`.** Nothing new — the existing `promote-main.yml` / Monday cut. The loop's contribution is only that it has fed `next` all week. The discipline: **`main` only ever gets what survived a week on `next` under the human's testing.**

The human's available time is therefore two queues: the ready-PR batch (merge + app-test), and the `Blocked on: Human` queue (paused sessions to jump into).

## 7. Autonomy — adapting the superpowers chain

The superpowers skills are written **interactively** — `brainstorming` HARD-GATEs on human approval, `writing-plans` / `executing-plans` have human checkpoints. The in-session pipeline must run them headless. The mechanism, proven in the `frink` project, is the **override-header pattern**.

Keep each superpowers skill **verbatim — interactive gates and all** — and prepend one standard block:

> **Headless mode.** If running non-interactive (`-p` / `--print`), do not ask questions or wait for user input. Make your best judgment from codebase patterns and project conventions; where options are presented, pick the recommended one; where approval is needed, proceed if confident; log your decisions.

The interactive gate text stays intact; the header *situationally overrides* it. The same skill file then works both ways — interactive for a human, headless in the loop — and the agent plays the human's approval role. No fork, no rewrite, no gate-deletion.

This is sound because the human-input half of `brainstorming` has already happened upstream — in `file-issue` + triage. The triaged issue *is* the approved design brief; headless "design the solution" decides only *how*.

**Import discipline** (keeps the project mergeable with upstream superpowers):

- Copy the upstream skill verbatim → insert the standard headless block → do not restyle the rest.
- Ship an `UPSTREAM.md` per adapted skill recording source repo / tag / path and every intentional edit.
- A grep gate hunts residual blockers (`ask the user`, `which option`, `wait for user`, `approval`, `TodoWrite`); remove only the exact matching lines.
- Pressure-test each adapted skill — 3 scenarios against fresh subagents, before and after — and patch loopholes with minimal wording changes.

## 8. Build phasing

The pipeline is the hard, expensive part; the dispatcher is comparatively easy. Prove the pipeline hand-cranked before wrapping it in automation.

- **Phase 1 — the spine, hand-cranked.** Build the new skills (`file-issue`, the in-session pipeline, the merge skill) and the headless adaptation of the superpowers chain (§7). Operate by hand: file an issue → invoke the pipeline skill on it → PR → invoke the merge skill. No dispatcher. This proves the expensive, risky part — that the autonomous pipeline reliably produces good PRs — on real issues, one at a time, watched. Useful from day one.
- **Phase 2 — the dispatcher.** Build `eng-orchestrator`: queue / ready-filter, concurrency cap (start at 1–2), backpressure, worktrees, the wall-clock breaker, jump-in / resume. The loop now runs unattended; the pipeline is already trusted from Phase 1.
- **Phase 3 — scale & refine.** Raise concurrency, add agent-selection routing, add stacked dispatch, tune throttles from real data. No new architecture.

Scope can phase alongside (prove on `fix` / `chore` / `docs` first, expand to `feat` / `refactor`) — a rollout dial, not an architecture choice.

## 9. The SolverNet seam

Structural mapping: issue = task / intent · dispatcher = generator · coordinating session = a solver attempt · PR = delivery · merged code + issue history = knowledge.

Two interfaces, defined from the start, each with only a local implementation now:

- **`IssueSource`** — where ready issues come from. Local: poll `gh`. Future: claim on-chain tasks.
- **`DeliverySink`** — what happens to finished work. Local: open a GitHub PR. Future: submit an on-chain delivery for evaluator verification and settlement.

Everything *between* the seams — triage, the coordinating-agent pipeline, the gates, the merge skill — is **SolverNet-invariant**. The future transition is: write the two on-chain implementations and swap them in; the pipeline is untouched. The one discipline that buys this: keep `gh` calls isolated behind `IssueSource` / `DeliverySink` — never thread them through the dispatcher.

Two future-layer notes, out of scope now:

- In-session review / security / app-test is solver *self-QA*. Protocol-level **evaluation** by independent evaluators is a separate layer, added when this becomes a SolverNet.
- Multi-solver **competition** (several operators attempt one issue-task, best delivery wins) is the natural SolverNet form of the multi-agent idea deliberately skipped in the local loop.

## Open questions / deferred

- **SolverNet evaluation.** How an independent evaluator verifies an engineering delivery on-chain is the genuine open question for the SolverNet form. Deferred until the SolverNet is actually built; it does not block the local loop.
- **Agent-selection policy.** v1 is a configurable default implementer plus a per-issue override. Whether to add Effort-tiered routing or round-robin is a Phase-3 question, decided from real data.
- **Concurrency / backpressure thresholds.** Start conservative (concurrency 3, a small open-PR cap); tune from observed human throughput.
- **Wall-clock ceiling value.** Generous (hours); the exact value is tuned in Phase 2.

## What's new vs. existing

**New:**

- `file-issue` skill.
- The merge skill.
- `eng-orchestrator` — the dispatcher — with the `IssueSource` / `DeliverySink` seams.
- The headless adaptation of the superpowers chain (override-header + `UPSTREAM.md` + pressure tests).

**Existing, reused:**

- The superpowers skill chain, `/simplify`, `/security-review`, `testing-jinn-app`, `requesting-code-review` + the code-reviewer template.
- The DR-2026-05-20-b taxonomy (Issue Types + `Blocked on` / `Effort` / `Priority`).
- The canary / Monday-cut cadence; the worktree rule; `gh-stack`.

## Appendix — practical gotchas (from `frink`)

- **`-p` mode does not auto-load `CLAUDE.md`.** The dispatcher must explicitly concatenate the canon (CLAUDE.md + handbook) into each session's prompt.
- **Zero-commit guard.** Agents sometimes claim "done" without committing. Verify git / PR state externally; never trust the transcript's self-report.
- **One review entrypoint.** An earlier `frink` attempt sprawled into five overlapping review surfaces and had to be consolidated. Keep exactly one (`requesting-code-review`).
- **No plan-posture flags on headless execution stages** — a leaked `--mode plan` / `--permission-mode plan` makes an agent narrate a plan instead of executing it.
