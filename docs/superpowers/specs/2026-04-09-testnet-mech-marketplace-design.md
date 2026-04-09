# Testnet MechMarketplace + Full Client Daemon Design

> Version: 0.1.0
> Date: 2026-04-09
> Author: Oak, Claude

## 1. Goal

Deploy the full OLAS MechMarketplace stack on Base Sepolia so the Jinn client daemon can run the complete training loop on testnet: create restoration jobs, claim and deliver restorations via Claude, claim deliveries, create evaluation jobs — all through the JinnRouter, earning JINN staking rewards. This is the production-equivalent path, not a mock or in-memory substitute.

## 2. Why

Phase 1b is about battle-testing the full protocol on testnet before mainnet. The client daemon currently stops at bootstrap on testnet because the Mech Marketplace doesn't exist on Base Sepolia. Without it, the three daemon loops (creator, restorer, delivery-watcher) cannot operate. Deploying the real marketplace contracts closes this gap and enables extended testnet operation with real clients.

## 3. What We're Deploying

### 3.1 Contracts to vendor (from `valory-xyz/ai-registry-mech`)

| Contract | Purpose |
|----------|---------|
| `MechMarketplace.sol` | Request/delivery hub (proxy pattern) |
| `Karma.sol` | Reputation tracking (required by marketplace constructor) |
| `MechFactoryFixedPriceNative.sol` | Creates OlasMech instances with native ETH payment |
| `OlasMechFixedPriceNative.sol` | Individual mech template contract |
| `BalanceTrackerFixedPriceNative.sol` | Payment balance tracking (required by factory registration) |
| Supporting interfaces/base contracts | As needed for compilation |

Vendored into: `contracts/src/vendor/mech/`

### 3.2 Existing contracts to deploy

| Contract | Source | Purpose |
|----------|--------|---------|
| `JinnRouter.sol` | `jinn-cli-agents/contracts/staking/` | Request routing + activity tracking + OLAS activity checker |
| `ClaimRegistry.sol` | `contracts/src/claiming/` | Job claim coordination (optional) |

### 3.3 New staking proxy

A new `StakingToken` proxy instance with `activityChecker` pointing at the JinnRouter. The existing Phase 1a staking instances remain untouched.

## 4. Deployment Sequence

All on Base Sepolia. Single deployment script: `contracts/scripts/deploy-phase1b-mech.ts`.

```
1. Deploy Karma
2. Deploy MechMarketplace implementation
3. Deploy MechMarketplace proxy (initialized with Karma)
4. Deploy OlasMechFixedPriceNative (mech template)
5. Deploy BalanceTrackerFixedPriceNative
6. Deploy MechFactoryFixedPriceNative (needs marketplace, mech template, balance tracker)
7. Register factory in marketplace (whitelist)
8. Deploy JinnRouter (initialized with marketplace address + liveness ratio)
9. Create new StakingToken proxy via the existing Phase 1a StakingFactory, with activityChecker = JinnRouter
10. Fund staking proxy with JINN rewards
```

### 4.1 Artifact output

`deployment-phase1b-mech-baseSepolia.json` (or `-fast` variant), containing:

```json
{
  "network": "baseSepolia",
  "chainId": 84532,
  "deployer": "0x...",
  "contracts": {
    "karma": "0x...",
    "mechMarketplaceImpl": "0x...",
    "mechMarketplace": "0x...",
    "mechTemplate": "0x...",
    "balanceTracker": "0x...",
    "mechFactory": "0x...",
    "jinnRouter": "0x...",
    "stakingToken": "0x..."
  },
  "config": {
    "timingProfile": "fast-test",
    "livenessRatio": "1000000000000000",
    "paymentType": "0xba699a34..."
  }
}
```

## 5. Client Changes

### 5.1 Bootstrap (`client/src/earning/bootstrap.ts`)

- Remove testnet `stopAt: 'service_staked'` gate when marketplace addresses are available
- Bootstrap runs all 11 steps through `complete`, including `mech_deployed`
- `mech_deployed` step calls `marketplace.create()` via the Safe to create an OlasMech instance

### 5.2 Main entry point (`client/src/main.ts`)

- Remove the hard testnet exit at lines 119-122
- Instantiate MechAdapter for testnet using addresses from the mech deployment artifact
- Daemon starts and runs the three loops identically to mainnet

### 5.3 Chain config (`client/src/earning/contracts.ts`)

- `BASE_SEPOLIA_CONFIG` loads real addresses from the mech deployment artifact
- New config/env inputs:
  - Config key: `testnetMechDeploymentPath`
  - Env var: `JINN_TESTNET_MECH_DEPLOYMENT`
- When the mech deployment path is provided, `mechMarketplace`, `mechFactory`, and router addresses are loaded from the artifact, overriding the null defaults

### 5.4 MechAdapter config

The adapter receives testnet addresses:
- `mechMarketplaceAddress` — from the deployment artifact
- `routerAddress` — JinnRouter on Base Sepolia
- `mechContractAddress` — from bootstrap state (`earning_state.json` → `mech_address`)
- `safeAddress` — from bootstrap state
- `agentEoaPrivateKey` — from the agent keystore

## 6. JinnRouter as Activity Checker

The JinnRouter serves dual roles:
1. **Request router** — wraps marketplace calls, tags job types (restoration/evaluation), enforces loop ordering
2. **Activity checker** — implements `getMultisigNonces()` (5 slots) + `isRatioPass()` for OLAS staking

The new staking proxy points at the JinnRouter as its activity checker. Activity is recorded implicitly through JinnRouter calls:
- `createRestorationJob()` → increments `creationCount[msg.sender]`
- `claimDelivery(requestId)` for restoration → increments `restorationDeliveryCount[msg.sender]`
- `createEvaluationJob()` → increments `evaluationCreationCount[msg.sender]`
- `claimDelivery(requestId)` for evaluation → increments `evaluationDeliveryCount[msg.sender]`

No separate `recordActivity()` call needed. The training loop itself IS the activity.

## 7. Operator Flow

After Phase 1a stack is deployed (L1 tokenomics + L2 staking + bridge):

```bash
# 1. Deploy mech marketplace stack
cd contracts
PHASE1A_TIMING_PROFILE=fast-test \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
npx hardhat run scripts/deploy-phase1b-mech.ts --network baseSepolia

# 2. Run governance wiring for the new staking proxy (if needed)
# ... (reuse existing Phase 1a governance scripts pointed at new proxy)

# 3. Start the client — full daemon, not just bootstrap
cd client
JINN_NETWORK=testnet \
JINN_EARNING_DIR=/tmp/jinn-phase1b/earning \
JINN_TESTNET_L2_DEPLOYMENT=../contracts/deployment-phase1a-l2-baseSepolia-fast.json \
JINN_TESTNET_TOKEN_DEPLOYMENT=../contracts/deployment-phase1a-token-baseSepolia-fast.json \
JINN_TESTNET_MECH_DEPLOYMENT=../contracts/deployment-phase1b-mech-baseSepolia-fast.json \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
JINN_PASSWORD=<keystore-password> \
npm start
```

The client bootstraps (wallet → Safe → service → staking → mech), then starts the daemon. The daemon runs the full training loop: posting desired states, restoring via Claude, delivering results, claiming deliveries, creating evaluation jobs.

## 8. Testing Strategy

- **Contract tests:** Deploy the marketplace stack locally in Hardhat tests, verify request/delivery/claim flow through the JinnRouter
- **Existing tests:** All Phase 1a tests must continue passing (the new contracts don't modify existing ones)
- **Live testnet proof:** Deploy on Base Sepolia fast-test stack, run the client, verify the full loop generates on-chain activity that earns staking rewards

## 9. Files to Create

| File | Purpose |
|------|---------|
| `contracts/src/vendor/mech/*.sol` | Vendored OLAS MechMarketplace contracts |
| `contracts/scripts/deploy-phase1b-mech.ts` | Deployment script for marketplace stack |
| `contracts/test/phase1/MechMarketplace.test.ts` | Tests for marketplace + JinnRouter integration |

## 10. Files to Modify

| File | Change |
|------|--------|
| `client/src/main.ts` | Remove testnet early exit, wire MechAdapter for testnet |
| `client/src/earning/bootstrap.ts` | Allow full bootstrap on testnet when marketplace exists |
| `client/src/earning/contracts.ts` | Load mech addresses from deployment artifact |
| `client/src/config.ts` | Add `testnetMechDeploymentPath` config key |
| `contracts/hardhat.config.ts` | Add any needed compiler versions for vendored contracts |
| `docs/phase1a-operator-runbook.md` | Add Phase 1b mech deployment section |

## 11. What This Does NOT Include

- Deploying the real OLAS contracts on Ethereum Sepolia (L1) — the mech stack is L2-only
- Multi-operator testing — single operator for now
- Karma-based mech selection — all requests go to the operator's own mech as priority
- Token-based payment factories — native ETH payment only
- Anti-farming V2 integration with JinnRouter — future work (JinnRouter could be extended to include evidence hashing)
