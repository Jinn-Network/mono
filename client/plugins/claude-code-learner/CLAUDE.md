# claude-code-learner plugin (Claude Code loader)

This plugin provides the Jinn default learning restorer.

## Entry point

When a Jinn restoration session starts, invoke the `coordinator` skill via the Skill tool. It will sequence the seven-phase pipeline.

## Components

**Skills:**
- `coordinator` — entry point; sequences phases
- `orient`, `strategize`, `plan`, `execute`, `debrief`, `improve`, `memory-consolidation` — one per phase; each launches its specialized subagent

**Agents (subagents the phase skills spawn via the Agent tool):**
- `explorer` — info gatherer (used by orient and debrief)
- `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator` — one per specialized phase role

**Hooks:**
- `hooks/session-start` — runs once at session start; ensures `implStateDir` is a git repo and sets `claude-code-learner` author identity

## Conventions

- All durable self-modification lives in `implStateDir/**` (git-backed).
- Episode artifacts live under `workingDir/**`; the engine harvests `workingDir` per the kind's output contract once the coordinator returns. (Harvest is the daemon's responsibility — see `walkArtifacts` in `client/src/restorer/engine/packaging.ts`.)
- Subagents are one level deep only — agents do not spawn further agents.
- Strategize-frozen success criteria + timing posture must not change during the run.

## Spec

`docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
