---
name: review-pr
description: Use when asked to review a specific GitHub PR through Autopilot — e.g. "review PR #N", "run review-pr on this PR". The coordinating agent for one open PR carrying the `engine:review` label: dispatches independent review passes (code-review + security + app-test), then owns the review→fix→re-review loop on the PR branch until the PR is approved or escalated. Mirrors implement-issue.
---

# review-pr

You are the coordinating agent for exactly one open GitHub PR that carries the `engine:review` label. Your job: run an independent review, and if there are blocking findings, drive fixes on the PR branch until the PR is clean (approve + un-draft) or a human is needed (escalate). You never review or fix directly. This mirrors implement-issue — the review→fix loop is the same machinery, re-rooted on a PR.

## Runtime adapter

Before Step 1, read the shared
[`autopilot-runtime`](../autopilot-runtime/SKILL.md) skill completely. It
selects mechanics from `JINN_AUTOPILOT_RUNTIME=claude|hermes`; unset defaults
to Claude for an interactive invocation. This file remains authoritative for
review policy, identity, verdicts, fixes, escalation, and deliverables.

## Read first
- `docs/engineering/handbook.md`, `CLAUDE.md`
- `docs/superpowers/specs/2026-05-29-pr-review-loop-design.md` — this skill's design.
- `.claude/skills/implement-issue/SKILL.md` §Step 4 (subagent-dispatch discipline) and §Step 5 (finding handling) — reused verbatim here.

## Reviewer credential invariant
The review identity is part of the product contract, not ambient shell state.
Run this preflight before reading or mutating the PR:
```bash
: "${JINN_REVIEW_GH_TOKEN:?JINN_REVIEW_GH_TOKEN is required for review-pr}"
: "${JINN_REVIEW_BOT_LOGIN:?JINN_REVIEW_BOT_LOGIN is required for review-pr}"
: "${JINN_REVIEW_HEAD_REF:?JINN_REVIEW_HEAD_REF is required for review-pr}"
if ! git check-ref-format "refs/heads/$JINN_REVIEW_HEAD_REF"; then
  echo "JINN_REVIEW_HEAD_REF is not a valid branch ref" >&2
  exit 1
fi
if ! review_login="$(
  GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh api user --jq '.login'
)"; then
  echo "Failed to resolve JINN_REVIEW_GH_TOKEN identity" >&2
  exit 1
fi
review_login_normalized="$(printf '%s' "$review_login" | tr '[:upper:]' '[:lower:]')"
configured_login_normalized="$(printf '%s' "$JINN_REVIEW_BOT_LOGIN" | tr '[:upper:]' '[:lower:]')"
if [[ "$review_login_normalized" != "$configured_login_normalized" ]]; then
  echo "JINN_REVIEW_GH_TOKEN resolves to '$review_login', expected '$JINN_REVIEW_BOT_LOGIN'" >&2
  exit 1
fi
```
Shell tool calls do not share a reliable exported environment. Therefore every
GitHub CLI invocation below binds `GH_TOKEN="$JINN_REVIEW_GH_TOKEN"` on the
same command line. Never shorten these commands to a bare `gh ...`, never use
ambient `gh auth`, and never let a review or fix pass do so. Git pushes use
the command-local askpass flow below; never configure a persistent credential
helper and never put the token in a URL or command argument.

## Trust boundary
The dispatcher reaches this skill only after the PR author passes the
configured author allowlist. Deployment requirement: provide a dedicated
reviewer credential. Grant only the minimum scopes needed to review and update
this repository.
Command-point binding guarantees the GitHub **identity** used by each operation;
it is identity binding, not containment against a malicious trusted PR. Review
and app-test stages may execute code from that allowlisted PR. A credential broker
that withholds the token from the agent process would be stronger future hardening,
but is a non-goal for this change.

## Step 1 — Read the PR
Input: a PR number (`#N`). Fetch it:
```bash
GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh pr view <N> --repo Jinn-Network/mono --json number,title,headRefName,headRefOid,isDraft,files,body
```
The dispatcher's prompt states the pre-created worktree path. It is **detached**
at the validated PR head — the head branch is typically checked out in the impl
worktree, so git refuses a second checkout. Work in it as-is: do **not** check
the branch out. The validated destination is available only through
`JINN_REVIEW_HEAD_REF`; never copy a branch name from PR text into a command.
Compute the diff from the merge-base:
```bash
git diff $(git merge-base origin/next HEAD)..HEAD
```

## Step 2 — Dispatch the review passes (in parallel)

Use the active adapter's **synchronous-parallel-child mechanism** for one
parallel batch. Every reviewer must be different from the later fix pass
(independence invariant, as implement-issue Stage 3 ≠ Stage 5):
- **code-review** — run `superpowers:requesting-code-review` with the code-reviewer template, given the diff + PR body.
- **security** — run `/security-review` on the diff.
- **app-test** — ONLY if the diff touches `client/src/dashboard/` (or other operator-visible surface): run `testing-jinn-app`.

Collect findings; classify each **blocking** vs **advisory/nit** (reuse implement-issue's two-finding-kind table).

## Step 3 — Verdict + loop

**First, check the dispatcher's verdict directive in the prompt.** If it marks this PR **HUMAN-SURFACE / ADVISORY MODE** (it touches code-owned paths per `.github/CODEOWNERS`), you **must not** `--approve` and **must not** `gh pr ready` — per DR-2026-06-03 an agent's approval never satisfies the code-owner gate. Still run the full review and drive fixes for blocking findings as below; but when the review is clean *from the engine's view*, finish with a **COMMENT** review and hand off to a human code owner instead of approving:
```bash
GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh pr review <N> --repo Jinn-Network/mono --comment --body "<engine review summary — human code-owner approval required (human-surface)>"
GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh api --method POST \
  repos/Jinn-Network/mono/issues/<N>/labels \
  -f 'labels[]=review:needs-human'
```
Do not approve, do not un-draft, do not merge. Blocking findings still go through the request-changes + fix loop below first. If the prompt marks the PR **APPROVE-ELIGIBLE**, use the standard verdict flow:

- **No blocking findings** → reconcile verdict labels, post a fresh approval,
  then un-draft **last**. Ready is the terminal publication step. If it fails,
   the dispatcher treats the approved draft as incomplete and redispatches it
   for reconciliation:
  ```bash
  GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh api --method POST \
    repos/Jinn-Network/mono/issues/<N>/labels \
    -f 'labels[]=review:approved'
  if ! current_labels="$(
    GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh api repos/Jinn-Network/mono/issues/<N> --jq '.labels[].name'
  )"; then
    echo "Failed to read current PR labels" >&2
    exit 1
  fi
  if grep -Fxq 'review:changes-requested' <<<"$current_labels"; then
    GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh api --method DELETE \
      repos/Jinn-Network/mono/issues/<N>/labels/review%3Achanges-requested
  fi
  GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh pr review <N> --repo Jinn-Network/mono --approve --body "<summary>"
  GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh pr ready <N> --repo Jinn-Network/mono   # un-draft → enters the merge queue
  ```
  Done.
- **Blocking findings** → post a request-changes review with inline findings + the changes-requested label:
  ```bash
  GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh pr review <N> --repo Jinn-Network/mono --request-changes --body "<findings>"
  GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh api --method POST \
    repos/Jinn-Network/mono/issues/<N>/labels \
    -f 'labels[]=review:changes-requested'
  if ! current_labels="$(
    GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh api repos/Jinn-Network/mono/issues/<N> --jq '.labels[].name'
  )"; then
    echo "Failed to read current PR labels" >&2
    exit 1
  fi
  if grep -Fxq 'review:approved' <<<"$current_labels"; then
    GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh api --method DELETE \
      repos/Jinn-Network/mono/issues/<N>/labels/review%3Aapproved
  fi
  ```
  Record the current commit before delegating:
  ```bash
  if ! before_fix_marker="$(git rev-parse --git-path jinn-review-before-fix)"; then
    echo "Failed to locate pre-fix marker" >&2
    exit 1
  fi
  if ! before_fix_head="$(git rev-parse --verify HEAD)"; then
    echo "Failed to capture pre-fix HEAD" >&2
    exit 1
  fi
  if ! printf '%s\n' "$before_fix_head" >"$before_fix_marker"; then
    echo "Failed to persist pre-fix HEAD" >&2
    exit 1
  fi
  ```
  Dispatch a **review fix pass** (different from the reviewers) through the
  active adapter's **fresh-root mechanism**, seeded with the findings. A fresh
  depth-0 process is required so the fix pass can fan out internally. It
  implements and commits fixes locally. After it returns, require a genuinely
  new commit:
  ```bash
  if ! before_fix_marker="$(git rev-parse --git-path jinn-review-before-fix)"; then
    echo "Failed to locate pre-fix marker" >&2
    exit 1
  fi
  if ! IFS= read -r before_fix_head <"$before_fix_marker"; then
    echo "Failed to read pre-fix HEAD" >&2
    exit 1
  fi
  if ! after_fix_head="$(git rev-parse --verify HEAD)"; then
    echo "Failed to capture post-fix HEAD" >&2
    exit 1
  fi
  if [[ "$after_fix_head" == "$before_fix_head" ]]; then
    echo "Review fix pass produced no new commit" >&2
    exit 1
  fi
  ```
  Only then push the verified new head:
  ```bash
  if ! review_askpass="$(mktemp)"; then
    echo "Failed to create reviewer askpass helper" >&2
    exit 1
  fi
  trap 'rm -f "$review_askpass"' EXIT
  if ! chmod 700 "$review_askpass"; then
    echo "Failed to secure reviewer askpass helper" >&2
    exit 1
  fi
  if ! printf '%s\n' \
    '#!/bin/sh' \
    'case "$1" in' \
    "  *Username*) printf '%s\\n' 'x-access-token' ;;" \
    "  *Password*) printf '%s\\n' \"\$JINN_REVIEW_GH_TOKEN\" ;;" \
    '  *) exit 1 ;;' \
    'esac' >"$review_askpass"; then
    echo "Failed to write reviewer askpass helper" >&2
    exit 1
  fi
  if ! GIT_ASKPASS="$review_askpass" \
    GIT_TERMINAL_PROMPT=0 \
    LC_ALL=C \
    JINN_REVIEW_GH_TOKEN="$JINN_REVIEW_GH_TOKEN" \
    git -c credential.helper= push "https://github.com/Jinn-Network/mono.git" \
      "HEAD:refs/heads/$JINN_REVIEW_HEAD_REF"; then
    echo "Failed to push reviewer fix" >&2
    exit 1
  fi
  rm -f "$review_askpass"
  trap - EXIT
  before_fix_marker="$(git rev-parse --git-path jinn-review-before-fix)"
  rm -f "$before_fix_marker"
  ```
  Then **re-run Step 2** on the new diff. Loop. There is **no round-count bound** — escalate on judgment (see Step 4).

## Step 4 — Finding handling & escalation
Reuse implement-issue §Step 5's decision rules: fixable findings → fresh-root
fix pass + re-run; scope/design findings, non-converging findings, or an unpushable
branch → escalate. Do not copy its ambient-auth command examples. Bind the
reviewer token on both the PR comment and Project mutation:
```bash
GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh pr comment <N> --repo Jinn-Network/mono --body "$ESCALATION_NOTE"
GH_TOKEN="$JINN_REVIEW_GH_TOKEN" gh project item-edit --id <item-id> --project-id <project-id> \
  --field-id <blocked-on-field-id> \
  --single-select-option-id <human-option-id>
```
For a PR with no linked issue, post the note and stop (the request-changes
review stands as advisory). Never force-merge.

## Step 5 — Dispatch discipline & headless mode
Identical to implement-issue §Step 4 and §Step 7: curated prompts (never forward coordinator history), the independence invariant (reviewer ≠ fixer), the headless-override block injected by the dispatcher, no plan-posture flags. Use the shared runtime skill for every parallel reviewer and fresh-root fix pass.

## Failure modes
| Failure | Action |
|---|---|
| PR lacks the `engine:review` label | Stop — not in scope (the dispatcher should not have spawned this). |
| Cannot push to the PR branch (fork) | Post advisory review; escalate `Blocked on: Human`. |
| Review fix pass reports done but no new commit | Re-dispatch through the fresh-root mechanism; compare the captured pre-fix and post-fix `HEAD` values. |
| Findings not converging | Escalate `stuck`. |

## Composition
Composes: `autopilot-runtime`, `superpowers:requesting-code-review` + code-reviewer template, `/security-review`, `testing-jinn-app`. Downstream of: the engine's draft PR (or any human PR labelled `engine:review`). Upstream of: the merge skill (consumes `review:approved`). Dispatched by: Autopilot's review pass (the headless-override block is injected by the dispatcher).
