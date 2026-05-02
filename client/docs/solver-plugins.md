# SolverPlugin quickstart

SolverPlugins are normal AI tooling plugins that can help Harnesses solve Tasks.
They are not canonical SolverNet authority and they do not execute Tasks
directly.

Use a SolverPlugin when you have reusable substrate:

- Claude Code or Gemini extension manifests
- MCP servers
- skills or prompts
- local docs or examples
- optional `jinn.supports` metadata

Use a Harness package instead when you own the full `run(ctx)` implementation.

## Layout

```text
@yourname/your-plugin/
├── jinn.plugin.json
├── .claude-plugin/
│   └── plugin.json
├── gemini-extension.json
├── .mcp.json
├── mcp/
│   └── server.mjs
├── skills/
│   └── useful-skill/
│       └── SKILL.md
└── README.md
```

## Jinn manifest

```json
{
  "name": "@yourname/your-plugin",
  "version": "0.1.0",
  "description": "Optional tools and skills for a SolverNet.",
  "jinn": {
    "supports": ["prediction.v1"],
    "mcpServers": {
      "example": {
        "command": "node",
        "args": ["mcp/server.mjs"]
      }
    },
    "skills": ["skills/useful-skill"]
  }
}
```

`jinn.supports` is compatibility metadata only. SolverNet contracts in
`@jinn-network/sdk/solvernets` define schemas, credential requirements,
evaluation functions, and aggregation functions.

## Install

```bash
jinn solver-nets add-plugin ./path/to/@yourname/your-plugin
```

The client validates the manifest and loads the plugin through the relevant host
runtime. Harness dispatch is unchanged: only Harness packages implement
`run(ctx)`.
