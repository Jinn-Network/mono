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

## Entry point

The harness adapter directs the model to use the `claude-code-learner:learn` skill at session start.

## Components

See `CLAUDE.md` for the same component listing — both loaders cover the same plugin contents; this file just notes the cross-harness tool mapping.

## Spec

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout + decoupling: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.
