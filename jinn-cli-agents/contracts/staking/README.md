# JIN OLAS Staking Contracts

Custom staking contracts for JIN on Base network with whitelisted activity checker.

## Overview

This directory contains:
- `WhitelistedRequesterActivityChecker.sol` - Custom activity checker that only allows whitelisted addresses to earn rewards
- `interfaces/IWhitelistManager.sol` - Interface for whitelist management

## Contract Addresses (Base Mainnet - Chain ID 8453)

### OLAS Infrastructure (Existing)

| Contract | Address |
|----------|---------|
| StakingFactory | `0x1cEe30D08943EB58EFF84DD1AB44a6ee6FEff63a` |
| StakingToken (Implementation) | `0xEB5638eefE289691EcE01943f768EDBF96258a80` |
| StakingVerifier | `0x10c5525F77F13b28f42c5626240c001c2D57CAd4` |
| ServiceRegistryL2 | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` |
| ServiceRegistryTokenUtility | `0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5` |
| MechMarketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` |
| RequesterActivityChecker (Reference) | `0x87C9922A099467E5A80367553e7003349FE50106` |
| AgentsFun1 Staking (Reference) | `0x2585e63df7BD9De8e058884D496658a030b5c6ce` |

### Ethereum Mainnet (for Nomination)

| Contract | Address |
|----------|---------|
| VoteWeighting | `0x54C17BA89e3F5E3d46f24B12C4C0c5F8E09D8419` (verify in OLAS docs) |
| veOLAS | `0x7e01A500805f8A52Fad229b3015AD130A332B7b3` |

### JIN Custom Contracts (To Deploy)

| Contract | Address |
|----------|---------|
| WhitelistedRequesterActivityChecker | TBD (after deployment) |
| JIN Staking Proxy | TBD (created via StakingFactory) |

## Whitelisted MEC Addresses

These Service Safe addresses are authorized to earn rewards through the activity checker.
Set via environment variables during deployment:

- `WHITELIST_ADDRESS_1`: Your MEC address
- `WHITELIST_ADDRESS_2`: Colleague's MEC address (optional)

## Quick Start

### 1. Install Dependencies

```bash
cd contracts
yarn install
```

### 2. Compile Contracts

```bash
yarn compile
```

### 3. Configure Environment

Create a `.env` file in the project root:

```bash
# Deployment
DEPLOYER_PRIVATE_KEY=0x...your_private_key...
BASE_RPC_URL=https://mainnet.base.org

# Whitelist addresses (Service Safes that can earn rewards)
WHITELIST_ADDRESS_1=0x...your_mec_address...
WHITELIST_ADDRESS_2=0x...colleague_mec_address...

# Activity checker owner (can add/remove whitelist addresses)
ACTIVITY_CHECKER_OWNER=0x...owner_address...

# For mainnet nomination
ETHEREUM_RPC_URL=https://eth.llamarpc.com
NOMINATOR_PRIVATE_KEY=0x...nominator_key...
```

### 4. Deploy (Dry Run First)

```bash
# Dry run to verify configuration
yarn tsx scripts/deploy-jin-staking.ts --dry-run

# Actual deployment
yarn tsx scripts/deploy-jin-staking.ts
```

### 5. Nominate on Ethereum Mainnet

```bash
# After deployment, nominate for veOLAS voting
yarn tsx scripts/nominate-staking-mainnet.ts --dry-run
yarn tsx scripts/nominate-staking-mainnet.ts
```

## Deployment Steps (Detailed)

### Step 1: Deploy WhitelistedRequesterActivityChecker

The activity checker is deployed with:
- `mechMarketplace`: `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020`
- `livenessRatio`: `11574074074074` (~1 request/day requirement)
- `initialWhitelist1`: Your MEC address
- `initialWhitelist2`: Colleague's MEC address (or zero address)
- `owner`: Address that can manage whitelist

### Step 2: Create Staking Instance via StakingFactory

Calls `StakingFactory.createStakingInstance()` with:
- Implementation: `0xEB5638eefE289691EcE01943f768EDBF96258a80` (StakingToken)
- Initialization payload encoding StakingParams + activity checker address

### Step 3: Nominate on Ethereum Mainnet

Calls `VoteWeighting.addNominee()` with:
- Staking contract address (from step 2)
- Chain ID: 8453 (Base)

### Step 4: Allocate veOLAS Votes

Use [OLAS Govern](https://govern.olas.network/) to allocate veOLAS votes to the staking contract.

## Activity Checker Features

### Whitelist Management

**Immutable Whitelist (Gas Efficient)**
- `initialWhitelist1` and `initialWhitelist2` are set at deployment
- Cannot be removed (immutable)
- Checked first for gas efficiency

**Dynamic Whitelist (Owner Managed)**
- Owner can add addresses: `addToWhitelist(address)`
- Owner can remove addresses: `removeFromWhitelist(address)`
- Ownership transferable: `transferOwnership(newOwner)`

### Activity Checking

The checker verifies:
1. Address is whitelisted
2. Mech marketplace request count increased
3. Activity ratio meets liveness threshold (~1 request/day)

## Staking Parameters

Default parameters (customize in `deploy-jin-staking.ts`):

| Parameter | Value | Description |
|-----------|-------|-------------|
| maxNumServices | 100 | Max services that can stake |
| rewardsPerSecond | 0.0001 OLAS | Reward emission rate |
| minStakingDeposit | 50 OLAS | Minimum deposit to stake |
| livenessPeriod | 86400 | 24 hours |
| timeForEmissions | 31536000 | 1 year |
| minNumStakingPeriods | 3 | Min periods before unstaking |
| maxNumInactivityPeriods | 2 | Max inactivity before eviction |

## Security Considerations

1. **Activity Checker Owner**: Use a multisig (Safe) for production, not an EOA
2. **Test First**: Deploy on Base Sepolia before mainnet
3. **Verify Contracts**: Verify on BaseScan after deployment
4. **Audit Whitelist Logic**: Review before mainnet deployment

## References

- [OLAS Staking Docs](https://docs.olas.network)
- [StakingFactory Source](../../code-resources/autonolas-registries/contracts/staking/StakingFactory.sol)
- [RequesterActivityChecker Source](../../code-resources/autonolas-staking-programmes/contracts/mech_usage/RequesterActivityChecker.sol)
- [OLAS Govern App](https://govern.olas.network/)
