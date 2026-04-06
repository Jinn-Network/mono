#!/usr/bin/env ts-node

import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');

const voteWeighting = new ethers.Contract(
  '0x95418b46d5566D3d1ea62C12Aea91227E566c5c1',
  [
    'function timeSum() view returns (uint256)',
    'function getWeightsSum() view returns (uint256)',
    'function getNomineeWeight(bytes32 account, uint256 chainId) view returns (uint256)',
    'function nomineeRelativeWeight(bytes32 account, uint256 chainId, uint256 time) view returns (uint256 relativeWeight, uint256 totalSum)',
    'function getAllNominees() view returns (tuple(bytes32 account, uint256 chainId)[])',
  ],
  provider
);

async function main() {
  console.log('Fetching all nominees from VoteWeighting contract...\n');
  
  const nominees = await voteWeighting.getAllNominees();
  const timeSum = await voteWeighting.timeSum();
  const totalWeightsSum = await voteWeighting.getWeightsSum();
  
  console.log(`Total nominees: ${nominees.length}`);
  console.log(`Next checkpoint: ${new Date(Number(timeSum) * 1000).toISOString()}`);
  console.log(`Total weights sum: ${ethers.formatEther(totalWeightsSum)} veOLAS`);
  
  const results: { name: string; address: string; chainId: number; weight: string; percentage: string }[] = [];
  
  for (const nominee of nominees) {
    const address = ethers.getAddress('0x' + nominee.account.slice(-40));
    const chainId = Number(nominee.chainId);
    
    const weight = await voteWeighting.getNomineeWeight(nominee.account, chainId);
    const [relWeight] = await voteWeighting.nomineeRelativeWeight(nominee.account, chainId, timeSum);
    
    results.push({
      name: address,
      address,
      chainId,
      weight: ethers.formatEther(weight),
      percentage: (Number(relWeight) / 1e16).toFixed(4),
    });
  }
  
  // Sort by weight descending
  results.sort((a, b) => parseFloat(b.weight) - parseFloat(a.weight));
  
  console.log('\n=== All Nominees Sorted by Weight ===\n');
  console.log('Address                                    | Chain | Weight (veOLAS)     | %');
  console.log('-'.repeat(90));
  
  for (const r of results) {
    const chainName = r.chainId === 8453 ? 'Base' : r.chainId === 100 ? 'Gnosis' : r.chainId === 1 ? 'Mainnet' : `Chain ${r.chainId}`;
    console.log(`${r.address} | ${chainName.padEnd(7)} | ${parseFloat(r.weight).toFixed(2).padStart(17)} | ${r.percentage}%`);
  }
}

main().catch(console.error);
