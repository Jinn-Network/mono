# claude-code-learner plugin (generic / Codex loader)

This plugin provides the Jinn default learning restorer for any agent harness that supports skills + subagents + hooks.

## Tool name mapping

> Names below are best-effort guidance; harness tool surfaces evolve. The canonical contract is the **capability** described in the Generic column — confirm against your harness's docs before wiring.

The skills and agents in this plugin use Claude Code tool names by default. On other harnesses, substitute equivalents:

| Claude Code | Codex | Pi.dev | Generic |
|---|---|---|---|
| `Skill` | `skill` | (extension load) | "load named instructions into current session" |
| `Agent` | `agent` | (subprocess) | "spawn fresh-context subagent with role + inputs" |
| `Bash` | `shell` | `bash` | shell tool |
| `Read`/`Write`/`Edit` | `file_read`/`file_write` | `fs` tools | filesystem |
| `Glob`/`Grep` | `glob`/`grep` | `fs` search | "filesystem search by pattern / content" |
| `Monitor` (wait) | (bespoke) | (built-in) | "block until duration/deadline/condition" |

## Entry point

Invoke the `coordinator` skill at the start of a Jinn restoration session.

## Components

See `CLAUDE.md` for the same component listing — both loaders cover the same plugin contents; this file just notes the cross-harness tool mapping.

## Spec

`docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
