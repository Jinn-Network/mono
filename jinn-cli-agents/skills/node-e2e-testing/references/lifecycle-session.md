# Lifecycle Session

Tests the full service lifecycle without worker execution: setup, stake, checkpoint, rewards, unstake, withdraw. Faster and lower-quota than the default session — no Docker, no Gemini CLI, no telemetry.

**Prerequisites**: Same as default session, minus Docker and Gemini CLI.
**Abort on failure**: Steps 1-2 abort the session. Steps 3+ continue and report.

## Steps

### 1. Infrastructure

Follow [phase-0-infrastructure.md](phase-0-infrastructure.md) exactly (create VNet, start Ponder + Control API).

### 2. Clone & Setup (single service)

Follow [phase-1-setup.md](phase-1-setup.md) steps 1-4 (clone, install, configure, setup). **Skip step 5** (Docker build) — not needed for this session.

Only 1 service is needed. Do NOT proceed to add a second service.

After setup, record addresses from the output. Save to `.env.e2e`:
```bash
echo "AGENT_EOA_1=<agent-eoa-address>" >> .env.e2e
echo "SERVICE_A_SAFE=<service-safe-address>" >> .env.e2e
```

### 3. Verify stake

```bash
cd "$CLONE_DIR" && yarn service:list
cd "$CLONE_DIR" && yarn service:status
```

Expected: 1 service shown, staked on `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139`.

### 4. Wallet info + key export

```bash
cd "$CLONE_DIR" && yarn wallet:info
cd "$CLONE_DIR" && yarn wallet:export-keys
```

Expected: Master EOA, Master Safe, Service Safe, Agent EOA addresses with balances. Valid BIP-39 mnemonic.

### 5. Seed activity

The staking activity checker requires both the Safe nonce and marketplace request count to have increased since the last checkpoint. Without running a worker, seed these via the harness:

```bash
yarn test:e2e:vnet seed-activity $SERVICE_A_SAFE \
  --staking 0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139 \
  --value 1000
```

The command automatically queries the activity checker and marketplace addresses from the staking contract, computes the correct storage slots, sets both values, and verifies them.

### 6. Checkpoint & rewards

Two checkpoint cycles are run. Since nonces were seeded before the first checkpoint, cycle 1 already sees a delta (0→1000) and will award rewards if the staking contract has available OLAS. Cycle 2 confirms rewards continue after a second nonce bump.

**Cycle 1:**
```bash
yarn test:e2e:vnet time-warp 86400

yarn test:e2e:vnet checkpoint \
  --staking 0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139 \
  --key <AGENT_EOA_1_PRIVATE_KEY>
```

Expected: Service receives OLAS rewards > 0 (nonces went from 0→1000). The checkpoint command auto-funds the staking contract with OLAS if `availableRewards` is 0.

**Bump nonces for Cycle 2:**
```bash
yarn test:e2e:vnet seed-activity $SERVICE_A_SAFE \
  --staking 0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139 \
  --value 2000
```

**Cycle 2:**
```bash
yarn test:e2e:vnet time-warp 86400

yarn test:e2e:vnet checkpoint \
  --staking 0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139 \
  --key <AGENT_EOA_1_PRIVATE_KEY>
```

Expected: Service receives OLAS rewards > 0 again (nonces increased from 1000 → 2000).

**Verify:**
```bash
cd "$CLONE_DIR" && yarn rewards:summary
```

Expected: `rewards:summary` shows accrued OLAS for the service.

### 7. Recovery

Time-warp 72 hours (unstake cooldown), then recover:

```bash
yarn test:e2e:vnet time-warp 259200

# Dry run first
cd "$CLONE_DIR" && yarn wallet:recover --to <MASTER_EOA_ADDRESS> --dry-run

# Execute
cd "$CLONE_DIR" && yarn wallet:recover --to <MASTER_EOA_ADDRESS>

# Verify
cd "$CLONE_DIR" && yarn wallet:info
```

Use the Master EOA as the destination address (shown in `wallet:info` output).

Expected:
- Dry run shows service to terminate + OLAS/ETH amounts
- Recovery terminates service, withdraws from Safe to destination
- Final `wallet:info` shows reduced Safe balances, destination received funds

## On Failure

- **Setup fails**: Same as Phase 1 troubleshooting — capture error, check funding amounts.
- **Activity seeding fails**: `tenderly_setStorageAt` may return error if VNet is stale. Check `yarn test:e2e:vnet status`.
- **Checkpoint reverts**: Time-warp may not have been enough. Check `getNextRewardCheckpointTimestamp()`. Verify nonces were seeded correctly — both Safe nonce AND request count must be > 0.
- **No rewards assigned**: Activity checker requirements not met. Need `requestCounts <= safeNonce` AND rate >= `livenessRatio` (60 requests/day). If nonces are both 1000, 1 day should pass easily.
- **"Not enough time passed" on unstake**: The 72h cooldown time-warp didn't advance enough. Document the error.
- **Recovery fails with 403**: VNet quota exhausted. Document it — the dry-run (read-only) confirms the logic is correct.

## CHECKPOINT: Lifecycle Session

- [PASS|FAIL] VNet + Ponder created
- [PASS|FAIL] Service deployed and staked
- [PASS|FAIL] `service:list` / `service:status` show staked service
- [PASS|FAIL] `wallet:info` displayed correct addresses and balances
- [PASS|FAIL] `wallet:export-keys` produced valid mnemonic
- [PASS|FAIL] Activity seeded (nonces set via storage override)
- [PASS|FAIL] Checkpoint cycle 1 succeeded (rewards > 0)
- [PASS|FAIL] Checkpoint cycle 2 succeeded (rewards > 0)
- [PASS|FAIL] `rewards:summary` showed accrued OLAS
- [PASS|FAIL] `wallet:recover --dry-run` showed correct amounts
- [PASS|FAIL] `wallet:recover` executed (services terminated, funds withdrawn)
- [PASS|FAIL] Destination received OLAS + ETH

## Final Report

```
## LIFECYCLE SESSION REPORT
Branch: <branch>
VNet ID: <from .env.e2e>
Clone: <CLONE_DIR>
Date: <timestamp>

| Step | Name                  | Result |
|------|-----------------------|--------|
| 1    | Infrastructure        | PASS   |
| 2    | Clone & Setup         | PASS   |
| 3    | Verify Stake          | PASS   |
| 4    | Wallet Info + Keys    | PASS   |
| 5    | Seed Activity         | PASS   |
| 6    | Checkpoint & Rewards  | PASS   |
| 7    | Recovery              | PASS   |

Overall: N/7 PASS

### Debugging Artifacts
- Clone: $CLONE_DIR
- VNet config: .env.e2e
```
