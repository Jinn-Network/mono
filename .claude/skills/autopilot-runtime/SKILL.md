---
name: autopilot-runtime
description: Shared process and child-dispatch mechanics for Jinn Autopilot's implement-issue, review-pr, fix-child, and reconcile workflows. Consume this skill from those canonical workflows; it does not define their lifecycle, gates, authority, or deliverables.
---

# autopilot-runtime

This skill is the single runtime-mechanics adapter for Autopilot. The canonical
`implement-issue`, `review-pr`, `fix-child`, and `reconcile` skills own their
distinct lifecycle policy, authority boundaries, gates, retry behavior, and
deliverables. Do not copy those workflow rules here, and do not copy runtime
mechanics back into a workflow skill.

## Select one process-wide runtime

Read `JINN_AUTOPILOT_RUNTIME` before dispatching any child or fresh-root stage:

- `claude` → read [`references/claude.md`](references/claude.md) completely.
- `hermes` → read [`references/hermes.md`](references/hermes.md) completely.
- `cursor` → read [`references/cursor.md`](references/cursor.md) completely.
- unset → use Claude and read the Claude reference.
- any other value → stop with an invalid-runtime error.

The selection applies to the coordinator and every child or fresh-root stage.
There is no per-stage override, fallback, or mixed-runtime routing.
Hermes uses the repository's stateless launcher and installed skills exactly as
configured. No upstream Hermes change is required.

## Preserve v2 attempt context

The calling workflow starts in the supplied detached attempt worktree and
receives `JINN_AUTOPILOT_SESSION_MANIFEST`. Preserve the supplied worktree as
the working directory. The coordinator retains its sanitized attempt
environment, but a stage process must not inherit publication or lifecycle
capability: `stage:run` strips `GH_TOKEN`, equivalent GitHub credentials,
Git/SSH credential paths, and `JINN_AUTOPILOT_SESSION_MANIFEST` before every
delegated root launch while preserving the process-wide runtime configuration.
All delegated stage work, including lightweight work and parallel review
checks, must use `stage:run`; an in-process child mechanism would retain the
coordinator capability and is prohibited. Prompt instructions are defense in
depth, not the credential boundary.

This mechanics skill does not read, advance, or replace lifecycle authority.
Only the workflow coordinator's v2 session commands consume the manifest to
perform shared mutations.

## Mechanism vocabulary

Canonical workflow skills assign work to one of these mechanisms:

- **fresh-root mechanism** — a new depth-0 runtime process with a curated
  prompt. Use this when the stage must be able to fan out internally.
- **synchronous-parallel-root mechanism** — independent `stage:run` roots
  started as one parallel batch; wait for and aggregate every result in the
  current turn.
- **single-root mechanism** — one synchronous `stage:run` root with a curated
  prompt; it must return before the coordinator continues.
- **coordinator-root mechanism** — perform the workflow step in the current
  coordinator. Do not create roots merely for runtime symmetry.

Every delegated root receives only its task, relevant source inputs and prior outputs,
the worktree/branch identity, and the calling workflow's workflow-specific authority capsule.
The capsule is mandatory because fresh roots do not inherit coordinator
history. Never forward coordinator conversation history. The runtime reference
controls how these mechanisms are invoked; the calling workflow remains
authoritative about when and why each one is used.

## Session verb roster

The v2 session surface (standalone Autopilot `session` CLI; never the vendored `packages/autopilot` tree) is:

- `checkpoint`
- `implementation-complete --summary-file <path>`
- `review-verdict --state <APPROVE|REQUEST_CHANGES> --body-file <path> [--follow-ups-file <path>]`
- `review-findings --file <path>`
- `child-complete`
- `human --reason-file <path>`

Deleted verbs (`review-fix-publish`, `merge-prep-complete`) must not appear in
workflow skills.
