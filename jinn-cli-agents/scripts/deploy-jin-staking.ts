#!/usr/bin/env ts-node

/**
 * Deploy JIN Custom OLAS Staking Contract on Base
 * 
 * This script deploys:
 * 1. WhitelistedRequesterActivityChecker - Custom activity checker with whitelist
 * 2. Creates a staking instance via StakingFactory
 * 
 * Uses the master wallet from .operate/wallets/ethereum.txt (encrypted keystore)
 * Ownership goes to Master Safe on Base.
 * 
 * Prerequisites:
 * - Compile contracts with: cd contracts && yarn compile
 * - Set OPERATE_PASSWORD in .env
 * 
 * Environment Variables:
 *   OPERATE_PASSWORD - Password to decrypt the master wallet keystore
 *   BASE_RPC_URL - Base mainnet RPC URL (default: https://mainnet.base.org)
 *
 * Usage:
 *   yarn tsx scripts/deploy-jin-staking.ts
 *   yarn tsx scripts/deploy-jin-staking.ts --dry-run
 *   yarn tsx scripts/deploy-jin-staking.ts --agent-id=103
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Import operate profile helpers
import { getMasterSafe, getMasterEOA } from 'jinn-node/env/operate-profile.js';

// ============================================================================
// IPFS METADATA UPLOAD
// ============================================================================

const REGISTRY_ADD_URL = 'https://registry.autonolas.tech/api/v0/add';

/**
 * Upload staking contract metadata to IPFS and return the metadataHash (bytes32)
 * 
 * IMPORTANT: The metadataHash must be a valid IPFS CID hash (SHA256), NOT keccak256!
 * The Autonolas gateway constructs URLs as: f01701220{sha256_hash}
 */
async function uploadMetadataToIPFS(): Promise<string> {
  const FormData = (await import('form-data')).default;
  const axios = (await import('axios')).default;
  
  const metadata = {
    name: 'Jinn Mech Marketplace Staking',
    description: 'Custom staking contract for Jinn mechs with whitelisted activity checking. Requires 5,000 OLAS minimum deposit. Activity verified via MechMarketplace requests from whitelisted MECs only.'
  };
  
  console.log('📤 Uploading metadata to IPFS...');
  console.log('   Metadata:', JSON.stringify(metadata));
  
  const formData = new FormData();
  const jsonBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');
  formData.append('file', jsonBuffer, { filename: 'metadata.json', contentType: 'application/json' });
  
  const params = { pin: 'true', 'cid-version': '1', 'wrap-with-directory': 'false' };
  
  const response = await axios.post(REGISTRY_ADD_URL, formData, {
    params,
    timeout: 60000,
    responseType: 'text',
    headers: formData.getHeaders(),
  });
  
  if (response.status !== 200) {
    throw new Error(`IPFS upload failed with status ${response.status}`);
  }
  
  // Parse the CID from response
  let cid: string | null = null;
  for (const line of String(response.data).trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.Hash) cid = entry.Hash;
    } catch {}
  }
  
  if (!cid) {
    throw new Error('No IPFS hash returned from upload');
  }
  
  console.log('   ✅ Uploaded to IPFS');
  console.log('   CID:', cid);
  console.log('   Gateway URL:', `https://gateway.autonolas.tech/ipfs/${cid}`);
  
  // Convert CID to bytes32 metadataHash
  // The CID is base32-encoded (bafkrei...), we need to extract the SHA256 hash
  // For raw codec CIDv1: the bytes are 01 (version) + 55 (raw codec) + 12 (sha256) + 20 (32 bytes) + hash
  // We need just the 32-byte hash
  
  const { base32 } = await import('multiformats/bases/base32');
  const cidBytes = base32.decode(cid);
  // Skip: 01 (cidv1) + 55 (raw) + 12 (sha256) + 20 (32 bytes) = 4 bytes prefix
  const hashBytes = cidBytes.slice(4);
  const metadataHash = '0x' + Buffer.from(hashBytes).toString('hex');
  
  console.log('   MetadataHash (bytes32):', metadataHash);
  
  return metadataHash;
}

// ============================================================================
// CONTRACT ADDRESSES - Base Mainnet
// ============================================================================

const BASE_ADDRESSES = {
  // OLAS Infrastructure
  StakingFactory: '0x1cEe30D08943EB58EFF84DD1AB44a6ee6FEff63a',
  StakingToken: '0xEB5638eefE289691EcE01943f768EDBF96258a80', // Implementation
  StakingVerifier: '0x10c5525F77F13b28f42c5626240c001c2D57CAd4',
  ServiceRegistryL2: '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE',
  ServiceRegistryTokenUtility: '0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5',
  MechMarketplace: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020',
  OLASToken: '0x54330d28ca3357F294334BDC454a032e7f353416',
  
  // Reference contracts
  AgentsFun1Staking: '0x2585e63df7BD9De8e058884D496658a030b5c6ce',
  RequesterActivityChecker: '0x87C9922A099467E5A80367553e7003349FE50106',
} as const;

// ============================================================================
// STAKING PARAMETERS - Customize these for JIN
// ============================================================================

const STAKING_PARAMS = {
  // Metadata hash - MUST be a valid IPFS CID hash, NOT a keccak256 hash!
  // This is set during deployment after uploading metadata to IPFS.
  // See uploadMetadataToIPFS() function below.
  // DO NOT use: ethers.keccak256(ethers.toUtf8Bytes('...'))
  metadataHash: '' as string, // Set by uploadMetadataToIPFS() during deployment
  
  // Maximum number of services that can stake
  maxNumServices: 100,
  
  // Rewards per second (in OLAS wei)
  // 300% APY with 5000 OLAS min stake:
  // rewardsPerYear = 5000 * 3 = 15000 OLAS
  // rewardsPerSecond = 15000e18 / 31536000 ≈ 4.756e14 wei
  rewardsPerSecond: BigInt('475646879756468'),  // ~575 OLAS per service per 14-day epoch
  
  // Minimum staking deposit required (in OLAS wei)
  // 5,000 OLAS per service
  minStakingDeposit: ethers.parseEther('5000'),
  
  // Minimum number of staking periods before unstaking allowed
  minNumStakingPeriods: 3,
  
  // Max inactivity periods before eviction
  maxNumInactivityPeriods: 2,
  
  // Liveness period in seconds (24 hours)
  livenessPeriod: 86400,
  
  // Time for emissions in seconds (30 days - verifier limit)
  timeForEmissions: 30 * 24 * 60 * 60, // 2592000 seconds
  
  // Number of agent instances per service
  numAgentInstances: 1,
  
  // Required agent IDs - set via --agent-id=N CLI param (default: 43 for backward compat)
  agentIds: [43] as number[],
  
  // Optional: required threshold (0 = any threshold)
  threshold: 0,
  
  // Optional: required config hash (bytes32(0) = any config)
  configHash: ethers.ZeroHash,
  
  // Proxy hash for Gnosis Safe multisig verification
  proxyHash: '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000',
};

// Liveness ratio for activity checker
// 694444444444444 = 60 mech requests per day requirement
const LIVENESS_RATIO = BigInt('694444444444444');

// ============================================================================
// ABIs
// ============================================================================

const STAKING_FACTORY_ABI = [
  'function createStakingInstance(address implementation, bytes initPayload) returns (address payable instance)',
  'function getProxyAddress(address implementation) view returns (address)',
  'function nonce() view returns (uint256)',
  'event InstanceCreated(address indexed sender, address indexed instance, address indexed implementation)',
];

const STAKING_TOKEN_ABI = [
  'function initialize((bytes32 metadataHash, uint256 maxNumServices, uint256 rewardsPerSecond, uint256 minStakingDeposit, uint256 minNumStakingPeriods, uint256 maxNumInactivityPeriods, uint256 livenessPeriod, uint256 timeForEmissions, uint256 numAgentInstances, uint256[] agentIds, uint256 threshold, bytes32 configHash, bytes32 proxyHash, address serviceRegistry, address activityChecker) stakingParams, address serviceRegistryTokenUtility, address stakingToken)',
];

// DeliveryActivityChecker ABI (permissionless — no whitelist)
const ACTIVITY_CHECKER_ABI = [
  'constructor(address _mechMarketplace, uint256 _livenessRatio)',
  'function livenessRatio() view returns (uint256)',
  'function mechMarketplace() view returns (address)',
];

// ============================================================================
// DEPLOYMENT FUNCTIONS
// ============================================================================

interface DeploymentConfig {
  rpcUrl: string;
  deployerPrivateKey: string;
  masterEOA: string;
  masterSafe: string;
  dryRun: boolean;
  existingActivityChecker?: string; // Reuse existing activity checker
}

async function loadMasterWalletPrivateKey(): Promise<string> {
  // Check for direct private key first
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    console.log('Using DEPLOYER_PRIVATE_KEY from environment');
    return process.env.DEPLOYER_PRIVATE_KEY;
  }

  const password = process.env.OPERATE_PASSWORD;
  if (!password) {
    throw new Error('Either DEPLOYER_PRIVATE_KEY or OPERATE_PASSWORD must be set');
  }

  // Find the keystore file
  const keystorePath = path.resolve(
    process.cwd(),
    'olas-operate-middleware/.operate/wallets/ethereum.txt'
  );

  if (!fs.existsSync(keystorePath)) {
    throw new Error(`Master wallet keystore not found at ${keystorePath}`);
  }

  // Use Python to decrypt (ethers v6 has scrypt parameter constraints)
  console.log('Decrypting master wallet keystore via Python...');
  const { execSync } = await import('child_process');
  
  try {
    const privateKey = execSync(
      `python3 -c "
from eth_account import Account
import json
with open('${keystorePath}') as f:
    keystore = json.load(f)
private_key = Account.decrypt(keystore, '${password}')
h = private_key.hex()
print(h if h.startswith('0x') else '0x' + h)
"`,
      { encoding: 'utf8', cwd: process.cwd() }
    ).trim();
    
    const wallet = new ethers.Wallet(privateKey);
    console.log(`✅ Master wallet decrypted: ${wallet.address}`);
    
    return privateKey;
  } catch (error) {
    throw new Error(`Failed to decrypt keystore: ${error}`);
  }
}

async function getDeploymentConfig(): Promise<DeploymentConfig> {
  // Load master wallet addresses from operate profile
  const masterEOA = getMasterEOA();
  const masterSafe = getMasterSafe('base');

  if (!masterEOA) {
    throw new Error('Master EOA not found in .operate/wallets/ethereum.json');
  }
  if (!masterSafe) {
    throw new Error('Master Safe for Base not found in .operate/wallets/ethereum.json');
  }

  console.log(`Master EOA: ${masterEOA}`);
  console.log(`Master Safe (Base): ${masterSafe}`);

  const dryRun = process.argv.includes('--dry-run');

  // Parse --agent-id=N from CLI args
  const agentIdArg = process.argv.find(a => a.startsWith('--agent-id='));
  if (agentIdArg) {
    const parsedId = parseInt(agentIdArg.split('=')[1], 10);
    if (isNaN(parsedId) || parsedId <= 0) {
      throw new Error(`Invalid --agent-id value: ${agentIdArg}`);
    }
    STAKING_PARAMS.agentIds = [parsedId];
    console.log(`Agent ID override: ${parsedId}`);
  }

  // Allow reusing an existing activity checker
  const existingActivityChecker = process.env.ACTIVITY_CHECKER_ADDRESS;
  if (existingActivityChecker && !ethers.isAddress(existingActivityChecker)) {
    throw new Error('ACTIVITY_CHECKER_ADDRESS must be a valid Ethereum address');
  }

  // Load the private key (only if not dry run)
  let deployerPrivateKey = '';
  if (!dryRun) {
    deployerPrivateKey = await loadMasterWalletPrivateKey();
  }

  return {
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    deployerPrivateKey,
    masterEOA,
    masterSafe,
    dryRun,
    existingActivityChecker,
  };
}

async function deployActivityChecker(
  wallet: ethers.Wallet,
  config: DeploymentConfig
): Promise<string> {
  console.log('\n📋 Step 2: Deploy DeliveryActivityChecker');
  console.log('═'.repeat(60));

  // Load the compiled contract bytecode
  // Try DeliveryActivityChecker first, fall back to WhitelistedRequesterActivityChecker
  let artifactPath = path.resolve(
    process.cwd(),
    'contracts/staking/artifacts/staking/DeliveryActivityChecker.sol/DeliveryActivityChecker.json'
  );
  if (!fs.existsSync(artifactPath)) {
    artifactPath = path.resolve(
      process.cwd(),
      'contracts/staking/artifacts/staking/WhitelistedRequesterActivityChecker.sol/WhitelistedRequesterActivityChecker.json'
    );
  }
  
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Contract artifact not found at ${artifactPath}.\n` +
      'Please compile the contracts first:\n' +
      '  cd contracts && yarn compile'
    );
  }
  
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  
  console.log('Constructor arguments:');
  console.log(`  mechMarketplace: ${BASE_ADDRESSES.MechMarketplace}`);
  console.log(`  livenessRatio: ${LIVENESS_RATIO}`);

  if (config.dryRun) {
    console.log('\n⚠️  DRY RUN - Skipping deployment');
    return '0x0000000000000000000000000000000000000000';
  }

  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet
  );

  console.log('\nDeploying...');
  const contract = await factory.deploy(
    BASE_ADDRESSES.MechMarketplace,
    LIVENESS_RATIO
  );
  
  await contract.waitForDeployment();
  const activityCheckerAddress = await contract.getAddress();
  
  console.log(`✅ ActivityChecker deployed: ${activityCheckerAddress}`);
  console.log(`   BaseScan: https://basescan.org/address/${activityCheckerAddress}`);
  
  return activityCheckerAddress;
}

async function createStakingInstance(
  wallet: ethers.Wallet,
  activityCheckerAddress: string,
  config: DeploymentConfig
): Promise<string> {
  console.log('\n📋 Step 3: Create Staking Instance via StakingFactory');
  console.log('═'.repeat(60));
  
  const stakingFactory = new ethers.Contract(
    BASE_ADDRESSES.StakingFactory,
    STAKING_FACTORY_ABI,
    wallet
  );
  
  // Build the StakingParams struct
  const stakingParams = {
    metadataHash: STAKING_PARAMS.metadataHash,
    maxNumServices: STAKING_PARAMS.maxNumServices,
    rewardsPerSecond: STAKING_PARAMS.rewardsPerSecond,
    minStakingDeposit: STAKING_PARAMS.minStakingDeposit,
    minNumStakingPeriods: STAKING_PARAMS.minNumStakingPeriods,
    maxNumInactivityPeriods: STAKING_PARAMS.maxNumInactivityPeriods,
    livenessPeriod: STAKING_PARAMS.livenessPeriod,
    timeForEmissions: STAKING_PARAMS.timeForEmissions,
    numAgentInstances: STAKING_PARAMS.numAgentInstances,
    agentIds: STAKING_PARAMS.agentIds,
    threshold: STAKING_PARAMS.threshold,
    configHash: STAKING_PARAMS.configHash,
    proxyHash: STAKING_PARAMS.proxyHash,
    serviceRegistry: BASE_ADDRESSES.ServiceRegistryL2,
    activityChecker: activityCheckerAddress,
  };
  
  console.log('Staking Parameters:');
  console.log(`  maxNumServices: ${stakingParams.maxNumServices}`);
  console.log(`  rewardsPerSecond: ${ethers.formatEther(stakingParams.rewardsPerSecond)} OLAS/sec`);
  console.log(`  minStakingDeposit: ${ethers.formatEther(stakingParams.minStakingDeposit)} OLAS`);
  console.log(`  livenessPeriod: ${stakingParams.livenessPeriod} seconds (${stakingParams.livenessPeriod / 3600} hours)`);
  console.log(`  timeForEmissions: ${stakingParams.timeForEmissions} seconds (${stakingParams.timeForEmissions / 86400} days)`);
  console.log(`  serviceRegistry: ${stakingParams.serviceRegistry}`);
  console.log(`  activityChecker: ${stakingParams.activityChecker}`);
  
  // Encode the initialize function call
  const stakingTokenInterface = new ethers.Interface(STAKING_TOKEN_ABI);
  const initPayload = stakingTokenInterface.encodeFunctionData('initialize', [
    [
      stakingParams.metadataHash,
      stakingParams.maxNumServices,
      stakingParams.rewardsPerSecond,
      stakingParams.minStakingDeposit,
      stakingParams.minNumStakingPeriods,
      stakingParams.maxNumInactivityPeriods,
      stakingParams.livenessPeriod,
      stakingParams.timeForEmissions,
      stakingParams.numAgentInstances,
      stakingParams.agentIds,
      stakingParams.threshold,
      stakingParams.configHash,
      stakingParams.proxyHash,
      stakingParams.serviceRegistry,
      stakingParams.activityChecker,
    ],
    BASE_ADDRESSES.ServiceRegistryTokenUtility,
    BASE_ADDRESSES.OLASToken,
  ]);
  
  if (config.dryRun) {
    console.log('\n⚠️  DRY RUN - Skipping staking instance creation');
    return '0x0000000000000000000000000000000000000000';
  }

  // Get predicted address
  const predictedAddress = await stakingFactory.getProxyAddress(BASE_ADDRESSES.StakingToken);
  console.log(`\nPredicted staking contract address: ${predictedAddress}`);
  
  console.log('\nCreating staking instance...');
  const tx = await stakingFactory.createStakingInstance(
    BASE_ADDRESSES.StakingToken,
    initPayload
  );
  
  console.log(`Transaction hash: ${tx.hash}`);
  const receipt = await tx.wait();
  
  // Parse the InstanceCreated event
  const instanceCreatedEvent = receipt.logs.find(
    (log: any) => log.topics[0] === ethers.id('InstanceCreated(address,address,address)')
  );
  
  let stakingContractAddress: string;
  if (instanceCreatedEvent) {
    stakingContractAddress = ethers.getAddress('0x' + instanceCreatedEvent.topics[2].slice(26));
  } else {
    stakingContractAddress = predictedAddress;
  }
  
  console.log(`✅ Staking contract created: ${stakingContractAddress}`);
  console.log(`   BaseScan: https://basescan.org/address/${stakingContractAddress}`);
  
  return stakingContractAddress;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('🚀 JIN Custom OLAS Staking Contract Deployment');
  console.log('═'.repeat(60));
  
  try {
    const config = await getDeploymentConfig();
    
    console.log('\n📋 Configuration:');
    console.log(`   Network: Base Mainnet`);
    console.log(`   RPC URL: ${config.rpcUrl}`);
    console.log(`   Dry Run: ${config.dryRun}`);
    console.log(`   Master EOA: ${config.masterEOA}`);
    console.log(`   Master Safe (Base): ${config.masterSafe}`);
    
    // Setup provider and wallet
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    
    let wallet: ethers.Wallet | null = null;
    if (!config.dryRun) {
      wallet = new ethers.Wallet(config.deployerPrivateKey, provider);
      console.log(`\n   Deployer Address: ${wallet.address}`);
      
      const balance = await provider.getBalance(wallet.address);
      console.log(`   Deployer Balance: ${ethers.formatEther(balance)} ETH`);
      
      if (balance === 0n) {
        throw new Error('Deployer has no ETH for gas. Please fund the deployer address.');
      }
    } else {
      console.log(`\n   Deployer Address: ${config.masterEOA} (dry run - not connected)`);
    }
    
    // Step 1: Upload metadata to IPFS
    console.log('\n📋 Step 1: Upload Metadata to IPFS');
    console.log('═'.repeat(60));
    if (!config.dryRun) {
      STAKING_PARAMS.metadataHash = await uploadMetadataToIPFS();
    } else {
      console.log('⚠️  DRY RUN - Skipping IPFS upload');
      STAKING_PARAMS.metadataHash = ethers.ZeroHash; // placeholder
    }
    
    // Step 2: Deploy Activity Checker (or reuse existing)
    let activityCheckerAddress: string;
    if (config.existingActivityChecker) {
      console.log('\n📋 Step 2: Using Existing Activity Checker');
      console.log('═'.repeat(60));
      console.log(`Using existing activity checker: ${config.existingActivityChecker}`);
      activityCheckerAddress = config.existingActivityChecker;
    } else {
      activityCheckerAddress = await deployActivityChecker(wallet!, config);
    }
    
    // Step 3: Create Staking Instance via StakingFactory
    const stakingContractAddress = await createStakingInstance(
      wallet!,
      activityCheckerAddress,
      config
    );
    
    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('✅ DEPLOYMENT COMPLETE');
    console.log('═'.repeat(60));
    console.log('\n📊 Deployed Contracts:');
    console.log(`   ActivityChecker: ${activityCheckerAddress}`);
    console.log(`   JIN Staking Contract: ${stakingContractAddress}`);
    console.log(`   Agent IDs: [${STAKING_PARAMS.agentIds.join(', ')}]`);
    console.log(`   Max Services: ${STAKING_PARAMS.maxNumServices}`);
    
    console.log('\n📋 Next Steps:');
    console.log('   1. Verify contracts on BaseScan');
    console.log('   2. Fund the staking contract with OLAS for rewards');
    console.log('   3. Nominate on Ethereum mainnet via VoteWeighting');
    console.log('   4. Allocate veOLAS votes to receive emissions');
    
    // Save deployment info
    const deploymentInfo = {
      network: 'base',
      chainId: 8453,
      timestamp: new Date().toISOString(),
      contracts: {
        activityChecker: activityCheckerAddress,
        stakingContract: stakingContractAddress,
      },
      config: {
        livenessRatio: LIVENESS_RATIO.toString(),
        stakingParams: {
          maxNumServices: STAKING_PARAMS.maxNumServices,
          rewardsPerSecond: STAKING_PARAMS.rewardsPerSecond.toString(),
          minStakingDeposit: STAKING_PARAMS.minStakingDeposit.toString(),
          livenessPeriod: STAKING_PARAMS.livenessPeriod,
          timeForEmissions: STAKING_PARAMS.timeForEmissions,
          agentIds: STAKING_PARAMS.agentIds,
        },
      },
      addresses: BASE_ADDRESSES,
    };
    
    const deploymentPath = path.resolve(process.cwd(), 'contracts/staking/deployment.json');
    fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
    console.log(`\n📁 Deployment info saved to: ${deploymentPath}`);
    
  } catch (error) {
    console.error('\n❌ Deployment failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
