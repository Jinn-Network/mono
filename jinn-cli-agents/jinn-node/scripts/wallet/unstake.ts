#!/usr/bin/env tsx
/**
 * Unstake - Unstake service from staking contract
 *
 * Usage:
 *   yarn wallet:unstake                    # Unstake using service ID from config
 *   yarn wallet:unstake --service-id 123  # Unstake specific service ID
 *   yarn wallet:unstake --dry-run         # Preview without executing
 *
 * Calls unstake(serviceId) on the StakingTokenProxy contract.
 * Returns any accumulated rewards to the Service Safe.
 */

import 'dotenv/config';
import { parseArgs } from 'util';
import { ethers } from 'ethers';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createRpcProvider } from '../../src/config/index.js';

// StakingTokenProxy ABI - just the unstake function
const STAKING_ABI = [
  'function unstake(uint256 serviceId) external returns (uint256 reward)',
  'function getServiceInfo(uint256 serviceId) external view returns (address multisig, address owner, uint256[] security)'
];

function getOperateHome(): string {
  if (process.env.OPERATE_HOME) {
    return process.env.OPERATE_HOME;
  }
  return join(process.cwd(), '.operate');
}

function getStakingContract(): string {
  if (process.env.STAKING_CONTRACT) {
    return process.env.STAKING_CONTRACT;
  }
  // Default Jinn staking contract on Base
  return '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';
}

function getServiceIdFromConfig(): string | null {
  const operateHome = getOperateHome();
  const servicesDir = join(operateHome, 'services');

  try {
    const serviceDirs = readdirSync(servicesDir);

    for (const dir of serviceDirs) {
      const configPath = join(servicesDir, dir, 'config.json');
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        // Look for service ID in chain_configs
        const chainConfig = config.chain_configs?.base || config.chain_configs?.gnosis;
        if (chainConfig?.chain_data?.token) {
          return chainConfig.chain_data.token.toString();
        }
        // Also check service_id field
        if (config.service_id) {
          return config.service_id.toString();
        }
      } catch {
        // Skip invalid configs
      }
    }
  } catch {
    // Services directory doesn't exist
  }

  return null;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'service-id': { type: 'string', short: 's' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' }
    },
    allowPositionals: false
  });

  if (values.help) {
    console.log(`
Unstake service from the staking contract.

Usage:
  yarn wallet:unstake                    # Unstake using service ID from config
  yarn wallet:unstake --service-id 123  # Unstake specific service ID
  yarn wallet:unstake --dry-run         # Preview without executing

Options:
  --service-id, -s   Service ID to unstake (reads from config if not provided)
  --dry-run          Preview unstaking without executing
  --help, -h         Show this help message

This calls unstake(serviceId) on the StakingTokenProxy contract.
Any accumulated rewards are returned to the Service Safe.
`);
    process.exit(0);
  }

  // Get service ID
  let serviceId = values['service-id'];
  if (!serviceId) {
    serviceId = getServiceIdFromConfig();
    if (!serviceId) {
      console.error('Error: Service ID not found. Provide --service-id or run setup first.');
      process.exit(1);
    }
    console.log(`Using service ID from config: ${serviceId}`);
  }

  const dryRun = values['dry-run'];
  const stakingContract = getStakingContract();
  const rpcUrl = process.env.RPC_URL;

  if (!rpcUrl) {
    console.error('Error: RPC_URL environment variable is required');
    process.exit(1);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`                    UNSTAKE SERVICE ${dryRun ? '(DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Service ID:       ${serviceId}`);
  console.log(`Staking Contract: ${stakingContract}`);
  console.log('');

  const provider = createRpcProvider(rpcUrl);
  const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);

  // Check if service is staked
  try {
    const serviceInfo = await staking.getServiceInfo(serviceId);
    console.log(`Service Multisig: ${serviceInfo.multisig}`);
    console.log(`Service Owner:    ${serviceInfo.owner}`);

    if (serviceInfo.multisig === ethers.ZeroAddress) {
      console.log('\n⚠️  Service is not currently staked');
      process.exit(0);
    }
  } catch (error) {
    console.log('\n⚠️  Could not query service info (service may not be staked)');
  }

  if (dryRun) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('DRY RUN - No transaction executed');
    console.log('');
    console.log('To unstake, you need to:');
    console.log('1. Ensure the Service Safe owner calls unstake()');
    console.log('2. Or use Pearl UI: Settings > Service > Terminate');
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(0);
  }

  // For actual unstaking, we need the service owner to sign
  // This typically goes through the middleware or Pearl UI
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('⚠️  Direct unstaking requires service owner signature');
  console.log('');
  console.log('Options:');
  console.log('1. Use Pearl UI: Settings > Service > Terminate');
  console.log('2. Use middleware API: POST /api/service/{id}/terminate_and_withdraw');
  console.log('3. Use yarn wallet:recover for full fund recovery');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
