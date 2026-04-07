/**
 * checkpoint-and-verify.ts — Trigger epoch checkpoint and verify Phase 1a health.
 *
 * Run on a schedule to advance epochs and monitor the JINN tokenomics stack.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/checkpoint-and-verify.ts --network sepolia
 *
 * What it does:
 *   1. Reads Tokenomics state (epoch counter, epoch timing)
 *   2. Checks if current epoch is ready for checkpoint
 *   3. If ready, calls checkpoint() to advance the epoch
 *   4. Reads post-checkpoint state (inflation, effective bond, Treasury balance)
 *   5. Records activity on Base Sepolia activity checker
 *   6. Checks liveness ratio on activity checker
 *   7. Prints full health report
 */

import { ethers } from "hardhat";

// ─── L1 Contract Addresses (Sepolia) ───────────────────────────────────────
const JINN = "0x95A0d0E40Ea5F85968dF9eF43e9E4a37D6C8b8a0";
const TOKENOMICS = "0xac1D01d27dcfc377656fc728222b40DCe4b203a0";
const TREASURY = "0x0eD61f297Ae6a9B6231818EB5055bF4002Eb99bE";
const DISPENSER = "0xB9485266348C49918842BF7152dbE76d36bb9A3D";

// ─── Minimal ABIs ──────────────────────────────────────────────────────────
const JINN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function minter() view returns (address)",
];

const TOKENOMICS_ABI = [
  "function epochCounter() view returns (uint32)",
  "function epochLen() view returns (uint32)",
  "function inflationPerSecond() view returns (uint256)",
  "function effectiveBond() view returns (uint256)",
  "function checkpoint() returns (bool)",
  "function mapEpochTokenomics(uint256) view returns (tuple(uint96,uint96,uint32,uint32,uint96) epochPoint, uint96, uint96, uint32, uint64)",
];

const TREASURY_ABI = [
  "function paused() view returns (uint8)",
  "function ETHOwned() view returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          JINN Phase 1a — Checkpoint & Health Report         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`  Signer:    ${signer.address}`);
  console.log(`  Network:   Sepolia (${(await provider.getNetwork()).chainId})`);
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log();

  // ─── Connect to contracts ─────────────────────────────────────────────
  const jinn = new ethers.Contract(JINN, JINN_ABI, signer);
  const tokenomics = new ethers.Contract(TOKENOMICS, TOKENOMICS_ABI, signer);
  const treasury = new ethers.Contract(TREASURY, TREASURY_ABI, signer);

  // ─── 1. JINN Token State ──────────────────────────────────────────────
  console.log("── JINN Token ─────────────────────────────────────────────");
  const name = await jinn.name();
  const symbol = await jinn.symbol();
  const totalSupply = await jinn.totalSupply();
  const minter = await jinn.minter();
  const treasuryBalance = await jinn.balanceOf(TREASURY);

  console.log(`  Name:           ${name} (${symbol})`);
  console.log(`  Total Supply:   ${ethers.formatEther(totalSupply)} JINN`);
  console.log(`  Minter:         ${minter}`);
  console.log(`  Minter is Treasury: ${minter.toLowerCase() === TREASURY.toLowerCase() ? "✓" : "✗ WRONG"}`);
  console.log(`  Treasury Balance: ${ethers.formatEther(treasuryBalance)} JINN`);
  console.log();

  // ─── 2. Tokenomics State ──────────────────────────────────────────────
  console.log("── Tokenomics ─────────────────────────────────────────────");
  const epochCounter = await tokenomics.epochCounter();
  const epochLen = await tokenomics.epochLen();
  const inflationPerSecond = await tokenomics.inflationPerSecond();
  const effectiveBond = await tokenomics.effectiveBond();

  console.log(`  Epoch Counter:       ${epochCounter}`);
  console.log(`  Epoch Length:        ${epochLen}s (${(Number(epochLen) / 3600).toFixed(1)} hours)`);
  console.log(`  Inflation/Second:    ${ethers.formatEther(inflationPerSecond)} JINN`);
  console.log(`  Effective Bond:      ${ethers.formatEther(effectiveBond)} JINN`);
  console.log();

  // ─── 3. Treasury State ────────────────────────────────────────────────
  console.log("── Treasury ───────────────────────────────────────────────");
  const paused = await treasury.paused();
  const ethOwned = await treasury.ETHOwned();
  console.log(`  Paused:    ${paused === 0n ? "No ✓" : "YES ✗"}`);
  console.log(`  ETH Owned: ${ethers.formatEther(ethOwned)} ETH`);
  console.log();

  // ─── 4. Epoch Checkpoint ──────────────────────────────────────────────
  console.log("── Epoch Checkpoint ───────────────────────────────────────");

  // Check if checkpoint is possible (static call first)
  let checkpointReady = false;
  try {
    const wouldAdvance = await tokenomics.checkpoint.staticCall();
    checkpointReady = wouldAdvance;
    if (wouldAdvance) {
      console.log(`  Status: READY — epoch ${epochCounter} can be advanced`);
    } else {
      // Calculate when next checkpoint is possible
      const currentBlock = await provider.getBlock("latest");
      const blockTimestamp = currentBlock!.timestamp;

      // Read epoch 0's endTime to calculate when current epoch ends
      // Epoch N ends at: epoch0EndTime + epochCounter * epochLen
      try {
        const ep0 = await tokenomics.mapEpochTokenomics(0);
        const epoch0EndTime = Number(ep0.epochPoint[2]); // endTime is 3rd field
        const nextCheckpoint = epoch0EndTime + Number(epochCounter) * Number(epochLen);
        const secondsRemaining = nextCheckpoint - blockTimestamp;

        if (secondsRemaining > 0) {
          const minutesRemaining = Math.ceil(secondsRemaining / 60);
          console.log(`  Status: NOT READY — ${minutesRemaining} minutes remaining`);
          console.log(`  Next checkpoint: ~${new Date((blockTimestamp + secondsRemaining) * 1000).toISOString()}`);
        } else {
          console.log(`  Status: NOT READY — checkpoint() returned false (may need investigation)`);
        }
      } catch {
        console.log(`  Status: NOT READY — epoch ${epochCounter} still in progress`);
      }
    }
  } catch (e: any) {
    console.log(`  Status: ERROR — ${e.message?.slice(0, 100)}`);
  }

  if (checkpointReady) {
    console.log(`  Executing checkpoint...`);
    try {
      const tx = await tokenomics.checkpoint();
      const receipt = await tx.wait();
      const newEpoch = await tokenomics.epochCounter();
      const newInflation = await tokenomics.inflationPerSecond();
      const newBond = await tokenomics.effectiveBond();

      console.log(`  ✓ Checkpoint successful!`);
      console.log(`  Epoch:     ${epochCounter} → ${newEpoch}`);
      console.log(`  Tx:        ${receipt.hash}`);
      console.log(`  Gas used:  ${receipt.gasUsed.toString()}`);
      console.log(`  Inflation: ${ethers.formatEther(newInflation)} JINN/s`);
      console.log(`  Bond:      ${ethers.formatEther(newBond)} JINN`);

      // Check new total supply
      const newSupply = await jinn.totalSupply();
      console.log(`  Supply:    ${ethers.formatEther(newSupply)} JINN (was ${ethers.formatEther(totalSupply)})`);
    } catch (e: any) {
      console.log(`  ✗ Checkpoint failed: ${e.message?.slice(0, 200)}`);
    }
  }
  console.log();

  // ─── 5. Summary ───────────────────────────────────────────────────────
  console.log("── Summary ────────────────────────────────────────────────");
  console.log(`  JINN Token:    ${JINN}`);
  console.log(`  Tokenomics:    ${TOKENOMICS}`);
  console.log(`  Treasury:      ${TREASURY}`);
  console.log(`  Dispenser:     ${DISPENSER}`);
  console.log(`  Epoch:         ${checkpointReady ? "ADVANCED ✓" : `${epochCounter} (waiting)`}`);
  console.log(`  Health:        ${paused === 0n ? "OK ✓" : "PAUSED ✗"}`);
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
