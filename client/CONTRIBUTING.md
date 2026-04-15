# Contributing to @jinn-network/client

Development happens in the [jinn-mono](https://github.com/Jinn-Network/mono) monorepo. This guide covers running the client from source.

## Prerequisites

- Node.js >= 20 (`corepack enable` once so Yarn matches this package's `packageManager` field)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` in PATH — the daemon spawns it as a subprocess)
- [Foundry](https://book.getfoundry.sh/) (only needed for `yarn e2e` against an Anvil fork)

## Setup

```bash
cd client
yarn install
yarn test              # vitest suite — 267 tests
yarn typecheck         # tsc --noEmit
```

## Running from source

```bash
JINN_PASSWORD=your-keystore-password yarn jinn run
```

The `yarn jinn` script uses `tsx` to run TypeScript directly without a build step.

## Running against an Anvil fork

```bash
# Terminal 1
anvil --fork-url https://sepolia.base.org --port 8545

# Terminal 2
JINN_RPC_URL=http://127.0.0.1:8545 JINN_PASSWORD=test yarn jinn run
```

The bootstrap pauses at the funding gate. Fund the printed master address from one of Anvil's pre-funded keys with `cast send`, then re-run.

## Project structure

```
src/
  bin/jinn.ts           CLI entry point (compiled to dist/bin/jinn.js)
  cli/                  CLI dispatcher and commands
  adapters/             Execution adapters (local, mech)
  daemon/               Concurrent loop orchestration
  earning/              Fleet bootstrap state machine
  runner/               Claude subprocess management
  store/                SQLite persistence
  api/                  HTTP API (Hono)
  types/                Core type definitions
  errors/               Error envelope system
  mcp/                  MCP server for Claude subprocess

deployments/            Bundled deployment artifacts (contract addresses)
test/                   Vitest tests (mirrors src/ structure)
scripts/                Dev utilities (e2e, staking validation, sync)
```

## Build and pack

```bash
yarn build                 # tsc output → dist/
yarn pack -o test.tgz      # create publishable tarball
```

The `files` field in `package.json` ensures only `dist/`, `deployments/`, and `README.md` are included in the tarball.

## Updating deployment artifacts

After deploying new contracts on testnet, sync the bundled defaults:

```bash
./scripts/sync-deployments.sh
```

This copies the 4 deployment JSON files from `contracts/` into `client/deployments/`. Commit the updated files.

## Scripts reference

| Command | Description |
|---|---|
| `yarn jinn run` | Run daemon from source (requires JINN_PASSWORD) |
| `yarn test` | Run vitest suite |
| `yarn build` | TypeScript compile |
| `yarn typecheck` | Typecheck without emitting |
| `yarn e2e` | End-to-end validation on Anvil fork |
| `yarn staking` | Earning bootstrap validation on Anvil fork |
| `yarn pack:smoke` | Pack tarball and run smoke tests |

## CI

In CI, use `yarn install --immutable` (equivalent to a clean `npm ci`). The CI workflow (`ci.yml`) runs:

1. `typecheck` + `test` + `build`
2. `yarn pack` + smoke test the packed artifact in a clean directory

## On-chain addresses

The client resolves contract addresses automatically from deployment artifacts bundled in `deployments/` (testnet) and hardcoded constants (mainnet). Operators don't need to set any `JINN_TESTNET_*_DEPLOYMENT` env var — those exist only as overrides for protocol developers running against a custom deploy.

Base mainnet reference addresses:

| Component | Address |
|---|---|
| JinnRouter | `0xfFa7118A3D820cd4E820010837D65FAfF463181B` |
| Mech marketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| Staking contract | `0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54` |
| OLAS token | `0x54330d28ca3357F294334BDC454a032e7f353416` |

## Spec

The stable command-line and JSON surface is defined in [`spec/2026-04-14-client-surface.md`](../spec/2026-04-14-client-surface.md). Error envelopes emitted on non-zero exits conform to §6 of that spec.
