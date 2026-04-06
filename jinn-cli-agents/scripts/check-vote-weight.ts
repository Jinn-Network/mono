#!/usr/bin/env ts-node
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');

const voteWeighting = new ethers.Contract(
  '0x95418b46d5566D3d1ea62C12Aea91227E566c5c1',
  [
    'function timeSum() view returns (uint256)',
    'function getWeightsSum() view returns (uint256)',
    'function WEEK() view returns (uint256)',
  ],
  provider
);

async function main() {
  const [timeSum, weightsSum, WEEK] = await Promise.all([
    voteWeighting.timeSum(),
    voteWeighting.getWeightsSum(),
    voteWeighting.WEEK(),
  ]);

  console.log('Current timeSum (next checkpoint):', new Date(Number(timeSum) * 1000).toISOString());
  console.log('WEEK constant:', Number(WEEK), 'seconds =', Number(WEEK) / 86400, 'days');
  console.log('');
  console.log('Total weights sum:', ethers.formatEther(weightsSum), 'veOLAS');
  console.log('');

  const jinnWeight = 440.314;
  const totalWeight = Number(ethers.formatEther(weightsSum));

  console.log('If Jinn weight is 440.314 veOLAS:');
  console.log('  Expected percentage:', (jinnWeight / totalWeight * 100).toFixed(4), '%');
  console.log('  UI shows: 0.061%');
  console.log('');

  const uiPercentage = 0.061;
  const impliedTotalWeight = jinnWeight / (uiPercentage / 100);
  console.log('If 440 = 0.061%, implied total weight:', impliedTotalWeight.toLocaleString(), 've OLAS');
}

main().catch(console.error);
