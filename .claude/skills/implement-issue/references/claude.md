# Claude runtime adapter

Use this reference only for dispatch mechanics. The canonical `../SKILL.md`
owns the lifecycle.

## Fresh-root stages

Write the curated prompt to `/tmp/stage-<N>-<stage>.md`, then run:

```bash
(cd "$WORKTREE_PATH/packages/autopilot" && yarn stage:run \
  --runtime claude \
  --prompt-file /tmp/stage-<N>-<stage>.md \
  --worktree "$WORKTREE_PATH" \
  [--model <model>])
```

Stages 1, 3, 4, and 5 each use a separate invocation.

## Lightweight children

Use a fresh Agent-tool child for Stages 2, 6, 7, and 8. Give it only the
canonical stage task, issue/acceptance criteria, worktree/branch, and relevant
prior-stage outputs.

## Method skills

- Stage 1: `superpowers:brainstorming`
- Stage 2: `superpowers:writing-plans`
- Stage 3: `superpowers:test-driven-development` then
  `superpowers:executing-plans`
- Stage 4: `/code-review`
- Stage 5: `superpowers:requesting-code-review`
- Stage 6: `/security-review`
- Stage 7: `testing-jinn-app`
- Stage 8: `superpowers:verification-before-completion`
