# Worked example: mcp-tool

**Example package:** [`examples/learner-plug-ins/@jinn-examples/polymarket-mcp`](../../../../examples/learner-plug-ins/@jinn-examples/polymarket-mcp)

## Recruit shape

You're a prediction-tool builder. You wrap a venue's API (Polymarket, Kalshi, Manifold, a sportsbook) and want every Jinn restorer to be able to call it. You're not shipping a forecaster — you're shipping the tool surface forecasters reach for.

The `mcp-tool` slot is your shape: package an MCP server, declare it in the manifest, and every phase agent gets your tools.

## What the slot does

The harness loads MCP servers declared in `jinn-plugin.json` at session start, registers their tools with all phase agents, and routes tool calls through the existing MCP-client convention.

This is **the one slot category that adds capability surface** — an MCP server runs in its own process with whatever the OS grants it. The trust posture is "the operator vouched by installing." Operators with stricter requirements run an MCP allow-list at the harness level.

The polymarket-mcp example exposes `polymarket_market_state`, `polymarket_resolution`, `polymarket_recent_volume` to every phase agent in the session.

## Manifest

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@jinn-examples/polymarket-mcp",
  "version": "0.1.0",
  "compatibility": {
    "claudeCodeLearner": ">=0.1.0 <0.2.0",
    "supportedKinds": ["prediction.v0"]
  },
  "slots": [
    {
      "type": "mcp-tool",
      "command": "node",
      "args": ["./dist/server.js"],
      "namespace": "polymarket"
    }
  ]
}
```

The `namespace` prefix becomes part of the registered tool names; phase agents see `polymarket__market_state` etc. and won't collide with other MCP servers.

## Slot entry walkthrough

The MCP server lives in `src/server.ts`, compiled to `dist/server.js`. It implements the standard MCP protocol via `@modelcontextprotocol/sdk` — same shape as any other MCP server.

The example's tools are stubs that return canned responses (so `yarn test` doesn't hit the live Polymarket API). A production version replaces the stub bodies with real API calls.

## Test → install → run

```bash
cd examples/learner-plug-ins/@jinn-examples/polymarket-mcp
yarn install
yarn build         # compiles dist/server.js
yarn test          # validates manifest + smoke-tests the MCP server

cd ~/your-daemon-config
yarn add file:.../examples/learner-plug-ins/@jinn-examples/polymarket-mcp
jinn plug-ins add @jinn-examples/polymarket-mcp

# Restart daemon. polymarket_* tools are now available to all phase agents.
```

## Replace the stub

1. **Implement the tool bodies** — replace the canned responses with real Polymarket API calls in `src/server.ts`.
2. **Handle API keys** — read from environment variables (e.g., `POLYMARKET_API_KEY`). The MCP server runs in its own process, so its env is independent of the daemon's.
3. **Add tool schemas** — MCP clients use the `inputSchema` declarations to validate calls; phase agents see the schemas in their tool list. Make these accurate so the strategist can plan against them.
4. **Document operator-side guardrails** — if your tools spend money or expose authenticated state, your README MUST say so. Operators decide whether to install based on the README; the harness doesn't enforce a per-tool allow-list (yet — see `spec/2026-04-30-plug-in-surface.md` §8 open question 4).

Stricter alternative: an `mcp-tool` slot can expose only read endpoints. Combined with a clear README, that lowers the operator's vouching cost dramatically.
