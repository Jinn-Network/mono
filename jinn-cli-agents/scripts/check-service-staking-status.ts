#!/usr/bin/env tsx
/**
 * Check staking status of deployed services
 */

import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const STAKING_CONTRACT = '0x2585e63df7BD9De8e058884D496658a030b5c6ce'; // AgentsFun1
const SERVICE_REGISTRY = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';
const SERVICE_REGISTRY_TOKEN_UTILITY = '0x3d77596beb0f130a4415df3D2D8232B3d3D31e44';

// Minimal ABIs
const STAKING_ABI = [
  'function mapServiceInfo(uint256) view returns (address multisig, address owner, uint256 nonces, uint256 tsStart, uint256 reward, bool inactivity)',
  'function getServiceIds() view returns (uint256[])',
];

const REGISTRY_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getService(uint256 serviceId) view returns (address, address, bytes32, uint256[], uint256[], uint256, uint256, uint256)',
];

const TOKEN_UTILITY_ABI = [
  'function mapServiceIdTokenDeposit(uint256) view returns (uint256 securityDeposit, uint256)',
];

const services = [
  { name: 'Service #149 (Master Safe)', tokenId: 149, safe: '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645' },
  { name: 'Service #150 (jinn-mech)', tokenId: 150, safe: '0xbcE25403FE17Cc0C41F334A07ca26cd8890090d9' },
  { name: 'Service #163 (default-service)', tokenId: 163, safe: '0xa70Ea55b009fB50AFae9136049bB1EB52880691e' },
  { name: 'Service #165 (Current)', tokenId: 165, safe: '0xb8B7A89760A4430C3f69eeE7Ba5D2B985D593D92' },
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const staking = new ethers.Contract(STAKING_CONTRACT, STAKING_ABI, provider);
  const registry = new ethers.Contract(SERVICE_REGISTRY, REGISTRY_ABI, provider);
  const tokenUtility = new ethers.Contract(SERVICE_REGISTRY_TOKEN_UTILITY, TOKEN_UTILITY_ABI, provider);
  
  console.log('📊 Service Staking Status Check\n');
  console.log('Staking Contract: AgentsFun1');
  console.log(`Address: ${STAKING_CONTRACT}\n`);
  
  // Get all staked service IDs
  const stakedIds = await staking.getServiceIds();
  console.log(`Currently staked services: ${stakedIds.length}\n`);
  
  for (const svc of services) {
    console.log(`═══════════════════════════════════════════════════════`);
    console.log(`${svc.name}`);
    console.log(`Token ID: ${svc.tokenId}`);
    console.log(`Safe: ${svc.safe}`);
    
    try {
      // Check if service is staked
      const isStaked = stakedIds.some((id: bigint) => Number(id) === svc.tokenId);
      
      if (isStaked) {
        console.log(`\n✅ STAKED in AgentsFun1`);
        
        // Get staking info
        const stakingInfo = await staking.mapServiceInfo(svc.tokenId);
        console.log(`   Staking Start: ${new Date(Number(stakingInfo.tsStart) * 1000).toISOString()}`);
        console.log(`   Accumulated Reward: ${ethers.formatEther(stakingInfo.reward)} OLAS`);
        console.log(`   Inactive: ${stakingInfo.inactivity}`);
      } else {
        console.log(`\n❌ NOT STAKED`);
      }
      
      // Get bond deposit
      const deposit = await tokenUtility.mapServiceIdTokenDeposit(svc.tokenId);
      console.log(`\n💰 Security Deposit (Bond): ${ethers.formatEther(deposit.securityDeposit)} OLAS`);
      
      // Get owner
      const owner = await registry.ownerOf(svc.tokenId);
      console.log(`👤 Owner: ${owner}`);
      
      // Generate links
      console.log(`\n🔗 Links:`);
      console.log(`   Service Registry: https://basescan.org/token/${SERVICE_REGISTRY}?a=${svc.tokenId}`);
      console.log(`   Safe: https://basescan.org/address/${svc.safe}`);
      console.log(`   Safe UI: https://app.safe.global/home?safe=base:${svc.safe}`);
      
      if (isStaked) {
        console.log(`   Staking Contract: https://basescan.org/address/${STAKING_CONTRACT}`);
      }
      
    } catch (err: any) {
      console.error(`\n❌ Error: ${err.message}`);
    }
    
    console.log('');
  }
  
  console.log(`═══════════════════════════════════════════════════════\n`);
  console.log('💡 Summary:');
  console.log('   - Staked services have 50 OLAS locked in staking contract');
  console.log('   - Bond deposits (50 OLAS) are locked in service contract');
  console.log('   - To recover: unstake → terminate → transfer from Safe');
  console.log('   - Total locked per staked service: 100 OLAS');
}

main().catch(console.error);

