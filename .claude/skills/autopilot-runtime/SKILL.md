---
name: autopilot-runtime
description: Shared process and child-dispatch mechanics for Jinn Autopilot's implement-issue, review-pr, and merge-prep workflows. Consume this skill from those canonical workflows; it does not define their lifecycle, gates, authority, or deliverables.
---

# autopilot-runtime

This skill is the single runtime-mechanics adapter for Autopilot. The canonical
`implement-issue`, `review-pr`, and `merge-prep` skills own their distinct
lifecycle policy, authority boundaries, gates, retry behavior, and deliverables.
Do not copy those workflow rules here, and do not copy runtime mechanics back
into a workflow skill.

## Select one process-wide runtime

Read `JINN_AUTOPILOT_RUNTIME` before dispatching any child or fresh-root stage:

- `claude` → read [`references/claude.md`](references/claude.md) completely.
- `hermes` → read [`references/hermes.md`](references/hermes.md) completely.
- unset → use Claude and read the Claude reference.
- any other value → stop with an invalid-runtime error.

The selection applies to the coordinator and every child or fresh-root stage.
There is no per-stage override, fallback, or mixed-runtime routing.

## Mechanism vocabulary

Canonical workflow skills assign work to one of these mechanisms:

- **fresh-root mechanism** — a new depth-0 runtime process with a curated
  prompt. Use this when the stage must be able to fan out internally.
- **synchronous-parallel-child mechanism** — independent children started as
  one parallel batch; wait for and aggregate every result in the current turn.
- **lightweight-child mechanism** — one synchronous child with a curated
  prompt; it must return before the coordinator continues.
- **coordinator-root mechanism** — perform the workflow step in the current
  coordinator. Do not create children merely for runtime symmetry.

Every child receives only its task, relevant source inputs and prior outputs,
and the worktree/branch identity. Never forward coordinator conversation
history. The runtime reference controls how these mechanisms are invoked; the
calling workflow remains authoritative about when and why each one is used.
