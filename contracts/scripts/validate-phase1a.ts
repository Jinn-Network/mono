/**
 * validate-phase1a.ts — End-to-end validation of the Phase 1a stack.
 *
 * Deploys the entire L1 + L2 stack on local Hardhat, simulates one epoch,
 * and verifies JINN distribution accounting works end-to-end.
 *
 * Usage:
 *   npx hardhat run scripts/validate-phase1a.ts
 */

import { ethers } from "hardhat";
import { deployL1Stack, DEFAULT_DEPLOY_CONFIG } from "./lib/deploy-helpers";
import { deployL2Stack } from "./deploy-phase1a-l2";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(step: string, detail: string) {
  console.log(`${step.padEnd(35)} ✓ ${detail}`);
}

function fail(step: string, err: unknown): never {
  console.error(`${step.padEnd(35)} ✗ FAILED`);
  console.error(err);
  process.exit(1);
}

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  console.log("=== Phase 1a E2E Validation ===\n");

  // -------------------------------------------------------------------------
  // Step 1: Deploy L1 stack
  // -------------------------------------------------------------------------
  let l1: Awaited<ReturnType<typeof deployL1Stack>>;
  try {
    process.stdout.write("Step 1: Deploying L1 stack...     ");
    l1 = await deployL1Stack(deployer, DEFAULT_DEPLOY_CONFIG);
    const contractCount = Object.keys(l1).length;
    pass("", `(${contractCount} contracts)`);
  } catch (e) {
    fail("Step 1: Deploying L1 stack", e);
  }

  // -------------------------------------------------------------------------
  // Step 2: Deploy L2 staking stack
  // -------------------------------------------------------------------------
  let l2: Awaited<ReturnType<typeof deployL2Stack>>;
  try {
    process.stdout.write("Step 2: Deploying L2 stack...     ");
    // Suppress the verbose output from deployL2Stack by temporarily redirecting
    // (we just capture the result — console.log in the helper still fires but
    //  that's acceptable for a validation script)
    l2 = await deployL2Stack(deployer);
    const contractCount = [
      l2.jinnToken,
      l2.serviceRegistry,
      l2.serviceRegistryTokenUtility,
      l2.activityChecker,
      l2.stakingFactory,
      l2.stakingImplementation,
      l2.stakingToken,
    ].length;
    pass("", `(${contractCount} contracts)`);
  } catch (e) {
    fail("Step 2: Deploying L2 stack", e);
  }

  // -------------------------------------------------------------------------
  // Step 2b: Verify the staking proxy is factory-backed
  // -------------------------------------------------------------------------
  try {
    process.stdout.write("Step 2b: Verifying proxy...       ");
    const proxy = await ethers.getContractAt("StakingProxy", l2.stakingToken, deployer);
    const factory = await ethers.getContractAt("StakingFactory", l2.stakingFactory, deployer);

    const [implementation, verified] = await Promise.all([
      proxy.getImplementation() as Promise<string>,
      factory.verifyInstance(l2.stakingToken) as Promise<boolean>,
    ]);

    if (implementation.toLowerCase() !== l2.stakingImplementation.toLowerCase()) {
      throw new Error(
        `Expected proxy implementation ${l2.stakingImplementation}, got ${implementation}`,
      );
    }
    if (!verified) {
      throw new Error("Factory does not recognize the deployed staking proxy");
    }

    pass("", "factory-backed proxy verified");
  } catch (e) {
    fail("Step 2b: Verifying proxy", e);
  }

  // -------------------------------------------------------------------------
  // Step 3: Configure Tokenomics for non-proxy usage
  // (sets PROXY_TOKENOMICS slot so checkpoint() doesn't revert with DelegatecallOnly)
  // -------------------------------------------------------------------------
  try {
    process.stdout.write("Step 3: Configuring Tokenomics... ");
    const tokenomicsAddr = await l1.tokenomics.getAddress();
    const tx = await l1.tokenomics.changeTokenomicsImplementation(tokenomicsAddr);
    await tx.wait();
    pass("", "");
  } catch (e) {
    fail("Step 3: Configuring Tokenomics", e);
  }

  // -------------------------------------------------------------------------
  // Step 4: Verify JINN token config
  // -------------------------------------------------------------------------
  try {
    process.stdout.write("Step 4: Verifying JINN token...   ");
    const name = await l1.jinn.name();
    const symbol = await l1.jinn.symbol();
    const minter = await l1.jinn.minter();
    const treasuryAddr = await l1.treasury.getAddress();
    if (name !== "Jinn") throw new Error(`Expected name "Jinn", got "${name}"`);
    if (symbol !== "JINN") throw new Error(`Expected symbol "JINN", got "${symbol}"`);
    if (minter.toLowerCase() !== treasuryAddr.toLowerCase())
      throw new Error(`Expected minter to be Treasury (${treasuryAddr}), got ${minter}`);
    pass("", `${name} (${symbol}), minter = Treasury`);
  } catch (e) {
    fail("Step 4: Verifying JINN token", e);
  }

  // -------------------------------------------------------------------------
  // Step 5: Verify Treasury is connected to all contracts
  // -------------------------------------------------------------------------
  try {
    process.stdout.write("Step 5: Verifying Treasury links...");
    // Treasury exposes `tokenomics`, `depository`, `dispenser` as public vars
    const tmAddr = await (l1.treasury as any).tokenomics();
    const depAddr = await (l1.treasury as any).depository();
    const disAddr = await (l1.treasury as any).dispenser();
    if (tmAddr.toLowerCase() !== (await l1.tokenomics.getAddress()).toLowerCase())
      throw new Error("Treasury.tokenomics mismatch");
    if (depAddr.toLowerCase() !== (await l1.depository.getAddress()).toLowerCase())
      throw new Error("Treasury.depository mismatch");
    if (disAddr.toLowerCase() !== (await l1.dispenser.getAddress()).toLowerCase())
      throw new Error("Treasury.dispenser mismatch");
    pass("", "tokenomics, depository, dispenser all correct");
  } catch (e) {
    fail("Step 5: Verifying Treasury links", e);
  }

  // -------------------------------------------------------------------------
  // Step 6: Advance time past one epoch and call checkpoint()
  // -------------------------------------------------------------------------
  try {
    process.stdout.write("Step 6: Advancing epoch...        ");
    const epochCounterBefore = await l1.tokenomics.epochCounter();

    // Advance time by epochLen + 1 second (MIN_EPOCH_LENGTH = 864000 = 10 days)
    await increaseTime(DEFAULT_DEPLOY_CONFIG.epochLen + 1);

    const tx = await l1.tokenomics.checkpoint();
    await tx.wait();

    const epochCounterAfter = await l1.tokenomics.epochCounter();
    if (epochCounterAfter !== epochCounterBefore + 1n)
      throw new Error(`Expected epoch ${epochCounterBefore + 1n}, got ${epochCounterAfter}`);
    pass("", `Epoch ${epochCounterBefore} → ${epochCounterAfter}`);
  } catch (e) {
    fail("Step 6: Advancing epoch", e);
  }

  // -------------------------------------------------------------------------
  // Step 7: Verify inflation accounting ran
  // -------------------------------------------------------------------------
  try {
    process.stdout.write("Step 7: Checking inflation...     ");
    const ips = await l1.tokenomics.inflationPerSecond();
    const eb = await l1.tokenomics.effectiveBond();
    if (ips === 0n) throw new Error("inflationPerSecond is 0");
    if (eb === 0n) throw new Error("effectiveBond is 0");
    pass("", `inflationPerSecond = ${ethers.formatEther(ips)} JINN/s, effectiveBond = ${ethers.formatEther(eb)} JINN`);
  } catch (e) {
    fail("Step 7: Checking inflation", e);
  }

  // -------------------------------------------------------------------------
  // Step 8: Record activity on the activity checker
  // -------------------------------------------------------------------------
  let multisigAddr: string;
  try {
    process.stdout.write("Step 8: Recording activity...     ");
    // Use the deployer address as a mock multisig for the activity counter
    // (RestorationActivityChecker.recordActivity is permissionless)
    multisigAddr = deployerAddress;
    const activityChecker = await ethers.getContractAt(
      "RestorationActivityChecker",
      l2.activityChecker,
      deployer
    );
    const activities = [
      { type: 0, label: "CREATE" },
      { type: 1, label: "DELIVER" },
      { type: 2, label: "EVALUATE" },
    ];
    for (const a of activities) {
      const tx = await activityChecker.recordActivity(multisigAddr, a.type);
      await tx.wait();
    }
    const count = await activityChecker.activityCounts(multisigAddr);
    if (count !== BigInt(activities.length))
      throw new Error(`Expected ${activities.length} activities, got ${count}`);
    pass("", `${count} activities recorded (CREATE, DELIVER, EVALUATE)`);
  } catch (e) {
    fail("Step 8: Recording activity", e);
  }

  // -------------------------------------------------------------------------
  // Step 9: Verify activity checker liveness passes
  // -------------------------------------------------------------------------
  try {
    process.stdout.write("Step 9: Checking liveness...      ");
    const activityChecker = await ethers.getContractAt(
      "RestorationActivityChecker",
      l2.activityChecker,
      deployer
    );
    const count = await activityChecker.activityCounts(multisigAddr);

    // Simulate nonce arrays: curNonces[1] = current count, lastNonces[1] = 0
    const curNonces = [0n, count];
    const lastNonces = [0n, 0n];
    // livenessRatio = 1e15. Need: (activities * 1e18) / ts >= 1e15
    // => ts <= activities * 1000 = 3 * 1000 = 3000 seconds
    const ts = 1000n; // 1000 seconds: ratio = 3e18/1000 = 3e15 > 1e15 ✓

    const ratioPass = await activityChecker.isRatioPass(curNonces, lastNonces, ts);
    if (!ratioPass) throw new Error("liveness ratio check failed");
    pass("", "ratio pass");
  } catch (e) {
    fail("Step 9: Checking liveness", e);
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("\n=== ALL CHECKS PASSED ===\n");
  console.log("Contract Addresses:");

  const l1Addrs: Record<string, string> = {
    JINN:            await l1.jinn.getAddress(),
    veJINN:          await l1.veOLAS.getAddress(),
    Tokenomics:      await l1.tokenomics.getAddress(),
    Treasury:        await l1.treasury.getAddress(),
    Depository:      await l1.depository.getAddress(),
    Dispenser:       await l1.dispenser.getAddress(),
    BondCalculator:  await l1.bondCalculator.getAddress(),
    VoteWeighting:   await l1.voteWeighting.getAddress(),
  };
  for (const [name, addr] of Object.entries(l1Addrs)) {
    console.log(`  ${name.padEnd(20)} ${addr}`);
  }
  console.log();

  const l2Addrs: Record<string, string> = {
    ActivityChecker:      l2.activityChecker,
    StakingFactory:       l2.stakingFactory,
    StakingImplementation:l2.stakingImplementation,
    StakingToken:         l2.stakingToken,
    ServiceRegistry:      l2.serviceRegistry,
  };
  for (const [name, addr] of Object.entries(l2Addrs)) {
    console.log(`  ${name.padEnd(20)} ${addr}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\nFatal error:", error);
    process.exit(1);
  });
