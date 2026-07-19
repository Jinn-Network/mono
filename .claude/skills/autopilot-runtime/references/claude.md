# Claude runtime adapter

Use this reference only for process, child-dispatch, and skill-loading
mechanics. The calling canonical workflow owns the lifecycle.

`JINN_AUTOPILOT_RUNTIME=claude` is inherited by every launched stage. An unset
value also selects Claude for an interactive invocation. Never select a
different runtime for an individual stage.

## Fresh-root sessions

Write the curated prompt to `/tmp/stage-<N>-<stage>.md`, then run:

```bash
(cd "$WORKTREE_PATH/packages/autopilot" && yarn stage:run \
  --prompt-file /tmp/stage-<N>-<stage>.md \
  --worktree "$WORKTREE_PATH" \
  [--model <model>])
```

Each invocation is a distinct root process. Use a separate invocation whenever
the workflow requires a fresh independent context or internal fan-out.

## Synchronous parallel children

Issue all independent Claude child-agent calls in one turn, then wait for every
result and aggregate them before continuing. Each child receives a separate
curated prompt and cannot be reused as a later fixer.

## Lightweight children

Use one fresh Claude child agent and wait for its result in the current turn.
Give it only the canonical task, worktree/branch, relevant inputs, and relevant
prior outputs.

## Skill loading

Invoke the named repository or installed method skill in the child prompt.
When no separately named skill exists, preserve the canonical workflow
checklist directly; never omit a gate because of a naming difference.
