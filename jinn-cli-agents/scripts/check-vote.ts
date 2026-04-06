import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');

const voteWeighting = new ethers.Contract(
  '0x95418b46d5566D3d1ea62C12Aea91227E566c5c1',
  [
    'function getWeightsSum() view returns (uint256)',
    'function getNomineeWeight(bytes32 account, uint256 chainId) view returns (uint256)',
    'function nomineeRelativeWeightWrite(bytes32 account, uint256 chainId, uint256 time) returns (uint256 relativeWeight, uint256 totalSum)',
    'function getAllNominees() view returns (tuple(bytes32 account, uint256 chainId)[])',
    'function voteUserPower(address) view returns (uint256)',
  ],
  provider
);

const veOLAS = new ethers.Contract(
  '0x7e01A500805f8A52Fad229b3015AD130A332B7b3',
  [
    'function balanceOf(address) view returns (uint256)',
  ],
  provider
);

const JINN_BYTES32 = '0x0000000000000000000000000dfafbf570e9e813507aae18aa08dfba0abc5139';
const JINN_CHAIN = 8453;
const VOTER = '0x0b6D0a414bc61A8f312f055669851edFb1764CE0';

async function main() {
  console.log('=== Post-Vote Verification ===\n');

  // 1. veOLAS balance
  const veBalance = await veOLAS.balanceOf(VOTER);
  console.log(`Your veOLAS balance: ${parseFloat(ethers.formatEther(veBalance)).toFixed(2)}`);

  // 2. Vote power used
  const powerUsed = await voteWeighting.voteUserPower(VOTER);
  console.log(`Vote power used: ${Number(powerUsed) / 100}% of 100%`);

  // 3. Jinn nominee weight
  const weight = await voteWeighting.getNomineeWeight(JINN_BYTES32, JINN_CHAIN);
  console.log(`\nJinn nominee weight: ${parseFloat(ethers.formatEther(weight)).toFixed(2)} veOLAS`);

  // 4. Total weights
  const totalWeights = await voteWeighting.getWeightsSum();
  console.log(`Total weights sum: ${parseFloat(ethers.formatEther(totalWeights)).toFixed(2)} veOLAS`);

  // 5. Relative weight now
  const now = Math.floor(Date.now() / 1000);
  try {
    const [relWeight, totalSum] = await voteWeighting.nomineeRelativeWeightWrite.staticCall(
      JINN_BYTES32, JINN_CHAIN, now
    );
    const pct = Number(relWeight) / 1e16;
    console.log(`\nRelative weight (now): ${pct.toFixed(4)}%`);
    console.log(`Total sum: ${parseFloat(ethers.formatEther(totalSum)).toFixed(2)} veOLAS`);
    
    if (pct >= 0.5) {
      console.log(`✅ ABOVE 0.5% threshold - eligible for emissions!`);
    } else {
      console.log(`⚠️  Below 0.5% threshold (need 0.5%, have ${pct.toFixed(4)}%)`);
    }
  } catch (e: any) {
    console.log(`\nnomineeRelativeWeightWrite error: ${e.message?.slice(0, 200)}`);
  }

  // 6. Relative weight at next Thursday
  const WEEK = 604800;
  const nextThursday = Math.floor((now + WEEK) / WEEK) * WEEK;
  try {
    const [relWeight2] = await voteWeighting.nomineeRelativeWeightWrite.staticCall(
      JINN_BYTES32, JINN_CHAIN, nextThursday
    );
    const pct2 = Number(relWeight2) / 1e16;
    console.log(`\nRelative weight (next Thu ${new Date(nextThursday * 1000).toISOString().split('T')[0]}): ${pct2.toFixed(4)}%`);
    if (pct2 >= 0.5) {
      console.log(`✅ ABOVE 0.5% threshold!`);
    } else {
      console.log(`⚠️  Below 0.5% threshold`);
    }
  } catch {}

  // 7. All nominees with non-zero weight
  console.log(`\n=== All Nominees with Weight ===`);
  const nominees = await voteWeighting.getAllNominees();
  const results: { address: string; chainId: number; weight: bigint; account: string }[] = [];
  
  for (const nominee of nominees) {
    const addr = ethers.getAddress('0x' + nominee.account.slice(-40));
    const cid = Number(nominee.chainId);
    const w = await voteWeighting.getNomineeWeight(nominee.account, cid);
    if (w > 0n) {
      results.push({ address: addr, chainId: cid, weight: w, account: nominee.account });
    }
  }
  
  results.sort((a, b) => (b.weight > a.weight ? 1 : -1));
  let totalW = 0n;
  for (const r of results) totalW += r.weight;
  
  for (const r of results) {
    const chain = r.chainId === 8453 ? 'Base' : r.chainId === 100 ? 'Gnosis' : r.chainId === 10 ? 'OP' : `${r.chainId}`;
    const isJinn = r.address.toLowerCase() === '0x0dfafbf570e9e813507aae18aa08dfba0abc5139';
    const marker = isJinn ? ' ← JINN' : '';
    const sharePct = (Number(r.weight) * 100 / Number(totalW)).toFixed(2);
    console.log(`  ${r.address.slice(0, 10)}... (${chain.padEnd(6)}): ${parseFloat(ethers.formatEther(r.weight)).toFixed(2).padStart(12)} veOLAS (${sharePct}%)${marker}`);
  }

  // 8. Funding estimate for Jinn
  const jinnEntry = results.find(r => r.address.toLowerCase() === '0x0dfafbf570e9e813507aae18aa08dfba0abc5139');
  if (jinnEntry) {
    const jinnShare = Number(jinnEntry.weight) / Number(totalW);
    const stakingPool = 751132;
    const jinnOlas = jinnShare * stakingPool;
    const maxPerNominee = 60000; // maxStakingIncentive cap
    const effectiveOlas = Math.min(jinnOlas, maxPerNominee);
    const servicesFullyFunded = Math.floor(effectiveOlas / 575);
    console.log(`\n=== Jinn Funding Estimate ===`);
    console.log(`Jinn share of total votes: ${(jinnShare * 100).toFixed(2)}%`);
    console.log(`Estimated OLAS/epoch (uncapped): ${jinnOlas.toFixed(0)}`);
    console.log(`Max per nominee cap: ${maxPerNominee}`);
    console.log(`Effective OLAS/epoch: ${effectiveOlas.toFixed(0)}`);
    console.log(`Services fundable (575 OLAS each): ${servicesFullyFunded}`);
  }
}

main().catch(console.error);
