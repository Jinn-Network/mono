---
name: deploy-worker
description: Deploy a Jinn worker to Railway. Use when creating a new worker deployment, configuring environment variables for a worker, setting up a Railway project for a new operator, or troubleshooting Railway worker deployments.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Deploy Jinn Worker to Railway

Deploy a Jinn worker node to Railway. Workers are network nodes that poll Ponder for unclaimed mech requests, execute jobs via the Gemini agent, and deliver results on-chain.

## Architecture Orientation

```
On-chain marketplace → Ponder indexer → Worker (Railway) → Gemini agent → delivery
```

Workers connect to two shared infrastructure services (already running in the `jinn-shared` Railway project):

| Shared Service | URL | Set as |
|---------------|-----|--------|
| Ponder | `https://indexer.jinn.network/graphql` | `PONDER_GRAPHQL_URL` |
| Control API | `https://control-api-production-c1f5.up.railway.app` | `CONTROL_API_URL` |

Each worker is its own Railway project (or service within one), linked to the `jinn-cli-agents` repo and configured to build from `deploy/worker-default/railway.toml`. The build uses Docker (`jinn-node/Dockerfile`) with Railway's root directory set to `jinn-node/`.

## Minimal Environment Variables

Only 5 variables are strictly required to run a worker. Everything else is auto-derived on-chain or has safe defaults.

### Required (Must Set)

| Variable | Description | Example |
|----------|-------------|---------|
| `RPC_URL` | Base mainnet RPC endpoint | `https://rpc.jinn.network` |
| `RPC_PROXY_TOKEN` | Auth token for `rpc.jinn.network` proxy (optional if using public RPC) | `<40-char hex>` |
| `CHAIN_ID` | Network ID | `8453` |
| `JINN_SERVICE_MECH_ADDRESS` | Mech contract for this service | `0x...` |
| `JINN_SERVICE_PRIVATE_KEY` | Agent EOA private key (hex) | `0x...` |
| `VENTURE_FILTER` | Venture UUID(s) this worker serves | `a68795df-774d-4782-a72e-3c6c73b91bb7` |

### Auto-Derived On-Chain (Do NOT Set Unless Overriding)

These are resolved at startup from `JINN_SERVICE_MECH_ADDRESS` + `RPC_URL` via `serviceResolver.ts`. Setting them is an explicit override — leave unset for normal deployments.

| Variable | Derived From | Chain Call |
|----------|-------------|-----------|
| `WORKER_SERVICE_ID` | `mech.tokenId()` | Mech contract |
| `WORKER_STAKING_CONTRACT` | `ServiceRegistry.ownerOf(serviceId)` + `getStakingState()` | ServiceRegistry on Base |
| `JINN_SERVICE_SAFE_ADDRESS` | `ServiceRegistry.getService(serviceId).multisig` | ServiceRegistry on Base |
| `MECH_MARKETPLACE_ADDRESS_BASE` | `mech.mechMarketplace()` | Mech contract |

The resolver logs "On-chain service config resolved" with all four values when it succeeds. This is the primary health signal to look for on first boot.

See `jinn-node/src/worker/onchain/serviceResolver.ts` for the derivation chain:
```
mech.tokenId() → serviceId
mech.mechMarketplace() → marketplace
ServiceRegistry.getService(serviceId) → multisig (Safe), state
ServiceRegistry.ownerOf(serviceId) → owner
  if owner is a contract → getStakingState(serviceId) → 1=staked, 0/2=not
```

### Also Required

| Variable | Description |
|----------|-------------|
| `PONDER_GRAPHQL_URL` | Ponder GraphQL endpoint (from `jinn-shared` project) |
| `CONTROL_API_URL` | Control API endpoint (from `jinn-shared` project) |
| `GITHUB_TOKEN` | GitHub PAT — used for repo cloning and pushing |
| `GIT_AUTHOR_NAME` | Git commit author name (e.g., `Jinn Worker`) |
| `GIT_AUTHOR_EMAIL` | Git commit author email (e.g., `worker@jinn.network`) |
| `GEMINI_API_KEY` **or** `GEMINI_OAUTH_CREDENTIALS` | Gemini auth (see below) |

### Gemini Auth (Choose One)

**Option A — API Key (simpler):**
```bash
GEMINI_API_KEY=AIza...
```

**Option B — OAuth credentials (supports multi-credential rotation for quota):**
```bash
GEMINI_OAUTH_CREDENTIALS='[{"oauth_creds":{...},"google_accounts":{...}}]'
```

When `GEMINI_API_KEY` is set, `init.sh` force-writes `~/.gemini/settings.json` to use API key auth and removes any stale OAuth files from the volume.

## Step-by-Step Deployment

### Step 1: Extract Service Credentials

From a machine with the `.operate` directory configured:

```bash
cd /path/to/jinn-cli-agents

# Agent (mech) address
MECH_ADDR=$(cat olas-operate-middleware/.operate/services/*/config.json \
  | jq -r '.env_variables.MECH_TO_CONFIG.value | keys[0]')
echo "Mech: $MECH_ADDR"

# Safe address
SAFE_ADDR=$(cat olas-operate-middleware/.operate/services/*/config.json \
  | jq -r '.chain_configs.base.chain_data.multisig')
echo "Safe: $SAFE_ADDR"

# Agent instance address (to look up private key)
AGENT_ADDR=$(cat olas-operate-middleware/.operate/services/*/config.json \
  | jq -r '.chain_configs.base.chain_data.instances[0]')

# Private key (SENSITIVE — do not log)
PRIVATE_KEY=$(cat "olas-operate-middleware/.operate/keys/$AGENT_ADDR" \
  | jq -r '.private_key')
```

### Step 2: Create Railway Project

**Via Railway Dashboard:**
1. Go to [railway.app](https://railway.app) → New Project
2. "Deploy from GitHub repo" → select `jinn-cli-agents`
3. Name the project (e.g., `jinn-worker-<venture-slug>`)

**Via MCP tools** (if Railway MCP is available):
```
mcp__Railway__create-project-and-link
```

### Step 3: Configure Railway Service Settings

**Root directory:** `jinn-node/` — set via Railway service settings (or GraphQL `serviceInstanceUpdate` with `rootDirectory: "jinn-node/"`). This scopes the Docker build context to `jinn-node/`, so the Dockerfile's relative paths resolve correctly.

**Config file:** Railway auto-detects `jinn-node/railway.toml` (relative to root directory). This file sets the Docker builder, start command, healthcheck, and restart policy.

The build uses Docker (`jinn-node/Dockerfile`). **ALWAYS use Docker builds. Do NOT switch to NIXPACKS or RAILPACK.**

The start command in `railway.toml` (paths relative to root directory):
```bash
sh -c 'bash scripts/init.sh && node dist/worker/worker_launcher.js'
```

### Step 4: Set Environment Variables

Set via Railway Dashboard (Settings → Variables) or CLI:

```bash
# Minimal required set
railway variables set RPC_URL="https://mainnet.base.org"
railway variables set CHAIN_ID="8453"
railway variables set JINN_SERVICE_MECH_ADDRESS="0x..."
railway variables set JINN_SERVICE_PRIVATE_KEY="0x..."
railway variables set VENTURE_FILTER="<venture-uuid>"

# Shared infrastructure (use production URLs from jinn-shared project)
railway variables set PONDER_GRAPHQL_URL="https://indexer.jinn.network/graphql"
railway variables set CONTROL_API_URL="https://control-api-production-c1f5.up.railway.app"

# GitHub
railway variables set GITHUB_TOKEN="ghp_..."
railway variables set GIT_AUTHOR_NAME="Jinn Worker"
railway variables set GIT_AUTHOR_EMAIL="worker@jinn.network"

# Gemini (API key is simplest)
railway variables set GEMINI_API_KEY="AIza..."

# Recommended: disable sandbox (Railway containers are already isolated)
railway variables set GEMINI_SANDBOX="false"

# Recommended: enable watchdog to recover from stuck workers
railway variables set WORKER_STUCK_EXIT_CYCLES="5"
```

**Via MCP tools:**
```
mcp__Railway__set-variables
```

### Step 5: Add Persistent Volume

Mount `/root` to persist state across deploys:
- `~/.gitconfig` — git identity configured by `init.sh`
- `~/.ssh/known_hosts` — GitHub SSH fingerprint
- `~/.git-credentials` — HTTPS credentials for push
- `~/.gemini/` — OAuth tokens (refreshed tokens survive redeploys)

In Railway Dashboard: service settings → Volumes → Add → mount path `/root`, name `worker-home-volume`.

A second volume at `/app/workspace` (with `JINN_WORKSPACE_DIR=/app/workspace`) speeds up subsequent jobs by caching git clones.

### Step 6: Set Deploy Trigger

Link to a specific GitHub branch (Railway will auto-deploy on push):
- Go to service settings → Source → select branch (e.g., `main`)

**Important:** The monorepo is too large to upload via `railway up`. Always use a GitHub branch deploy trigger instead.

If you need to update the trigger branch programmatically, use the Railway GraphQL API mutation `deploymentTriggerUpdate`.

### Step 7: Deploy and Verify

Trigger a deploy (push to branch or click "Deploy" in dashboard), then watch logs:

```bash
railway logs -f
```

**Expected startup sequence:**
```
[init] Set git user.name to: Jinn Worker
[init] Set git user.email to: worker@jinn.network
[init] Added github.com to known_hosts
[init] Created .git-credentials with GitHub token
[init] Configured Gemini CLI for API key auth (forced)
[init] Ensured ~/.gemini exists
[init] Worker initialization complete
...
On-chain service config resolved  ← KEY SIGNAL: derived config loaded from chain
...
Worker polling for unclaimed requests
```

The "On-chain service config resolved" log (from `serviceResolver.ts`) confirms that `serviceId`, `multisig`, `marketplace`, and `stakingContract` were all derived successfully.

**Via MCP tools:**
```
mcp__Railway__get-logs
mcp__Railway__list-deployments
```

## VENTURE_FILTER vs WORKSTREAM_FILTER

These serve different filtering purposes:

| Variable | Filters By | Format |
|----------|-----------|--------|
| `VENTURE_FILTER` | Venture UUID(s) — limits which ventures' jobs this worker claims | Single UUID or comma-separated list |
| `WORKSTREAM_FILTER` | Workstream hex IDs — limits which on-chain workstreams this worker claims from | Single hex, comma-separated, or JSON array |

For venture-specific workers, `VENTURE_FILTER` is the primary filter. `WORKSTREAM_FILTER` can be used in addition for finer-grained control over which on-chain workstreams are served.

## Optional Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_ID` | auto | Worker identifier in logs |
| `WORKER_JOB_DELAY_MS` | `0` | Delay between jobs (ms) — set to `120000` for polite behavior |
| `JINN_WORKSPACE_DIR` | `~/jinn-repos` | Git clone cache directory |
| `WORKER_STUCK_EXIT_CYCLES` | none | Exit after N stuck cycles (Railway restarts on failure) |
| `MECH_RECLAIM_AFTER_MINUTES` | — | Reclaim undelivered requests after N minutes |
| `BLUEPRINT_ENABLE_BEADS` | `true` | Disable if not using beads issue tracking |
| `BLUEPRINT_ENABLE_CONTEXT_PHASES` | `true` | Disable to skip recognition/reflection |
| `WORKER_DEPENDENCY_AUTOFAIL` | `1` | Auto-cancel jobs with unresolvable dependencies |
| `WORKER_TX_CONFIRMATIONS` | `3` | On-chain confirmations before proceeding |

Full reference: [docs/reference/environment-variables.md](../../docs/reference/environment-variables.md)

## Deploy Config Files

| File | Purpose |
|------|---------|
| `jinn-node/railway.toml` | Railway service config (Docker builder, start command, healthcheck) |
| `jinn-node/Dockerfile` | Docker multi-stage build (Node 22, Python, Gemini CLI, worker build) |
| `jinn-node/scripts/init.sh` | Startup script: git identity, SSH known_hosts, credentials, gemini dir |

## Troubleshooting

### "On-chain service config resolved" never appears

- Verify `JINN_SERVICE_MECH_ADDRESS` is a valid `0x...` address for the correct mech contract
- Verify `RPC_URL` is reachable from Railway (use a reliable provider — `mainnet.base.org` works but can rate-limit)
- Run the resolver standalone to diagnose: `tsx jinn-node/src/worker/onchain/serviceResolver.ts <mechAddress> <rpcUrl>`

### No jobs claimed (worker polls but skips all requests)

- Check `VENTURE_FILTER` matches the venture UUID exactly (from Supabase `ventures` table)
- Check `WORKSTREAM_FILTER` if set — must match hex workstream IDs from on-chain requests
- Look for "Skipping request" log lines that explain why requests are being skipped

### Git commit failures

```
fatal: unable to auto-detect email address
```

- Ensure `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` are set
- Volume at `/root` must be mounted — without it, `~/.gitconfig` is lost on restart
- Confirm logs show `[init] Set git user.name` on startup

### Builder: DOCKERFILE vs Railpack

The worker is designed for Docker builds via `jinn-node/Dockerfile` (installs git, chromium, Gemini CLI, creates non-root user). Railway may auto-migrate to RAILPACK, which causes issues:

**How to detect:** Check build logs — DOCKERFILE shows `docker build` steps; Railpack shows `railpack-plan.json` and `[railpack]` lines.

**Key differences between DOCKERFILE and Railpack builds:**

| | DOCKERFILE | Railpack |
|---|-----------|----------|
| Start command | `railway.toml` `startCommand` or Dockerfile `CMD` | `package.json` `start` script or `main` field |
| System packages | Installed via `apt-get` (git, chromium, ssh) | Minimal — no git, no chromium, no ssh |
| Working directory | `/app` (Dockerfile WORKDIR) | `/app` (auto) |
| Config file | `jinn-node/railway.toml` respected | `railway.toml` builder setting IGNORED |
| Volume path | `/home/jinn` (non-root user) | `/home/jinn` (same mount, but runs as root) |

**`railway up` always uses Railpack** regardless of `railway.toml` `builder = "DOCKERFILE"`. It also uploads from the **git root** (monorepo), not the current directory. The monorepo root `package.json` has a `start` script that routes to the correct entry point.

**If Railpack is acceptable** (no git/chromium needed): Ensure `OPERATE_PROFILE_DIR=/home/jinn/.operate` is set as an env var (Dockerfile sets this via ENV, but Railpack doesn't).

**To force DOCKERFILE builds:** Use GitHub branch deploy triggers instead of `railway up`, or fix via GraphQL API:
```bash
# Use serviceInstanceUpdate mutation to force builder back to DOCKERFILE
# (See Railway GraphQL API — serviceInstanceUpdate with builder: DOCKERFILE)
```

**init.sh compatibility:** The `scripts/init.sh` startup script guards git/ssh commands behind `command -v git` so it works in both DOCKERFILE and Railpack environments.

### Gemini quota exhausted

- Switch from `GEMINI_API_KEY` to `GEMINI_OAUTH_CREDENTIALS` with multiple credential sets
- Worker automatically rotates to next credential when quota is hit
- Volume at `/root` preserves refreshed OAuth tokens between restarts

### Private repo clone failures

- Ensure `GITHUB_TOKEN` has `repo` scope
- Confirm `[init] Created .git-credentials` appears in startup logs
- Token is embedded in HTTPS clone URLs by `init.sh`

### Worker stuck / not progressing

- Set `WORKER_STUCK_EXIT_CYCLES=5` — Railway's ON_FAILURE restart policy will recover it
- Check logs for repeated "stuck cycle" messages
- Verify the Safe has ETH for gas and the agent key is a Safe signer

## Railway MCP Operations

When Railway MCP tools are available, use them for operations instead of the CLI:

| Operation | MCP Tool |
|-----------|---------|
| List projects | `mcp__Railway__list-projects` |
| List services | `mcp__Railway__list-services` |
| Get logs | `mcp__Railway__get-logs` |
| Set variables | `mcp__Railway__set-variables` |
| List variables | `mcp__Railway__list-variables` |
| Trigger deploy | `mcp__Railway__deploy` |
| Check status | `mcp__Railway__check-railway-status` |
| List deployments | `mcp__Railway__list-deployments` |
| Generate domain | `mcp__Railway__generate-domain` |

## Multi-Service Deployment

When running multiple staked services from a single Railway worker, enable the `ServiceRotator` which automatically cycles through services based on activity needs.

### Required Environment Variables

```bash
WORKER_MULTI_SERVICE=true          # Enable ServiceRotator
WORKER_COUNT=3                     # Parallel workers (see capacity below)
WORKER_ACTIVITY_POLL_MS=60000      # Activity poll interval
WORKER_ACTIVITY_CACHE_TTL_MS=60000 # Cache TTL
```

### Credential Import (Volume-Based — NOT Environment Variables)

**CRITICAL:** Multi-service credentials are stored on the **Railway persistent volume** at `/home/jinn/.operate/`, NOT as environment variables. The worker discovers services by scanning `.operate/services/sc-*/` on the volume.

**DO NOT** set `OPERATE_SERVICE_sc_*_CONFIG` or `OPERATE_SERVICE_sc_*_KEYS` environment variables. This is incorrect and leads to stale/orphaned env vars that don't do anything useful. The worker reads from the volume, not env vars.

After provisioning new services (see `skills/fleet-management/SKILL.md`), deploy to Railway:

```bash
# Import .operate/ + .gemini/ to volume via SSH (tar + base64 over railway ssh)
yarn deploy:railway -- --project <project-name>

# Code-only redeploy (credentials already on volume, unchanged)
yarn deploy:railway -- --project <project-name> --skip-import
```

**How it works:** The deploy script tars `.operate/` (excluding `services/*/deployment` venvs), base64-encodes it, and sends via `railway ssh` to extract at `/home/jinn/.operate/` on the persistent volume. The `ServiceConfigReader` automatically discovers all `sc-*/config.json` directories on startup.

**Prerequisite:** `.operate` must be accessible from `jinn-node/`. Verify the symlink exists:
```bash
ls -la jinn-node/.operate  # should point to ../olas-operate-middleware/.operate
```

### Worker Count Tuning

Each service needs ~61 deliveries/day (liveness ratio). Average job execution is ~4 minutes.

| WORKER_COUNT | Jobs/Day | Max Services |
|--------------|----------|-------------|
| 1 | ~360 | ~5 |
| 2 | ~720 | ~11 |
| 3 | ~1,080 | ~17 |

Choose `WORKER_COUNT` based on your total staked services. Over-provisioning wastes compute; under-provisioning risks eviction.

### Fleet Monitoring

```bash
# Check fleet health from the provisioning machine
yarn service:fleet

# JSON output for automation
yarn service:fleet --json
```

The `/health` endpoint (port 8080) includes fleet state when multi-service is enabled — see `skills/fleet-management/SKILL.md` for details.

---

## Known Railway Deployment Patterns

- **`railway up` uses Railpack**: `railway up` always uses the Railpack builder, ignoring `railway.toml` `builder = "DOCKERFILE"`. It also uploads from the git root (monorepo), not `jinn-node/`. The monorepo root `package.json` `start` script routes to the correct entry point. For DOCKERFILE builds, use GitHub branch deploy triggers instead.
- **`railway up` needs `OPERATE_PROFILE_DIR`**: Railpack images don't set `OPERATE_PROFILE_DIR` (the Dockerfile does via `ENV`). Set it as a Railway env var: `OPERATE_PROFILE_DIR=/home/jinn/.operate`.
- **Auto-relink after deploy**: After `railway up`, the CLI may relink to a different service. Always verify which service is linked before deploying.
- **Builder migration**: Railway may silently migrate services away from DOCKERFILE. Detect by checking build logs (`railpack-plan.json` = Railpack, `docker build` = DOCKERFILE). Fix with `serviceInstanceUpdate` mutation setting `builder: DOCKERFILE`.
- **Worker count**: Set `WORKER_COUNT` env var to run multiple parallel workers in one service. Each gets a prefixed log output.
- **Symlink gotcha**: `jinn-node/.operate` is a symlink to `../olas-operate-middleware/.operate`. When tarring for SSH import, use `tar -h` (follow symlinks) or the tar will upload the symlink itself, not the actual data. The deploy script handles this correctly, but manual imports must use `-h`.
- **Volume mount path**: The deploy script expects the volume at `/home/jinn`. If the Railway volume is mounted at a different path (e.g., `/root`), the `ensure_volume` step will fail. Check with `railway volume list` and ensure `MIDDLEWARE_PATH` env var matches the volume mount location.
