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

**Hook:**
- `hooks/session-start` — runs once at session start; ensures `implStateDir` (and, in candidate mode, `$JINN_LEARNER_CANDIDATE_DIR`) is a git repo and sets `claude-code-learner` author identity. Emits a mode-aware steer.

## Modes and the write target

`JINN_HARNESS_MODE` is `train`, `frozen`, or `candidate`. It decides where Improve and Memory consolidation write — `SKILL.md`'s "Write target" section is the source of truth, and both writing prompts (`promoter-prompt.md`, `consolidator-prompt.md`) take a resolved `stateDir` rather than deciding for themselves.

In `candidate` mode the plugin is a **proposer**: it runs the active policy read-only and writes its proposed changes to a provisioned copy, which the harness seals as a candidate manifest for separate evaluation. The active `implStateDir` is fenced and verified byte-identical; a run that mutates it is discarded.

**Deprecated — inline self-mutation.** `train` mode's in-place mutation of `implStateDir` is a compatibility mode with no identity boundary between the policy that produced a result and the policy that replaced it. Product design §10 retires it once the first optimization campaign completes end-to-end; campaign evaluation never depends on it. Disable with `JINN_LEARNER_INLINE_MUTATION=0`. Do not build new behaviour on it.

Authority: `docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md` §10.

## Conventions

- All durable self-modification lives in `stateDir/**` (git-backed) — `implStateDir` in `train` mode, the candidate workspace in `candidate` mode.
- Episode artifacts live under `workingDir/**`; the harness harvests `workingDir` once the orchestrator returns.
- Subagents are one level deep only — they do not spawn further agents.
- Strategize-frozen success criteria + timing posture must not change during the run.
- Subagent dispatch is by inlined prompt body (read from a sibling `*-prompt.md`), not by named-subagent registry. This keeps the plugin portable across harnesses.
- The plugin does not interpret `goal.kind` semantically. Domain-specific knowledge belongs in other plugins or in the harness layer.

## Spec

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout + decoupling: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.
- Candidate mode + the learner-as-proposer migration: `docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md` §10.
