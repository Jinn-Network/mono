# claude-code-learner plugin (Claude Code loader)

This plugin provides a generic learning-agent loop.

## Entry point

When a session starts, the harness adapter provides the task payload and paths. The harness/plugin projection makes this skill available to the model; this skill drives the full seven-phase pipeline when selected by the runtime.

## Components

**Skill:**
- `skills/learn/SKILL.md` — single orchestrator. Sequences Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation. Each phase dispatches a fresh-context subagent using the prompt body from the matching sibling file.

**Subagent prompt files (siblings of SKILL.md):**
- `explorer-prompt.md` — info gatherer (used by Orient and Debrief, parallel-dispatched)
- `strategist-prompt.md`, `planner-prompt.md`, `step-worker-prompt.md`, `analyst-prompt.md`, `promoter-prompt.md`, `consolidator-prompt.md` — one per specialized role

**Hooks:**
- `hooks/session-start` — runs once at session start; ensures `implStateDir` is a git repo, sets `claude-code-learner` author identity, and records `$WORKING_DIR/repo` HEAD into `.jinn/session-repo-base-head` when present.
- `hooks/post-tool-use-failure` — on failed Bash test commands, appends non-empty working-tree diffs vs that base HEAD into `.jinn/intermediate-failure-diffs.json` for harvest (`Solution.intermediateFailureDiffs`). Codex/Hermes stay honest omit/`[]` until follow-ups wire the same store contract.

## Conventions

- All durable self-modification lives in `implStateDir/**` (git-backed).
- Episode artifacts live under `workingDir/**`; the harness harvests `workingDir` once the orchestrator returns.
- Subagents are one level deep only — they do not spawn further agents.
- Strategize-frozen success criteria + timing posture must not change during the run.
- Subagent dispatch is by inlined prompt body (read from a sibling `*-prompt.md`), not by named-subagent registry. This keeps the plugin portable across harnesses.
- The plugin does not interpret `goal.kind` semantically. Domain-specific knowledge belongs in other plugins or in the harness layer.

## Spec

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout + decoupling: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.
