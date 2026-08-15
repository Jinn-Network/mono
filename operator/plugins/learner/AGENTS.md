# claude-code-learner plugin (generic / Codex loader)

This plugin provides a generic learning-agent loop for any harness that supports skills + subagent dispatch + hooks.

## Tool name mapping

> Names below are best-effort guidance; harness tool surfaces evolve. The canonical contract is the **capability** described in the Generic column — confirm against your harness's docs before wiring.

The `learn` skill and the sibling prompt files use Claude Code tool names by default. On other harnesses, substitute equivalents:

| Claude Code | Codex | Pi.dev | Generic |
|---|---|---|---|
| `Skill` | `skill` | (extension load) | "load named instructions into current session" |
| `Task` (general-purpose) | `spawn_agent` | (subprocess) | "spawn fresh-context subagent with an inline prompt body" |
| `Bash` | `shell` | `bash` | shell tool |
| `Read`/`Write`/`Edit` | `file_read`/`file_write` | `fs` tools | filesystem |
| `Glob`/`Grep` | `glob`/`grep` | `fs` search | "filesystem search by pattern / content" |
| `Monitor` (wait) | (bespoke) | (built-in) | "block until duration/deadline/condition" |

## Subagent dispatch contract

The learner workflow is written against generic harness capabilities, not a specific subagent API. The harness projects these operations onto its native tools:

- Dispatch a fresh-context subagent with an inline role prompt body plus explicit inputs.
- Wait on returned subagent handles until every required phase artifact exists.
- Release/close completed subagents after their outputs are verified and their summaries are captured.
- Pass absolute filesystem paths in subagent inputs; subagents should not rely on inheriting the coordinator's current working directory.

## Entry point

The harness adapter provides the task payload and paths at session start. The harness/plugin projection makes this skill available to the model; this skill drives the full seven-phase pipeline when selected by the runtime.

## Components

See `CLAUDE.md` for the same component listing — both loaders cover the same plugin contents; this file just notes the cross-harness tool mapping. On Claude Code, `hooks/post-tool-use` captures failed-test Bash/Shell diffs into `$WORKING_DIR/.execute/intermediate-failure-diffs.json` for harvest (§10 field 4).

## Spec

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout + decoupling: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.
