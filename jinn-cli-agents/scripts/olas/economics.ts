/**
 * OLAS Tokenomics Deep Dive
 *
 * Shows epoch timing, inflation rates, staking pool breakdown,
 * and Jinn reward estimates.
 *
 * Usage: yarn olas:economics
 */
import { ethers } from 'ethers';
import { JINN } from './lib/addresses.js';
import { getTokenomics, getDispenser, getVoteWeighting } from './lib/contracts.js';
import { formatOLAS, formatPercent, formatDuration } from './lib/format.js';

async function main() {
  const tok = getTokenomics();
  const disp = getDispenser();
  const vw = getVoteWeighting();
  const now = Math.floor(Date.now() / 1000);

  console.log('  Fetching tokenomics data...\n');

  const [epochCounter, epochLen, inflationPerSecond] = await Promise.all([
    tok.epochCounter(),
    tok.epochLen(),
    tok.inflationPerSecond(),
  ]);

  const currentEpoch = Number(epochCounter);
  const epochLenSec = Number(epochLen);

  // Get staking points for last completed epoch
  const points = await tok.mapEpochStakingPoints(currentEpoch - 1);
  const stakingPool = parseFloat(ethers.formatEther(points[0]));
  const maxPerNominee = parseFloat(ethers.formatEther(points[1]));
  const minStakingWeight = Number(points[2]); // bps

  // Inflation calc
  const inflPerSec = parseFloat(ethers.formatEther(inflationPerSecond));
  const inflPerEpoch = inflPerSec * epochLenSec;
  const inflPerYear = inflPerSec * 365.25 * 86400;
  const stakingSharePct = (stakingPool / inflPerEpoch) * 100;

  // Epoch timing estimate (approximate - no on-chain epoch start time available)
  const epochDays = epochLenSec / 86400;

  console.log('=== Epoch Info ===');
  console.log(`  Current Epoch:    ${currentEpoch}`);
  console.log(`  Epoch Length:     ${epochDays} days (${formatDuration(epochLenSec)})`);

  console.log('\n=== Inflation ===');
  console.log(`  Per Second:       ${inflPerSec.toFixed(6)} OLAS`);
  console.log(`  Per Epoch:        ${inflPerEpoch.toLocaleString('en-US', { maximumFractionDigits: 0 })} OLAS`);
  console.log(`  Per Year:         ~${(inflPerYear / 1e6).toFixed(2)}M OLAS`);

  console.log(`\n=== Staking Pool (Epoch ${currentEpoch - 1}) ===`);
  console.log(`  Total Pool:       ${stakingPool.toLocaleString('en-US', { maximumFractionDigits: 0 })} OLAS/epoch`);
  console.log(`  Share of Inflation: ${formatPercent(stakingSharePct, 1)}`);
  console.log(`  Per-Nominee Cap:  ${maxPerNominee.toLocaleString('en-US', { maximumFractionDigits: 0 })} OLAS`);
  console.log(`  Min Weight:       ${formatPercent(minStakingWeight / 100, 1)} (${minStakingWeight} bps)`);

  // Jinn-specific
  let jinnRelWeight = 0;
  try {
    const [rw] = await vw.nomineeRelativeWeightWrite.staticCall(
      JINN.nomineeBytes32, JINN.chainId, now
    );
    jinnRelWeight = Number(rw) / 1e16;
  } catch {}

  let lastClaimedEpoch = 0;
  try {
    const nomineeHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256'],
        [JINN.nomineeBytes32, JINN.chainId]
      )
    );
    lastClaimedEpoch = Number(await disp.mapLastClaimedStakingEpochs(nomineeHash));
  } catch {}

  const jinnOlasPerEpoch = (jinnRelWeight / 100) * stakingPool;
  const effectiveOlas = Math.min(jinnOlasPerEpoch, maxPerNominee);
  const unclaimedEpochs = lastClaimedEpoch > 0 ? currentEpoch - lastClaimedEpoch : 0;
  const pendingOlas = unclaimedEpochs * effectiveOlas;

  console.log('\n=== Jinn Rewards ===');
  console.log(`  Relative Weight:  ${formatPercent(jinnRelWeight, 4)}`);
  console.log(`  OLAS/epoch:       ~${effectiveOlas.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  console.log(`  OLAS/year:        ~${((effectiveOlas * 365.25) / epochDays).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  console.log(`  Last Claimed:     Epoch ${lastClaimedEpoch || '?'}`);
  if (unclaimedEpochs > 0) {
    console.log(`  Unclaimed:        ${unclaimedEpochs} epochs (~${pendingOlas.toLocaleString('en-US', { maximumFractionDigits: 0 })} OLAS pending)`);
  }

  // ROI estimate
  const stakeCostPerService = 10000; // 5K stake + 5K bond
  if (effectiveOlas > 0) {
    const roiPerServicePerEpoch = (effectiveOlas / JINN.maxSlots) / stakeCostPerService * 100;
    const annualRoi = roiPerServicePerEpoch * (365.25 / epochDays);
    console.log(`\n=== ROI Estimate (per service) ===`);
    console.log(`  Stake Required:   10,000 OLAS (5K stake + 5K bond)`);
    console.log(`  Reward/epoch:     ~${(effectiveOlas / JINN.maxSlots).toFixed(0)} OLAS`);
    console.log(`  Annual ROI:       ~${formatPercent(annualRoi, 0)}`);
  }

  console.log('');
}

main().catch(console.error);
