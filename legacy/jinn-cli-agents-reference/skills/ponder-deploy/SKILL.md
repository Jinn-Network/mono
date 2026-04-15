---
name: ponder-deploy
description: Safely deploy Ponder indexer changes to Railway. Use when updating Ponder schema, indexing logic, or config. Covers sandbox-first workflow, schema versioning, backfill monitoring, and rollback.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Safe Ponder Deployment

Deploy Ponder indexer changes without breaking production. Every code or config change triggers a full re-index (hours of downtime if done in-place), so all deployments go through a sandbox-first pattern.

## Why This Matters

Ponder computes a `build_id` = SHA-256 hash of:
```
BUILD_ID_VERSION + config.contentHash + schema.contentHash + indexingFunctions.contentHash
```

ANY change to config, schema, or `index.ts` produces a new build_id. If the build_id doesn't match the existing schema, Ponder drops all data and re-indexes from scratch. During backfill it serves no data. Production goes dark.

---

## 1. Safe Update Workflow

### Step 1: Create Sandbox Project

```bash
# Create a new Railway project for the sandbox
railway project create "ponder-sandbox"

# Add Postgres (use Railway's template or add a plugin)
# Then create a Ponder service in the project
```

### Step 2: Configure Environment Variables

Set all required env vars on the sandbox Ponder service. Use Railway variable references for Postgres:

```bash
railway variables set \
  PONDER_DATABASE_URL='${{Postgres.DATABASE_URL}}' \
  PONDER_SCHEMA_VERSION='jinn_sandbox_v1' \
  PONDER_VIEWS_SCHEMA='jinn_sandbox_public' \
  PONDER_FACTORY_START_BLOCK='36000000' \
  PONDER_START_BLOCK='36000000' \
  PONDER_PORT='42069' \
  PONDER_RPC_URL='<tenderly-gateway-url>' \
  RPC_URL='<tenderly-gateway-url>' \
  BASE_LEDGER_RPC='<tenderly-gateway-url>' \
  MECH_ADDRESS='0x8c083Dfe9bee719a05Ba3c75A9B16BE4ba52c299' \
  -s ponder
```

### Step 3: Set Deploy Trigger to Feature Branch

Do NOT use `railway up` -- the monorepo is too large. Use GitHub branch deploy triggers instead:

```bash
# Get the trigger ID first
railway triggers list -s ponder

# Then set branch via GraphQL (see Section 9)
```

### Step 4: Deploy and Wait for Backfill

```bash
# Generate a public domain
railway domain -s ponder

# Watch logs for backfill progress
railway logs -s ponder --lines 200
```

Wait for the `/ready` endpoint to return 200. This means backfill is complete. Backfill from block 36M typically takes 30-60 minutes depending on RPC speed.

### Step 5: Verify Data Quality

Query the sandbox GraphQL endpoint and compare against production:

- Workstream count matches (or exceeds) production
- `jobName` fields are populated (not null)
- Recent deliveries are indexed
- `ventureId` / `templateId` fields populated where expected

### Step 6: Swap Frontend to Sandbox

Update the frontend's `PONDER_GRAPHQL_URL` (or equivalent) to point at the sandbox URL. Verify the UI loads correctly.

### Step 7: Decommission Old Deployment

- Stop (do NOT delete) the old production Ponder service
- Keep it available for 48 hours as a rollback target
- After confirming stability, delete the old service and rename sandbox to production

---

## 2. Schema Version Rules

| Env Var | Controls | Naming Convention |
|---------|----------|-------------------|
| `PONDER_SCHEMA_VERSION` | Postgres schema for indexed data | `jinn_shared_v{N}` (prod), `jinn_sandbox_v{N}` (sandbox) |
| `PONDER_VIEWS_SCHEMA` | Postgres schema for client-facing views | `jinn_shared_public` (prod), `jinn_sandbox_public` (sandbox) |

**Rules:**
- ALWAYS set `PONDER_SCHEMA_VERSION`. Without it, each deploy creates an orphaned schema with a random name.
- ALWAYS bump the version number when deploying new code. Even a one-line change to `index.ts` changes the build_id.
- Two Ponder instances must NEVER share the same `PONDER_VIEWS_SCHEMA` -- they will overwrite each other's views.
- Env var changes (like `PONDER_START_BLOCK`) also change the build_id via config hash.

**Current production:** `jinn_shared_v17`

### Pre-Deploy Script (Automatic)

A `preDeployCommand` in `railway.toml` runs `ponder/scripts/pre-deploy.mjs` before every deploy. It handles:

1. **Locked schema from crashed deploy** (`is_locked=1, is_ready=0`): Drops the incomplete schema so Ponder recreates it fresh.
2. **Stale incomplete schema** (`is_locked=0, is_ready=0`): Same — drops and recreates.
3. **Completed schema** (`is_ready=1`): Left intact. Ponder reuses it (hot start) if the build_id matches, or fails with a clear mismatch error if code changed.
4. **No schema yet**: Nothing to do — fresh deploy.

This means you can safely **reuse the same `PONDER_SCHEMA_VERSION`** across failed/retried deploys. Only bump the version when you want a fresh schema alongside the old one (e.g., for A/B comparison).

### Manual: Detect Next Available Schema Version

If you need to pick a new schema version (code changed, or want to keep old data):

```bash
# Query the Railway Postgres for existing jinn_shared_v* schemas
node -e "
const { Client } = require('pg');
const c = new Client('postgresql://postgres:mRsjrrrbOxPFFUWHSFPWjPmbIUBKuQTX@shortline.proxy.rlwy.net:27666/railway');
c.connect()
  .then(() => c.query(\"SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'jinn_shared_v%' AND schema_name NOT LIKE '%public%' ORDER BY schema_name\"))
  .then(r => {
    const versions = r.rows.map(x => parseInt(x.schema_name.replace('jinn_shared_v','')));
    const max = Math.max(...versions);
    console.log('Existing versions:', versions.sort((a,b)=>a-b).join(', '));
    console.log('Next available: jinn_shared_v' + (max + 1));
    c.end();
  }).catch(e => { console.error(e.message); c.end(); });
"
```

If the DB public URL has changed, get it from `railway variables -s ponder-db --kv | grep DATABASE_PUBLIC_URL`.

---

## 3. Zero-Downtime Deployment (healthcheckPath=/ready)

As of Feb 2026, `deploy/ponder/railway.toml` includes:

```toml
[deploy]
healthcheckPath = "/ready"
healthcheckTimeout = 3600
```

**How it works:**
1. New deployment starts, begins backfilling into the new private schema (e.g., `jinn_shared_v17`)
2. Railway polls `/ready` — Ponder returns **503** during backfill
3. The **old deployment stays alive** and serves traffic the entire time
4. When backfill completes, Ponder atomically swaps SQL VIEWs in the views-schema (e.g., `jinn_staging_v7_public`) to point at the new private schema tables
5. `/ready` returns **200** → Railway routes traffic to the new instance and kills the old one

**Key implications:**
- No downtime during re-index — old data stays served until new data is ready
- The 3600s (1 hour) timeout covers typical backfill duration. If backfill takes longer, Railway will mark the deployment as failed
- Both old and new instances write to the **same Postgres cluster** but different schemas
- The `PONDER_VIEWS_SCHEMA` is the traffic cutover point — it must be the same for both old and new so the view swap is seamless

**Backfill duration depends heavily on IPFS gateway availability.** Both `gateway.autonolas.tech` and `ipfs.io` frequently timeout during backfill, causing each Jinn request to wait through the full retry chain before falling back to "indexing without metadata." This is expected — IPFS metadata fetching is essential for populating `jobName`, `ventureId`, `templateId`, and artifact data. Without it, indexed requests lack context and the explorer shows empty fields.

**Typical backfill times:**
- With healthy IPFS gateways: ~30-60 minutes from block 36M
- With degraded IPFS (timeouts): 2-3+ hours
- Current `healthcheckTimeout` is set to **10800s (3 hours)** in `railway.toml`

**If backfill exceeds the timeout:** Railway marks the deployment as failed and the old deployment stays active (safe, no data loss). Increase `healthcheckTimeout` in `deploy/ponder/railway.toml`, push, and redeploy. Do NOT raise `PONDER_START_BLOCK` to skip IPFS — that skips real data.

---

## 4. Environment Variable Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `PONDER_DATABASE_URL` | Postgres connection string | `${{Postgres.DATABASE_URL}}` |
| `PONDER_SCHEMA_VERSION` | Schema name for indexed data | `jinn_sandbox_v1` |
| `PONDER_VIEWS_SCHEMA` | Schema name for client views | `jinn_sandbox_public` |
| `PONDER_FACTORY_START_BLOCK` | Block to start factory indexing | `36000000` |
| `PONDER_START_BLOCK` | Block to start event indexing | `36000000` |
| `PONDER_PORT` | HTTP server port | `42069` |
| `PONDER_RPC_URL` | Base chain RPC URL | Tenderly gateway |
| `RPC_URL` | Alias used by some code paths | Same as `PONDER_RPC_URL` |
| `BASE_LEDGER_RPC` | Another RPC alias | Same as `PONDER_RPC_URL` |
| `MECH_ADDRESS` | Mech contract to index | `0x8c083Dfe9bee719a05Ba3c75A9B16BE4ba52c299` |

---

## 5. Monitoring Checklist

**During backfill:**
- [ ] `/ready` endpoint returns 200 when backfill complete (503 during backfill)
- [ ] Build logs show "nixpacks" builder (NOT railpack)
- [ ] Deploy logs: no IPFS timeouts (cloudflare-ipfs.com is dead -- must use ipfs.io)
- [ ] Deploy logs: no RPC rate-limit errors
- [ ] Block numbers in logs are advancing toward chain head

**After backfill:**
- [ ] GraphQL endpoint responds
- [ ] Workstream count matches production
- [ ] `jobName` fields populated (not null) on recent requests
- [ ] `ventureId` / `templateId` populated where expected
- [ ] `lastStatus` / `latestStatusUpdate` populated on workstreams

---

## 6. Rollback Procedure

**If sandbox fails verification:**
1. Frontend stays pointed at old production -- no action needed
2. Fix issues in sandbox, redeploy, re-verify

**If new production crashes after swap:**
1. Point frontend back to old production URL
2. Stop the new (broken) service
3. Restart old production service
4. Investigate and fix before retrying

**Key:** Never delete the old production service until the new one has been stable for 48+ hours.

---

## 7. Gotchas

- **build_id = full re-index**: ANY change to config, schema, or indexing code means the entire index rebuilds from scratch. There is no incremental migration. You cannot `ALTER TABLE` to avoid it.
- **cloudflare-ipfs.com is DEAD**: Returns ENOTFOUND. Use `ipfs.io` for IPFS gateway. This was causing 5-10s delays per request during backfill.
- **Railway auto-migrates to RAILPACK**: Services may silently switch from NIXPACKS to RAILPACK, breaking the build. Fix with the `serviceInstanceUpdate` GraphQL mutation (set `builder: NIXPACKS`).
- **`railway up` is too slow for monorepo**: The upload is too large and times out. Use GitHub branch deploy triggers instead.
- **Views-schema collision**: If two Ponder instances share the same `PONDER_VIEWS_SCHEMA`, they overwrite each other's views. Always use distinct values.
- **Orphaned schemas accumulate**: Without `PONDER_SCHEMA_VERSION`, each deploy creates a new schema with a generated name. These pile up in Postgres and waste storage.
- **Ponder filter syntax is flat**: Use `where: { field: $var, field_gte: $val }`, NOT nested `{ field: { equals: $var } }`. Ponder is not standard GraphQL filter syntax.
- **Schema locking/collision (auto-handled)**: The `preDeployCommand` (`ponder/scripts/pre-deploy.mjs`) automatically drops incomplete schemas from crashed deploys. You only need to bump `PONDER_SCHEMA_VERSION` when the code changes AND you want to keep the old schema's data. Redeploying with the same version after a failure is safe.
- **Build optimization**: `rm -rf frontend packages` before `yarn install` in the build phase to skip workspace deps unused by Ponder. Cuts build from 16min to ~97s. Configured in `deploy/ponder/nixpacks.toml`.
- **Old schemas cleanup**: Run periodic cleanup of orphaned schemas. 190 were cleaned in Feb 2026.

---

## 8. Railway Commands Reference

```bash
# Create project
railway project create "ponder-sandbox"

# List services
railway service list

# Set env vars on a service
railway variables set KEY=VALUE -s ponder

# Generate public domain
railway domain -s ponder

# Check logs
railway logs -s ponder --lines 100

# List deploy triggers
railway triggers list -s ponder
```

---

## 9. Deploy Trigger Configuration

Use the Railway GraphQL API to set the deploy trigger to a specific branch and config file:

```bash
# Set deploy trigger to feature branch
curl -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { deploymentTriggerUpdate(id: \"<TRIGGER_ID>\", input: { branch: \"feat/my-branch\", rootDirectory: \"/\" }) { id branch } }"
  }'
```

**To force NIXPACKS builder** (if Railway auto-migrated to RAILPACK):

```bash
curl -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { serviceInstanceUpdate(serviceId: \"<SERVICE_ID>\", environmentId: \"<ENV_ID>\", input: { builder: NIXPACKS }) { id } }"
  }'
```

**After merge to main:** Remember to update the deploy trigger back to `main`:

```bash
curl -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { deploymentTriggerUpdate(id: \"<TRIGGER_ID>\", input: { branch: \"main\" }) { id branch } }"
  }'
```

---

## Key File Locations

| File | Purpose |
|------|---------|
| `ponder/src/index.ts` | Indexing functions (changes trigger re-index) |
| `ponder/ponder.schema.ts` | Schema definition (changes trigger re-index) |
| `ponder/ponder.config.ts` | Config: contracts, start blocks, RPC (changes trigger re-index) |
| `deploy/ponder/nixpacks.toml` | Build configuration for Railway |
| `deploy/ponder/railway.toml` | Railway service configuration |

## 10. Local Testing Before Deploy

**Always verify Ponder starts locally before pushing to Railway.** This catches syntax errors, missing exports, and config issues before wasting a build cycle.

```bash
# From repo ROOT (not ponder/ subdirectory!)
PONDER_START_BLOCK=<recent_block> PONDER_END_BLOCK=<recent_block+10> \
  npx ponder start --root ponder --port 42070 --schema test_local_v1
```

**Critical: run from repo root, not `cd ponder/`.** The `ponder/` directory may contain stale `node_modules/` with an old `@ponder/core` version (0.6.x) that conflicts with the root-level `ponder@0.15.x`. Running `npx ponder` from `ponder/` resolves the wrong binary.

**What to check:**
- Config loads without errors (look for `Connected to database` and `Started backfill`)
- No `ESBuildTransformError` (syntax errors in index.ts)
- No `TypeError` in `executeSchema` (schema export issues)

**Kill quickly** — don't leave local Ponder running as it consumes RPC credits.

**Per-contract start blocks:** When adding new contracts (e.g., staking V2), verify the deployment block on-chain first:
```bash
# Binary search for contract deployment via eth_getCode
for BLOCK in 40000000 41000000 42000000; do
  HEX=$(printf '0x%x' $BLOCK)
  curl -s <RPC_URL> -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"<CONTRACT>\",\"$HEX\"],\"id\":1}"
done
```
Set each contract's `startBlock` to just before its deployment — don't scan millions of empty blocks.
