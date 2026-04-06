#!/usr/bin/env tsx
/**
 * Claim OLAS staking incentives from the L1 Dispenser
 *
 * Calls claimStakingIncentives() on the Ethereum mainnet Dispenser to bridge
 * OLAS rewards to the Jinn staking contract on Base. Permissionless — any
 * funded EOA can call it.
 *
 * The Dispenser enforces maxNumClaimingEpochs=1, so this script loops and
 * claims one epoch at a time until caught up.
 *
 * Usage:
 *   yarn staking:claim-incentives              # Claim all pending epochs
 *   yarn staking:claim-incentives --dry-run    # Preview without sending txs
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { getMasterPrivateKey, getServicePrivateKey } from '../../src/env/operate-profile.js';

// Ethereum mainnet contracts
const DISPENSER = '0x5650300fcbab43a0d7d02f8cb5d0f039402593f0';
const TOKENOMICS = '0xc096362fa6f4A4B1a9ea68b1043416f3381ce300';
const MAINNET_RPC = 'https://ethereum-rpc.publicnode.com';

// Jinn staking nominee on Base
const NOMINEE_BYTES32 = '0x0000000000000000000000000dfafbf570e9e813507aae18aa08dfba0abc5139';
const CHAIN_ID = 8453;

const DISPENSER_ABI = [
  'function claimStakingIncentives(uint256 numClaimedEpochs, uint256 chainId, bytes32 stakingTarget, bytes bridgePayload) external payable',
  'function mapLastClaimedStakingEpochs(bytes32 nomineeHash) view returns (uint256)',
  'function maxNumClaimingEpochs() view returns (uint256)',
];

const TOKENOMICS_ABI = [
  'function epochCounter() view returns (uint32)',
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const provider = new ethers.JsonRpcProvider(MAINNET_RPC);

  const tok = new ethers.Contract(TOKENOMICS, TOKENOMICS_ABI, provider);
  const disp = new ethers.Contract(DISPENSER, DISPENSER_ABI, provider);

  const nomineeHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256'],
      [NOMINEE_BYTES32, CHAIN_ID]
    )
  );

  const [currentEpoch, lastClaimed, maxPerClaim] = await Promise.all([
    tok.epochCounter().then(Number),
    disp.mapLastClaimedStakingEpochs(nomineeHash).then(Number),
    disp.maxNumClaimingEpochs().then(Number),
  ]);

  const claimableEpochs = (currentEpoch - 1) - lastClaimed;

  console.log(`Current epoch:     ${currentEpoch}`);
  console.log(`Last claimed:      ${lastClaimed}`);
  console.log(`Max per claim tx:  ${maxPerClaim}`);
  console.log(`Claimable epochs:  ${claimableEpochs}`);
  console.log();

  if (claimableEpochs <= 0) {
    console.log('Nothing to claim — all completed epochs have been claimed.');
    return;
  }

  const privateKey = getMasterPrivateKey() || getServicePrivateKey();
  if (!privateKey) {
    console.error('No private key available. Set OPERATE_PASSWORD to decrypt .operate keystore.');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log(`Caller:            ${wallet.address}`);
  console.log(`Mainnet ETH:       ${ethers.formatEther(balance)}`);

  if (balance < ethers.parseEther('0.005')) {
    console.error('Insufficient mainnet ETH for gas (need >= 0.005)');
    process.exit(1);
  }

  if (dryRun) {
    console.log(`\n--dry-run: would claim ${claimableEpochs} epoch(s). Exiting.`);
    return;
  }

  const signedDisp = new ethers.Contract(DISPENSER, DISPENSER_ABI, wallet);

  const numTxs = Math.ceil(claimableEpochs / maxPerClaim);
  for (let i = 0; i < numTxs; i++) {
    const epochsToClaim = Math.min(maxPerClaim, claimableEpochs - i * maxPerClaim);
    const targetEpoch = lastClaimed + (i * maxPerClaim) + epochsToClaim;

    console.log(`\n[${i + 1}/${numTxs}] Claiming ${epochsToClaim} epoch(s) (through epoch ${targetEpoch})...`);

    const tx = await signedDisp.claimStakingIncentives(
      epochsToClaim,
      CHAIN_ID,
      NOMINEE_BYTES32,
      '0x',
    );

    console.log(`  TX sent: ${tx.hash}`);
    console.log(`  Waiting for confirmation...`);

    const receipt = await tx.wait(1);
    if (receipt?.status === 1) {
      console.log(`  Confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed.toString()})`);
    } else {
      console.error(`  TX REVERTED: ${tx.hash}`);
      process.exit(1);
    }
  }

  const newLastClaimed = Number(await disp.mapLastClaimedStakingEpochs(nomineeHash));
  console.log(`\nDone. Last claimed epoch now: ${newLastClaimed}`);
  console.log('OLAS will arrive on Base staking contract after ~20 min bridge delay.');
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
