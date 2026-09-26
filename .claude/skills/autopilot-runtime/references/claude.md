# Claude runtime adapter

Use this reference only for process, child-dispatch, and skill-loading
mechanics. The calling canonical workflow owns the lifecycle.

`JINN_AUTOPILOT_RUNTIME=claude` is inherited by every launched stage. An unset
value also selects Claude for an interactive invocation. Never select a
different runtime for an individual stage.

## Fresh-root sessions

Create every curated prompt as an owner-only unique file inside the current
attempt's reports directory, then run:

```bash
SESSION_REPORT_DIR="$(dirname -- "$JINN_AUTOPILOT_SESSION_MANIFEST")/reports"
STAGE_PROMPT="$(mktemp "$SESSION_REPORT_DIR/stage-${STAGE_NUMBER}-${STAGE_NAME}.md.XXXXXX")"
chmod 600 "$STAGE_PROMPT"
# Write only this stage's curated prompt to "$STAGE_PROMPT".
autopilot internal run-stage \
  --prompt-file "$STAGE_PROMPT" \
  --worktree "$WORKTREE_PATH" \
  [--model <model>]
rm -f -- "$STAGE_PROMPT"
```

Install an exact-file cleanup trap before launch so interruption also removes
only `"$STAGE_PROMPT"`. Never reuse or predict a prompt path. Parallel roots
each receive their own `mktemp` result.

Each invocation is a distinct root process. Use a separate invocation whenever
the workflow requires a fresh independent context or internal fan-out.
`autopilot internal run-stage` removes the coordinator's GitHub credentials, Git/SSH publication
paths, and session manifest before spawning the root. Do not launch a fresh
root directly in a way that bypasses that environment boundary.

## Synchronous parallel roots

For synchronous parallel work, launch a separate `stage:run` invocation for
each curated prompt concurrently, then wait for every result and aggregate
them before continuing. Each root receives the stripped stage environment and
cannot be reused as a later fixer.

## Single roots

Use one `stage:run` invocation and wait for its result in the current turn.
Give it only the canonical task, worktree/branch, relevant inputs, and relevant
prior outputs. Do not replace it with an in-process child that inherits the
coordinator's GitHub credentials or session manifest.

## Skill loading

Invoke the named repository or installed method skill in the child prompt.
When no separately named skill exists, preserve the canonical workflow
checklist directly; never omit a gate because of a naming difference.
