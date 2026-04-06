// @ts-nocheck
/**
 * Query MechFactory addresses from Base MechMarketplace
 */

import { ethers } from 'ethers';

const MECH_MARKETPLACE_ADDRESS = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';

// MechMarketplace ABI - only what we need
const ABI = [
  'event SetMechFactoryStatuses(address[] factories, bool[] statuses)',
  'function create(uint256 serviceId, address mechFactory, bytes32 data) returns (address)'
];

async function queryFactories() {
  console.log('Querying MechFactory addresses from Base MechMarketplace...\n');
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(MECH_MARKETPLACE_ADDRESS, ABI, provider);
  
  // Get SetMechFactoryStatuses events to find allowed factories
  console.log('Fetching SetMechFactoryStatuses events from recent blocks...');
  
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 10000000); // Last ~10M blocks
  
  console.log(`Current block: ${currentBlock}`);
  console.log(`Searching from block: ${fromBlock}\n`);
  
  const filter = contract.filters.SetMechFactoryStatuses();
  const events = await contract.queryFilter(filter, fromBlock, 'latest');
  
  console.log(`Found ${events.length} SetMechFactoryStatuses events\n`);
  
  const allowedFactories = new Set<string>();
  
  events.forEach((event, i) => {
    console.log(`Event ${i + 1}:`);
    console.log('  Block:', event.blockNumber);
    console.log('  Factories:', event.args?.factories);
    console.log('  Statuses:', event.args?.statuses);
    
    if (event.args?.factories && event.args?.statuses) {
      event.args.factories.forEach((factory: string, idx: number) => {
        const status = event.args.statuses[idx];
        if (status) {
          allowedFactories.add(factory);
          console.log(`  ✅ Factory allowed: ${factory}`);
        } else {
          allowedFactories.delete(factory);
          console.log(`  ❌ Factory disabled: ${factory}`);
        }
      });
    }
    console.log();
  });
  
  console.log('='.repeat(80));
  console.log('ALLOWED MECH FACTORIES ON BASE:');
  console.log('='.repeat(80));
  
  if (allowedFactories.size === 0) {
    console.log('No factories currently allowed');
  } else {
    allowedFactories.forEach(factory => {
      console.log(factory);
    });
  }
  
  console.log();
  console.log('Use any of these addresses as mechFactory parameter in MechMarketplace.create()');
}

queryFactories().catch(console.error);
