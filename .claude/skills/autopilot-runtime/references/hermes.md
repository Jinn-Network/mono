# Hermes runtime adapter

Use this reference only for process, child-dispatch, and skill-loading
mechanics. The calling canonical workflow owns the lifecycle.

`JINN_AUTOPILOT_RUNTIME=hermes` and the configured Hermes Python, model, and
provider are inherited by every launched stage. Never select a different
runtime for an individual stage.

## Finite-session invariant

The coordinator and every root stage run through Jinn's stateless Hermes
launcher. It binds `async_delivery=False`, so top-level delegation uses
Hermes's existing synchronous aggregation path. A batch may fan out
concurrently, but all results return in the current turn.

## Fresh-root sessions

Write the curated prompt to `/tmp/stage-<N>-<stage>.md`, then run:

```bash
(cd "$WORKTREE_PATH/packages/autopilot" && yarn stage:run \
  --prompt-file /tmp/stage-<N>-<stage>.md \
  --worktree "$WORKTREE_PATH")
```

Each invocation is a new depth-0 Hermes process, so the stage may use its own
depth-1 fan-out internally. Do not raise Hermes's default spawn depth to
compensate for launching depth-needing work as a child.

## Synchronous parallel children

For synchronous parallel fan-out, issue all independent `delegate_task` calls
in one turn. Wait for Hermes to aggregate every child result before
continuing. Each child receives a separate curated prompt and cannot be reused
as a later fixer.

## Lightweight children

Use one fresh synchronous `delegate_task` child and wait for its result in the
current turn. Never use a lightweight child when the workflow prescribes a
fresh root.

## Skill loading

Load the closest installed Hermes skill for the named methodology through the
configured external skill directories. Where Hermes has no separately named
equivalent, preserve the canonical workflow checklist directly; never remove
or compress a gate.
