# default-learner — agent harness plugin

A drop-in plugin for any agent harness that supports skills + subagents + hooks. Implements the Jinn default learning restorer end-to-end: 8 skills sequencing 7 specialized subagents through Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation.

## What it provides

- **8 skills** — `coordinator` (entry point) plus one per phase. Skills are thin: their job is to launch the right specialized subagent and collect results.
- **7 agents** — `explorer`, `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator`. These are the specialized subagents the phase skills launch in fresh contexts.
- **1 hook** — `session-start.sh` initializes `implStateDir` as a git repo and sets author identity.
- **1 validator** — `validate-plugin.mjs` checks structure + frontmatter.

## Installing

The plugin ships inside the `@jinn-network/client` npm package under `node_modules/@jinn-network/client/plugins/default-learner/`. Per harness:

**Claude Code (local development — recommended for first install):**

Use `--plugin-dir` to load the plugin for a single session without installing into Claude Code's marketplace cache:

```bash
# From a project where @jinn-network/client is a dependency:
PLUGIN_PATH=$(npm root)/@jinn-network/client/plugins/default-learner

# Or if you installed @jinn-network/client globally:
PLUGIN_PATH="$(npm root -g)/@jinn-network/client/plugins/default-learner"

# Validate the plugin manifest before first use:
claude plugin validate "$PLUGIN_PATH"

# Then for any session where you want default-learner available:
claude --plugin-dir "$PLUGIN_PATH" [other args]
```

For a permanent install via the Claude Code marketplace, use `claude plugin install <plugin>@<marketplace>` once a marketplace listing is published. Until then, `--plugin-dir` is the supported path.

**Codex / Pi.dev / other harnesses:** consult your harness's documentation for how to point it at a local plugin directory. The plugin layout (`.claude-plugin/plugin.json` + `skills/` + `agents/` + `hooks/` + `hooks/hooks.json`) is Claude-Code-shaped; harnesses with a different convention may need an adapter.

## What the harness must provide

These are the runtime primitives the plugin assumes the harness exposes (Claude Code names; substitute equivalents on other harnesses):

- `Skill` — load a named skill into the current session
- `Agent` — spawn a fresh-context subagent with a role name and inputs
- `Bash` — for git commands and other shell calls
- `Read`, `Write`, `Edit`, `Glob`, `Grep` — filesystem
- A wait primitive — block until duration / deadline / condition (Claude Code: `Monitor`)

If the harness lacks `Skill`, `Agent`, `Bash`, or filesystem read/write/edit, the plugin will not run. The wait primitive gates time-anchored plans only — the plugin can run for `early-return` postures without it.

## What this plugin does NOT contain

- The Jinn daemon-side `RestorerImpl` shim (separate plan).
- Kind-specific tools (HL MCP, Polymarket, etc.) — those come from the daemon's MCP setup.
- `buildRestorerImpls` registration — separate plan wires the shim.

## Spec

`docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
