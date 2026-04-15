---
name: setup-worker
description: Set up and verify a Jinn mech worker — local or remote. Covers operate-profile verification, RPC connectivity, on-chain service resolution, venture filtering, starting the worker, and confirming the first poll cycle.
allowed-tools: Bash, Read, Edit, Glob, Grep
user-invocable: true
---

# Worker Setup

End-to-end setup and verification of a Jinn mech worker. Works for both local development and remote (Railway) deployment.

## Overview

A mech worker needs three things to start cleanly:

1. **Identity** — mech address + private key (from `.operate` profile or env vars)
2. **Connectivity** — RPC URL that reaches Base mainnet and Ponder GraphQL
3. **Filter** — `VENTURE_FILTER` set to the target venture ID(s)

All other config (`WORKER_SERVICE_ID`, `WORKER_STAKING_CONTRACT`, `JINN_SERVICE_SAFE_ADDRESS`, `MECH_MARKETPLACE_ADDRESS_BASE`) is **auto-derived on-chain** from the mech address at startup.

---

## Step 1: Verify .operate Profile

The worker reads credentials from `olas-operate-middleware/.operate/services/*/config.json` unless overridden by env vars.

**Check what the profile contains:**

```bash
# Find the service config
ls olas-operate-middleware/.operate/services/

# Read key fields
python3 -c "
import json, glob
configs = glob.glob('olas-operate-middleware/.operate/services/*/config.json')
for path in configs:
    c = json.load(open(path))
    sc_id = c.get('service_config_id')
    agent_addrs = c.get('agent_addresses', [])
    for chain, data in c.get('chain_configs', {}).items():
        cd = data.get('chain_data', {})
        print(f'Service Config: {sc_id}')
        print(f'  Agent (mech key): {agent_addrs}')
        print(f'  Safe (multisig):  {cd.get(\"multisig\")}')
        mech_cfg = c.get('env_variables', {}).get('MECH_TO_CONFIG', {}).get('value', '')
        if mech_cfg:
            import ast; mc = ast.literal_eval(mech_cfg) if isinstance(mech_cfg, str) else mech_cfg
            print(f'  Mech address(es): {list(mc.keys()) if isinstance(mc, dict) else mech_cfg}')
"
```

**What to verify:**

| Field | Location in config | What it gives you |
|-------|-------------------|--------------------|
| Mech address | `env_variables.MECH_TO_CONFIG` (key of the dict) | Worker identity on-chain |
| Agent key | `agent_addresses[0]` | Signs Safe transactions |
| Safe (multisig) | `chain_configs.base.chain_data.multisig` | Delivers results on-chain |

**Check the encrypted keystore exists:**

```bash
ls olas-operate-middleware/.operate/wallets/
# Should contain: ethereum.txt  (V3 JSON keystore for master EOA)

# Keys directory (agent keys, one per service instance)
ls olas-operate-middleware/.operate/keys/
# Should contain one file per agent address
```

**If `.operate` is missing or empty**, use explicit env vars instead (see Step 2 Option B).

---

## Step 2: Configure Environment Variables

### Option A: `.operate` Profile (local dev)

The profile is auto-loaded. Only add these to `.env`:

```bash
OPERATE_PASSWORD=<password>    # Required — decrypts agent keystore
RPC_URL=https://rpc.jinn.network   # Jinn RPC proxy (recommended)
RPC_PROXY_TOKEN=<40-char-hex>      # Auth token for rpc.jinn.network
```

### Option B: Explicit Env Vars (Railway / no `.operate`)

```bash
JINN_SERVICE_MECH_ADDRESS=0x<mech>      # Mech contract address
JINN_SERVICE_PRIVATE_KEY=0x<hex>        # Agent EOA private key (raw hex, 66 chars)
RPC_URL=https://rpc.jinn.network        # Jinn RPC proxy (or any Base RPC)
RPC_PROXY_TOKEN=<40-char-hex>           # Auth token (only for rpc.jinn.network)
CHAIN_ID=8453
```

`JINN_SERVICE_SAFE_ADDRESS` does NOT need to be set — it is auto-derived from the mech address.

### Set VENTURE_FILTER

```bash
# Single venture
VENTURE_FILTER=<venture-uuid>

# Multiple ventures (comma-separated)
VENTURE_FILTER=<venture-uuid-1>,<venture-uuid-2>
```

Find a venture's ID via `bd ready` or the Jinn explorer at `https://explorer.jinn.network`.

**Note:** `VENTURE_FILTER` is the primary filter as of the venture-workstream separation. `WORKSTREAM_FILTER` (by workstream address) is still supported but coarser-grained — prefer `VENTURE_FILTER` for targeting a specific venture.

### Other required vars

```bash
CONTROL_API_URL=http://localhost:4001/graphql   # local dev
# or
CONTROL_API_URL=https://control-api-production-c1f5.up.railway.app  # production

PONDER_GRAPHQL_URL=https://indexer.jinn.network/graphql  # production default

SUPABASE_URL=https://clnwgxgvmnrkwqdblqgf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<key>
```

---

## Step 3: Verify RPC Connectivity

```bash
# Public RPC (no auth)
curl -s -X POST https://mainnet.base.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | python3 -m json.tool

# Jinn RPC proxy (requires Bearer token)
curl -s -X POST https://rpc.jinn.network \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <RPC_PROXY_TOKEN>' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | python3 -m json.tool
```

Expected: `{"result": "0x..."}` with a recent hex block number.

**RPC Proxy (`rpc.jinn.network`):** Requires `Authorization: Bearer <token>` header. The `createRpcProvider()` helper in `src/config/index.ts` attaches this automatically when `RPC_PROXY_TOKEN` is set. All ethers.js provider creation in `src/` and `scripts/` uses this helper. If you get `401 Unauthorized`, check that `RPC_PROXY_TOKEN` is set and correct (40-char hex string).

---

## Step 4: Run the On-Chain Resolver Standalone

Before starting the full worker, verify that the mech address resolves correctly to the expected service ID, Safe, and staking contract.

```bash
# Using env vars
JINN_SERVICE_MECH_ADDRESS=0x<mech> RPC_URL=https://mainnet.base.org \
  tsx jinn-node/src/worker/onchain/serviceResolver.ts

# Or passing args directly
tsx jinn-node/src/worker/onchain/serviceResolver.ts \
  0x<mech> https://mainnet.base.org
```

**Expected output:**

```json
{
  "serviceId": 165,
  "multisig": "0xb8B7A89760A4430C3f69eeE7Ba5D2B985D593D92",
  "marketplace": "0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020",
  "stakingContract": "0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139",
  "serviceState": 4
}
```

**What each field means:**

| Field | Derived From | What to Check |
|-------|-------------|---------------|
| `serviceId` | `mech.tokenId()` | Should match your service ID |
| `multisig` | `ServiceRegistry.getService(serviceId).multisig` | Your Gnosis Safe — must have ETH for gas |
| `marketplace` | `mech.mechMarketplace()` | Marketplace contract on Base |
| `stakingContract` | `ServiceRegistry.ownerOf(serviceId)` + `getStakingState()` | Non-null = actively staked (earns OLAS rewards). Null = unstaked. |
| `serviceState` | `ServiceRegistry.getService(serviceId).state` | 4 = DEPLOYED (correct). If not 4, service needs to be deployed. |

**Failure modes:**

| Error | Cause | Fix |
|-------|-------|-----|
| `Resolution failed: could not detect network` | RPC_URL unreachable | Check RPC URL and network connectivity |
| `Resolution failed: call revert exception` | Wrong mech address | Verify `JINN_SERVICE_MECH_ADDRESS` is correct |
| `stakingContract: null` | Service not staked | Normal if unstaked; worker still functions but earns no OLAS staking rewards |
| `serviceState: 3` | Service in FINISHED_REGISTRATION | Run deploy step via middleware |

---

## Step 5: Start the Worker

### Local Development

```bash
# Start Control API first (required)
yarn control:dev

# Full worker with pretty logs
yarn dev:mech

# Single job then exit (useful for smoke testing)
yarn dev:mech --single

# Filter by venture
VENTURE_FILTER=<venture-uuid> yarn dev:mech

# Filter by workstream address (alternative)
yarn dev:mech --workstream=0x<workstream>
```

### Remote (Railway)

Required Railway environment variables (set in Railway dashboard):

```
RPC_URL                    = https://rpc.jinn.network
RPC_PROXY_TOKEN            = <40-char-hex-token>
CHAIN_ID                   = 8453
JINN_SERVICE_MECH_ADDRESS  = 0x<mech>
JINN_SERVICE_PRIVATE_KEY   = 0x<key>
VENTURE_FILTER             = <venture-uuid>
CONTROL_API_URL            = https://control-api-production-c1f5.up.railway.app
PONDER_GRAPHQL_URL         = https://indexer.jinn.network/graphql
SUPABASE_URL               = https://clnwgxgvmnrkwqdblqgf.supabase.co
SUPABASE_SERVICE_ROLE_KEY  = <key>
```

Auto-derived — do NOT set manually (set by resolver):
- `WORKER_SERVICE_ID`
- `WORKER_STAKING_CONTRACT`
- `JINN_SERVICE_SAFE_ADDRESS`
- `MECH_MARKETPLACE_ADDRESS_BASE`

Deploy via Railway GitHub branch trigger (not `railway up` — the monorepo is too large for direct upload).

---

## Step 6: Verify First Poll Cycle

A healthy startup produces these log lines in order:

```
Mech worker starting
On-chain service config resolved   {"resolved": {"serviceId": 165, ...}}
Control API health check passed    {"controlApiUrl": "...", "nodeId": "..."}
Fetching requests from Ponder      {"ventureFilter": ["<venture-uuid>"], "workstreamFilter": "none", ...}
```

**Key things to confirm in logs:**

1. `On-chain service config resolved` — resolver succeeded; note the `serviceId` and `stakingContract` values
2. `Control API health check passed` — Control API is reachable
3. `Fetching requests from Ponder` — first poll cycle ran; `ventureFilter` shows your venture ID
4. After the poll: either `No unclaimed on-chain requests found` (idle — normal) or `Processing request` (job found)

**Idle worker (no pending jobs):**
```
No unclaimed on-chain requests found
```
This is normal when the venture has no pending work. The worker backs off and retries.

**Job claimed:**
```
Processing request
├── jobName: "example-job"
├── requestId: "0x..."
└── workstreamId: "0x..."
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `WORKER_PRIVATE_KEY must be a 66-character hex string` | Keystore not decrypted | Set `OPERATE_PASSWORD` to decrypt the `.operate` keystore |
| `Encrypted keystore detected but OPERATE_PASSWORD not set` | Missing password | Add `OPERATE_PASSWORD` to `.env` |
| `Missing service mech address` | No mech configured | Set `JINN_SERVICE_MECH_ADDRESS` or configure `.operate` profile |
| `Control API health check failed` | Control API not running | Run `yarn control:dev` first |
| `On-chain service resolution failed — falling back to env vars` | RPC issue or wrong mech addr | Check RPC connectivity; verify `JINN_SERVICE_MECH_ADDRESS` |
| `ventureFilter: "none"` in logs | `VENTURE_FILTER` not set | Worker will claim ALL ventures — set filter to scope work |
| `No unclaimed on-chain requests found` (persistent) | Wrong venture ID or no pending jobs | Verify `VENTURE_FILTER` matches the venture's UUID; check Ponder for open requests |
| Safe delivery fails | Safe has no ETH | Fund the Safe address with ~0.02 ETH for gas |
| Gemini CLI asks for OAuth after container restart | Docker container runs as `root` but `.gemini` is mounted at `/home/jinn/.gemini`, so `~/.gemini` resolves to `/root/.gemini` and the worker copies no auth into `GEMINI_CLI_HOME` | In `docker-compose.yml`, set `HOME=/home/jinn` and mount `${HOME}/.gemini:/home/jinn/.gemini` writable so Gemini credentials are read from and refreshed back to the mounted directory |

---

## On-Chain Derived Variables Reference

These four variables are automatically resolved at startup from `JINN_SERVICE_MECH_ADDRESS` + `RPC_URL`. Setting them explicitly acts as an override.

| Variable | Derived From | Resolver Call |
|----------|-------------|---------------|
| `WORKER_SERVICE_ID` | Mech's token ID | `mech.tokenId()` |
| `JINN_SERVICE_SAFE_ADDRESS` | Service's multisig | `ServiceRegistry.getService(serviceId).multisig` |
| `MECH_MARKETPLACE_ADDRESS_BASE` | Mech's marketplace | `mech.mechMarketplace()` |
| `WORKER_STAKING_CONTRACT` | NFT owner + staking state | `ServiceRegistry.ownerOf(serviceId)` → `getStakingState(serviceId)` |

**Derivation chain:**
```
JINN_SERVICE_MECH_ADDRESS
  → mech.tokenId()              → serviceId
  → mech.mechMarketplace()      → MECH_MARKETPLACE_ADDRESS_BASE
  → ServiceRegistry.getService(serviceId)
      .multisig                 → JINN_SERVICE_SAFE_ADDRESS
      .state                    → (must be 4 = DEPLOYED)
  → ServiceRegistry.ownerOf(serviceId) → owner
      if owner is contract:
        → owner.getStakingState(serviceId)
          if state == 1 (Staked): → WORKER_STAKING_CONTRACT = owner
          else (0=Unstaked, 2=Evicted): → WORKER_STAKING_CONTRACT = null
```

Source: `jinn-node/src/worker/onchain/serviceResolver.ts`

---

## Key Files

| File | Purpose |
|------|---------|
| `jinn-node/src/worker/mech_worker.ts` | Main worker loop |
| `jinn-node/src/worker/onchain/serviceResolver.ts` | On-chain config resolver (standalone runnable) |
| `olas-operate-middleware/.operate/services/*/config.json` | Service profile (mech, safe, agent key paths) |
| `olas-operate-middleware/.operate/wallets/ethereum.txt` | Master EOA keystore (V3 JSON) |
| `deploy/worker-default/railway.toml` | Railway deploy config |
| `docs/reference/environment-variables.md` | Full env var reference |
| `docs/runbooks/setup-worker.md` | Detailed setup runbook |
