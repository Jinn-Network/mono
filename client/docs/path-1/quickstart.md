# Path 1 quickstart

A 60-second walkthrough for shipping a Path 1 plug-in into `claude-code-learner`.

## Audience

Component-builders shipping a single piece — a markdown agent, an MCP tool, a skill bundle, a memory backend, or a hook — into the bundled learning restorer's seven-phase pipeline. If you have a whole forecaster you want to wrap, see [Path 2](../path-2/README.md) instead.

## 1. Decide your slot type

Six mechanical shapes are available; pick the one that matches what you're shipping. Full reference in [slot-reference.md](./slot-reference.md).

| Slot | What you ship | Where it lands |
|---|---|---|
| `phase-agent-override` | A markdown agent file | Replaces a phase agent (strategist, planner, step-worker, analyst, promoter, consolidator) for declared kinds. |
| `topic-explorer` | A markdown agent file | Adds a topic to Orient or Debrief's fan-out. |
| `mcp-tool` | A standalone MCP server | Tools become available to all phase agents. |
| `skill-bundle` | One or more `skills/<name>/SKILL.md` | Skills loaded into the harness's `Skill` tool. |
| `memory-backend` | An MCP server (memory backend protocol) | Augments the consolidator's storage strategy. |
| `hook` | A shell script or Node executable | Runs at session-start, pre-phase, post-phase, or session-end. |

## 2. Scaffold

```bash
jinn create plug-in @yourname/your-package --pattern <slot-type>
```

The scaffolder asks for the integration point (which phase / agent / topic / event, depending on the slot), then emits a working package:

```
@yourname/your-package/
├── package.json
├── jinn-plugin.json          # Jinn-side manifest
├── .claude-plugin/
│   └── plugin.json           # Claude Code-shaped declaration
├── agents/                   # for phase-agent-override / topic-explorer
├── skills/                   # for skill-bundle
├── tools/                    # for mcp-tool
├── hooks/                    # for hook
├── test/
│   └── plugin.test.ts        # validates manifest + simulates load
├── README.md
└── tsconfig.json
```

## 3. Edit + test

```bash
cd @yourname/your-package
yarn install
yarn test
```

The scaffolded test loads `jinn-plugin.json`, simulates session-start discovery, and asserts the plug-in registers cleanly. It passes immediately. Edit the slot's primary file (the agent markdown, the MCP server, the skill body, the hook script), rerun `yarn test`.

## 4. Publish to npm

```bash
npm publish --access public
```

For private testing, point at Verdaccio or a private GitHub Packages registry. No signing or IPFS pinning required — Path 1 trust is host-inheritance (see [`../path-1/README.md`](./README.md#trust-posture)).

## 5. Operator-side install

The operator (the human running the daemon) runs:

```bash
yarn add @yourname/your-package
jinn plug-ins add @yourname/your-package
```

`jinn plug-ins add` reads the package's `jinn-plugin.json`, validates against `client/schemas/jinn-plugin-v1.json`, checks the compatibility range against the bundled learner version, and appends to `~/.jinn-client/config.json` under `learnerPlugIns[]`.

## 6. Daemon picks it up

Restart the daemon. At session start, `claude-code-learner` walks `config.learnerPlugIns[]`, loads each plug-in's `jinn-plugin.json`, and registers the declared slots into the session's slot registry. Phase agents (when sequenced by the coordinator) consult the registry: phase-agent overrides replace the bundled agent for matching `(phase, agent, kind)` tuples; topic explorers extend Orient/Debrief; MCP tools register with the harness's MCP client; skills register with the `Skill` tool; memory backends and hooks plug in at their respective integration points.

`jinn plug-ins list` shows what's installed; `jinn plug-ins show <name>` shows the manifest; `jinn plug-ins remove <name>` uninstalls.

## Next

- [slot-reference.md](./slot-reference.md) — full mechanical reference for each slot category.
- [examples/](./examples/README.md) — six worked walkthroughs, one per slot.
- [manifest-reference.md](./manifest-reference.md) — field-by-field reference for `jinn-plugin.json`.
