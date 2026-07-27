# claude-code-learner — generic learning agent plugin

A drop-in plugin for any agent harness that supports skills + subagent dispatch + hooks. Runs a goal through a seven-phase learning loop (Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation) and self-improves between runs by mutating its own state directory.

## What it provides

- **1 orchestrator skill** — `skills/learn/SKILL.md`. Drives the seven-phase pipeline end-to-end inside one harness session.
- **7 sibling subagent prompts** — `skills/learn/<role>-prompt.md` for `explorer`, `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator`. Each is the prompt body the orchestrator passes to a fresh-context subagent dispatch.
- **2 hooks** — `hooks/session-start` initializes `implStateDir` as a git repo, sets author identity, and records coding-checkout base HEAD; `hooks/post-tool-use-failure` captures intermediate failure diffs for failed test Bash commands.

## intermediateFailureDiffs (§10 field 4)

On Claude Code, `PostToolUseFailure` (Bash) appends non-empty working-tree
diffs vs session-start `repo` HEAD into `.jinn/intermediate-failure-diffs.json`
when the failed command is test-like (`pytest` / `yarn test` / …). Harvest
attaches the list onto `Solution.intermediateFailureDiffs`.

**Codex / Hermes (this Issue):** honest omit / empty field 4. Follow-ups:

- `feat: emit intermediateFailureDiffs from Codex coding harness`
- `feat: emit intermediateFailureDiffs from Hermes coding harness` (Hermes
  `post_tool_call` plugin writing the same `.jinn/intermediate-failure-diffs.json`
  contract so harvest lights up without LearnerHarness)

## Installing

The plugin is consumed by harnesses that load skills from a plugin directory.

**Claude Code (local development — recommended for first install):**

```bash
# Point a Claude Code session at the plugin directory:
claude --plugin-dir /path/to/claude-code-learner [other args]
```

For a permanent install via the Claude Code marketplace, use `claude plugin install <plugin>@<marketplace>` once a marketplace listing is published. Until then, `--plugin-dir` is the supported path.

**Codex / OpenCode / other harnesses:** consult your harness's documentation for how to point it at a local plugin directory. The plugin layout (`.claude-plugin/plugin.json` + `skills/` + `hooks/` + `hooks/hooks.json`) is Claude-Code-shaped; harnesses with a different convention may need an adapter.

## What the harness must provide

These are the runtime primitives the plugin assumes the harness exposes (Claude Code names; substitute equivalents on other harnesses):

- `Skill` — load a named skill into the current session.
- `Task` (general-purpose) — spawn a fresh-context subagent with an inline prompt body.
- `Bash` — for git commands and other shell calls.
- `Read`, `Write`, `Edit`, `Glob`, `Grep` — filesystem.
- A wait primitive — block until duration / deadline / condition (Claude Code: `Monitor`).

The harness adapter is responsible for projecting the generic subagent lifecycle onto its own tool surface: dispatch a fresh-context role worker, wait for required artifacts, and release completed workers. Subagent inputs should use absolute paths so workers do not depend on inheriting the coordinator's current working directory.

If the harness lacks `Skill`, generic `Task`-style subagent dispatch, `Bash`, or filesystem read/write/edit, the plugin will not run. The wait primitive gates time-anchored plans only — the plugin can run for `early-return` postures without it.

## Inputs the harness adapter passes

The orchestrator skill expects these as session inputs (typically via the harness adapter's initial prompt or environment):

- `goal` — `{ id, description, kind?, deadline?, spec? }`. Free-form payload describing what to achieve.
- `workingDir` — ephemeral path for this run's artifacts.
- `implStateDir` — the agent's persistent self-state (git-backed).
- `msUntilDeadline` — function returning remaining time.
- An abort signal that fires at the goal's deadline.

The plugin does not interpret `goal.kind` semantically. Domain-specific behavior (e.g. how to forecast a prediction market, how to rebalance a portfolio) belongs in domain-specific plugins loaded alongside this one, OR in the harness adapter / harvester layer.

## Optional environment

- `LEARNER_PHASE_RANGE=pre-execute|post-execute|full` — limits which phases run. Used by harnesses that wrap a domain-specialist Execute path between meta-pre and meta-post passes.

## Spec

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout + decoupling: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.
