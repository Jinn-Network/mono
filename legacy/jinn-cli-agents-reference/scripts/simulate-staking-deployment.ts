#!/usr/bin/env tsx
/**
 * Simulate DeliveryActivityChecker + Staking Contract deployment via Tenderly Virtual TestNet.
 *
 * Uses a Tenderly Virtual TestNet (sequential transactions preserve state) to simulate:
 *   1. Deploy DeliveryActivityChecker
 *   2. Create staking instance via StakingFactory
 *   3. Verify the resulting state
 *
 * This avoids the single-simulation state_objects limitation where immutable variables
 * (baked into runtime bytecode by the compiler) are zeroed out.
 *
 * Requires: OPERATE_PASSWORD, OPERATE_PROFILE_DIR, TENDERLY_ACCESS_KEY,
 *           TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG
 */

import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { ethers, Interface, ContractFactory } from 'ethers';
import { getMasterPrivateKey } from 'jinn-node/env/operate-profile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env.test') });
dotenv.config({ path: path.resolve(__dirname, '../jinn-node/.env') });

// ============================================================================
// Config (matches deploy-jin-staking.ts)
// ============================================================================

const BASE_ADDRESSES = {
  StakingFactory: '0x1cEe30D08943EB58EFF84DD1AB44a6ee6FEff63a',
  StakingToken: '0xEB5638eefE289691EcE01943f768EDBF96258a80',
  ServiceRegistryL2: '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE',
  ServiceRegistryTokenUtility: '0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5',
  MechMarketplace: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020',
  OLASToken: '0x54330d28ca3357F294334BDC454a032e7f353416',
};

const LIVENESS_RATIO = 694444444444444n;
const AGENT_ID = 103;

const STAKING_PARAMS = {
  // Must be non-zero — StakingVerifier checks this. Use a dummy hash for simulation.
  metadataHash: '0x' + '1'.padStart(64, '0'),
  maxNumServices: 100,
  rewardsPerSecond: 475646879756468n,
  minStakingDeposit: ethers.parseEther('5000'),
  minNumStakingPeriods: 3,
  maxNumInactivityPeriods: 2,
  livenessPeriod: 86400,
  timeForEmissions: 30 * 24 * 60 * 60,
  numAgentInstances: 1,
  agentIds: [AGENT_ID],
  threshold: 0,
  configHash: ethers.ZeroHash,
  proxyHash: '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000',
};

// ============================================================================
// Tenderly Virtual TestNet Helpers
// ============================================================================

const TENDERLY_API_BASE = () => {
  const { TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG } = process.env;
  return `https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT_SLUG}/project/${TENDERLY_PROJECT_SLUG}`;
};

const authHeaders = () => ({
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'X-Access-Key': process.env.TENDERLY_ACCESS_KEY!,
});

async function createVirtualTestNet(networkId: number): Promise<{ vnetId: string; adminRpcUrl: string }> {
  const url = `${TENDERLY_API_BASE()}/vnets`;
  const slug = `staking-sim-${Date.now()}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      slug,
      display_name: `Staking Deployment Sim ${new Date().toISOString().slice(0, 19)}`,
      fork_config: {
        network_id: networkId,
        block_number: 'latest',
      },
      virtual_network_config: {
        chain_config: {
          chain_id: networkId,
        },
      },
      sync_state_config: {
        enabled: false,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Tenderly VNet creation failed ${res.status}: ${errText.slice(0, 1000)}`);
  }

  const data = await res.json();
  const vnetId = data.id;

  // Extract Admin RPC URL from rpcs array
  const adminRpc = data.rpcs?.find((r: any) => r.name === 'Admin RPC');
  if (!adminRpc?.url) {
    console.log('  VNet response rpcs:', JSON.stringify(data.rpcs, null, 2));
    throw new Error('Could not find Admin RPC URL in VNet response');
  }

  return { vnetId, adminRpcUrl: adminRpc.url };
}

async function deleteVirtualTestNet(vnetId: string): Promise<void> {
  const url = `${TENDERLY_API_BASE()}/vnets/${vnetId}`;
  await fetch(url, {
    method: 'DELETE',
    headers: authHeaders(),
  });
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG } = process.env;
  if (!TENDERLY_ACCESS_KEY || !TENDERLY_ACCOUNT_SLUG || !TENDERLY_PROJECT_SLUG) {
    console.error('Missing Tenderly env vars');
    process.exit(1);
  }

  console.log('== Step 1: Decrypt wallet ==');
  const pk = getMasterPrivateKey();
  if (!pk) { console.error('No private key'); process.exit(1); }

  console.log('\n== Step 2: Create Tenderly Virtual TestNet (Base mainnet fork) ==');
  const { vnetId, adminRpcUrl } = await createVirtualTestNet(8453);
  console.log(`  VNet ID: ${vnetId}`);
  console.log(`  Admin RPC: ${adminRpcUrl}`);

  try {
    // Connect wallet to the Virtual TestNet RPC
    const provider = new ethers.JsonRpcProvider(adminRpcUrl);
    const wallet = new ethers.Wallet(pk, provider);
    console.log('  Sender:', wallet.address);

    // Fund the sender on the virtual testnet
    await provider.send('tenderly_setBalance', [
      [wallet.address],
      ethers.toQuantity(ethers.parseEther('10')),
    ]);
    console.log('  Funded sender with 10 ETH on virtual testnet');

    // ── Step 3: Deploy DeliveryActivityChecker ──
    console.log('\n== Step 3: Deploy DeliveryActivityChecker ==');

    const artifactPath = path.resolve(__dirname,
      '../contracts/staking/artifacts/staking/DeliveryActivityChecker.sol/DeliveryActivityChecker.json');
    if (!fs.existsSync(artifactPath)) {
      console.error('Contract artifact not found. Run: cd contracts && yarn compile');
      process.exit(1);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

    const checkerFactory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
    const checker = await checkerFactory.deploy(
      BASE_ADDRESSES.MechMarketplace,
      LIVENESS_RATIO,
    );
    const checkerReceipt = await checker.deploymentTransaction()!.wait();
    const checkerAddress = await checker.getAddress();

    console.log(`  Deployed to: ${checkerAddress}`);
    console.log(`  Gas used: ${checkerReceipt!.gasUsed.toString()}`);
    console.log(`  Block: ${checkerReceipt!.blockNumber}`);

    // Verify immutables
    const checkerContract = new ethers.Contract(checkerAddress, artifact.abi, provider);
    const readMechMarketplace = await checkerContract.mechMarketplace();
    const readLivenessRatio = await checkerContract.livenessRatio();
    console.log(`  mechMarketplace(): ${readMechMarketplace}`);
    console.log(`  livenessRatio(): ${readLivenessRatio}`);

    if (readMechMarketplace !== BASE_ADDRESSES.MechMarketplace) {
      console.error('  ERROR: mechMarketplace mismatch!');
      process.exit(1);
    }
    if (readLivenessRatio !== LIVENESS_RATIO) {
      console.error('  ERROR: livenessRatio mismatch!');
      process.exit(1);
    }
    console.log('  Immutables verified OK');

    // ── Step 4: Call StakingFactory.createStakingInstance ──
    console.log('\n== Step 4: Create staking instance via StakingFactory ==');
    console.log('  Agent IDs:', STAKING_PARAMS.agentIds);
    console.log('  Max services:', STAKING_PARAMS.maxNumServices);
    console.log('  Activity checker:', checkerAddress);

    const stakingTokenIface = new Interface([
      'function initialize((bytes32 metadataHash, uint256 maxNumServices, uint256 rewardsPerSecond, uint256 minStakingDeposit, uint256 minNumStakingPeriods, uint256 maxNumInactivityPeriods, uint256 livenessPeriod, uint256 timeForEmissions, uint256 numAgentInstances, uint256[] agentIds, uint256 threshold, bytes32 configHash, bytes32 proxyHash, address serviceRegistry, address activityChecker) stakingParams, address serviceRegistryTokenUtility, address stakingToken)',
    ]);

    const initPayload = stakingTokenIface.encodeFunctionData('initialize', [
      [
        STAKING_PARAMS.metadataHash,
        STAKING_PARAMS.maxNumServices,
        STAKING_PARAMS.rewardsPerSecond,
        STAKING_PARAMS.minStakingDeposit,
        STAKING_PARAMS.minNumStakingPeriods,
        STAKING_PARAMS.maxNumInactivityPeriods,
        STAKING_PARAMS.livenessPeriod,
        STAKING_PARAMS.timeForEmissions,
        STAKING_PARAMS.numAgentInstances,
        STAKING_PARAMS.agentIds,
        STAKING_PARAMS.threshold,
        STAKING_PARAMS.configHash,
        STAKING_PARAMS.proxyHash,
        BASE_ADDRESSES.ServiceRegistryL2,
        checkerAddress,
      ],
      BASE_ADDRESSES.ServiceRegistryTokenUtility,
      BASE_ADDRESSES.OLASToken,
    ]);

    const factoryIface = new Interface([
      'function createStakingInstance(address implementation, bytes initPayload) returns (address payable instance)',
      'event InstanceCreated(address indexed sender, address indexed instance, address indexed implementation)',
    ]);
    const factoryCalldata = factoryIface.encodeFunctionData('createStakingInstance', [
      BASE_ADDRESSES.StakingToken,
      initPayload,
    ]);

    // First do a staticCall to get the revert reason if any
    try {
      const staticResult = await provider.call({
        from: wallet.address,
        to: BASE_ADDRESSES.StakingFactory,
        data: factoryCalldata,
        gasLimit: 5000000,
      });
      console.log('  Static call succeeded, return data:', staticResult.slice(0, 130) + '...');
    } catch (err: any) {
      console.error('  Static call REVERTED:');
      console.error('    reason:', err.reason || 'unknown');
      console.error('    data:', err.data || 'none');
      console.error('    message:', err.shortMessage || err.message?.slice(0, 200));
      // Try to decode the revert data
      if (err.data && err.data !== '0x') {
        try {
          const decoded = ethers.toUtf8String('0x' + err.data.slice(138));
          console.error('    decoded:', decoded);
        } catch { /* ignore */ }
        // Try standard Error(string) selector: 0x08c379a0
        if (err.data.startsWith('0x08c379a0')) {
          try {
            const errIface = new Interface(['function Error(string)']);
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + err.data.slice(10));
            console.error('    Error(string):', decoded[0]);
          } catch { /* ignore */ }
        }
      }
      process.exit(1);
    }

    const factoryTx = await wallet.sendTransaction({
      to: BASE_ADDRESSES.StakingFactory,
      data: factoryCalldata,
      gasLimit: 5000000,
    });

    const factoryReceipt = await factoryTx.wait();
    console.log(`  Status: ${factoryReceipt!.status === 1 ? 'SUCCESS' : 'REVERTED'}`);
    console.log(`  Gas used: ${factoryReceipt!.gasUsed.toString()}`);
    console.log(`  Block: ${factoryReceipt!.blockNumber}`);

    if (factoryReceipt!.status !== 1) {
      console.error('\n  Staking instance creation REVERTED.');
      process.exit(1);
    }

    // Parse InstanceCreated event
    let stakingAddress = '';
    const INSTANCE_CREATED_TOPIC = ethers.id('InstanceCreated(address,address,address)');
    for (const log of factoryReceipt!.logs) {
      if (log.topics[0] === INSTANCE_CREATED_TOPIC) {
        stakingAddress = '0x' + log.topics[2].slice(26);
        break;
      }
    }

    console.log(`  Staking contract: ${stakingAddress}`);

    // ── Step 5: Verify staking contract state ──
    console.log('\n== Step 5: Verify staking contract state ==');

    const stakingAbi = [
      'function getAgentIds() view returns (uint256[] memory)',
      'function maxNumServices() view returns (uint256)',
      'function rewardsPerSecond() view returns (uint256)',
      'function minStakingDeposit() view returns (uint256)',
      'function livenessPeriod() view returns (uint256)',
      'function timeForEmissions() view returns (uint256)',
      'function numAgentInstances() view returns (uint256)',
      'function activityChecker() view returns (address)',
      'function serviceRegistry() view returns (address)',
    ];

    const staking = new ethers.Contract(stakingAddress, stakingAbi, provider);

    const agentIds = await staking.getAgentIds();
    const maxServices = await staking.maxNumServices();
    const rewardsPerSec = await staking.rewardsPerSecond();
    const minDeposit = await staking.minStakingDeposit();
    const livenessPeriod = await staking.livenessPeriod();
    const timeForEmissions = await staking.timeForEmissions();
    const numInstances = await staking.numAgentInstances();
    const activityCheckerAddr = await staking.activityChecker();
    const serviceRegistry = await staking.serviceRegistry();

    console.log(`  agentIds: [${agentIds.join(', ')}]`);
    console.log(`  maxNumServices: ${maxServices}`);
    console.log(`  rewardsPerSecond: ${rewardsPerSec}`);
    console.log(`  minStakingDeposit: ${ethers.formatEther(minDeposit)} OLAS`);
    console.log(`  livenessPeriod: ${livenessPeriod}s`);
    console.log(`  timeForEmissions: ${timeForEmissions}s (${Number(timeForEmissions) / 86400} days)`);
    console.log(`  numAgentInstances: ${numInstances}`);
    console.log(`  activityChecker: ${activityCheckerAddr}`);
    console.log(`  serviceRegistry: ${serviceRegistry}`);

    // Verify critical params
    const errors: string[] = [];
    if (agentIds.length !== 1 || Number(agentIds[0]) !== AGENT_ID) {
      errors.push(`agentIds mismatch: expected [${AGENT_ID}], got [${agentIds.join(', ')}]`);
    }
    if (Number(maxServices) !== STAKING_PARAMS.maxNumServices) {
      errors.push(`maxNumServices mismatch: expected ${STAKING_PARAMS.maxNumServices}, got ${maxServices}`);
    }
    if (activityCheckerAddr.toLowerCase() !== checkerAddress.toLowerCase()) {
      errors.push(`activityChecker mismatch: expected ${checkerAddress}, got ${activityCheckerAddr}`);
    }
    if (serviceRegistry.toLowerCase() !== BASE_ADDRESSES.ServiceRegistryL2.toLowerCase()) {
      errors.push(`serviceRegistry mismatch: expected ${BASE_ADDRESSES.ServiceRegistryL2}, got ${serviceRegistry}`);
    }

    if (errors.length > 0) {
      console.error('\n  VERIFICATION FAILED:');
      for (const err of errors) console.error(`    - ${err}`);
      process.exit(1);
    }

    console.log('\n== Summary ==');
    console.log(`  DeliveryActivityChecker: ${checkerAddress}`);
    console.log(`  Staking contract: ${stakingAddress}`);
    console.log(`  Agent IDs: [${STAKING_PARAMS.agentIds.join(', ')}]`);
    console.log(`  Max services: ${STAKING_PARAMS.maxNumServices}`);
    console.log(`  Liveness ratio: ${LIVENESS_RATIO.toString()}`);
    console.log(`  All verifications PASSED`);
    console.log(`\n  Both transactions would succeed on-chain.`);

  } finally {
    // Clean up virtual testnet
    console.log('\n  Cleaning up Virtual TestNet...');
    await deleteVirtualTestNet(vnetId);
    console.log('  Virtual TestNet deleted.');
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
