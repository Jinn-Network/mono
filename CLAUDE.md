# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Jinn Network monorepo. Phase 0 implementation is complete — the client daemon, on-chain contracts, and JinnRouter are all deployed and working on Base.

Jinn is a training protocol for state restoration. It defines a loop (Creation → Restoration → Evaluation → Knowledge) where desired states are published with fees, participants attempt restoration, evaluators verify results, and knowledge accumulates to improve future attempts.

## Repository Structure

```
client/          TypeScript daemon — the main runnable component
  src/
    main.ts              Production entry point (npm start)
    config.ts            Config loader (file > env > defaults)
    index.ts             Library exports
    adapters/
      adapter.ts         ExecutionAdapter interface
      local/adapter.ts   In-memory adapter for testing
      mech/              OLAS Mech Marketplace + JinnRouter adapter
        adapter.ts       MechAdapter (production adapter)
        contracts.ts     Contract call helpers (submitRestorationJob, claimDelivery, etc.)
        types.ts         ABIs, config types, JINN_ROUTER_ABI
        claim-policy.ts  Request claim strategies
        ipfs.ts          IPFS upload/download via Autonolas gateway
        safe.ts          Safe wallet creation + viem clients
    daemon/
      daemon.ts          Orchestrates creator, restorer, delivery-watcher loops
      creator.ts         Posts desired states via adapter
      restorer.ts        Claims requests, runs Claude, submits results
      delivery-watcher.ts  Claims deliveries, creates evaluation jobs
    runner/
      runner.ts          Runner interface
      claude.ts          Spawns Claude CLI via MCP for restoration/evaluation
      simple.ts          Callback-based runner for testing
    earning/
      bootstrap.ts       11-step state machine (wallet → Safe → staking → mech)
      contracts.ts       Chain config, ABIs, Base addresses
      safe-adapter.ts    Safe deployment + batch tx execution
      store.ts           Earning state persistence (~/.jinn-client/earning/)
      types.ts           EarningState Zod schema
    store/store.ts       SQLite persistence (activity, artifacts, recovery)
    api/
      server.ts          Hono HTTP API for artifact search/publish
      peers.ts           Background peer sync
    auth/erc8128.ts      ERC-8128 HTTP message signatures
    discovery/
      registry.ts        ERC-8004 on-chain artifact registration
      subgraph.ts        The Graph subgraph queries
    mcp/server.ts        MCP tools exposed to Claude subprocess
    x402/                Payment-gated artifact access
    types/               DesiredState, errors, core types
  scripts/
    e2e-validate.ts      Self-contained e2e test on Anvil fork
    staking-validate.ts  Earning bootstrap validation
    mock-agent.ts        Mock agent for testing (replaces Claude)
  fixtures/
    config.example.json  Example config file
    local-config.json    Local adapter test config
  test/                  Vitest tests (14 files, 33 tests)

contracts/       Solidity smart contracts (Hardhat)
  src/
    claiming/
      ClaimRegistry.sol        On-chain claim coordination
      AcceptAllChecker.sol     Phase 0 eligibility (accept all)
      IEligibilityChecker.sol  Checker interface
    staking/
      RestorationActivityChecker.sol  OLAS activity checker
  test/                        Hardhat tests
  scripts/                     Deployment scripts

spec/            Dated specification proposals
docs/            Design specs and implementation plans
```

## Running the Client

### Prerequisites

- Node.js >= 20
- Foundry (`anvil` for local fork, `cast` for funding)
- Claude Code CLI (`claude` in PATH — the daemon spawns it as a subprocess)

### Quick validation (Anvil fork, no real funds)

```bash
cd client
npm install
npx tsc --noEmit   # should be zero errors
npx vitest run      # 33 tests, all pass
npm run e2e         # full loop on Anvil fork of Base
```

The e2e script spawns Anvil, bootstraps from scratch, runs create → restore → evaluate, and verifies staking rewards. Needs internet (Base RPC + IPFS).

### Production run

```bash
cd client
JINN_PASSWORD=your-keystore-password npm start
```

Or with a config file:

```bash
JINN_PASSWORD=secret npm start -- --config ./my-config.json
```

The daemon will:
1. Run the earning bootstrap (wallet → Safe → service → staking → mech)
2. Pause at `awaiting_funding` if the wallet needs ETH/OLAS — fund and re-run
3. Start the daemon with 3 loops (creator, restorer, delivery-watcher)

### Running against Anvil fork (local dev)

```bash
# Terminal 1: start Anvil
anvil --fork-url https://mainnet.base.org --port 8545

# Terminal 2: create config and run
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
# Will pause at awaiting_funding — fund via cast, then re-run
```

Funding on Anvil (use pre-funded account):
```bash
# Fund EOA with ETH
cast send <EOA_ADDRESS> --value 0.01ether \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://127.0.0.1:8545

# Fund Safe with OLAS (impersonate a whale)
cast rpc anvil_impersonateAccount <OLAS_WHALE> --rpc-url http://127.0.0.1:8545
cast send 0x54330d28ca3357F294334BDC454a032e7f353416 \
  "transfer(address,uint256)" <SAFE_ADDRESS> 5000000000000000000000 \
  --from <OLAS_WHALE> --rpc-url http://127.0.0.1:8545 --unlocked
```

## Config

Config file first, env var override. File at `~/.jinn-client/config.json` or `--config <path>`.

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

`JINN_PASSWORD` is env-only — never in config files.

## On-Chain Addresses (Base)

| Component              | Address                                      |
|------------------------|----------------------------------------------|
| JinnRouter             | `0xfFa7118A3D820cd4E820010837D65FAfF463181B` |
| Activity checker proxy | `0x477C41Cccc8bd08027e40CEF80c25918C595a24d` |
| Mech marketplace       | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| Staking contract       | `0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54` |
| OLAS token             | `0x54330d28ca3357F294334BDC454a032e7f353416` |

## Architecture

Three layers, top to bottom:

1. **DAO Layer (Ethereum Mainnet)** — JINN ERC-20 token, treasury with epoch emissions, ve-JINN gauge for directing emissions to distribution contracts (Phase 1+)
2. **Distribution Contracts (per-chain)** — Four incentive channels (creation, restoration, outcome, evaluation rewards), distribute JINN to qualifying participants (Phase 1+)
3. **Execution Layer (Base)** — OLAS Mech Marketplace (request/delivery), JinnRouter (loop enforcement + activity tracking), ERC-8004 (knowledge discovery), x402 (payment-gated knowledge access)

### How the daemon works

The daemon runs three concurrent loops:

1. **CreatorLoop** — posts each desired state once via `JinnRouter.createRestorationJob()`
2. **RestorerLoop** — watches marketplace for requests, claims them, spawns Claude CLI to attempt restoration, submits result via `mech.deliverToMarketplace()`
3. **DeliveryWatcherLoop** — watches for deliveries, calls `JinnRouter.claimDelivery()`, then creates evaluation jobs via `JinnRouter.createEvaluationJob()`

Each JinnRouter call increments activity counters for the Safe multisig. The OLAS staking contract reads these counters at checkpoints to determine reward eligibility.

### Earning bootstrap

The `EarningBootstrapper` walks through 11 idempotent steps:
1. wallet — create agent EOA + encrypted keystore
2. safe_predicted — predict Safe address
3. awaiting_funding — gate until EOA has ETH + Safe has OLAS
4. safe_deployed — deploy Safe via factory
5. service_created — register service on-chain
6. service_activated — approve OLAS bond + activate
7. agents_registered — register agent in service
8. service_deployed — deploy service
9. service_staked — stake service in staking contract
10. mech_deployed — deploy mech via marketplace
11. complete

State persists to `~/.jinn-client/earning/earning_state.json`. Safe to interrupt and re-run.

## Key Roles

- **Creator** — defines desired states and funds restoration
- **Restorer** — attempts to make desired states true
- **Evaluator** — independently verifies restoration success

## Phased Rollout

- **Phase 0** (current): Prove on OLAS ecosystem, single chain (Base), OLAS Mech Marketplace + JinnRouter, optimistic evidence, no JINN token
- **Phase 1**: Fair-launch JINN, deploy DAO (multisig → ve-JINN), distribution contracts, anti-farming + challenge mechanism
- **Phase 2**: Multi-chain, ZK-requiring distribution contracts, broader governance
- **Phase 3**: Autonomous — full ve-JINN governance, USDC revenue exceeds JINN emissions

## Development Commands

```bash
# Client
cd client
npm install          # install deps
npm run build        # tsc compile
npm test             # vitest run (33 tests)
npm run e2e          # end-to-end on Anvil fork
npm run staking      # earning bootstrap validation on Anvil
npm start            # production daemon (requires JINN_PASSWORD)

# Contracts
cd contracts
npm install
npx hardhat test     # Hardhat tests
```

## Spec Conventions

Spec files are named `YYYY-MM-DD-<topic>.md` and placed in `spec/`. Each has a version, date, and author in the header.
