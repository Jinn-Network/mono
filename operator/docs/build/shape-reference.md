# Plug-in shape reference

A SolverPlugin is an npm package with a `jinn.plugin.json` manifest at its root. The manifest declares which SolverTypes the plug-in serves and which artifacts it ships (skills, MCP servers).

## `jinn.plugin.json`

```json
{
  "name": "@you/my-swe-skill",
  "version": "0.1.0",
  "description": "Solver-side reasoning skill for SWE-rebench v2.",
  "jinn": {
    "supports": ["swe-rebench-v2.v1"],
    "skills": [
      "skills/example/SKILL.md"
    ]
  }
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | npm package name. Used as the canonical id across the registry. |
| `version` | yes | Semver. Each new version publishes under a new IPFS CID. |
| `description` | no | Short prose. |
| `jinn.supports` | yes | Either `["jinn.runtime"]` OR one or more SolverType ids. See "Two modes". |
| `jinn.skills` | no | Relative paths to SKILL.md files the harness should load. |
| `jinn.mcpServers` | no | Inline MCP server map. Prefer `.mcp.json` for harness-agnostic portability. |
| `jinn.capabilities` | no | Reserved for future use. |

## Two modes

The validator (`operator/src/plugins/validator.ts`) enforces exactly two exclusive modes per `spec/2026-05-01-harness-pack-architecture.md` §5.1.

### Runtime plug-in

`jinn.supports` is exactly `["jinn.runtime"]`. Singleton — only one runtime plug-in loads per daemon. Use this for cross-cutting MCP tools that any SolverType can call. Reference: `operator/plugins/network-tools/`.

### SolverType plug-in

Every entry of `jinn.supports` is a SolverType identifier. The plug-in loads only for tasks of those SolverTypes. Mixing `jinn.runtime` with SolverType ids is rejected. Reference: `operator/plugins/swe-rebench-v2-runtime/`.

## `skills/`

A skill is a directory containing a `SKILL.md` document. Hermes consumes the directory directly via `skills.external_dirs:`. The directory may also contain example files, snippets, or anything the SKILL.md references — all of it travels with the package.

## `.mcp.json`

A standard MCP servers manifest. Hermes's `hermesConfigFromSolverPlugins()` resolves `${CLAUDE_PLUGIN_ROOT}` templates against the vendored plug-in root and merges the result into the harness's `mcp_servers:`. Use this for any MCP server you want to expose to the agent.
