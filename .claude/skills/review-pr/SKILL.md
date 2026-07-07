---
name: review-pr
description: Use when asked to review a specific GitHub PR through Autopilot — e.g. "review PR #N", "run review-pr on this PR". The coordinating agent for one open PR carrying the `engine:review` label: dispatches independent review subagents (code-review + security + app-test), then owns the review→fix→re-review loop on the PR branch until the PR is approved or escalated. Mirrors implement-issue.
---

# review-pr

You are the coordinating agent for exactly one open GitHub PR that carries the `engine:review` label. Your job: run an independent review, and if there are blocking findings, drive fixes on the PR branch until the PR is clean (approve + un-draft) or a human is needed (escalate). You dispatch a fresh subagent per stage; you never review or fix directly. This mirrors implement-issue — the review→fix loop is the same machinery, re-rooted on a PR.

## Read first
- `docs/engineering/handbook.md`, `CLAUDE.md`
- `docs/superpowers/specs/2026-05-29-pr-review-loop-design.md` — this skill's design.
- `.claude/skills/implement-issue/SKILL.md` §Step 4 (subagent-dispatch discipline) and §Step 5 (finding handling) — reused verbatim here.

## Step 1 — Read the PR
Input: a PR number (`#N`). Fetch it:
```bash
gh pr view <N> --repo Jinn-Network/mono --json number,title,headRefName,headRefOid,isDraft,files,body
```
The dispatcher's prompt states the pre-created worktree path (on the PR head branch). Compute the diff from the merge-base:
```bash
git diff $(git merge-base origin/next HEAD)..HEAD
```

## Step 2 — Dispatch the review subagents (in parallel)
Dispatch fresh subagents — each different from any fix subagent (independence invariant, as implement-issue Stage 3 ≠ Stage 5):
- **code-review** — run `superpowers:requesting-code-review` with the code-reviewer template, given the diff + PR body.
- **security** — run `/security-review` on the diff.
- **app-test** — ONLY if the diff touches `client/src/dashboard/` (or other operator-visible surface): run `testing-jinn-app`.

Collect findings; classify each **blocking** vs **advisory/nit** (reuse implement-issue's two-finding-kind table).

## Step 3 — Verdict + loop
- **No blocking findings** → post an approving review and the verdict label, then un-draft:
  ```bash
  gh pr review <N> --repo Jinn-Network/mono --approve --body "<summary>"
  gh pr edit <N> --repo Jinn-Network/mono --add-label "review:approved" --remove-label "review:changes-requested"
  gh pr ready <N> --repo Jinn-Network/mono   # un-draft → enters the merge queue
  ```
  Done.
- **Blocking findings** → post a request-changes review with inline findings + the changes-requested label:
  ```bash
  gh pr review <N> --repo Jinn-Network/mono --request-changes --body "<findings>"
  gh pr edit <N> --repo Jinn-Network/mono --add-label "review:changes-requested" --remove-label "review:approved"
  ```
  Then dispatch a **fix subagent** (different from the reviewers) seeded with the findings. It implements fixes on the PR branch, commits, and pushes:
  ```bash
  git push origin HEAD:<headRefName>
  ```
  Then **re-run Step 2** on the new diff. Loop. There is **no round-count bound** — escalate on judgment (see Step 4).

## Step 4 — Finding handling & escalation
Reuse implement-issue §Step 5 verbatim: fixable findings → fix subagent + re-run; scope/design findings, non-converging findings, or an unpushable branch (e.g. a fork PR you cannot push to) → escalate. Escalation = post the structured note as a PR comment and set the PR's linked issue (if any) `Blocked on: Human`; for a PR with no linked issue, post the note and stop (the request-changes review stands as advisory). Never force-merge.

## Step 5 — Subagent-dispatch discipline & headless mode
Identical to implement-issue §Step 4 and §Step 7: curated prompts (never forward coordinator history), the independence invariant (reviewer ≠ fixer), the headless-override block injected by the dispatcher, no plan-posture flags.

## Failure modes
| Failure | Action |
|---|---|
| PR lacks the `engine:review` label | Stop — not in scope (the dispatcher should not have spawned this). |
| Cannot push to the PR branch (fork) | Post advisory review; escalate `Blocked on: Human`. |
| Fix subagent reports done but no new commit | Re-dispatch; verify with `git log origin/<headRefName>..HEAD`. |
| Findings not converging | Escalate `stuck`. |

## Composition
Composes: `superpowers:requesting-code-review` + code-reviewer template, `/security-review`, `testing-jinn-app`. Downstream of: the engine's draft PR (or any human PR labelled `engine:review`). Upstream of: the merge skill (consumes `review:approved`). Dispatched by: Autopilot's `eng-loop` review pass (the headless-override block is injected by the dispatcher).
