---
name: implement-issue
description: Use when Autopilot v2 dispatches implementation for one claimed GitHub issue. Coordinates the complete eight-stage implementation and internal review workflow in the supplied detached attempt worktree, publishing progress and terminal state only through the v2 session protocol.
---

# implement-issue

You are the implementation coordinator for one Autopilot v2 attempt. Run the
canonical implementation methodology; do not own the shared lifecycle.

## Runtime adapter

Before doing work, read
[`autopilot-runtime`](../autopilot-runtime/SKILL.md) completely. It selects
process mechanics from the one process-wide
`JINN_AUTOPILOT_RUNTIME=claude|hermes` setting. The configured runtime applies
to the coordinator and every stage; never select a different runtime for an
individual stage.

Also read:

- [`CLAUDE.md`](../../../CLAUDE.md)
- [`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md)
- [`active-active lifecycle design`](../../../docs/superpowers/specs/2026-07-19-active-active-autopilot-lifecycle-design.md)

## Input contract

Autopilot v2 has already won the implementation branch claim, created the
early draft PR, projected the issue to `In Progress`, selected the implementer
credential, and created a detached attempt worktree. The session prompt names
the issue, PR, target base, branch, worktree, and attempt. The environment
contains `JINN_AUTOPILOT_SESSION_MANIFEST`, and the current directory is the
detached attempt worktree.

Fail closed if that context is absent or contradictory. Do not fall back to
the legacy hand-invoked workflow. In particular:

- do not run discovery, eligibility, claiming, or the old reality check;
- do not create or adopt a branch, PR, or worktree;
- do not check out the logical branch in the detached worktree;
- do not select, validate, or replace credentials;
- do not change Project fields, labels, comments, reviews, or draft state;
- do not remove or recreate local artifacts.

The v2 session commands re-read the manifest and GitHub state at the last
possible moment, reject stale authority, publish with the required lease, and
reconcile ambiguous outcomes. A missing local worktree on another host is
never evidence about this attempt.

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

## Authority

You may inspect and modify files in the supplied worktree, run tests and local
tools, and create local commits. Shared publication is restricted to:

```bash
autopilot session checkpoint
autopilot session implementation-complete --summary-file "$SESSION_REPORT_DIR/implementation-summary.md"
autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

Never substitute direct GitHub or remote-Git mutations for these commands. If
a session command rejects authority or reports contradictory state, stop. Do
not retry by weakening its checks.

## Canonical stage methodologies

All full-pipeline shapes retain the eight stages and their internal
self-review. The active runtime adapter resolves the method names to the
closest installed runtime skill without removing a gate.

| Stage | Method skill |
|---|---|
| 1 — Design | `superpowers:brainstorming` |
| 2 — Plan | `superpowers:writing-plans` |
| 3 — Implement | `superpowers:test-driven-development` then `superpowers:executing-plans` |
| 4 — Code review | `/code-review` |
| 5 — Independent review | `superpowers:requesting-code-review` |
| 6 — Security review | `/security-review` |
| 7 — Jinn-app test | `testing-jinn-app` |
| 8 — Verify + handoff | `superpowers:verification-before-completion` |

Effort controls depth, not gates:

- Low-effort `docs` or `chore`: compress Stages 1–2 to a short note and plan.
- Medium/High/XHigh/Max: run every stage at the corresponding depth.
- `refactor`: Stage 1 is always full and uncompressed.

## Stage flow

### 1. Design

Use the active adapter’s fresh-root mechanism. Explore relevant code,
constraints, and existing patterns; compare plausible approaches; return a
short design note that covers every acceptance criterion.

### 2. Plan

Use the single-root mechanism with the design note. Return an actionable
step-by-step plan mapping acceptance criteria to tasks and verification.

### 3. Implement

Use the fresh-root mechanism with the issue, design, and plan. For `fix`, write
and observe the failing regression first. For every shape, follow TDD and
commit the completed work locally.

Externally verify a real local commit exists beyond the attempt’s supplied
starting head. If none exists, re-run the stage with that exact gap.

After every commit-producing stage or fix pass, publish real progress:

```bash
autopilot session checkpoint
```

Only branch-head advancement is liveness evidence. Comments, Project edits,
CI activity, session logs, and local process existence are not progress.

### 4. Code review

Use a fresh-root `/code-review` context to tighten reuse, clarity, and surface
area and to self-review the change. If it creates fix commits, checkpoint them
before continuing. Structural concerns enter the finding loop.

### 5. Independent internal review

Use a fresh-root context that has not seen the Stage 3 implementer’s work.
Provide the issue, acceptance criteria, and the exact change diff from the
attempt target-base merge-base.

The Stage 3 implementer and the Stage 5 reviewer must be different sessions.
The reviewer has send-back authority. Re-review after a fix stays with the
independent reviewer.

### 6. Security review

Use the single-root mechanism on every full pipeline. Treat blocking
security findings exactly like blocking Stage 5 findings.

### 7. Jinn-app test

Run `testing-jinn-app` when the change touches an operator-visible surface,
daemon API, bootstrap flow, dashboard, or an app-spec domain model. It is
mandatory for `human-surface` work and must produce the required verification
artifact. Otherwise record the skip reason.

### 8. Verify and hand off

Use the single-root mechanism. Run the repository-required typecheck,
tests, build, and any shape-specific checks against the exact local head. Do
not open a PR: v2 created the canonical early draft PR before this session.

Write a bounded UTF-8 summary to
`"$SESSION_REPORT_DIR/implementation-summary.md"` containing:

- implementation summary;
- tests and verification run;
- internal review/security/app-test results;
- human-surface compliance and artifact link when applicable;
- any remaining non-blocking caveats.

Then invoke:

```bash
autopilot session implementation-complete --summary-file "$SESSION_REPORT_DIR/implementation-summary.md"
```

This command checkpoints the exact head, writes durable summary evidence,
runs the three-op finalize (completion marker → `engine:review` label →
undraft), and makes the existing PR non-draft only after the implementation
session ends. It enforces ready-last ordering. Project Status is paint-only —
the session never reads or writes it. Do nothing after successful completion
except return the result; v2 owns cleanup.

## Finding handling

| Finding | Action |
|---|---|
| Fixable implementation/test/review finding | Re-run the responsible implementation context with the findings, commit, checkpoint, then re-run the gate. |
| Scope, product, or design decision | Escalate immediately. |
| Non-converging findings | Escalate on judgment. |

There is no round-count budget. A legitimate multi-round correction may
continue; a design wall must not be disguised as another fix round.

For escalation, write a bounded UTF-8 reason to
`"$SESSION_REPORT_DIR/human-reason.md"` with:

- where the pipeline stopped;
- the exact blocking finding;
- status: `needs-decision`, `blocked`, or `stuck`;
- the latest checkpointed head and any uncheckpointed local state.

Then invoke:

```bash
autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

Escalation authority is the PR label `review:needs-human` plus the structured
marker comment — not Project Status. The early draft PR remains the recovery
surface. Do not close it, ready it, or clean the worktree yourself.

## Shape variants

- `feat`, `fix`, `chore`, `docs`, `test`, `refactor`: run all eight stages.
- `spike`, `incident`, `design`: run Stages 1–2 only, commit and checkpoint any
  produced artifact, then use the Human session command with
  `needs-decision`. The existing early draft PR is preserved for resumption.

## Dispatch discipline

- Give every stage a curated prompt: its task, issue context, worktree and
  target base, the authority capsule below, and only relevant prior outputs.
- Every delegated-root prompt must include this authority capsule:
  - the canonical early draft PR already exists and the coordinator alone owns
    lifecycle session commands;
  - the supplied attempt worktree must remain detached; never check out or
    create the logical branch;
  - the root must not push, create or ready a PR, submit a review, mutate
    GitHub or Project state, select credentials, or clean local artifacts;
  - the root must not invoke `autopilot session`; it may inspect/edit/test and,
    only when its stage permits, create local commits for the coordinator;
  - if the supplied attempt identity, head, base, worktree, or authority is
    contradictory, the root must stop and report the contradiction without a
    shared mutation.
- Never forward the coordinator’s conversation history.
- Depth-needing Stages 1, 3, 4, and 5 use fresh-root processes.
- Stages 2, 6, 7, and 8 use single-root processes. Every delegated stage goes
  through `stage:run`; none inherits coordinator authority.
- The Stage 3 implementer and Stage 5 reviewer are separate fresh roots.
- Compute review diffs from the supplied target-base merge-base, never from a
  moving two-dot range.
- Verify external local state after stages; do not trust a “done” report.

## Invariants on return

Downstream may rely on exactly one of:

1. `implementation-complete` succeeded for the exact owned head and v2 made
   the existing PR ready last; or
2. `human` succeeded and v2 preserved a draft Human recovery surface; or
3. a session command rejected stale/ambiguous authority and this coordinator
   stopped without further shared mutation.
