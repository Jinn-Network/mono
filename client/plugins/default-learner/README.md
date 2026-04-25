# default-learner — agent harness plugin

A drop-in plugin for any agent harness that supports skills + subagents + hooks. Implements the Jinn default learning restorer end-to-end: 8 skills sequencing 7 specialized subagents through Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation.

## What it provides

- **8 skills** — `coordinator` (entry point) plus one per phase. Skills are thin: their job is to launch the right specialized subagent and collect results.
- **7 agents** — `explorer`, `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator`. These are the specialized subagents the phase skills launch in fresh contexts.
- **1 hook** — `session-start.sh` initializes `implStateDir` as a git repo and sets author identity.
- **1 validator** — `validate-plugin.mjs` checks structure + frontmatter.

## Installing

The plugin ships inside the `@jinn-network/client` npm package under `node_modules/@jinn-network/client/plugins/default-learner/`. Per harness:

**Claude Code:**

```bash
mkdir -p ~/.claude/plugins

# From a project where @jinn-network/client is a dependency:
cp -r node_modules/@jinn-network/client/plugins/default-learner ~/.claude/plugins/

# Or if you installed @jinn-network/client globally:
cp -r "$(npm root -g)/@jinn-network/client/plugins/default-learner" ~/.claude/plugins/
```

**Codex:**

```bash
mkdir -p ~/.codex/plugins

# From a project where @jinn-network/client is a dependency:
cp -r node_modules/@jinn-network/client/plugins/default-learner ~/.codex/plugins/

# Or if you installed @jinn-network/client globally:
cp -r "$(npm root -g)/@jinn-network/client/plugins/default-learner" ~/.codex/plugins/
```

**Pi.dev / other harnesses:** copy the directory into wherever the harness loads plugins from. Each harness reads its own loader file at the plugin root (`CLAUDE.md`, `AGENTS.md`, etc.).

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
