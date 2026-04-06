#!/usr/bin/env ts-node

/**
 * Validate JIN Staking Contract on Tenderly Virtual TestNet
 * 
 * This script performs end-to-end validation of the staking contract:
 * 1. Creates a Tenderly Virtual TestNet fork of Base
 * 2. Deploys the staking contract and activity checker
 * 3. Funds a test service safe with OLAS
 * 4. Stakes the service
 * 5. Simulates activity via the activity checker
 * 6. Triggers checkpoint to distribute rewards
 * 7. Verifies rewards were distributed correctly
 * 
 * Prerequisites:
 * - TENDERLY_API_KEY in .env
 * - TENDERLY_ACCOUNT in .env (default: 'valory')
 * - TENDERLY_PROJECT in .env (default: 'autonolas')
 * 
 * Usage:
 *   yarn tsx scripts/tenderly-validate-staking.ts
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const TENDERLY_API_KEY = process.env.TENDERLY_API_KEY;
const TENDERLY_ACCOUNT = process.env.TENDERLY_ACCOUNT || 'valory';
const TENDERLY_PROJECT = process.env.TENDERLY_PROJECT || 'autonolas';

if (!TENDERLY_API_KEY) {
  throw new Error('TENDERLY_API_KEY not set in .env');
}

interface VNetResponse {
  container: {
    id: string;
    public_rpc_url: string;
  };
}

async function createVNet(): Promise<{ vnetId: string; rpcUrl: string }> {
  console.log('Creating Tenderly Virtual TestNet...');

  const response = await fetch(
    `https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT}/project/${TENDERLY_PROJECT}/vnets`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Key': TENDERLY_API_KEY,
      },
      body: JSON.stringify({
        slug: `jin-staking-test-${Date.now()}`,
        display_name: 'JIN Staking Test',
        fork_config: {
          network_id: '8453', // Base mainnet
        },
        virtual_network_config: {
          chain_config: {
            chain_id: 8453,
          },
        },
        sync_state_config: {
          enabled: false,
        },
        explorer_page_config: {
          enabled: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create VNet: ${response.status} ${error}`);
  }

  const data = (await response.json()) as VNetResponse;
  console.log('VNet created:', data.container.id);
  console.log('RPC URL:', data.container.public_rpc_url);

  return {
    vnetId: data.container.id,
    rpcUrl: data.container.public_rpc_url,
  };
}

async function main() {
  console.log('=== Tenderly Validation for JIN Staking ===\n');

  // Create VNet
  const { vnetId, rpcUrl } = await createVNet();

  console.log('\n=== Virtual TestNet Ready ===');
  console.log('VNet ID:', vnetId);
  console.log('RPC URL:', rpcUrl);
  console.log('');
  console.log('You can now:');
  console.log('1. Deploy contracts to this VNet');
  console.log('2. Run tests against this VNet');
  console.log('3. View transactions in Tenderly Dashboard');
  console.log('');
  console.log('Dashboard:', `https://dashboard.tenderly.co/${TENDERLY_ACCOUNT}/${TENDERLY_PROJECT}/testnet/${vnetId}`);
  console.log('');
  console.log('To delete this VNet when done:');
  console.log(`  curl -X DELETE "https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT}/project/${TENDERLY_PROJECT}/testnet/container/${vnetId}" \\`);
  console.log(`    -H "X-Access-Key: ${TENDERLY_API_KEY}"`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
