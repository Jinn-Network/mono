# Hermes runtime adapter

Use this reference only for process, child-dispatch, and skill-loading
mechanics. The calling canonical workflow owns the lifecycle.

`JINN_AUTOPILOT_RUNTIME=hermes` and the configured Hermes Python, model, and
provider are inherited by every launched stage. Never select a different
runtime for an individual stage.

## Finite-session invariant

The coordinator and every root stage run through the package-owned stateless
Hermes launcher. It binds `async_delivery=False`, so top-level delegation uses
Hermes's existing synchronous aggregation path. A batch may fan out
concurrently, but all results return in the current turn.

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

Each invocation is a new depth-0 Hermes process, so the stage may use its own
depth-1 fan-out internally. Do not raise Hermes's default spawn depth to
compensate for launching depth-needing work as a child.
`autopilot internal run-stage` removes the coordinator's GitHub credentials, Git/SSH publication
paths, and session manifest before spawning the root while retaining the
configured Hermes runtime/model/provider. Do not launch a fresh root directly
in a way that bypasses that environment boundary.

## Synchronous parallel roots

For synchronous parallel work, launch a separate `stage:run` invocation for
each curated prompt concurrently. Wait for every root result and aggregate
them before continuing. Each root receives the stripped stage environment and
cannot be reused as a later fixer.

## Single roots

Use one `stage:run` invocation and wait for its result in the current turn.
Do not replace it with an in-process delegation that inherits the
coordinator's GitHub credentials or session manifest.

## Skill loading

Load the closest installed Hermes skill for the named methodology through the
configured external skill directories. Where Hermes has no separately named
equivalent, preserve the canonical workflow checklist directly; never remove
or compress a gate.
