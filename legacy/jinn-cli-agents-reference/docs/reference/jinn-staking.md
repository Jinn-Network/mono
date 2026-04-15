---
title: Jinn Staking Contract Guide
purpose: reference
scope: [deployment]
last_verified: 2026-01-30
related_code:
  - olas-operate-middleware/
  - worker/OlasStakingManager.ts
keywords: [staking, olas, veolas, emissions, rewards, voting]
when_to_read: "When understanding staking mechanics, rewards, or veOLAS voting"
---

# Jinn Staking Contract - Complete Guide

## Overview

This document summarizes the Jinn staking contract deployment on Base and the veOLAS voting mechanics required to receive protocol emissions.

## Deployed Contracts

### Base Network

| Contract | Address |
|----------|---------|
| Activity Checker (v1) | `0x1dF0be586a7273a24C7b991e37FE4C0b1C622A9B` |
| Staking Contract v1 | `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139` |
| Activity Checker (v2) | `0xe575393b921C98288a842217AFBeDBA8197496D5` |
| Staking Contract v2 | `0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488` |

### Nomination

- **Ethereum Mainnet TX**: `0xe794032599e191c7e04ad6db4b72381512422d7feb02ed2088522ad9cfdb659d`
- **Block**: 24225500
- **Nominee ID**: 67
- **VoteWeighting Contract**: `0x95418b46d5566D3d1ea62C12Aea91227E566c5c1`
- **Status**: Successfully nominated via VoteWeighting contract

## Contract Parameters

| Parameter | Value |
|-----------|-------|
| `minStakingDeposit` | 5,000 OLAS |
| `maxNumServices` | 10 |
| `rewardsPerSecond` | 0.000475646879756468 OLAS |
| `livenessPeriod` | 1 day (86,400 seconds) |
| `timeForEmissions` | 30 days (2,592,000 seconds) |
| `livenessRatio` | 694444444444444 (60 requests/day required) |

### Whitelisted MEC Addresses

- `0xb55fadf1f0bb1de99c13301397c7b67fde44f6b1`
- `0x8c083dfe9bee719a05ba3c75a9b16be4ba52c299`

### Reward Economics

| Metric | Value |
|--------|-------|
| Rewards per day (total pool) | 41.1 OLAS |
| Rewards per 14-day epoch | 575 OLAS |
| Max rewards (30 days) | 1,233 OLAS |
| Per-service rewards (10 staked) | 57.5 OLAS/epoch |
| APY per service | 30% (on 5,000 OLAS deposit) |

## APY Limit Verification

The StakingVerifier on Base enforces:

```
APY = (rewardsPerSecond × 365 days × 1e18) / minStakingDeposit
```

| Limit | Value |
|-------|-------|
| `apyLimit` | 3e18 = **300%** |
| `minStakingDepositLimit` | 10,000 OLAS |

**Jinn Contract APY**: 300% (exactly at limit)

Note: APY is calculated based on `minStakingDeposit`, NOT total bonded amount.

---

## veOLAS Voting & Emissions

### How Protocol Emissions Work

1. **Epoch Distribution**: 75% of OLAS epoch emissions go to Operators (staking)
2. **Total Staking Pool**: ~714,000 OLAS available per epoch
3. **Vote Weighting**: veOLAS holders vote for staking contracts
4. **Distribution**: Each contract receives proportional share based on votes

### Critical Finding: NOT Zero-Sum (Currently)

The Dispenser contract contains this logic:

```solidity
uint256 availableStakingAmount = stakingPoint.stakingIncentive;

if (availableStakingAmount > totalWeightSum) {
    stakingDiff = availableStakingAmount - totalWeightSum;
    availableStakingAmount = totalWeightSum;
}

stakingIncentive = (availableStakingAmount * stakingWeight) / 1e18;
```

**Interpretation**:
- If total veOLAS votes < available OLAS pool, the pool is capped at total votes
- Excess OLAS returns to inflation (not distributed)
- Currently only ~14K veOLAS voting for staking (vs 714K OLAS available)
- **Adding votes claims from the excess pool, NOT from other contracts**

### Current Vote Distribution (Govern UI)

| Contract | veOLAS | Share |
|----------|--------|-------|
| LST (Gnosis) | 5,087 | 0.7% |
| Pett.AI 1 (Base) | 4,360 | 0.6% |
| Pett.AI 2 (Base) | 4,360 | 0.6% |
| **Total** | ~14,000 | ~2% |

### Effective Reward Rate

Due to under-subscription, the effective rate is approximately **1:1**:
- 5,000 veOLAS = ~5,000 OLAS per epoch
- This holds as long as total veOLAS < available OLAS pool

---

## veOLAS Lock Strategy

### Lock Duration vs Amount

veOLAS formula: `veOLAS = OLAS_locked × (time_remaining / 4_years)`

| Lock Duration | OLAS Needed | Starting veOLAS |
|---------------|-------------|-----------------|
| 4 years | 5,000 | 5,000 |
| 2 years | 10,000 | 5,000 |
| 1 year | 20,000 | 5,000 |
| 6 months | 40,000 | 5,000 |
| 3 months | 80,000 | 5,000 |

### veOLAS Decay

veOLAS decays linearly to 0 at lock expiry:
- Day 1 of 3-month lock: 100% of starting veOLAS
- Day 45: ~50%
- Day 90: 0%

### Recommended Strategy: Rolling 3-Month Lock

**Initial Setup**:
- Lock ~90,000 OLAS for 3 months
- Starting veOLAS: 5,625
- After 2 weeks: ~4,687 veOLAS (still above 5K effective)

**Maintenance**:
- Every 2 weeks (before epoch ends): extend lock back to 3 months
- Keeps veOLAS consistently above 5,000
- Gas cost: ~$5-10 per extension on mainnet

### veOLAS Contract Functions

```solidity
increase_unlock_time()  // Extends lock duration
increase_amount()       // Adds more OLAS to existing lock
```

---

## Service Requirements

### To Stake in Jinn Contract

1. **Minimum Deposit**: 5,000 OLAS (security deposit + agent bond combined)
2. **Agent ID**: Must be agent 43 (Mech)
3. **Activity**: 60 requests/day via whitelisted MEC addresses
4. **Service State**: Must be in Deployed state (state 4)

### Migration from Existing Service

If your existing service has < 5,000 OLAS bond:
1. Unstake from current contract
2. Either:
   - Increase service bond to 5,000 OLAS, OR
   - Create new service with 5,000 OLAS bond
3. Stake into Jinn contract

---

## Reward Flow Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    OLAS Protocol Emissions                   │
│                    (~714K OLAS/epoch to staking)            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      VoteWeighting                           │
│         (veOLAS holders vote for staking contracts)         │
│                                                              │
│  Current: ~14K veOLAS voting = ~14K OLAS distributed        │
│  Remaining ~700K OLAS returns to inflation                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Dispenser                             │
│              (Claims and bridges to L2 chains)              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Jinn Staking Contract (Base)                │
│                                                              │
│  • Receives OLAS based on veOLAS vote share                 │
│  • Distributes to staked services meeting activity          │
│  • 60 requests/day via whitelisted MECs required            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Staked Services                          │
│                                                              │
│  • Each active service earns proportional rewards           │
│  • Max 10 services, ~57.5 OLAS/epoch each if all active    │
└─────────────────────────────────────────────────────────────┘
```

---

## Action Checklist

### Immediate

- [ ] Lock OLAS on Ethereum mainnet (https://govern.olas.network/ → veOLAS)
- [ ] Vote for Jinn staking contract on Base
- [ ] Unstake existing service from old contract
- [ ] Create/modify service with 5,000 OLAS deposit
- [ ] Stake service into Jinn contract

### Ongoing

- [ ] Extend veOLAS lock every 2 weeks (before epoch end)
- [ ] Ensure 60+ mech requests per day via whitelisted addresses
- [ ] Monitor rewards via checkpoint calls

---

## Key Contract Addresses

### Ethereum Mainnet

| Contract | Address |
|----------|---------|
| VoteWeighting | `0x95418b46d5566D3d1ea62C12Aea91227E566c5c1` |
| veOLAS | `0x7e01A500805f8A52Fad229b3015AD130A332B7b3` |
| Dispenser | `0xeED0000fE94d7cfeF4Dc0CA86a223f0F603A61B8` |

**IMPORTANT**: Use `addNomineeEVM(address, chainId)` to nominate EVM staking contracts, NOT `addNominee()`.

### Base Network

| Contract | Address |
|----------|---------|
| StakingFactory | `0x1cEe30D08943EB58EFF84DD1AB44a6ee6FEff63a` |
| StakingVerifier | `0x10c5525F77F13b28f42c5626240c001c2D57CAd4` |
| ServiceRegistry | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` |
| ServiceRegistryTokenUtility | `0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5` |
| MechMarketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` |

---

## References

- OLAS Govern: https://govern.olas.network/
- stOLAS (LST recipient): Shows ~890K OLAS staked, ~14% APY
- Dispenser contract: `code-resources/autonolas-tokenomics/contracts/Dispenser.sol`
- StakingVerifier: `code-resources/autonolas-registries/contracts/staking/StakingVerifier.sol`
