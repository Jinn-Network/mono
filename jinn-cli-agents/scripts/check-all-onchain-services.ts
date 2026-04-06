#!/usr/bin/env tsx
/**
 * Check all on-chain services 145-163 for locked funds
 */

import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';
const SERVICE_REGISTRY = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';
const SERVICE_REGISTRY_TOKEN_UTILITY = '0x3d77596beb0f130a4415df3D2D8232B3d3D31e44';
const STAKING_CONTRACT = '0x2585e63df7BD9De8e058884D496658a030b5c6ce';

const REGISTRY_ABI = [
  'function exists(uint256 tokenId) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getService(uint256 serviceId) view returns (tuple(address securityDeposit, address multisig, bytes32 configHash, uint32 threshold, uint32 maxNumAgentInstances, uint32 numAgentInstances, uint8 state, address[] agentIds))',
];

const TOKEN_UTILITY_ABI = [
  'function mapServiceIdTokenDeposit(uint256) view returns (uint256, uint256)',
];

const STAKING_ABI = [
  'function getServiceInfo(uint256) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// Check services 145-163 from the screenshots
const SERVICE_IDS = Array.from({ length: 19 }, (_, i) => 145 + i);

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const registry = new ethers.Contract(SERVICE_REGISTRY, REGISTRY_ABI, provider);
  const tokenUtility = new ethers.Contract(SERVICE_REGISTRY_TOKEN_UTILITY, TOKEN_UTILITY_ABI, provider);
  const staking = new ethers.Contract(STAKING_CONTRACT, STAKING_ABI, provider);
  const olas = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);

  console.log('🔍 Checking Services 145-163 for Locked Funds\n');

  let totalBonded = 0n;
  let totalStaked = 0n;
  let totalInSafes = 0n;
  const recoverableServices: Array<{ id: number, safe: string, bonded: string, staked: string, safeBalance: string }> = [];

  for (let i = 0; i < SERVICE_IDS.length; i++) {
    const serviceId = SERVICE_IDS[i];

    // Rate limit
    if (i > 0 && i % 3 === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }

    try {
      const exists = await registry.exists(serviceId);
      if (!exists) {
        console.log(`Service ${serviceId}: Does not exist`);
        continue;
      }

      const owner = await registry.ownerOf(serviceId);
      const service = await registry.getService(serviceId);
      const deposit = await tokenUtility.mapServiceIdTokenDeposit(serviceId);

      const bonded = deposit[0];
      const multisig = service[1];
      const state = service[6];

      // Check if staked
      let stakedAmount = 0n;
      let isStaked = false;
      try {
        const stakingInfo = await staking.getServiceInfo(serviceId);
        if (stakingInfo.multisig !== ethers.ZeroAddress) {
          isStaked = true;
          stakedAmount = 50000000000000000000n; // 50 OLAS typical stake
        }
      } catch {
        // Not staked
      }

      // Check Safe balance
      let safeBalance = 0n;
      if (multisig !== ethers.ZeroAddress) {
        safeBalance = await olas.balanceOf(multisig);
      }

      const hasLocked = bonded > 0n || safeBalance > 0n || isStaked;

      if (hasLocked) {
        console.log(`\n📦 Service ${serviceId}`);
        console.log(`   Owner: ${owner}`);
        console.log(`   Safe: ${multisig}`);
        console.log(`   State: ${state} (4=DEPLOYED, 5=DEPLOYED_AND_STAKED)`);
        console.log(`   Bonded: ${ethers.formatEther(bonded)} OLAS`);
        if (isStaked) {
          console.log(`   Staked: ~50 OLAS (estimated)`);
        }
        if (safeBalance > 0n) {
          console.log(`   Safe Balance: ${ethers.formatEther(safeBalance)} OLAS`);
        }

        totalBonded += bonded;
        totalStaked += stakedAmount;
        totalInSafes += safeBalance;

        recoverableServices.push({
          id: serviceId,
          safe: multisig,
          bonded: ethers.formatEther(bonded),
          staked: isStaked ? '~50' : '0',
          safeBalance: ethers.formatEther(safeBalance),
        });
      }

    } catch (err: any) {
      console.error(`Service ${serviceId}: Error - ${err.message}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('📊 Total Locked Funds:');
  console.log(`   Bonded (in service contracts): ${ethers.formatEther(totalBonded)} OLAS`);
  console.log(`   Staked (in staking contract): ${ethers.formatEther(totalStaked)} OLAS`);
  console.log(`   In Safes: ${ethers.formatEther(totalInSafes)} OLAS`);
  console.log(`   TOTAL: ${ethers.formatEther(totalBonded + totalStaked + totalInSafes)} OLAS`);
  console.log('═══════════════════════════════════════════════════════\n');

  if (recoverableServices.length > 0) {
    console.log('💰 Services with Recoverable Funds:\n');
    recoverableServices.forEach(s => {
      console.log(`Service ${s.id}:`);
      console.log(`  Safe: ${s.safe}`);
      console.log(`  Bonded: ${s.bonded} OLAS`);
      console.log(`  Staked: ${s.staked} OLAS`);
      console.log(`  Safe Balance: ${s.safeBalance} OLAS`);
      console.log(`  BaseScan: https://basescan.org/address/${s.safe}`);
      console.log('');
    });

    console.log('\n💡 To recover funds:');
    console.log('   1. Unstake services (if staked)');
    console.log('   2. Terminate services (returns bonds)');
    console.log('   3. Transfer from Safes to Master Safe');
  }
}

main().catch(console.error);

