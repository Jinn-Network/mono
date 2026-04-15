# jinn-client

Jinn protocol client. Runs a daemon that participates in the Jinn training loop: create, restore, and evaluate desired states, and earn rewards for measured work.

The default network is whatever network the protocol is currently launching on. Today that is **Base Sepolia** (Phase 1b — fast epochs, free testnet funds). At Phase 2 launch it will flip to **Base mainnet**. Operators should not normally need to choose.

## What it does

1. **Creates** desired states (posts restoration jobs to the marketplace)
2. **Restores** desired states (claims requests, runs Claude to attempt restoration)
3. **Evaluates** restorations (claims deliveries, creates evaluation jobs)
4. **Earns** staking rewards (activity tracked on-chain)

## Prerequisites

- Node.js >= 20 (`corepack enable` once so Yarn matches this package’s `packageManager` field)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` in PATH — the daemon spawns it as a subprocess)
- [Foundry](https://book.getfoundry.sh/) (only needed for `yarn e2e` against an Anvil fork)

## Quick start

```bash
yarn install
yarn test              # vitest suite
JINN_PASSWORD=your-keystore-password yarn start
```

On first run, the bootstrap generates a master wallet and prints a funding address. Send testnet ETH to it, then re-run. The bootstrap is idempotent — it picks up where it left off.

`JINN_PASSWORD` encrypts the local keystore and is env-only; never put it in a config file.

## Switching to mainnet

When Phase 2 launches, the default will flip. Until then, an explicit opt-in:

```bash
JINN_NETWORK=mainnet JINN_PASSWORD=secret yarn start
```

or in `~/.jinn-client/config.json`:

```json
{ "network": "mainnet" }
```

Everything else in this README applies to both networks.

## Running against an Anvil fork

For offline validation without touching real funds:

```bash
# Terminal 1
anvil --fork-url https://sepolia.base.org --port 8545

# Terminal 2
JINN_RPC_URL=http://127.0.0.1:8545 JINN_PASSWORD=test yarn start
```

The bootstrap will pause at the funding gate. Fund the printed master address from one of Anvil's pre-funded keys with `cast send`, then re-run.

## Config

Config file first, env var override. Default location: `~/.jinn-client/config.json`.

Override with `--config`:
```bash
JINN_PASSWORD=secret yarn start -- --config ./my-config.json
```

| Config key       | Env override             | Default                           |
|------------------|--------------------------|-----------------------------------|
| network          | JINN_NETWORK             | testnet (flips to mainnet at launch) |
| rpcUrl           | BASE_RPC_URL/BASE_SEPOLIA_RPC_URL/JINN_RPC_URL | network-appropriate public RPC |
| claudeModel      | JINN_CLAUDE_MODEL        | claude-haiku-4-5-20251001         |
| claudePath       | JINN_CLAUDE_PATH         | claude                            |
| pollIntervalMs   | JINN_POLL_INTERVAL_MS    | 5000                              |
| apiPort          | JINN_API_PORT            | 7331                              |
| dbPath           | JINN_DB_PATH             | ~/.jinn-client/jinn.db            |
| earningDir       | JINN_EARNING_DIR         | ~/.jinn-client/earning            |
| peers            | JINN_PEERS               | []                                |
| subgraphUrl      | JINN_SUBGRAPH_URL        | (none)                            |
| desiredStates    | JINN_DESIRED_STATES      | [health-check]                    |
| ipfsRegistryUrl  | JINN_IPFS_REGISTRY_URL   | https://registry.autonolas.tech   |
| ipfsGatewayUrl   | JINN_IPFS_GATEWAY_URL    | https://gateway.autonolas.tech    |

`JINN_PASSWORD` is env-only (keystore encryption password, never in config files).

See `fixtures/config.example.json` for a template.

## How it works

The daemon runs three concurrent loops:

- **CreatorLoop** — posts desired states via `JinnRouter.createRestorationJob()`
- **RestorerLoop** — watches for requests, claims them, spawns Claude to attempt restoration, submits results
- **DeliveryWatcherLoop** — watches for deliveries, calls `JinnRouter.claimDelivery()`, creates evaluation jobs

Each JinnRouter call increments activity counters for the Safe multisig. The OLAS staking contract reads these at checkpoints to determine reward eligibility.

### Earning bootstrap

On first run, the `EarningBootstrapper` walks through 11 idempotent steps:

1. Create agent wallet (encrypted keystore)
2. Predict Safe address
3. Wait for funding (ETH for gas + OLAS for bond)
4. Deploy Safe
5. Create service on-chain
6. Activate service (approve OLAS bond)
7. Register agent
8. Deploy service
9. Stake service
10. Deploy mech
11. Complete

State persists to `~/.jinn-client/earning/`. Safe to interrupt and re-run at any point.

## On-chain addresses

The client resolves contract addresses automatically from deployment artifacts
shipped in `contracts/deployment-*.json` (testnet) and hardcoded (mainnet).
Operators do not need to set any `JINN_TESTNET_*_DEPLOYMENT` env var — those
exist only as overrides for protocol developers running against a custom
deploy.

Base mainnet reference addresses (used when `network: mainnet`):

| Component              | Address                                      |
|------------------------|----------------------------------------------|
| JinnRouter             | `0xfFa7118A3D820cd4E820010837D65FAfF463181B` |
| Mech marketplace       | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| Staking contract       | `0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54` |
| OLAS token             | `0x54330d28ca3357F294334BDC454a032e7f353416` |

## Scripts

| Command           | Description                                     |
|-------------------|-------------------------------------------------|
| `yarn start`      | Production daemon (requires JINN_PASSWORD)    |
| `yarn test`       | Run vitest suite                                |
| `yarn build`      | TypeScript compile                              |
| `yarn typecheck`  | Typecheck without emitting (`tsc --noEmit`)     |
| `yarn e2e`        | End-to-end validation on Anvil fork             |
| `yarn staking`    | Earning bootstrap validation on Anvil fork      |

In CI, use `yarn install --immutable` after checking out `yarn.lock` (equivalent to a clean `npm ci`).

## Spec

The stable command-line and JSON surface this client exposes is
defined in [`spec/2026-04-14-client-surface.md`](../spec/2026-04-14-client-surface.md).
Error envelopes emitted on non-zero exits conform to §6 of that spec.
