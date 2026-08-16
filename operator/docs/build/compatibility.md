# Compatibility

The `jinn.supports` field declares which SolverTypes a plug-in is compatible with. Operators install plug-ins on a per-SolverNet basis; the validator enforces compatibility at load time.

## `jinn.supports` semantics

- `["jinn.runtime"]` — singleton runtime plug-in. Loads regardless of SolverType. Reserved for cross-cutting MCP tools.
- `["swe-rebench-v2.v1"]` — solver-type plug-in scoped to a single SolverType.
- `["swe-rebench-v2.v1", "future-swe.v2"]` — solver-type plug-in declaring compatibility with multiple SolverTypes.
- Mixed mode (`["jinn.runtime", "swe-rebench-v2.v1"]`) is rejected at validation time.

## Version pinning

Plug-in versions are pinned by IPFS CID. A new `version` field in `jinn.plugin.json` produces a new tarball and a new CID. The on-chain registry stores each CID as a distinct `plugin:<cid>` record; the indexer maintains a version chain keyed on `(builderAgentId, pluginName)`.

Operators pin a specific CID in their `joinedSolverNets[<manifestCid>].plugins[]` config. Upgrading is opt-in: the operator changes the pin and restarts.

## Which harnesses load which slots

The plug-in surface is largely harness-agnostic. A plug-in's `.mcp.json` and `skills/` directory work across the `learner` harness (Claude Code / Codex CLI) and the Hermes harness automatically.

| Slot | Hermes (`hermes-agent`) | learner (Claude Code) |
|---|---|---|
| `skills/` | yes — via `skills.external_dirs:` | yes — via Claude Code skill loader |
| `.mcp.json` | yes — via `mcp_servers:` merge | yes — via Claude Code MCP config |
| Phase-agent override | no | yes |
| Topic explorer | no | yes |

Phase-agent override and topic-explorer slots are Claude-Code-shaped and live inside the `learner` harness. Hermes drives its own learning loop and ignores them. Plug-ins targeting Hermes should ship only the harness-portable surface (skills + MCP tools).

## Forks

If an operator installs a plug-in directly (npm or local path) without going through `jinn solver-plugins publish`, the run still scores against the operator. The builder gets no attribution. This is intentional: anonymous forks shouldn't dilute the original builder's reputation.

If an envelope's `executor.plugins[].sha256` matches a published record's `pluginSha256`, the run credits the builder. If it doesn't, the run is flagged `forkSuspected: true` and excluded from builder-credit aggregations.
