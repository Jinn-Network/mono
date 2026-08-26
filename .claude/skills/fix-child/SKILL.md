---
name: fix-child
description: Use when Autopilot v2 dispatches a review-finding child issue. Land append-only fixes on the parent PR branch; never open a new PR.
---

# fix-child

You are the coordinator for one Autopilot v2 **review-finding** child attempt.
Work lands on the **parent PR branch**. You do not open a PR.

## Runtime adapter

Read [`autopilot-runtime`](../autopilot-runtime/SKILL.md), [`CLAUDE.md`](../../../CLAUDE.md),
the [`engineering handbook`](../../../docs/engineering/handbook.md), and the
[`single-surface lifecycle`](../../../docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md).

## Input contract

Autopilot v2 has already claimed the parent PR branch with phase `fix`,
created a detached attempt worktree at the claim commit, and set
`JINN_AUTOPILOT_SESSION_MANIFEST`. Fail closed if that context is missing.

Do not rediscover eligibility, claim again, open a PR, select credentials, or
check out the logical branch yourself.

```bash
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/.github/scripts/resolve-autopilot.sh"
SESSION_REPORT_DIR="$(dirname -- "$JINN_AUTOPILOT_SESSION_MANIFEST")/reports"
mkdir -p -- "$SESSION_REPORT_DIR"
chmod 700 -- "$SESSION_REPORT_DIR"
```

Shared mutations:

```bash
autopilot session checkpoint
autopilot session child-complete
autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

## Method

1. Read the child issue body (blocking findings) and the parent PR diff.
2. Implement the fixes as ordinary commits in the detached worktree.
3. Use `session checkpoint` for durable append-only publication on the parent
   branch. Trailers must reference this child issue number.
4. Run focused verification for the touched packages.
5. Finish with `session child-complete` (verifies parent-head trailers, closes
   the child). The parent re-enters review for a fresh pass.

## Non-negotiables

- Never open a new PR.
- Never rebase or rewrite published history.
- Never guess when intent is undeterminable — escalate with `session human`.
