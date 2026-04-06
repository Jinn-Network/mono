---
name: local-dev-stack
description: Start a local development stack (Anvil fork + Ponder + Control API) for fast template iteration without touching the public chain.
allowed-tools: Bash, Read, Edit, Glob, Grep
user-invocable: true
---

# Local Dev Stack

Run the full Jinn pipeline locally: Anvil fork of Base mainnet + Ponder indexer + Control API. Dispatch jobs, execute them with a worker, and verify delivery — all without gas costs or public chain interaction.

## Architecture

```
Anvil (:8545)        ← Fork of Base mainnet (ephemeral EVM)
  ↓ events
Ponder (:42070)      ← Indexes on-chain events from Anvil
  ↓ GraphQL
Control API (:4001)  ← Off-chain job management (Supabase)
  ↓
Worker               ← Claims jobs, executes agent, delivers results
```

The script `scripts/local-dev-stack.ts` orchestrates all three services. It forks Base mainnet at the current block, starts Ponder with instant finality, and writes `.env.local-stack` with the connection URLs.

---

## Prerequisites

Before starting, ensure you have:

| Requirement | How to check | Install |
|-------------|-------------|---------|
| Node.js 22+ | `node --version` | [nodejs.org](https://nodejs.org) |
| Yarn | `yarn --version` | `npm install -g yarn` |
| Foundry/Anvil | `anvil --version` | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Supabase creds | Check `.env` for `SUPABASE_URL` | Copy from `.env.template` |
| Worker identity | `.operate` profile or `WORKER_PRIVATE_KEY` in `.env` | See `/setup-worker` skill |
| Gemini CLI | `gemini --version` | [ai.google.dev/gemini-api/docs/gemini-cli](https://ai.google.dev/gemini-api/docs/gemini-cli) |

**Environment variables** — Your `.env` file must contain at minimum:

```bash
SUPABASE_URL=https://clnwgxgvmnrkwqdblqgf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-key>
OPERATE_PASSWORD=<your-password>        # For .operate keystore decryption
```

The script reads `.env` automatically for these. Everything else (RPC, Ponder URLs, etc.) is auto-configured.

---

## Step 1: Start the Stack

```bash
yarn dev:local-stack
```

This will:
1. Check Anvil is installed
2. Kill any processes on ports 8545, 42070, 4001
3. Clean Ponder cache
4. Start Anvil fork of Base mainnet
5. Fund the Safe address (if `MECH_SAFE_ADDRESS` is set or `--safe-address` passed)
6. Start Ponder with instant finality (`PONDER_FINALITY_BLOCK_COUNT=0`)
7. Start Control API
8. Wait for health checks
9. Write `.env.local-stack` with connection URLs
10. Print next-step instructions

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--fork-url <url>` | `https://mainnet.base.org` | Base RPC to fork from (or `RPC_URL` env) |
| `--anvil-port <port>` | `8545` | Anvil JSON-RPC port |
| `--ponder-port <port>` | `42070` | Ponder GraphQL port |
| `--control-port <port>` | `4001` | Control API port |
| `--safe-address <addr>` | `MECH_SAFE_ADDRESS` env | Auto-fund this address with 100 ETH |

**Logs** are written to `/tmp/jinn-local-stack-logs/` — check `anvil.log`, `ponder.log`, `control-api.log` for debugging.

---

## Step 2: Dispatch a Job

In a **separate terminal**, dispatch a job to the local Anvil chain.

**Using dispatch-template.ts** (for blueprint+input pairs):

```bash
RPC_URL=http://127.0.0.1:8545 \
  yarn tsx scripts/dispatch-template.ts \
    blueprints/<template>.json \
    blueprints/inputs/<input>.json
```

**Example with the OODA Venture Orchestrator:**

```bash
RPC_URL=http://127.0.0.1:8545 \
  yarn tsx scripts/dispatch-template.ts \
    blueprints/ooda-venture-orchestrator-local.json \
    blueprints/inputs/ooda-orchestrator-local.json
```

The output will print the request ID — copy it for the next step.

**Using redispatch-job.ts** (for existing job definitions):

```bash
RPC_URL=http://127.0.0.1:8545 \
  PONDER_GRAPHQL_URL=http://localhost:42070/graphql \
  CONTROL_API_URL=http://localhost:4001/graphql \
  yarn tsx scripts/redispatch-job.ts \
    --jobName "<name>" --jobId "$(uuidgen)" \
    --template blueprints/<template>.json \
    --input configs/<config>.json --cyclic
```

**Critical:** The dispatch command MUST use `RPC_URL=http://127.0.0.1:8545` so the marketplace transaction lands on the local Anvil fork, not the public chain.

---

## Step 3: Run the Worker

The worker needs local connection URLs AND a target request ID (because the forked staking state blocks normal job pickup).

```bash
source .env.local-stack && \
  MECH_TARGET_REQUEST_ID=<request-id-from-step-2> \
  yarn dev:mech --single
```

**Why `MECH_TARGET_REQUEST_ID`?** The Anvil fork inherits Base mainnet's staking state. The worker's staking check sees "target already met" and skips normal polling. Setting `MECH_TARGET_REQUEST_ID` bypasses this gate and targets a specific request directly.

**Optional — local x402 gateway** (for Moltbook and other paid tools):

```bash
source .env.local-stack && \
  MECH_TARGET_REQUEST_ID=<id> \
  X402_GATEWAY_URL=http://localhost:3001 \
  yarn dev:mech --single
```

---

## Step 4: Verify Results

**Check Ponder for indexed requests:**

```bash
curl -s http://localhost:42070/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ requests(limit:5, orderBy:\"blockNumber\", orderDirection:\"desc\") { items { id blockNumber } } }"}' \
  | python3 -m json.tool
```

**Check for deliveries:**

```bash
curl -s http://localhost:42070/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ delivers(limit:5, orderBy:\"blockNumber\", orderDirection:\"desc\") { items { id requestId blockNumber } } }"}' \
  | python3 -m json.tool
```

The worker output also prints delivery confirmation with tx hash and block number.

---

## Troubleshooting

### "Staking target met — skipping"

The forked chain has existing staking state that blocks normal job pickup.

**Fix:** Always use `MECH_TARGET_REQUEST_ID=<id>` when running the worker against the local stack.

### Ponder not indexing / stuck

Check that Ponder is using Anvil as its RPC:

```bash
tail -20 /tmp/jinn-local-stack-logs/ponder.log
```

The script sets `PONDER_FINALITY_BLOCK_COUNT=0` automatically. If Ponder seems stuck, it may be waiting for a finality delay — restart the stack.

### Port conflicts

Another process is using 8545, 42070, or 4001. The script attempts to kill existing processes on these ports, but if it fails:

```bash
lsof -ti :8545 | xargs kill   # Kill Anvil
lsof -ti :42070 | xargs kill  # Kill Ponder
lsof -ti :4001 | xargs kill   # Kill Control API
```

Or use custom ports: `yarn dev:local-stack --anvil-port 8546 --ponder-port 42071`

### Ephemeral state

All Anvil state is lost when the stack stops. This means:
- Prior artifacts from `create_artifact` won't appear in `search_artifacts` on restart
- OODA orchestrator's OBSERVE phase may fail on fresh forks (no historical data)
- Each restart is a clean slate

### Control API "unauthorized" errors

The Control API requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in your `.env`. Make sure these are set.

### "No Safe address provided"

The worker's Safe address needs ETH to pay for delivery transactions on Anvil. Either:
- Set `MECH_SAFE_ADDRESS` in your `.env` before starting the stack
- Pass `--safe-address <addr>` to the start command
- Fund manually: `cast rpc anvil_setBalance <address> 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8545`

---

## Key Files

| File | Purpose |
|------|---------|
| `scripts/local-dev-stack.ts` | Stack orchestrator — starts Anvil, Ponder, Control API |
| `scripts/lib/process-manager.ts` | Process lifecycle management (start, health check, kill) |
| `.env.local-stack` | Generated env vars for worker (written by the script) |
| `blueprints/ooda-venture-orchestrator-local.json` | Example OODA orchestrator blueprint for local testing |
| `blueprints/inputs/ooda-orchestrator-local.json` | Example input for OODA orchestrator |
| `blueprints/guerilla-moltbook-local.json` | Example guerilla marketing blueprint for local testing |
| `configs/guerilla-local.json` | Example guerilla marketing config |
| `ponder/ponder.config.ts` | Ponder config — respects `PONDER_FINALITY_BLOCK_COUNT` override |

---

## Quick Reference

```bash
# Terminal 1: Start the stack
yarn dev:local-stack

# Terminal 2: Dispatch a job
RPC_URL=http://127.0.0.1:8545 \
  yarn tsx scripts/dispatch-template.ts \
    blueprints/ooda-venture-orchestrator-local.json \
    blueprints/inputs/ooda-orchestrator-local.json
# → Copy the request ID from output

# Terminal 2: Run the worker
source .env.local-stack && \
  MECH_TARGET_REQUEST_ID=<request-id> \
  yarn dev:mech --single
```
