---
title: Mech Worker Setup
purpose: runbook
scope: [worker, deployment]
last_verified: 2026-03-02
related_code:
  - worker/mech_worker.ts
  - worker/config.ts
  - worker/orchestration/jobRunner.ts
  - worker/control_api_client.ts
  - config/schema.ts
  - config/loader.ts
  - config/secrets.ts
  - env/operate-profile.ts
  - control-api/server.ts
  - package.json
keywords: [worker setup, mech worker, installation, configuration, Railway, deployment, jinn.yaml]
when_to_read: "Use when setting up a new worker, configuring environment variables, or troubleshooting worker startup"
---

# Mech Worker Setup Runbook

> **Note:** For interactive setup, use the `/setup-worker` skill which provides guided verification with on-chain checks. This runbook is retained as a reference.
>
> **Feb 2026:** Service config (service ID, Safe address, staking contract, marketplace) is now auto-derived on-chain from the mech address at startup. See [On-Chain Derived section](../reference/environment-variables.md#on-chain-derived-auto-resolved). You can verify resolution with: `tsx jinn-node/src/worker/onchain/serviceResolver.ts`

This runbook provides step-by-step instructions for setting up and running a Jinn mech worker. The worker polls Ponder for unclaimed on-chain mech requests, executes jobs via a Gemini agent, and delivers results on-chain via a Gnosis Safe.

## Overview

The mech worker is the core execution component that:

1. Connects to Ponder GraphQL to discover unclaimed requests
2. Claims requests via the Control API
3. Executes jobs using the Gemini CLI agent
4. Delivers results on-chain via Safe transactions
5. Reports telemetry and artifacts to the Control API

## Prerequisites

Before starting, ensure you have:

- [ ] Node.js v22.0.0 or higher installed
- [ ] Yarn package manager (v1.22.x)
- [ ] Access to an RPC endpoint for Base mainnet (8453) or Base Sepolia (84532)
- [ ] A configured `.operate` directory with service credentials, OR environment variables for Railway deployment
- [ ] Gemini API key for agent execution
- [ ] GitHub token for repository operations (if working with code-based jobs)
- [ ] Supabase project credentials (for Control API backend)

## Step 1: Install Dependencies

```bash
# Clone the repository if not already done
git clone <repository-url>
cd jinn-gemini-3

# Install all dependencies
yarn install

# Build the worker and MCP server
yarn build
```

## Step 2: Configure Environment

### Secrets (.env)

Copy the template and set secrets:

```bash
cp .env.template .env
```

| Variable | Description | Example |
|----------|-------------|---------|
| `RPC_URL` | HTTP RPC endpoint for Base | `https://mainnet.base.org` |
| `OPERATE_PASSWORD` | **Required** - Password to decrypt agent keystores | — |
| `GEMINI_API_KEY` | Google Gemini API key for agent execution | `AIza...` |

### Configuration (jinn.yaml)

`jinn.yaml` is auto-generated on first run with correct defaults. Common overrides:

| YAML Path | Default | Env Override | Description |
|-----------|---------|-------------|-------------|
| `chain.chain_id` | `8453` | `CHAIN_ID` | Network ID |
| `services.ponder_url` | Jinn production | `PONDER_GRAPHQL_URL` | Ponder GraphQL endpoint |
| `services.control_api_url` | Jinn production | `CONTROL_API_URL` | Control API endpoint |
| `worker.poll_base_ms` | `30000` | `WORKER_POLL_BASE_MS` | Base polling interval |
| `worker.mech_filter_mode` | `single` | `WORKER_MECH_FILTER_MODE` | `any` \| `list` \| `single` \| `staking` |
| `filtering.workstreams` | `[]` | `WORKSTREAM_FILTER` | Filter to workstream IDs |
| `agent.sandbox` | `sandbox-exec` | `GEMINI_SANDBOX` | Sandbox mode |

### Service Credentials

Service credentials can come from two sources:

**Option A: `.operate` Directory (Local Development)**

The worker reads credentials from `.operate/`:
- Mech address from `services/*/config.json`
- Safe address from `services/*/config.json`
- Private key from `keys/<agent_address>` (encrypted keystore)

**Option B: Environment Variables (Railway/Production)**

| Variable | Description |
|----------|-------------|
| `JINN_SERVICE_MECH_ADDRESS` | Mech contract address (0x...) |
| `JINN_SERVICE_SAFE_ADDRESS` | Gnosis Safe multisig address (0x...) |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_TOKEN` | GitHub PAT for repository operations | None |
| `GIT_AUTHOR_NAME` | Git author name for agent commits | None |
| `GIT_AUTHOR_EMAIL` | Git author email for agent commits | None |

## Step 3: Set Up Control API

```bash
# Add to .env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Start
yarn control:dev
```

Verify: `curl -X POST http://localhost:4001/graphql -H "Content-Type: application/json" -d '{"query": "{ __typename }"}'`

## Step 4: Set Up Ponder

**Production:** Use default `PONDER_GRAPHQL_URL=https://indexer.jinn.network/graphql`

**Local:** `yarn ponder:dev` (port 42069)

## Step 5: Start the Worker

### Development Mode

```bash
# With pretty-printed logs (recommended for development)
yarn dev:mech

# Raw logs (no formatting)
yarn dev:mech:raw

# Single job execution (process one request then exit)
yarn dev:mech --single

# Limited runs
yarn dev:mech --runs=10
```

### Production Mode

```bash
# Build first
yarn build

# Start the worker
yarn worker:start
```

### Parallel Workers

For processing multiple workstreams simultaneously:

```bash
# Run 3 parallel workers for a specific workstream
yarn dev:mech:parallel --workers=3 --workstream=0x...

# With limited runs per worker
yarn dev:mech:parallel -w 3 -s 0x... --runs=10
```

## Step 6: Verify Worker Operation

### Check Logs

A healthy worker will show:

```
Using mech address from JINN_SERVICE_MECH_ADDRESS: 0x...
Using safe address from JINN_SERVICE_SAFE_ADDRESS: 0x...
Control API health check passed
Mech worker starting
Fetching requests from Ponder
```

### Monitor Job Processing

When the worker claims and processes a job:

```
Processing request
├── jobName: "example-job"
├── requestId: "0x..."
└── workstreamId: "0x..."

Execution completed - status inferred
├── status: "COMPLETED"
└── message: "Job completed successfully"

Delivered via Safe
├── txHash: "0x..."
└── status: "executed"
```

## CLI Flags Reference

| Flag | Description |
|------|-------------|
| `--single` | Process one request then exit |
| `--runs=<N>` | Process up to N requests then exit |
| `--max-cycles=<N>` | Maximum cycles for cyclic workstreams |
| `--stuck-exit-cycles=<N>` | Exit after N consecutive idle cycles |
| `--workstream=<id>` | Filter to specific workstream address |

## Troubleshooting

| Problem | Possible Cause | Solution |
|---------|---------------|----------|
| "WORKER_PRIVATE_KEY must be a 66-character hex string" | Encrypted keystore not decrypted | Set `OPERATE_PASSWORD` env var to decrypt agent keys |
| "Encrypted keystore detected but OPERATE_PASSWORD not set" | Missing password | Set `OPERATE_PASSWORD` in `.env` |
| "Failed to decrypt agent keystore: wrong password" | Incorrect password | Verify `OPERATE_PASSWORD` matches the one used during service setup |
| "Missing service mech address" | Credentials not configured | Set `JINN_SERVICE_*` env vars or configure `.operate` directory |
| "Control API health check failed" | Control API not running | Start with `yarn control:dev` |
| "No unclaimed on-chain requests found" | No pending work | Normal when idle; check `WORKSTREAM_FILTER` if expecting work |
| "Ponder GraphQL not reachable" | Incorrect URL or Ponder down | Verify `PONDER_GRAPHQL_URL` and Ponder status |
| "Claim failed: already claimed" | Another worker claimed first | Normal in multi-worker setups; worker will try next request |
| "Safe delivery failed" | Insufficient gas or incorrect signer | Verify Safe has ETH and agent is a signer |
| "Git push failed" | Missing GitHub token or permissions | Set `GITHUB_TOKEN` with repo access |
| Worker stuck in loop | Agent execution issues | Set `WORKER_STUCK_EXIT_CYCLES` for auto-recovery |

## Key Files

| File | Purpose |
|------|---------|
| `worker/mech_worker.ts` | Main worker loop |
| `worker/orchestration/jobRunner.ts` | Job execution |
| `config/index.ts` | Configuration singleton (backed by jinn.yaml + Zod) |

See `docs/context/system-overview.md` for full architecture.
