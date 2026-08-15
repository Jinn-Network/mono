# Phase 1a Operator Runbook

Standalone guide for running the Jinn Phase 1a tokenomics stack on testnet. Covers both the **canonical** (production-like timing) and **fast-test** (rapid iteration) stacks.

## Prerequisites

- Node.js >= 20
- Foundry (`cast` for funding)
- `cd contracts && npm install`
- `cd client && npm install`
- Sepolia ETH in deployer wallet (for L1 deploys + governance txs)
- Base Sepolia ETH in deployer wallet (for L2 deploys)
- Private key set as `DEPLOYER_PRIVATE_KEY` in `contracts/.env`

## Stack Selection

All scripts respect the `PHASE1A_TIMING_PROFILE` env var:

| Profile | Epoch | Vote period | L2 liveness | L2 min stake | Artifact suffix |
|---------|-------|-------------|-------------|--------------|-----------------|
| `canonical` (default) | 7200s | 7200s | 86400s | 3 periods | (none) |
| `fast-test` | 900s | 900s | 300s | 2 periods | `-fast` |

Canonical and fast-test stacks use separate artifact files and never overwrite each other.

## Full Operator Sequence

All commands run from `contracts/`.

### Step 1: Deploy L1 tokenomics (Sepolia)

```bash
PHASE1A_TIMING_PROFILE=fast-test \
npx hardhat run scripts/deploy-phase1a.ts --network sepolia
```

**Produces:** `deployment-phase1a-sepolia-fast.json`
**Contains:** JINN token, veOLAS, Tokenomics, Treasury, Dispenser, VoteWeighting, registries

### Step 2: Create L2 token (Base Sepolia)

```bash
PHASE1A_TIMING_PROFILE=fast-test \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
npx hardhat run scripts/create-phase1a-l2-token.ts --network baseSepolia
```

**Produces:** `deployment-phase1a-token-baseSepolia-fast.json`
**Contains:** Bridge-compatible L2 JINN via OP Stack OptimismMintableERC20Factory

### Step 3: Deploy L2 staking stack (Base Sepolia)

```bash
PHASE1A_TIMING_PROFILE=fast-test \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
npx hardhat run scripts/deploy-phase1a-l2.ts --network baseSepolia
```

**Produces:** `deployment-phase1a-l2-baseSepolia-fast.json`
**Contains:** ActivityChecker, StakingFactory, StakingToken implementation, StakingToken proxy

To deploy with the **V2 anti-farming activity checker** (Phase 1b):

```bash
PHASE1A_TIMING_PROFILE=fast-test \
ACTIVITY_CHECKER_VERSION=v2 \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
npx hardhat run scripts/deploy-phase1a-l2.ts --network baseSepolia
```

Optional V2 tuning env vars:
- `SIMILARITY_THRESHOLD` — Hamming distance threshold (default: 64, range 0-256)
- `SIMILAR_DECAY_MULTIPLIER` — weight for similar evidence in wei (default: 0 = binary)
- `COMPARISON_WINDOW` — recent hashes to compare (default: 20)

### Step 4: Deploy bridge adapters (Sepolia + Base Sepolia)

```bash
PHASE1A_TIMING_PROFILE=fast-test \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
npx hardhat run scripts/deploy-phase1a-bridge.ts --network sepolia
```

**Produces:** `deployment-phase1a-bridge-sepolia-baseSepolia-fast.json`
**Contains:** DepositProcessorL1 (Sepolia), TargetDispenserL2 (Base Sepolia)

### Step 5: Governance wiring (all on Sepolia)

Run these in order. All read from the timing-profile-aware artifact files.

```bash
# Set PHASE1A_TIMING_PROFILE=fast-test for all of these

# 1. Unpause dispenser for staking incentives
npx hardhat run scripts/phase1a-unpause-dispenser.ts --network sepolia

# 2. Map Base Sepolia chain ID to the deposit processor
npx hardhat run scripts/phase1a-set-deposit-processor.ts --network sepolia

# 3. Register staking proxy as a voting nominee
npx hardhat run scripts/phase1a-add-staking-nominee.ts --network sepolia

# 4. Mint JINN and lock as veJINN for voting (if needed)
npx hardhat run scripts/phase1a-mint-jinn-for-vote.ts --network sepolia

# 5. Cast vote weight to the staking nominee
npx hardhat run scripts/phase1a-vote-staking-weight.ts --network sepolia
```

**Checkpoint:** Run `status-phase1a-live.ts` to verify all gates pass:
```bash
npx hardhat run scripts/status-phase1a-live.ts --network sepolia
```

#### Fast-test heartbeat requirement (jinn-mono-5hc)

On the `fast-test` timing profile, `VoteWeightingFast._period = 900s` and
`_maxNumPeriods = 10_000`, giving the internal `_getSum()` walker a
quiet-tolerance window of ~104 days. If no one invokes
`VoteWeighting.checkpoint()` (directly, or via any function that calls it)
for longer than that window, `timeSum` falls too far behind
`block.timestamp` for the iteration cap to catch up, and the contract
bricks permanently — there is no admin reset. Run the heartbeat at least
weekly on fast-test:

```bash
PHASE1A_TIMING_PROFILE=fast-test \
  npx hardhat run scripts/phase1a-heartbeat-vote-weighting.ts --network sepolia
```

The heartbeat is gas-trivial once caught up (the walker only iterates the
few periods that elapsed). Fold it into whatever cron already runs
`checkpoint-and-verify.ts`, or add a dedicated scheduled workflow.

#### Recovery if the gauge is already bricked

If `status-phase1a-live.ts` reports the staking nominee with zero relative
weight despite a valid on-chain vote, or `probe-timesum.ts` shows `timeSum`
more than `MAX_NUM_WEEKS` periods behind `now`, the gauge is stuck.
`VoteWeighting` is not behind a proxy and has no admin reset — recovery is
a one-contract redeploy. Only `VoteWeightingFast` moves; everything else
(JINN, Treasury, Tokenomics, Depository, Dispenser, veJINN, bridge, L2)
stays. State lost: nominee registrations and vote history inside
VoteWeighting (must re-register + re-vote post-redeploy).

```bash
# From the deployer key (owner of JINN/Dispenser/VoteWeighting):
PHASE1A_TIMING_PROFILE=fast-test \
  npx hardhat run scripts/phase1a-redeploy-vote-weighting.ts --network sepolia

# The script deploys, rewires Dispenser ↔ new VW, re-registers the nominee,
# and rewrites the fast-test artifact JSON. Next steps print on success.
```

### Step 6: Seed L2 with JINN

```bash
# Bridge JINN from Sepolia to Base Sepolia
npx hardhat run scripts/phase1a-bridge-jinn-to-l2.ts --network sepolia

# Seed the staking proxy with reward liquidity
PHASE1A_TIMING_PROFILE=fast-test \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
npx hardhat run scripts/phase1a-deposit-staking-rewards.ts --network baseSepolia
```

### Step 7: Bootstrap the client service

```bash
cd client
JINN_NETWORK=testnet \
JINN_EARNING_DIR=/tmp/jinn-phase1a-fast/earning \
JINN_TESTNET_L2_DEPLOYMENT=../contracts/deployment-phase1a-l2-baseSepolia-fast.json \
JINN_TESTNET_TOKEN_DEPLOYMENT=../contracts/deployment-phase1a-token-baseSepolia-fast.json \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
JINN_PASSWORD=<keystore-password> \
npx jinn run
```

Bootstrap will pause at `awaiting_funding` — fund the Safe with ETH and JINN, then re-run.

The testnet bootstrap stops at `service_staked` (mech deployment is skipped).

### Step 8: Record activity

```bash
cd contracts

# V1 checker (simple counter)
PHASE1A_TIMING_PROFILE=fast-test \
PHASE1A_MULTISIG=<safe-address> \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
npx hardhat run scripts/phase1a-record-activity.ts --network baseSepolia

# V2 checker (with evidence hash)
PHASE1A_TIMING_PROFILE=fast-test \
PHASE1A_MULTISIG=<safe-address> \
EVIDENCE_MODE=novel \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
npx hardhat run scripts/phase1b-record-activity-with-evidence.ts --network baseSepolia
```

Evidence modes for V2:
- `novel` — generates unique evidence hashes per activity (proves novel work earns rewards)
- `duplicate` — uses identical hashes (proves farming is penalized)
- `custom` — uses `EVIDENCE_HASH` env var

### Step 9: Claim rewards

Wait for the vote boundary to pass (15 min for fast-test, ~2 hours for canonical).

```bash
# Claim L1 staking incentives
PHASE1A_TIMING_PROFILE=fast-test \
npx hardhat run scripts/phase1a-claim-staking-incentives.ts --network sepolia

# Wait for bridge delivery (~2 min on testnet)

# Claim L2 rewards via Safe
PHASE1A_TIMING_PROFILE=fast-test \
PHASE1A_SERVICE_ID=<service-id> \
PHASE1A_EARNING_DIR=/tmp/jinn-phase1a-fast/earning \
JINN_PASSWORD=<keystore-password> \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
npx hardhat run scripts/phase1a-claim-l2-rewards.ts --network baseSepolia
```

## Phase 1b: MechMarketplace + Full Daemon

After the Phase 1a stack is deployed, deploy the MechMarketplace to enable the full client daemon on testnet.

### Deploy mech marketplace stack

```bash
cd contracts
PHASE1A_TIMING_PROFILE=fast-test \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
npx hardhat run scripts/deploy-phase1b-mech.ts --network baseSepolia
```

**Produces:** `deployment-phase1b-mech-baseSepolia-fast.json`
**Contains:** Karma, MechMarketplace (proxy), MechFactory, BalanceTracker, JinnRouter

### Start the full client daemon

```bash
cd client
JINN_NETWORK=testnet \
JINN_EARNING_DIR=/tmp/jinn-phase1b/earning \
JINN_TESTNET_L2_DEPLOYMENT=../contracts/deployment-phase1a-l2-baseSepolia-fast.json \
JINN_TESTNET_TOKEN_DEPLOYMENT=../contracts/deployment-phase1a-token-baseSepolia-fast.json \
JINN_TESTNET_MECH_DEPLOYMENT=../contracts/deployment-phase1b-mech-baseSepolia-fast.json \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
JINN_PASSWORD=<keystore-password> \
npx jinn run
```

The client will:
1. Bootstrap through all 11 steps (including mech deployment via the factory)
2. Start the daemon's long-running loops (which ones depends on vertical mode and config — see [`client/ARCHITECTURE.md`](../client/ARCHITECTURE.md) §6)
3. Post desired states through the JinnRouter
4. Watch for requests, run Claude for restoration, deliver results
5. Claim deliveries, create evaluation jobs
6. Activity is tracked by the JinnRouter and feeds into staking rewards

When healthy, daemon progress is visible through:
- `jinn status --human` (rollup health + fleet summary)
- `jinn logs --follow --human` (live lifecycle stream with timestamps)
- Dashboard at `http://127.0.0.1:7331/` (in-flight Tasks, verdicts, earnings, fleet, and next actions)

### New env var

| Env var | Purpose |
|---------|---------|
| `JINN_TESTNET_MECH_DEPLOYMENT` | Path to mech marketplace deployment artifact |

## Artifact Files

| Stack | L1 | L2 Token | L2 Staking | Bridge | Mech (Phase 1b) |
|-------|----|----|----|----|-----|
| Canonical | `deployment-phase1a-sepolia.json` | `deployment-phase1a-token-baseSepolia.json` | `deployment-phase1a-l2-baseSepolia.json` | `deployment-phase1a-bridge-sepolia-baseSepolia.json` | `deployment-phase1b-mech-baseSepolia.json` |
| Fast-test | `deployment-phase1a-sepolia-fast.json` | `deployment-phase1a-token-baseSepolia-fast.json` | `deployment-phase1a-l2-baseSepolia-fast.json` | `deployment-phase1a-bridge-sepolia-baseSepolia-fast.json` | `deployment-phase1b-mech-baseSepolia-fast.json` |

## Troubleshooting

**Bootstrap stuck at `awaiting_funding`**
- Fund the Safe address with ETH (for gas) and stOLAS on Base Sepolia (2x bond amount for activation + registration). stOLAS is the liquid-staked OLAS variant wrapped by the Phase 1b distributor; OLAS itself is never sent to the Safe.
- Use `cast send` from a funded account

**RPC write failures on Base Sepolia**
- Use `https://sepolia.base.org` for writes, not Tenderly or other providers
- Set `BASE_SEPOLIA_RPC_URL=https://sepolia.base.org` explicitly

**Vote weight shows zero after voting**
- Wait for the vote activation period to pass (900s for fast-test)
- Run `status-phase1a-live.ts` to check the current weight

**L2 claim fails with "not enough staking time"**
- The minimum staking duration must elapse before claims
- Fast-test: 2 periods × 300s = 600s minimum
- Canonical: 3 periods × 86400s = 259200s (72 hours)

**Nonce desync during consecutive deploys**
- The deploy scripts pin nonces explicitly to avoid this
- If it happens, wait a few seconds and retry

## Known Operational Gotchas (Phase 1b)

**JINN must be pre-positioned**
- The operator must mint JINN on L1 (Sepolia), bridge to L2 (Base Sepolia, takes 5-10 min), send to the predicted Safe, and deposit into the staking proxy. There's no single automated script for this flow.

**proxyHash must match the Safe bytecode**
- The staking proxy's `proxyHash` must match the codehash of the deployed Safe proxy. The default in the deploy script is the correct hash for Base Sepolia's Safe proxy factory (`0xb89c1b3b...`). If deploying on a different chain, compute it with `cast keccak $(cast code <deployed-safe-address>)` and pass via `SAFE_PROXY_HASH`.

**Multiple deployment artifacts**
- The client needs three artifact paths: `JINN_TESTNET_L2_DEPLOYMENT`, `JINN_TESTNET_TOKEN_DEPLOYMENT`, and `JINN_TESTNET_MECH_DEPLOYMENT`. All paths are relative to the working directory. Recommend setting them in the client `.env` file.

**Bridge timing**
- The OP Stack bridge from Sepolia to Base Sepolia takes 5-15 minutes. The `phase1a-bridge-jinn-to-l2.ts` script submits the tx but doesn't wait for relay. Check L2 balance with `cast call <L2_JINN> "balanceOf(address)" <address>` before proceeding.
