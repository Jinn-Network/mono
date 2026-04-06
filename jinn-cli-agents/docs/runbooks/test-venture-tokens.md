# Test Venture Tokens

Guide for testing token deployment, reward distribution, and onboarding via OpenClaw.

---

## Prerequisites

- Node.js 22+, Yarn installed
- `.env` configured with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- Base RPC access (`BASE_RPC_URL` in `.env` or default public endpoint)
- A Gnosis Safe on Base (for governance + vesting)

---

## 1. Test Token Deployment

### 1a. Mint a venture with auto-launch

This creates a venture record in Supabase AND deploys a Doppler token in one step.

```bash
yarn tsx scripts/ventures/mint.ts \
  --name "Amplify² Growth Agency" \
  --ownerAddress "0xYOUR_SAFE_ADDRESS" \
  --blueprint '{"invariants":[{"id":"GROWTH-001","form":"threshold","description":"Become the most-used x402 server in the growth sector, as evidenced by total volume of requests on x402 scan"}]}' \
  --description "Autonomous growth services for projects — content strategy, community building, and distribution." \
  --tokenSymbol "AMP2" \
  --safe-address "0xYOUR_SAFE_ADDRESS"
```

**What happens:**
1. Creates venture in Supabase
2. Detects `--tokenSymbol` + `--safe-address` → auto-calls `launchToken()`
3. Deploys Doppler multicurve with 10/10/80 allocation:
   - 10% (100M) → bonding curve (price discovery)
   - 10% (100M) → Safe (insiders, vested)
   - 80% (800M) → governance contract (treasury, Safe-controlled)
4. Updates venture record with token address, pool ID, etc.

**Deployer key resolution:**
1. `DEPLOYER_PRIVATE_KEY` env var (for manual runs)
2. Operate-profile service EOA (for agent self-launch)

### 1b. Launch token separately

If you already have a venture, launch a token for it:

```bash
yarn tsx scripts/ventures/launch-token.ts \
  --venture-id "YOUR_VENTURE_UUID" \
  --name "Amplify² Token" \
  --symbol "AMP2" \
  --safe-address "0xYOUR_SAFE_ADDRESS"
```

### 1c. Verify deployment

```bash
# Check the venture record
yarn tsx scripts/ventures/mint.ts --help

# Verify in explorer
open http://localhost:3000/ventures
```

**Expected:** Venture card shows `$AMP2` badge, links to dashboard via `root_workstream_id`.

### 1d. Verify --help output

```bash
yarn tsx scripts/ventures/launch-token.ts --help
```

**Expected:** Shows 10/10/80 allocation, deployer key fallback chain, GovernanceLaunchpad info.

---

## 2. Test Reward Distribution

### 2a. Dry run (calculation only)

```bash
yarn tsx scripts/ventures/distribute-rewards.ts \
  --venture-id "YOUR_VENTURE_UUID" \
  --amount "10000" \
  --dry-run
```

**Expected output:**
- Queries Ponder for deliveries in the venture's workstream
- Checks MechActivityChecker for each worker
- Shows proportional allocation table
- Prints `[DRY RUN] No Safe TX batch generated.`

### 2b. Generate Safe TX batch

```bash
yarn tsx scripts/ventures/distribute-rewards.ts \
  --venture-id "YOUR_VENTURE_UUID" \
  --amount "10000" \
  --output "./safe-tx-distribute.json"
```

**Expected output:**
- Same allocation calculation as dry run
- Writes `safe-tx-distribute.json` with Safe Transaction Builder format
- Shows next steps for importing into Safe app

### 2c. Verify the batch JSON

```bash
cat safe-tx-distribute.json | jq '.meta, (.transactions | length)'
```

**Expected:** Meta shows venture name, transaction count matches worker count.

### 2d. Execute via Safe (manual)

1. Open the Safe app for your venture's Safe
2. Go to **Apps → Transaction Builder**
3. Click **Upload** and select `safe-tx-distribute.json`
4. Review the batch of ERC20 `transfer()` calls
5. Execute the batch transaction

### 2e. Skip activity check

If workers haven't registered with the staking contract yet:

```bash
yarn tsx scripts/ventures/distribute-rewards.ts \
  --venture-id "YOUR_VENTURE_UUID" \
  --amount "10000" \
  --skip-activity-check \
  --dry-run
```

---

## 3. Test Onboarding via OpenClaw

### 3a. Run the onboard skill

The `/onboard` skill checks your service setup, worker status, and lets you pick a venture.

```bash
# In your Claude Code session:
/onboard
```

**Expected flow:**
1. **Service check** — looks for `.operate/services/*/config.json`
2. **Worker check** — `ps aux | grep mech_worker`
3. **Venture list** — shows active ventures with tokens and `root_workstream_id`
4. **Pick venture** — select one, updates `WORKSTREAM_FILTER` in `.env`
5. **Next steps** — instructions to start/restart worker

### 3b. OpenClaw skill installation (coming soon)

When OpenClaw skill support is available, agents will install venture skills directly:

```
/install jinn-network/amplify-growth
```

This will:
1. Install the Amplify² growth agency skill on your OpenClaw agent
2. The skill detects growth-related intents and routes them as Jinn jobs
3. Completed jobs earn `$AMP2` tokens proportional to deliveries
4. AI tokens in → crypto tokens out

### 3c. Verify worker config

After onboarding, verify your `.env`:

```bash
grep WORKSTREAM_FILTER .env
```

**Expected:** `WORKSTREAM_FILTER=0x...` matching the selected venture's `root_workstream_id`.

Then start the worker:

```bash
yarn dev:mech
```

---

## 4. Frontend Verification

### 4a. Explorer homepage

```bash
open http://localhost:3000
```

**Expected:** Only ventures with tokens appear in the Ventures card, each showing `$SYMBOL` badge.

### 4b. Ventures registry

```bash
open http://localhost:3000/ventures
```

**Expected:** Only tokenized ventures listed. Each card shows token badge, links to dashboard via `root_workstream_id`.

### 4c. Venture dashboard

Click "View Dashboard" on any venture card.

**Expected:** URL is `/ventures/<root_workstream_id>`, not `/ventures/<uuid>`.

### 4d. Website

```bash
open http://localhost:3001  # or wherever the website runs
```

**Expected:**
- Hero: "AI tokens in. Crypto tokens out."
- Featured section: "Agent Companies"
- OpenClaw section: "Give your OpenClaw its first job" with `/install` hint
- About: "The network for agent companies"

---

## Dummy Test Venture

A test venture (`test-token-venture`) is inserted in Supabase for frontend verification:
- Token: `$TEST`
- Staking: `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139`
- Has `root_workstream_id` set for link testing

Delete it after verification:

```sql
DELETE FROM ventures WHERE slug = 'test-token-venture';
```
