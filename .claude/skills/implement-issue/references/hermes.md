# Hermes runtime adapter

Use this reference only for dispatch mechanics. The canonical `../SKILL.md`
owns the lifecycle.

## Finite-session invariant

The coordinator and every root stage run through Jinn’s stateless Hermes
launcher. It binds `async_delivery=False`, so top-level `delegate_task` calls
use Hermes’s existing synchronous aggregation path. A task batch may still fan
out concurrently; its consolidated result returns in the current turn.

## Fresh-root stages

Write the curated prompt to `/tmp/stage-<N>-<stage>.md`, then run:

```bash
(cd "$WORKTREE_PATH/packages/autopilot" && yarn stage:run \
  --runtime hermes \
  --prompt-file /tmp/stage-<N>-<stage>.md \
  --worktree "$WORKTREE_PATH")
```

Stages 1, 3, 4, and 5 each use a separate invocation. Each invocation is a new
depth-0 Hermes process, so that stage may use its own `delegate_task` fan-out.

## Lightweight children

Use a fresh synchronous `delegate_task` child for Stages 2, 6, 7, and 8.
Never use a lightweight child for a depth-needing stage.

## Method skills

Load the closest installed Hermes skill for the canonical methodology:
`plan`/`writing-plans`, `test-driven-development`,
`subagent-driven-development`, `simplify-code`,
`requesting-code-review`, `github-code-review`, and the repository’s
`testing-jinn-app`. Where Hermes has no separately named security or
verification skill, follow the canonical stage checklist directly; do not
remove or compress the stage.
