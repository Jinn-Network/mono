#!/usr/bin/env tsx
/**
 * Tenderly Virtual TestNet Setup
 * 
 * Creates and configures a Tenderly Virtual TestNet for OLAS service testing.
 * 
 * Steps:
 * 1. Create Virtual TestNet (fork of Base mainnet)
 * 2. Fund Master EOA with ETH
 * 3. Verify OLAS token accessibility
 * 4. Output configuration for env.tenderly
 * 
 * Prerequisites:
 * - TENDERLY_ACCESS_KEY in environment
 * - TENDERLY_ACCOUNT_SLUG in environment
 * - TENDERLY_PROJECT_SLUG in environment
 * 
 * Usage:
 *   yarn tsx scripts/setup-tenderly-vnet.ts
 */

import '../env/index.js';
import { ethers } from 'ethers';
import axios from 'axios';

const TENDERLY_API_BASE = 'https://api.tenderly.co/api/v1';
const BASE_CHAIN_ID = 8453;
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';
const MASTER_EOA = '0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2';

interface TenderlyConfig {
  accessKey: string;
  accountSlug: string;
  projectSlug: string;
}

interface VirtualTestnet {
  id: string;
  name: string;
  rpcUrl: string;
  chainId: number;
}

/**
 * Load Tenderly configuration from environment
 */
function loadTenderlyConfig(): TenderlyConfig {
  const accessKey = process.env.TENDERLY_ACCESS_KEY;
  const accountSlug = process.env.TENDERLY_ACCOUNT_SLUG;
  const projectSlug = process.env.TENDERLY_PROJECT_SLUG;

  if (!accessKey || !accountSlug || !projectSlug) {
    console.error('❌ Missing Tenderly configuration!');
    console.error('');
    console.error('Required environment variables:');
    console.error('  - TENDERLY_ACCESS_KEY');
    console.error('  - TENDERLY_ACCOUNT_SLUG');
    console.error('  - TENDERLY_PROJECT_SLUG');
    console.error('');
    console.error('Get your credentials from: https://dashboard.tenderly.co/account/authorization');
    process.exit(1);
  }

  return { accessKey, accountSlug, projectSlug };
}

/**
 * Create a Virtual TestNet via Tenderly API
 */
async function createVirtualTestnet(config: TenderlyConfig): Promise<VirtualTestnet> {
  console.log('🔨 Creating Tenderly Virtual TestNet...');
  console.log(`   Account: ${config.accountSlug}`);
  console.log(`   Project: ${config.projectSlug}`);
  console.log('');

  const url = `${TENDERLY_API_BASE}/account/${config.accountSlug}/project/${config.projectSlug}/vnets`;
  
  try {
    const response = await axios.post(
      url,
      {
        slug: `olas-service-test-${Date.now()}`,
        display_name: `OLAS Service Test - ${new Date().toISOString().split('T')[0]}`,
        fork_config: {
          network_id: BASE_CHAIN_ID,
        },
        virtual_network_config: {
          chain_config: {
            chain_id: 73571, // Unique chain ID to avoid replay attacks
          },
        },
        sync_state_config: {
          enabled: false,
        },
        explorer_page_config: {
          enabled: true,
          verification_visibility: 'bytecode',
        },
      },
      {
        headers: {
          'X-Access-Key': config.accessKey,
          'Content-Type': 'application/json',
        },
      }
    );

    const vnet = response.data;
    
    // Use the RPC URLs from the response
    const rpcUrl = vnet.rpcs?.[0]?.url || vnet.rpcUrl || `https://virtual.base.rpc.tenderly.co/${vnet.id}`;

    console.log('✅ Virtual TestNet created!');
    console.log(`   ID: ${vnet.id}`);
    console.log(`   Name: ${vnet.display_name}`);
    console.log(`   RPC: ${rpcUrl}`);
    console.log('');

    return {
      id: vnet.id,
      name: vnet.display_name,
      rpcUrl,
      chainId: BASE_CHAIN_ID,
    };
  } catch (error: any) {
    console.error('❌ Failed to create Virtual TestNet:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Message: ${JSON.stringify(error.response.data, null, 2)}`);
    } else {
      console.error(`   ${error.message}`);
    }
    process.exit(1);
  }
}

/**
 * Fund an address with ETH using Tenderly's admin RPC
 */
async function fundWithETH(rpcUrl: string, address: string, amount: string): Promise<void> {
  console.log(`💰 Funding ${address} with ${amount} ETH...`);

  try {
    const response = await axios.post(
      rpcUrl,
      {
        jsonrpc: '2.0',
        method: 'tenderly_setBalance',
        params: [
          [address], // Array of addresses
          ethers.toBeHex(ethers.parseEther(amount)),
        ],
        id: 1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.error) {
      throw new Error(JSON.stringify(response.data.error));
    }

    console.log(`   ✅ ${address} funded with ${amount} ETH`);
  } catch (error: any) {
    if (error.response?.data) {
      console.error(`   ❌ Failed to fund address: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`   ❌ Failed to fund address: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Verify OLAS token is accessible
 */
async function verifyOLASToken(rpcUrl: string): Promise<void> {
  console.log('🔍 Verifying OLAS token accessibility...');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const abi = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
  ];

  try {
    const token = new ethers.Contract(OLAS_TOKEN, abi, provider);
    const [name, symbol, decimals] = await Promise.all([
      token.name(),
      token.symbol(),
      token.decimals(),
    ]);

    console.log(`   ✅ OLAS token found:`);
    console.log(`      Name: ${name}`);
    console.log(`      Symbol: ${symbol}`);
    console.log(`      Decimals: ${decimals}`);
    console.log(`      Address: ${OLAS_TOKEN}`);
  } catch (error: any) {
    console.error(`   ❌ Failed to verify OLAS token: ${error.message}`);
    throw error;
  }
}

/**
 * Output configuration for env.tenderly
 */
function outputConfig(config: TenderlyConfig, vnet: VirtualTestnet): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📋 Configuration for env.tenderly');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('Copy these values to your env.tenderly file:');
  console.log('');
  console.log(`TENDERLY_ENABLED=true`);
  console.log(`TENDERLY_ACCESS_KEY=${config.accessKey}`);
  console.log(`TENDERLY_ACCOUNT_SLUG=${config.accountSlug}`);
  console.log(`TENDERLY_PROJECT_SLUG=${config.projectSlug}`);
  console.log(`TENDERLY_VNET_ID=${vnet.id}`);
  console.log(`TENDERLY_RPC_URL=${vnet.rpcUrl}`);
  console.log(`BASE_LEDGER_RPC=${vnet.rpcUrl}`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('🚀 Next steps:');
  console.log('');
  console.log('1. Update env.tenderly with the values above');
  console.log('2. Load the environment:');
  console.log('   source env.tenderly  # or export $(cat env.tenderly | xargs)');
  console.log('');
  console.log('3. Run interactive setup:');
  console.log('   yarn setup:service --chain=base --with-mech');
  console.log('');
  console.log('4. View transactions in Tenderly Dashboard:');
  console.log(`   https://dashboard.tenderly.co/${config.accountSlug}/${config.projectSlug}/virtual-testnets/${vnet.id}`);
  console.log('');
}

/**
 * Main setup flow
 */
async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Tenderly Virtual TestNet Setup for OLAS Service Testing  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // 1. Load config
  const config = loadTenderlyConfig();

  // 2. Create Virtual TestNet
  const vnet = await createVirtualTestnet(config);

  // 3. Skip pre-funding - Tenderly vnets have unlimited ETH by default
  console.log('ℹ️  Skipping pre-funding - Virtual TestNet has unlimited ETH by default');
  console.log('');

  // 4. Verify OLAS token
  await verifyOLASToken(vnet.rpcUrl);

  // 5. Output configuration
  outputConfig(config, vnet);

  console.log('✅ Tenderly Virtual TestNet setup complete!');
  console.log('');
}

main().catch((error) => {
  console.error('');
  console.error('❌ Setup failed:', error.message);
  process.exit(1);
});

