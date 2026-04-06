---
title: Deploying Jinn Worker to Railway
purpose: runbook
scope: [worker, deployment]
last_verified: 2026-01-30
related_code:
  - deploy/worker-default/
  - deploy/control-api/
  - deploy/ponder/
  - worker/mech_worker.ts
keywords: [railway, worker, deployment, control-api, ponder, gemini]
when_to_read: "When deploying or updating the Jinn worker service on Railway"
---

# Deploying Jinn Worker to Railway

> **Note:** For interactive deployment, use the `/deploy-worker` skill which provides step-by-step guidance with Railway MCP tools. This runbook is retained as a reference.
>
> **Feb 2026:** Most service config env vars are now auto-derived on-chain from `JINN_SERVICE_MECH_ADDRESS`. See [On-Chain Derived section](../reference/environment-variables.md#on-chain-derived-auto-resolved) for details. `WORKER_SERVICE_ID`, `WORKER_STAKING_CONTRACT`, and `MECH_MARKETPLACE_ADDRESS_BASE` no longer need to be set.

This guide explains how to deploy the Jinn worker service to Railway.

## Overview

The worker polls Ponder for unclaimed mech requests, executes jobs via Gemini agent, and delivers results on-chain. It requires:

- Access to the Ponder GraphQL endpoint
- Service credentials (private key, Safe address, mech address)
- RPC access to Base mainnet
- GitHub token for repo cloning
- Gemini API key or OAuth credentials for agent execution

## Architecture

The Jinn platform uses two Railway projects:

### Shared Infrastructure (`jinn-shared` project)
These services are shared by all workers and already deployed:

| Service | Purpose | Config |
|---------|---------|--------|
| **Ponder** | Blockchain indexer - indexes mech requests | `deploy/ponder/` |
| **Control API** | Job coordination and status reporting | `deploy/control-api/` |
| **X402 Gateway** | Payment gateway (optional) | `deploy/x402-gateway/` |

### Worker Projects
Each worker deployment is a separate Railway project that connects to the shared services:

| Service | Purpose | Config |
|---------|---------|--------|
| **Worker** | Polls for jobs, executes Gemini agent | `deploy/worker-default/` |

Workers need URLs to the shared services (see Step 4).

### Worker Start Command

The worker start command in `deploy/worker-default/railway.toml`:
```bash
export NODE_OPTIONS='--disable-warning=DEP0040' && bash deploy/worker-default/init.sh && node dist/worker/worker_launcher.js
```

- `NODE_OPTIONS` suppresses punycode deprecation warnings in child processes
- `init.sh` configures git identity, SSH known_hosts, and credentials
- `worker_launcher.js` provides healthcheck server, multi-process support, and graceful shutdown

## Worker Initialization

The worker runs `deploy/worker-default/init.sh` before starting to configure the environment from Railway env vars:

| Configuration | Source Env Var | Persisted To |
|--------------|----------------|--------------|
| Git identity | `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | `~/.gitconfig` |
| SSH known_hosts | (ssh-keyscan github.com) | `~/.ssh/known_hosts` |
| Git credentials | `GITHUB_TOKEN` | `~/.git-credentials` |
| Directories | `JINN_WORKSPACE_DIR` | `~/.gemini/`, workspace |

Expected logs on startup:
```
[init] Set git user.name to: Jinn
[init] Set git user.email to: worker@jinn.network
[init] Added github.com to known_hosts
[init] Created .git-credentials with GitHub token
[init] Ensured ~/.gemini exists
[init] Worker initialization complete
```

## Prerequisites

1. Railway CLI installed: `npm install -g @railway/cli`
2. Access to the Oaksprout Railway workspace
3. Service credentials (private key, Safe address, mech address)

## Step 1: Extract Credentials

From a machine with the configured `.operate` directory, extract the required values:

```bash
# Navigate to the repo
cd jinn-cli-agents

# Get the agent address
AGENT_ADDR=$(cat olas-operate-middleware/.operate/services/*/config.json | jq -r '.chain_configs.base.chain_data.instances[0]')
echo "Agent Address: $AGENT_ADDR"

# Get the private key (SENSITIVE - don't log this!)
PRIVATE_KEY=$(cat "olas-operate-middleware/.operate/keys/$AGENT_ADDR" | jq -r '.private_key')

# Get the Safe address
SAFE_ADDR=$(cat olas-operate-middleware/.operate/services/*/config.json | jq -r '.chain_configs.base.chain_data.multisig')
echo "Safe Address: $SAFE_ADDR"

# Get the Mech address
MECH_ADDR=$(cat olas-operate-middleware/.operate/services/*/config.json | jq -r '.env_variables.MECH_TO_CONFIG.value' | jq -r 'keys[0]')
echo "Mech Address: $MECH_ADDR"
```

## Step 2: Create Railway Project

```bash
# Login to Railway
railway login

# Create a new project in Oaksprout workspace
railway init

# When prompted:
# - Select "Oaksprout" workspace
# - Create new project: "jinn-worker"
```

## Step 3: Link the Repository

In Railway Dashboard:
1. Go to the new project
2. Click "Add Service" → "GitHub Repo"
3. Select `jinn-cli-agents` repository
4. **Important**: In service settings, set the config file to `deploy/worker-default/railway.toml`

Or via CLI:
```bash
railway link
```

## Step 4: Configure Secrets and Config

Set these in Railway Dashboard (Settings → Variables) or via CLI:

### Required Secrets (Railway Variables)

```bash
# Service credentials
railway variables set OPERATE_PASSWORD="your_keystore_password"
railway variables set JINN_SERVICE_SAFE_ADDRESS="0x..."
railway variables set JINN_SERVICE_MECH_ADDRESS="0x..."

# RPC
railway variables set RPC_URL="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY"

# GitHub
railway variables set GITHUB_TOKEN="ghp_..."
railway variables set GIT_AUTHOR_NAME="Jinn Worker"
railway variables set GIT_AUTHOR_EMAIL="worker@jinn.network"

# Gemini (choose one auth method)
railway variables set GEMINI_API_KEY="..."
# Or: railway variables set GEMINI_OAUTH_CREDENTIALS='[{...}]'
```

### Configuration (jinn.yaml on volume)

Service URLs, chain ID, polling intervals, blueprint features, etc. are configured in `jinn.yaml` on the persistent volume. It's auto-generated on first run with correct defaults.

To customize on Railway:
```bash
railway shell
nano /home/jinn/jinn.yaml  # or vi
```

Legacy env var overrides also work (e.g., `CHAIN_ID`, `PONDER_GRAPHQL_URL`).

### Optional Secrets (Railway Variables)

```bash
railway variables set WORKER_ID="worker-community-1"
railway variables set JINN_WORKSPACE_DIR="/app/workspace"
```

### Configuration Overrides (prefer jinn.yaml)

These can be set as Railway variables but **prefer editing jinn.yaml** on the volume:

```bash
# These override jinn.yaml values:
railway variables set WORKSTREAM_FILTER="0x7b2e..."
railway variables set WORKER_STUCK_EXIT_CYCLES="5"
railway variables set CHAIN_ID="8453"
railway variables set GEMINI_SANDBOX="false"
```

## Step 5: Add Persistent Volumes

### Home Directory Volume (Recommended)

Mount `/root` to persist all worker state:
- Git config (`~/.gitconfig`) - configured by init.sh
- SSH known_hosts (`~/.ssh/known_hosts`) - configured by init.sh
- Git credentials (`~/.git-credentials`) - configured by init.sh
- Gemini OAuth (`~/.gemini/`) - managed by worker code, preserves refreshed tokens

1. In Railway Dashboard, go to worker service settings
2. Add Volume: mount path `/root`
3. Name it `worker-home-volume`

### Git Clone Cache (Optional)

For faster job startup with cached repos:

1. Add Volume: mount path `/app/workspace`
2. Set `JINN_WORKSPACE_DIR=/app/workspace` in variables

## Step 6: Deploy

```bash
# Deploy from local
railway up

# Or let Railway auto-deploy from GitHub
# (configure in service settings)
```

## Step 7: Verify

```bash
# Check logs
railway logs

# You should see:
# - [init] messages showing git config
# - "Using mech address from JINN_SERVICE_MECH_ADDRESS: 0x..."
# - "Using safe address from JINN_SERVICE_SAFE_ADDRESS: 0x..."
# - Polling for unclaimed requests
```

## Monitoring

### Logs
```bash
railway logs -f  # Follow logs
railway logs --lines 500  # Last 500 lines
```

### Restart
```bash
railway service restart
```

### Redeploy
```bash
railway up
# or
railway deployment redeploy --yes
```

## Troubleshooting

### Git commit identity errors
```
fatal: unable to auto-detect email address
```
- Ensure `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` are set in Railway variables
- Check logs for `[init] Set git user.name` messages
- Volume must be mounted at `/root` to persist config between deploys

### Deprecated model errors (404)
```
ModelNotFoundError: Requested entity was not found (404)
```
- Jobs with deprecated models (e.g., `gemini-2.0-flash-thinking-exp`) now auto-fallback to default
- Check logs for "Deprecated model detected, falling back to default"
- New job dispatches with deprecated models are rejected with helpful error message

### OAuth quota exhausted
```
RESOURCE_EXHAUSTED: Quota exceeded
```
- Set `GEMINI_OAUTH_CREDENTIALS` with multiple credential sets for automatic rotation
- Worker automatically rotates to next credential when quota exhausted
- Check logs for "Selecting credential with available quota"

### "No mech address found"
- Check `JINN_SERVICE_MECH_ADDRESS` is set correctly
- Must be a valid 40-character hex address with `0x` prefix

### Connection errors to Ponder or Control API
- Verify URLs are correct (get from `jinn-shared` project in Railway)
- Check if Ponder/Control API services are healthy in `jinn-shared` project dashboard
- Try accessing the URL directly in browser (should show GraphQL playground)

### Transaction failures
- Ensure the Safe has sufficient ETH for gas
- Check RPC URL is responsive
- Verify the agent address is a signer on the Safe

### Private repository clone failures
- Ensure `GITHUB_TOKEN` has access to the repository
- Token is automatically configured in `~/.git-credentials` by init.sh
- Check logs for `[init] Created .git-credentials` message

### Worker stuck / not processing jobs
- Set `WORKER_STUCK_EXIT_CYCLES=5` to enable watchdog
- Worker will exit after N consecutive stuck cycles
- Railway restart policy (ON_FAILURE) will recover the service
- Check `WORKSTREAM_FILTER` is set to correct workstream addresses

## Security Notes

1. **Private Key**: Stored encrypted by Railway. Only accessible to project members.
2. **Container Isolation**: Railway containers are isolated. The agent can only access what's explicitly provided.
3. **OAuth Tokens**: Stored in `~/.gemini/` on volume. Refreshed tokens are preserved between jobs.

## Files Reference

| File | Purpose |
|------|---------|
| `deploy/worker-default/railway.toml` | Worker Railway service configuration |
| `deploy/worker-default/nixpacks.toml` | Worker build configuration (Node.js + Gemini CLI) |
| `deploy/worker-default/init.sh` | Worker startup initialization script |
| `deploy/control-api/railway.toml` | Control API service configuration |
| `deploy/ponder/railway.toml` | Ponder indexer service configuration |
| `.railwayignore` | Excludes unnecessary files from build |

## Current Deployment

### Shared Services (`jinn-shared` project)
- Ponder indexer
- Control API
- X402 Gateway

### Worker (`jinn-worker` project)
- Worker running standalone with init.sh
- Volume mounted at `/root` for persistent state
- Connects to shared services via URLs

**Configuration:**
- `WORKSTREAM_FILTER` set to specific workstream addresses
- `WORKER_STUCK_EXIT_CYCLES=5` for automatic recovery
- `GEMINI_OAUTH_CREDENTIALS` for multi-credential quota rotation

**Build:**
- Node.js 22 via Nixpacks
- Gemini CLI installed globally (`npm install -g @google/gemini-cli`)
- Symlink created: `/usr/bin/gemini` → gemini binary

## Recent Fixes

These issues were encountered and fixed:

1. **Private repo cloning** (2ab469e): GITHUB_TOKEN embedded in HTTPS URLs
2. **Child process warnings** (e5ab205): NODE_OPTIONS exported to suppress deprecation
3. **Job status mapping** (193926d): Intermediate statuses properly mapped for DB
4. **Multi-workstream support** (abd0532): WORKSTREAM_FILTER supports arrays
5. **Stuck worker recovery** (ad8da3f): WORKER_STUCK_EXIT_CYCLES watchdog added
6. **Separate services architecture**: Control API now runs as separate Railway service
7. **Worker init script** (32aa933): Git identity and credentials configured on startup
8. **Deprecated model fallback** (f64f47d): Jobs with deprecated models fallback to default
9. **OAuth multi-credential rotation** (69916d5): Automatic failover when quota exhausted
10. **Token preservation on volume** (5af4757): Refreshed OAuth tokens persist between jobs
