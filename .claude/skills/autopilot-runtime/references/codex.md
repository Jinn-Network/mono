# Codex runtime adapter

Use this reference only for process, child-dispatch, and skill-loading
mechanics. The calling canonical workflow owns the lifecycle.

`JINN_AUTOPILOT_RUNTIME=codex` and the configured Codex CLI binary and model
(`JINN_DISPATCHER_CODEX_BIN`, `JINN_DISPATCHER_CODEX_MODEL`) are inherited by
every launched stage. Never select a different runtime for an individual
stage. This session may have been seated in the Codex overflow pool while the
engine's process-wide runtime is something else; that is deliberate, and the
whole session — coordinator and every stage it launches — stays on Codex.

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
  --worktree "$WORKTREE_PATH"
rm -f -- "$STAGE_PROMPT"
```

Install an exact-file cleanup trap before launch so interruption also removes
only `"$STAGE_PROMPT"`. Never reuse or predict a prompt path. Parallel roots
each receive their own `mktemp` result.

Each invocation is a new depth-0 `codex exec` process running unattended in
the worktree with approvals bypassed — the detached worktree is its isolation.
Use a separate invocation whenever the workflow requires a fresh independent
context or internal fan-out. `autopilot internal run-stage` removes the
coordinator's GitHub credentials, Git/SSH publication paths, and session
manifest before spawning the root. Do not launch a fresh root directly in a
way that bypasses that environment boundary, and do not launch depth-needing
work as an in-process subagent when the workflow prescribes a fresh root.

## Synchronous parallel roots

For synchronous parallel work, launch a separate `stage:run` invocation for
each curated prompt concurrently, then wait for every result and aggregate
them before continuing. Each root receives the stripped stage environment and
cannot be reused as a later fixer.

## Single roots

Use one `stage:run` invocation and wait for its result in the current turn.
Give it only the canonical task, worktree/branch, relevant inputs, and relevant
prior outputs. Do not replace it with an in-process subagent that inherits the
coordinator's GitHub credentials or session manifest.

## Coordinator-root work

Perform the workflow step in the current coordinator when the canonical skill
assigns coordinator-root mechanism. Do not create roots merely for runtime
symmetry.

## Skill loading

Codex loads skills from the worktree's `.codex/skills`, which the repository's
skill mirror keeps in step with `.claude/skills`, and from the repository skill
directories named in `.autopilot/config.json`. Where Codex has no separately
named equivalent, preserve the canonical workflow checklist directly; never
remove or compress a gate.
