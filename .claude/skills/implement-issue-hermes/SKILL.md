---
name: implement-issue-hermes
description: Use when the Autopilot dispatcher asks you to implement a specific GitHub issue in a hermes coordinator session — e.g. "Use the implement-issue-hermes skill on issue #N". The hermes-native sibling of implement-issue: same lifecycle contract and same end-state, but the stage pipeline runs on hermes' own delegate_task subagents instead of claude's Task tool. Dispatched headless; not human-invoked.
---

# implement-issue-hermes

You are the coordinating agent for exactly one GitHub issue, running as a **hermes** session. Your job: take the issue from triage to an open, reviewable draft PR — or escalate cleanly. You **delegate each pipeline stage to a fresh `delegate_task` subagent** and integrate their results; you do not implement or review directly.

This is the hermes sibling of `implement-issue`. The **contract is identical** (same gates, same end-state, same escalation); only the machinery differs: where that skill says "dispatch a fresh claude subagent", you use `delegate_task`. Do not read `implement-issue` for instructions — it is written for a different agent's tooling. This file is authoritative for you.

## 0. Your machinery

- **Subagents**: `delegate_task` spawns a child with **isolated context**. One goal per call, or a `tasks` array to run several in parallel. Children inherit your model and reasoning effort; each gets its own iteration budget. You are a root session, so your children are leaves — **children must not be asked to delegate further**.
- **Independence invariant**: a child that reviews must never be the child that implemented. Fresh `delegate_task` = fresh context = genuine independence. This is the whole reason the stages are delegated rather than done inline.
- **Skills**: you can load other SKILL.md skills (e.g. `testing-jinn-app`) — the dispatcher points your skills dir at the repo. If a skill's methodology assumes claude-only machinery (a `Task` tool, `superpowers:*`, `/slash-commands`), **read it for method, not mechanics**: apply its discipline with your own tools.
- **Shell**: you have `terminal` — `git`, `gh`, `yarn` all work. Every command is scanned by `tirith` before it runs.

## 1. Read the issue and check the hard preconditions

```bash
gh issue view <N> --repo Jinn-Network/mono --json number,title,body,labels
```
Plus its board fields (Issue Type, Blocked on, Effort, Priority). **Stop and escalate (§8) if any hold:**
- Issue Type is unset → not triage-complete.
- `Blocked on` is `Human` or `Another issue` → not yours to start.
- The issue asks for a decision/spec rather than code (`design` / `spike` shapes ship a written artifact, not an implementation).

## 2. Reality check — the triage gate

```bash
yarn workspace @jinn-network/autopilot triage:check <N>
```
Read the JSON verdict. If it is **not clear**, do not implement: comment the verdict on the issue, set `Blocked on: Human`, and stop (§8). A nonzero exit is itself a stop — never proceed on an unverified issue.

## 3. Your worktree already exists

The dispatcher created it and told you the path and branch. **Do not** `git worktree add`. Do not create a branch. Do not touch any other worktree. Work only in yours. Never use plan-posture flags of any kind.

## 4. Stages 1–3 — design, plan, implement (delegated)

Delegate each as its own `delegate_task` child, in order (each needs the previous one's output):

1. **Design** — a short design note: the approach, the files it touches, the risks. Brainstorm alternatives before settling; state assumptions explicitly. Deliverable: the note, in your context.
2. **Plan** — a concrete step plan from the design: what changes where, in what order, with the test strategy named.
3. **Implement** — execute the plan **test-first** (write the failing test, then the code that passes it — a `fix` needs a regression test that fails before the fix; a `feat` needs TDD). Match surrounding style. Commit as you go.

Then verify the work is real, not claimed:
```bash
git -C <worktree> log origin/next..HEAD --oneline
```
**Zero commits ⇒ nothing was implemented.** Do not proceed to review; re-delegate implementation once with the gap named, and escalate if it comes back empty again.

## 5. Stages 4–6 — review (delegated to FRESH children)

Compute the diff **from the merge-base** (never `origin/next..HEAD`):
```bash
git -C <worktree> diff $(git -C <worktree> merge-base origin/next HEAD)..HEAD
```
Delegate these as **separate `delegate_task` children that have not seen the implementer's context** — you may run them as one parallel batch:

- **Code review** — correctness, edge cases, error handling, and whether it actually does what the issue asked.
- **Independent review** — a second reviewer with the issue + diff and authority to send it back. Reviews the *intent*, not just the code: does this solve the stated problem, is it over-built, does it match repo conventions?
- **Security review** — injection, auth/authz, secret handling, unsafe shell/SQL, dependency risk. Run it on every session, not just "security-looking" diffs.

Classify each finding **blocking** (correctness, security, contract violation, missing test for the fix) vs **advisory/nit** (style, preference, future work). For blocking findings: delegate a **fix child** (a different child from the reviewers), then **re-run the review children on the new diff**. Loop until clean. There is no round bound — escalate on judgment (§8) if it is not converging.

## 6. Stage 7 — app test (conditional)

If the diff touches an operator-visible surface (`client/src/dashboard/`, the explorer, or any rendered page), load and follow the `testing-jinn-app` skill — you have the chrome-devtools MCP wired. Mandatory for human-surface changes; skip with a logged reason otherwise.

## 7. Stage 8 — verify, then ship the PR

**Verify before claiming.** For every package you touched, run its own gate and read the output:
```bash
yarn typecheck && yarn test        # in the touched package
```
Red ⇒ fix or escalate. Never open a PR on red.

Then, in this order:
```bash
gh pr create --draft --repo Jinn-Network/mono \
  --base next \
  --title "<shape>(<scope>): <one-line summary>" \
  --body "<problem-not-solution summary, test plan, 'Closes #<N>'>" \
  --label engine:review
```
- `--base` is the **stack base** the dispatcher named, if it named one — not `next`.
- **`Closes #<N>` is load-bearing**: it links the PR to the issue and auto-closes it on merge.
- `engine:review` is what makes the review loop see your PR.

Confirm it exists (`gh pr list --head <branch>` — zero PRs means the create failed silently), then **set the issue's Project `Status` to `In Review`**.

> **This last step is the one that must not be skipped.** The dispatcher's in-flight set keys on `In Progress`; `In Review` is what tells it you finished, releases your concurrency slot, and records the session as `pr-opened`. Without it your session looks stuck forever.

## 8. Escalation

When you genuinely cannot proceed — mis-scoped issue, a human product/design decision is needed, triage came back non-clear, or the review loop is not converging:

1. Write a structured note (as an issue comment): **Where I got to** / **Why I stopped** / **Status** (`needs-decision` | `blocked` | `stuck`).
2. Set the issue's `Blocked on` field to `Human`.
3. Stop.

**Never open a PR from a failed or escalated pipeline.** An escalated issue is parked (it leaves the in-flight set and surfaces in the operator's Human lane) — that is a clean outcome, not a failure.

## 9. Failure table

| Situation | Action |
|-----------|--------|
| `triage:check` non-clear or nonzero exit | Comment the verdict, `Blocked on: Human`, stop. |
| Implementation child returns zero commits | Re-delegate once naming the gap; still zero ⇒ escalate `stuck`. |
| Tests/typecheck red and the fix isn't obvious | Escalate `stuck` — never open a red PR. |
| Reviewers keep finding blocking issues (not converging) | Escalate `stuck` with the recurring theme named. |
| Cannot push / cannot create the PR | Escalate `blocked` (do not retry blindly). |
| A child reports it needs to delegate further | Do that work in a child of your own — you are the only orchestrator. |
