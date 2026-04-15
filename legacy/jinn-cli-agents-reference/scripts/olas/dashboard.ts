/**
 * OLAS Staking Dashboard
 *
 * Single command showing veOLAS position, Jinn nominee status,
 * staking economics, and all nominee weights.
 *
 * Usage: yarn olas:dashboard
 *
 * Note: getNomineeWeight() only works for checkpointed nominees.
 * nomineeRelativeWeightWrite.staticCall() is the only accurate way
 * to get weights (it checkpoints internally). We use it for all nominees.
 */
import { ethers } from 'ethers';
import { JINN, VOTER } from './lib/addresses.js';
import { getVoteWeighting, getVeOLAS, getTokenomics, getDispenser } from './lib/contracts.js';
import { formatOLAS, formatPercent, chainName, shortAddr } from './lib/format.js';

const MIN_WEIGHT_PCT = 0.5; // 0.5% threshold (minStakingWeight = 50 bps)

async function main() {
  const vw = getVoteWeighting();
  const ve = getVeOLAS();
  const tok = getTokenomics();
  const disp = getDispenser();

  const now = Math.floor(Date.now() / 1000);

  console.log('  Fetching on-chain data...\n');

  // Parallel fetch all independent data
  const [
    veBalance,
    powerUsed,
    epochCounter,
    epochLen,
    nominees,
  ] = await Promise.all([
    ve.balanceOf(VOTER),
    vw.voteUserPower(VOTER),
    tok.epochCounter(),
    tok.epochLen(),
    vw.getAllNominees(),
  ]);

  // Jinn relative weight (the only accurate method - checkpoints internally)
  let jinnRelWeight = 0;
  let totalSumVeOLAS = 0n;

  try {
    const [rw, ts] = await vw.nomineeRelativeWeightWrite.staticCall(
      JINN.nomineeBytes32, JINN.chainId, now
    );
    jinnRelWeight = Number(rw) / 1e16;
    totalSumVeOLAS = ts;
  } catch {}

  // Staking pool from latest completed epoch
  // mapEpochStakingPoints returns: [stakingAmount, maxStakingIncentive, minStakingWeight, ...]
  let stakingPool = 0;
  let maxPerNominee = 60000; // fallback
  const currentEpoch = Number(epochCounter);

  try {
    const points = await tok.mapEpochStakingPoints(currentEpoch - 1);
    stakingPool = parseFloat(ethers.formatEther(points[0]));
    maxPerNominee = parseFloat(ethers.formatEther(points[1]));
  } catch {}

  // Unclaimed epochs
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

  // === DISPLAY ===

  const powerPct = Number(powerUsed) / 100;
  console.log('=== veOLAS Position ===');
  console.log(`  Wallet:           ${shortAddr(VOTER)}`);
  console.log(`  veOLAS Balance:   ${formatOLAS(veBalance)}`);
  console.log(`  Vote Power Used:  ${formatPercent(powerPct, 0)} (${formatPercent(100 - powerPct, 0)} remaining)`);

  const thresholdTag = (pct: number) =>
    pct >= MIN_WEIGHT_PCT ? ' [PASS]' : ' [BELOW 0.5% THRESHOLD]';

  console.log('\n=== Jinn Nominee ===');
  console.log(`  Chain:            Base (${JINN.chainId})`);
  console.log(`  Contract:         0x0dfaFbf...5139`);
  console.log(`  Relative Weight:  ${formatPercent(jinnRelWeight, 4)}${thresholdTag(jinnRelWeight)}`);
  if (totalSumVeOLAS > 0n) {
    console.log(`  Total Vote Pool:  ${formatOLAS(totalSumVeOLAS)} veOLAS`);
  }

  // Funding estimate
  const jinnOlasPerEpoch = (jinnRelWeight / 100) * stakingPool;
  const effectiveOlas = Math.min(jinnOlasPerEpoch, maxPerNominee);
  const servicesFunded = Math.floor(effectiveOlas / JINN.rewardsPerService);
  const unclaimedEpochs = lastClaimedEpoch > 0 ? currentEpoch - lastClaimedEpoch : 0;

  console.log('\n=== Staking Economics ===');
  console.log(`  Epoch:            ${currentEpoch} (${Number(epochLen) / 86400}-day cycle)`);
  console.log(`  Staking Pool:     ${stakingPool.toLocaleString('en-US', { maximumFractionDigits: 0 })} OLAS/epoch`);
  console.log(`  Jinn Allocation:  ~${effectiveOlas.toLocaleString('en-US', { maximumFractionDigits: 0 })} OLAS/epoch`);
  console.log(`  Per-Nominee Cap:  ${maxPerNominee.toLocaleString('en-US', { maximumFractionDigits: 0 })} OLAS`);
  console.log(`  Services Funded:  ${servicesFunded} / ${JINN.maxSlots} slots (at ${JINN.rewardsPerService} OLAS each)`);
  if (unclaimedEpochs > 0) {
    console.log(`  Unclaimed Epochs: ${unclaimedEpochs} (~${(unclaimedEpochs * effectiveOlas).toLocaleString('en-US', { maximumFractionDigits: 0 })} OLAS pending)`);
  }

  // Nominees table - use nomineeRelativeWeightWrite for accuracy
  console.log('\n=== All Nominees (by relative weight) ===');
  console.log('  Querying all nominees (this takes ~30s)...');

  type NomineeResult = {
    address: string;
    chainId: number;
    relWeight: number; // percentage
  };
  const results: NomineeResult[] = [];

  // Batch queries in groups of 10 for reasonable RPC throughput
  const BATCH_SIZE = 10;
  for (let i = 0; i < nominees.length; i += BATCH_SIZE) {
    const batch = nominees.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (nom: { account: string; chainId: bigint }) => {
        try {
          const [rw] = await vw.nomineeRelativeWeightWrite.staticCall(
            nom.account, nom.chainId, now
          );
          const pct = Number(rw) / 1e16;
          if (pct > 0) {
            const addr = ethers.getAddress('0x' + nom.account.slice(-40));
            return { address: addr, chainId: Number(nom.chainId), relWeight: pct };
          }
        } catch {}
        return null;
      })
    );
    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }

  results.sort((a, b) => b.relWeight - a.relWeight);

  for (const r of results) {
    const chain = chainName(r.chainId).padEnd(8);
    const isJinn = r.address.toLowerCase() === '0x0dfafbf570e9e813507aae18aa08dfba0abc5139';
    const isDead = r.address.toLowerCase() === '0x000000000000000000000000000000000000dead';
    const label = isJinn ? ' <- YOU' : isDead ? ' (retainer)' : '';
    console.log(`  ${shortAddr(r.address)} (${chain}): ${formatPercent(r.relWeight, 4).padStart(10)}${label}`);
  }

  console.log('');
}

main().catch(console.error);
