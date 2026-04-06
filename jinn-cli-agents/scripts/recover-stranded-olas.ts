// @ts-nocheck
/**
 * Recovery Script: Sweep OLAS from Stranded Agent EOAs
 * 
 * This script recovers OLAS tokens from agent EOAs that were funded but
 * never completed deployment due to middleware failures.
 */

import { ethers } from 'ethers';

// Configuration
const RPC_URL = process.env.RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';

// Agent EOAs with stranded OLAS (from middleware keys)
const AGENTS = [
  {
    address: '0x879f73A2F355BD1d1bB299D21d9B621Ce6C4c285',
    privateKey: '0xbfd3377803271f33b8c079b29cd99b42c1ebc7b0b319f38b1e5b20c05fa54d1a',
    // default-service agent: 50.0 OLAS, 0.0005 ETH
  },
];

// ERC20 ABI (minimal: balanceOf + transfer)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

async function main() {
  console.log('🔄 OLAS Recovery Script\n');
  console.log(`Master Safe: ${MASTER_SAFE}`);
  console.log(`OLAS Token: ${OLAS_TOKEN}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const olasToken = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);

  const symbol = await olasToken.symbol();
  const decimals = await olasToken.decimals();
  
  console.log(`Token: ${symbol}, Decimals: ${decimals}\n`);
  console.log('═'.repeat(80));

  let totalRecovered = 0n;
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < AGENTS.length; i++) {
    const agent = AGENTS[i];
    
    // Add delay between agents to avoid rate limiting
    if (i > 0) {
      console.log(`\n⏸️  Waiting 3 seconds to avoid rate limit...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    console.log(`\n📍 Agent: ${agent.address}`);
    
    try {
      // Check OLAS balance
      const balance = await olasToken.balanceOf(agent.address);
      const balanceFormatted = ethers.formatUnits(balance, decimals);
      
      console.log(`   Balance: ${balanceFormatted} ${symbol}`);

      if (balance === 0n) {
        console.log(`   ⏭️  Nothing to recover, skipping`);
        continue;
      }

      // Check ETH balance for gas
      const ethBalance = await provider.getBalance(agent.address);
      const ethBalanceFormatted = ethers.formatEther(ethBalance);
      console.log(`   ETH Balance: ${ethBalanceFormatted} ETH`);

      if (ethBalance === 0n) {
        console.log(`   ❌ No ETH for gas, cannot recover`);
        failureCount++;
        continue;
      }

      // Create wallet and connect to token contract
      const wallet = new ethers.Wallet(agent.privateKey, provider);
      const tokenWithSigner = olasToken.connect(wallet);

      // Estimate gas
      const gasLimit = await tokenWithSigner.transfer.estimateGas(MASTER_SAFE, balance);
      const feeData = await provider.getFeeData();
      const gasCost = gasLimit * (feeData.gasPrice || feeData.maxFeePerGas || 0n);
      const gasCostEth = ethers.formatEther(gasCost);

      console.log(`   Estimated gas: ${gasLimit.toString()} units (~${gasCostEth} ETH)`);

      if (gasCost > ethBalance) {
        console.log(`   ❌ Insufficient ETH for gas`);
        failureCount++;
        continue;
      }

      // Send transaction
      console.log(`   🚀 Sending ${balanceFormatted} ${symbol} to Master Safe...`);
      const tx = await tokenWithSigner.transfer(MASTER_SAFE, balance, {
        gasLimit: gasLimit * 120n / 100n, // 20% buffer
      });
      
      console.log(`   📝 Tx Hash: ${tx.hash}`);
      console.log(`   ⏳ Waiting for confirmation...`);
      
      const receipt = await tx.wait();
      
      if (receipt?.status === 1) {
        console.log(`   ✅ Success! Recovered ${balanceFormatted} ${symbol}`);
        totalRecovered += balance;
        successCount++;
      } else {
        console.log(`   ❌ Transaction failed`);
        failureCount++;
      }

    } catch (error) {
      console.error(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
      failureCount++;
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('\n📊 Recovery Summary:');
  console.log(`   ✅ Successful: ${successCount}`);
  console.log(`   ❌ Failed: ${failureCount}`);
  console.log(`   💰 Total Recovered: ${ethers.formatUnits(totalRecovered, decimals)} ${symbol}`);
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

