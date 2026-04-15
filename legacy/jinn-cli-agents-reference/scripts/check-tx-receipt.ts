/**
 * Check transaction receipt details
 */

import { ethers } from 'ethers';

const TX_HASH = '0x76f71c4dec2627443231598bb794a3858192eca5998683b923e5077bc0736874';
const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';

async function checkReceipt() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  console.log('Fetching transaction receipt...\n');
  
  const receipt = await provider.getTransactionReceipt(TX_HASH);
  
  if (!receipt) {
    console.log('Receipt not found');
    return;
  }
  
  console.log('Transaction Status:', receipt.status === 1 ? '✅ SUCCESS' : '❌ FAILED');
  console.log('Block Number:', receipt.blockNumber);
  console.log('Gas Used:', receipt.gasUsed.toString());
  console.log('Logs Count:', receipt.logs.length);
  console.log();
  
  console.log('Transaction Details:');
  console.log('From:', receipt.from);
  console.log('To:', receipt.to);
  console.log();
  
  if (receipt.logs.length > 0) {
    console.log('Events:');
    receipt.logs.forEach((log, i) => {
      console.log(`\n[Event ${i}]`);
      console.log('  Address:', log.address);
      console.log('  Topics:', log.topics);
      console.log('  Data:', log.data);
    });
  } else {
    console.log('No events emitted - transaction likely reverted');
  }
  
  console.log('\nBaseScan:', `https://basescan.org/tx/${TX_HASH}`);
}

checkReceipt().catch(console.error);
