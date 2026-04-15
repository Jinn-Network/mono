---
name: deploy-staking
description: Deploy a new Jinn OLAS staking contract on Base with a custom activity checker, register the agent on Ethereum mainnet, and nominate for veOLAS emissions. Use when deploying a new staking contract, changing agent IDs, updating activity checker logic, or setting up staking infrastructure from scratch.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
user-invocable: true
---

# Deploy Jinn Staking Contract

End-to-end guide for deploying a new OLAS staking contract on Base with a custom activity checker, registering the agent on Ethereum, and nominating for emissions.

## When to Use This Skill

- Deploying a new staking contract (new agent ID, updated params, new activity checker)
- The existing staking contract's `agentIds` are immutable and locked to the wrong ID
- Changing activity checker logic (e.g., from request-counting to delivery-counting)
- Setting up staking infrastructure for a new Jinn agent from scratch

## Prerequisites

- `OPERATE_PASSWORD` set in `.env` or `jinn-node/.env`
- `OPERATE_PROFILE_DIR` pointing to `.operate/` directory (default: `olas-operate-middleware/.operate/`)
- Master EOA funded with ETH on both Ethereum mainnet (~0.005 ETH) and Base (~0.02 ETH)
- Contracts compiled: `cd contracts && yarn compile`
- Activity checker contract exists in `contracts/staking/`

## Quick Reference: Current Deployment

| Asset | Chain | Address |
|-------|-------|---------|
| Agent 103 (jinn-node) | Ethereum | Registry ID 103, TX `0x4a3d8d35...` |
| DeliveryActivityChecker | Base | `0xe575393b921C98288a842217AFBeDBA8197496D5` |
| Staking Contract v2 | Base | `0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488` |
| Staking Contract v1 (old, agent 43) | Base | `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139` |
| Nomination | Ethereum | VoteWeighting, block 24527565 |

### Key Wallet Addresses

| Wallet | Address | Role |
|--------|---------|------|
| Master EOA | `0x5a5043c364E82f11Dc56f5A778d3031FEA16aF49` | Signs all transactions (pays gas) |
| Master Safe (Base) | `0xC440e601e22429C8f93a65548A746F015DDa26d2` | Owns services on Base |
| Venture Safe | `0x900Db2954a6c14C011dBeBE474e3397e58AE5421` | Owns agents on Ethereum |

---

## Full Deployment Pipeline

### Step 1: Compile the Activity Checker

```bash
cd contracts && yarn compile
```

Verify artifact exists at:
`contracts/staking/artifacts/staking/DeliveryActivityChecker.sol/DeliveryActivityChecker.json`

### Step 2: Register Agent on Ethereum (if new agent needed)

```bash
OPERATE_PASSWORD=<password> \
OPERATE_PROFILE_DIR=olas-operate-middleware/.operate \
npx tsx scripts/register-jinn-node-agent.ts [--dry-run]
```

**What it does:**
1. Uploads service package (`packages/jinn/services/jinn_node/`) to IPFS with `wrap-with-directory=true`
2. Builds metadata JSON with `code_uri` pointing to the service package CID
3. Uploads metadata to IPFS
4. Converts CID to bytes32 via `cidToBytes32()` (strips 2-byte multihash prefix from base58 CIDv0)
5. Calls `RegistriesManager.create(1, venturesSafe, hash, [315])` on Ethereum mainnet
6. Parses agent ID from ERC721 Transfer event

**Output:** New agent ID (e.g., 103)

**Cost:** ~205k gas on Ethereum mainnet

### Step 3: Deploy Activity Checker + Staking Contract on Base

```bash
OPERATE_PASSWORD=<password> \
OPERATE_PROFILE_DIR=olas-operate-middleware/.operate \
npx tsx scripts/deploy-jin-staking.ts --agent-id=103 [--dry-run]
```

**What it does:**
1. Uploads staking metadata to IPFS (name, description)
2. Deploys DeliveryActivityChecker with `(mechMarketplace, livenessRatio)` constructor args
3. Calls `StakingFactory.createStakingInstance(stakingTokenImpl, initPayload)` on Base

**Output:** Activity checker address + staking contract address, saved to `contracts/staking/deployment.json`

**Cost:** ~414k gas (checker) + ~663k gas (staking instance) on Base

### Step 4: Nominate on Ethereum Mainnet

```bash
OPERATE_PASSWORD=<password> \
OPERATE_PROFILE_DIR=olas-operate-middleware/.operate \
npx tsx scripts/nominate-staking-mainnet.ts [--dry-run]
```

Reads staking address from `contracts/staking/deployment.json`. Calls `VoteWeighting.addNomineeEVM(stakingAddress, 8453)`.

**Cost:** ~100k gas on Ethereum mainnet

### Step 5: Update Config Files

After deployment, update these files with real addresses:

| File | What to Update |
|------|---------------|
| `jinn-node/src/worker/config/ServiceConfig.ts` | `DEFAULT_STAKING_PROGRAM_ID`, `DEFAULT_AGENT_ID`, `DEFAULT_SERVICE_HASH` |
| `jinn-node/.env.example` | `STAKING_CONTRACT`, `WORKER_STAKING_CONTRACT` |
| `jinn-node/scripts/staking/migrate-staking-contract.ts` | Add new entry to `STAKING_CONTRACTS` map |
| `ponder/ponder.config.ts` | Add new address to `StakingContracts.address[]` |
| `ponder/src/index.ts` | Add new address to `JINN_STAKING_CONTRACTS[]` |
| `skills/olas-registry/SKILL.md` | Add agent entry to "Current Registry Entries" |
| `skills/olas-staking/SKILL.md` | Update contract addresses + see "New Staking Contract Checklist" |

### Step 6: Fund + Vote

1. **Fund staking contract** -- Send OLAS tokens to the staking contract address on Base for rewards
2. **Allocate veOLAS votes** -- Go to https://govern.olas.network/ and vote for the contract

---

## Staking Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `maxNumServices` | 100 | Increased from 10 to support growth |
| `rewardsPerSecond` | 475646879756468 | ~300% APY with 5000 OLAS stake |
| `minStakingDeposit` | 5000 OLAS | Per service |
| `minNumStakingPeriods` | 3 | Before unstaking allowed |
| `maxNumInactivityPeriods` | 2 | Before eviction |
| `livenessPeriod` | 86400s (1 day) | |
| `timeForEmissions` | 2592000s (30 days) | Verifier limit |
| `numAgentInstances` | 1 | Per service |
| `threshold` | 0 | Any multisig threshold accepted |
| `livenessRatio` | 694444444444444 | 60 deliveries/day requirement |
| `proxyHash` | `0xb89c1b3b...b000` | Gnosis Safe proxy verification |

---

## Activity Checker Design

The `DeliveryActivityChecker` is a simplified, permissionless contract:

- **No owner, no whitelist** -- anyone who meets the liveness ratio passes
- **Reads `mapDeliveryCounts`** from MechMarketplace (not `mapRequestCounts`)
- **Two immutable values:** `mechMarketplace` address and `livenessRatio`
- **Two functions:** `getMultisigNonces(address)` and `isRatioPass(uint256[], uint256[], uint256)`
- **Liveness formula:** `(deliveryCountDiff * 1e18) / timeDiff >= livenessRatio`
- **Sanity bound:** `deliveryCountDiff <= nonceDiff` (deliveries can't exceed total txs)

Key insight: `mapDeliveryCounts` is keyed by **multisig (service safe) address**, not by mech contract address.

### Testing the Activity Checker

```bash
# Enable Base mainnet forking in hardhat.config.ts (set enabled: true)
cd contracts && npx hardhat test --network hardhat
# Remember to set enabled: false after testing
```

Test suite at `contracts/test/DeliveryActivityChecker.test.ts` covers:
- Constructor validation (zero address, zero ratio reverts)
- `getMultisigNonces` against real Base mainnet multisigs
- `isRatioPass` logic (pass/fail thresholds, edge cases)

---

## Tenderly Simulation (Optional Pre-flight)

Use `scripts/simulate-staking-deployment.ts` to simulate the full deployment on a Tenderly Virtual TestNet before committing real funds.

```bash
OPERATE_PASSWORD=<password> \
OPERATE_PROFILE_DIR=olas-operate-middleware/.operate \
npx tsx scripts/simulate-staking-deployment.ts
```

Requires `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT_SLUG`, `TENDERLY_PROJECT_SLUG` in `.env.test`.

Uses Tenderly Virtual TestNets API (forks are deprecated). Creates a Base mainnet fork, deploys both contracts sequentially, verifies all state, then cleans up.

---

## Key Gotchas

### 1. metadataHash must be non-zero
The StakingVerifier rejects `bytes32(0)` with `ZeroValue()` (selector `0x7c946ed7`). The deploy script uploads real metadata to IPFS. Only affects simulations using dummy hashes.

### 2. RegistriesManager.create() unitType is uint8, not uint256
The `unitType` parameter is an enum encoded as `uint8`. Using `uint256` in the ABI produces a different function selector and causes an immediate revert. The correct ABI fragment:
```
function create(uint8 unitType, address unitOwner, bytes32 unitHash, uint256[] dependencies)
```

### 3. Python eth_account.decrypt() returns HexBytes
`HexBytes.hex()` already includes `0x` prefix. Writing `'0x' + private_key.hex()` produces `0x0x...`. Fix:
```python
h = private_key.hex()
print(h if h.startswith('0x') else '0x' + h)
```

### 4. Staking contracts are permanently immutable
`agentIds`, `maxNumServices`, activity checker address, and all staking params are set once at initialization. Cannot be changed. Need a new contract for any param change.

### 5. Activity checker whitelist was dead code
The `WhitelistedRequesterActivityChecker` has whitelist functions but `isRatioPass()` never checks them. The OLAS staking contract only calls `getMultisigNonces()` and `isRatioPass()`. The `DeliveryActivityChecker` drops the whitelist entirely.

### 6. Contracts are ownerless after deployment
Neither the activity checker nor the staking contract proxy have an owner/admin. The Master EOA is just the deployer (pays gas). No ongoing privileges.

### 7. dotenv loading order matters
Scripts in `scripts/` need to load from multiple .env files:
```typescript
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env.test') }); // Tenderly creds
dotenv.config({ path: path.resolve(__dirname, '../jinn-node/.env') }); // OPERATE_PASSWORD
```

### 8. OPERATE_PROFILE_DIR must be absolute when running from monorepo root
`getMasterPrivateKey()` resolves paths relative to `jinn-node/`. Set:
```
OPERATE_PROFILE_DIR=/absolute/path/to/olas-operate-middleware/.operate
```

---

## Contract Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| StakingFactory | `0x1cEe30D08943EB58EFF84DD1AB44a6ee6FEff63a` |
| StakingToken (implementation) | `0xEB5638eefE289691EcE01943f768EDBF96258a80` |
| StakingVerifier | `0x10c5525F77F13b28f42c5626240c001c2D57CAd4` |
| ServiceRegistryL2 | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` |
| ServiceRegistryTokenUtility | `0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5` |
| MechMarketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` |

## Contract Addresses (Ethereum Mainnet)

| Contract | Address |
|----------|---------|
| VoteWeighting | `0x95418b46d5566D3d1ea62C12Aea91227E566c5c1` |
| RegistriesManager | `0x9eC9156dEF5C613B2a7D4c46C383F9B58DfcD6fE` |
| AgentRegistry | `0x2F1f7D38e4772884b88f3eCd8B6b9faCdC319112` |

---

## Files

| File | Purpose |
|------|---------|
| `contracts/staking/DeliveryActivityChecker.sol` | Permissionless activity checker (delivery-based) |
| `contracts/test/DeliveryActivityChecker.test.ts` | Hardhat test suite (11 tests, Base mainnet fork) |
| `scripts/deploy-jin-staking.ts` | Deploy activity checker + create staking instance |
| `scripts/register-jinn-node-agent.ts` | Register agent on Ethereum + upload to IPFS |
| `scripts/nominate-staking-mainnet.ts` | Nominate staking contract for veOLAS emissions |
| `scripts/simulate-staking-deployment.ts` | Tenderly Virtual TestNet simulation |
| `scripts/simulate-registration.ts` | Tenderly simulation of agent registration |
| `contracts/staking/deployment.json` | Auto-saved deployment addresses and params |
| `jinn-node/src/worker/config/ServiceConfig.ts` | Default staking/agent config for operators |
| `packages/jinn/services/jinn_node/` | AEA service package (uploaded to IPFS) |

---

## Operator Migration (Existing Services)

Existing operators with services minted under agent ID 43 **cannot restake** in the new contract (agent ID mismatch). They must re-mint:

```bash
git pull                  # Get updated ServiceConfig.ts
yarn wallet:recover       # Unstake + withdraw all funds
yarn setup                # Fresh setup with new agent_id + staking contract
```

New operators get the correct defaults automatically via `yarn setup`.
