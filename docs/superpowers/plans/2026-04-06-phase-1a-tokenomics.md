# Phase 1a: JINN Tokenomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a working JINN token → treasury → bridge → staking distribution flow on Sepolia + Base Sepolia by forking OLAS contracts with minimal modifications.

**Architecture:** Fork OLAS governance (token), tokenomics (Treasury, Dispenser, Tokenomics, Depository), and registries (StakingToken) contracts. Change token name/symbol to JINN. Deploy all contracts on Sepolia (L1) and Base Sepolia (L2) with an end-to-end deployment script. The OLAS contracts have circular constructor dependencies (Treasury↔Tokenomics↔Dispenser) — resolve with two-phase init pattern. Unused features (bonding, registries, developer rewards) are deployed but never called. Client daemon gets testnet config to claim JINN rewards.

**Tech Stack:** Solidity 0.8.25, Hardhat, ethers.js v6, TypeScript, OP Stack canonical bridge (Sepolia ↔ Base Sepolia)

**Spec:** `spec/2026-04-06-phase-1a-design.md`

**OLAS source repos:**
- Token: `github.com/valory-xyz/autonolas-governance` → `contracts/OLAS.sol`
- Tokenomics: `github.com/valory-xyz/autonolas-tokenomics` → `contracts/Tokenomics.sol`, `Treasury.sol`, `Dispenser.sol`, `Depository.sol`
- Registries/Staking: `github.com/valory-xyz/autonolas-registries` → `contracts/staking/StakingBase.sol`, `StakingToken.sol`
- Bridge: `github.com/valory-xyz/autonolas-tokenomics` → `contracts/staking/OptimismDepositProcessorL1.sol`, `OptimismTargetDispenserL2.sol`
- Gauge: `github.com/valory-xyz/autonolas-governance` → `contracts/VoteWeighting.sol`

---

## File Structure

### New directories and files

```
contracts/
  vendor/                          # Forked OLAS contracts (git-tracked, minimal changes)
    governance/                    # From autonolas-governance
      OLAS.sol → JINN.sol          # Renamed, name/symbol changed
      veOLAS.sol                   # Unchanged (Phase 1b, but deployed now as dep)
      VoteWeighting.sol            # Unchanged (required by Dispenser)
    tokenomics/                    # From autonolas-tokenomics
      Tokenomics.sol               # Unchanged or minimal registry stubs
      TokenomicsConstants.sol      # Unchanged
      Treasury.sol                 # Unchanged
      Dispenser.sol                # Unchanged
      Depository.sol               # Unchanged
      GenericBondCalculator.sol    # Unchanged (required by Depository)
      interfaces/                  # All OLAS interfaces needed by above
    registries/                    # From autonolas-registries
      staking/
        StakingBase.sol            # Unchanged
        StakingToken.sol           # Unchanged
        StakingFactory.sol         # Unchanged
        StakingProxy.sol           # Unchanged
    bridge/                        # From autonolas-tokenomics
      OptimismDepositProcessorL1.sol   # Unchanged
      DefaultDepositProcessorL1.sol    # Base class
      OptimismTargetDispenserL2.sol    # Unchanged
      DefaultTargetDispenserL2.sol     # Base class
  src/
    phase1/                        # Jinn-specific Phase 1 contracts
      JinnActivityChecker.sol      # Fresh activity checker for testnet (reuses JinnRouter pattern)
  scripts/
    deploy-phase1a.ts              # Full-stack deployment script
    lib/
      deploy-helpers.ts            # Shared deployment utilities
  test/
    phase1/
      JINN.test.ts                 # Token tests
      Treasury.test.ts             # Epoch emission tests
      StakingDistribution.test.ts  # End-to-end staking + distribution test
      DeployPhase1a.test.ts        # Full stack deployment integration test

client/
  src/
    config.ts                      # Add testnet network support
    earning/
      contracts.ts                 # Add testnet chain config + JINN addresses
      jinn-rewards.ts              # NEW: JINN reward claiming
```

---

## Task 1: Vendor OLAS Governance Contracts

**Files:**
- Create: `contracts/vendor/governance/JINN.sol`
- Create: `contracts/vendor/governance/veOLAS.sol`
- Create: `contracts/vendor/governance/VoteWeighting.sol`
- Create: `contracts/vendor/governance/interfaces/` (as needed)

- [ ] **Step 1: Clone autonolas-governance and identify required files**

```bash
cd /tmp
git clone --depth 1 https://github.com/valory-xyz/autonolas-governance.git
ls autonolas-governance/contracts/
```

Identify the exact files and their import chains. We need:
- `OLAS.sol` (token)
- `veOLAS.sol` (vote-escrow, Phase 1b but Dispenser may reference it)
- `VoteWeighting.sol` (required by Dispenser constructor)
- All interfaces these import

- [ ] **Step 2: Copy OLAS.sol and rename to JINN.sol**

Copy `OLAS.sol` to `contracts/vendor/governance/JINN.sol`. Make these minimal changes:
1. Rename the contract from `OLAS` to `JINN`
2. Change the token name string from `"Autonolas"` to `"Jinn"`
3. Change the symbol string from `"OLAS"` to `"JINN"`
4. Update any internal references from `OLAS` to `JINN`

Do NOT change any logic, access control, or minting behavior.

- [ ] **Step 3: Copy veOLAS.sol unchanged**

Copy `veOLAS.sol` and its dependencies to `contracts/vendor/governance/`. Preserve all import paths — update only the relative paths to match the new directory structure.

- [ ] **Step 4: Copy VoteWeighting.sol unchanged**

Copy `VoteWeighting.sol` and its dependencies. Same approach — preserve logic, update import paths only.

- [ ] **Step 5: Copy all required interfaces**

Copy every interface file imported by the above contracts into `contracts/vendor/governance/interfaces/`. Fix import paths.

- [ ] **Step 6: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: Compiles with zero errors. If import path issues, fix them. If Solidity version mismatches with existing contracts, add a separate compiler version in hardhat.config.ts.

- [ ] **Step 7: Commit**

```bash
git add contracts/vendor/governance/
git commit -m "chore: vendor OLAS governance contracts (JINN token, veOLAS, VoteWeighting)"
```

---

## Task 2: Vendor OLAS Tokenomics Contracts

**Files:**
- Create: `contracts/vendor/tokenomics/Tokenomics.sol`
- Create: `contracts/vendor/tokenomics/TokenomicsConstants.sol`
- Create: `contracts/vendor/tokenomics/Treasury.sol`
- Create: `contracts/vendor/tokenomics/Dispenser.sol`
- Create: `contracts/vendor/tokenomics/Depository.sol`
- Create: `contracts/vendor/tokenomics/GenericBondCalculator.sol`
- Create: `contracts/vendor/tokenomics/interfaces/`

- [ ] **Step 1: Clone autonolas-tokenomics and identify required files**

```bash
cd /tmp
git clone --depth 1 https://github.com/valory-xyz/autonolas-tokenomics.git
ls autonolas-tokenomics/contracts/
```

Map the full import graph for: Tokenomics.sol, Treasury.sol, Dispenser.sol, Depository.sol. Include TokenomicsConstants.sol (inherited by Tokenomics) and GenericBondCalculator.sol (required by Depository).

- [ ] **Step 2: Copy core tokenomics contracts**

Copy these files to `contracts/vendor/tokenomics/`:
- `Tokenomics.sol`
- `TokenomicsConstants.sol`
- `Treasury.sol`
- `Dispenser.sol`
- `Depository.sol`
- `GenericBondCalculator.sol`

Do NOT modify any logic. Only update import paths to match the vendor directory structure.

- [ ] **Step 3: Copy all required interfaces**

These contracts import many interfaces (IToken, ITreasury, ITokenomics, IDispenser, IServiceRegistry, IVotingEscrow, etc.). Copy every interface into `contracts/vendor/tokenomics/interfaces/`. Fix import paths.

- [ ] **Step 4: Resolve cross-package imports**

The tokenomics contracts import from governance (e.g., IOLAS, IVotingEscrow). Ensure these imports resolve correctly — either copy the interfaces into the tokenomics interfaces directory, or use relative imports to `../governance/interfaces/`.

- [ ] **Step 5: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: Compiles with zero errors. The tokenomics contracts are large — expect many warnings about contract size. That's fine for testnet.

- [ ] **Step 6: Commit**

```bash
git add contracts/vendor/tokenomics/
git commit -m "chore: vendor OLAS tokenomics contracts (Treasury, Dispenser, Tokenomics, Depository)"
```

---

## Task 3: Vendor OLAS Staking and Bridge Contracts

**Files:**
- Create: `contracts/vendor/registries/staking/StakingBase.sol`
- Create: `contracts/vendor/registries/staking/StakingToken.sol`
- Create: `contracts/vendor/registries/staking/StakingFactory.sol`
- Create: `contracts/vendor/registries/staking/StakingProxy.sol`
- Create: `contracts/vendor/bridge/OptimismDepositProcessorL1.sol`
- Create: `contracts/vendor/bridge/DefaultDepositProcessorL1.sol`
- Create: `contracts/vendor/bridge/OptimismTargetDispenserL2.sol`
- Create: `contracts/vendor/bridge/DefaultTargetDispenserL2.sol`

- [ ] **Step 1: Clone autonolas-registries and identify staking files**

```bash
cd /tmp
git clone --depth 1 https://github.com/valory-xyz/autonolas-registries.git
ls autonolas-registries/contracts/staking/
```

We need: StakingBase.sol, StakingToken.sol, StakingFactory.sol, StakingProxy.sol, and their interfaces.

- [ ] **Step 2: Copy staking contracts**

Copy the staking contracts to `contracts/vendor/registries/staking/`. Preserve logic, update import paths.

Key fact: `StakingToken.initialize()` takes `_stakingToken` as a parameter — the token address is NOT hardcoded. This means we can pass JINN token address at deploy time with zero code changes.

- [ ] **Step 3: Copy bridge contracts from autonolas-tokenomics**

The bridge contracts live in `autonolas-tokenomics/contracts/staking/`:
- `OptimismDepositProcessorL1.sol`
- `DefaultDepositProcessorL1.sol`
- `OptimismTargetDispenserL2.sol`
- `DefaultTargetDispenserL2.sol`

Copy to `contracts/vendor/bridge/`. Update import paths.

- [ ] **Step 4: Copy all required interfaces for staking and bridge**

These reference IService, IActivityChecker, IStakingFactory, etc. Copy all interfaces and fix paths.

- [ ] **Step 5: Verify compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: Compiles with zero errors.

- [ ] **Step 6: Commit**

```bash
git add contracts/vendor/registries/ contracts/vendor/bridge/
git commit -m "chore: vendor OLAS staking and bridge contracts"
```

---

## Task 4: Update Hardhat Configuration

**Files:**
- Modify: `contracts/hardhat.config.ts`
- Modify: `contracts/package.json`
- Create: `contracts/.env.example`

- [ ] **Step 1: Add Sepolia and Base Sepolia networks to hardhat.config.ts**

Add to the networks section:

```typescript
sepolia: {
  url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 11155111,
},
baseSepolia: {
  url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 84532,
},
```

- [ ] **Step 2: Add multiple Solidity compiler versions if needed**

The OLAS contracts may use a different pragma than 0.8.25. Check the vendored files and add any required compiler versions to the `solidity` config. Use the `overrides` field if different contracts need different versions.

- [ ] **Step 3: Add vendor paths to Hardhat sources**

Ensure Hardhat compiles the `vendor/` directory. The default `sources: "./src"` won't include vendor. Update to:

```typescript
paths: {
  sources: "./src",
  tests: "./test",
  cache: "./cache",
  artifacts: "./artifacts",
},
```

If Hardhat doesn't support multiple source directories, either:
- Move vendor imports to use `src/vendor/` path, or
- Add a `paths.sources` override, or
- Use Hardhat's `dependencyCompiler` plugin

The simplest approach: move vendor into `src/vendor/` so the existing source path covers it.

- [ ] **Step 4: Create .env.example**

```
# Deployer
DEPLOYER_PRIVATE_KEY=

# L1 (Sepolia)
SEPOLIA_RPC_URL=https://rpc.sepolia.org

# L2 (Base Sepolia)
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# Etherscan verification
ETHERSCAN_API_KEY=
BASESCAN_API_KEY=
```

- [ ] **Step 5: Verify full compilation**

```bash
cd contracts
npx hardhat compile
```

Expected: All contracts compile — both existing Jinn contracts and vendored OLAS contracts.

- [ ] **Step 6: Commit**

```bash
git add contracts/hardhat.config.ts contracts/package.json contracts/.env.example
git commit -m "chore: add Sepolia/Base Sepolia networks and vendor compilation support"
```

---

## Task 5: Write JINN Token Tests

**Files:**
- Create: `contracts/test/phase1/JINN.test.ts`

- [ ] **Step 1: Write the JINN token test**

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("JINN Token", function () {
  async function deployJinnFixture() {
    const [owner, minter, user] = await ethers.getSigners();
    const JINN = await ethers.getContractFactory("JINN");
    const jinn = await JINN.deploy();
    return { jinn, owner, minter, user };
  }

  describe("Deployment", function () {
    it("should have correct name and symbol", async function () {
      const { jinn } = await loadFixture(deployJinnFixture);
      expect(await jinn.name()).to.equal("Jinn");
      expect(await jinn.symbol()).to.equal("JINN");
    });

    it("should set deployer as owner", async function () {
      const { jinn, owner } = await loadFixture(deployJinnFixture);
      expect(await jinn.owner()).to.equal(owner.address);
    });

    it("should have 18 decimals", async function () {
      const { jinn } = await loadFixture(deployJinnFixture);
      expect(await jinn.decimals()).to.equal(18);
    });
  });

  describe("Minting", function () {
    it("should allow minter to mint tokens", async function () {
      const { jinn, owner, minter, user } = await loadFixture(deployJinnFixture);
      // Owner changes minter
      await jinn.connect(owner).changeMinter(minter.address);
      // Minter mints
      const amount = ethers.parseEther("1000");
      await jinn.connect(minter).mint(user.address, amount);
      expect(await jinn.balanceOf(user.address)).to.equal(amount);
    });

    it("should reject mint from non-minter", async function () {
      const { jinn, user } = await loadFixture(deployJinnFixture);
      const amount = ethers.parseEther("1000");
      await expect(
        jinn.connect(user).mint(user.address, amount)
      ).to.be.reverted;
    });
  });

  describe("Ownership", function () {
    it("should allow owner to change minter", async function () {
      const { jinn, owner, minter } = await loadFixture(deployJinnFixture);
      await jinn.connect(owner).changeMinter(minter.address);
      expect(await jinn.minter()).to.equal(minter.address);
    });

    it("should allow owner to transfer ownership", async function () {
      const { jinn, owner, user } = await loadFixture(deployJinnFixture);
      await jinn.connect(owner).changeOwner(user.address);
      expect(await jinn.owner()).to.equal(user.address);
    });
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd contracts
npx hardhat test test/phase1/JINN.test.ts
```

Expected: All 5 tests pass. If the OLAS contract's function names differ (e.g., `changeMinter` vs `setMinter`), adjust the test to match the actual ABI. Read the vendored JINN.sol to confirm function names.

- [ ] **Step 3: Commit**

```bash
git add contracts/test/phase1/
git commit -m "test: add JINN token tests"
```

---

## Task 6: Analyze OLAS Contract Dependencies and Write Deployment Helpers

This is the critical research + code task. The OLAS contracts have circular constructor dependencies. This task determines the deployment order.

**Files:**
- Create: `contracts/scripts/lib/deploy-helpers.ts`

- [ ] **Step 1: Map the dependency graph by reading vendored contracts**

Read every constructor and `initialize` function in the vendored contracts. Document:

1. **JINN token**: No constructor params. Deploy first.
2. **Tokenomics**: Empty constructor, initialized via `initializeTokenomics(olas, treasury, depository, dispenser, ve, epochLen, componentRegistry, agentRegistry, serviceRegistry, donatorBlacklist)`. Two-phase.
3. **Treasury**: Constructor `(olas, tokenomics, depository, dispenser)`. All must be non-zero.
4. **Dispenser**: Constructor `(olas, tokenomics, treasury, voteWeighting, retainer, maxNumClaimingEpochs, maxNumStakingTargets, defaultMinStakingWeight, defaultMaxStakingIncentive)`.
5. **Depository**: Constructor `(olas, tokenomics, treasury, bondCalculator)`.
6. **VoteWeighting**: Check constructor params (likely `veOLAS` address).
7. **veOLAS**: Constructor `(token, name, symbol)`.
8. **GenericBondCalculator**: Check constructor params.

The circular dependency: Treasury needs Tokenomics address, but Tokenomics.initializeTokenomics needs Treasury address. OLAS resolves this because Tokenomics uses two-phase init — deploy Tokenomics first (empty constructor), then deploy Treasury with Tokenomics address, then call `initializeTokenomics` with Treasury address.

Investigate whether Treasury/Dispenser/Depository also support two-phase init or if they require all addresses at construction time. If they require addresses at construction, we need to determine the exact deployment order that satisfies all dependencies.

Likely deployment order:
1. JINN token
2. veOLAS (needs JINN address)
3. VoteWeighting (needs veOLAS address)
4. Tokenomics (empty constructor)
5. GenericBondCalculator (check deps)
6. Treasury (needs JINN, Tokenomics — Depository and Dispenser addresses TBD)
7. Depository (needs JINN, Tokenomics, Treasury)
8. Dispenser (needs JINN, Tokenomics, Treasury, VoteWeighting)
9. Call `Tokenomics.initializeTokenomics(...)` with all addresses
10. Call `Treasury.changeManagers(...)` or similar to update Depository/Dispenser if they were zero at construction

**Read the actual contract code to determine the exact order.** The OLAS contracts may have `changeManagers()` or `changeDispenser()` admin functions that allow setting addresses post-deployment.

- [ ] **Step 2: Write deploy-helpers.ts with the deployment sequence**

```typescript
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

export interface Phase1aDeployment {
  jinn: Contract;
  veJINN: Contract;
  voteWeighting: Contract;
  tokenomics: Contract;
  treasury: Contract;
  dispenser: Contract;
  depository: Contract;
  bondCalculator: Contract;
  // L2 contracts (Base Sepolia)
  stakingFactory?: Contract;
  stakingToken?: Contract;
  activityChecker?: Contract;
  // Bridge
  depositProcessor?: Contract;
  targetDispenser?: Contract;
}

export interface DeployConfig {
  deployer: Signer;
  epochLength: number;       // seconds (e.g., 604800 for 1 week)
  // Registry addresses — zero-address for Phase 1a
  componentRegistry: string;
  agentRegistry: string;
  serviceRegistry: string;
  donatorBlacklist: string;
  // Dispenser config
  maxNumClaimingEpochs: number;
  maxNumStakingTargets: number;
  defaultMinStakingWeight: bigint;
  defaultMaxStakingIncentive: bigint;
}

/**
 * Deploy the full Phase 1a L1 (Sepolia) contract stack.
 * 
 * Deployment order resolves circular dependencies:
 * 1. JINN token (no deps)
 * 2. veJINN (needs JINN)
 * 3. VoteWeighting (needs veJINN)
 * 4. Tokenomics (empty constructor, two-phase init)
 * 5. GenericBondCalculator (check deps)
 * 6. Treasury (needs JINN, Tokenomics — may need post-deploy manager update)
 * 7. Depository (needs JINN, Tokenomics, Treasury)
 * 8. Dispenser (needs JINN, Tokenomics, Treasury, VoteWeighting)
 * 9. Tokenomics.initializeTokenomics(...) with all addresses
 * 10. Any post-deploy manager updates on Treasury
 * 11. Set Treasury as JINN minter
 * 
 * IMPORTANT: Steps 5-10 must be verified against actual OLAS contract code.
 * The constructor signatures and post-deploy configuration calls must match
 * the vendored contracts exactly. Read the contracts before implementing.
 */
export async function deployL1Stack(config: DeployConfig): Promise<Phase1aDeployment> {
  const deployer = config.deployer;

  // 1. Deploy JINN token
  const JINNFactory = await ethers.getContractFactory("JINN");
  const jinn = await JINNFactory.connect(deployer).deploy();
  await jinn.waitForDeployment();
  console.log(`JINN token deployed at: ${await jinn.getAddress()}`);

  // 2. Deploy veJINN
  const veJINNFactory = await ethers.getContractFactory("veOLAS");
  const veJINN = await veJINNFactory.connect(deployer).deploy(
    await jinn.getAddress(),
    "Voting Escrow JINN",
    "veJINN"
  );
  await veJINN.waitForDeployment();
  console.log(`veJINN deployed at: ${await veJINN.getAddress()}`);

  // 3. Deploy VoteWeighting
  const VoteWeightingFactory = await ethers.getContractFactory("VoteWeighting");
  // CHECK: VoteWeighting constructor params — likely (veOLAS address)
  const voteWeighting = await VoteWeightingFactory.connect(deployer).deploy(
    await veJINN.getAddress()
  );
  await voteWeighting.waitForDeployment();
  console.log(`VoteWeighting deployed at: ${await voteWeighting.getAddress()}`);

  // 4. Deploy Tokenomics (empty constructor, two-phase init)
  const TokenomicsFactory = await ethers.getContractFactory("Tokenomics");
  const tokenomics = await TokenomicsFactory.connect(deployer).deploy();
  await tokenomics.waitForDeployment();
  console.log(`Tokenomics deployed at: ${await tokenomics.getAddress()}`);

  // 5. Deploy GenericBondCalculator
  // CHECK: constructor params
  const BondCalcFactory = await ethers.getContractFactory("GenericBondCalculator");
  const bondCalculator = await BondCalcFactory.connect(deployer).deploy(
    await jinn.getAddress(),
    await tokenomics.getAddress()
  );
  await bondCalculator.waitForDeployment();

  // 6-8: Deploy Treasury, Depository, Dispenser
  // CRITICAL: Read the actual vendored contracts to determine exact constructor
  // signatures and whether Treasury supports post-deploy manager updates.
  // The code below is the EXPECTED pattern — verify against source.
  
  // If Treasury requires all addresses at construction:
  // Deploy a temporary placeholder, or use the two-phase pattern if available.
  // 
  // If Treasury has changeManagers() or similar:
  // Deploy with zero-address for Depository/Dispenser, then update after.

  // --- PLACEHOLDER: Replace with actual deployment after reading contracts ---
  // const treasury = await TreasuryFactory.deploy(jinnAddr, tokenomicsAddr, depositoryAddr, dispenserAddr);
  // const depository = await DepositoryFactory.deploy(jinnAddr, tokenomicsAddr, treasuryAddr, bondCalcAddr);
  // const dispenser = await DispenserFactory.deploy(jinnAddr, tokenomicsAddr, treasuryAddr, voteWeightingAddr, ...);
  // --- END PLACEHOLDER ---

  // 9. Initialize Tokenomics with all addresses
  // await tokenomics.initializeTokenomics(
  //   jinnAddr, treasuryAddr, depositoryAddr, dispenserAddr, veJINNAddr,
  //   config.epochLength,
  //   config.componentRegistry, config.agentRegistry, config.serviceRegistry,
  //   config.donatorBlacklist
  // );

  // 10. Set Treasury as JINN minter
  // await jinn.changeMinter(treasuryAddr);

  // Return deployment - fill in actual contracts after implementation
  return {
    jinn,
    veJINN,
    voteWeighting,
    tokenomics,
    treasury: null as any, // PLACEHOLDER
    dispenser: null as any, // PLACEHOLDER
    depository: null as any, // PLACEHOLDER
    bondCalculator,
  };
}
```

**CRITICAL NOTE:** The placeholder sections (steps 6-10) MUST be filled in after reading the actual vendored contract constructors. The OLAS contracts have specific initialization patterns that vary by contract. Do not guess — read the code.

- [ ] **Step 3: Commit**

```bash
git add contracts/scripts/lib/
git commit -m "feat: add Phase 1a deployment helpers (L1 stack)"
```

---

## Task 7: Write Full Deployment Script

**Files:**
- Create: `contracts/scripts/deploy-phase1a.ts`

- [ ] **Step 1: Write the deployment script**

This script deploys the complete Phase 1a stack across both chains. It uses the helpers from Task 6.

```typescript
import { ethers, network } from "hardhat";
import { deployL1Stack, DeployConfig } from "./lib/deploy-helpers";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network: ${network.name} (chainId: ${network.config.chainId})`);

  if (network.name !== "sepolia" && network.name !== "hardhat") {
    throw new Error("Phase 1a deployment targets Sepolia. Use --network sepolia or hardhat for local testing.");
  }

  const config: DeployConfig = {
    deployer,
    epochLength: 604800, // 1 week
    // Zero-address for unused registries
    componentRegistry: ethers.ZeroAddress,
    agentRegistry: ethers.ZeroAddress,
    serviceRegistry: ethers.ZeroAddress,
    donatorBlacklist: ethers.ZeroAddress,
    // Dispenser config
    maxNumClaimingEpochs: 10,
    maxNumStakingTargets: 100,
    defaultMinStakingWeight: 100n,
    defaultMaxStakingIncentive: ethers.parseEther("1000000"),
  };

  console.log("\n=== Deploying Phase 1a L1 Stack (Sepolia) ===\n");
  const deployment = await deployL1Stack(config);

  // Output deployment summary
  const summary = {
    network: network.name,
    chainId: network.config.chainId,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      jinn: await deployment.jinn.getAddress(),
      veJINN: await deployment.veJINN.getAddress(),
      voteWeighting: await deployment.voteWeighting.getAddress(),
      tokenomics: await deployment.tokenomics.getAddress(),
      treasury: await deployment.treasury.getAddress(),
      dispenser: await deployment.dispenser.getAddress(),
      depository: await deployment.depository.getAddress(),
      bondCalculator: await deployment.bondCalculator.getAddress(),
    },
    config: {
      epochLength: config.epochLength,
      maxNumClaimingEpochs: config.maxNumClaimingEpochs,
      maxNumStakingTargets: config.maxNumStakingTargets,
    },
  };

  console.log("\n=== Deployment Summary ===");
  console.log(JSON.stringify(summary, null, 2));

  // Write deployment file
  const fs = await import("fs");
  fs.writeFileSync(
    `deployment-phase1a-${network.name}.json`,
    JSON.stringify(summary, null, 2)
  );
  console.log(`\nDeployment saved to deployment-phase1a-${network.name}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Test deployment locally**

```bash
cd contracts
npx hardhat run scripts/deploy-phase1a.ts --network hardhat
```

Expected: Full L1 stack deploys on local Hardhat network. Deployment JSON written to disk.

- [ ] **Step 3: Commit**

```bash
git add contracts/scripts/deploy-phase1a.ts
git commit -m "feat: add Phase 1a full-stack deployment script"
```

---

## Task 8: Write Integration Test — Epoch Emission Flow

**Files:**
- Create: `contracts/test/phase1/EpochEmission.test.ts`

- [ ] **Step 1: Write the end-to-end epoch emission test**

This test deploys the full L1 stack and verifies that an epoch produces JINN emissions.

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployL1Stack, DeployConfig } from "../scripts/lib/deploy-helpers";

describe("Phase 1a: Epoch Emission Flow", function () {
  async function deployFullStackFixture() {
    const [deployer, operator] = await ethers.getSigners();

    const config: DeployConfig = {
      deployer,
      epochLength: 86400, // 1 day for fast testing
      componentRegistry: ethers.ZeroAddress,
      agentRegistry: ethers.ZeroAddress,
      serviceRegistry: ethers.ZeroAddress,
      donatorBlacklist: ethers.ZeroAddress,
      maxNumClaimingEpochs: 10,
      maxNumStakingTargets: 100,
      defaultMinStakingWeight: 100n,
      defaultMaxStakingIncentive: ethers.parseEther("1000000"),
    };

    const deployment = await deployL1Stack(config);
    return { deployment, deployer, operator, config };
  }

  it("should deploy all contracts with correct addresses", async function () {
    const { deployment } = await loadFixture(deployFullStackFixture);

    expect(await deployment.jinn.getAddress()).to.not.equal(ethers.ZeroAddress);
    expect(await deployment.treasury.getAddress()).to.not.equal(ethers.ZeroAddress);
    expect(await deployment.tokenomics.getAddress()).to.not.equal(ethers.ZeroAddress);
    expect(await deployment.dispenser.getAddress()).to.not.equal(ethers.ZeroAddress);
  });

  it("should have Treasury as JINN minter", async function () {
    const { deployment } = await loadFixture(deployFullStackFixture);
    const treasuryAddr = await deployment.treasury.getAddress();
    expect(await deployment.jinn.minter()).to.equal(treasuryAddr);
  });

  it("should advance epoch after epoch length passes", async function () {
    const { deployment, config } = await loadFixture(deployFullStackFixture);

    // Read initial epoch
    const initialEpoch = await deployment.tokenomics.epochCounter();

    // Advance time past epoch length
    await time.increase(config.epochLength + 1);

    // Trigger checkpoint
    // NOTE: This may revert if registries are needed. If so, this test
    // documents that we need stub contracts. Adjust accordingly.
    await deployment.tokenomics.checkpoint();

    // Verify epoch advanced
    const newEpoch = await deployment.tokenomics.epochCounter();
    expect(newEpoch).to.equal(initialEpoch + 1n);
  });

  it("should mint JINN during epoch checkpoint", async function () {
    const { deployment, config } = await loadFixture(deployFullStackFixture);

    const treasuryAddr = await deployment.treasury.getAddress();
    const balanceBefore = await deployment.jinn.balanceOf(treasuryAddr);

    // Advance time and checkpoint
    await time.increase(config.epochLength + 1);
    await deployment.tokenomics.checkpoint();

    const balanceAfter = await deployment.jinn.balanceOf(treasuryAddr);
    // Treasury should have received minted JINN
    expect(balanceAfter).to.be.gt(balanceBefore);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd contracts
npx hardhat test test/phase1/EpochEmission.test.ts
```

Expected outcomes:
- **Best case:** All tests pass — OLAS contracts work with zero-address registries.
- **Likely case:** `checkpoint()` reverts due to registry calls. This is the moment we learn exactly what stubs are needed. Read the revert reason, find the failing call in the Tokenomics code, and determine whether a no-op stub or a code change is required.
- **Action on failure:** Document which interfaces need stubs, create minimal stub contracts in `contracts/src/phase1/stubs/`, redeploy, and re-run.

- [ ] **Step 3: Fix any failures and iterate**

If `checkpoint()` fails:
1. Read the revert message
2. Find the line in `Tokenomics.sol` that reverts
3. If it's a registry call, deploy a no-op stub implementing that interface
4. If it's a fundamental requirement, make a targeted change to the vendored contract (document exactly what changed and why)
5. Re-run tests

- [ ] **Step 4: Commit**

```bash
git add contracts/test/phase1/ contracts/src/phase1/
git commit -m "test: add Phase 1a epoch emission integration test"
```

---

## Task 9: Deploy and Test Staking on Base Sepolia (L2)

**Files:**
- Create: `contracts/scripts/deploy-phase1a-l2.ts`
- Create: `contracts/test/phase1/StakingDistribution.test.ts`

- [ ] **Step 1: Write L2 staking deployment script**

This deploys the staking infrastructure on Base Sepolia. The staking contract accepts JINN (bridged) instead of OLAS.

```typescript
import { ethers, network } from "hardhat";

interface L2DeployConfig {
  jinnTokenL2: string;     // Bridged JINN address on Base Sepolia
  serviceRegistry: string; // OLAS service registry on Base Sepolia (if exists) or stub
  activityCheckerAddress?: string; // Existing or deploy new
}

async function main() {
  const [deployer] = await ethers.getSigners();

  if (network.name !== "baseSepolia" && network.name !== "hardhat") {
    throw new Error("L2 deployment targets Base Sepolia");
  }

  // Deploy activity checker (JinnRouter pattern)
  // Reuse existing RestorationActivityChecker or deploy JinnRouter
  const ActivityCheckerFactory = await ethers.getContractFactory("RestorationActivityChecker");
  const livenessRatio = 230481481481481n; // Same as JinnRouter V3
  const activityChecker = await ActivityCheckerFactory.connect(deployer).deploy(livenessRatio);
  await activityChecker.waitForDeployment();
  console.log(`Activity Checker: ${await activityChecker.getAddress()}`);

  // Deploy StakingToken via StakingFactory
  // OR deploy StakingToken directly for testnet simplicity
  //
  // StakingToken.initialize() params:
  // - StakingParams struct (see OLAS StakingBase)
  // - serviceRegistryTokenUtility address
  // - stakingToken address (JINN on L2)
  //
  // For testnet: deploy directly, not via factory
  // READ the vendored StakingToken.sol to confirm initialize() signature

  console.log("\n=== L2 Deployment Complete ===");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Write local staking distribution test**

Test that staking with JINN works on a local Hardhat fork:

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("Phase 1a: L2 Staking Distribution", function () {
  async function deployStakingFixture() {
    const [deployer, operator] = await ethers.getSigners();

    // Deploy JINN token locally (simulating bridged JINN on L2)
    const JINNFactory = await ethers.getContractFactory("JINN");
    const jinn = await JINNFactory.deploy();

    // Deploy activity checker
    const ActivityCheckerFactory = await ethers.getContractFactory("RestorationActivityChecker");
    const activityChecker = await ActivityCheckerFactory.deploy(230481481481481n);

    // Deploy staking contract with JINN as staking token
    // FILL IN: actual StakingToken deployment after reading vendored contract
    // const stakingToken = await StakingTokenFactory.deploy();
    // await stakingToken.initialize(stakingParams, serviceRegistryTokenUtility, jinnAddr);

    return { jinn, activityChecker, deployer, operator };
  }

  it("should deploy activity checker with correct liveness ratio", async function () {
    const { activityChecker } = await loadFixture(deployStakingFixture);
    expect(await activityChecker.livenessRatio()).to.equal(230481481481481n);
  });

  it("should record activity and pass liveness check", async function () {
    const { activityChecker, operator } = await loadFixture(deployStakingFixture);

    // Record some activity
    await activityChecker.recordActivity(operator.address, 0); // CREATE
    await activityChecker.recordActivity(operator.address, 1); // DELIVER

    // Verify activity count
    expect(await activityChecker.activityCounts(operator.address)).to.equal(2n);
  });

  // Additional tests for staking + claiming flow to be added
  // after StakingToken deployment is implemented
});
```

- [ ] **Step 3: Run tests**

```bash
cd contracts
npx hardhat test test/phase1/StakingDistribution.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add contracts/scripts/deploy-phase1a-l2.ts contracts/test/phase1/StakingDistribution.test.ts
git commit -m "feat: add Phase 1a L2 staking deployment and tests"
```

---

## Task 10: Write Bridge Deployment (L1 ↔ L2)

**Files:**
- Modify: `contracts/scripts/deploy-phase1a.ts` (add bridge deployment)
- Create: `contracts/test/phase1/Bridge.test.ts`

- [ ] **Step 1: Research OP Stack bridge addresses on Sepolia**

Find the Sepolia addresses for:
- `L1StandardBridgeProxy` (Sepolia)
- `L1CrossDomainMessengerProxy` (Sepolia)
- `L2CrossDomainMessengerProxy` (Base Sepolia)

These are infrastructure contracts deployed by the OP Stack. They're the same for all tokens bridging between Sepolia and Base Sepolia.

Search: `https://docs.base.org/docs/base-contracts` or `https://docs.optimism.io/chain/addresses`

- [ ] **Step 2: Add bridge deployment to deploy-phase1a.ts**

After the L1 stack is deployed, deploy the bridge contracts:

```typescript
// Deploy OptimismDepositProcessorL1 on Sepolia
// Constructor: (olas, l1Dispenser, l1TokenRelayer, l1MessageRelayer, l2TargetChainId, olasL2)
const DepositProcessorFactory = await ethers.getContractFactory("OptimismDepositProcessorL1");
const depositProcessor = await DepositProcessorFactory.deploy(
  jinnAddress,           // JINN token on L1
  dispenserAddress,       // Dispenser on L1
  L1_STANDARD_BRIDGE,    // OP Stack L1StandardBridgeProxy on Sepolia
  L1_CROSS_DOMAIN_MSG,   // OP Stack L1CrossDomainMessengerProxy on Sepolia
  84532,                  // Base Sepolia chain ID
  jinnL2Address           // JINN (bridged) on Base Sepolia
);
```

The L2 side (OptimismTargetDispenserL2) is deployed on Base Sepolia:

```typescript
// Deploy on Base Sepolia
// Constructor: (olas, stakingFactory, l2MessageRelayer, l1DepositProcessor, l1SourceChainId)
const TargetDispenserFactory = await ethers.getContractFactory("OptimismTargetDispenserL2");
const targetDispenser = await TargetDispenserFactory.deploy(
  jinnL2Address,          // Bridged JINN on Base Sepolia
  stakingFactoryAddress,  // StakingFactory on Base Sepolia
  L2_CROSS_DOMAIN_MSG,    // OP Stack L2CrossDomainMessengerProxy on Base Sepolia
  depositProcessorAddress, // L1 DepositProcessor on Sepolia
  11155111                 // Sepolia chain ID
);
```

- [ ] **Step 3: Write bridge integration test (local mock)**

For local testing, mock the cross-domain messenger behavior:

```typescript
describe("Phase 1a: Bridge Configuration", function () {
  it("should deploy DepositProcessor with correct JINN and chain config", async function () {
    // Deploy and verify constructor params are stored correctly
    // Check: olas() returns JINN address
    // Check: l2TargetChainId matches Base Sepolia
  });

  it("should deploy TargetDispenser with correct L1 source config", async function () {
    // Check: l1SourceChainId matches Sepolia
    // Check: l1DepositProcessor matches L1 deployment
  });
});
```

Note: Full bridge testing requires actual cross-chain message passing. This is tested on live Sepolia ↔ Base Sepolia, not locally. Local tests verify configuration only.

**Governance note:** The spec calls for an OpenZeppelin TimelockController with a Safe multisig. On testnet, the deployer wallet acts as governance directly (no Timelock needed for iteration). Add TimelockController deployment when moving toward mainnet — it's standard OpenZeppelin infrastructure and doesn't affect the tokenomics flow.

- [ ] **Step 4: Commit**

```bash
git add contracts/scripts/ contracts/test/phase1/
git commit -m "feat: add OP Stack bridge deployment for Sepolia <-> Base Sepolia"
```

---

## Task 11: Client Testnet Configuration

**Files:**
- Modify: `client/src/earning/contracts.ts`
- Create: `client/src/earning/jinn-rewards.ts`
- Modify: `client/src/config.ts`

- [ ] **Step 1: Add testnet chain config to contracts.ts**

Read `client/src/earning/contracts.ts` to understand the existing `getChainConfig()` pattern. Add a testnet variant:

```typescript
// Add alongside existing 'base' config
export function getChainConfig(network: 'base' | 'base-sepolia') {
  if (network === 'base-sepolia') {
    return {
      // Addresses filled in after deployment
      serviceRegistry: '0x...', // Base Sepolia service registry (if exists)
      stakingContract: '0x...', // Phase 1a staking contract
      olasToken: '0x...',       // Bridged JINN on Base Sepolia
      mechMarketplace: '0x...', // Base Sepolia mech marketplace (if exists)
      // ... other addresses from deployment-phase1a-baseSepolia.json
    };
  }
  // existing base config...
}
```

Note: Actual addresses are filled in after deployment. Use placeholder addresses during development and replace from deployment JSON.

- [ ] **Step 2: Add network config option**

Read `client/src/config.ts`. Add a `network` config key:

```typescript
// In the config schema
network: z.enum(['mainnet', 'testnet']).default('mainnet'),
```

When `network: 'testnet'`, the client uses Base Sepolia RPC and testnet contract addresses.

- [ ] **Step 3: Create jinn-rewards.ts**

```typescript
import { type PublicClient, type WalletClient } from 'viem';

/**
 * Claim JINN rewards from the Phase 1a staking contract on Base Sepolia.
 * Mirrors the OLAS staking claim pattern in earning/bootstrap.ts.
 */
export async function claimJinnRewards(
  publicClient: PublicClient,
  walletClient: WalletClient,
  stakingContractAddress: `0x${string}`,
  serviceId: number
): Promise<{ claimed: boolean; amount: bigint }> {
  // Read available rewards
  // Call staking contract's claim function
  // Return claimed amount
  //
  // IMPLEMENTATION: Follow the same pattern as the existing OLAS
  // staking claim in earning/bootstrap.ts. Read that file first
  // to match the viem client usage patterns.
  throw new Error('TODO: implement after contracts are deployed');
}
```

- [ ] **Step 4: Run existing client tests to verify no regressions**

```bash
cd client
npx vitest run
```

Expected: All 33 existing tests pass. The new config option should have a default that preserves existing behavior.

- [ ] **Step 5: Commit**

```bash
git add client/src/earning/contracts.ts client/src/earning/jinn-rewards.ts client/src/config.ts
git commit -m "feat(client): add testnet config and JINN reward claiming scaffold"
```

---

## Task 12: End-to-End Deployment Validation Script

**Files:**
- Create: `contracts/scripts/validate-phase1a.ts`

- [ ] **Step 1: Write the validation script**

This is the "redeploy and test the whole thing" script — the equivalent of `client/scripts/e2e-validate.ts` but for Phase 1a tokenomics.

```typescript
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployL1Stack, DeployConfig } from "./lib/deploy-helpers";

/**
 * Phase 1a End-to-End Validation
 * 
 * Deploys the complete L1 tokenomics stack on local Hardhat,
 * simulates epoch advancement, and verifies JINN distribution.
 * 
 * Run: npx hardhat run scripts/validate-phase1a.ts
 */
async function main() {
  const [deployer, operator] = await ethers.getSigners();
  console.log("=== Phase 1a E2E Validation ===\n");

  // 1. Deploy full L1 stack
  console.log("Step 1: Deploying L1 stack...");
  const config: DeployConfig = {
    deployer,
    epochLength: 86400, // 1 day for fast validation
    componentRegistry: ethers.ZeroAddress,
    agentRegistry: ethers.ZeroAddress,
    serviceRegistry: ethers.ZeroAddress,
    donatorBlacklist: ethers.ZeroAddress,
    maxNumClaimingEpochs: 10,
    maxNumStakingTargets: 100,
    defaultMinStakingWeight: 100n,
    defaultMaxStakingIncentive: ethers.parseEther("1000000"),
  };
  const deployment = await deployL1Stack(config);
  console.log("  ✓ L1 stack deployed\n");

  // 2. Verify JINN token
  console.log("Step 2: Verifying JINN token...");
  const name = await deployment.jinn.name();
  const symbol = await deployment.jinn.symbol();
  console.log(`  Token: ${name} (${symbol})`);
  console.assert(name === "Jinn", "Token name mismatch");
  console.assert(symbol === "JINN", "Token symbol mismatch");
  console.log("  ✓ Token verified\n");

  // 3. Verify Treasury is minter
  console.log("Step 3: Verifying Treasury is JINN minter...");
  const treasuryAddr = await deployment.treasury.getAddress();
  const minter = await deployment.jinn.minter();
  console.assert(minter === treasuryAddr, "Treasury is not minter");
  console.log("  ✓ Treasury is minter\n");

  // 4. Advance time and trigger epoch
  console.log("Step 4: Advancing epoch...");
  const epochBefore = await deployment.tokenomics.epochCounter();
  console.log(`  Current epoch: ${epochBefore}`);
  
  await time.increase(config.epochLength + 1);
  await deployment.tokenomics.checkpoint();
  
  const epochAfter = await deployment.tokenomics.epochCounter();
  console.log(`  New epoch: ${epochAfter}`);
  console.assert(epochAfter > epochBefore, "Epoch did not advance");
  console.log("  ✓ Epoch advanced\n");

  // 5. Check JINN minted
  console.log("Step 5: Checking JINN emissions...");
  const treasuryBalance = await deployment.jinn.balanceOf(treasuryAddr);
  console.log(`  Treasury JINN balance: ${ethers.formatEther(treasuryBalance)}`);
  console.assert(treasuryBalance > 0n, "No JINN minted");
  console.log("  ✓ JINN emitted\n");

  console.log("=== Phase 1a E2E Validation PASSED ===");
}

main().catch((error) => {
  console.error("=== VALIDATION FAILED ===");
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script**

In `contracts/package.json`, add:

```json
"scripts": {
  "validate:phase1a": "hardhat run scripts/validate-phase1a.ts"
}
```

- [ ] **Step 3: Run validation**

```bash
cd contracts
npm run validate:phase1a
```

Expected: All steps pass. If any step fails, debug and fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add contracts/scripts/validate-phase1a.ts contracts/package.json
git commit -m "feat: add Phase 1a end-to-end validation script"
```

---

## Task 13: Deploy to Sepolia + Base Sepolia

This task is executed manually (not in local tests) once all local validation passes.

**Files:**
- Create: `contracts/deployment-phase1a-sepolia.json` (generated)
- Create: `contracts/deployment-phase1a-baseSepolia.json` (generated)

- [ ] **Step 1: Get testnet ETH**

Fund the deployer wallet with Sepolia ETH and Base Sepolia ETH:
- Sepolia faucet: https://sepoliafaucet.com or https://faucets.chain.link
- Base Sepolia: bridge from Sepolia or use Base Sepolia faucet

- [ ] **Step 2: Deploy L1 stack to Sepolia**

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=<key> npx hardhat run scripts/deploy-phase1a.ts --network sepolia
```

Record all deployed addresses from the output JSON.

- [ ] **Step 3: Bridge JINN to Base Sepolia**

Use the OP Stack StandardBridge to bridge test JINN from Sepolia to Base Sepolia. This may require:
- Approving the bridge to spend JINN
- Calling the bridge's `depositERC20()` function
- Waiting for the L1→L2 message to be relayed (~20 min on testnet)

- [ ] **Step 4: Deploy L2 stack to Base Sepolia**

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=<key> npx hardhat run scripts/deploy-phase1a-l2.ts --network baseSepolia
```

- [ ] **Step 5: Update client config with deployed addresses**

Fill in the actual addresses in `client/src/earning/contracts.ts` from the deployment JSONs.

- [ ] **Step 6: Commit deployment records**

```bash
git add contracts/deployment-phase1a-*.json client/src/earning/contracts.ts
git commit -m "chore: record Phase 1a testnet deployment addresses"
```

---

## Summary

| Task | Description | Dependencies |
|------|-------------|--------------|
| 1 | Vendor OLAS governance contracts (JINN token, veOLAS, VoteWeighting) | None |
| 2 | Vendor OLAS tokenomics contracts (Treasury, Dispenser, Tokenomics, Depository) | None |
| 3 | Vendor OLAS staking and bridge contracts | None |
| 4 | Update Hardhat config (networks, compilation) | Tasks 1-3 |
| 5 | Write JINN token tests | Tasks 1, 4 |
| 6 | Analyze dependencies and write deployment helpers | Tasks 1-4 |
| 7 | Write full deployment script | Task 6 |
| 8 | Write epoch emission integration test | Tasks 6-7 |
| 9 | Deploy and test staking on L2 | Tasks 4, 8 |
| 10 | Write bridge deployment | Tasks 7, 9 |
| 11 | Client testnet configuration | Task 9 |
| 12 | End-to-end validation script | Tasks 7-10 |
| 13 | Deploy to live testnets | Task 12 |

Tasks 1-3 can be parallelized. Tasks 5-8 are sequential (each builds on the last). Task 13 is the final manual deployment.
