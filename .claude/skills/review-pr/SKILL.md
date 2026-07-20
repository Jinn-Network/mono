---
name: review-pr
description: Use when Autopilot v2 dispatches an exact-head PR review attempt. Coordinates independent review, fixes, and re-review in one session while delegating all publication, verdict, draft/ready, identity, and recovery authority to the v2 session protocol.
---

# review-pr

You are the review coordinator for one Autopilot v2 exact-head attempt. The
same coordinator session owns the full review → fix → re-review loop. You do
not own shared lifecycle state.

## Runtime adapter

Before doing work, read
[`autopilot-runtime`](../autopilot-runtime/SKILL.md) completely. It selects the
mechanics for the one process-wide
`JINN_AUTOPILOT_RUNTIME=claude|hermes` setting. Never switch runtime within the
attempt.

Also read:

- [`CLAUDE.md`](../../../CLAUDE.md)
- [`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md)
- [`active-active lifecycle design`](../../../docs/superpowers/specs/2026-07-19-active-active-autopilot-lifecycle-design.md)

## Input contract

Autopilot v2 has already won the exact-head review claim, selected a reviewer
identity that is distinct from the PR author, and created a detached attempt
worktree at the claimed head. The prompt supplies the PR, linked issue, exact
head, target base, approval policy, worktree, and attempt. The environment
contains `JINN_AUTOPILOT_SESSION_MANIFEST`.

Fail closed if that context is missing or contradictory. Do not rediscover or
replace it. In particular, do not:

- claim or release review authority;
- select, inspect, export, or replace credentials;
- create, adopt, or remove worktrees;
- check out the logical branch;
- publish branch changes yourself;
- submit native verdicts or mutate labels, Project state, comments, or PR
  draft state yourself.

The session protocol re-reads the manifest and GitHub state at each boundary.
It binds verdicts to the claimed head, publishes fixes atomically with review
authority advancement, and rejects stale sessions.

Resolve the package command once:

```bash
AUTOPILOT_PACKAGE_DIR="${JINN_AUTOPILOT_PACKAGE_DIR:-<repo-root>/packages/autopilot}"
SESSION_REPORT_DIR="$(dirname -- "$JINN_AUTOPILOT_SESSION_MANIFEST")/reports"
mkdir -p -- "$SESSION_REPORT_DIR"
chmod 700 -- "$SESSION_REPORT_DIR"
```

The reports directory is attempt-scoped and outside the supplied worktree.
Every session payload file must use an absolute path below
`"$SESSION_REPORT_DIR"`; never write session payloads into the worktree.

Shared mutations are restricted to:

```bash
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session review-verdict --state REQUEST_CHANGES --body-file "$SESSION_REPORT_DIR/review-verdict.md"
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session review-fix-publish
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session review-verdict --state APPROVE --body-file "$SESSION_REPORT_DIR/review-verdict.md"
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

The draft/ready ordering, review refs, credentials, and cleanup remain
v2-owned. Do not redraft or ready the PR yourself.

## Review pass

Dispatch these independent checks through the
**synchronous-parallel-root mechanism** in one batch:

1. **Code review** — use `superpowers:requesting-code-review` and the
   code-reviewer template with the PR context, acceptance criteria, and exact
   diff.
2. **Security review** — use `/security-review` on every PR.
3. **Jinn-app test** — use `testing-jinn-app` when the change touches an
   operator-visible surface, daemon API, bootstrap flow, dashboard, or app
   domain model.

Compute the change from the supplied target-base merge-base. Do not use a
moving two-dot range. Collect every result before deciding. Classify findings:

- **blocking** — correctness, security, missing coverage, failed acceptance
  criteria, or a failing required test;
- **advisory** — useful improvement that does not block the change;
- **scope/design** — requires product or architectural judgment.

## No blocking findings

If the attempt policy is `approve-eligible`, write a bounded UTF-8 verdict
body to `"$SESSION_REPORT_DIR/review-verdict.md"` that summarizes the checks
and advisory findings, then invoke:

```bash
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session review-verdict --state APPROVE --body-file "$SESSION_REPORT_DIR/review-verdict.md"
```

The command verifies exact authority and identity, publishes a marker-bound
native approval, projects state, and makes the PR ready last. Stop after it
succeeds.

If the policy is `human-codeowner`, never attempt automated approval. Write a
reason to `"$SESSION_REPORT_DIR/human-reason.md"` explaining that the engine
review is clean but Human CODEOWNER approval is required, then invoke:

```bash
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

Human review and CI remain authoritative. The PR may remain draft while held
for Human judgment.

## Blocking findings: fix and re-review

Write bounded UTF-8 findings to `"$SESSION_REPORT_DIR/review-verdict.md"` with
actionable, file-specific blocking findings and any advisory findings. First
invoke:

```bash
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session review-verdict --state REQUEST_CHANGES --body-file "$SESSION_REPORT_DIR/review-verdict.md"
```

This marker-bound transition records requested changes and makes the PR draft
before mutation. If it does not return fixing authority, stop.

Dispatch a fresh-root fixer through the **fresh-root mechanism** with the exact
findings and PR context. The
reviewer and fixer must be different fresh contexts. The fixer implements,
tests, and commits the fixes locally; it does not publish them. Verify that the
worktree is clean and has a genuinely new commit rooted at the supplied old
head.

Publish only through:

```bash
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session review-fix-publish
```

The command atomically advances the PR branch and append-only review ref under
exact expected heads, then advances the manifest. An ambiguous or stale result
is not permission to publish another way.

Now re-run the full review pass against the new manifest head. Re-review uses a
fresh reviewer context after every published fix. Continue inside this same
coordinator session until clean or escalated.

There is no round-count budget. Continue converging implementation fixes;
escalate immediately for scope/design findings or when the loop is genuinely
not converging.

## Escalation

Write a bounded UTF-8 reason to `"$SESSION_REPORT_DIR/human-reason.md"`
containing:

- the exact current head and last completed review pass;
- the blocking finding or ambiguity;
- status: `needs-decision`, `blocked`, or `stuck`;
- whether any local commit has not been published.

Then invoke:

```bash
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

Do not make any later shared mutation. v2 records the Human review authority,
keeps a draft recovery surface, and preserves local artifacts.

## Dispatch discipline

- Reviewer and fixer contexts receive curated prompts with the authority
  capsule below, never coordinator history.
- Every delegated-root prompt must state that the exact-head review claim and canonical
  PR already exist; the worktree must remain detached; direct GitHub, remote
  Git, credential, branch, draft/ready, review, Project, cleanup, and
  `autopilot session` operations are prohibited. Reviewers return findings
  only. A fixer may create tested local commits only, for coordinator
  publication. Contradictory attempt context must stop and be reported without
  a shared mutation.
- Reviewer and fixer must be different fresh contexts.
- Every re-review is fresh and sees the exact new head.
- Stage reports are evidence to evaluate, not proof of completion.
- Do not run code from a PR whose author failed the dispatcher allowlist.
- If a session command rejects authority, stop without fallback.

## Invariants on return

Downstream may rely on exactly one of:

1. a marker-bound approval exists for the exact current head and v2 readied
   the approve-eligible PR last;
2. requested changes were followed by an atomic fix publication and a fresh
   re-review in this coordinator session;
3. v2 recorded a Human hold and retained the draft recovery surface; or
4. the attempt lost/failed authority and performed no later shared mutation.
