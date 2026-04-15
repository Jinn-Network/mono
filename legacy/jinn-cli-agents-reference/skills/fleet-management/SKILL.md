---
name: fleet-management
description: Manage a fleet of OLAS staked services — provision new services, deploy to Railway, monitor health, and troubleshoot operational issues. Use when scaling up services, checking fleet health, or troubleshooting evictions and gas issues.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
user-invocable: true
---

# Fleet Management

> Manage a fleet of OLAS staked services: provision, deploy, monitor, troubleshoot.

## When to Use

- Setting up multiple new services for staking
- Monitoring fleet health (activity, gas, eviction risk)
- Deploying fleet credentials to Railway
- Troubleshooting underperforming services

---

## 1. Capacity Planning

### OLAS Budget
- Each service costs **10,000 OLAS** (5k security deposit + 5k agent bond)
- All OLAS is returned when the service is terminated and unbonded
- Budget formula: `available_olas / 10,000 = max_new_services`

### Worker Throughput
- Each service needs **~61 deliveries/day** (liveness ratio: 694,444,444,444,444 / 1e18 × 86,400 + 1)
- Average job execution: ~4 minutes
- One worker handles ~360 jobs/day
- **WORKER_COUNT=2** → ~720 jobs/day → supports ~11 services
- **WORKER_COUNT=3** → ~1,080 jobs/day → supports ~17 services

### ETH Gas Budget
- Per service Safe: ~0.005 ETH (funded by middleware from Master Safe)
- Per agent EOA: ~0.002 ETH for gas
- Total per service creation: ~0.01 ETH

---

## 2. Service Provisioning

### Pre-Flight: Check Balances FIRST

**CRITICAL:** Always verify balances _before_ running `service:add`. The middleware will fail mid-provisioning if funds are insufficient, leaving a partially-created config that needs cleanup.

**Two things to check:**
1. **Master Safe OLAS balance** — each service requires 10,000 OLAS (5k deposit + 5k bond)
2. **Master EOA ETH balance** — needs ~0.01 ETH for on-chain transactions (create, activate, register, deploy, stake)

```bash
# Quick fleet-wide balance check (no middleware daemon needed):
tsx scripts/fleet-balances.ts

# Or use the preflight skill for a full check:
# /olas-service-preflight

# Or check manually with cast:
cast call 0x54330d28ca3357F294334BDC454a032e7f353416 \
  "balanceOf(address)(uint256)" <MASTER_SAFE_ADDRESS> \
  --rpc-url "$RPC_URL" | cast from-wei
cast balance <MASTER_EOA_ADDRESS> --rpc-url "$RPC_URL" -e
```

**Budget check:** `available_olas / 10,000 = max_new_services`. Master EOA needs ≥0.01 ETH per service. If insufficient, fund before proceeding.

### Add One Service
```bash
# Interactive (attended mode, shows funding requirements)
yarn service:add --staking-contract=0x66A9...

# Unattended (automated, proceeds without prompts)
yarn service:add --unattended --staking-contract=0x66A9...

# Dry run — creates config but doesn't deploy
yarn service:add --dry-run
```

### Add Multiple Services (Batch)
```bash
# Add 7 services unattended
yarn service:add --count=7 --unattended

# Dry run first to check balances
yarn service:add --count=7 --dry-run
```

Each service goes through: create config → activate registration (5k OLAS) → register agent (5k OLAS) → deploy Safe → stake → whitelist mech. The middleware handles Safe funding automatically from the Master Safe.

### Post-Provisioning
```bash
# Verify new services appear
yarn service:list

# Check staking + activity status
yarn service:status
```

---

## 3. Railway Deployment

### How It Works (Volume-Based — NOT Environment Variables)

**CRITICAL:** Service configs and keys are stored on a **persistent Railway volume** at `/home/jinn/.operate/`, NOT as environment variables. The worker discovers services by scanning `.operate/services/sc-*/` on the volume at startup.

**DO NOT** set `OPERATE_SERVICE_sc_*_CONFIG` or `OPERATE_SERVICE_sc_*_KEYS` environment variables on Railway. This is wrong and will lead to stale/orphaned env vars. The correct method is the SSH-based volume import described below.

### Deploy Flow

The deploy script (`scripts/deploy-railway.sh`):
1. Tars the local `.operate/` directory (excluding `services/*/deployment` venvs)
2. Base64-encodes and sends via `railway ssh` to the persistent volume
3. Extracts to `/home/jinn/.operate/` on the Railway volume
4. The `ServiceConfigReader` scans `sc-*/config.json` on startup to discover all services

```bash
# After provisioning new services — re-import .operate to volume
yarn deploy:railway -- --project <project-name>

# Code-only redeploy (credentials already on volume, unchanged)
yarn deploy:railway -- --project <project-name> --skip-import
```

**Prerequisite:** The deploy script expects `.operate` inside `jinn-node/`. A symlink must exist:
```bash
# This should already be set up, but verify:
ls -la jinn-node/.operate
# Should show: jinn-node/.operate -> ../olas-operate-middleware/.operate
```

### Worker Configuration (Multi-Service)
```bash
# Key env vars for multi-service Railway deployment
WORKER_MULTI_SERVICE=true          # Enable ServiceRotator
WORKER_COUNT=3                     # Parallel workers (see capacity above)
WORKER_ACTIVITY_POLL_MS=60000      # Activity poll interval
WORKER_ACTIVITY_CACHE_TTL_MS=60000 # Cache TTL
```

After changing `WORKER_COUNT`, trigger a Railway redeploy.

### Backup Before Deploy
Always create a backup before deploying:
```bash
yarn wallet:backup
# Creates jinn-backup-<timestamp>.tar.gz with entire .operate directory
```

---

## 4. Fleet Monitoring

### Fleet Health Dashboard
```bash
# Human-readable dashboard
yarn service:status

# JSON output (for automation/alerting)
yarn service:fleet    # alias for service:status --json

# Single-service detail
yarn service:status --service sc-000165
```

Shows:
- Epoch progress and time remaining
- Staking slot usage and APY
- Aggregate activity (eligible vs needs-work vs evicted)
- Per-service: deliveries, status, Safe ETH, Agent ETH, rewards
- Alerts: low gas (<0.002 ETH), approaching eviction, dispatch issues

### Rewards Tracker
```bash
yarn rewards:summary
```

Shows total accrued OLAS rewards, per-service breakdown, APY, and eviction risk.

### Fleet Balance Overview
```bash
# ETH + OLAS balances for Master EOA, Master Safe, all Service Safes + Agent EOAs
# Dynamically discovers addresses from .operate via ServiceConfigReader
tsx scripts/fleet-balances.ts

# Alerts on: low gas Safes (<0.002 ETH), stranded OLAS on Agent EOAs
```

### Wallet Overview
```bash
yarn wallet:info   # Master EOA + Safe addresses and balances (requires middleware daemon)
```

### Healthcheck Endpoint
The `/health` endpoint (port 8080) includes fleet state when multi-service is enabled:
```json
{
  "status": "ok",
  "fleet": {
    "currentServiceConfigId": "sc-000165",
    "totalServices": 9,
    "stakedServices": 9,
    "rotationCount": 42,
    "lastPollAt": 1708940400
  }
}
```

---

## 5. Operational Checklist

### Daily Checks
- [ ] `tsx scripts/fleet-balances.ts` — all Safes funded? No stranded OLAS?
- [ ] `yarn service:status` — all services eligible?
- [ ] Any eviction warnings? (inactivity count > 0)
- [ ] Any low-gas alerts? (Safe ETH < 0.002)
- [ ] Deliveries on track for current epoch?

### Per-Epoch Checks
- [ ] All services hit 61+ deliveries before epoch end?
- [ ] No services evicted?
- [ ] Rewards accruing correctly? (`yarn rewards:summary`)

### After Provisioning New Services
- [ ] New services appear in `yarn service:list`
- [ ] All mechs whitelisted (`tsx scripts/activity-checker-whitelist.ts list`)
- [ ] Verify each new service has `keys.json` in its service directory
- [ ] Run `yarn wallet:backup` to create a fresh backup
- [ ] Re-deploy to Railway via volume import: `yarn deploy:railway -- --project <name>`
- [ ] **DO NOT** set OPERATE_SERVICE_* env vars — the volume import handles everything
- [ ] Update `WORKER_COUNT` if needed and trigger redeploy
- [ ] First deliveries recorded within 1-2 hours

---

## 6. RPC Configuration

### Jinn RPC Proxy (Recommended)

Use `rpc.jinn.network` with Bearer token authentication:

```bash
RPC_URL=https://rpc.jinn.network
RPC_PROXY_TOKEN=<40-char-hex-token>
```

All ethers.js provider creation routes through `createRpcProvider()` in `src/config/index.ts`, which attaches the `Authorization: Bearer <token>` header when `RPC_PROXY_TOKEN` is set. This applies to:
- All `src/worker/` modules (heartbeat, checkpoint, restake, funding, etc.)
- All `scripts/` (service:status, wallet:info, etc.)
- Safe SDK initialization in `FundDistributor.ts`

**Quick connectivity test:**
```bash
RPC_URL=https://rpc.jinn.network RPC_PROXY_TOKEN=<token> yarn service:status
```

**If you get 401 Unauthorized:** Verify `RPC_PROXY_TOKEN` is exactly 40 hex characters. The proxy also accepts `?token=<token>` query param but the ethers.js helper uses the Authorization header.

---

## 7. Troubleshooting

### Service Not Making Deliveries
1. Check mech is whitelisted: `tsx scripts/activity-checker-whitelist.ts check <mech>`
2. Check Safe has ETH for gas: `yarn service:status`
3. Check worker logs for claims/skips from this mech
4. Confirm staking state = 1 (Staked) via `yarn service:status`

### Service Evicted
1. Run `yarn service:status` to confirm eviction
2. Restake: `/olas-staking` skill → Section 1 (Restaking)
3. Or: `tsx scripts/migrate-staking-contract.ts --service-id=<id> --source=jinn --target=jinn`

### Low Safe ETH Alert
```bash
# Check current balances
yarn service:status

# Withdraw ETH from Master Safe to Service Safe
yarn wallet:withdraw --to <safe-address> --asset ETH --chain base
```

### Emergency Recovery
```bash
# Unstake a service
yarn wallet:unstake --service-id <id>

# Full recovery — unstake all + sweep funds to external address
yarn wallet:recover --to <address> --dry-run
yarn wallet:recover --to <address>
```

---

## 8. Key Scripts Reference

| Command | Script | Purpose |
|---------|--------|---------|
| `yarn service:add` | `scripts/service/add.ts` | Add 1 or N services (`--count=N`) |
| `yarn service:list` | `scripts/service/list.ts` | List all services |
| `yarn service:status` | `scripts/service/status.ts` | Dashboard + alerts (`--json` for machine output) |
| `yarn service:fleet` | `scripts/service/status.ts --json` | JSON fleet overview alias |
| `yarn rewards:summary` | `scripts/service/rewards.ts` | Rewards tracker |
| `tsx scripts/fleet-balances.ts` | `scripts/fleet-balances.ts` | Fleet-wide ETH + OLAS balances |
| `yarn wallet:info` | `scripts/wallet/info.ts` | Wallet addresses + balances |
| `yarn wallet:backup` | `scripts/wallet/backup.ts` | Encrypted .operate backup |
| `yarn wallet:recover` | `scripts/wallet/recover.ts` | Emergency fund recovery |
| `yarn wallet:withdraw` | `scripts/wallet/withdraw.ts` | Withdraw ETH/OLAS |
| `yarn wallet:unstake` | `scripts/wallet/unstake.ts` | Unstake a service |
| `yarn deploy:railway` | `scripts/deploy-railway.sh` | Deploy/update Railway worker |
| `tsx scripts/activity-checker-whitelist.ts` | — | Mech whitelist management |
| `tsx scripts/migrate-staking-contract.ts` | — | Restake / migrate contracts |

## 9. Key Contracts

| Contract | Address (Base) |
|----------|---------------|
| ServiceManagerToken | `0x1262136cac6a06A782DC94eb3a3dF0b4d09FF6A6` |
| ServiceRegistryL2 | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` |
| Jinn Staking v2 | `0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488` |
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` |
| Activity Checker | Derived from `stakingContract.activityChecker()` |
