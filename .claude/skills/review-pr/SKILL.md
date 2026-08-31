---
name: review-pr
description: Use when Autopilot v2 dispatches an exact-head PR review attempt. Two terminal outcomes only — approve (optionally with non-blocking follow-ups), or request changes and file a finding child. Never fix, never push branches.
---

# review-pr

You are the review coordinator for one Autopilot v2 exact-head attempt. You
read, verdict, file findings or non-blocking follow-ups, and exit. You do not
own shared lifecycle state and you never push to the PR branch.

## Runtime adapter

Before doing work, read
[`autopilot-runtime`](../autopilot-runtime/SKILL.md) completely. It selects the
mechanics for the one process-wide
`JINN_AUTOPILOT_RUNTIME=claude|hermes` setting. Never switch runtime within the
attempt.

Also read:

- [`CLAUDE.md`](../../../CLAUDE.md)
- [`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md)
- [`single-surface lifecycle`](../../../docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md)

## Input contract

Autopilot v2 has already won the exact-head review claim, selected a reviewer
identity that is distinct from the PR author, and created a detached attempt
worktree at the claimed head. The prompt supplies the PR, linked issue, exact
head, target base, approval policy, worktree, and attempt. The environment
contains `JINN_AUTOPILOT_SESSION_MANIFEST`.

Fail closed if that context is missing or contradictory. Do not:

- claim or release review authority yourself;
- select or replace credentials;
- create or remove worktrees;
- check out the logical branch;
- publish branch changes;
- mutate labels, Project state, comments, or draft state yourself.

Resolve Autopilot fail-closed (standalone only; never `packages/autopilot`):

```bash
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/.github/scripts/resolve-autopilot.sh"
SESSION_REPORT_DIR="$(dirname -- "$JINN_AUTOPILOT_SESSION_MANIFEST")/reports"
mkdir -p -- "$SESSION_REPORT_DIR"
chmod 700 -- "$SESSION_REPORT_DIR"
```

The reports directory is attempt-scoped and outside the supplied worktree.
Every session payload file must use an absolute path below
`"$SESSION_REPORT_DIR"`; never write session payloads into the worktree.

Shared mutations are restricted to:

```bash
autopilot session review-verdict --state APPROVE \
  --body-file "$SESSION_REPORT_DIR/review-verdict.md" \
  --follow-ups-file "$SESSION_REPORT_DIR/review-follow-ups.json"
autopilot session review-verdict --state APPROVE --body-file "$SESSION_REPORT_DIR/review-verdict.md"
autopilot session review-findings --file "$SESSION_REPORT_DIR/review-findings.md"
autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

Do **not** call the fix-publish session verb. Reviewers have no branch-push authority.

## Review pass

Dispatch independent checks through the synchronous-parallel-root mechanism:

1. **Code review** — requesting-code-review / code-reviewer with PR context
2. **Security** — only when the diff warrants it
3. **Tests / acceptance** — verify the claimed acceptance criteria

Classify each note:

- **merge-blocking** → Request changes (finding child path below)
- **non-blocking** merge-OK debt / nits → follow-up entry on Approve

Cap ≤5 follow-ups per approve pass. If more, escalate Human or fold into
fewer issues. Never use `review-finding` labels or child markers for
non-blocking notes.

Collect blocking findings into one list. Split into multiple finding children
only when findings are genuinely independent workstreams.

## Terminal outcomes (exactly two)

### Approve

Write `$SESSION_REPORT_DIR/review-verdict.md` with the approval body.

When there are non-blocking notes, also write
`$SESSION_REPORT_DIR/review-follow-ups.json`:

```json
{
  "followUps": [
    {
      "type": "feat",
      "title": "Extract duplicate helper",
      "body": "Non-blocking: …",
      "effort": "low",
      "priority": "p3"
    }
  ]
}
```

`type` is `feat` | `chore` | `fix` | `refactor`. `effort` is
`low` | `medium` | `high` | `xhigh` | `max`. `priority` is
`p0` | `p1` | `p2` | `p3` | `p4`. Omit the file or use `"followUps": []`
for a clean approve.

Then invoke APPROVE, with `--follow-ups-file` only when the JSON file is
present and non-empty:

```bash
autopilot session review-verdict --state APPROVE \
  --body-file "$SESSION_REPORT_DIR/review-verdict.md" \
  --follow-ups-file "$SESSION_REPORT_DIR/review-follow-ups.json"
```

or, with no follow-ups:

```bash
autopilot session review-verdict --state APPROVE --body-file "$SESSION_REPORT_DIR/review-verdict.md"
```

Exit. Do not push. Do not re-draft. Follow-ups are ordinary triage-complete
issues; they never gate the parent PR.

### Request changes

Write `$SESSION_REPORT_DIR/review-findings.md` listing every blocking finding
(markdown). Then:

```bash
autopilot session review-findings --file "$SESSION_REPORT_DIR/review-findings.md"
```

The session files one `review-finding` child, publishes native REQUEST_CHANGES,
releases the review claim, and exits. A separate fix-child session lands the
fixes on the parent branch.

## Human escalation

If intent is undeterminable from the record, or the surface is CODEOWNER-
reserved:

```bash
autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

## Non-negotiables

- Never push to the PR branch.
- Never call the fix-publish session verb.
- Never redraft or ready the PR yourself.
- Never guess on undeterminable intent.
- Never park non-blocking notes as `review-finding` children.
