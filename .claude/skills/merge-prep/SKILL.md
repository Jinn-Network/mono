---
name: merge-prep
description: Use when Autopilot v2 dispatches an exact-head merge-prep attempt for a reviewed PR that is behind or conflicting. Resolves mechanical conflicts locally, then delegates publication, ready state, escalation, and cleanup to the v2 session protocol.
---

# merge-prep

You are the coordinator for one Autopilot v2 merge-prep attempt. Prepare a
reviewed PR for the ordinary merge gates; never merge it.

## Runtime and input

Read
[`autopilot-runtime`](../autopilot-runtime/SKILL.md),
[`CLAUDE.md`](../../../CLAUDE.md), the
[`engineering handbook`](../../../docs/engineering/handbook.md), and the
[`active-active lifecycle design`](../../../docs/superpowers/specs/2026-07-19-active-active-autopilot-lifecycle-design.md).
The one process-wide `JINN_AUTOPILOT_RUNTIME=claude|hermes` setting applies to
this coordinator and any child; never override it per stage.

Autopilot v2 has already:

- verified exact-head approval, changed-file completeness, and non-CODEOWNER
  eligibility;
- won the merge-prep branch claim and made the PR draft;
- selected the implementer identity;
- created a detached attempt worktree at the claim commit;
- pinned the exact target-base OID.

The prompt supplies those values and the environment contains
`JINN_AUTOPILOT_SESSION_MANIFEST`. Fail closed if they are absent or
contradictory. Do not rediscover eligibility, claim again, check out the
logical branch, select credentials, or create/remove worktrees.

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
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session merge-prep-complete --summary-file "$SESSION_REPORT_DIR/merge-prep-summary.md"
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

The session protocol owns conditional publication, completion evidence,
Project projection, ready-last ordering, ambiguous-outcome reconciliation,
and cleanup.

## Charter

**Mechanical** conflicts have one behavior-preserving resolution visible from
the two patches:

- lockfile regeneration;
- import or formatting collisions;
- adjacent non-overlapping edits;
- rename/path ports;
- a clean stale-base rebase.

**Semantic** conflicts require choosing behavior or redesigning overlapping
logic:

- incompatible changes to the same function;
- competing abstraction or schema directions;
- a resolution whose correctness depends on runtime/product intent;
- any change to a CODEOWNER-sensitive path.

Resolve Mechanical conflicts only. For Semantic, CODEOWNER, ambiguous, or
unproven conflicts, never guess.

## Prepare locally

1. Confirm the current detached head and target-base OID match the supplied
   attempt context.
2. Rebase the detached attempt locally onto the exact target-base OID. Do not
   substitute a moving remote branch name.
3. Inspect every conflict before editing. If any conflict is Semantic, abort
   the local rebase and escalate.
4. Resolve only Mechanical conflicts, stage them, and continue the rebase.
5. Regenerate mechanical artifacts such as lockfiles with their canonical
   tool; do not hand-edit generated output.
6. Run focused tests plus the repository-required verification for affected
   packages.
7. Require a clean worktree and a genuinely changed tree rooted at the exact
   target-base OID.

Do not publish the prepared commits yourself. The completion command performs
an independent conservative classification and rejects results that are not
provably mechanical.

## Complete

Write a bounded UTF-8 summary to
`"$SESSION_REPORT_DIR/merge-prep-summary.md"` containing:

- old claimed head and exact target-base OID;
- conflicts encountered and why each resolution was Mechanical;
- generated artifacts refreshed;
- verification commands and results.

Then invoke:

```bash
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session merge-prep-complete --summary-file "$SESSION_REPORT_DIR/merge-prep-summary.md"
```

The command validates the attempt and PR, classifies the prepared result,
publishes under the exact expected branch head, records completion, projects
`In Review`, and makes the PR ready last. The new head must pass independent
review and CI again before merge.

If the command returns partial, ambiguous, stale, or rejected, stop. Do not
bypass it or attempt a second publication path.

## Escalate

For any Semantic, CODEOWNER-sensitive, ambiguous, or unproven conflict, write a
bounded UTF-8 reason to `"$SESSION_REPORT_DIR/human-reason.md"` with the exact
files/hunks and why mechanical resolution is impossible. Invoke:

```bash
yarn --cwd "$AUTOPILOT_PACKAGE_DIR" autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

Stop afterward. v2 preserves the draft PR and local attempt for Human
intervention. Do not discard local state or clean the attempt yourself.

## Delegated-root discipline

If runtime delegation is used, it must go through `stage:run`, and every
delegated-root prompt must state that the exact-head merge-prep claim and draft
PR already exist; the supplied worktree must remain detached; direct GitHub,
remote Git, credential, branch, draft/ready, review, Project, cleanup, and
`autopilot session` operations are prohibited. The root may inspect, edit,
test, and create local commits only. Contradictory attempt context must stop
and be reported without a shared mutation.

## Invariants on return

Downstream may rely on exactly one of:

1. v2 published a mechanically prepared exact-head result and readied it last
   for full re-review and ordinary merge gates;
2. v2 recorded Human authority and retained the draft recovery surface; or
3. the attempt lost authority and made no later shared mutation.
