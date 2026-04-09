# Testnet MechMarketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the full OLAS MechMarketplace + JinnRouter on Base Sepolia and wire the client daemon to run the complete training loop on testnet.

**Architecture:** Vendor the OLAS mech contracts from `valory-xyz/autonolas-marketplace` into `contracts/src/vendor/mech/`. Write a Hardhat deployment script that deploys Karma, MechMarketplace (proxy), MechFactory, BalanceTracker, and JinnRouter on Base Sepolia. Update the client to load mech addresses from a deployment artifact, remove the testnet early-exit, and run the MechAdapter with JinnRouter on testnet.

**Tech Stack:** Solidity 0.8.28/0.8.30, Hardhat, ethers.js v6, TypeScript, viem

**Spec:** `docs/superpowers/specs/2026-04-09-testnet-mech-marketplace-design.md`

---

## File Structure

### New files to create

| File | Responsibility |
|------|---------------|
| `contracts/src/vendor/mech/MechMarketplace.sol` | Core marketplace (vendored from OLAS) |
| `contracts/src/vendor/mech/Karma.sol` | Reputation tracking (vendored) |
| `contracts/src/vendor/mech/OlasMech.sol` | Abstract base mech (vendored) |
| `contracts/src/vendor/mech/MechFixedPriceBase.sol` | Fixed-price mech base (vendored) |
| `contracts/src/vendor/mech/MechFactoryBase.sol` | Abstract factory base (vendored) |
| `contracts/src/vendor/mech/BalanceTrackerBase.sol` | Abstract balance tracker (vendored) |
| `contracts/src/vendor/mech/mechs/native/MechFixedPriceNative.sol` | Native-token mech (vendored) |
| `contracts/src/vendor/mech/mechs/native/MechFactoryFixedPriceNative.sol` | Native-token factory (vendored) |
| `contracts/src/vendor/mech/mechs/native/BalanceTrackerFixedPriceNative.sol` | Native balance tracker (vendored) |
| `contracts/src/vendor/mech/proxies/KarmaProxy.sol` | Karma UUPS proxy (vendored) |
| `contracts/src/vendor/mech/proxies/MechMarketplaceProxy.sol` | Marketplace UUPS proxy (vendored) |
| `contracts/src/vendor/mech/interfaces/*.sol` | Interface files (vendored) |
| `contracts/src/vendor/mech/lib/Mech.sol` | gnosis-mech base (vendored, flattened) |
| `contracts/src/staking/JinnRouter.sol` | Copy from `jinn-cli-agents/contracts/staking/` |
| `contracts/scripts/deploy-phase1b-mech.ts` | Deployment script for full mech stack |
| `contracts/test/phase1/MechMarketplace.test.ts` | Integration tests |

### Files to modify

| File | Change |
|------|--------|
| `contracts/package.json` | Add `@gnosis.pm/safe-contracts` dependency (for `Enum.sol`) |
| `contracts/hardhat.config.ts` | Add compiler override for MechMarketplace (0.8.30) and Mech base (0.8.28) |
| `client/src/main.ts` | Remove testnet early-exit, wire MechAdapter for testnet |
| `client/src/earning/bootstrap.ts` | Allow full bootstrap when marketplace exists |
| `client/src/earning/contracts.ts` | Load mech addresses from deployment artifact |
| `client/src/config.ts` | Add `testnetMechDeploymentPath` config key |
| `docs/phase1a-operator-runbook.md` | Add Phase 1b mech deployment section |

---

## Task 1: Install gnosis-mech dependency

The OLAS `OlasMech.sol` inherits from `Mech.sol` which imports `@gnosis.pm/safe-contracts/contracts/common/Enum.sol`. We need this npm package.

**Files:**
- Modify: `contracts/package.json`

- [ ] **Step 1: Install the Safe contracts package**

```bash
cd contracts
npm install @gnosis.pm/safe-contracts@1.3.0
```

- [ ] **Step 2: Verify the Enum.sol file is accessible**

```bash
ls node_modules/@gnosis.pm/safe-contracts/contracts/common/Enum.sol
```

Expected: file exists.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @gnosis.pm/safe-contracts for OlasMech dependency"
```

---

## Task 2: Vendor OLAS mech contracts

Fetch the contract sources from `valory-xyz/autonolas-marketplace` and vendor them into our repo. The gnosis-mech `Mech.sol` base contract needs to be vendored with its dependency on `Account.sol` and `Receiver.sol` flattened/adapted to work with our Hardhat setup.

**Files:**
- Create: `contracts/src/vendor/mech/` (entire directory tree)

- [ ] **Step 1: Create the vendor directory structure**

```bash
mkdir -p contracts/src/vendor/mech/interfaces
mkdir -p contracts/src/vendor/mech/mechs/native
mkdir -p contracts/src/vendor/mech/proxies
mkdir -p contracts/src/vendor/mech/lib
```

- [ ] **Step 2: Fetch all contract sources from GitHub**

Fetch each file from `https://raw.githubusercontent.com/valory-xyz/autonolas-marketplace/main/contracts/` and save to the corresponding path under `contracts/src/vendor/mech/`. The files to fetch:

Core contracts:
- `MechMarketplace.sol` → `contracts/src/vendor/mech/MechMarketplace.sol`
- `Karma.sol` → `contracts/src/vendor/mech/Karma.sol`
- `OlasMech.sol` → `contracts/src/vendor/mech/OlasMech.sol`
- `MechFixedPriceBase.sol` → `contracts/src/vendor/mech/MechFixedPriceBase.sol`
- `MechFactoryBase.sol` → `contracts/src/vendor/mech/MechFactoryBase.sol`
- `BalanceTrackerBase.sol` → `contracts/src/vendor/mech/BalanceTrackerBase.sol`

Interfaces:
- `interfaces/IErrorsMarketplace.sol`
- `interfaces/IErrorsMech.sol`
- `interfaces/IBalanceTracker.sol`
- `interfaces/IMech.sol`
- `interfaces/IMechMarketplace.sol`
- `interfaces/IServiceRegistry.sol`
- `interfaces/IKarma.sol`

Native mechs:
- `mechs/native/MechFixedPriceNative.sol`
- `mechs/native/MechFactoryFixedPriceNative.sol`
- `mechs/native/BalanceTrackerFixedPriceNative.sol`

Proxies:
- `proxies/KarmaProxy.sol`
- `proxies/MechMarketplaceProxy.sol`

gnosis-mech base (from `valory-xyz/gnosis-mech`):
- `contracts/base/Mech.sol` → `contracts/src/vendor/mech/lib/Mech.sol`
- `contracts/base/Account.sol` → `contracts/src/vendor/mech/lib/Account.sol`
- `contracts/base/Receiver.sol` → `contracts/src/vendor/mech/lib/Receiver.sol`
- `contracts/interfaces/IMech.sol` → `contracts/src/vendor/mech/lib/IMechGnosis.sol`

- [ ] **Step 3: Fix import paths**

After fetching, update all import paths to use relative paths within the vendor directory. Key changes:
- `OlasMech.sol`: Change `import {Mech} from "lib/gnosis-mech/contracts/base/Mech.sol"` → `import {Mech} from "./lib/Mech.sol"`
- `Mech.sol`: Change `import "@gnosis.pm/safe-contracts/contracts/common/Enum.sol"` — keep this as-is (npm package)
- `Mech.sol`: Change `import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol"` — keep as-is (npm package)
- `Mech.sol`: Change `import "../interfaces/IMech.sol"` → `import "./IMechGnosis.sol"`
- All interface imports in marketplace contracts: adjust to relative `./interfaces/` paths
- `MechFixedPriceNative.sol`: adjust import of `MechFixedPriceBase` to `../../MechFixedPriceBase.sol`
- Similarly for factory and balance tracker native variants

- [ ] **Step 4: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: compiles successfully. May need Hardhat config overrides (see Task 3).

- [ ] **Step 5: Commit**

```bash
git add contracts/src/vendor/mech/
git commit -m "feat: vendor OLAS MechMarketplace contracts from autonolas-marketplace"
```

---

## Task 3: Update Hardhat config for vendored contracts

The MechMarketplace uses Solidity 0.8.30 and the mech base contracts use 0.8.28. Add compiler overrides as needed.

**Files:**
- Modify: `contracts/hardhat.config.ts`

- [ ] **Step 1: Add compiler overrides for large/specific vendored contracts**

Add overrides in the `solidity.overrides` section of `hardhat.config.ts` for any contracts that need specific compiler versions or settings. The 0.8.28 and 0.8.30 compilers are already configured.

If `MechMarketplace.sol` is large (948 lines), it may need the large contract optimizer settings:

```typescript
"src/vendor/mech/MechMarketplace.sol": {
  version: "0.8.30",
  settings: largeContractSettings,
},
```

- [ ] **Step 2: Verify compilation passes**

```bash
cd contracts
npx hardhat compile
```

Expected: all contracts compile, including vendored mech contracts.

- [ ] **Step 3: Verify existing tests still pass**

```bash
cd contracts
npx hardhat test
```

Expected: all existing tests pass (vendoring new contracts should not affect existing tests).

- [ ] **Step 4: Commit**

```bash
git add contracts/hardhat.config.ts
git commit -m "chore: add Hardhat compiler overrides for vendored mech contracts"
```

---

## Task 4: Copy JinnRouter into contracts/src

The JinnRouter exists in `jinn-cli-agents/contracts/staking/JinnRouter.sol`. Copy it into the main contracts directory so the deployment script can reference it.

**Files:**
- Create: `contracts/src/staking/JinnRouter.sol`

- [ ] **Step 1: Copy the JinnRouter**

```bash
cp jinn-cli-agents/contracts/staking/JinnRouter.sol contracts/src/staking/JinnRouter.sol
```

- [ ] **Step 2: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add contracts/src/staking/JinnRouter.sol
git commit -m "feat: add JinnRouter to contracts for testnet deployment"
```

---

## Task 5: Write the mech marketplace deployment script

Single script that deploys the entire mech marketplace stack on Base Sepolia.

**Files:**
- Create: `contracts/scripts/deploy-phase1b-mech.ts`

- [ ] **Step 1: Write the deployment script**

The script deploys in order:
1. Karma implementation
2. KarmaProxy (initialized)
3. MechMarketplace implementation (constructor: serviceRegistry, karmaProxy)
4. MechMarketplaceProxy (initialized with fee=0, minTimeout=60, maxTimeout=300)
5. MechFixedPriceNative template (constructor: marketplace, serviceRegistry, 0, 0 — template only)
6. BalanceTrackerFixedPriceNative (constructor: marketplace, deployer as drainer, WETH address)
7. MechFactoryFixedPriceNative (constructor: marketplace)
8. Register factory in marketplace: `setMechFactoryStatuses([factory], [true])`
9. Register balance tracker: `setPaymentTypeBalanceTrackers([NATIVE_PAYMENT_TYPE], [balanceTracker])`
10. Whitelist marketplace in Karma: `setMechMarketplaceStatuses([marketplace], [true])`
11. Deploy JinnRouter, call `initialize(marketplace, livenessRatio)`
12. Create new StakingToken proxy via existing StakingFactory with `activityChecker = jinnRouter`

Environment variables:
- `DEPLOYER_PRIVATE_KEY` — deployer key
- `BASE_SEPOLIA_RPC_URL` — RPC endpoint
- `PHASE1A_TIMING_PROFILE` — canonical or fast-test
- `SERVICE_REGISTRY_ADDRESS` — Base Sepolia ServiceRegistry (default: `0x31D3202d8744B16A120117A053459DDFAE93c855`)
- `WETH_ADDRESS` — Wrapped ETH (default: `0x4200000000000000000000000000000000000006`)
- `L2_DEPLOYMENT_PATH` — path to existing Phase 1a L2 deployment artifact (for StakingFactory address and JINN token)

Key constants:
- `NATIVE_PAYMENT_TYPE = keccak256("FixedPriceNative")` = `0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1`
- Marketplace fee: `0` (no fee for testnet)
- Min response timeout: `60`
- Max response timeout: `300`
- Liveness ratio: `1e15` (same as Phase 1a)

Output artifact: `deployment-phase1b-mech-baseSepolia.json` (or `-fast` variant)

- [ ] **Step 2: Verify the script compiles and runs locally**

```bash
cd contracts
npx hardhat run scripts/deploy-phase1b-mech.ts
```

Expected: deploys all contracts on local Hardhat network, outputs artifact to stdout.

- [ ] **Step 3: Commit**

```bash
git add contracts/scripts/deploy-phase1b-mech.ts
git commit -m "feat: add Phase 1b mech marketplace deployment script"
```

---

## Task 6: Write integration tests

Test the MechMarketplace + JinnRouter flow locally: create request through router, deliver via mech, claim delivery, verify activity counters.

**Files:**
- Create: `contracts/test/phase1/MechMarketplace.test.ts`

- [ ] **Step 1: Write the test file**

Tests to include:
1. Deploy the full mech stack (Karma, marketplace proxy, factory, balance tracker, JinnRouter)
2. Create a mech via the factory
3. Create a restoration job via JinnRouter → verify `creationCount` incremented
4. Deliver via the mech → verify marketplace status changes to `Delivered`
5. Claim delivery via JinnRouter → verify `restorationDeliveryCount` incremented
6. Create an evaluation job via JinnRouter → verify loop enforcement (requires restoration claim)
7. `getMultisigNonces` returns correct 5-slot array
8. `isRatioPass` passes when activity rate meets threshold

Use Hardhat's local network with the ServiceRegistryStub from the existing test setup.

- [ ] **Step 2: Run the tests**

```bash
cd contracts
npx hardhat test test/phase1/MechMarketplace.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run all tests to verify no regressions**

```bash
cd contracts
npx hardhat test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add contracts/test/phase1/MechMarketplace.test.ts
git commit -m "test: add MechMarketplace + JinnRouter integration tests"
```

---

## Task 7: Add testnet mech deployment config to client

Add the `testnetMechDeploymentPath` config key so the client can load marketplace addresses from the deployment artifact.

**Files:**
- Modify: `client/src/config.ts`
- Modify: `client/src/earning/contracts.ts`

- [ ] **Step 1: Add config key to `config.ts`**

Add `testnetMechDeploymentPath` to the config schema and resolution, following the existing pattern for `testnetL2DeploymentPath`:

```typescript
// In the schema
testnetMechDeploymentPath: z.string().optional(),

// In env resolution
JINN_TESTNET_MECH_DEPLOYMENT → testnetMechDeploymentPath
```

- [ ] **Step 2: Update `contracts.ts` to load mech addresses from artifact**

When `testnetMechDeploymentPath` is provided, load the artifact and override:
- `mechMarketplace` — from `contracts.mechMarketplace`
- `mechFactory` — from `contracts.mechFactory`

Also add a new field to `ChainConfig`:
- `jinnRouter` — JinnRouter address on the chain (loaded from artifact `contracts.jinnRouter`)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd client
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/config.ts client/src/earning/contracts.ts
git commit -m "feat: add testnet mech deployment artifact loading to client config"
```

---

## Task 8: Wire up the client daemon for testnet

Remove the testnet early-exit in `main.ts`, make `ROUTER_ADDRESS` configurable, and let the daemon start on testnet.

**Files:**
- Modify: `client/src/main.ts`
- Modify: `client/src/earning/bootstrap.ts`

- [ ] **Step 1: Update bootstrap to allow full run on testnet**

In `main.ts` line 70, change `stopAt` logic:

```typescript
// Old:
stopAt: config.network === 'testnet' ? 'service_staked' : 'complete',

// New: run through to complete when marketplace is available
stopAt: config.network === 'testnet' && !CHAIN_CONFIG.mechMarketplace 
  ? 'service_staked' 
  : 'complete',
```

Also pass `testnetMechDeploymentPath` to the bootstrapper options so it can resolve marketplace/factory addresses.

- [ ] **Step 2: Remove the testnet early exit**

In `main.ts` lines 119-122, replace the hard exit with a conditional:

```typescript
// Old:
if (config.network === 'testnet') {
  console.log('[main] Testnet bootstrap stops at service_staked by design. Exiting before mech/daemon startup.');
  return;
}

// New: only exit if marketplace is not configured
if (!mechAddress) {
  if (config.network === 'testnet') {
    console.log('[main] No mech marketplace configured for testnet. Bootstrap complete, daemon not started.');
    console.log('[main] To run the daemon, deploy the mech marketplace and set JINN_TESTNET_MECH_DEPLOYMENT.');
    return;
  }
  throw new Error('Bootstrap completed without a mech address. Re-run to deploy the mech.');
}
```

- [ ] **Step 3: Make router address configurable**

Replace the hardcoded `ROUTER_ADDRESS` with a value from chain config:

```typescript
// Old:
const ROUTER_ADDRESS = '0xfFa7118A3D820cd4E820010837D65FAfF463181B' as const;

// New:
const ROUTER_ADDRESS = (CHAIN_CONFIG.jinnRouter ?? '0xfFa7118A3D820cd4E820010837D65FAfF463181B') as `0x${string}`;
```

And update the MechAdapter instantiation to use the correct chain ID:

```typescript
chainId: config.network === 'testnet' ? 84532 : 8453,
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd client
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Run all client tests**

```bash
cd client
npx vitest run
```

Expected: all tests pass (existing daemon tests use LocalAdapter, not affected by these changes).

- [ ] **Step 6: Commit**

```bash
git add client/src/main.ts client/src/earning/bootstrap.ts
git commit -m "feat: wire client daemon for testnet with MechMarketplace support"
```

---

## Task 9: Update operator runbook

Add Phase 1b mech marketplace deployment instructions to the operator runbook.

**Files:**
- Modify: `docs/phase1a-operator-runbook.md`

- [ ] **Step 1: Add Phase 1b mech deployment section**

Add a new section after the existing content covering:
- Deploy mech marketplace stack command
- New env vars (`JINN_TESTNET_MECH_DEPLOYMENT`)
- Updated client start command with mech deployment path
- Expected daemon behavior (three loops running, activity recorded via JinnRouter)

- [ ] **Step 2: Commit**

```bash
git add docs/phase1a-operator-runbook.md
git commit -m "docs: add Phase 1b mech marketplace deployment to operator runbook"
```

---

## Task 10: Deploy to Base Sepolia and verify

Live deployment of the mech marketplace stack on the fast-test Base Sepolia stack.

**Files:**
- Create: `contracts/deployment-phase1b-mech-baseSepolia-fast.json` (output artifact)

- [ ] **Step 1: Deploy the mech marketplace stack**

```bash
cd contracts
PHASE1A_TIMING_PROFILE=fast-test \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
SERVICE_REGISTRY_ADDRESS=0x31D3202d8744B16A120117A053459DDFAE93c855 \
npx hardhat run scripts/deploy-phase1b-mech.ts --network baseSepolia
```

Expected: all contracts deploy, artifact written.

- [ ] **Step 2: Start the client with mech marketplace**

```bash
cd client
JINN_NETWORK=testnet \
JINN_EARNING_DIR=/tmp/jinn-phase1b/earning \
JINN_TESTNET_L2_DEPLOYMENT=../contracts/deployment-phase1a-l2-baseSepolia-fast.json \
JINN_TESTNET_TOKEN_DEPLOYMENT=../contracts/deployment-phase1a-token-baseSepolia-fast.json \
JINN_TESTNET_MECH_DEPLOYMENT=../contracts/deployment-phase1b-mech-baseSepolia-fast.json \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
JINN_PASSWORD=<password> \
npm start
```

Expected: bootstrap runs through `complete` (including mech deployment), daemon starts, three loops begin operating.

- [ ] **Step 3: Verify on-chain activity**

Check that the JinnRouter's activity counters are incrementing:
```bash
cast call <jinnRouter> "creationCount(address)" <safeAddress> --rpc-url https://sepolia.base.org
```

Expected: non-zero creation count after the creator loop posts a desired state.

- [ ] **Step 4: Record deployment artifact and commit**

```bash
git add contracts/deployment-phase1b-mech-baseSepolia-fast.json
git commit -m "feat: deploy Phase 1b mech marketplace on Base Sepolia fast-test"
```

---

## Dependency Graph

```
Task 1 (install deps)
  ↓
Task 2 (vendor contracts) → Task 3 (Hardhat config)
  ↓
Task 4 (copy JinnRouter)
  ↓
Task 5 (deployment script) → Task 6 (tests)
  ↓
Task 7 (client config) → Task 8 (client wiring)
  ↓
Task 9 (runbook) → Task 10 (live deployment)
```

Tasks 1-4 can be done in sequence. Tasks 5 and 6 depend on 1-4. Tasks 7-8 depend on 5 (need artifact format). Task 9 is documentation. Task 10 is the live proof.
