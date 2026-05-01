# @jinn-examples/polymarket-mcp

**Recruit shape:** prediction-tool builder with a Polymarket API integration
(per #57 §2.4 Polymarket bot operators).

**Slot:** mcp-tool → claude-code-learner harness, namespace `polymarket`.

## What this plug-in does

Exposes two MCP tools to phase agents (especially the strategist) under the
`polymarket` namespace:

- `polymarket_market_state(marketId)` — current state of a binary market
- `polymarket_recent_volume(marketId)` — 24h trading volume

The default impl is a deterministic stub keyed off `marketId`. Real builders
swap `src/polymarket-stub.ts` for the Polymarket gamma-markets API.

## Install

```bash
yarn add @jinn-examples/polymarket-mcp
yarn build  # tsc -> dist/
jinn plug-ins add @jinn-examples/polymarket-mcp --entry $(npm root)/@jinn-examples/polymarket-mcp
```

## Build & test

```bash
yarn install
yarn typecheck
yarn build
yarn test
```

## Spec

`spec/2026-04-30-plug-in-surface.md` §4.7.3.
