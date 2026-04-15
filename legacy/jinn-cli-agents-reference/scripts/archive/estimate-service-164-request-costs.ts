#!/usr/bin/env tsx
/**
 * Estimate Costs for Service #164 Mech Marketplace Requests
 * 
 * Determines:
 * 1. Service Safe ETH balance
 * 2. Estimated gas cost per request
 * 3. Mech request pricing (if available)
 * 4. Total cost to submit required requests
 * 5. Whether Service Safe needs additional funding
 */

import { ethers } from 'ethers';

// Configuration
const RPC_URL = process.env.BASE_LEDGER_RPC || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Service #164 addresses
const SERVICE_SAFE = '0xdB225C794218b1f5054dffF3462c84A30349B182';
const AGENT_EOA = '0x3944aB4EbAe6F9CA96430CaE97B71FB878E1e100';
const MECH_CONTRACT = '0xE403cd520cfC2C3580D6C1C9302b74723Ef48B8E';
const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';

// Number of requests needed
const REQUIRED_REQUESTS = 2;

// ABIs
const MECH_MARKETPLACE_ABI = [
  'function request(bytes[] memory requestDatas, address priorityMech, uint256 deliveryRate, bytes32 paymentType, uint256 responseTimeout, bytes memory paymentData) external payable returns (bytes32[] memory requestIds)',
];

const MECH_ABI = [
  'function price() view returns (uint256)',
  'function getRequestsCount(address account) view returns (uint256)',
];

async function main() {
  console.log('💰 Estimating Request Costs for Service #164\n');
  console.log(`Service Safe: ${SERVICE_SAFE}`);
  console.log(`Required Requests: ${REQUIRED_REQUESTS}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  console.log('📊 Fetching balances and pricing...\n');

  try {
    // 1. Get Service Safe ETH balance
    const serviceSafeBalance = await provider.getBalance(SERVICE_SAFE);
    console.log('✅ Service Safe Balance:');
    console.log(`   ${ethers.formatEther(serviceSafeBalance)} ETH`);
    console.log(`   (${serviceSafeBalance.toString()} wei)\n`);

    // 2. Get Agent EOA balance (signs transactions)
    const agentBalance = await provider.getBalance(AGENT_EOA);
    console.log('✅ Agent EOA Balance:');
    console.log(`   ${ethers.formatEther(agentBalance)} ETH`);
    console.log(`   (${agentBalance.toString()} wei)\n`);

    // 3. Get Master Safe balance (if additional funding needed)
    const masterSafeBalance = await provider.getBalance(MASTER_SAFE);
    console.log('✅ Master Safe Balance:');
    console.log(`   ${ethers.formatEther(masterSafeBalance)} ETH\n`);

    // 4. Get current gas price
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice || 0n;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || 0n;

    console.log('✅ Current Gas Pricing (Base Network):');
    console.log(`   Base Fee: ${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei`);
    console.log(`   Priority Fee: ${ethers.formatUnits(maxPriorityFeePerGas, 'gwei')} gwei`);
    console.log(`   Total: ${ethers.formatUnits(maxFeePerGas + maxPriorityFeePerGas, 'gwei')} gwei\n`);

    // 5. Try to get mech pricing (may not be available)
    let mechPrice = 0n;
    let mechPriceAvailable = false;

    try {
      const mechContract = new ethers.Contract(MECH_CONTRACT, MECH_ABI, provider);
      mechPrice = await mechContract.price();
      mechPriceAvailable = true;
      console.log('✅ Mech Request Price:');
      console.log(`   ${ethers.formatEther(mechPrice)} ETH per request\n`);
    } catch (error) {
      console.log('⚠️  Mech Request Price: Not available via price() method');
      console.log('   Using default estimate: 0.01 ETH per request\n');
      mechPrice = ethers.parseEther('0.01');
    }

    // ========================================
    // Cost Estimation
    // ========================================
    console.log('🧮 Cost Estimation...\n');

    // Estimate gas for Safe transaction
    // Safe.execTransaction + MechMarketplace.request
    // Typical range: 200,000 - 300,000 gas
    const ESTIMATED_GAS_PER_REQUEST = 250_000n;

    console.log(`Estimated gas per request: ${ESTIMATED_GAS_PER_REQUEST.toLocaleString()} gas`);

    const gasCostPerRequest = ESTIMATED_GAS_PER_REQUEST * (maxFeePerGas + maxPriorityFeePerGas);
    console.log(`Gas cost per request: ${ethers.formatEther(gasCostPerRequest)} ETH`);
    console.log(`  = ${ESTIMATED_GAS_PER_REQUEST} gas × ${ethers.formatUnits(maxFeePerGas + maxPriorityFeePerGas, 'gwei')} gwei\n`);

    // Total cost per request
    const totalCostPerRequest = gasCostPerRequest + mechPrice;
    console.log(`Total cost per request: ${ethers.formatEther(totalCostPerRequest)} ETH`);
    console.log(`  = ${ethers.formatEther(gasCostPerRequest)} ETH (gas)`);
    console.log(`  + ${ethers.formatEther(mechPrice)} ETH (mech fee)\n`);

    // Total cost for all requests
    const totalCostAllRequests = totalCostPerRequest * BigInt(REQUIRED_REQUESTS);
    console.log(`Total cost for ${REQUIRED_REQUESTS} requests: ${ethers.formatEther(totalCostAllRequests)} ETH\n`);

    // ========================================
    // Balance Sufficiency Check
    // ========================================
    console.log('💳 Balance Sufficiency Check...\n');

    // Agent EOA needs gas to sign Safe transactions
    const agentGasNeeded = ESTIMATED_GAS_PER_REQUEST * BigInt(REQUIRED_REQUESTS) * (maxFeePerGas + maxPriorityFeePerGas);
    const agentHasEnough = agentBalance >= agentGasNeeded;

    console.log(`Agent EOA (transaction signer):`);
    console.log(`  Current: ${ethers.formatEther(agentBalance)} ETH`);
    console.log(`  Needed: ${ethers.formatEther(agentGasNeeded)} ETH (for gas)`);
    console.log(`  Status: ${agentHasEnough ? '✅ SUFFICIENT' : '❌ INSUFFICIENT'}`);
    if (!agentHasEnough) {
      const shortfall = agentGasNeeded - agentBalance;
      console.log(`  Shortfall: ${ethers.formatEther(shortfall)} ETH`);
    }
    console.log();

    // Service Safe needs total cost (gas + mech fees)
    const serviceSafeNeeded = totalCostAllRequests;
    const serviceSafeHasEnough = serviceSafeBalance >= serviceSafeNeeded;

    console.log(`Service Safe (pays for requests):`);
    console.log(`  Current: ${ethers.formatEther(serviceSafeBalance)} ETH`);
    console.log(`  Needed: ${ethers.formatEther(serviceSafeNeeded)} ETH (for ${REQUIRED_REQUESTS} requests)`);
    console.log(`  Status: ${serviceSafeHasEnough ? '✅ SUFFICIENT' : '❌ INSUFFICIENT'}`);
    if (!serviceSafeHasEnough) {
      const shortfall = serviceSafeNeeded - serviceSafeBalance;
      console.log(`  Shortfall: ${ethers.formatEther(shortfall)} ETH`);
    }
    console.log();

    // ========================================
    // Funding Recommendation
    // ========================================
    console.log('💡 Recommendation:\n');

    if (agentHasEnough && serviceSafeHasEnough) {
      console.log('✅ Both Agent EOA and Service Safe have sufficient ETH!');
      console.log('   No additional funding needed.');
      console.log('   Ready to submit requests.\n');
    } else {
      console.log('⚠️  Additional funding required:\n');

      if (!agentHasEnough) {
        const shortfall = agentGasNeeded - agentBalance;
        const recommended = shortfall + ethers.parseEther('0.0001'); // Add buffer
        console.log(`Agent EOA needs ${ethers.formatEther(recommended)} ETH more`);
        console.log(`  Current: ${ethers.formatEther(agentBalance)} ETH`);
        console.log(`  Recommended: ${ethers.formatEther(agentBalance + recommended)} ETH total\n`);
      }

      if (!serviceSafeHasEnough) {
        const shortfall = serviceSafeNeeded - serviceSafeBalance;
        const recommended = shortfall + ethers.parseEther('0.0001'); // Add buffer
        console.log(`Service Safe needs ${ethers.formatEther(recommended)} ETH more`);
        console.log(`  Current: ${ethers.formatEther(serviceSafeBalance)} ETH`);
        console.log(`  Recommended: ${ethers.formatEther(serviceSafeBalance + recommended)} ETH total\n`);
      }

      console.log(`Master Safe has ${ethers.formatEther(masterSafeBalance)} ETH available for funding.\n`);
    }

    // ========================================
    // Summary Table
    // ========================================
    console.log('='.repeat(70));
    console.log('📋 COST SUMMARY');
    console.log('='.repeat(70));
    console.log(`Per Request:`);
    console.log(`  Gas Cost:     ${ethers.formatEther(gasCostPerRequest)} ETH`);
    console.log(`  Mech Fee:     ${ethers.formatEther(mechPrice)} ETH${mechPriceAvailable ? '' : ' (estimated)'}`);
    console.log(`  Total:        ${ethers.formatEther(totalCostPerRequest)} ETH\n`);
    console.log(`For ${REQUIRED_REQUESTS} Requests:`);
    console.log(`  Total Cost:   ${ethers.formatEther(totalCostAllRequests)} ETH\n`);
    console.log(`Current Balances:`);
    console.log(`  Agent EOA:    ${ethers.formatEther(agentBalance)} ETH ${agentHasEnough ? '✅' : '❌'}`);
    console.log(`  Service Safe: ${ethers.formatEther(serviceSafeBalance)} ETH ${serviceSafeHasEnough ? '✅' : '❌'}`);
    console.log(`  Master Safe:  ${ethers.formatEther(masterSafeBalance)} ETH`);
    console.log('='.repeat(70) + '\n');

    // ========================================
    // Next Steps
    // ========================================
    console.log('📝 Next Steps:\n');

    if (agentHasEnough && serviceSafeHasEnough) {
      console.log('1. Create marketplace request submission script');
      console.log('2. Test with 1 request first');
      console.log('3. Verify request is recorded on-chain');
      console.log('4. Submit second request');
      console.log('5. Verify activity checker recognizes both requests\n');
    } else {
      console.log('1. Fund Agent EOA and/or Service Safe as needed');
      console.log('2. Re-run this script to verify sufficient balance');
      console.log('3. Then proceed with request submission\n');

      console.log('Funding commands:');
      if (!agentHasEnough) {
        const shortfall = agentGasNeeded - agentBalance + ethers.parseEther('0.0001');
        console.log(`\n# Fund Agent EOA`);
        console.log(`cast send ${AGENT_EOA} --value ${ethers.formatEther(shortfall)}ether --from <your-wallet>`);
      }
      if (!serviceSafeHasEnough) {
        const shortfall = serviceSafeNeeded - serviceSafeBalance + ethers.parseEther('0.0001');
        console.log(`\n# Fund Service Safe`);
        console.log(`cast send ${SERVICE_SAFE} --value ${ethers.formatEther(shortfall)}ether --from <your-wallet>`);
      }
      console.log();
    }

  } catch (error: any) {
    console.error('❌ Error estimating costs:', error.message);
    if (error.data) {
      console.error('Error data:', error.data);
    }
    process.exit(1);
  }
}

main().catch(console.error);

