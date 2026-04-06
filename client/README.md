# jinn-client

Phase 0 Jinn protocol client. Runs a daemon that participates in the Jinn training loop on Base via the OLAS Mech Marketplace and JinnRouter.

## What it does

1. **Creates** desired states (posts restoration jobs to the marketplace)
2. **Restores** desired states (claims requests, runs Claude to attempt restoration)
3. **Evaluates** restorations (claims deliveries, creates evaluation jobs)
4. **Earns** OLAS staking rewards (activity tracked on-chain by JinnRouter)

## Prerequisites

- Node.js >= 20
- [Foundry](https://book.getfoundry.sh/) (`anvil` for local fork, `cast` for funding)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` in PATH)

## Quick start

```bash
npm install
npm test              # 33 tests, all pass
npm run e2e           # full loop on Anvil fork (no real funds needed)
```

## Running

### Production (Base mainnet)

```bash
JINN_PASSWORD=your-keystore-password npm start
```

On first run, the earning bootstrap creates a wallet, Safe, service, stakes it, and deploys a mech. It will pause at `awaiting_funding` — fund the printed addresses with ETH (gas) and OLAS (bond), then re-run.

### Local development (Anvil fork)

```bash
# Terminal 1
anvil --fork-url https://mainnet.base.org --port 8545

# Terminal 2
mkdir -p ~/.jinn-client
cat > ~/.jinn-client/config.json << 'EOF'
{
  "rpcUrl": "http://127.0.0.1:8545",
  "claudeModel": "claude-haiku-4-5-20251001",
  "desiredStates": [
    { "id": "test-1", "description": "The service is healthy and responding." }
  ]
}
EOF

JINN_PASSWORD=test npm start
```

Fund on Anvil after the bootstrap prints addresses:

```bash
# ETH for gas (from Anvil's pre-funded account)
cast send <EOA_ADDRESS> --value 0.01ether \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://127.0.0.1:8545

# OLAS for staking bond (impersonate a whale)
cast rpc anvil_impersonateAccount <OLAS_WHALE> --rpc-url http://127.0.0.1:8545
cast send 0x54330d28ca3357F294334BDC454a032e7f353416 \
  "transfer(address,uint256)" <SAFE_ADDRESS> 5000000000000000000000 \
  --from <OLAS_WHALE> --rpc-url http://127.0.0.1:8545 --unlocked
```

Then re-run `JINN_PASSWORD=test npm start`.

## Config

Config file first, env var override. Default location: `~/.jinn-client/config.json`.

Override with `--config`:
```bash
JINN_PASSWORD=secret npm start -- --config ./my-config.json
```

| Config key       | Env override             | Default                           |
|------------------|--------------------------|-----------------------------------|
| rpcUrl           | BASE_RPC_URL/JINN_RPC_URL| https://mainnet.base.org          |
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

## On-chain addresses (Base)

| Component              | Address                                      |
|------------------------|----------------------------------------------|
| JinnRouter             | `0xfFa7118A3D820cd4E820010837D65FAfF463181B` |
| Mech marketplace       | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| Staking contract       | `0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54` |
| OLAS token             | `0x54330d28ca3357F294334BDC454a032e7f353416` |

## Scripts

| Command          | Description                                     |
|------------------|-------------------------------------------------|
| `npm start`      | Production daemon (requires JINN_PASSWORD)       |
| `npm test`       | Run vitest (33 tests)                            |
| `npm run build`  | TypeScript compile                               |
| `npm run e2e`    | End-to-end validation on Anvil fork              |
| `npm run staking`| Earning bootstrap validation on Anvil fork       |
